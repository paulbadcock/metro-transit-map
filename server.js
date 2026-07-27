import express from 'express';
import helmet from 'helmet';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import {
  parseCsv,
  groupTripsByDirection,
  pickCanonicalShapeId,
  pickBestTrip,
  computeActiveServiceIds,
} from './lib/gtfs-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Distinguishes "running as the real server" from "imported as a module"
// (e.g. by integration tests) -- gates both the process-exit error handlers
// below and the startup()/app.listen() call at the bottom of this file.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  // Errors thrown outside the request/response cycle (e.g. in a timer or a
  // rejected promise nothing awaits) have no Express error handler to catch
  // them. Log and exit so the container's restart policy brings up a clean
  // process, rather than continuing to run in a possibly-corrupted state.
  // Only registered for the real server -- a test importing this module
  // shouldn't have an unrelated unhandled rejection hard-kill the whole
  // test run.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
}

const GTFS_STATIC_URL = 'https://gtfs.halifax.ca/static/google_transit.zip';
const GTFS_DIR = join(__dirname, 'data', 'gtfs');

const VEHICLE_POSITIONS_URL = 'https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb';
const TRIP_UPDATES_URL = 'https://gtfs.halifax.ca/realtime/TripUpdate/TripUpdates.pb';
const ALERTS_URL = 'https://gtfs.halifax.ca/realtime/Alert/Alerts.pb';

// In-memory caches
const cache = {
  vehicles: { data: null, ts: 0, ttl: 15000 },
  tripUpdates: { data: null, ts: 0, ttl: 15000 },
  alerts: { data: null, ts: 0, ttl: 5 * 60000 },
};

// Parsed static GTFS data
let gtfsData = {
  routes: new Map(),           // route_id -> { route_id, route_short_name, route_long_name }
  stops: new Map(),            // stop_id -> { stop_id, stop_name, stop_lat, stop_lon }
  trips: new Map(),            // trip_id -> { trip_id, route_id, direction_id, shape_id, trip_headsign }
  stopTimesByTrip: new Map(),  // trip_id -> [{ trip_id, arrival_time, departure_time, stop_id, stop_sequence }]
  shapes: new Map(),           // shape_id -> [[lat, lon], ...] sorted by sequence
  routeInfoCache: new Map(),   // route_id -> { tripIds: Set, stopIds: Set, stopTimes: [] }
  calendars: new Map(),        // service_id -> { monday..sunday, start_date, end_date }
  calendarDates: new Map(),    // service_id -> [{ date, exception_type }]
};

// ─── Static GTFS Bootstrap ────────────────────────────────────────────────────

async function downloadGtfs() {
  console.log('Downloading GTFS static data...');
  const res = await fetch(GTFS_STATIC_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);

  if (!existsSync(GTFS_DIR)) mkdirSync(GTFS_DIR, { recursive: true });

  const required = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
  for (const name of required) {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`Missing ${name} in GTFS zip`);
    zip.extractEntryTo(entry, GTFS_DIR, false, true);
  }
  const optional = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt'];
  for (const name of optional) {
    const entry = zip.getEntry(name);
    if (entry) zip.extractEntryTo(entry, GTFS_DIR, false, true);
  }
  writeFileSync(join(GTFS_DIR, '.downloaded'), Date.now().toString());
  console.log('GTFS static data downloaded.');
}

function isGtfsFresh() {
  const tsFile = join(GTFS_DIR, '.downloaded');
  if (!existsSync(tsFile)) return false;
  // Re-download if calendar files are absent (one-time migration for existing caches)
  const hasCalendar = existsSync(join(GTFS_DIR, 'calendar.txt')) || existsSync(join(GTFS_DIR, 'calendar_dates.txt'));
  if (!hasCalendar) return false;
  const ts = parseInt(readFileSync(tsFile, 'utf8'));
  return Date.now() - ts < 24 * 60 * 60 * 1000;
}

function loadGtfsData() {
  // Routes
  const routes = parseCsv(readFileSync(join(GTFS_DIR, 'routes.txt'), 'utf8'));
  for (const r of routes) {
    gtfsData.routes.set(r.route_id, {
      route_id: r.route_id,
      route_short_name: r.route_short_name || r.route_id,
      route_long_name: r.route_long_name || '',
    });
  }
  console.log(`Loaded ${gtfsData.routes.size} routes.`);

  // Stops
  const stops = parseCsv(readFileSync(join(GTFS_DIR, 'stops.txt'), 'utf8'));
  for (const s of stops) {
    gtfsData.stops.set(s.stop_id, {
      stop_id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: parseFloat(s.stop_lat),
      stop_lon: parseFloat(s.stop_lon),
    });
  }
  console.log(`Loaded ${gtfsData.stops.size} stops.`);

  // Trips
  const trips = parseCsv(readFileSync(join(GTFS_DIR, 'trips.txt'), 'utf8'));
  for (const t of trips) {
    gtfsData.trips.set(t.trip_id, t);
  }
  console.log(`Loaded ${gtfsData.trips.size} trips.`);

  // Stop times — indexed by trip_id so per-route lookups are fast
  const stopTimesRaw = parseCsv(readFileSync(join(GTFS_DIR, 'stop_times.txt'), 'utf8'));
  for (const st of stopTimesRaw) {
    if (!gtfsData.stopTimesByTrip.has(st.trip_id)) {
      gtfsData.stopTimesByTrip.set(st.trip_id, []);
    }
    gtfsData.stopTimesByTrip.get(st.trip_id).push({
      trip_id: st.trip_id,
      arrival_time: st.arrival_time,
      departure_time: st.departure_time,
      stop_id: st.stop_id,
      stop_sequence: parseInt(st.stop_sequence),
    });
  }
  console.log(`Loaded stop_times for ${gtfsData.stopTimesByTrip.size} trips.`);

  // Shapes
  const shapesPath = join(GTFS_DIR, 'shapes.txt');
  if (existsSync(shapesPath)) {
    const shapeRows = parseCsv(readFileSync(shapesPath, 'utf8'));
    const shapePoints = new Map();
    for (const row of shapeRows) {
      if (!shapePoints.has(row.shape_id)) shapePoints.set(row.shape_id, []);
      shapePoints.get(row.shape_id).push({
        seq: parseInt(row.shape_pt_sequence),
        lat: parseFloat(row.shape_pt_lat),
        lon: parseFloat(row.shape_pt_lon),
      });
    }
    for (const [shapeId, points] of shapePoints) {
      points.sort((a, b) => a.seq - b.seq);
      gtfsData.shapes.set(shapeId, points.map(p => [p.lat, p.lon]));
    }
    console.log(`Loaded ${gtfsData.shapes.size} shapes.`);
  } else {
    console.warn('shapes.txt not found — polylines will use stop-to-stop straight lines.');
  }

  // Service calendar
  const calendarPath = join(GTFS_DIR, 'calendar.txt');
  if (existsSync(calendarPath)) {
    const rows = parseCsv(readFileSync(calendarPath, 'utf8'));
    for (const r of rows) gtfsData.calendars.set(r.service_id, r);
    console.log(`Loaded ${gtfsData.calendars.size} service calendars.`);
  }

  const calendarDatesPath = join(GTFS_DIR, 'calendar_dates.txt');
  if (existsSync(calendarDatesPath)) {
    const rows = parseCsv(readFileSync(calendarDatesPath, 'utf8'));
    for (const r of rows) {
      if (!gtfsData.calendarDates.has(r.service_id)) gtfsData.calendarDates.set(r.service_id, []);
      gtfsData.calendarDates.get(r.service_id).push({ date: r.date, exception_type: r.exception_type });
    }
    console.log(`Loaded calendar exceptions for ${gtfsData.calendarDates.size} service IDs.`);
  }
}

// ─── Route info helper (computed once per route_id, then cached) ──────────────

function getRouteInfo(routeId) {
  if (gtfsData.routeInfoCache.has(routeId)) return gtfsData.routeInfoCache.get(routeId);

  const tripIds = new Set();
  for (const [tripId, trip] of gtfsData.trips) {
    if (trip.route_id === routeId) tripIds.add(tripId);
  }

  const stopIds = new Set();
  const stopTimes = [];
  for (const tripId of tripIds) {
    const sts = gtfsData.stopTimesByTrip.get(tripId);
    if (!sts) continue;
    for (const st of sts) {
      stopTimes.push(st);
      stopIds.add(st.stop_id);
    }
  }

  const info = { tripIds, stopIds, stopTimes };
  gtfsData.routeInfoCache.set(routeId, info);
  return info;
}

// ─── Today's active service IDs ───────────────────────────────────────────────

function getTodayServiceIds() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Halifax' }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dateStr = `${y}${m}${d}`;
  const dayName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][now.getDay()];

  return computeActiveServiceIds(gtfsData.calendars, gtfsData.calendarDates, dateStr, dayName);
}

// ─── GTFS-RT helpers ──────────────────────────────────────────────────────────

async function fetchFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Feed fetch failed (${url}): ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
}

async function getCached(key, fetchFn) {
  const c = cache[key];
  if (c.data && Date.now() - c.ts < c.ttl) return c.data;
  const data = await fetchFn();
  c.data = data;
  c.ts = Date.now();
  return data;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// CSP allow-list matches this app's actual resources: Leaflet is loaded
// from unpkg.com (its CSS also pulls marker icons from there), map tiles
// come from CARTO's lettered basemap subdomains, and everything else
// (API calls, our own scripts/styles) is same-origin.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://unpkg.com'],
      styleSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://unpkg.com', 'https://*.basemaps.cartocdn.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // Helmet includes this in its CSP defaults, which would otherwise make
      // browsers rewrite every http:// subresource request to https:// --
      // breaking asset loading since this app is only ever served over plain
      // HTTP (locally and via the current Docker setup, neither terminate TLS).
      upgradeInsecureRequests: null,
    },
  },
}));

app.use(express.static(join(__dirname, 'public')));

app.get('/api/routes', (req, res) => {
  const routes = [...gtfsData.routes.values()].sort((a, b) => {
    const an = parseInt(a.route_short_name), bn = parseInt(b.route_short_name);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return a.route_short_name.localeCompare(b.route_short_name);
  });
  res.json(routes);
});

app.get('/api/vehicles', async (req, res) => {
  try {
    const routeId = req.query.route_id || '194';
    const { tripIds } = getRouteInfo(routeId);

    const feed = await getCached('vehicles', () => fetchFeed(VEHICLE_POSITIONS_URL));
    const vehicles = [];
    for (const entity of feed.entity) {
      const vp = entity.vehicle;
      if (!vp) continue;
      const vehicleRouteId = vp.trip?.routeId;
      const tripId = vp.trip?.tripId;
      if (vehicleRouteId && vehicleRouteId !== routeId) continue;
      if (!vehicleRouteId && tripId && !tripIds.has(tripId)) continue;

      vehicles.push({
        id: entity.id,
        lat: vp.position?.latitude,
        lon: vp.position?.longitude,
        bearing: vp.position?.bearing,
        speed: vp.position?.speed,
        trip_id: vp.trip?.tripId,
        route_id: vehicleRouteId,
        timestamp: vp.timestamp ? Number(vp.timestamp) : null,
        label: vp.vehicle?.label,
      });
    }
    res.json(vehicles);
  } catch (err) {
    console.error('Error fetching vehicles:', err.message);
    res.status(502).json({ error: 'Failed to fetch vehicle positions' });
  }
});

app.get('/api/trip-updates', async (req, res) => {
  try {
    const routeId = req.query.route_id || '194';
    const { tripIds } = getRouteInfo(routeId);

    const feed = await getCached('tripUpdates', () => fetchFeed(TRIP_UPDATES_URL));
    const updates = [];
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu) continue;
      const vehicleRouteId = tu.trip?.routeId;
      const tripId = tu.trip?.tripId;
      if (vehicleRouteId && vehicleRouteId !== routeId) continue;
      if (!vehicleRouteId && tripId && !tripIds.has(tripId)) continue;
      if (!vehicleRouteId && !tripId) continue;

      for (const stu of (tu.stopTimeUpdate || [])) {
        updates.push({
          trip_id: tu.trip?.tripId,
          route_id: vehicleRouteId,
          stop_id: stu.stopId,
          stop_sequence: stu.stopSequence,
          arrival_time: stu.arrival?.time ? Number(stu.arrival.time) : null,
          arrival_delay: stu.arrival?.delay ?? null,
          departure_time: stu.departure?.time ? Number(stu.departure.time) : null,
          departure_delay: stu.departure?.delay ?? null,
        });
      }
    }
    res.json(updates);
  } catch (err) {
    console.error('Error fetching trip updates:', err.message);
    res.status(502).json({ error: 'Failed to fetch trip updates' });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const routeId = req.query.route_id || '194';
    const feed = await getCached('alerts', () => fetchFeed(ALERTS_URL));
    const nowSec = Date.now() / 1000;

    const alerts = [];
    for (const entity of feed.entity) {
      const alert = entity.alert;
      if (!alert) continue;
      const informed = alert.informedEntity || [];
      if (!informed.some(ie => ie.routeId === routeId)) continue;

      const periods = alert.activePeriod || [];
      const isActive = periods.length === 0 || periods.some(p => {
        const start = p.start != null ? Number(p.start) : -Infinity;
        const end = p.end != null ? Number(p.end) : Infinity;
        return nowSec >= start && nowSec <= end;
      });
      if (!isActive) continue;

      alerts.push({
        id: entity.id,
        header: alert.headerText?.translation?.[0]?.text || '',
        description: alert.descriptionText?.translation?.[0]?.text || '',
      });
    }
    res.json(alerts);
  } catch (err) {
    console.error('Error fetching alerts:', err.message);
    res.status(502).json({ error: 'Failed to fetch service alerts' });
  }
});

app.get('/api/stops', (req, res) => {
  const routeId = req.query.route_id || '194';
  const { stopIds } = getRouteInfo(routeId);

  const stops = [];
  for (const stopId of stopIds) {
    const s = gtfsData.stops.get(stopId);
    if (s) stops.push(s);
  }
  stops.sort((a, b) => a.stop_name.localeCompare(b.stop_name));
  res.json(stops);
});

app.get('/api/schedule', (req, res) => {
  const { stop_id, direction, route_id } = req.query;
  if (!stop_id) return res.status(400).json({ error: 'stop_id required' });

  const { stopTimes } = getRouteInfo(route_id || '194');
  const dir = direction !== undefined ? parseInt(direction) : null;

  const tripStopEntries = stopTimes.filter(st => st.stop_id === stop_id);

  const results = [];
  for (const st of tripStopEntries) {
    const trip = gtfsData.trips.get(st.trip_id);
    if (!trip) continue;
    if (dir !== null && parseInt(trip.direction_id) !== dir) continue;

    results.push({
      trip_id: st.trip_id,
      direction_id: parseInt(trip.direction_id),
      departure_time: st.departure_time,
      stop_sequence: st.stop_sequence,
      shape_id: trip.shape_id,
      trip_headsign: trip.trip_headsign,
    });
  }

  results.sort((a, b) => a.departure_time.localeCompare(b.departure_time));
  res.json(results);
});

app.get('/api/route-stops', (req, res) => {
  const routeId = req.query.route_id || '194';
  const { tripIds } = getRouteInfo(routeId);

  const { tripsByDir, shapeCountsByDir } = groupTripsByDirection(tripIds, gtfsData.trips);

  const byDirection = {};
  for (const [dir, dirTrips] of Object.entries(tripsByDir)) {
    const canonicalShapeId = pickCanonicalShapeId(shapeCountsByDir[dir] || {});
    const bestTrip = pickBestTrip(
      dirTrips,
      canonicalShapeId,
      tripId => (gtfsData.stopTimesByTrip.get(tripId) || []).length
    );

    const sts = [...(gtfsData.stopTimesByTrip.get(bestTrip.trip_id) || [])];
    sts.sort((a, b) => a.stop_sequence - b.stop_sequence);

    byDirection[dir] = {
      direction_id: parseInt(dir),
      trip_headsign: bestTrip.trip_headsign,
      stops: sts.map(st => {
        const s = gtfsData.stops.get(st.stop_id);
        return s ? { ...s, sequence: st.stop_sequence } : null;
      }).filter(Boolean),
      shape: (bestTrip.shape_id && gtfsData.shapes.has(bestTrip.shape_id))
        ? gtfsData.shapes.get(bestTrip.shape_id)
        : [],
    };
  }

  res.json(Object.values(byDirection));
});

app.get('/api/service-status', (req, res) => {
  const routeId = req.query.route_id || '194';
  const { stopTimes, tripIds } = getRouteInfo(routeId);
  const routeShortName = gtfsData.routes.get(routeId)?.route_short_name || routeId;

  if (stopTimes.length === 0) {
    return res.json({ running: false, routeShortName, message: 'No schedule data available' });
  }

  // Filter to trips that actually run today (requires calendar data)
  const todayServiceIds = getTodayServiceIds();
  let effectiveStopTimes = stopTimes;
  if (todayServiceIds !== null) {
    const todayTripIds = new Set();
    for (const tripId of tripIds) {
      const trip = gtfsData.trips.get(tripId);
      if (trip && todayServiceIds.has(trip.service_id)) todayTripIds.add(tripId);
    }
    effectiveStopTimes = stopTimes.filter(st => todayTripIds.has(st.trip_id));
  }

  if (effectiveStopTimes.length === 0) {
    return res.json({ running: false, routeShortName, message: 'No service scheduled for today' });
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Halifax' }));
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let firstMin = Infinity, lastMin = -Infinity;
  let firstTime = '', lastTime = '';

  // Compute earliest departure per trip (trip start times)
  const tripStarts = new Map();
  for (const st of effectiveStopTimes) {
    if (!st.departure_time) continue;
    const [h, m] = st.departure_time.split(':').map(Number);
    const min = h * 60 + m;
    if (min < firstMin) { firstMin = min; firstTime = st.departure_time; }
    if (min > lastMin) { lastMin = min; lastTime = st.departure_time; }
    const curr = tripStarts.get(st.trip_id);
    if (curr === undefined || min < curr.min) tripStarts.set(st.trip_id, { min, time: st.departure_time });
  }

  // Next trip whose first stop departs after now
  let nextMin = Infinity, nextTime = '';
  for (const { min, time } of tripStarts.values()) {
    if (min > nowMin && min < nextMin) { nextMin = min; nextTime = time; }
  }

  const running = nowMin >= firstMin && nowMin <= lastMin;
  res.json({ running, routeShortName, firstService: firstTime, lastService: lastTime, nextService: nextTime, nowMin, firstMin, lastMin });
});

app.get('/api/status', (req, res) => {
  const routeId = req.query.route_id || '194';
  const { tripIds, stopIds, stopTimes } = getRouteInfo(routeId);
  res.json({
    routeId,
    routesLoaded: gtfsData.routes.size,
    stopsLoaded: gtfsData.stops.size,
    tripsLoaded: gtfsData.trips.size,
    routeStops: stopIds.size,
    routeTrips: tripIds.size,
    stopTimesLoaded: stopTimes.length,
  });
});

// Catch-all for errors thrown or rejected within route handlers (Express 5
// forwards rejected async handlers here automatically) so callers get a
// consistent JSON error instead of Express's default HTML error page.
app.use((err, req, res, _next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  if (!isGtfsFresh()) {
    await downloadGtfs();
  } else {
    console.log('GTFS static data is fresh, skipping download.');
  }
  loadGtfsData();

  const server = app.listen(PORT, () => {
    console.log(`Bus Tracker running at http://localhost:${PORT}`);
  });

  // On docker stop/compose down, stop accepting new connections and let
  // in-flight requests finish rather than being hard-killed by Docker's
  // grace period (10s by default).
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Skip auto-starting when imported (e.g. by integration tests) rather than
// run directly -- avoids a real network download and port bind on import.
if (isMainModule) {
  startup().catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
}

export { app, gtfsData };

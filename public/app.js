/* ─── Bus Tracker — Frontend ──────────────────────────────────────── */

const HALIFAX_CENTER = [44.6476, -63.5728];
const HALIFAX_TZ = "America/Halifax";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  vehicles: [],
  stops: [],
  allTripUpdates: [],
  schedule: [],
  alerts: [],
  notifiedTripIds: new Set(),
  vehicleMarkers: new Map(), // id -> L.Marker
  stopMarkers: [],
  // Pickup points stay off the map until a bus is chosen, then show only
  // that bus's own trip (not the whole route).
  selectedBusId: null,
  selectedTripStops: [],
  selectedTripDirectionId: null,
  // Stop the rider tapped on the selected trip -- narrows the animated flow
  // segment from "bus to route end" down to "bus to this stop".
  selectedStopId: null,
  routePolylines: [],
  routePolylinesByDirection: new Map(), // direction_id -> L.Polyline
  routeShapeByDirection: new Map(), // direction_id -> raw [lat,lon] shape points, in travel order
  busFlowPolyline: null, // L.Polyline, the animated bus->destination segment
  stopScheduleCache: new Map(), // stop_id -> raw /api/schedule response, reused across popup opens/refreshes
  activeTab: "map",
  lastVehicleFetch: null,
  nextVehicleRefreshAt: null, // ms epoch -- when the next scheduled poll fires
  fetchErrors: 0,
  serviceStatus: null,
  trafficLayer: null, // L.tileLayer, present only while the overlay is on
  // Popups get fully rebuilt on every vehicle/trip-update poll (fresh
  // speed/delay data), so this can't live in the popup's own DOM -- it'd
  // reset on the next poll tick.
  busPopupLegendExpanded: false,
};

// ─── Settings (persisted in localStorage) ────────────────────────────────────
const DEFAULTS = {
  selectedRoute: "194",
  morningStop: "",
  eveningStop: "",
  morningStart: "07:00",
  morningEnd: "09:00",
  eveningStart: "16:00",
  eveningEnd: "18:30",
  notifEnable: false,
  notifMinutes: 5,
  sidebarExpanded: false,
  autoTrafficEnable: false,
};

function loadSettings() {
  const raw = localStorage.getItem("metromaps_settings");
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
}

function saveSettings(s) {
  localStorage.setItem("metromaps_settings", JSON.stringify(s));
}

let settings = loadSettings();

function currentRouteId() {
  return settings.selectedRoute || "194";
}

// ─── Map Setup ────────────────────────────────────────────────────────────────
const map = L.map("map", {
  center: HALIFAX_CENTER,
  zoom: 13,
  zoomControl: true,
}).setView(HALIFAX_CENTER, 13);

L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 20,
  subdomains: "abcd",
}).addTo(map);

// ─── Bus Icon ─────────────────────────────────────────────────────────────────
function busDirectionClass(directionId) {
  if (directionId === 0) return "dir-outbound";
  if (directionId === 1) return "dir-inbound";
  return null;
}

// The bus glyph is a flat side-view drawing (front on one side, wheels on
// the bottom), not a rotationally-symmetric arrow -- rotating it more than
// a quarter turn from its native pose flips it wheels-up instead of turning
// it to face the new heading. Beyond +/-90 degrees we mirror the glyph
// horizontally instead and rotate by the much smaller remaining angle, so
// it stays right-side up for every bearing.
function busIconTransform(bearing) {
  if (bearing == null) return "";

  const normalize = (deg) => (((deg + 180) % 360) + 360) % 360 - 180;
  let r = normalize(bearing + 90);

  if (r > 90) return `transform:scaleX(-1) rotate(${-(r - 180)}deg)`;
  if (r < -90) return `transform:scaleX(-1) rotate(${-(r + 180)}deg)`;
  return `transform:rotate(${r}deg)`;
}

function makeBusIcon(bearing, timestamp, delayMin, directionId) {
  const rotation = busIconTransform(bearing);
  let ageBadge = "";
  if (timestamp) {
    const ageS = Math.round(Date.now() / 1000 - timestamp);
    const ageClass = ageS < 30 ? "" : ageS < 90 ? " stale" : " very-stale";
    ageBadge = `<div class="bus-age-badge${ageClass}">${ageS}s</div>`;
  }

  let iconClass = "bus-marker-icon";
  let delayBadge = "";
  if (delayMin != null) {
    if (delayMin > 1) {
      const severe = delayMin >= 5 ? " severe" : "";
      iconClass += ` delay-late${severe}`;
      delayBadge = `<div class="bus-delay-badge late">+${delayMin}m</div>`;
    } else if (delayMin < -1) {
      delayBadge = `<div class="bus-delay-badge early">${delayMin}m</div>`;
    }
  }

  const dirClass = busDirectionClass(directionId);
  const discHtml = dirClass ? `<div class="bus-direction-disc ${dirClass}"></div>` : "";

  return L.divIcon({
    className: "",
    html: `<div class="bus-marker-wrap">${discHtml}<div class="${iconClass}" style="${rotation}">🚌</div>${ageBadge}${delayBadge}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

// Returns the current delay (minutes) for a trip from the most recently
// arriving stop-time update, or null if no real-time data is available yet.
function getTripDelayMinutes(tripId) {
  if (!tripId) return null;
  let best = null;
  for (const u of state.allTripUpdates) {
    if (u.trip_id !== tripId) continue;
    if (best === null || (u.stop_sequence ?? Infinity) < (best.stop_sequence ?? Infinity)) {
      best = u;
    }
  }
  if (!best) return null;
  const delaySeconds = best.departure_delay ?? best.arrival_delay;
  return delaySeconds != null ? Math.round(delaySeconds / 60) : null;
}

function stopDirectionClass(directionId) {
  if (directionId == null) return "";
  return directionId === 1 ? "dir-inbound" : "dir-outbound";
}

function makeStopIcon(directionId, selected = false) {
  // iconSize/iconAnchor become inline styles on the div, which would
  // override a CSS width/height on `.selected` -- so the bigger selected
  // size is set here instead of in the stylesheet.
  const size = selected ? 14 : 10;
  return L.divIcon({
    className: `stop-marker ${stopDirectionClass(directionId)}${selected ? " selected" : ""}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ─── Security Utilities ───────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Time Utilities ───────────────────────────────────────────────────────────
function nowInHalifax() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: HALIFAX_TZ }));
}

function timeStringToMinutes(t) {
  // Handles "HH:MM" or "HH:MM:SS" — also handles >24h GTFS times
  const parts = t.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

function minutesToTimeString(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function nowMinutes() {
  const d = nowInHalifax();
  return d.getHours() * 60 + d.getMinutes();
}

function formatTime12(timeStr) {
  // timeStr = "HH:MM" or "HH:MM:SS"
  let [h, m] = timeStr.split(":").map(Number);
  h = h % 24;
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatCountdown(minutesAway) {
  if (minutesAway < 1) return "<1";
  return String(Math.round(minutesAway));
}

// ─── Active Commute Window ────────────────────────────────────────────────────
function getActiveWindow() {
  const now = nowMinutes();
  const ms = timeStringToMinutes(settings.morningStart);
  const me = timeStringToMinutes(settings.morningEnd);
  const es = timeStringToMinutes(settings.eveningStart);
  const ee = timeStringToMinutes(settings.eveningEnd);

  if (now >= ms && now <= me && settings.morningStop) return "morning";
  if (now >= es && now <= ee && settings.eveningStop) return "evening";
  return null;
}

function getActiveStop() {
  const w = getActiveWindow();
  if (w === "morning") return settings.morningStop;
  if (w === "evening") return settings.eveningStop;
  return settings.morningStop || settings.eveningStop;
}

// ─── API Calls ────────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

async function fetchVehicles(force = false) {
  state.vehicles = await apiFetch(
    `/api/vehicles?route_id=${encodeURIComponent(currentRouteId())}${force ? "&force=true" : ""}`,
  );
  state.lastVehicleFetch = new Date();
  updateVehicleMarkers();
  updateBusList();
  updateStatusDot(true);
}

async function fetchTripUpdates(force = false) {
  state.allTripUpdates = await apiFetch(
    `/api/trip-updates?route_id=${encodeURIComponent(currentRouteId())}${force ? "&force=true" : ""}`,
  );
}

async function fetchStops() {
  state.stops = await apiFetch(
    `/api/stops?route_id=${encodeURIComponent(currentRouteId())}`,
  );
  populateStopDropdowns();
}

// Pickup points stay off the map until the rider picks a specific bus, then
// show only the stops on that bus's own trip.
async function fetchTripStops(tripId) {
  try {
    state.selectedTripStops = await apiFetch(
      `/api/trip-stops?trip_id=${encodeURIComponent(tripId)}`,
    );
  } catch (err) {
    console.warn("[BusTracker] Could not load trip stops:", err);
    state.selectedTripStops = [];
  }
  drawStopMarkers();
}

function selectBus(id) {
  state.selectedBusId = id;
  state.selectedStopId = null;
  highlightBusInList(id);

  const v = state.vehicles.find((x) => x.id === id);
  if (v && v.trip_id) {
    state.selectedTripDirectionId = v.direction_id ?? null;
    fetchTripStops(v.trip_id);
  } else {
    state.selectedTripStops = [];
    state.selectedTripDirectionId = null;
    drawStopMarkers();
  }
  updateRouteFlowHighlight();
}

// Rider tapped one of the selected trip's own stop markers -- narrow the
// animated flow segment to "bus to this stop" instead of "bus to route end".
// Tapping the same stop again clears it, reverting to bus-to-end.
function selectStopForFlow(stopId) {
  state.selectedStopId = state.selectedStopId === stopId ? null : stopId;
  drawStopMarkers();
  updateBusFlowSegment();
}

// Leaflet marker clicks don't bubble to the map's own click event (Leaflet
// stops that propagation), so this only fires for clicks on the map
// background -- i.e. "outside" any bus -- letting us clear the selection.
function deselectBus() {
  if (state.selectedBusId == null) return;
  state.selectedBusId = null;
  state.selectedStopId = null;
  state.selectedTripStops = [];
  state.selectedTripDirectionId = null;
  highlightBusInList(null);
  drawStopMarkers();
  updateRouteFlowHighlight();
}

async function fetchRoutePolyline() {
  const data = await apiFetch(
    `/api/route-stops?route_id=${encodeURIComponent(currentRouteId())}`,
  );
  drawRoutePolylines(data);
}

async function fetchScheduleForStop(stopId) {
  if (!stopId) {
    state.schedule = [];
    return;
  }
  state.schedule = await apiFetch(
    `/api/schedule?stop_id=${encodeURIComponent(stopId)}&route_id=${encodeURIComponent(currentRouteId())}`,
  );
}

async function fetchRoutes() {
  const routes = await apiFetch("/api/routes");
  const sel = document.getElementById("route-select");
  sel.innerHTML = routes
    .map((r) => {
      const label = r.route_long_name
        ? `${escapeHtml(r.route_short_name)} \u2014 ${escapeHtml(r.route_long_name)}`
        : escapeHtml(r.route_short_name);
      return `<option value="${escapeHtml(r.route_id)}">${label}</option>`;
    })
    .join("");
  sel.value = currentRouteId();
}

// ─── Map: Vehicles ────────────────────────────────────────────────────────────
function updateVehicleMarkers() {
  const seenIds = new Set();

  for (const v of state.vehicles) {
    if (!v.lat || !v.lon) continue;
    seenIds.add(v.id);
    const delayMin = getTripDelayMinutes(v.trip_id);

    if (state.vehicleMarkers.has(v.id)) {
      const marker = state.vehicleMarkers.get(v.id);
      marker.setLatLng([v.lat, v.lon]);
      marker.setIcon(makeBusIcon(v.bearing, v.timestamp, delayMin, v.direction_id));
      marker.getPopup()?.setContent(buildBusPopup(v, delayMin));
    } else {
      const marker = L.marker([v.lat, v.lon], {
        icon: makeBusIcon(v.bearing, v.timestamp, delayMin, v.direction_id),
        title: `Bus ${v.label || v.id}`,
        zIndexOffset: 100,
      })
        .bindPopup(buildBusPopup(v, delayMin))
        .addTo(map);

      marker.on("click", () => selectBus(v.id));

      state.vehicleMarkers.set(v.id, marker);
    }
  }

  // Remove markers for buses no longer in feed
  for (const [id, marker] of state.vehicleMarkers) {
    if (!seenIds.has(id)) {
      marker.remove();
      state.vehicleMarkers.delete(id);
    }
  }

  // Keep the animated flow segment's start point tracking the bus as it moves.
  updateBusFlowSegment();
  refreshOpenStopPopups();
}

function buildBusPopup(v, delayMin) {
  const speed = v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : "–";
  const ts = v.timestamp
    ? new Date(v.timestamp * 1000).toLocaleTimeString("en-CA", {
        timeZone: HALIFAX_TZ,
        hour: "2-digit",
        minute: "2-digit",
      })
    : "–";
  const ageS = v.timestamp ? Math.round(Date.now() / 1000 - v.timestamp) : null;
  const ageText =
    ageS != null
      ? ` <span class="popup-age-text" style="opacity:0.65">(${ageS}s ago)</span>`
      : "";

  let delayLine = "";
  if (delayMin != null) {
    const cls = delayMin > 1 ? "late" : delayMin < -1 ? "early" : "ontime";
    const text =
      delayMin > 1
        ? `+${delayMin} min late`
        : delayMin < -1
          ? `${delayMin} min early`
          : "On time";
    delayLine = `<div class="delay ${cls}">${text}</div>`;
  }

  const legendExpanded = state.busPopupLegendExpanded;
  return `
    <strong>Route ${escapeHtml(currentRouteId())}</strong>
    <button class="legend-info-btn" type="button" aria-expanded="${legendExpanded}" title="What does the bus icon mean?">ⓘ</button><br>
    Bus #${escapeHtml(v.label || v.id)}<br>
    Trip: ${escapeHtml(v.trip_id || "–")}<br>
    Speed: ${escapeHtml(speed)}<br>
    Updated: ${escapeHtml(ts)}${ageText}<br>
    ${delayLine}
    <div class="legend-detail popup-legend-detail" ${legendExpanded ? "" : "hidden"}>${document.getElementById("legend-detail").innerHTML}</div>
    <span style="opacity:0.65">Refreshing every 15s</span>
  `;
}

function toggleInlineLegend(btn) {
  const detail = btn.closest(".leaflet-popup-content")?.querySelector(".popup-legend-detail");
  if (!detail) return;
  state.busPopupLegendExpanded = !state.busPopupLegendExpanded;
  detail.hidden = !state.busPopupLegendExpanded;
  btn.setAttribute("aria-expanded", String(state.busPopupLegendExpanded));
}

// Delegated on the map container rather than bound per-popup: Leaflet popup
// DOM is created fresh each time a popup opens, so a per-marker listener
// would need constant rebinding. This also avoids the CSP's
// script-src-attr 'none', which silently blocks inline onclick=.
document.getElementById("map").addEventListener("click", (e) => {
  const btn = e.target.closest(".legend-info-btn");
  if (btn && btn.closest(".leaflet-popup-content")) toggleInlineLegend(btn);
});

// Clicking the map background (not a bus marker or its popup) deselects the
// active bus, returning the route line to its unselected/resting style.
map.on("click", deselectBus);

function highlightBusInList(id) {
  document.querySelectorAll(".bus-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.busId === id);
  });
}

// ─── Map: Stops ───────────────────────────────────────────────────────────────
function drawStopMarkers() {
  for (const m of state.stopMarkers) m.remove();
  state.stopMarkers = [];

  for (const s of state.selectedTripStops) {
    if (!s.stop_lat || !s.stop_lon) continue;
    const m = L.marker([s.stop_lat, s.stop_lon], {
      icon: makeStopIcon(state.selectedTripDirectionId, s.stop_id === state.selectedStopId),
      title: s.stop_name,
    })
      .bindPopup(buildStopPopup(s.stop_name, s.stop_id, null, null))
      .addTo(map);
    m.metroStop = s; // stashed for the popupopen handler and the live refresh loop below
    m.on("popupopen", () => loadStopPopupTimes(m));
    m.on("click", () => selectStopForFlow(s.stop_id));
    state.stopMarkers.push(m);
  }
}

// Times pane is `null` while loading, an array (possibly empty) once fetched.
// tripContext is `null` while loading or when there's nothing to show
// (before/after entries relative to the selected bus's own trip -- see
// computeStopTripContext).
function buildStopPopup(stopName, stopId, upcoming, tripContext) {
  const header = `<strong>${escapeHtml(stopName)}</strong><br>Stop #${escapeHtml(stopId)}`;
  const contextHtml = buildTripContextHtml(tripContext);

  let timesHtml;
  if (upcoming === null) {
    timesHtml = `<div class="stop-popup-times empty-state">Loading times…</div>`;
  } else if (upcoming.length === 0) {
    timesHtml = `<div class="stop-popup-times empty-state">No upcoming departures</div>`;
  } else {
    timesHtml = `<div class="stop-popup-times">${upcoming
      .map((s) => {
        let delayHtml = `<span class="delay ontime">On time</span>`;
        if (s.delayMin > 1) delayHtml = `<span class="delay late">+${s.delayMin} min</span>`;
        else if (s.delayMin < -1) delayHtml = `<span class="delay early">${s.delayMin} min</span>`;

        return `
          <div class="stop-popup-time-row">
            <span class="stop-popup-time">${formatTime12(minutesToTimeString(s.estimatedMin))}</span>
            ${delayHtml}
            <span class="stop-popup-headsign">${escapeHtml(s.trip_headsign || "")}</span>
          </div>`;
      })
      .join("")}</div>`;
  }

  return `${header}${contextHtml}${timesHtml}`;
}

// One row of trip-context info: the published/scheduled time (adjusted by
// any live delay for that specific trip+stop), plus a countdown relative to
// now -- "in N min" for a trip still ahead, "N min ago" for one already gone
// (the "before" row is often already in the past relative to now, even
// though it's still "before" the selected bus in schedule order).
function buildTripContextRow(label, s) {
  let delayHtml = `<span class="delay ontime">On time</span>`;
  if (s.delayMin > 1) delayHtml = `<span class="delay late">+${s.delayMin} min</span>`;
  else if (s.delayMin < -1) delayHtml = `<span class="delay early">${s.delayMin} min</span>`;

  const countdown =
    s.minutesAway >= 0
      ? `in ${formatCountdown(s.minutesAway)} min`
      : `${formatCountdown(-s.minutesAway)} min ago`;

  return `
    <div class="stop-context-row">
      <span class="stop-context-label">${escapeHtml(label)}</span>
      <span class="stop-popup-time">${formatTime12(minutesToTimeString(s.estimatedMin))}</span>
      ${delayHtml}
      <span class="stop-context-countdown">${countdown}</span>
    </div>`;
}

function buildTripContextHtml(context) {
  if (!context) return "";
  const rows = [];
  // Once the selected bus has already passed this stop, the trip that ran
  // just before it is old news -- only the next one still matters.
  if (context.before) rows.push(buildTripContextRow("Bus before", context.before));
  if (context.after) rows.push(buildTripContextRow("Bus after", context.after));
  if (rows.length === 0) return "";
  return `<div class="stop-trip-context">${rows.join("")}</div>`;
}

// Shape-index comparison (same technique as updateBusFlowSegment) rather
// than GTFS-RT stop-time updates, since the realtime feed doesn't reliably
// report per-stop arrival status for every stop on every trip.
function hasBusPassedStop(stop) {
  const dirId = state.selectedTripDirectionId;
  const bus = state.vehicles.find((v) => v.id === state.selectedBusId);
  const shape = state.routeShapeByDirection.get(dirId);
  if (!bus || !bus.lat || !bus.lon || !shape || shape.length < 2) return false;
  const busIdx = nearestShapeIndex(shape, bus.lat, bus.lon);
  const stopIdx = nearestShapeIndex(shape, stop.stop_lat, stop.stop_lon);
  return busIdx > stopIdx;
}

// Finds the scheduled trips immediately before/after the selected bus's own
// trip at this stop, within the same direction. Falls back to anchoring on
// the current time if the selected trip isn't in the static schedule (e.g. a
// real-time-only trip).
function computeStopTripContext(stopId, stop, schedule) {
  const dirId = state.selectedTripDirectionId;
  const bus = state.vehicles.find((v) => v.id === state.selectedBusId);

  const dirEntries = schedule
    .filter((e) => e.direction_id === dirId)
    .slice()
    .sort((a, b) => a.departure_time.localeCompare(b.departure_time));

  const delayByTrip = NextBuses.buildDelayMap(state.allTripUpdates);
  const decorate = (e) => {
    const depMin = timeStringToMinutes(e.departure_time);
    const delaySeconds = delayByTrip[e.trip_id + "_" + stopId]?.departure_delay ?? 0;
    const delayMin = Math.round(delaySeconds / 60);
    const estimatedMin = depMin + delayMin;
    return { ...e, depMin, delayMin, estimatedMin, minutesAway: estimatedMin - nowMinutes() };
  };

  const idx = bus ? dirEntries.findIndex((e) => e.trip_id === bus.trip_id) : -1;
  let before = null;
  let after = null;

  if (idx === -1) {
    const now = nowMinutes();
    for (let i = dirEntries.length - 1; i >= 0; i--) {
      if (timeStringToMinutes(dirEntries[i].departure_time) <= now) {
        before = decorate(dirEntries[i]);
        break;
      }
    }
    for (let i = 0; i < dirEntries.length; i++) {
      if (timeStringToMinutes(dirEntries[i].departure_time) > now) {
        after = decorate(dirEntries[i]);
        break;
      }
    }
  } else {
    if (idx > 0) before = decorate(dirEntries[idx - 1]);
    if (idx < dirEntries.length - 1) after = decorate(dirEntries[idx + 1]);
  }

  const passed = hasBusPassedStop(stop);
  return { before: passed ? null : before, after, passed };
}

async function ensureStopScheduleCached(stopId) {
  if (!state.stopScheduleCache.has(stopId)) {
    const schedule = await apiFetch(
      `/api/schedule?stop_id=${encodeURIComponent(stopId)}&route_id=${encodeURIComponent(currentRouteId())}`,
    );
    state.stopScheduleCache.set(stopId, schedule);
  }
  return state.stopScheduleCache.get(stopId);
}

function renderStopPopupContent(marker, stop, schedule) {
  const upcoming = NextBuses.computeNextBuses(schedule, stop.stop_id, state.allTripUpdates, nowMinutes(), 5);
  const tripContext = computeStopTripContext(stop.stop_id, stop, schedule);
  marker.setPopupContent(buildStopPopup(stop.stop_name, stop.stop_id, upcoming, tripContext));
}

async function loadStopPopupTimes(marker) {
  const stop = marker.metroStop;
  try {
    const schedule = await ensureStopScheduleCached(stop.stop_id);
    renderStopPopupContent(marker, stop, schedule);
  } catch (err) {
    marker.setPopupContent(
      `<strong>${escapeHtml(stop.stop_name)}</strong><br>Stop #${escapeHtml(stop.stop_id)}<br><span class="empty-state">Couldn't load times</span>`,
    );
  }
}

// Keeps any open stop popup's countdown/delay/before-after box live as
// vehicle positions and delays refresh, without refetching the (static,
// already-cached) schedule each time.
function refreshOpenStopPopups() {
  for (const m of state.stopMarkers) {
    const popup = m.getPopup();
    if (!popup || !popup.isOpen()) continue;
    const schedule = state.stopScheduleCache.get(m.metroStop.stop_id);
    if (!schedule) continue;
    renderStopPopupContent(m, m.metroStop, schedule);
  }
}

// ─── Map: Live Traffic ────────────────────────────────────────────────────────
// Tiles are proxied through our own /api/traffic-tile route so the TomTom API
// key stays server-side. Off by default -- this is a sanity-check overlay to
// spot congestion the GTFS-RT feed's delay data isn't reflecting yet, not
// data the app depends on.
async function initTrafficControl() {
  const btn = document.getElementById("traffic-toggle-btn");

  let trafficEnabled = false;
  try {
    const config = await apiFetch("/api/config");
    trafficEnabled = Boolean(config.trafficEnabled);
  } catch (err) {
    console.warn("[BusTracker] Could not load config:", err);
  }

  if (!trafficEnabled) {
    btn.disabled = true;
    btn.title = "Traffic layer not configured on server (set TOMTOM_API_KEY).";
    return;
  }

  btn.addEventListener("click", toggleTraffic);

  if (settings.autoTrafficEnable) toggleTraffic();
}

function toggleTraffic() {
  const btn = document.getElementById("traffic-toggle-btn");

  if (state.trafficLayer) {
    map.removeLayer(state.trafficLayer);
    state.trafficLayer = null;
    btn.classList.remove("active");
    return;
  }

  state.trafficLayer = L.tileLayer("/api/traffic-tile/{z}/{x}/{y}", {
    maxZoom: 20,
    opacity: 0.65,
  }).addTo(map);
  btn.classList.add("active");
}

// ─── Map: Route Polylines ─────────────────────────────────────────────────────
// Mirrors --color-dir-outbound / --color-dir-inbound in style.css. Leaflet's
// vector layers need a literal color string (not a var() reference -- the
// canvas renderer fallback can't resolve CSS custom properties), so the
// values are duplicated here rather than read from the stylesheet.
const DIR_OUTBOUND_COLOR = "#2f8fd1";
const DIR_INBOUND_COLOR = "#d18f2f";

function drawRoutePolylines(directions) {
  for (const pl of state.routePolylines) pl.remove();
  state.routePolylines = [];
  state.routePolylinesByDirection.clear();
  state.routeShapeByDirection.clear();

  directions.forEach((dir) => {
    // Prefer shape track (follows roads); fall back to straight stop-to-stop lines
    const latlngs =
      dir.shape && dir.shape.length > 1
        ? dir.shape
        : (dir.stops || [])
            .filter((s) => s.stop_lat && s.stop_lon)
            .map((s) => [s.stop_lat, s.stop_lon]);
    if (latlngs.length < 2) return;
    const isInbound = dir.direction_id === 1;
    const pl = L.polyline(latlngs, {
      color: isInbound ? DIR_INBOUND_COLOR : DIR_OUTBOUND_COLOR,
      weight: 3,
      opacity: 0.6,
      dashArray: isInbound ? "6,4" : null,
      // Paths bubble click events up to the map by default, which would
      // immediately re-trigger deselectBus() (bound on map click) the
      // instant this line's own popup was clicked open.
      bubblingMouseEvents: false,
    })
      .bindPopup(
        `<strong>Direction ${escapeHtml(String(dir.direction_id))}</strong><br>${escapeHtml(dir.trip_headsign || "")}<br><span style="opacity:0.65">${latlngs.length} shape points</span>`,
      )
      .addTo(map);
    state.routePolylines.push(pl);
    state.routePolylinesByDirection.set(dir.direction_id, pl);
    state.routeShapeByDirection.set(dir.direction_id, latlngs);
  });

  // Fit map to route if we have polylines
  if (state.routePolylines.length > 0) {
    const group = L.featureGroup(state.routePolylines);
    map.fitBounds(group.getBounds().pad(0.1));
  }

  updateRouteFlowHighlight();
}

// With a bus selected, its direction's line is brought to full opacity and
// the other direction dimmed for contrast -- but the animated flow itself is
// drawn separately by updateBusFlowSegment() as just the bus->destination
// portion, not the whole line (showing the whole route flowing made it hard
// to tell where the bus actually was or how much distance remained).
function updateRouteFlowHighlight() {
  const activeDir = state.selectedTripDirectionId;
  for (const [dirId, pl] of state.routePolylinesByDirection) {
    const isActive = activeDir != null && dirId === activeDir;
    pl.setStyle({ opacity: activeDir == null ? 0.6 : isActive ? 0.9 : 0.2 });
  }
  updateBusFlowSegment();
}

// Finds the index of the shape point nearest a given lat/lon. Shape points
// are dense enough along a route like this that nearest-vertex is a good
// enough stand-in for a true perpendicular projection onto the line.
function nearestShapeIndex(latlngs, lat, lon) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < latlngs.length; i++) {
    const dLat = latlngs[i][0] - lat;
    const dLon = latlngs[i][1] - lon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Draws (or clears) the animated segment from the selected bus's current
// position to its destination -- the whole route if no stop is picked, or
// just the selected stop if one is. Re-run on every vehicle poll so the
// segment's start point tracks the bus as it moves.
function updateBusFlowSegment() {
  if (state.busFlowPolyline) {
    state.busFlowPolyline.remove();
    state.busFlowPolyline = null;
  }

  const dirId = state.selectedTripDirectionId;
  if (dirId == null) return;

  const bus = state.vehicles.find((v) => v.id === state.selectedBusId);
  if (!bus || !bus.lat || !bus.lon) return;

  const latlngs = state.routeShapeByDirection.get(dirId);
  if (!latlngs || latlngs.length < 2) return;

  const busIdx = nearestShapeIndex(latlngs, bus.lat, bus.lon);

  let destIdx = latlngs.length - 1;
  if (state.selectedStopId) {
    const stop = state.selectedTripStops.find((s) => s.stop_id === state.selectedStopId);
    if (stop) destIdx = nearestShapeIndex(latlngs, stop.stop_lat, stop.stop_lon);
  }

  const from = Math.min(busIdx, destIdx);
  const to = Math.max(busIdx, destIdx);
  const segment = latlngs.slice(from, to + 1);
  if (segment.length < 2) return;

  const isInbound = dirId === 1;
  state.busFlowPolyline = L.polyline(segment, {
    color: isInbound ? DIR_INBOUND_COLOR : DIR_OUTBOUND_COLOR,
    weight: 5,
    opacity: 0.95,
    className: "route-flow-active",
    bubblingMouseEvents: false, // don't let a click here bubble to the map and deselect the bus
  }).addTo(map);
}

// ─── Sidebar: Bus List ────────────────────────────────────────────────────────
function busListEmptyMessage() {
  const s = state.serviceStatus;
  if (!s) return `No buses on route ${currentRouteId()} right now.`;
  const route = s.routeShortName || currentRouteId();
  if (s.nowMin != null && s.nowMin < s.firstMin) {
    return `No buses yet today — first bus at ${formatTime12(s.firstService)}.`;
  }
  if (s.nextService) {
    return `No buses right now — next bus at ${formatTime12(s.nextService)}.`;
  }
  if (s.lastService) {
    return `Service has ended for today — last bus was at ${formatTime12(s.lastService)}.`;
  }
  return `No buses on route ${route} right now.`;
}

function updateBusList() {
  const el = document.getElementById("bus-list");
  if (state.vehicles.length === 0) {
    el.innerHTML = `<div class="empty-state">${escapeHtml(busListEmptyMessage())}</div>`;
    return;
  }

  el.innerHTML = state.vehicles
    .map(
      (v) => `
    <div class="bus-item" data-bus-id="${escapeHtml(v.id)}">
      <div class="bus-badge">${escapeHtml(currentRouteId())}</div>
      <div class="bus-info">
        <div class="bus-label">Bus #${escapeHtml(v.label || v.id)}</div>
        <div class="bus-meta">${v.trip_id ? `Trip ${escapeHtml(v.trip_id)}` : "No trip"}</div>
      </div>
    </div>
  `,
    )
    .join("");

  const ts = state.lastVehicleFetch
    ? `Updated ${state.lastVehicleFetch.toLocaleTimeString("en-CA", { timeZone: HALIFAX_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "";
  document.getElementById("last-update").textContent = ts;
}

function updateRouteHeader() {
  document.title = `Route ${currentRouteId()} Bus Tracker`;
}

async function switchRoute() {
  // Clear map elements for the old route
  for (const [, marker] of state.vehicleMarkers) marker.remove();
  state.vehicleMarkers.clear();
  for (const m of state.stopMarkers) m.remove();
  state.stopMarkers = [];
  state.selectedBusId = null;
  state.selectedStopId = null;
  state.selectedTripStops = [];
  state.selectedTripDirectionId = null;
  for (const pl of state.routePolylines) pl.remove();
  state.routePolylines = [];
  state.routePolylinesByDirection.clear();
  state.routeShapeByDirection.clear();
  state.stopScheduleCache.clear();
  if (state.busFlowPolyline) {
    state.busFlowPolyline.remove();
    state.busFlowPolyline = null;
  }

  // Clear data
  state.vehicles = [];
  state.stops = [];
  state.schedule = [];
  state.allTripUpdates = [];
  state.alerts = [];
  state.notifiedTripIds.clear();

  updateRouteHeader();

  try {
    await fetchStops();
  } catch (err) {
    console.warn("[BusTracker] Could not load stops:", err);
  }
  try {
    await fetchRoutePolyline();
  } catch (err) {
    console.warn("[BusTracker] Could not load route polyline:", err);
  }
  try {
    await fetchVehicles();
  } catch (err) {
    console.error("[BusTracker] Vehicle fetch failed:", err);
    updateStatusDot(false);
  }
  try {
    await fetchTripUpdates();
  } catch (err) {
    console.warn("[BusTracker] Trip update fetch failed:", err);
  }

  const stopId = getActiveStop();
  if (stopId) {
    try {
      await fetchScheduleForStop(stopId);
    } catch {}
  }

  updateCommutePanel();
  await checkServiceStatus();
  await checkAlerts();
}

function panToBus(id) {
  const v = state.vehicles.find((x) => x.id === id);
  if (v && v.lat && v.lon) {
    map.panTo([v.lat, v.lon], { animate: true, duration: 0.5 });
    state.vehicleMarkers.get(id)?.openPopup();
  }
  selectBus(id);
}

// Event delegation instead of inline onclick= -- the CSP's script-src-attr
// 'none' silently blocks inline handlers, and this list is re-rendered
// wholesale on every vehicle poll anyway, so a single listener on the
// container is both correct and simpler than rebinding per item.
document.getElementById("bus-list").addEventListener("click", (e) => {
  const item = e.target.closest(".bus-item");
  if (item) panToBus(item.dataset.busId);
});

// ─── Status Dot ───────────────────────────────────────────────────────────────
function updateStatusDot(ok) {
  const dot = document.getElementById("status-dot");
  dot.className = ok ? "green" : "red";
}

// ─── Commute Panel ────────────────────────────────────────────────────────────
function updateCommutePanel() {
  const window = getActiveWindow();
  const stopId = getActiveStop();

  const badge = document.getElementById("commute-direction-indicator");
  if (window === "morning") {
    badge.textContent = "🌅 Morning Commute";
    badge.className = "direction-badge morning";
  } else if (window === "evening") {
    badge.textContent = "🌆 Evening Commute";
    badge.className = "direction-badge evening";
  } else {
    badge.textContent = stopId
      ? "Outside commute window"
      : "Configure stops in Settings";
    badge.className = "direction-badge";
  }

  updateNextBuses(stopId);
  updateScheduleList(stopId);
}

function computeNextBuses(stopId, limit = 3) {
  return NextBuses.computeNextBuses(state.schedule, stopId, state.allTripUpdates, nowMinutes(), limit);
}

function updateNextBuses(stopId) {
  const el = document.getElementById("next-buses");
  const upcoming = computeNextBuses(stopId);

  if (upcoming.length === 0) {
    el.innerHTML =
      '<div class="empty-state">No upcoming buses in the next 2 hours.</div>';
    return;
  }

  el.innerHTML = upcoming
    .map((s) => {
      const ma = s.minutesAway;
      let countdownClass = "countdown-normal";
      if (ma <= 2) countdownClass = "countdown-imminent";
      else if (ma <= 8) countdownClass = "countdown-soon";

      let delayHtml;
      if (s.delayMin > 1) {
        delayHtml = `<div class="delay late">+${s.delayMin} min late</div>`;
      } else if (s.delayMin < -1) {
        delayHtml = `<div class="delay early">${s.delayMin} min early</div>`;
      } else {
        delayHtml = `<div class="delay ontime">On time</div>`;
      }

      return `
      <div class="next-bus-item">
        <div class="next-bus-time">
          <div class="time">${formatTime12(minutesToTimeString(s.estimatedMin))}</div>
          ${delayHtml}
        </div>
        <div class="next-bus-countdown">
          <span class="countdown-value ${countdownClass}">${formatCountdown(ma)}</span>
          <span class="countdown-unit">min</span>
          <div class="trip-headsign">${escapeHtml(s.trip_headsign || "")}</div>
        </div>
      </div>
    `;
    })
    .join("");

  checkNotifications(upcoming, stopId);
}

function updateScheduleList(stopId) {
  const el = document.getElementById("schedule-list");
  if (!stopId || state.schedule.length === 0) {
    el.innerHTML = '<div class="empty-state">–</div>';
    return;
  }

  const nowMin = nowMinutes();
  const items = state.schedule.slice(0, 40); // show up to 40

  el.innerHTML = items
    .map((s) => {
      const depMin = timeStringToMinutes(s.departure_time);
      const past = depMin < nowMin - 1;
      return `
      <div class="schedule-item ${past ? "past" : ""}">
        <span class="sched-time">${formatTime12(s.departure_time)}</span>
        <span class="sched-headsign">${escapeHtml(s.trip_headsign || "")}</span>
      </div>
    `;
    })
    .join("");
}

// ─── Notifications ────────────────────────────────────────────────────────────
function notificationsSupported() {
  return typeof Notification !== "undefined" && Notification.permission !== undefined;
}

function checkNotifications(upcoming, stopId) {
  if (!settings.notifEnable) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  const threshold = settings.notifMinutes;
  for (const s of upcoming) {
    if (s.minutesAway <= threshold && s.minutesAway >= 0) {
      const key = `${s.trip_id}_${stopId}`;
      if (!state.notifiedTripIds.has(key)) {
        state.notifiedTripIds.add(key);
        const stopName =
          state.stops.find((x) => x.stop_id === stopId)?.stop_name ||
          "your stop";
        const departBy = minutesToTimeString(
          nowMinutes() + Math.round(s.minutesAway),
        );
        fireNotification(
          `Route 194 arriving in ~${Math.round(s.minutesAway)} min`,
          `Bus at ${stopName} — depart by ${formatTime12(departBy)}`,
        );
      }
    }
  }
}

function fireNotification(title, body) {
  try {
    new Notification(title, {
      body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚌</text></svg>',
      tag: "rt194-" + Date.now(),
    });
    console.log("[BusTracker] Notification fired:", title, body);
  } catch (e) {
    console.warn("[BusTracker] Notification failed:", e.message);
  }
}

// Exposed globally for testing
window.testNotification = () => {
  if (!notificationsSupported()) {
    alert("Notifications are not supported in this browser.\nOn Safari, you need to add this page to the Dock as a web app.");
    return;
  }
  Notification.requestPermission().then((perm) => {
    if (perm === "granted") {
      fireNotification(
        "Route 194 test",
        "This is a test notification from Route 194 Bus Tracker.",
      );
    } else {
      alert("Notification permission not granted.");
    }
  });
};

// ─── Settings Panel ───────────────────────────────────────────────────────────
function populateStopDropdowns() {
  const mSelect = document.getElementById("morning-stop");
  const eSelect = document.getElementById("evening-stop");

  const opts = state.stops
    .map(
      (s) =>
        `<option value="${escapeHtml(s.stop_id)}">${escapeHtml(s.stop_name)}</option>`,
    )
    .join("");
  const placeholder = '<option value="">— Select a stop —</option>';

  mSelect.innerHTML = placeholder + opts;
  eSelect.innerHTML = placeholder + opts;

  // Restore saved values
  if (settings.morningStop) mSelect.value = settings.morningStop;
  if (settings.eveningStop) eSelect.value = settings.eveningStop;
}

function applySettingsToForm() {
  const routeSel = document.getElementById("route-select");
  if (routeSel) routeSel.value = settings.selectedRoute || "194";
  document.getElementById("morning-stop").value = settings.morningStop;
  document.getElementById("evening-stop").value = settings.eveningStop;
  document.getElementById("morning-start").value = settings.morningStart;
  document.getElementById("morning-end").value = settings.morningEnd;
  document.getElementById("evening-start").value = settings.eveningStart;
  document.getElementById("evening-end").value = settings.eveningEnd;
  document.getElementById("notif-enable").checked = settings.notifEnable;
  document.getElementById("notif-minutes").value = settings.notifMinutes;
  document.getElementById("auto-traffic-enable").checked = settings.autoTrafficEnable;
}

document
  .getElementById("settings-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const prevStop = getActiveStop();

    settings.morningStop = document.getElementById("morning-stop").value;
    settings.eveningStop = document.getElementById("evening-stop").value;
    settings.morningStart = document.getElementById("morning-start").value;
    settings.morningEnd = document.getElementById("morning-end").value;
    settings.eveningStart = document.getElementById("evening-start").value;
    settings.eveningEnd = document.getElementById("evening-end").value;
    settings.notifEnable = document.getElementById("notif-enable").checked;
    settings.notifMinutes = parseInt(
      document.getElementById("notif-minutes").value,
    );
    settings.autoTrafficEnable = document.getElementById("auto-traffic-enable").checked;
    saveSettings(settings);

    // Request notification permission if enabled
    if (settings.notifEnable && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    // Flash save indicator
    const indicator = document.getElementById("settings-saved");
    indicator.hidden = false;
    setTimeout(() => {
      indicator.hidden = true;
    }, 2000);

    const newStop = getActiveStop();
    if (newStop !== prevStop) {
      await fetchScheduleForStop(newStop);
    }
    updateCommutePanel();
  });

// ─── Route Select (header) ────────────────────────────────────────────────────
document.getElementById("route-select").addEventListener("change", async () => {
  const newRoute = document.getElementById("route-select").value;
  if (newRoute === settings.selectedRoute) return;

  settings.selectedRoute = newRoute;
  // Boarding stops belong to the old route -- clear them.
  settings.morningStop = "";
  settings.eveningStop = "";
  saveSettings(settings);

  await switchRoute();
  applySettingsToForm();
});

// ─── Sidebar Collapse ─────────────────────────────────────────────────────────
// Collapsed by default so the map stays the primary focus; the header and
// minibar (route, traffic, refresh) stay visible either way.
function applySidebarExpanded(expanded) {
  document.getElementById("app").classList.toggle("expanded", expanded);
  const btn = document.getElementById("sidebar-toggle-btn");
  btn.textContent = expanded ? "▴" : "▾";
  btn.title = expanded ? "Collapse sidebar" : "Expand sidebar";
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-expanded", String(expanded));
  setTimeout(() => map.invalidateSize(), 50);
}

document.getElementById("sidebar-toggle-btn").addEventListener("click", () => {
  settings.sidebarExpanded = !settings.sidebarExpanded;
  saveSettings(settings);
  applySidebarExpanded(settings.sidebarExpanded);
});

// ─── Bus Icon Legend (collapsible detail) ─────────────────────────────────────
document.getElementById("legend-info-btn").addEventListener("click", () => {
  const btn = document.getElementById("legend-info-btn");
  const detail = document.getElementById("legend-detail");
  const expanded = detail.hidden;
  detail.hidden = !expanded;
  btn.setAttribute("aria-expanded", String(expanded));
});

// ─── Tab Switching ────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    state.activeTab = tab;

    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    document.getElementById(`tab-${tab}`).classList.add("active");

    // Invalidate map size when map tab becomes visible
    if (tab === "map") setTimeout(() => map.invalidateSize(), 50);
  });
});

// ─── Refresh Button ───────────────────────────────────────────────────────────
// force=true bypasses the server's 15s cache, so this always pulls a fresh
// read from Halifax's live feed rather than possibly replaying whatever the
// last poll (from this tab or another) already cached.
document.getElementById("refresh-btn").addEventListener("click", async () => {
  try {
    await Promise.all([fetchVehicles(true), fetchTripUpdates(true)]);
    updateCommutePanel();
  } catch (err) {
    console.error("Refresh error:", err);
    updateStatusDot(false);
  } finally {
    // A manual refresh just happened -- restart the countdown from a full
    // 15s instead of leaving it on the original interval's phase.
    scheduleVehiclePoll();
    updateNextRefreshCountdown();
  }
});

// ─── Test Notification Button ─────────────────────────────────────────────────
document.getElementById("test-notif-btn").addEventListener("click", () => {
  window.testNotification();
});

// ─── Service Warning Bar ─────────────────────────────────────────────────────
const SERVICE_WARNING_DISMISS_KEY = "metromaps_dismissed_service_warning";
let currentServiceWarningMessage = "";

async function checkServiceStatus() {
  try {
    const s = await apiFetch(
      `/api/service-status?route_id=${encodeURIComponent(currentRouteId())}`,
    );
    state.serviceStatus = s;
    updateBusList();

    const bar = document.getElementById("service-warning");
    const text = document.getElementById("service-warning-text");

    const activeVehicles = state.vehicles.filter((v) => v.trip_id);
    if (activeVehicles.length === 0) {
      const route = s.routeShortName || currentRouteId();
      if (s.nowMin != null && s.nowMin < s.firstMin) {
        currentServiceWarningMessage = `Route ${route} is not yet in service — first bus at ${formatTime12(s.firstService)}`;
      } else if (s.nextService) {
        currentServiceWarningMessage = `Route ${route} has no active buses — next bus at ${formatTime12(s.nextService)}`;
      } else if (s.lastService) {
        currentServiceWarningMessage = `Route ${route} has finished service for today — last bus was at ${formatTime12(s.lastService)}`;
      } else {
        currentServiceWarningMessage = `Route ${route} is not currently in service`;
      }
      text.textContent = currentServiceWarningMessage;
      // Stay dismissed only while the message is unchanged — a status change
      // (e.g. "not yet in service" → "finished for today") surfaces again.
      const dismissed = sessionStorage.getItem(SERVICE_WARNING_DISMISS_KEY);
      bar.hidden = dismissed === currentServiceWarningMessage;
    } else {
      bar.hidden = true;
    }
  } catch (err) {
    console.warn("[BusTracker] Service status check failed:", err);
  }
}

document
  .getElementById("service-warning-dismiss")
  .addEventListener("click", () => {
    sessionStorage.setItem(
      SERVICE_WARNING_DISMISS_KEY,
      currentServiceWarningMessage,
    );
    document.getElementById("service-warning").hidden = true;
  });

// ─── Service Alert Banner (detours, disruptions) ─────────────────────────────
const ALERT_DISMISS_KEY = "metromaps_dismissed_alerts";
let currentAlertSignature = "";

function alertSignature(alerts) {
  return alerts.map((a) => a.header).join("|");
}

async function checkAlerts() {
  try {
    state.alerts = await apiFetch(
      `/api/alerts?route_id=${encodeURIComponent(currentRouteId())}`,
    );
    const banner = document.getElementById("alert-banner");
    const list = document.getElementById("alert-banner-list");
    if (state.alerts.length === 0) {
      banner.hidden = true;
      list.innerHTML = "";
      currentAlertSignature = "";
      return;
    }
    currentAlertSignature = alertSignature(state.alerts);
    list.innerHTML = state.alerts
      .map(
        (a) =>
          `<div class="alert-item" title="${escapeHtml(a.description)}"><span>🚧</span><span>${escapeHtml(a.header)}</span></div>`,
      )
      .join("");
    // Stay dismissed only while the same set of alerts is still active — a
    // new or changed alert should surface even if an earlier one was dismissed.
    const dismissed = sessionStorage.getItem(ALERT_DISMISS_KEY);
    banner.hidden = dismissed === currentAlertSignature;
  } catch (err) {
    console.warn("[BusTracker] Alert check failed:", err);
  }
}

document.getElementById("alert-dismiss").addEventListener("click", () => {
  sessionStorage.setItem(ALERT_DISMISS_KEY, currentAlertSignature);
  document.getElementById("alert-banner").hidden = true;
});

// ─── Polling ──────────────────────────────────────────────────────────────────
async function pollVehicles() {
  try {
    await fetchVehicles();
    state.fetchErrors = 0;
    // If active-trip vehicles just became available, the service banner may be stale — hide it
    if (state.vehicles.some((v) => v.trip_id)) {
      document.getElementById("service-warning").hidden = true;
    }
  } catch (err) {
    console.error("[BusTracker] Vehicle fetch error:", err);
    state.fetchErrors++;
    updateStatusDot(false);
  }
}

// Self-rescheduling (rather than setInterval) so a manual Refresh can reset
// the countdown to a full 15s instead of it staying on whatever phase the
// original interval happened to be in.
let vehiclePollTimer = null;
const VEHICLE_POLL_INTERVAL_MS = 15_000;

function scheduleVehiclePoll(delayMs = VEHICLE_POLL_INTERVAL_MS) {
  if (vehiclePollTimer) clearTimeout(vehiclePollTimer);
  state.nextVehicleRefreshAt = Date.now() + delayMs;
  vehiclePollTimer = setTimeout(async () => {
    await pollVehicles();
    scheduleVehiclePoll();
  }, delayMs);
}

function updateNextRefreshCountdown() {
  const el = document.getElementById("next-refresh");
  if (!el || state.nextVehicleRefreshAt == null) return;
  const secondsLeft = Math.max(0, Math.round((state.nextVehicleRefreshAt - Date.now()) / 1000));
  el.textContent = `Next refresh in ${secondsLeft}s`;
}

async function pollTripUpdates() {
  try {
    await fetchTripUpdates();
    updateCommutePanel();
    updateVehicleMarkers();
  } catch (err) {
    console.error("[BusTracker] Trip update fetch error:", err);
  }
}

// ─── Bus Age Ticker (updates badge + open popup every second) ─────────────────
function tickBusAges() {
  const nowSec = Date.now() / 1000;
  for (const [id, marker] of state.vehicleMarkers) {
    const v = state.vehicles.find((x) => x.id === id);
    if (!v || !v.timestamp) continue;

    // Patch badge text/class directly — avoids full icon re-render flicker
    const iconEl = marker.getElement();
    if (iconEl) {
      const badge = iconEl.querySelector(".bus-age-badge");
      if (badge) {
        const ageS = Math.round(nowSec - v.timestamp);
        badge.textContent = `${ageS}s`;
        badge.className = `bus-age-badge${ageS < 30 ? "" : ageS < 90 ? " stale" : " very-stale"}`;
      }
    }

    // Patch the age text in place too -- rebuilding the whole popup every
    // second would (a) drop the delay badge, since this tick has no fresh
    // delayMin to pass in, and (b) reset any interactive state inside it
    // (e.g. the icon-legend toggle) on every tick.
    if (marker.isPopupOpen()) {
      const ageEl = marker.getPopup().getElement()?.querySelector(".popup-age-text");
      if (ageEl) {
        const ageS = Math.round(nowSec - v.timestamp);
        ageEl.textContent = `(${ageS}s ago)`;
      }
    }
  }
}

// ─── Countdown Timer (UI refresh every 15s) ───────────────────────────────────
function tickCommutePanel() {
  if (state.activeTab === "commute") {
    updateCommutePanel();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  console.log("[BusTracker] Initializing...");

  updateRouteHeader();

  // Load routes first so the selector is populated before applySettingsToForm
  try {
    await fetchRoutes();
  } catch (err) {
    console.warn("[BusTracker] Could not load routes:", err);
  }

  applySettingsToForm();
  applySidebarExpanded(settings.sidebarExpanded);
  await initTrafficControl();

  // Request notification permission up front if enabled
  if (settings.notifEnable && Notification.permission === "default") {
    Notification.requestPermission();
  }

  // Initial data load
  try {
    await fetchStops();
  } catch (err) {
    console.warn("[BusTracker] Could not load stops:", err);
  }

  try {
    await fetchRoutePolyline();
  } catch (err) {
    console.warn("[BusTracker] Could not load route polyline:", err);
  }

  try {
    await fetchVehicles();
  } catch (err) {
    console.error("[BusTracker] Initial vehicle fetch failed:", err);
    updateStatusDot(false);
  }

  try {
    await fetchTripUpdates();
  } catch (err) {
    console.warn("[BusTracker] Initial trip update fetch failed:", err);
  }

  const stopId = getActiveStop();
  if (stopId) {
    try {
      await fetchScheduleForStop(stopId);
    } catch (err) {
      console.warn("[BusTracker] Schedule fetch failed:", err);
    }
  }

  updateCommutePanel();
  await checkServiceStatus();
  await checkAlerts();

  // Start polling
  scheduleVehiclePoll();
  updateNextRefreshCountdown();
  setInterval(pollTripUpdates, 15_000);
  setInterval(tickCommutePanel, 15_000);
  setInterval(tickBusAges, 1_000);
  setInterval(updateNextRefreshCountdown, 1_000);
  setInterval(checkServiceStatus, 5 * 60_000);
  setInterval(checkAlerts, 5 * 60_000);

  // Reload schedule for active stop every 5 minutes
  setInterval(async () => {
    const sid = getActiveStop();
    if (sid) {
      try {
        await fetchScheduleForStop(sid);
      } catch {}
      updateCommutePanel();
    }
  }, 5 * 60_000);

  console.log("[BusTracker] Ready.");
}

init().catch((err) => console.error("[BusTracker] Init error:", err));

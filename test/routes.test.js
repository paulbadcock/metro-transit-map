// Integration tests against the real Express app/route handlers. server.js
// only runs its network-download/app.listen startup when executed directly
// (see the process.argv[1] guard at the bottom of server.js), so importing
// it here just registers routes -- no real GTFS download or port bind.
// Fixture data is seeded directly into the exported gtfsData Maps, and each
// test binds its own ephemeral port so tests can run in parallel-safe
// isolation without touching the real data/gtfs/ directory.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app, gtfsData } from '../server.js';

let server;
let baseUrl;

before(() => {
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  gtfsData.routes.clear();
  gtfsData.stops.clear();
  gtfsData.trips.clear();
  gtfsData.stopTimesByTrip.clear();
  gtfsData.shapes.clear();
  gtfsData.routeInfoCache.clear();
  gtfsData.calendars.clear();
  gtfsData.calendarDates.clear();

  gtfsData.routes.set('194', { route_id: '194', route_short_name: '194', route_long_name: 'Downtown Express' });
  gtfsData.routes.set('1', { route_id: '1', route_short_name: '1', route_long_name: 'Spring Garden' });

  gtfsData.stops.set('s1', { stop_id: 's1', stop_name: 'Alpha St', stop_lat: 44.65, stop_lon: -63.58 });
  gtfsData.stops.set('s2', { stop_id: 's2', stop_name: 'Beta Ave', stop_lat: 44.66, stop_lon: -63.59 });

  gtfsData.trips.set('t1', { trip_id: 't1', route_id: '194', direction_id: '0', shape_id: 'sh1', trip_headsign: 'Downtown', service_id: 'weekday' });

  gtfsData.stopTimesByTrip.set('t1', [
    { trip_id: 't1', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 's1', stop_sequence: 1 },
    { trip_id: 't1', arrival_time: '08:10:00', departure_time: '08:10:00', stop_id: 's2', stop_sequence: 2 },
  ]);

  gtfsData.shapes.set('sh1', [[44.65, -63.58], [44.66, -63.59]]);
});

describe('GET /api/routes', () => {
  test('returns routes sorted numerically by short name', async () => {
    const res = await fetch(`${baseUrl}/api/routes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.map(r => r.route_short_name), ['1', '194']);
  });
});

describe('GET /api/stops', () => {
  test('returns stops serving the requested route, sorted by name', async () => {
    const res = await fetch(`${baseUrl}/api/stops?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.map(s => s.stop_id), ['s1', 's2']);
  });

  test('returns an empty array for a route with no trips', async () => {
    const res = await fetch(`${baseUrl}/api/stops?route_id=999`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('includes the direction(s) that serve each stop', async () => {
    gtfsData.trips.set('t2', { trip_id: 't2', route_id: '194', direction_id: '1', shape_id: 'sh1', trip_headsign: 'Uptown', service_id: 'weekday' });
    gtfsData.stopTimesByTrip.set('t2', [
      { trip_id: 't2', arrival_time: '09:00:00', departure_time: '09:00:00', stop_id: 's2', stop_sequence: 1 },
    ]);

    const res = await fetch(`${baseUrl}/api/stops?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const s1 = body.find((s) => s.stop_id === 's1');
    const s2 = body.find((s) => s.stop_id === 's2');
    assert.deepEqual(s1.directions, [0]);
    assert.deepEqual(s2.directions, [0, 1]);
  });
});

describe('GET /api/schedule', () => {
  test('requires stop_id', async () => {
    const res = await fetch(`${baseUrl}/api/schedule?route_id=194`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /stop_id/);
  });

  test('returns departures for the given stop sorted by time', async () => {
    const res = await fetch(`${baseUrl}/api/schedule?route_id=194&stop_id=s2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].trip_id, 't1');
    assert.equal(body[0].departure_time, '08:10:00');
  });

  test('filters by direction when provided', async () => {
    const res = await fetch(`${baseUrl}/api/schedule?route_id=194&stop_id=s1&direction=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  // Regression coverage for a real bug: a route with separate weekday/
  // Saturday/holiday calendars (the live data has exactly this, via GTFS
  // service_id families like "259.0.1"/"259.0.2"/"259.0.3") was showing
  // every one of those overlapping schedules merged together every day,
  // calendar.txt/calendar_dates.txt ignored entirely -- near-duplicate
  // departure times a few minutes apart, several not actually running
  // today, with inconsistent delay info between them since only the trips
  // genuinely running today ever have real-time data to match against.
  describe('today-only service calendar filtering', () => {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    function todayDateAndDay() {
      // Mirrors getTodayServiceIds()'s own date/day derivation in server.js.
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Halifax' }));
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return { dateStr: `${y}${m}${d}`, dayName: dayNames[now.getDay()] };
    }

    function calendarRow(serviceId, activeDay) {
      const row = { service_id: serviceId, start_date: '20200101', end_date: '20301231' };
      for (const d of dayNames) row[d] = d === activeDay ? '1' : '0';
      return row;
    }

    test('excludes a trip whose service calendar is not active today', async () => {
      const { dayName } = todayDateAndDay();
      const otherDayName = dayNames[(dayNames.indexOf(dayName) + 1) % 7];

      gtfsData.calendars.set('today-svc', calendarRow('today-svc', dayName));
      gtfsData.calendars.set('other-svc', calendarRow('other-svc', otherDayName));

      gtfsData.trips.set('t-today', { trip_id: 't-today', route_id: '194', direction_id: '0', shape_id: 'sh1', trip_headsign: 'Today', service_id: 'today-svc' });
      gtfsData.trips.set('t-other', { trip_id: 't-other', route_id: '194', direction_id: '0', shape_id: 'sh1', trip_headsign: 'Other day', service_id: 'other-svc' });
      gtfsData.stopTimesByTrip.set('t-today', [
        { trip_id: 't-today', arrival_time: '09:00:00', departure_time: '09:00:00', stop_id: 's2', stop_sequence: 1 },
      ]);
      gtfsData.stopTimesByTrip.set('t-other', [
        { trip_id: 't-other', arrival_time: '09:05:00', departure_time: '09:05:00', stop_id: 's2', stop_sequence: 1 },
      ]);

      const res = await fetch(`${baseUrl}/api/schedule?route_id=194&stop_id=s2`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.map((s) => s.trip_id), ['t-today']);
    });

    test('respects a calendar_dates removal exception for today (e.g. a holiday)', async () => {
      const { dateStr, dayName } = todayDateAndDay();

      gtfsData.calendars.set('removed-today', calendarRow('removed-today', dayName));
      gtfsData.calendarDates.set('removed-today', [
        { service_id: 'removed-today', date: dateStr, exception_type: '2' },
      ]);
      gtfsData.trips.set('t-removed', { trip_id: 't-removed', route_id: '194', direction_id: '0', shape_id: 'sh1', trip_headsign: 'Removed', service_id: 'removed-today' });
      gtfsData.stopTimesByTrip.set('t-removed', [
        { trip_id: 't-removed', arrival_time: '09:00:00', departure_time: '09:00:00', stop_id: 's2', stop_sequence: 1 },
      ]);

      const res = await fetch(`${baseUrl}/api/schedule?route_id=194&stop_id=s2`);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).map((s) => s.trip_id), []);
    });

    test('falls back to unfiltered when no calendar data is loaded at all', async () => {
      // beforeEach leaves calendars/calendarDates empty -- t1's service_id
      // ('weekday') has no matching calendar entry, but getTodayServiceIds()
      // returns null (not an empty set) when there's no calendar data to
      // filter by in the first place, so nothing should be excluded.
      const res = await fetch(`${baseUrl}/api/schedule?route_id=194&stop_id=s2`);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).map((s) => s.trip_id), ['t1']);
    });
  });
});

describe('GET /api/route-stops', () => {
  test('groups stops and shape by direction', async () => {
    const res = await fetch(`${baseUrl}/api/route-stops?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].direction_id, 0);
    assert.equal(body[0].trip_headsign, 'Downtown');
    assert.deepEqual(body[0].stops.map(s => s.stop_id), ['s1', 's2']);
    assert.deepEqual(body[0].shape, [[44.65, -63.58], [44.66, -63.59]]);
  });
});

describe('GET /api/status', () => {
  test('reports loaded counts for the requested route', async () => {
    const res = await fetch(`${baseUrl}/api/status?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.routeId, '194');
    assert.equal(body.routesLoaded, 2);
    assert.equal(body.stopsLoaded, 2);
    assert.equal(body.routeTrips, 1);
  });

  // CI's publish job bumps and tags this on every push to main (see
  // .github/workflows/ci.yml) -- surfaced in the UI (Settings > Debug) so a
  // stale deploy is visible without grepping app.js by hand.
  test('includes the app version from package.json', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body = await res.json();
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
  });
});

describe('security headers', () => {
  test('sets CSP and nosniff headers via helmet', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('unknown route', () => {
  test('returns 404 without hitting the error middleware', async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

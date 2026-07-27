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

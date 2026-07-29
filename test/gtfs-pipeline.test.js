// Integration test for the file-loading pipeline (loadGtfsData() parsing
// real GTFS CSVs off disk) -- distinct from routes.test.js, which seeds
// gtfsData's Maps directly and only exercises the route handlers. This is
// the one place the fixtures in test/fixtures/gtfs/ get parsed end to end,
// the same pipeline a real GTFS download feeds into. The same fixture set
// doubles as offline/local dev data -- see CLAUDE.md.
//
// GTFS_DIR is read by server.js at module load time, so it must be set
// before server.js is imported -- hence the dynamic import behind a
// top-level await instead of a static one.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.GTFS_DIR = join(__dirname, 'fixtures', 'gtfs');

const { app, loadGtfsData, gtfsData } = await import('../server.js');

let server;
let baseUrl;

before(() => {
  loadGtfsData();
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
});

after(() => {
  server.close();
});

describe('loadGtfsData from disk', () => {
  test('parses the fixture GTFS files into gtfsData', () => {
    assert.equal(gtfsData.routes.size, 1);
    assert.equal(gtfsData.stops.size, 2);
    assert.equal(gtfsData.trips.size, 2);
    assert.equal(gtfsData.stopTimesByTrip.size, 2);
    assert.equal(gtfsData.shapes.size, 2);
    assert.equal(gtfsData.calendars.size, 1);
  });
});

describe('GET /api/routes (loaded from disk)', () => {
  test('returns the fixture route', async () => {
    const res = await fetch(`${baseUrl}/api/routes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, [{ route_id: '194', route_short_name: '194', route_long_name: 'Sackville Express' }]);
  });
});

describe('GET /api/stops (loaded from disk)', () => {
  test('returns both fixture stops with their directions', async () => {
    const res = await fetch(`${baseUrl}/api/stops?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.map(s => s.stop_id).sort(), ['1001', '1002']);
    const cobequid = body.find(s => s.stop_id === '1001');
    assert.deepEqual(cobequid.directions, [0, 1]);
  });
});

describe('GET /api/route-stops (loaded from disk)', () => {
  test('groups the fixture stops and shape by direction', async () => {
    const res = await fetch(`${baseUrl}/api/route-stops?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2);

    const outbound = body.find(d => d.direction_id === 0);
    assert.equal(outbound.trip_headsign, 'Downtown');
    assert.deepEqual(outbound.stops.map(s => s.stop_id), ['1001', '1002']);
    assert.deepEqual(outbound.shape, [[44.7896, -63.6947], [44.6488, -63.5752]]);
  });
});

describe('GET /api/schedule (loaded from disk)', () => {
  test('returns the fixture departure for the requested stop', async () => {
    const res = await fetch(`${baseUrl}/api/schedule?route_id=194&stop_id=1002&direction=0`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].trip_id, 't-out-1');
    assert.equal(body[0].departure_time, '07:30:00');
  });
});

describe('GET /api/status (loaded from disk)', () => {
  test('reports counts matching the fixture data', async () => {
    const res = await fetch(`${baseUrl}/api/status?route_id=194`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.routesLoaded, 1);
    assert.equal(body.stopsLoaded, 2);
    assert.equal(body.tripsLoaded, 2);
    assert.equal(body.routeStops, 2);
    assert.equal(body.routeTrips, 2);
    assert.equal(body.stopTimesLoaded, 4);
  });
});

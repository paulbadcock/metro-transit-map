import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// next-buses.js is a plain classic script in the browser (window.NextBuses),
// not an ES module -- createRequire loads its CommonJS export path instead.
const require = createRequire(import.meta.url);
const { computeNextBuses, buildDelayMap } = require('../public/next-buses.js');

describe('buildDelayMap', () => {
  test('keys updates by trip_id_stop_id', () => {
    const map = buildDelayMap([
      { trip_id: 't1', stop_id: 's1', departure_delay: 120 },
      { trip_id: 't2', stop_id: 's2', departure_delay: -60 },
    ]);
    assert.equal(map['t1_s1'].departure_delay, 120);
    assert.equal(map['t2_s2'].departure_delay, -60);
  });

  test('skips updates with no stop_id', () => {
    const map = buildDelayMap([{ trip_id: 't1', departure_delay: 120 }]);
    assert.deepEqual(map, {});
  });
});

describe('computeNextBuses', () => {
  const stopId = 's1';

  test('returns empty array when there is no stopId', () => {
    assert.deepEqual(computeNextBuses([{ trip_id: 't1', departure_time: '08:00' }], null, [], 480), []);
  });

  test('returns empty array when schedule is empty', () => {
    assert.deepEqual(computeNextBuses([], stopId, [], 480), []);
  });

  test('computes minutesAway from departure time and current time', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }]; // 490 min
    const result = computeNextBuses(schedule, stopId, [], 480); // now = 08:00
    assert.equal(result.length, 1);
    assert.equal(result[0].minutesAway, 10);
    assert.equal(result[0].delayMin, 0);
  });

  test('applies a matching delay update to estimatedMin/minutesAway', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }];
    const tripUpdates = [{ trip_id: 't1', stop_id: stopId, departure_delay: 300 }]; // +5 min
    const result = computeNextBuses(schedule, stopId, tripUpdates, 480);
    assert.equal(result[0].delayMin, 5);
    assert.equal(result[0].estimatedMin, 495); // 490 + 5
    assert.equal(result[0].minutesAway, 15);
  });

  test('ignores a delay update for a different stop_id', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }];
    const tripUpdates = [{ trip_id: 't1', stop_id: 'other-stop', departure_delay: 300 }];
    const result = computeNextBuses(schedule, stopId, tripUpdates, 480);
    assert.equal(result[0].delayMin, 0);
  });

  test('filters out trips more than 120 minutes away', () => {
    const schedule = [{ trip_id: 't1', departure_time: '11:00' }]; // 660 min, 180 away
    const result = computeNextBuses(schedule, stopId, [], 480);
    assert.equal(result.length, 0);
  });

  test('keeps trips up to 1 minute in the past (already-departing bus)', () => {
    const schedule = [{ trip_id: 't1', departure_time: '07:59' }]; // 479 min, -1 away
    const result = computeNextBuses(schedule, stopId, [], 480);
    assert.equal(result.length, 1);
  });

  test('sorts by soonest and respects the limit', () => {
    const schedule = [
      { trip_id: 't1', departure_time: '08:30' },
      { trip_id: 't2', departure_time: '08:05' },
      { trip_id: 't3', departure_time: '08:15' },
    ];
    const result = computeNextBuses(schedule, stopId, [], 480, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].trip_id, 't2');
    assert.equal(result[1].trip_id, 't3');
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// next-buses.js is a plain classic script in the browser (window.NextBuses),
// not an ES module -- createRequire loads its CommonJS export path instead.
const require = createRequire(import.meta.url);
const { computeNextBuses, buildDelayMap, getTripDelayMinutes } = require('../public/next-buses.js');

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
  const started = (...tripIds) => new Set(tripIds);

  test('returns empty array when there is no stopId', () => {
    assert.deepEqual(computeNextBuses([{ trip_id: 't1', departure_time: '08:00' }], null, [], started(), 480), []);
  });

  test('returns empty array when schedule is empty', () => {
    assert.deepEqual(computeNextBuses([], stopId, [], started(), 480), []);
  });

  test('computes minutesAway from departure time and current time', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }]; // 490 min
    const result = computeNextBuses(schedule, stopId, [], started(), 480); // now = 08:00
    assert.equal(result.length, 1);
    assert.equal(result[0].minutesAway, 10);
    assert.equal(result[0].delayMin, 0);
  });

  test('applies a matching delay update to estimatedMin/minutesAway, for a trip that has started', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }];
    const tripUpdates = [{ trip_id: 't1', stop_id: stopId, departure_delay: 300 }]; // +5 min
    const result = computeNextBuses(schedule, stopId, tripUpdates, started('t1'), 480);
    assert.equal(result[0].started, true);
    assert.equal(result[0].delayMin, 5);
    assert.equal(result[0].estimatedMin, 495); // 490 + 5
    assert.equal(result[0].minutesAway, 15);
  });

  // The core of the fix this covers: Halifax's GTFS-RT feed predicts a
  // vehicle's *upcoming* trip in its block by propagating forward from its
  // current trip's progress, before that next trip has actually started --
  // that's a forecast, not an observed fact (a faster/slower turnaround, a
  // different pickup, a swapped vehicle could all make it wrong). A trip
  // update can exist for a trip_id with no vehicle actually running it yet;
  // its delay must not be applied or displayed in that case.
  test('ignores a delay update for a trip no vehicle is running yet', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }];
    const tripUpdates = [{ trip_id: 't1', stop_id: stopId, departure_delay: 300 }];
    const result = computeNextBuses(schedule, stopId, tripUpdates, started(), 480); // empty active set
    assert.equal(result[0].started, false);
    assert.equal(result[0].delayMin, 0);
    assert.equal(result[0].estimatedMin, 490); // plain scheduled time, no adjustment
    assert.equal(result[0].minutesAway, 10);
  });

  test('ignores a delay update for a different stop_id', () => {
    const schedule = [{ trip_id: 't1', departure_time: '08:10' }];
    const tripUpdates = [{ trip_id: 't1', stop_id: 'other-stop', departure_delay: 300 }];
    const result = computeNextBuses(schedule, stopId, tripUpdates, started('t1'), 480);
    assert.equal(result[0].delayMin, 0);
  });

  test('filters out trips more than 120 minutes away', () => {
    const schedule = [{ trip_id: 't1', departure_time: '11:00' }]; // 660 min, 180 away
    const result = computeNextBuses(schedule, stopId, [], started(), 480);
    assert.equal(result.length, 0);
  });

  test('keeps trips up to 1 minute in the past (already-departing bus)', () => {
    const schedule = [{ trip_id: 't1', departure_time: '07:59' }]; // 479 min, -1 away
    const result = computeNextBuses(schedule, stopId, [], started(), 480);
    assert.equal(result.length, 1);
  });

  test('sorts by soonest and respects the limit', () => {
    const schedule = [
      { trip_id: 't1', departure_time: '08:30' },
      { trip_id: 't2', departure_time: '08:05' },
      { trip_id: 't3', departure_time: '08:15' },
    ];
    const result = computeNextBuses(schedule, stopId, [], started(), 480, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0].trip_id, 't2');
    assert.equal(result[1].trip_id, 't3');
  });
});

describe('getTripDelayMinutes', () => {
  const nowSec = 1_700_000_000;
  const nowMs = nowSec * 1000;

  test('returns null for a falsy trip_id', () => {
    assert.equal(getTripDelayMinutes(null, [], nowMs), null);
  });

  test('returns null when the feed has nothing for this trip', () => {
    const updates = [{ trip_id: 'other', stop_sequence: 1, departure_time: nowSec, departure_delay: 0 }];
    assert.equal(getTripDelayMinutes('t1', updates, nowMs), null);
  });

  // The bug this exists to fix: Halifax's feed doesn't reliably prune a
  // trip's early stop-time updates once the bus passes them, so the first
  // stop's long-past, originally-on-time reading would otherwise always
  // beat a later stop's much larger, current delay on stop_sequence alone.
  test('ignores a stale early-stop reading once its predicted time has passed', () => {
    const updates = [
      { trip_id: 't1', stop_sequence: 1, departure_time: nowSec - 1800, departure_delay: 0 },
      { trip_id: 't1', stop_sequence: 5, departure_time: nowSec + 300, departure_delay: 1200 },
    ];
    assert.equal(getTripDelayMinutes('t1', updates, nowMs), 20);
  });

  test('picks the nearest still-upcoming stop among several', () => {
    const updates = [
      { trip_id: 't1', stop_sequence: 3, departure_time: nowSec + 120, departure_delay: 120 },
      { trip_id: 't1', stop_sequence: 7, departure_time: nowSec + 600, departure_delay: 600 },
    ];
    assert.equal(getTripDelayMinutes('t1', updates, nowMs), 2);
  });

  test('falls back to stop_sequence when the feed gives no predicted times at all', () => {
    // A pure delay-only feed (no arrival_time/departure_time anywhere)
    // carries no signal about which entries are stale, so this case can't
    // be distinguished from a spec-compliant remaining-stops-only feed --
    // behavior is unchanged from picking the lowest sequence number.
    const updates = [
      { trip_id: 't1', stop_sequence: 1, departure_delay: 0 },
      { trip_id: 't1', stop_sequence: 5, departure_delay: 1200 },
    ];
    assert.equal(getTripDelayMinutes('t1', updates, nowMs), 0);
  });

  test('when every reading is in the past, uses the most recent one rather than the lowest sequence', () => {
    const updates = [
      { trip_id: 't1', stop_sequence: 1, departure_time: nowSec - 1000, departure_delay: 0 },
      { trip_id: 't1', stop_sequence: 5, departure_time: nowSec - 100, departure_delay: 600 },
    ];
    assert.equal(getTripDelayMinutes('t1', updates, nowMs), 10);
  });

  test('falls back to arrival_time/arrival_delay when departure fields are absent', () => {
    const updates = [{ trip_id: 't1', stop_sequence: 1, arrival_time: nowSec + 60, arrival_delay: 180 }];
    assert.equal(getTripDelayMinutes('t1', updates, nowMs), 3);
  });
});

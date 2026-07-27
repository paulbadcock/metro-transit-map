import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  splitCsvLine,
  groupTripsByDirection,
  pickCanonicalShapeId,
  pickBestTrip,
  computeActiveServiceIds,
} from '../lib/gtfs-utils.js';

describe('splitCsvLine', () => {
  test('splits plain comma-separated values', () => {
    assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  });

  test('keeps commas inside quoted fields intact', () => {
    assert.deepEqual(splitCsvLine('a,"b, with comma",c'), ['a', 'b, with comma', 'c']);
  });

  test('handles an empty trailing field', () => {
    assert.deepEqual(splitCsvLine('a,b,'), ['a', 'b', '']);
  });
});

describe('parseCsv', () => {
  test('parses headers and rows into objects', () => {
    const rows = parseCsv('stop_id,stop_name\n1,Main St\n2,Elm St\n');
    assert.deepEqual(rows, [
      { stop_id: '1', stop_name: 'Main St' },
      { stop_id: '2', stop_name: 'Elm St' },
    ]);
  });

  test('strips a leading BOM from the first header', () => {
    const rows = parseCsv('﻿stop_id,stop_name\n1,Main St\n');
    assert.deepEqual(rows, [{ stop_id: '1', stop_name: 'Main St' }]);
  });

  test('skips blank lines', () => {
    const rows = parseCsv('a,b\n1,2\n\n3,4\n');
    assert.equal(rows.length, 2);
  });

  test('returns an empty array for empty input', () => {
    assert.deepEqual(parseCsv(''), []);
  });

  test('trims whitespace around values', () => {
    const rows = parseCsv('a,b\n 1 , 2 \n');
    assert.deepEqual(rows, [{ a: '1', b: '2' }]);
  });
});

describe('groupTripsByDirection', () => {
  test('groups trips by direction_id and counts shape usage', () => {
    const tripsById = new Map([
      ['t1', { trip_id: 't1', direction_id: '0', shape_id: 'shapeA' }],
      ['t2', { trip_id: 't2', direction_id: '0', shape_id: 'shapeA' }],
      ['t3', { trip_id: 't3', direction_id: '0', shape_id: 'shapeB' }],
      ['t4', { trip_id: 't4', direction_id: '1', shape_id: 'shapeC' }],
    ]);

    const { tripsByDir, shapeCountsByDir } = groupTripsByDirection(
      ['t1', 't2', 't3', 't4'],
      tripsById
    );

    assert.equal(tripsByDir['0'].length, 3);
    assert.equal(tripsByDir['1'].length, 1);
    assert.deepEqual(shapeCountsByDir['0'], { shapeA: 2, shapeB: 1 });
    assert.deepEqual(shapeCountsByDir['1'], { shapeC: 1 });
  });

  test('defaults missing direction_id to "0" and skips unknown trip ids', () => {
    const tripsById = new Map([['t1', { trip_id: 't1', direction_id: undefined }]]);
    const { tripsByDir } = groupTripsByDirection(['t1', 'missing'], tripsById);
    assert.equal(Object.keys(tripsByDir).length, 1);
    assert.equal(tripsByDir['0'].length, 1);
  });
});

describe('pickCanonicalShapeId', () => {
  test('picks the shape with the highest trip count', () => {
    assert.equal(pickCanonicalShapeId({ shapeA: 2, shapeB: 9, shapeC: 1 }), 'shapeB');
  });

  test('returns undefined when there are no shapes', () => {
    assert.equal(pickCanonicalShapeId({}), undefined);
  });
});

describe('pickBestTrip', () => {
  const trips = [
    { trip_id: 't1', shape_id: 'shapeA' },
    { trip_id: 't2', shape_id: 'shapeA' },
    { trip_id: 't3', shape_id: 'shapeB' },
  ];
  const stopCounts = { t1: 5, t2: 12, t3: 20 };

  test('prefers the trip with the most stops among the canonical shape', () => {
    const best = pickBestTrip(trips, 'shapeA', tripId => stopCounts[tripId]);
    assert.equal(best.trip_id, 't2');
  });

  test('falls back to the first trip when there is no canonical shape', () => {
    const best = pickBestTrip(trips, undefined, tripId => stopCounts[tripId]);
    assert.equal(best.trip_id, 't3');
  });

  test('falls back to the first trip when nothing matches the canonical shape', () => {
    const best = pickBestTrip(trips, 'shapeZ', tripId => stopCounts[tripId]);
    assert.equal(best.trip_id, 't1');
  });
});

describe('computeActiveServiceIds', () => {
  test('returns null when there is no calendar data at all', () => {
    assert.equal(computeActiveServiceIds(new Map(), new Map(), '20260727', 'monday'), null);
  });

  test('activates a service running on the given weekday within its date range', () => {
    const calendars = new Map([
      ['weekday', { start_date: '20260101', end_date: '20261231', monday: '1', tuesday: '0' }],
    ]);
    const active = computeActiveServiceIds(calendars, new Map(), '20260727', 'monday');
    assert.ok(active.has('weekday'));
  });

  test('excludes a service outside its calendar date range', () => {
    const calendars = new Map([
      ['expired', { start_date: '20200101', end_date: '20201231', monday: '1' }],
    ]);
    const active = computeActiveServiceIds(calendars, new Map(), '20260727', 'monday');
    assert.equal(active.has('expired'), false);
  });

  test('exception_type 1 adds a service not otherwise running that day', () => {
    const calendars = new Map([
      ['weekday', { start_date: '20260101', end_date: '20261231', monday: '0' }],
    ]);
    const calendarDates = new Map([
      ['weekday', [{ date: '20260727', exception_type: '1' }]],
    ]);
    const active = computeActiveServiceIds(calendars, calendarDates, '20260727', 'monday');
    assert.ok(active.has('weekday'));
  });

  test('exception_type 2 removes a service otherwise running that day', () => {
    const calendars = new Map([
      ['weekday', { start_date: '20260101', end_date: '20261231', monday: '1' }],
    ]);
    const calendarDates = new Map([
      ['weekday', [{ date: '20260727', exception_type: '2' }]],
    ]);
    const active = computeActiveServiceIds(calendars, calendarDates, '20260727', 'monday');
    assert.equal(active.has('weekday'), false);
  });
});

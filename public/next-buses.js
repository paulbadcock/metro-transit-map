/* ─── Next-buses merge logic ──────────────────────────────────────────────
 * Pure trip/delay merge logic, split out of app.js so it can be unit tested.
 * Loaded as a plain classic script in the browser (sets window.NextBuses,
 * same as every other function in app.js) and required directly by
 * node:test via createRequire. Deliberately not an ES module: app.js is a
 * classic script so functions like panToBus stay reachable from inline
 * onclick= handlers, and mixing module/classic script timing on this page
 * is a hazard not worth introducing for one shared file.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.NextBuses = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  function timeStringToMinutes(t) {
    const parts = t.split(":").map(Number);
    return parts[0] * 60 + parts[1];
  }

  // Maps "trip_id_stop_id" -> update
  function buildDelayMap(allTripUpdates) {
    const m = {};
    for (const u of allTripUpdates) {
      if (u.stop_id) m[`${u.trip_id}_${u.stop_id}`] = u;
    }
    return m;
  }

  // schedule entries come from GET /api/schedule?stop_id=X, so they don't
  // carry their own stop_id -- the caller's stopId applies to every row.
  // activeTripIds is the set of trip_ids a real vehicle is currently
  // running (state.vehicles' trip_ids) -- Halifax's GTFS-RT feed predicts
  // delay for a vehicle's *upcoming* trip in its block by propagating
  // forward from its current trip's progress, before that next trip has
  // actually started. That's a forecast, not an observed fact: it can't
  // know the vehicle will turn around at the same speed, or whether its
  // next pickup runs on schedule. So a trip's predicted delay is only
  // applied/displayed once a vehicle is actually confirmed running that
  // specific trip_id; otherwise it's shown as its plain scheduled time
  // with no delay claim at all (see `started` below).
  function computeNextBuses(schedule, stopId, allTripUpdates, activeTripIds, nowMin, limit = 3) {
    if (!stopId || !schedule || schedule.length === 0) return [];

    const delayByTrip = buildDelayMap(allTripUpdates);
    const active = activeTripIds || new Set();

    return schedule
      .map((s) => {
        const depMin = timeStringToMinutes(s.departure_time);
        const started = active.has(s.trip_id);
        const delaySeconds = started ? (delayByTrip[s.trip_id + "_" + stopId]?.departure_delay ?? 0) : 0;
        const delayMin = Math.round(delaySeconds / 60);
        const estimatedMin = depMin + delayMin;
        const minutesAway = estimatedMin - nowMin;
        return { ...s, depMin, delayMin, estimatedMin, minutesAway, started };
      })
      .filter((s) => s.minutesAway >= -1 && s.minutesAway <= 120)
      .sort((a, b) => a.minutesAway - b.minutesAway)
      .slice(0, limit);
  }

  // Returns the current delay (minutes) for a trip that's confirmed
  // running (caller guarantees that -- see activeTripIdSet() in app.js),
  // picking the stop-time update for the nearest stop still ahead rather
  // than just the lowest stop_sequence in the feed. The two aren't the
  // same thing: picking by sequence number alone assumes the feed only
  // ever lists a trip's *remaining* stops (as the GTFS-RT spec
  // recommends), but Halifax's producer doesn't reliably prune a trip's
  // early stop-time updates once the vehicle passes them (the same feed's
  // other quirk -- forecasting into a not-yet-started next trip -- is
  // handled separately in computeNextBuses above). Left unfiltered, the
  // lowest sequence number can get stuck forever on the first stop's
  // original (often "on time") delay even as the bus falls further behind
  // at every stop since, which is exactly backwards from what "current
  // delay" should mean.
  function getTripDelayMinutes(tripId, allTripUpdates, nowMs) {
    if (!tripId) return null;
    const forTrip = allTripUpdates.filter((u) => u.trip_id === tripId);
    if (forTrip.length === 0) return null;

    const eventTimeMs = (u) => {
      const t = u.departure_time ?? u.arrival_time;
      return t != null ? t * 1000 : null;
    };

    // An entry with no predicted time at all (delay-only update) is kept
    // rather than excluded -- there's no signal either way on whether its
    // stop is still ahead, so it gets the benefit of the doubt.
    const upcoming = forTrip.filter((u) => {
      const t = eventTimeMs(u);
      return t == null || t >= nowMs;
    });

    const pickLowestSequence = (list) => {
      let best = null;
      for (const u of list) {
        if (best === null || (u.stop_sequence ?? Infinity) < (best.stop_sequence ?? Infinity)) best = u;
      }
      return best;
    };

    let best = pickLowestSequence(upcoming);
    if (!best) {
      // Nothing is still ahead by time -- every entry's predicted time has
      // already passed. Falling back to the lowest-sequence entry here
      // would just reintroduce the bug above, so use whichever entry's
      // predicted time is most recent instead, as the closest available
      // signal to "now".
      for (const u of forTrip) {
        const t = eventTimeMs(u);
        if (best === null || (t ?? -Infinity) > (eventTimeMs(best) ?? -Infinity)) best = u;
      }
    }

    if (!best) return null;
    const delaySeconds = best.departure_delay ?? best.arrival_delay;
    return delaySeconds != null ? Math.round(delaySeconds / 60) : null;
  }

  // The vehicle immediately ahead of the selected one on the same route
  // direction -- the "prior bus" a rider wants to see alongside their own
  // to judge how the route is running. shapeIndexOf(v) returns how far along
  // the route a vehicle is (null if unknown); "ahead" means a strictly
  // larger index, and the nearest such vehicle wins. Returns its id, or null.
  function pickBusAhead(vehicles, selectedId, shapeIndexOf) {
    const sel = vehicles.find((v) => v.id === selectedId);
    if (!sel) return null;
    const selIdx = shapeIndexOf(sel);
    if (selIdx == null) return null;

    let bestId = null;
    let bestIdx = Infinity;
    for (const v of vehicles) {
      if (v.id === selectedId || v.direction_id !== sel.direction_id) continue;
      const idx = shapeIndexOf(v);
      if (idx == null || idx <= selIdx) continue;
      if (idx < bestIdx) {
        bestIdx = idx;
        bestId = v.id;
      }
    }
    return bestId;
  }

  return { computeNextBuses, buildDelayMap, getTripDelayMinutes, pickBusAhead };
});

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

  return { computeNextBuses, buildDelayMap };
});

// Pure GTFS parsing/merge helpers, split out of server.js so they can be
// unit tested without triggering the module's startup side effects
// (network download + app.listen).

export function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\uFEFF/, ''));
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (values[i] || '').trim(); });
    return obj;
  });
}

// Groups trips by direction_id, and tallies how many trips use each shape_id
// per direction — some routes have rare detour/short-turn variants alongside
// the main shape, and callers only want the one most trips actually run.
export function groupTripsByDirection(tripIds, tripsById) {
  const tripsByDir = {};
  const shapeCountsByDir = {};
  for (const tripId of tripIds) {
    const trip = tripsById.get(tripId);
    if (!trip) continue;
    const dir = trip.direction_id || '0';
    (tripsByDir[dir] ??= []).push(trip);
    if (trip.shape_id) {
      const counts = (shapeCountsByDir[dir] ??= {});
      counts[trip.shape_id] = (counts[trip.shape_id] || 0) + 1;
    }
  }
  return { tripsByDir, shapeCountsByDir };
}

// Returns Map<stop_id, Set<direction_id>> -- which direction(s) actually
// stop at each physical stop, based on every trip that serves the route
// (not just the canonical/most-common shape per direction), so a stop only
// reachable via a rare branch or short-turn trip is still attributed
// correctly.
export function computeStopDirections(stopTimes, tripsById) {
  const result = new Map();
  for (const st of stopTimes) {
    const trip = tripsById.get(st.trip_id);
    if (!trip) continue;
    const dir = parseInt(trip.direction_id, 10) || 0;
    if (!result.has(st.stop_id)) result.set(st.stop_id, new Set());
    result.get(st.stop_id).add(dir);
  }
  return result;
}

export function pickCanonicalShapeId(shapeCounts) {
  return Object.keys(shapeCounts).sort((a, b) => shapeCounts[b] - shapeCounts[a])[0];
}

// Among trips running the canonical shape, prefer the one with the most
// stops so a truncated variant doesn't win by tie-breaking on order.
export function pickBestTrip(trips, canonicalShapeId, stopCountForTrip) {
  let bestTrip = null;
  let bestStopCount = -1;
  for (const trip of trips) {
    if (canonicalShapeId && trip.shape_id !== canonicalShapeId) continue;
    const stopCount = stopCountForTrip(trip.trip_id);
    if (stopCount > bestStopCount) {
      bestStopCount = stopCount;
      bestTrip = trip;
    }
  }
  return bestTrip || trips[0];
}

// service_id set active on a given date, applying calendar.txt's weekly
// pattern then calendar_dates.txt's per-date add(1)/remove(2) exceptions.
export function computeActiveServiceIds(calendars, calendarDates, dateStr, dayName) {
  if (calendars.size === 0 && calendarDates.size === 0) return null;

  const active = new Set();

  for (const [serviceId, cal] of calendars) {
    if (cal.start_date <= dateStr && dateStr <= cal.end_date && cal[dayName] === '1') {
      active.add(serviceId);
    }
  }

  for (const [serviceId, exceptions] of calendarDates) {
    for (const exc of exceptions) {
      if (exc.date === dateStr) {
        if (exc.exception_type === '1') active.add(serviceId);
        if (exc.exception_type === '2') active.delete(serviceId);
      }
    }
  }

  return active;
}

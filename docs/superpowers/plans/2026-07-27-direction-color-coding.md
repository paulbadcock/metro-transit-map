# Direction Color-Coding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Color-code stop markers, live bus markers, and route polylines by direction (outbound/inbound), with a distinct third color for a stop served by both directions, plus a small legend.

**Architecture:** Backend adds a `directions` array to each stop in `GET /api/stops` and a `direction_id` field to each vehicle in `GET /api/vehicles`, both derived from GTFS trip data already loaded in memory. Frontend consumes these fields to pick a color/CSS class per marker, and re-keys the existing route-polyline coloring off the real `direction_id` instead of array position.

**Tech Stack:** Node.js (`node:test` for tests), Express, vanilla JS frontend, Leaflet for the map, no new dependencies.

## Global Constraints

- No new npm dependencies.
- ES module syntax throughout (`"type": "module"` in package.json).
- Follow the existing patterns in `server.js` / `lib/gtfs-utils.js` (pure helpers in `gtfs-utils.js`, wired into route handlers in `server.js`).
- `--color-accent` (`#e94560`) and everything it currently drives — the primary CTA button, active tab underline, late-bus glow, alert banner border — is untouched by this work.
- New direction palette, defined once as CSS custom properties: `--color-dir-outbound: #2f8fd1` (direction_id 0), `--color-dir-inbound: #d18f2f` (direction_id 1), `--color-dir-shared: #8a8f98` (a stop serving both directions — stops only, buses are always exactly one direction).
- Every stop `GET /api/stops` returns must end up with a non-empty `directions` array — there is no "unknown direction" case to handle on the frontend.
- `npm run lint` and `npm test` must pass after every task.

---

### Task 1: `computeStopDirections` helper

**Files:**
- Modify: `lib/gtfs-utils.js` (add function after `groupTripsByDirection`, which ends around line 53)
- Test: `test/gtfs-utils.test.js` (add a new `describe` block after the existing `groupTripsByDirection` block, which ends around line 81)

**Interfaces:**
- Produces: `computeStopDirections(stopTimes: Array<{trip_id, stop_id}>, tripsById: Map<string, {direction_id}>) => Map<string, Set<number>>` — maps `stop_id` to the set of `direction_id` values (as numbers, `0` or `1`) of every trip that stops there. Trip ids not present in `tripsById` are skipped. A missing/empty `direction_id` on a trip defaults to `0`, matching `groupTripsByDirection`'s existing default.

- [ ] **Step 1: Write the failing tests**

Add to `test/gtfs-utils.test.js`, just after the `describe('groupTripsByDirection', ...)` block:

```js
describe('computeStopDirections', () => {
  test('attributes each stop to the direction(s) that actually serve it', () => {
    const tripsById = new Map([
      ['t1', { trip_id: 't1', direction_id: '0' }],
      ['t2', { trip_id: 't2', direction_id: '1' }],
    ]);
    const stopTimes = [
      { trip_id: 't1', stop_id: 's1' },
      { trip_id: 't1', stop_id: 's2' },
      { trip_id: 't2', stop_id: 's2' },
    ];

    const result = computeStopDirections(stopTimes, tripsById);

    assert.deepEqual([...result.get('s1')], [0]);
    assert.deepEqual([...result.get('s2')].sort(), [0, 1]);
  });

  test('defaults missing direction_id to 0 and skips unknown trip ids', () => {
    const tripsById = new Map([['t1', { trip_id: 't1', direction_id: undefined }]]);
    const stopTimes = [
      { trip_id: 't1', stop_id: 's1' },
      { trip_id: 'missing', stop_id: 's2' },
    ];

    const result = computeStopDirections(stopTimes, tripsById);

    assert.deepEqual([...result.get('s1')], [0]);
    assert.equal(result.has('s2'), false);
  });

  test('picks up a stop only reachable via a rare/non-canonical trip', () => {
    // The canonical-shape simplification used elsewhere (pickCanonicalShapeId)
    // doesn't apply here -- this function sees every trip it's handed.
    const tripsById = new Map([
      ['main', { trip_id: 'main', direction_id: '0', shape_id: 'shapeA' }],
      ['shortTurn', { trip_id: 'shortTurn', direction_id: '1', shape_id: 'shapeRare' }],
    ]);
    const stopTimes = [
      { trip_id: 'main', stop_id: 's1' },
      { trip_id: 'shortTurn', stop_id: 's3' },
    ];

    const result = computeStopDirections(stopTimes, tripsById);

    assert.deepEqual([...result.get('s3')], [1]);
  });
});
```

Also update the import at the top of the file to include `computeStopDirections`:

```js
import {
  parseCsv,
  splitCsvLine,
  groupTripsByDirection,
  pickCanonicalShapeId,
  pickBestTrip,
  computeActiveServiceIds,
  computeStopDirections,
} from '../lib/gtfs-utils.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `computeStopDirections is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 3: Implement `computeStopDirections`**

Add to `lib/gtfs-utils.js`, directly after the `groupTripsByDirection` function:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests including the three new ones under `computeStopDirections`.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: no errors (the pre-existing `err` unused-var warning in `app.js:387` is unrelated and expected).

```bash
git add lib/gtfs-utils.js test/gtfs-utils.test.js
git commit -m "feat: add computeStopDirections helper for per-stop direction lookup"
```

---

### Task 2: `directions` field on `GET /api/stops`

**Files:**
- Modify: `server.js` (import line ~9-15, and the `/api/stops` handler around line 392-403)
- Test: `test/routes.test.js` (extend the `describe('GET /api/stops', ...)` block around line 60-73)

**Interfaces:**
- Consumes: `computeStopDirections` from Task 1 (`Map<string, Set<number>>`).
- Produces: `GET /api/stops` response items gain a `directions: number[]` field (sorted ascending, e.g. `[0]`, `[1]`, or `[0, 1]`).

- [ ] **Step 1: Write the failing test**

Add to `test/routes.test.js`, inside the existing `describe('GET /api/stops', () => { ... })` block (after the two existing tests):

```js
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
```

This reuses the fixture's existing `s1`/`s2`/`t1` (route 194, direction 0, `s1` → `s2`) from the shared `beforeEach`, and adds a second trip `t2` on direction 1 that also stops at `s2` — making `s2` a shared stop and `s1` outbound-only.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `s1.directions` is `undefined`, not `[0]` (the field doesn't exist in the response yet).

- [ ] **Step 3: Wire `computeStopDirections` into the `/api/stops` handler**

In `server.js`, update the import block (around line 9-15) to include `computeStopDirections`:

```js
import {
  parseCsv,
  groupTripsByDirection,
  pickCanonicalShapeId,
  pickBestTrip,
  computeActiveServiceIds,
  computeStopDirections,
} from './lib/gtfs-utils.js';
```

Replace the `/api/stops` handler (around line 392-403):

```js
app.get('/api/stops', (req, res) => {
  const routeId = req.query.route_id || '194';
  const { stopIds, stopTimes } = getRouteInfo(routeId);
  const stopDirections = computeStopDirections(stopTimes, gtfsData.trips);

  const stops = [];
  for (const stopId of stopIds) {
    const s = gtfsData.stops.get(stopId);
    if (!s) continue;
    const directions = [...(stopDirections.get(stopId) || [])].sort((a, b) => a - b);
    stops.push({ ...s, directions });
  }
  stops.sort((a, b) => a.stop_name.localeCompare(b.stop_name));
  res.json(stops);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all tests, including the new `/api/stops` direction test.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add server.js test/routes.test.js
git commit -m "feat: include per-stop directions array in GET /api/stops"
```

---

### Task 3: `direction_id` field on `GET /api/vehicles`

**Files:**
- Modify: `server.js` (the `/api/vehicles` handler, around line 288-320)

**Interfaces:**
- Produces: `GET /api/vehicles` response items gain a `direction_id: number | null` field — `0`, `1`, or `null` if the vehicle's `trip_id` doesn't resolve against loaded static GTFS trips.

**Note:** `GET /api/vehicles` has no automated test coverage today (it depends on decoding a live GTFS-RT protobuf feed via `fetchFeed`, which isn't mocked anywhere in `test/`). Adding `direction_id` doesn't change that; this task is verified manually (Step 3) rather than with `npm test`. That gap is pre-existing and out of scope for this plan.

- [ ] **Step 1: Add the direction lookup in the `/api/vehicles` handler**

In `server.js`, inside the `for (const entity of feed.entity)` loop of the `/api/vehicles` handler (around line 295-314), insert the lookup before the `vehicles.push(...)` call and add the field:

```js
app.get('/api/vehicles', async (req, res) => {
  try {
    const routeId = req.query.route_id || '194';
    const { tripIds } = getRouteInfo(routeId);

    const feed = await getCached('vehicles', () => fetchFeed(VEHICLE_POSITIONS_URL));
    const vehicles = [];
    for (const entity of feed.entity) {
      const vp = entity.vehicle;
      if (!vp) continue;
      const vehicleRouteId = vp.trip?.routeId;
      const tripId = vp.trip?.tripId;
      if (vehicleRouteId && vehicleRouteId !== routeId) continue;
      if (!vehicleRouteId && tripId && !tripIds.has(tripId)) continue;

      const trip = tripId ? gtfsData.trips.get(tripId) : null;
      const directionId = trip && trip.direction_id !== undefined && trip.direction_id !== ''
        ? parseInt(trip.direction_id, 10)
        : null;

      vehicles.push({
        id: entity.id,
        lat: vp.position?.latitude,
        lon: vp.position?.longitude,
        bearing: vp.position?.bearing,
        speed: vp.position?.speed,
        trip_id: vp.trip?.tripId,
        route_id: vehicleRouteId,
        direction_id: directionId,
        timestamp: vp.timestamp ? Number(vp.timestamp) : null,
        label: vp.vehicle?.label,
      });
    }
    res.json(vehicles);
  } catch (err) {
    console.error('Error fetching vehicles:', err.message);
    res.status(502).json({ error: 'Failed to fetch vehicle positions' });
  }
});
```

- [ ] **Step 2: Run the existing test suite**

Run: `npm test`
Expected: PASS — no existing test touches `/api/vehicles`, so nothing should change; this just confirms the edit didn't break anything else in `server.js`.

- [ ] **Step 3: Manually verify the field is present**

```bash
npm start &
i=0; until curl -sf http://localhost:3000/api/status >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && { echo TIMEOUT; break; }; sleep 1; done
curl -s "http://localhost:3000/api/vehicles?route_id=194" | head -c 500
```

Expected: a JSON array; if any vehicles are currently active on route 194, each object includes a `"direction_id"` key set to `0`, `1`, or `null`. If the array is empty (route not currently running — check `/api/service-status?route_id=194` to confirm), that's an acceptable outcome given real-world timing; re-read the code in Step 1 to confirm correctness instead. Stop the server afterward (`kill %1` or find the process on port 3000 and kill it).

- [ ] **Step 4: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add server.js
git commit -m "feat: include direction_id in GET /api/vehicles"
```

---

### Task 4: Direction palette + colored stop markers

**Files:**
- Modify: `public/style.css` (`:root` block around line 10-24, and the `.stop-marker` block around line 519-526)
- Modify: `public/app.js` (`makeStopIcon` around line 113-119, `drawStopMarkers` around line 334-348)

**Interfaces:**
- Consumes: `directions: number[]` field on each stop from Task 2's `/api/stops` response, already loaded into `state.stops` by the existing `fetchStops()`.
- Produces: `stopDirectionClass(directions: number[]) => string` and `makeStopIcon(directions: number[]) => L.DivIcon`, both used by `drawStopMarkers`.

- [ ] **Step 1: Add the direction color tokens to `style.css`**

In the `:root` block (after `--color-warning: #ff9800;`, around line 21):

```css
  --color-warning: #ff9800;
  --color-dir-outbound: #2f8fd1;
  --color-dir-inbound: #d18f2f;
  --color-dir-shared: #8a8f98;
```

- [ ] **Step 2: Add stop-marker direction modifier classes**

After the existing `.stop-marker { ... }` block (around line 519-526):

```css
.stop-marker {
  width: 16px;
  height: 16px;
  background: #aaa;
  border: 2px solid white;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.stop-marker.dir-outbound { background: var(--color-dir-outbound); }
.stop-marker.dir-inbound  { background: var(--color-dir-inbound); }
.stop-marker.dir-shared   { background: var(--color-dir-shared); }
```

(The base `background: #aaa` becomes a fallback for the rare case a stop marker is created with no direction info; every stop from `/api/stops` will have one of the three modifier classes applied per Step 3, so in practice the fallback shouldn't be visible.)

- [ ] **Step 3: Update `makeStopIcon` in `app.js`**

Replace (around line 113-119):

```js
function makeStopIcon() {
  return L.divIcon({
    className: "stop-marker",
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}
```

with:

```js
function stopDirectionClass(directions) {
  if (!directions || directions.length === 0) return "";
  if (directions.length > 1) return "dir-shared";
  return directions[0] === 1 ? "dir-inbound" : "dir-outbound";
}

function makeStopIcon(directions) {
  return L.divIcon({
    className: `stop-marker ${stopDirectionClass(directions)}`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}
```

- [ ] **Step 4: Pass each stop's directions in `drawStopMarkers`**

In `drawStopMarkers` (around line 334-348), change:

```js
    const m = L.marker([s.stop_lat, s.stop_lon], {
      icon: makeStopIcon(),
      title: s.stop_name,
    })
```

to:

```js
    const m = L.marker([s.stop_lat, s.stop_lon], {
      icon: makeStopIcon(s.directions),
      title: s.stop_name,
    })
```

- [ ] **Step 5: Run the automated test suite**

Run: `npm test`
Expected: PASS — this task doesn't touch anything under test, this just confirms nothing broke.

- [ ] **Step 6: Manually verify in the browser**

```bash
npm run dev &
```

Open `http://localhost:3000`, wait for the map to load, and confirm stop markers are colored (blue, amber, or grey/slate) rather than uniform grey. Open the browser devtools console and confirm there are no JS errors. Stop the server afterward.

- [ ] **Step 7: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add public/style.css public/app.js
git commit -m "feat: color stop markers by the direction(s) they serve"
```

---

### Task 5: Colored direction disc on bus markers

**Files:**
- Modify: `public/style.css` (add `.bus-direction-disc` rules near the `.bus-marker-wrap` block, around line 465-469)
- Modify: `public/app.js` (`makeBusIcon` around line 66-95, `updateVehicleMarkers` around line 251-289)

**Interfaces:**
- Consumes: `direction_id: number | null` field on each vehicle from Task 3's `/api/vehicles` response, already loaded into `state.vehicles` by the existing `fetchVehicles()`.
- Produces: `busDirectionClass(directionId: number | null) => string | null`; `makeBusIcon` gains a fourth parameter `directionId`.

- [ ] **Step 1: Add `.bus-direction-disc` styles to `style.css`**

Directly after the `.bus-marker-wrap { ... }` block (around line 465-469):

```css
.bus-marker-wrap {
  position: relative;
  width: 28px;
  height: 28px;
}

.bus-direction-disc {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}
.bus-direction-disc.dir-outbound { background: var(--color-dir-outbound); }
.bus-direction-disc.dir-inbound  { background: var(--color-dir-inbound); }
```

(No `dir-shared` variant here — a single vehicle is always exactly one direction at a time.)

- [ ] **Step 2: Update `makeBusIcon` in `app.js`**

Replace (around line 65-95):

```js
// ─── Bus Icon ─────────────────────────────────────────────────────────────────
function makeBusIcon(bearing, timestamp, delayMin) {
  const rotation =
    bearing != null ? `transform:rotate(${bearing + 90}deg)` : "";
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

  return L.divIcon({
    className: "",
    html: `<div class="bus-marker-wrap"><div class="${iconClass}" style="${rotation}">🚌</div>${ageBadge}${delayBadge}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}
```

with:

```js
// ─── Bus Icon ─────────────────────────────────────────────────────────────────
function busDirectionClass(directionId) {
  if (directionId === 0) return "dir-outbound";
  if (directionId === 1) return "dir-inbound";
  return null;
}

function makeBusIcon(bearing, timestamp, delayMin, directionId) {
  const rotation =
    bearing != null ? `transform:rotate(${bearing + 90}deg)` : "";
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
```

- [ ] **Step 3: Pass `v.direction_id` at both `makeBusIcon` call sites**

In `updateVehicleMarkers` (around line 251-289), there are two calls to update:

```js
      marker.setIcon(makeBusIcon(v.bearing, v.timestamp, delayMin));
```
→
```js
      marker.setIcon(makeBusIcon(v.bearing, v.timestamp, delayMin, v.direction_id));
```

and:

```js
      const marker = L.marker([v.lat, v.lon], {
        icon: makeBusIcon(v.bearing, v.timestamp, delayMin),
```
→
```js
      const marker = L.marker([v.lat, v.lon], {
        icon: makeBusIcon(v.bearing, v.timestamp, delayMin, v.direction_id),
```

- [ ] **Step 4: Run the automated test suite**

Run: `npm test`
Expected: PASS — no existing test covers this rendering path.

- [ ] **Step 5: Manually verify in the browser**

```bash
npm run dev &
```

Open `http://localhost:3000`. If route 194 currently has active vehicles (check the "Live Buses" sidebar list, or try switching routes via Settings to one that's currently running), confirm each bus marker shows a colored disc behind the 🚌 emoji, and that the late-arrival glow/corner badges still render correctly on top when applicable. If no buses are active at test time, this step can be deferred to Task 7's final check. Stop the server afterward.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add public/style.css public/app.js
git commit -m "feat: show direction as a colored disc on live bus markers"
```

---

### Task 6: Direction-keyed polyline colors + sidebar legend

**Files:**
- Modify: `public/app.js` (`drawRoutePolylines` around line 395-427)
- Modify: `public/style.css` (add `.direction-legend` rules, anywhere in the sidebar-styles section)
- Modify: `public/index.html` (Map tab panel, around line 37-48)

**Interfaces:**
- Consumes: `direction_id` field already present on each entry of the `/api/route-stops` response (used, but previously ignored in favor of array index).
- No new exported functions — this task changes internal logic in `drawRoutePolylines` and adds static markup.

- [ ] **Step 1: Re-key `drawRoutePolylines` off `direction_id`**

Replace (around line 394-427):

```js
// ─── Map: Route Polylines ─────────────────────────────────────────────────────
function drawRoutePolylines(directions) {
  for (const pl of state.routePolylines) pl.remove();
  state.routePolylines = [];

  const colors = ["#e94560", "#533483"];
  directions.forEach((dir, i) => {
    // Prefer shape track (follows roads); fall back to straight stop-to-stop lines
    const latlngs =
      dir.shape && dir.shape.length > 1
        ? dir.shape
        : (dir.stops || [])
            .filter((s) => s.stop_lat && s.stop_lon)
            .map((s) => [s.stop_lat, s.stop_lon]);
    if (latlngs.length < 2) return;
    const pl = L.polyline(latlngs, {
      color: colors[i % colors.length],
      weight: 3,
      opacity: 0.6,
      dashArray: i === 1 ? "6,4" : null,
    })
      .bindPopup(
        `<strong>Direction ${escapeHtml(String(dir.direction_id))}</strong><br>${escapeHtml(dir.trip_headsign || "")}<br><span style="opacity:0.65">${latlngs.length} shape points</span>`,
      )
      .addTo(map);
    state.routePolylines.push(pl);
  });

  // Fit map to route if we have polylines
  if (state.routePolylines.length > 0) {
    const group = L.featureGroup(state.routePolylines);
    map.fitBounds(group.getBounds().pad(0.1));
  }
}
```

with:

```js
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
    })
      .bindPopup(
        `<strong>Direction ${escapeHtml(String(dir.direction_id))}</strong><br>${escapeHtml(dir.trip_headsign || "")}<br><span style="opacity:0.65">${latlngs.length} shape points</span>`,
      )
      .addTo(map);
    state.routePolylines.push(pl);
  });

  // Fit map to route if we have polylines
  if (state.routePolylines.length > 0) {
    const group = L.featureGroup(state.routePolylines);
    map.fitBounds(group.getBounds().pad(0.1));
  }
}
```

- [ ] **Step 2: Add legend styles to `style.css`**

Add anywhere after the `:root` block (e.g. near the end of the file, before the `─── Responsive ───` section):

```css
/* ─── Direction Legend ──────────────────────────────────────────────────────── */
.direction-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.direction-legend .swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: -1px;
}
.direction-legend .swatch.outbound { background: var(--color-dir-outbound); }
.direction-legend .swatch.inbound  { background: var(--color-dir-inbound); }
.direction-legend .swatch.shared   { background: var(--color-dir-shared); }
```

- [ ] **Step 3: Add the legend markup to `index.html`**

In the Map tab panel (around line 37-48), add the legend between the section label and the bus list:

```html
      <!-- Tab: Map Controls -->
      <div id="tab-map" class="tab-panel active" role="tabpanel" aria-labelledby="tabbtn-map">
        <div class="panel-section">
          <div class="section-label">Live Buses</div>
          <div class="direction-legend">
            <span><span class="swatch outbound"></span>Outbound</span>
            <span><span class="swatch inbound"></span>Inbound</span>
            <span><span class="swatch shared"></span>Both directions</span>
          </div>
          <div id="bus-list">
            <div class="empty-state">Loading bus positions...</div>
          </div>
        </div>
```

(Only the `<div class="direction-legend">...</div>` block is new; the surrounding markup is shown for placement context.)

- [ ] **Step 4: Run the automated test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Manually verify in the browser**

```bash
npm run dev &
```

Open `http://localhost:3000`. Confirm:
- The legend appears above the bus list in the Map tab, with three correctly-colored swatches.
- The route polyline(s) render in blue/amber rather than crimson/purple.
- Clicking a polyline's popup still shows the correct direction/headsign text.

Stop the server afterward.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add public/app.js public/style.css public/index.html
git commit -m "feat: key route polyline colors off direction_id, add sidebar legend"
```

---

### Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full lint pass**

Run: `npm run lint`
Expected: 0 errors (the one pre-existing `no-unused-vars` warning on `app.js:387` is expected and unrelated).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass, including the new `computeStopDirections` and `/api/stops` direction tests from Tasks 1-2.

- [ ] **Step 3: End-to-end manual smoke test**

```bash
npm start &
i=0; until curl -sf http://localhost:3000/api/status >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && { echo TIMEOUT; break; }; sleep 1; done
curl -s "http://localhost:3000/api/stops?route_id=194" | head -c 300
```

Confirm the output includes a `"directions"` array on each stop. Then open `http://localhost:3000` in a browser and confirm together, in one pass:
- Stop markers are colored (not uniform grey).
- The legend renders above the bus list.
- Route polylines render in the new blue/amber palette.
- If any buses are currently active, their markers show a colored disc.
- No errors in the browser devtools console.
- Existing unrelated features still work: switching tabs, dismissing the alert/service-status banners, saving settings.

Stop the server afterward (find the process on port 3000 and kill it).

- [ ] **Step 4: Report**

No commit needed for this task unless Step 1-3 surfaced an issue that required a fix — in that case, fix it, re-run the relevant step, and commit with a message describing what was wrong (e.g. `fix: correct direction class on shared stops`).

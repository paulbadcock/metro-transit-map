# Direction color-coding for stops, buses, and route lines

Date: 2026-07-27
Status: Approved, not yet implemented

## Problem

On routes with more overlapping geography than 194 (the motivating example
was route 90), it's hard to tell at a glance which stops and which live
buses belong to which direction of travel. Route polylines already use two
colors (crimson/purple) to distinguish direction, but stop markers are a
uniform grey dot and bus markers carry no direction cue at all — you have to
open a popup and read the trip headsign to find out.

## Goal

Extend the existing direction-color concept (currently polylines-only) to
stop markers and live bus markers, with a clearly different color for a
stop that's served by both directions, and a legend so the colors are
self-explanatory.

## Decisions (from brainstorming)

1. **Dedicated direction palette**, not a reuse of `--color-accent`
   (crimson). Crimson already means "primary CTA", "active tab", and "bus is
   late" — reusing it for "direction 0" would make a late outbound bus glow
   red for two unrelated reasons at once. New tokens:
   - `--color-dir-outbound: #2f8fd1` (blue) — direction_id 0
   - `--color-dir-inbound: #d18f2f` (amber) — direction_id 1
   - `--color-dir-shared: #8a8f98` (slate) — stop serves both directions
   - Existing `--color-accent` and its current meanings are untouched.
2. **Add a compact legend** to the Map tab sidebar, above the bus list:
   `● Outbound  ● Inbound  ● Both directions`.
3. **Bus markers get a colored disc behind the 🚌 emoji**, matching the
   stop markers' "colored dot" visual language. The existing late-arrival
   red drop-shadow glow and the two corner badges (age in seconds, delay in
   minutes) are unaffected — they render on top of/around the disc.

## Data model changes

### `lib/gtfs-utils.js`

Add a pure helper, alongside the existing `groupTripsByDirection`:

```js
// Returns Map<stop_id, Set<direction_id>> — which direction(s) actually
// stop at each physical stop, based on every trip on the route (not just
// the canonical/most-common shape), so a stop only served by a rare
// branch or short-turn trip is still correctly attributed.
export function computeStopDirections(stopTimes, tripsById) { ... }
```

This reuses the same `stopTimes` array `getRouteInfo()` already assembles
from every trip on the route — the same data `/api/stops` already draws its
`stopIds` set from — so every stop `/api/stops` returns is guaranteed to
get at least one direction. There is no "unknown direction" fallback case
to design for.

### `server.js`

- **`GET /api/stops`** — each stop gains a `directions` field:
  `[0]`, `[1]`, or `[0, 1]`, computed via `computeStopDirections`.
- **`GET /api/vehicles`** — each vehicle gains `direction_id` (`0`, `1`, or
  `null`), a lookup of `gtfsData.trips.get(trip_id)?.direction_id`. `null`
  covers a live vehicle whose `trip_id` doesn't resolve against static GTFS
  (e.g. a newly-added trip not yet in today's static data pull) — those
  buses render with no direction disc rather than guessing.
- **`GET /api/route-stops`** — no response shape change, but
  `drawRoutePolylines` on the frontend currently picks color/dash by array
  index rather than each entry's actual `direction_id` field (which is
  already present in the response). Fix the frontend to key off
  `direction_id` explicitly — today it happens to work because the object
  key order is ascending, but it's not guaranteed.

## Frontend changes (`public/app.js`, `public/style.css`)

- Add the three `--color-dir-*` custom properties to `style.css`.
- `makeStopIcon(directions)`: single direction → that color;
  `directions.length === 2` → slate. Replaces the current fixed `#aaa`.
- `makeBusIcon(...)`: add a colored disc behind the emoji keyed off the
  vehicle's `direction_id`; omit the disc when `direction_id` is `null`.
- `drawRoutePolylines`: color/dash keyed off `dir.direction_id` instead of
  array index; colors switch from crimson/purple to the new blue/amber
  tokens (dash pattern on direction 1 kept as a secondary, non-color cue).
- New legend markup in the Map tab, above `#bus-list`, using the same three
  tokens as swatch colors.

## Testing

- Unit tests for `computeStopDirections` in a new `describe` block in
  `test/gtfs-utils.test.js`, mirroring the existing `groupTripsByDirection`
  tests (single-direction stop, shared stop, stop only reachable via a
  non-canonical/branch trip).
- Extend the `GET /api/stops` test in `test/routes.test.js` to assert the
  `directions` field on the existing two-stop fixture.
- `GET /api/vehicles` currently has no test coverage in `test/routes.test.js`
  (it depends on a live GTFS-RT feed fetch that isn't mocked today). Adding
  `direction_id` doesn't change that gap — out of scope for this change to
  fix, but worth a one-line note in the PR description so it's a visible,
  known gap rather than a silent one.
- Manual verification: run the app, switch to a route with two directions,
  confirm stop/bus colors and legend render as designed, confirm dismissing
  behavior and everything else from the prior UI/UX pass still works
  unchanged.

## Out of scope

- No changes to `--color-accent` or anything it currently drives (CTA
  button, active tab underline, late-bus glow, alert banner).
- No backend change to `/api/route-stops` — only how the frontend consumes
  the `direction_id` field it already returns.
- No changes to the Commute or Settings tabs.

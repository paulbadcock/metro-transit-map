# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

```bash
npm start          # Run server (node server.js)
npm run dev        # Run with auto-restart on file changes (node --watch)
npm test           # Run the test suite (node:test)
npm run lint       # Run ESLint
```

The server starts on http://localhost:3000. No build step.

Set `GTFS_DIR` to point at a directory of GTFS static files (e.g. `GTFS_DIR=$(pwd)/test/fixtures/gtfs npm start`) to skip the download and freshness check entirely and load from there instead — useful for running without network access. `test/fixtures/gtfs/` is a small checked-in fixture (one route, two stops, one trip per direction) covering the same files `loadGtfsData` expects; GTFS-RT endpoints (`/api/vehicles`, `/api/trip-updates`, `/api/alerts`) still hit Halifax's live feeds regardless, since only the static data is mocked.

`test/gtfs-pipeline.test.js` exercises this fixture end to end — parsing the files via `loadGtfsData()` and hitting the real API routes — as a complement to `test/routes.test.js`, which seeds `gtfsData`'s Maps directly and so never touches the file-parsing pipeline itself.

On first start (or when GTFS data is >24h old), `server.js` downloads `google_transit.zip` from Halifax Transit and extracts five files into `data/gtfs/`. Subsequent starts skip the download.

CI (`.github/workflows/ci.yml`) runs lint, tests, `npm audit --audit-level=high`, and a Docker build check on every push/PR to `main`.

---

## Docker deployment

Docker files (`Dockerfile`, `docker-compose.yml`) live on `main` alongside the app — there is no separate Docker branch to check out (an old `feature/docker` branch still exists on the remote but is stale; Docker support was merged to `main`).

```bash
docker compose up --build      # Build image and start container
docker compose up -d           # Run in background
docker compose down            # Stop and remove container
```

GTFS data is stored in the `gtfs-data` named volume and persists across restarts. On first start the container downloads GTFS automatically — this takes ~10s and requires internet access.

To run on a different host port:

```bash
PORT=8080 docker compose up -d
```

**Image build** is multi-stage: `node:24-slim` (Docker Official) installs dependencies, then only `node_modules`/`server.js`/`lib/`/`public/` are copied into `gcr.io/distroless/nodejs24-debian12:nonroot` for runtime. The runtime image has **no shell and no package manager** — `docker exec sh` will fail by design. It runs as non-root (uid `65532`) by default; the `data/gtfs` directory is pre-created with that ownership in the build stage specifically so a fresh named volume mounted at `/app/data/gtfs` inherits correct ownership from the image on first use (Docker seeds a new named volume from whatever the image already has at that mount path). If you ever see a `chmod ENOENT` error from `adm-zip` on startup, it means the volume ended up root-owned — reset it with `docker compose down -v` and rebuild.

`HEALTHCHECK` execs `node` directly (`/nodejs/bin/node -e "..."`) since there's no shell to run a `curl`/`wget` one-liner. Logging uses `json-file` with `max-size`/`max-file` caps in `docker-compose.yml` to avoid unbounded log growth on a long-running host.

The server handles `SIGTERM`/`SIGINT` by closing the HTTP server cleanly (with a 10s hard-exit fallback), so `docker stop`/redeploys don't have to wait out Docker's hard-kill grace period.

## Architecture

**Backend (`server.js`)** — ES module. Serves `public/` as static files and exposes these API routes:
- `GET /api/routes` — All routes (from static GTFS)
- `GET /api/vehicles` — GTFS-RT vehicle positions filtered to route (15s TTL cache)
- `GET /api/trip-updates` — GTFS-RT stop-time updates for route (15s TTL cache)
- `GET /api/alerts` — GTFS-RT service alerts filtered to route (5min TTL cache)
- `GET /api/stops` — All stops serving route (from static GTFS, sorted by name)
- `GET /api/schedule?stop_id=&direction=` — All trips visiting a stop today, sorted by departure time
- `GET /api/route-stops` — Stops and shape coordinates grouped by direction (for drawing polylines)
- `GET /api/service-status` — Whether route is currently running, based on first/last departure time
- `GET /api/status` — Debug: counts of loaded GTFS data

Security headers are set via `helmet`, including a CSP allow-listing this app's actual external resources (Leaflet + its assets from `unpkg.com`, OpenStreetMap tile subdomains). **If you add a new external resource (CDN script, font, API), update the CSP directives in `server.js` or it will be silently blocked in the browser** — check the browser console for CSP violation messages if something loads locally but not in a fresh browser session.

**Pure GTFS logic lives in `lib/gtfs-utils.js`** (CSV parsing, canonical-shape/trip selection for `/api/route-stops`, calendar-exception handling for `/api/service-status`), separated from `server.js` specifically so it can be unit tested — `server.js` has startup side effects (network download + `app.listen`) that make it unsafe to import directly in a test file. Tests are in `test/`.

**Static GTFS loading** (`loadGtfsData`): At startup, parses `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, and `shapes.txt` into `gtfsData` Maps/Sets in memory. Only stop_times and shapes belonging to route trips are retained, keeping memory use low. GTFS data is refreshed from source if the `.downloaded` timestamp file in `data/gtfs/` is older than 24 hours.

**Frontend (`public/`)** — No framework, no build step. Leaflet is loaded from CDN (`unpkg.com`). `app.js` is a single module-style script with:
- Global `state` object holding vehicles, stops, trip updates, schedule, and Leaflet marker references
- Settings persisted in `localStorage` under key `metromaps_settings`
- Polling: vehicles every 15s, trip updates every 30s, UI countdown tick every 15s, service status every 5min, schedule reload every 5min
- Commute panel shows next buses for the active stop, comparing GTFS static schedule against real-time delay data from `buildDelayMap()`
- Browser notifications fire when a bus is within the configured threshold (default 5 min), tracked per trip by `state.notifiedTripIds`
- `window.testNotification()` is available in the browser console for testing

**Data flow for "next buses"**: `fetchScheduleForStop()` loads static departure times → `fetchTripUpdates()` loads delays → `computeNextBuses()` merges them by `trip_id + stop_id` key to show adjusted arrival times.

**GTFS-RT decoding**: The `gtfs-realtime-bindings` package decodes protobuf binary feeds. Long integers (e.g. `timestamp`) come back as Long objects and must be wrapped with `Number()`.

## Key Facts

- Route 194's `route_id` in the Halifax GTFS feed is `"194"`
- All times are in Halifax timezone (`America/Halifax`); GTFS times may exceed `24:00` for trips past midnight
- The project uses `"type": "module"` — all imports use ES module syntax

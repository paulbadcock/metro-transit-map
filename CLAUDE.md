# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branches

- `main` — Node.js/Express version (`server.js`). Run locally with `npm start` or `npm run dev`.
- `feature/docker` — Adds Docker/docker-compose for self-hosted deployment. See below.

---

## main branch — Node.js

```bash
npm start          # Run server (node server.js)
npm run dev        # Run with auto-restart on file changes (node --watch)
```

No build step, no test suite, no linter configured. The server starts on http://localhost:3000.

On first start (or when GTFS data is >24h old), `server.js` downloads `google_transit.zip` from Halifax Transit and extracts five files into `data/gtfs/`. Subsequent starts skip the download.

---

## feature/docker branch — Docker

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

The container runs as a non-root user (`appuser`). No other configuration is required.

## Architecture

**Backend (`server.js`)** — ES module. Serves `public/` as static files and exposes these API routes:
- `GET /api/vehicles` — GTFS-RT vehicle positions filtered to route (15s TTL cache)
- `GET /api/trip-updates` — GTFS-RT stop-time updates for route (30s TTL cache)
- `GET /api/stops` — All stops serving route (from static GTFS, sorted by name)
- `GET /api/schedule?stop_id=&direction=` — All trips visiting a stop today, sorted by departure time
- `GET /api/route-stops` — Stops and shape coordinates grouped by direction (for drawing polylines)
- `GET /api/service-status` — Whether route is currently running, based on first/last departure time
- `GET /api/status` — Debug: counts of loaded GTFS data

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

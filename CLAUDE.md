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

### Versioning

Every push to `main` *is* a release: CI's `publish` job auto-bumps `package.json`'s patch version (`npm version patch`), commits that back to `main` and tags it (`vX.Y.Z`), then builds the image from that bumped commit — so the version baked into any given deploy always matches a real, findable git tag, with no manual version-bumping step. The bump commit's message carries `[skip ci]`, which (a) stops that push from re-triggering the whole workflow (avoiding an infinite bump loop) and (b) is also checked explicitly in `publish`'s own `if:` as a second guard against a manual re-run of that specific commit double-bumping.

`server.js` reads its own baked-in `package.json` version at startup and exposes it via `GET /api/status` (`{ version, ... }`); the frontend fetches it once at load and shows it in Settings → Debug (`#app-version`) and as a suffix on the status dot's tooltip — so confirming a deploy actually landed (vs. still serving a stale image) is a glance instead of grepping `app.js` for a telltale string. Don't hand-edit `package.json`'s `version` field — the next push overwrites whatever's there.

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

**Image build** is multi-stage: `node:26-slim` (Docker Official) installs dependencies, then only `package.json`/`node_modules`/`server.js`/`lib/`/`public/` are copied into Chainguard's `cgr.dev/chainguard/node:latest` (Wolfi-based) for runtime. Chainguard's free tier publishes only `:latest`/`:latest-dev` (no version tags), so the `FROM` line pins it **by digest** for reproducible builds; Dependabot's docker ecosystem opens PRs to bump that digest, but only weekly and without looking at CVEs inside the image, so `.github/workflows/base-image-refresh.yml` also runs daily: if Trivy finds fixable HIGH/CRITICAL CVEs in the published `ghcr.io/...:latest` image and upstream's current digest clears them, it commits the new digest straight to `main` and dispatches `ci.yml` (`workflow_dispatch`, since a `GITHUB_TOKEN` push doesn't trigger `push` workflows), which tests, scans and publishes a release as usual. If that digest also changes Node's major version, it opens an issue for review instead. CI's `docker-build` job also runs Trivy on the built image and fails on any fixable HIGH/CRITICAL CVE. `:latest` tracks the newest Node major — odd-numbered, non-LTS releases included — so review those bumps rather than auto-merging, and don't switch to `:latest-slim`: it stopped being rebuilt on the free tier (stuck on Node 25, 50 CVEs as of 2026-09). Chainguard was chosen over the previous `gcr.io/distroless/nodejs26-debian13` for its daily rebuilds (distroless lagged Debian's OpenSSL fixes) and because Node is a tracked package there, so scanners can see Node runtime CVEs — distroless copies in a bare binary that Trivy can't see. Unlike distroless, the runtime image **does include busybox `sh` and npm** (so `docker exec ... sh` works for debugging); nothing in the app relies on them. It runs as non-root (`node` user, uid `65532` — the same uid distroless used, so existing volumes keep working); the `data/gtfs` directory is pre-created with that ownership in the build stage specifically so a fresh named volume mounted at `/app/data/gtfs` inherits correct ownership from the image on first use (Docker seeds a new named volume from whatever the image already has at that mount path). If you ever see a `chmod ENOENT` error from `adm-zip` on startup, it means the volume ended up root-owned — reset it with `docker compose down -v` and rebuild.

**Image size**: the base Chainguard node image alone accounts for the bulk of it (mostly the Node.js runtime + full ICU Unicode data + glibc/OpenSSL, plus npm) — inherent to running a real Node server, not something this app's own code controls. What this app actually adds on top (`node_modules` + app code) runs `scripts/prune-unused-transitive-deps.js` after `npm ci --omit=dev` in the build stage, which strips ~30MB of genuinely-unused transitive dependencies that only exist because `gtfs-realtime-bindings` mis-declares its own build-time-only `.proto` codegen CLI (`protobufjs-cli`, never invoked at runtime) as a regular dependency rather than a devDependency — see that script for the full explanation. It computes what's safe to remove dynamically from the installed tree (`npm ls --all --omit=dev`), so it self-adjusts if those packages' versions change later; nothing here needs manual updating.

`HEALTHCHECK` execs `node` directly (`/usr/bin/node -e "..."`) since the image has no `curl`/`wget`. The server listens on `PORT` (default `3000` outside Docker); the image sets `ENV PORT=4040` to match `EXPOSE`/the healthcheck, so a bare `docker run` works without `-e PORT`. Logging uses `json-file` with `max-size`/`max-file` caps in `docker-compose.yml` to avoid unbounded log growth on a long-running host.

The server handles `SIGTERM`/`SIGINT` by closing the HTTP server cleanly (with a 10s hard-exit fallback), so `docker stop`/redeploys don't have to wait out Docker's hard-kill grace period.

### Pulling a pre-built image instead of building

CI's `publish` job (`.github/workflows/ci.yml`) builds the image and pushes it to GitHub Container Registry on every push to `main`, tagged `latest` and with the commit SHA — `ghcr.io/paulbadcock/metro-transit-map:latest` / `:<sha>`. `docker-compose.yml` sets `image:` to that `latest` tag alongside `build: .`, so:

```bash
docker compose pull && docker compose up -d   # deploy server: pull the published image, no build/source needed
docker compose up --build                     # local dev: build from source instead, same tag
```

The GHCR package defaults to **private** on first push even though the repo is public — visit the package's GitHub page (linked from the repo sidebar under "Packages") and change its visibility to public, or `docker pull` from the server will need `docker login ghcr.io` first.

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

Security headers are set via `helmet`, including a CSP allow-listing this app's actual external resources (Leaflet + MapLibre GL from `unpkg.com`, OpenFreeMap's `tiles.openfreemap.org` for the basemap's vector tiles/style/fonts/sprites, plus `worker-src blob:` for MapLibre's tile-parsing worker). **If you add a new external resource (CDN script, font, API), update the CSP directives in `server.js` or it will be silently blocked in the browser** — check the browser console for CSP violation messages if something loads locally but not in a fresh browser session.

**Production (`busmap.thisisunsafe.org`) runs behind Cloudflare**, which injects its own inline bot-detection bootstrap script (`window.__CF$cv$params = ...`) into every proxied response before `</body>` — this happens on any proxied zone, there's no dashboard toggle for it. A per-request CSP nonce is generated in `server.js` (`res.locals.cspNonce`, a middleware ahead of `helmet()`) and included in `script-src`; Cloudflare's edge parses the outgoing CSP header and copies that same nonce onto its injected script, so it passes CSP without needing `'unsafe-inline'` (which Cloudflare's own docs explicitly warn against for this). `static.cloudflareinsights.com`/`cloudflareinsights.com` are also allow-listed for Cloudflare Web Analytics' RUM beacon, in case that's ever turned on — not currently enabled on the zone, but it's a fixed known host, harmless to allow ahead of time.

**Basemap**: the map tiles are OpenFreeMap's "Liberty" vector style (free, keyless, modeled after CARTO's Voyager, which now requires an API key) rendered by MapLibre GL and bridged into the Leaflet map via `maplibre-gl-leaflet` (`L.maplibreGL({ style: ... }).addTo(map)` in `app.js`'s Map Setup section). All three are CDN scripts loaded from `unpkg.com` in `index.html`, in order: `leaflet.js`, `maplibre-gl.js` (sets `window.maplibregl`), then the bridge (reads `window.L` + `window.maplibregl`, attaches `L.maplibreGL`). MapLibre GL is pinned to the `5.x` line specifically — `6.x` dropped the classic/UMD build this no-build-step app depends on, shipping ESM-only instead.

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

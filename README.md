# Bus Tracker

Real-time tracker for Halifax Transit Routes. Shows live bus positions on a map, upcoming departures at your stop with delay information, and fires browser notifications when your bus is approaching.

## Features

- Live map of route buses updated every 15 seconds
- Route polyline following the actual road geometry (via GTFS shapes data)
- Commute panel showing next 3 buses with countdowns and delay indicators
- Warning bar when the route is not in service
- Browser notifications when a bus is within a configurable number of minutes
- Configurable morning and evening commute windows and boarding stops
- Settings persisted in `localStorage`

## Requirements

- Node.js 24+
- Internet connection (fetches live data from Halifax Transit on startup)

## Getting Started

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

On first run the server downloads and extracts the GTFS static feed (~5 MB zip) into `data/gtfs/`. This takes a few seconds. The cached files are reused for 24 hours before refreshing.

### Development (auto-restart on file changes)

```bash
npm run dev
```

### Testing and linting

```bash
npm test        # node:test unit + integration tests
npm run lint    # ESLint
```

CI (GitHub Actions) runs both, plus `npm audit` and a Docker build check, on every push/PR to `main`.

### Docker

```bash
docker compose up --build
```

See [CLAUDE.md](CLAUDE.md#docker-deployment) for details on the image build and deployment behavior.

## Configuration

Open the **Settings** tab in the sidebar:

| Setting | Description |
|---|---|
| Morning stop | The stop you board at during the morning commute |
| Evening stop | The stop you board at during the evening commute |
| Morning window | Time range to show morning commute info (default 7:00–9:00 AM) |
| Evening window | Time range to show evening commute info (default 4:00–6:30 PM) |
| Notify when | Fire a notification this many minutes before bus arrives (default 5) |
| Enable notifications | Toggle browser notifications on/off |

The app automatically detects which commute window is active based on the current time and shows the relevant stop and upcoming trips.

## Project Structure

```
returntowork/
├── server.js          # Express backend — GTFS proxy, caching, static data parsing
├── lib/
│   └── gtfs-utils.js  # Pure GTFS parsing/merge logic (unit tested)
├── package.json
├── Dockerfile          # Multi-stage: node:24-slim build → distroless nonroot runtime
├── docker-compose.yml
├── public/
│   ├── index.html     # Single-page app shell
│   ├── app.js         # Frontend — map, commute panel, notifications, settings
│   └── style.css      # Dark theme
├── test/               # node:test unit + integration tests
├── .github/
│   ├── workflows/ci.yml
│   └── dependabot.yml
└── data/
    └── gtfs/          # Cached static GTFS files (auto-downloaded on first run)
        ├── stops.txt
        ├── routes.txt
        ├── trips.txt
        ├── stop_times.txt
        └── shapes.txt
```

## API Endpoints

The backend proxies Halifax Transit's GTFS-Realtime protobuf feeds (which can't be fetched directly from the browser due to CORS) and serves parsed static GTFS data.

| Endpoint | Description |
|---|---|
| `GET /api/routes` | All routes available in the static GTFS feed |
| `GET /api/vehicles` | Live bus positions for route (cached 15s) |
| `GET /api/trip-updates` | Stop-level delay data for route (cached 15s) |
| `GET /api/alerts` | Active service alerts for route (cached 5min) |
| `GET /api/stops` | All stops served by route |
| `GET /api/schedule?stop_id=X` | Today's scheduled departures at a stop |
| `GET /api/route-stops` | Stops and shape coordinates grouped by direction |
| `GET /api/service-status` | Whether the route is currently in service |
| `GET /api/status` | Debug info — counts of loaded stops, trips, stop times |

## Data Sources

All feeds are public and require no authentication.

| Feed | URL |
|---|---|
| Static GTFS | `https://gtfs.halifax.ca/static/google_transit.zip` |
| Vehicle positions | `https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb` |
| Trip updates | `https://gtfs.halifax.ca/realtime/TripUpdate/TripUpdates.pb` |
| Alerts | `https://gtfs.halifax.ca/realtime/Alert/Alerts.pb` |

The `route_id` in the GTFS feed is `"194"`.

## How Notifications Work

Notifications use the browser's built-in **Web Notifications API** (`new Notification()`). No server involvement — the browser tab runs JavaScript that polls the API and fires a native OS notification when a bus is within the configured threshold.

The tab must be open for this to work. Each trip only triggers one notification per session (tracked in memory) to avoid repeat alerts for the same bus.

To test: open the browser console and run `testNotification()`.

## Hosting

### Docker (recommended for self-hosting)
```bash
docker compose up -d
```
Runs a hardened, non-root, distroless container with health checks, log rotation, and graceful shutdown. See [CLAUDE.md](CLAUDE.md#docker-deployment) for details.

### Cloudflare Tunnel (no code changes)
Run the Node.js server (locally or in the Docker container) and expose it via `cloudflared tunnel`. Cloudflare handles HTTPS and your domain without opening firewall ports.

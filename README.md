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

- Node.js 18+
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
├── package.json
├── public/
│   ├── index.html     # Single-page app shell
│   ├── app.js         # Frontend — map, commute panel, notifications, settings
│   └── style.css      # Dark theme
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
| `GET /api/vehicles` | Live bus positions for route (cached 15s) |
| `GET /api/trip-updates` | Stop-level delay data for route (cached 30s) |
| `GET /api/stops` | All 43 stops served by route |
| `GET /api/schedule?stop_id=X` | Today's scheduled departures at a stop |
| `GET /api/route-stops` | Stops and shape coordinates grouped by direction |
| `GET /api/service-status` | Whether the route is currently in service |
| `GET /api/status` | Debug info — counts of loaded stops, trips, stop times |

## Data Sources

All feeds are public and require no authentication.

| Feed | URL |
|---|---|
| Static GTFS | `http://gtfs.halifax.ca/static/google_transit.zip` |
| Vehicle positions | `https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb` |
| Trip updates | `https://gtfs.halifax.ca/realtime/TripUpdate/TripUpdates.pb` |
| Alerts | `https://gtfs.halifax.ca/realtime/Alert/Alerts.pb` |

The `route_id` in the GTFS feed is `"194"`.

## How Notifications Work

Notifications use the browser's built-in **Web Notifications API** (`new Notification()`). No server involvement — the browser tab runs JavaScript that polls the API and fires a native OS notification when a bus is within the configured threshold.

The tab must be open for this to work. Each trip only triggers one notification per session (tracked in memory) to avoid repeat alerts for the same bus.

To test: open the browser console and run `testNotification()`.

**Limitation:** Notifications do not work on a locked iPhone with this approach. See the iOS Push roadmap item below.

## Hosting

Currently designed to run locally. Three options for making it publicly accessible:

### Cloudflare Tunnel (no code changes)
Run the Node.js server as-is and expose it via `cloudflared tunnel`. Cloudflare handles HTTPS and your domain without opening firewall ports.

## Roadmap

### iOS push notifications
Enable notifications on a locked iPhone via server-initiated Web Push. The current client-polling approach stops working as soon as iOS suspends the tab.

Required additions:
- `manifest.json` to make the app installable as a PWA (iOS push only works from a Home Screen app, not a Safari tab)
- Service worker (`sw.js`) to handle `push` events and call `self.registration.showNotification()`
- VAPID key pair for authenticating the server with Apple's push infrastructure
- `/api/subscribe` endpoint to store each device's push subscription alongside their stop and threshold preferences
- Server-side polling loop that checks GTFS-RT and calls `web-push` when a bus is within range of a subscribed stop

iOS requirements: 16.4 or later, app launched from Home Screen at least once, notification permission granted via a user gesture (button tap).

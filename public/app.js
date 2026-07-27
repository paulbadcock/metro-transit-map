/* ─── Bus Tracker — Frontend ──────────────────────────────────────── */

const HALIFAX_CENTER = [44.6476, -63.5728];
const HALIFAX_TZ = "America/Halifax";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  vehicles: [],
  stops: [],
  allTripUpdates: [],
  schedule: [],
  alerts: [],
  notifiedTripIds: new Set(),
  vehicleMarkers: new Map(), // id -> L.Marker
  stopMarkers: [],
  routePolylines: [],
  activeTab: "map",
  lastVehicleFetch: null,
  fetchErrors: 0,
  serviceStatus: null,
};

// ─── Settings (persisted in localStorage) ────────────────────────────────────
const DEFAULTS = {
  selectedRoute: "194",
  morningStop: "",
  eveningStop: "",
  morningStart: "07:00",
  morningEnd: "09:00",
  eveningStart: "16:00",
  eveningEnd: "18:30",
  notifEnable: false,
  notifMinutes: 5,
};

function loadSettings() {
  const raw = localStorage.getItem("metromaps_settings");
  return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
}

function saveSettings(s) {
  localStorage.setItem("metromaps_settings", JSON.stringify(s));
}

let settings = loadSettings();

function currentRouteId() {
  return settings.selectedRoute || "194";
}

// ─── Map Setup ────────────────────────────────────────────────────────────────
const map = L.map("map", {
  center: HALIFAX_CENTER,
  zoom: 13,
  zoomControl: true,
}).setView(HALIFAX_CENTER, 13);

L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 20,
  subdomains: "abcd",
}).addTo(map);

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

// Returns the current delay (minutes) for a trip from the most recently
// arriving stop-time update, or null if no real-time data is available yet.
function getTripDelayMinutes(tripId) {
  if (!tripId) return null;
  let best = null;
  for (const u of state.allTripUpdates) {
    if (u.trip_id !== tripId) continue;
    if (best === null || (u.stop_sequence ?? Infinity) < (best.stop_sequence ?? Infinity)) {
      best = u;
    }
  }
  if (!best) return null;
  const delaySeconds = best.departure_delay ?? best.arrival_delay;
  return delaySeconds != null ? Math.round(delaySeconds / 60) : null;
}

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

// ─── Security Utilities ───────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Time Utilities ───────────────────────────────────────────────────────────
function nowInHalifax() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: HALIFAX_TZ }));
}

function timeStringToMinutes(t) {
  // Handles "HH:MM" or "HH:MM:SS" — also handles >24h GTFS times
  const parts = t.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

function minutesToTimeString(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function nowMinutes() {
  const d = nowInHalifax();
  return d.getHours() * 60 + d.getMinutes();
}

function formatTime12(timeStr) {
  // timeStr = "HH:MM" or "HH:MM:SS"
  let [h, m] = timeStr.split(":").map(Number);
  h = h % 24;
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatCountdown(minutesAway) {
  if (minutesAway < 1) return "<1";
  return String(Math.round(minutesAway));
}

// ─── Active Commute Window ────────────────────────────────────────────────────
function getActiveWindow() {
  const now = nowMinutes();
  const ms = timeStringToMinutes(settings.morningStart);
  const me = timeStringToMinutes(settings.morningEnd);
  const es = timeStringToMinutes(settings.eveningStart);
  const ee = timeStringToMinutes(settings.eveningEnd);

  if (now >= ms && now <= me && settings.morningStop) return "morning";
  if (now >= es && now <= ee && settings.eveningStop) return "evening";
  return null;
}

function getActiveStop() {
  const w = getActiveWindow();
  if (w === "morning") return settings.morningStop;
  if (w === "evening") return settings.eveningStop;
  return settings.morningStop || settings.eveningStop;
}

// ─── API Calls ────────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

async function fetchVehicles() {
  state.vehicles = await apiFetch(
    `/api/vehicles?route_id=${encodeURIComponent(currentRouteId())}`,
  );
  state.lastVehicleFetch = new Date();
  updateVehicleMarkers();
  updateBusList();
  updateStatusDot(true);
}

async function fetchTripUpdates() {
  state.allTripUpdates = await apiFetch(
    `/api/trip-updates?route_id=${encodeURIComponent(currentRouteId())}`,
  );
}

async function fetchStops() {
  state.stops = await apiFetch(
    `/api/stops?route_id=${encodeURIComponent(currentRouteId())}`,
  );
  populateStopDropdowns();
  drawStopMarkers();
}

async function fetchRoutePolyline() {
  const data = await apiFetch(
    `/api/route-stops?route_id=${encodeURIComponent(currentRouteId())}`,
  );
  drawRoutePolylines(data);
}

async function fetchScheduleForStop(stopId) {
  if (!stopId) {
    state.schedule = [];
    return;
  }
  state.schedule = await apiFetch(
    `/api/schedule?stop_id=${encodeURIComponent(stopId)}&route_id=${encodeURIComponent(currentRouteId())}`,
  );
}

async function fetchRoutes() {
  const routes = await apiFetch("/api/routes");
  const sel = document.getElementById("route-select");
  sel.innerHTML = routes
    .map((r) => {
      const label = r.route_long_name
        ? `${escapeHtml(r.route_short_name)} \u2014 ${escapeHtml(r.route_long_name)}`
        : escapeHtml(r.route_short_name);
      return `<option value="${escapeHtml(r.route_id)}">${label}</option>`;
    })
    .join("");
  sel.value = currentRouteId();
}

// ─── Map: Vehicles ────────────────────────────────────────────────────────────
function updateVehicleMarkers() {
  const seenIds = new Set();

  for (const v of state.vehicles) {
    if (!v.lat || !v.lon) continue;
    seenIds.add(v.id);
    const delayMin = getTripDelayMinutes(v.trip_id);

    if (state.vehicleMarkers.has(v.id)) {
      const marker = state.vehicleMarkers.get(v.id);
      marker.setLatLng([v.lat, v.lon]);
      marker.setIcon(makeBusIcon(v.bearing, v.timestamp, delayMin));
      marker.getPopup()?.setContent(buildBusPopup(v, delayMin));
    } else {
      const marker = L.marker([v.lat, v.lon], {
        icon: makeBusIcon(v.bearing, v.timestamp, delayMin),
        title: `Bus ${v.label || v.id}`,
        zIndexOffset: 100,
      })
        .bindPopup(buildBusPopup(v, delayMin))
        .addTo(map);

      marker.on("click", () => {
        // Highlight in sidebar list
        highlightBusInList(v.id);
      });

      state.vehicleMarkers.set(v.id, marker);
    }
  }

  // Remove markers for buses no longer in feed
  for (const [id, marker] of state.vehicleMarkers) {
    if (!seenIds.has(id)) {
      marker.remove();
      state.vehicleMarkers.delete(id);
    }
  }
}

function buildBusPopup(v, delayMin) {
  const speed = v.speed != null ? `${Math.round(v.speed * 3.6)} km/h` : "–";
  const ts = v.timestamp
    ? new Date(v.timestamp * 1000).toLocaleTimeString("en-CA", {
        timeZone: HALIFAX_TZ,
        hour: "2-digit",
        minute: "2-digit",
      })
    : "–";
  const ageS = v.timestamp ? Math.round(Date.now() / 1000 - v.timestamp) : null;
  const ageText =
    ageS != null ? ` <span style="opacity:0.65">(${ageS}s ago)</span>` : "";

  let delayLine = "";
  if (delayMin != null) {
    const cls = delayMin > 1 ? "late" : delayMin < -1 ? "early" : "ontime";
    const text =
      delayMin > 1
        ? `+${delayMin} min late`
        : delayMin < -1
          ? `${delayMin} min early`
          : "On time";
    delayLine = `<div class="delay ${cls}">${text}</div>`;
  }

  return `
    <strong>Route ${escapeHtml(currentRouteId())}</strong><br>
    Bus #${escapeHtml(v.label || v.id)}<br>
    Trip: ${escapeHtml(v.trip_id || "–")}<br>
    Speed: ${escapeHtml(speed)}<br>
    Updated: ${escapeHtml(ts)}${ageText}<br>
    ${delayLine}
    <span style="opacity:0.65">Refreshing every 15s</span>
  `;
}

function highlightBusInList(id) {
  document.querySelectorAll(".bus-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.busId === id);
  });
}

// ─── Map: Stops ───────────────────────────────────────────────────────────────
function drawStopMarkers() {
  for (const m of state.stopMarkers) m.remove();
  state.stopMarkers = [];

  for (const s of state.stops) {
    if (!s.stop_lat || !s.stop_lon) continue;
    const m = L.marker([s.stop_lat, s.stop_lon], {
      icon: makeStopIcon(s.directions),
      title: s.stop_name,
    })
      .bindPopup(buildStopPopup(s.stop_name, s.stop_id, null))
      .addTo(map);
    m.on("popupopen", () => loadStopPopupTimes(m, s.stop_id, s.stop_name));
    state.stopMarkers.push(m);
  }
}

// Times pane is `null` while loading, an array (possibly empty) once fetched.
function buildStopPopup(stopName, stopId, upcoming) {
  const header = `<strong>${escapeHtml(stopName)}</strong><br>Stop #${escapeHtml(stopId)}`;

  let timesHtml;
  if (upcoming === null) {
    timesHtml = `<div class="stop-popup-times empty-state">Loading times…</div>`;
  } else if (upcoming.length === 0) {
    timesHtml = `<div class="stop-popup-times empty-state">No upcoming departures</div>`;
  } else {
    timesHtml = `<div class="stop-popup-times">${upcoming
      .map((s) => {
        let delayHtml = `<span class="delay ontime">On time</span>`;
        if (s.delayMin > 1) delayHtml = `<span class="delay late">+${s.delayMin} min</span>`;
        else if (s.delayMin < -1) delayHtml = `<span class="delay early">${s.delayMin} min</span>`;

        return `
          <div class="stop-popup-time-row">
            <span class="stop-popup-time">${formatTime12(minutesToTimeString(s.estimatedMin))}</span>
            ${delayHtml}
            <span class="stop-popup-headsign">${escapeHtml(s.trip_headsign || "")}</span>
          </div>`;
      })
      .join("")}</div>`;
  }

  return `${header}${timesHtml}`;
}

async function loadStopPopupTimes(marker, stopId, stopName) {
  try {
    const schedule = await apiFetch(
      `/api/schedule?stop_id=${encodeURIComponent(stopId)}&route_id=${encodeURIComponent(currentRouteId())}`,
    );
    const upcoming = NextBuses.computeNextBuses(schedule, stopId, state.allTripUpdates, nowMinutes(), 5);
    marker.setPopupContent(buildStopPopup(stopName, stopId, upcoming));
  } catch (err) {
    marker.setPopupContent(
      `<strong>${escapeHtml(stopName)}</strong><br>Stop #${escapeHtml(stopId)}<br><span class="empty-state">Couldn't load times</span>`,
    );
  }
}

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

// ─── Sidebar: Bus List ────────────────────────────────────────────────────────
function busListEmptyMessage() {
  const s = state.serviceStatus;
  if (!s) return `No buses on route ${currentRouteId()} right now.`;
  const route = s.routeShortName || currentRouteId();
  if (s.nowMin != null && s.nowMin < s.firstMin) {
    return `No buses yet today — first bus at ${formatTime12(s.firstService)}.`;
  }
  if (s.nextService) {
    return `No buses right now — next bus at ${formatTime12(s.nextService)}.`;
  }
  if (s.lastService) {
    return `Service has ended for today — last bus was at ${formatTime12(s.lastService)}.`;
  }
  return `No buses on route ${route} right now.`;
}

function updateBusList() {
  const el = document.getElementById("bus-list");
  if (state.vehicles.length === 0) {
    el.innerHTML = `<div class="empty-state">${escapeHtml(busListEmptyMessage())}</div>`;
    return;
  }

  el.innerHTML = state.vehicles
    .map(
      (v) => `
    <div class="bus-item" data-bus-id="${escapeHtml(v.id)}" onclick="panToBus('${escapeHtml(v.id)}')">
      <div class="bus-badge">${escapeHtml(currentRouteId())}</div>
      <div class="bus-info">
        <div class="bus-label">Bus #${escapeHtml(v.label || v.id)}</div>
        <div class="bus-meta">${v.trip_id ? `Trip ${escapeHtml(v.trip_id)}` : "No trip"}</div>
      </div>
    </div>
  `,
    )
    .join("");

  const ts = state.lastVehicleFetch
    ? `Updated ${state.lastVehicleFetch.toLocaleTimeString("en-CA", { timeZone: HALIFAX_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "";
  document.getElementById("last-update").textContent = ts;
}

function updateRouteHeader() {
  document.querySelector("#logo span:last-child").textContent =
    `Route ${currentRouteId()}`;
  document.title = `Route ${currentRouteId()} Bus Tracker`;
}

async function switchRoute() {
  // Clear map elements for the old route
  for (const [, marker] of state.vehicleMarkers) marker.remove();
  state.vehicleMarkers.clear();
  for (const m of state.stopMarkers) m.remove();
  state.stopMarkers = [];
  for (const pl of state.routePolylines) pl.remove();
  state.routePolylines = [];

  // Clear data
  state.vehicles = [];
  state.stops = [];
  state.schedule = [];
  state.allTripUpdates = [];
  state.alerts = [];
  state.notifiedTripIds.clear();

  updateRouteHeader();

  try {
    await fetchStops();
  } catch (err) {
    console.warn("[BusTracker] Could not load stops:", err);
  }
  try {
    await fetchRoutePolyline();
  } catch (err) {
    console.warn("[BusTracker] Could not load route polyline:", err);
  }
  try {
    await fetchVehicles();
  } catch (err) {
    console.error("[BusTracker] Vehicle fetch failed:", err);
    updateStatusDot(false);
  }
  try {
    await fetchTripUpdates();
  } catch (err) {
    console.warn("[BusTracker] Trip update fetch failed:", err);
  }

  const stopId = getActiveStop();
  if (stopId) {
    try {
      await fetchScheduleForStop(stopId);
    } catch {}
  }

  updateCommutePanel();
  await checkServiceStatus();
  await checkAlerts();
}

// eslint-disable-next-line no-unused-vars -- called from an inline onclick= in the bus-item markup above
function panToBus(id) {
  const v = state.vehicles.find((x) => x.id === id);
  if (v && v.lat && v.lon) {
    map.panTo([v.lat, v.lon], { animate: true, duration: 0.5 });
    state.vehicleMarkers.get(id)?.openPopup();
  }
}

// ─── Status Dot ───────────────────────────────────────────────────────────────
function updateStatusDot(ok) {
  const dot = document.getElementById("status-dot");
  dot.className = ok ? "green" : "red";
}

// ─── Commute Panel ────────────────────────────────────────────────────────────
function updateCommutePanel() {
  const window = getActiveWindow();
  const stopId = getActiveStop();

  const badge = document.getElementById("commute-direction-indicator");
  if (window === "morning") {
    badge.textContent = "🌅 Morning Commute";
    badge.className = "direction-badge morning";
  } else if (window === "evening") {
    badge.textContent = "🌆 Evening Commute";
    badge.className = "direction-badge evening";
  } else {
    badge.textContent = stopId
      ? "Outside commute window"
      : "Configure stops in Settings";
    badge.className = "direction-badge";
  }

  updateNextBuses(stopId);
  updateScheduleList(stopId);
}

function computeNextBuses(stopId, limit = 3) {
  return NextBuses.computeNextBuses(state.schedule, stopId, state.allTripUpdates, nowMinutes(), limit);
}

function updateNextBuses(stopId) {
  const el = document.getElementById("next-buses");
  const upcoming = computeNextBuses(stopId);

  if (upcoming.length === 0) {
    el.innerHTML =
      '<div class="empty-state">No upcoming buses in the next 2 hours.</div>';
    return;
  }

  el.innerHTML = upcoming
    .map((s) => {
      const ma = s.minutesAway;
      let countdownClass = "countdown-normal";
      if (ma <= 2) countdownClass = "countdown-imminent";
      else if (ma <= 8) countdownClass = "countdown-soon";

      let delayHtml;
      if (s.delayMin > 1) {
        delayHtml = `<div class="delay late">+${s.delayMin} min late</div>`;
      } else if (s.delayMin < -1) {
        delayHtml = `<div class="delay early">${s.delayMin} min early</div>`;
      } else {
        delayHtml = `<div class="delay ontime">On time</div>`;
      }

      return `
      <div class="next-bus-item">
        <div class="next-bus-time">
          <div class="time">${formatTime12(minutesToTimeString(s.estimatedMin))}</div>
          ${delayHtml}
        </div>
        <div class="next-bus-countdown">
          <span class="countdown-value ${countdownClass}">${formatCountdown(ma)}</span>
          <span class="countdown-unit">min</span>
          <div class="trip-headsign">${escapeHtml(s.trip_headsign || "")}</div>
        </div>
      </div>
    `;
    })
    .join("");

  checkNotifications(upcoming, stopId);
}

function updateScheduleList(stopId) {
  const el = document.getElementById("schedule-list");
  if (!stopId || state.schedule.length === 0) {
    el.innerHTML = '<div class="empty-state">–</div>';
    return;
  }

  const nowMin = nowMinutes();
  const items = state.schedule.slice(0, 40); // show up to 40

  el.innerHTML = items
    .map((s) => {
      const depMin = timeStringToMinutes(s.departure_time);
      const past = depMin < nowMin - 1;
      return `
      <div class="schedule-item ${past ? "past" : ""}">
        <span class="sched-time">${formatTime12(s.departure_time)}</span>
        <span class="sched-headsign">${escapeHtml(s.trip_headsign || "")}</span>
      </div>
    `;
    })
    .join("");
}

// ─── Notifications ────────────────────────────────────────────────────────────
function notificationsSupported() {
  return typeof Notification !== "undefined" && Notification.permission !== undefined;
}

function checkNotifications(upcoming, stopId) {
  if (!settings.notifEnable) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;

  const threshold = settings.notifMinutes;
  for (const s of upcoming) {
    if (s.minutesAway <= threshold && s.minutesAway >= 0) {
      const key = `${s.trip_id}_${stopId}`;
      if (!state.notifiedTripIds.has(key)) {
        state.notifiedTripIds.add(key);
        const stopName =
          state.stops.find((x) => x.stop_id === stopId)?.stop_name ||
          "your stop";
        const departBy = minutesToTimeString(
          nowMinutes() + Math.round(s.minutesAway),
        );
        fireNotification(
          `Route 194 arriving in ~${Math.round(s.minutesAway)} min`,
          `Bus at ${stopName} — depart by ${formatTime12(departBy)}`,
        );
      }
    }
  }
}

function fireNotification(title, body) {
  try {
    new Notification(title, {
      body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚌</text></svg>',
      tag: "rt194-" + Date.now(),
    });
    console.log("[BusTracker] Notification fired:", title, body);
  } catch (e) {
    console.warn("[BusTracker] Notification failed:", e.message);
  }
}

// Exposed globally for testing
window.testNotification = () => {
  if (!notificationsSupported()) {
    alert("Notifications are not supported in this browser.\nOn Safari, you need to add this page to the Dock as a web app.");
    return;
  }
  Notification.requestPermission().then((perm) => {
    if (perm === "granted") {
      fireNotification(
        "Route 194 test",
        "This is a test notification from Route 194 Bus Tracker.",
      );
    } else {
      alert("Notification permission not granted.");
    }
  });
};

// ─── Settings Panel ───────────────────────────────────────────────────────────
function populateStopDropdowns() {
  const mSelect = document.getElementById("morning-stop");
  const eSelect = document.getElementById("evening-stop");

  const opts = state.stops
    .map(
      (s) =>
        `<option value="${escapeHtml(s.stop_id)}">${escapeHtml(s.stop_name)}</option>`,
    )
    .join("");
  const placeholder = '<option value="">— Select a stop —</option>';

  mSelect.innerHTML = placeholder + opts;
  eSelect.innerHTML = placeholder + opts;

  // Restore saved values
  if (settings.morningStop) mSelect.value = settings.morningStop;
  if (settings.eveningStop) eSelect.value = settings.eveningStop;
}

function applySettingsToForm() {
  const routeSel = document.getElementById("route-select");
  if (routeSel) routeSel.value = settings.selectedRoute || "194";
  document.getElementById("morning-stop").value = settings.morningStop;
  document.getElementById("evening-stop").value = settings.eveningStop;
  document.getElementById("morning-start").value = settings.morningStart;
  document.getElementById("morning-end").value = settings.morningEnd;
  document.getElementById("evening-start").value = settings.eveningStart;
  document.getElementById("evening-end").value = settings.eveningEnd;
  document.getElementById("notif-enable").checked = settings.notifEnable;
  document.getElementById("notif-minutes").value = settings.notifMinutes;
}

document
  .getElementById("settings-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const prevStop = getActiveStop();
    const prevRoute = settings.selectedRoute;

    const newRoute = document.getElementById("route-select").value;
    const routeChanged = newRoute !== prevRoute;

    settings.selectedRoute = newRoute;
    // If route changed, clear stop selections — they belong to the old route
    if (routeChanged) {
      settings.morningStop = "";
      settings.eveningStop = "";
    } else {
      settings.morningStop = document.getElementById("morning-stop").value;
      settings.eveningStop = document.getElementById("evening-stop").value;
    }
    settings.morningStart = document.getElementById("morning-start").value;
    settings.morningEnd = document.getElementById("morning-end").value;
    settings.eveningStart = document.getElementById("evening-start").value;
    settings.eveningEnd = document.getElementById("evening-end").value;
    settings.notifEnable = document.getElementById("notif-enable").checked;
    settings.notifMinutes = parseInt(
      document.getElementById("notif-minutes").value,
    );
    saveSettings(settings);

    // Request notification permission if enabled
    if (settings.notifEnable && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    // Flash save indicator
    const indicator = document.getElementById("settings-saved");
    indicator.hidden = false;
    setTimeout(() => {
      indicator.hidden = true;
    }, 2000);

    if (routeChanged) {
      await switchRoute();
      applySettingsToForm();
    } else {
      const newStop = getActiveStop();
      if (newStop !== prevStop) {
        await fetchScheduleForStop(newStop);
      }
      updateCommutePanel();
    }
  });

// ─── Tab Switching ────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    state.activeTab = tab;

    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    document.getElementById(`tab-${tab}`).classList.add("active");

    // Invalidate map size when map tab becomes visible
    if (tab === "map") setTimeout(() => map.invalidateSize(), 50);
  });
});

// ─── Refresh Button ───────────────────────────────────────────────────────────
document.getElementById("refresh-btn").addEventListener("click", async () => {
  try {
    await Promise.all([fetchVehicles(), fetchTripUpdates()]);
    updateCommutePanel();
  } catch (err) {
    console.error("Refresh error:", err);
    updateStatusDot(false);
  }
});

// ─── Test Notification Button ─────────────────────────────────────────────────
document.getElementById("test-notif-btn").addEventListener("click", () => {
  window.testNotification();
});

// ─── Service Warning Bar ─────────────────────────────────────────────────────
const SERVICE_WARNING_DISMISS_KEY = "metromaps_dismissed_service_warning";
let currentServiceWarningMessage = "";

async function checkServiceStatus() {
  try {
    const s = await apiFetch(
      `/api/service-status?route_id=${encodeURIComponent(currentRouteId())}`,
    );
    state.serviceStatus = s;
    updateBusList();

    const bar = document.getElementById("service-warning");
    const text = document.getElementById("service-warning-text");

    const activeVehicles = state.vehicles.filter((v) => v.trip_id);
    if (activeVehicles.length === 0) {
      const route = s.routeShortName || currentRouteId();
      if (s.nowMin != null && s.nowMin < s.firstMin) {
        currentServiceWarningMessage = `Route ${route} is not yet in service — first bus at ${formatTime12(s.firstService)}`;
      } else if (s.nextService) {
        currentServiceWarningMessage = `Route ${route} has no active buses — next bus at ${formatTime12(s.nextService)}`;
      } else if (s.lastService) {
        currentServiceWarningMessage = `Route ${route} has finished service for today — last bus was at ${formatTime12(s.lastService)}`;
      } else {
        currentServiceWarningMessage = `Route ${route} is not currently in service`;
      }
      text.textContent = currentServiceWarningMessage;
      // Stay dismissed only while the message is unchanged — a status change
      // (e.g. "not yet in service" → "finished for today") surfaces again.
      const dismissed = sessionStorage.getItem(SERVICE_WARNING_DISMISS_KEY);
      bar.hidden = dismissed === currentServiceWarningMessage;
    } else {
      bar.hidden = true;
    }
  } catch (err) {
    console.warn("[BusTracker] Service status check failed:", err);
  }
}

document
  .getElementById("service-warning-dismiss")
  .addEventListener("click", () => {
    sessionStorage.setItem(
      SERVICE_WARNING_DISMISS_KEY,
      currentServiceWarningMessage,
    );
    document.getElementById("service-warning").hidden = true;
  });

// ─── Service Alert Banner (detours, disruptions) ─────────────────────────────
const ALERT_DISMISS_KEY = "metromaps_dismissed_alerts";
let currentAlertSignature = "";

function alertSignature(alerts) {
  return alerts.map((a) => a.header).join("|");
}

async function checkAlerts() {
  try {
    state.alerts = await apiFetch(
      `/api/alerts?route_id=${encodeURIComponent(currentRouteId())}`,
    );
    const banner = document.getElementById("alert-banner");
    const list = document.getElementById("alert-banner-list");
    if (state.alerts.length === 0) {
      banner.hidden = true;
      list.innerHTML = "";
      currentAlertSignature = "";
      return;
    }
    currentAlertSignature = alertSignature(state.alerts);
    list.innerHTML = state.alerts
      .map(
        (a) =>
          `<div class="alert-item" title="${escapeHtml(a.description)}"><span>🚧</span><span>${escapeHtml(a.header)}</span></div>`,
      )
      .join("");
    // Stay dismissed only while the same set of alerts is still active — a
    // new or changed alert should surface even if an earlier one was dismissed.
    const dismissed = sessionStorage.getItem(ALERT_DISMISS_KEY);
    banner.hidden = dismissed === currentAlertSignature;
  } catch (err) {
    console.warn("[BusTracker] Alert check failed:", err);
  }
}

document.getElementById("alert-dismiss").addEventListener("click", () => {
  sessionStorage.setItem(ALERT_DISMISS_KEY, currentAlertSignature);
  document.getElementById("alert-banner").hidden = true;
});

// ─── Polling ──────────────────────────────────────────────────────────────────
async function pollVehicles() {
  try {
    await fetchVehicles();
    state.fetchErrors = 0;
    // If active-trip vehicles just became available, the service banner may be stale — hide it
    if (state.vehicles.some((v) => v.trip_id)) {
      document.getElementById("service-warning").hidden = true;
    }
  } catch (err) {
    console.error("[BusTracker] Vehicle fetch error:", err);
    state.fetchErrors++;
    updateStatusDot(false);
  }
}

async function pollTripUpdates() {
  try {
    await fetchTripUpdates();
    updateCommutePanel();
    updateVehicleMarkers();
  } catch (err) {
    console.error("[BusTracker] Trip update fetch error:", err);
  }
}

// ─── Bus Age Ticker (updates badge + open popup every second) ─────────────────
function tickBusAges() {
  const nowSec = Date.now() / 1000;
  for (const [id, marker] of state.vehicleMarkers) {
    const v = state.vehicles.find((x) => x.id === id);
    if (!v || !v.timestamp) continue;

    // Patch badge text/class directly — avoids full icon re-render flicker
    const iconEl = marker.getElement();
    if (iconEl) {
      const badge = iconEl.querySelector(".bus-age-badge");
      if (badge) {
        const ageS = Math.round(nowSec - v.timestamp);
        badge.textContent = `${ageS}s`;
        badge.className = `bus-age-badge${ageS < 30 ? "" : ageS < 90 ? " stale" : " very-stale"}`;
      }
    }

    if (marker.isPopupOpen()) {
      marker.getPopup().setContent(buildBusPopup(v));
    }
  }
}

// ─── Countdown Timer (UI refresh every 15s) ───────────────────────────────────
function tickCommutePanel() {
  if (state.activeTab === "commute") {
    updateCommutePanel();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  console.log("[BusTracker] Initializing...");

  updateRouteHeader();

  // Load routes first so the selector is populated before applySettingsToForm
  try {
    await fetchRoutes();
  } catch (err) {
    console.warn("[BusTracker] Could not load routes:", err);
  }

  applySettingsToForm();

  // Request notification permission up front if enabled
  if (settings.notifEnable && Notification.permission === "default") {
    Notification.requestPermission();
  }

  // Initial data load
  try {
    await fetchStops();
  } catch (err) {
    console.warn("[BusTracker] Could not load stops:", err);
  }

  try {
    await fetchRoutePolyline();
  } catch (err) {
    console.warn("[BusTracker] Could not load route polyline:", err);
  }

  try {
    await fetchVehicles();
  } catch (err) {
    console.error("[BusTracker] Initial vehicle fetch failed:", err);
    updateStatusDot(false);
  }

  try {
    await fetchTripUpdates();
  } catch (err) {
    console.warn("[BusTracker] Initial trip update fetch failed:", err);
  }

  const stopId = getActiveStop();
  if (stopId) {
    try {
      await fetchScheduleForStop(stopId);
    } catch (err) {
      console.warn("[BusTracker] Schedule fetch failed:", err);
    }
  }

  updateCommutePanel();
  await checkServiceStatus();
  await checkAlerts();

  // Start polling
  setInterval(pollVehicles, 15_000);
  setInterval(pollTripUpdates, 15_000);
  setInterval(tickCommutePanel, 15_000);
  setInterval(tickBusAges, 1_000);
  setInterval(checkServiceStatus, 5 * 60_000);
  setInterval(checkAlerts, 5 * 60_000);

  // Reload schedule for active stop every 5 minutes
  setInterval(async () => {
    const sid = getActiveStop();
    if (sid) {
      try {
        await fetchScheduleForStop(sid);
      } catch {}
      updateCommutePanel();
    }
  }, 5 * 60_000);

  console.log("[BusTracker] Ready.");
}

init().catch((err) => console.error("[BusTracker] Init error:", err));

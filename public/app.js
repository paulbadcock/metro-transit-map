/* ─── Bus Tracker — Frontend ──────────────────────────────────────── */

const HALIFAX_CENTER = [44.6476, -63.5728];
const HALIFAX_TZ = "America/Halifax";

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  vehicles: [],
  stops: [],
  allTripUpdates: [],
  schedule: [],
  notifiedTripIds: new Set(),
  vehicleMarkers: new Map(), // id -> L.Marker
  stopMarkers: [],
  routePolylines: [],
  activeTab: "map",
  lastVehicleFetch: null,
  fetchErrors: 0,
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

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// ─── Bus Icon ─────────────────────────────────────────────────────────────────
function makeBusIcon(bearing, timestamp) {
  const rotation =
    bearing != null ? `transform:rotate(${bearing + 90}deg)` : "";
  let badge = "";
  if (timestamp) {
    const ageS = Math.round(Date.now() / 1000 - timestamp);
    const ageClass = ageS < 30 ? "" : ageS < 90 ? " stale" : " very-stale";
    badge = `<div class="bus-age-badge${ageClass}">${ageS}s</div>`;
  }
  return L.divIcon({
    className: "",
    html: `<div class="bus-marker-wrap"><div class="bus-marker-icon" style="${rotation}">🚌</div>${badge}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

function makeStopIcon() {
  return L.divIcon({
    className: "stop-marker",
    iconSize: [10, 10],
    iconAnchor: [5, 5],
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

    if (state.vehicleMarkers.has(v.id)) {
      const marker = state.vehicleMarkers.get(v.id);
      marker.setLatLng([v.lat, v.lon]);
      marker.setIcon(makeBusIcon(v.bearing, v.timestamp));
      marker.getPopup()?.setContent(buildBusPopup(v));
    } else {
      const marker = L.marker([v.lat, v.lon], {
        icon: makeBusIcon(v.bearing, v.timestamp),
        title: `Bus ${v.label || v.id}`,
        zIndexOffset: 100,
      })
        .bindPopup(buildBusPopup(v))
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

function buildBusPopup(v) {
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
  return `
    <strong>Route ${escapeHtml(currentRouteId())}</strong><br>
    Bus #${escapeHtml(v.label || v.id)}<br>
    Trip: ${escapeHtml(v.trip_id || "–")}<br>
    Speed: ${escapeHtml(speed)}<br>
    Updated: ${escapeHtml(ts)}${ageText}<br>
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
      icon: makeStopIcon(),
      title: s.stop_name,
    })
      .bindPopup(`<strong>${escapeHtml(s.stop_name)}</strong><br>Stop #${escapeHtml(s.stop_id)}`)
      .addTo(map);
    state.stopMarkers.push(m);
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
    }).addTo(map);
    state.routePolylines.push(pl);
  });

  // Fit map to route if we have polylines
  if (state.routePolylines.length > 0) {
    const group = L.featureGroup(state.routePolylines);
    map.fitBounds(group.getBounds().pad(0.1));
  }
}

// ─── Sidebar: Bus List ────────────────────────────────────────────────────────
function updateBusList() {
  const el = document.getElementById("bus-list");
  if (state.vehicles.length === 0) {
    el.innerHTML = `<div class="empty-state">No buses on route ${currentRouteId()} right now.</div>`;
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
}

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
  if (!stopId || state.schedule.length === 0) return [];

  const nowMin = nowMinutes();
  const delayByTrip = buildDelayMap();

  const upcoming = state.schedule
    .map((s) => {
      const depMin = timeStringToMinutes(s.departure_time);
      const delaySeconds =
        delayByTrip[s.trip_id + "_" + stopId]?.departure_delay ?? 0;
      const delayMin = Math.round(delaySeconds / 60);
      const estimatedMin = depMin + delayMin;
      const minutesAway = estimatedMin - nowMin;
      return { ...s, depMin, delayMin, estimatedMin, minutesAway };
    })
    .filter((s) => s.minutesAway >= -1 && s.minutesAway <= 120)
    .sort((a, b) => a.minutesAway - b.minutesAway)
    .slice(0, limit);

  return upcoming;
}

function buildDelayMap() {
  // Maps "trip_id_stop_id" -> update
  const m = {};
  for (const u of state.allTripUpdates) {
    if (u.stop_id) m[`${u.trip_id}_${u.stop_id}`] = u;
  }
  return m;
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

      let delayHtml = "";
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
        `<option value="${escapeHtml(s.stop_id)}">${escapeHtml(s.stop_name)} (${escapeHtml(s.stop_id)})</option>`,
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

    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
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
async function checkServiceStatus() {
  try {
    const s = await apiFetch(
      `/api/service-status?route_id=${encodeURIComponent(currentRouteId())}`,
    );
    const bar = document.getElementById("service-warning");
    const text = document.getElementById("service-warning-text");

    const activeVehicles = state.vehicles.filter((v) => v.trip_id);
    if (activeVehicles.length === 0) {
      const route = s.routeShortName || currentRouteId();
      if (s.nowMin != null && s.nowMin < s.firstMin) {
        text.textContent = `Route ${route} is not yet in service — first bus at ${formatTime12(s.firstService)}`;
      } else if (s.nextService) {
        text.textContent = `Route ${route} has no active buses — next bus at ${formatTime12(s.nextService)}`;
      } else if (s.lastService) {
        text.textContent = `Route ${route} has finished service for today — last bus was at ${formatTime12(s.lastService)}`;
      } else {
        text.textContent = `Route ${route} is not currently in service`;
      }
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  } catch (err) {
    console.warn("[BusTracker] Service status check failed:", err);
  }
}

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

  // Start polling
  setInterval(pollVehicles, 15_000);
  setInterval(pollTripUpdates, 15_000);
  setInterval(tickCommutePanel, 15_000);
  setInterval(tickBusAges, 1_000);
  setInterval(checkServiceStatus, 5 * 60_000);

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

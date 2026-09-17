/* player.js — Winamp, two modes:
 *   desktop:  transparent full-screen surface, panels float anywhere,
 *             click-through everywhere except the panels themselves
 *   windowed: normal opaque window sized to the winamp cluster
 * Mode comes from the URL (?mode=desktop|windowed); the menu toggles it.
 */
let webamp = null;
let pendingTracks = null;
let panelStateSyncTimer = null;
const PANEL_IDS = ["main", "playlist", "equalizer", "milkdrop"];
const MODE = new URLSearchParams(location.search).get("mode") || "desktop";
if (MODE === "windowed") document.body.classList.add("windowed");

// ---------- mode: desktop click-through ----------
let ignoring = true;
let pointerInside = false;
let pointerDown = false;

function setIgnore(v) {
  if (v !== ignoring) {
    ignoring = v;
    window.plex.setIgnoreMouseEvents?.(v);
  }
}

function panelRects() {
  return [...document.querySelectorAll("#webamp [class*='window']")]
    .filter((el) => el.offsetHeight > 0 && el.offsetWidth > 0)
    .map((el) => el.getBoundingClientRect());
}

function insideAnyPanel(x, y) {
  const M = 2;
  return panelRects().some(
    (r) => x >= r.left - M && x <= r.right + M && y >= r.top - M && y <= r.bottom + M
  );
}

if (MODE === "desktop") {
  document.addEventListener("mousemove", (e) => {
    pointerInside = insideAnyPanel(e.clientX, e.clientY);
    if (!pointerDown) setIgnore(!pointerInside);
  });
  document.addEventListener("mousedown", () => (pointerDown = true), true);
  document.addEventListener("mouseup", () => {
    pointerDown = false;
    if (!pointerInside) setIgnore(true);
  }, true);
  setIgnore(true);
}

// ---------- mode: windowed bounds tracking ----------
// NOTE: getBoundingClientRect reports UNZOOMED CSS px under webContents zoom,
// so dimensions must be scaled by the current zoom factor or the window
// clips its content at >100%.
let currentZoom = 1;
async function refreshZoom() {
  currentZoom = (await window.plex.getZoom()) || 1;
}
let windowSyncTimer = null;
function scheduleWindowSync() {
  if (MODE !== "windowed") return;
  clearTimeout(windowSyncTimer);
  windowSyncTimer = setTimeout(syncWindowSize, 200);
}
function syncWindowSize() {
  if (MODE !== "windowed") return;
  const all = [...document.querySelectorAll("#webamp div")].filter((el) => {
    if (el.id === "webamp") return false;
    const s = getComputedStyle(el);
    if (s.position !== "absolute") return false;
    if (el.offsetWidth < 100 || el.offsetHeight < 40) return false;
    return true;
  });
  // Drop descendants: a panel's children are positioned inside it, not panels.
  const els = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  if (!els.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
    x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
  }
  window.plex.setWindowBounds({
    // Fit the cluster; the 700px floor from early development left a phantom
    // 425px of empty window beside a lone main panel.
    width: Math.max(275, Math.ceil((x2 - x1) * currentZoom)),
    height: Math.ceil((y2 - y1) * currentZoom) + 8,
  });
}

// ---------- Webamp panel session state ----------
function currentPanelState() {
  const windows = webamp?.store?.getState?.().windows?.genWindows || {};
  return Object.fromEntries(PANEL_IDS.map((id) => [id, id === "main" ? true : Boolean(windows[id]?.open)]));
}

function restorePanelState(desired) {
  const windows = webamp?.store?.getState?.().windows?.genWindows || {};
  for (const id of PANEL_IDS) {
    if (id === "main" || typeof desired?.[id] !== "boolean" || !windows[id]) continue;
    if (Boolean(windows[id].open) !== desired[id]) {
      webamp.store.dispatch({ type: "TOGGLE_WINDOW", windowId: id });
    }
  }
}

function schedulePanelStateSave() {
  clearTimeout(panelStateSyncTimer);
  panelStateSyncTimer = setTimeout(() => {
    // main process persists the panel state AND syncs the View-menu checkmarks
    window.plex.sendPanelsChanged(currentPanelState());
  }, 150);
}

// ---------- webamp ----------
async function initWebamp() {
  const t0 = Date.now();
  while (!window.WebampWithButterchurn && Date.now() - t0 < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const Ctor = window.WebampWithButterchurn || window.Webamp;
  const opts = {
    initialTracks: [],
    enableHotkeys: true,
    filePickers: false,
    enableMilkdrop: true,
    windowLayout: {
      main: { position: { left: 24, top: 24 } },
      equalizer: { position: { left: 24, top: 140 } },
      playlist: {
        position: { left: 24, top: 256 },
        size: { extraHeight: 4, extraWidth: 0 },
      },
      milkdrop: {
        position: { left: 299, top: 24 },
        size: { extraHeight: 12, extraWidth: 7 },
      },
    },
  };
  // Use an optional local preset pack when present; otherwise Webamp's
  // bundled Butterchurn preset collection is used.
  const og = window.__ogPresets;
  if (og) {
    opts.requireButterchurnPresets = async () =>
      Object.entries(og).map(([name, butterchurnPresetObject]) => ({
        name,
        butterchurnPresetObject,
      }));
  }
  webamp = new Ctor(opts);
  window.__webamp = webamp;
  await webamp.renderWhenReady(document.getElementById("webamp-slot"));
  const savedSession = await window.plex.getSession();
  restorePanelState(savedSession.panels);
  webamp.store.subscribe(() => {
    schedulePanelStateSave();
    scheduleWindowSync(); // panel toggles change the cluster size
  });
  if (MODE === "windowed") {
    // drag regions for the OS window + bounds sync
    const style = document.createElement("style");
    style.textContent = `
      #webamp .window > div > .draggable,
      #webamp .window .draggable.title-bar { -webkit-app-region: drag; }
      #webamp .draggable .handle, #webamp .draggable > * { -webkit-app-region: no-drag; }
      #webamp .context-menu, #webamp [role="menu"] { -webkit-app-region: no-drag; }
    `;
    document.head.appendChild(style);
    await refreshZoom();
    syncWindowSize();
    setTimeout(syncWindowSize, 800);
  }
  if (pendingTracks) {
    enqueue(pendingTracks);
    pendingTracks = null;
  }
}

// ---------- fractional scaling (zoom) — Cmd+= / Cmd+- / Cmd+0 (macOS),
// Ctrl+= / Ctrl+- / Ctrl+0 (Linux). Webamp's Win-era hotkey table only
// checks ctrlKey, so on Linux both handlers would fire for Ctrl+=;
// the renderer-side handler therefore only adds Ctrl on non-macOS.
const ZOOM_STEPS = [0.75, 1, 1.15, 1.25, 1.5, 1.75, 2];
async function bumpZoom(dir) {
  const cur = (await window.plex.getZoom()) || 1;
  let next;
  if (dir === 0) {
    next = 1;
  } else {
    const idx = ZOOM_STEPS.findIndex((z) => Math.abs(z - cur) < 0.01);
    const at = idx === -1 ? ZOOM_STEPS.indexOf([...ZOOM_STEPS].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur))[0]) : idx;
    next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))];
  }
  await window.plex.setZoom(next);
  await refreshZoom();
  scheduleWindowSync();
}
document.addEventListener("keydown", (e) => {
  // macOS uses Cmd (metaKey); Linux uses Ctrl — webamp's Win-era hotkey table
  // also binds Ctrl, so the renderer handler stays Cmd-only on macOS to avoid
  // double-firing there.
  const mod = window.plex.platform === "darwin" ? e.metaKey : e.ctrlKey;
  if (!mod) return;
  // ⌘L/Ctrl+L belongs to the app menu (Media Library). Webamp's Win-era hotkey
  // table only checks ctrlKey, so ⌘L leaks into its bare-L handler and ALSO pops
  // the local file picker. Swallow it at capture phase before webamp sees it.
  if (e.key === "l" || e.key === "L") {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.key === "=" || e.key === "+") { e.preventDefault(); bumpZoom(1); }
  else if (e.key === "-") { e.preventDefault(); bumpZoom(-1); }
  else if (e.key === "0") { e.preventDefault(); bumpZoom(0); }
}, true);

// ---------- panel toggles from the View menu ----------
window.plex.onPanelToggle((id) => {
  if (!webamp?.store) return;
  if (id === "main") return; // base surface, never toggled
  webamp.store.dispatch({ type: "TOGGLE_WINDOW", windowId: id });
});

// ---------- enqueue from the library window ----------
function enqueue(tracks) {
  if (!webamp) {
    pendingTracks = tracks;
    return;
  }
  const playlist = tracks
    .filter((t) => t && t.url)
    .map((t) => ({
      url: t.url,
      metaData: { artist: t.artist, title: t.title },
      duration: t.duration,
    }));
  webamp.setTracksToPlay(playlist);
  if (MODE === "windowed") syncWindowSize();
}

window.plex.onEnqueue((tracks) => enqueue(tracks));

// ---------- media keys ----------
window.plex.registerMediaKeys();
window.plex.onMediaKey((action) => {
  if (!webamp) return;
  try {
    if (action === "toggle") {
      webamp.getMediaStatus() === "PLAYING" ? webamp.pause() : webamp.play();
    } else if (action === "next") {
      webamp.nextTrack();
    } else if (action === "prev") {
      webamp.previousTrack();
    }
  } catch (e) {
    /* webamp mid-teardown */
  }
});

initWebamp();
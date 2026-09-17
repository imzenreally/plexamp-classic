/* player.js — Winamp, two modes:
 *   float:    transparent cluster window hugging the panels; gaps are
 *             click-through, the desktop shows between panels. The window
 *             follows panel drags (renderer-driven), so panels can live
 *             anywhere on screen without a full-screen overlay.
 *   windowed: normal opaque window sized to the winamp cluster
 * Mode comes from the URL (?mode=float|windowed); the menu toggles it.
 * "desktop" is accepted as a legacy alias for float.
 */
let webamp = null;
let pendingTracks = null;
let panelStateSyncTimer = null;
const PANEL_IDS = ["main", "playlist", "equalizer", "milkdrop"];
const rawMode = new URLSearchParams(location.search).get("mode") || "float";
const MODE = rawMode === "windowed" ? "windowed" : "float";
if (MODE === "windowed") document.body.classList.add("windowed");

// ---------- mode: float/windowed click-through + cluster tracking ----------
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

if (MODE !== "windowed") {
  document.addEventListener("mousemove", (e) => {
    pointerInside = insideAnyPanel(e.clientX, e.clientY);
    if (!pointerDown) setIgnore(!pointerInside);
  });
  document.addEventListener("mousedown", (e) => {
    pointerDown = true;
    // Float pre-grow: webamp pins panel store positions at >= 0 relative to
    // the host origin — dragging left/up stops dead at the host edge. Grow
    // the window's left/top edge AT DRAG START (before webamp's drag math
    // engages — no feedback possible) so there is headroom in every
    // direction. The post-drag rewrap settles the exact box.
    if (MODE === "float" && e.button === 0 && scheduleClusterSync.preGrow) scheduleClusterSync.preGrow();
  }, true);
  document.addEventListener("mouseup", () => {
    pointerDown = false;
    if (!pointerInside) setIgnore(true);
  }, true);
  setIgnore(true);
}

// ---------- mode: float cluster tracking ----------
// The float window is a transparent rectangle wrapping the panel cluster
// plus a margin on every side. Gaps inside the window are click-through.
//
// Two sync shapes, chosen for drag safety (webamp diffs pointer events from
// a pointerdown anchor, so moving the window ORIGIN under an in-flight drag
// would feed back into its math and fling the panel):
//   live (pointer down): grow-only — extend right/bottom edges so a panel
//     being dragged toward the edge never clips. Origin never moves.
//   full (pointer up / toggle / zoom / init): re-wrap the window around the
//     cluster with a fresh margin, then counter-translate #webamp-slot by
//     the window's move delta so panels stay visually fixed on screen.
//
// getBoundingClientRect reports UNZOOMED CSS px under webContents zoom, so
// all deltas are scaled by the current zoom factor.
const FLOAT_MARGIN = 320; // css px of transparent margin around the cluster
let currentZoom = 1;
async function refreshZoom() {
  currentZoom = (await window.plex.getZoom()) || 1;
}
let clusterTimer = null;
let lastLiveGrow = 0;
function scheduleClusterSync(live) {
  if (MODE !== "float") return;
  if (live) {
    // LEADING-EDGE throttle: fires on the FIRST mutation of a burst, then at
    // most every 33ms. A trailing debounce starves here — real drags fire
    // mutations every animation frame, endlessly restarting the timer, so
    // the window never grew mid-drag (the "invisible wall" bug).
    const now = performance.now();
    if (now - lastLiveGrow < 33) {
      clearTimeout(clusterTimer);
      clusterTimer = setTimeout(() => { lastLiveGrow = performance.now(); syncCluster({ live: true }); }, 33 - (now - lastLiveGrow));
      return;
    }
    lastLiveGrow = performance.now();
    clearTimeout(clusterTimer);
    syncCluster({ live: true });
    return;
  }
  clearTimeout(clusterTimer);
  clusterTimer = setTimeout(() => syncCluster({ live }), 0);
}
// Full rewraps run on a TRAILING debounce: webamp commits its final panel
// position some time AFTER pointerup, and a rewrap that fires first shifts
// the coordinate space under that write (panel flings). Any panel-root
// mutation inside the window postpones the rewrap until webamp settles.
let rewrapTimer = null;
function scheduleRewrap() {
  if (MODE !== "float") return;
  clearTimeout(rewrapTimer);
  rewrapTimer = setTimeout(() => syncCluster({ live: false }), 150);
}
function visiblePanels() {
  const els = [...document.querySelectorAll("#webamp div")].filter((el) => {
    if (el.id === "webamp") return false;
    const s = getComputedStyle(el);
    if (s.position !== "absolute") return false;
    if (el.offsetWidth < 100 || el.offsetHeight < 40) return false;
    return true;
  });
  return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
}
// Last cluster bounds the renderer ASKED the main process to apply. Read
// back NEVER — window.screenX/Y updates asynchronously, so deriving dx from
// a live read races the compositor and compounds errors.
let lastCluster = null; // { x, y, width, height } as sent to player:setCluster

// All displays' work areas, from the main process. Cached briefly so drag
// bursts don't hammer IPC, but never trusted across a drag — displays are
// rare to change, but a stale union here would clamp the window wrongly.
let displaysCache = null;
let displaysCacheAt = 0;
async function getDisplays() {
  if (!window.plex.getDisplays) return [window.screen];
  const now = performance.now();
  if (displaysCache && now - displaysCacheAt < 5000) return displaysCache;
  try {
    displaysCache = await window.plex.getDisplays();
    displaysCacheAt = now;
    window.__displaysCache = displaysCache; // sync fallback for drag-start pre-grow
  } catch {
    return [window.screen];
  }
  return displaysCache;
}

// Pre-grow the window at drag START: extend all four edges by the margin
// (clamped to the display union), keeping the PANELS visually fixed by
// counter-shifting the host. Safe at mousedown because webamp's drag math
// has not engaged yet (its anchor read happens on its own pointerdown
// handler, which runs after ours — and even if it read first, screen-space
// deltas are invariant to window moves).
function preGrowCluster() {
  if (MODE !== "float" || !window.plex.setCluster) return;
  const panels = visiblePanels();
  if (!panels.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of panels) {
    const r = el.getBoundingClientRect();
    x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
    x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
  }
  const displays = window.__displaysCache || [{ workArea: { x: window.screen.availLeft, y: window.screen.availTop, width: window.screen.availWidth, height: window.screen.availHeight } }];
  let UL = Infinity, UT = Infinity, UR = -Infinity, UB = -Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    UL = Math.min(UL, wa.x); UT = Math.min(UT, wa.y);
    UR = Math.max(UR, wa.x + wa.width); UB = Math.max(UB, wa.y + wa.height);
  }
  const M = FLOAT_MARGIN;
  // target window box: cluster grown by M on all sides, clamped to union
  const tx = Math.max(UL, Math.round(window.screenX + x1 * currentZoom - M));
  const ty = Math.max(UT, Math.round(window.screenY + y1 * currentZoom - M));
  const tw = Math.min(Math.round((x2 - x1) * currentZoom + M * 2), UR - tx);
  const th = Math.min(Math.round((y2 - y1) * currentZoom + M * 2), UB - ty);
  const dx = tx - window.screenX;
  const dy = ty - window.screenY;
  if (dx === 0 && dy === 0 && tw === window.outerWidth && th === window.outerHeight) return;
  lastCluster = { x: tx, y: ty, width: tw, height: th };
  window.plex.setCluster({ ...lastCluster });
  shiftHost(-dx / currentZoom, -dy / currentZoom);
}

// Move the #webamp host by (dx, dy) CSS px. Panels stay visually fixed on
// screen when the window moves by the opposite amount.
function shiftHost(dx, dy) {
  const host = document.getElementById("webamp");
  if (!host) return;
  const cur = host.dataset.shift ? JSON.parse(host.dataset.shift) : { x: 0, y: 0 };
  cur.x += dx; cur.y += dy;
  host.dataset.shift = JSON.stringify(cur);
  host.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
}

async function syncCluster({ live = false } = {}) {
  if (MODE !== "float" || !window.plex.setCluster) return;
  const panels = visiblePanels();
  if (!panels.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of panels) {
    const r = el.getBoundingClientRect();
    x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top);
    x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
  }
  if (live) {
    // Grow-only: keep the origin; extend edges so nothing clips mid-drag.
    // Size is capped to the union of all displays (not just the current
    // one) so the window can grow TOWARD another display while dragging.
    const displays = await getDisplays();
    let UL = Infinity, UT = Infinity, UR = -Infinity, UB = -Infinity;
    for (const d of displays) {
      const wa = d.workArea || { x: d.left || 0, y: d.top || 0, width: d.width, height: d.height };
      UL = Math.min(UL, wa.x); UT = Math.min(UT, wa.y);
      UR = Math.max(UR, wa.x + wa.width); UB = Math.max(UB, wa.y + wa.height);
    }
    const base = lastCluster || { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
    lastCluster = {
      x: base.x,
      y: base.y,
      width: Math.min(Math.max(base.width, Math.ceil((x2 + 80) * currentZoom)), UR - UL),
      height: Math.min(Math.max(base.height, Math.ceil((y2 + 80) * currentZoom)), UB - UT),
    };
    window.plex.setCluster({ ...lastCluster });
    return;
  }
  // Full re-wrap, in SCREEN space (valid at rest — full syncs only run when
  // no drag is in flight): wrap the cluster with a FLOAT_MARGIN on every
  // side, clamp to the UNION of all displays' work areas (panels can be
  // dragged across displays — the window must be allowed to follow onto
  // the target display instead of being pinned to the birth display),
  // move the window there, then counter-translate #webamp by the actual
  // move so panels stay put.
  const displays = await getDisplays();
  let UL = Infinity, UT = Infinity, UR = -Infinity, UB = -Infinity;
  for (const d of displays) {
    const wa = d.workArea || { x: d.left || 0, y: d.top || 0, width: d.width, height: d.height };
    UL = Math.min(UL, wa.x); UT = Math.min(UT, wa.y);
    UR = Math.max(UR, wa.x + wa.width); UB = Math.max(UB, wa.y + wa.height);
  }
  const scr = { availLeft: UL, availTop: UT, availWidth: UR - UL, availHeight: UB - UT };
  const clusterLeft = window.screenX + x1 * currentZoom;
  const clusterTop = window.screenY + y1 * currentZoom;
  const clusterW = (x2 - x1) * currentZoom;
  const clusterH = (y2 - y1) * currentZoom;
  const tw = Math.min(Math.ceil(clusterW + FLOAT_MARGIN * 2), scr.availWidth);
  const th = Math.min(Math.ceil(clusterH + FLOAT_MARGIN * 2), scr.availHeight);
  const tx = Math.round(Math.max(scr.availLeft, Math.min(clusterLeft - FLOAT_MARGIN, scr.availLeft + scr.availWidth - tw)));
  const ty = Math.round(Math.max(scr.availTop, Math.min(clusterTop - FLOAT_MARGIN, scr.availTop + scr.availHeight - th)));
  const dx = tx - window.screenX;
  const dy = ty - window.screenY;
  lastCluster = { x: tx, y: ty, width: tw, height: th };
  window.plex.setCluster({ ...lastCluster });
  // Webamp renders `#webamp` as a direct child of <body> (it portals out of
  // #webamp-slot after render), so the counter-translate must target #webamp
  // itself — transforming the slot does nothing to the panels.
  const host = document.getElementById("webamp") || document.getElementById("webamp-slot");
  if (host && host.id !== "webamp-slot") {
    shiftHost(-dx / currentZoom, -dy / currentZoom);
  }
}
scheduleClusterSync.preGrow = preGrowCluster;
// Webamp restyles its windows constantly (drag, shade, resize); style/class
// mutations are the cheapest signal that the cluster box may have changed.
let floatObserver = null;
function startFloatObserver() {
  if (MODE !== "float" || floatObserver) return;
  const host = document.getElementById("webamp") || document.getElementById("webamp-slot") || document.body;
  floatObserver = new MutationObserver((records) => {
    // Only panel-ROOT mutations count (webamp restyles its internals — LCD,
    // marquee — constantly during playback; reacting to those would spin
    // the observer). Our own #webamp transform writes are excluded too.
    const real = records.some(
      (r) => r.target.id !== "webamp" && r.target.className && String(r.target.className).includes("window")
    );
    if (!real) return;
    if (pointerDown) scheduleClusterSync(true); // grow-only mid-drag
    else scheduleRewrap(); // trailing; lets webamp's final write land first
  });
  floatObserver.observe(host, { subtree: true, attributes: true, attributeFilter: ["style", "class"] });
}

// ---------- mode: windowed bounds tracking ----------
// NOTE: getBoundingClientRect reports UNZOOMED CSS px under webContents zoom,
// so dimensions must be scaled by the current zoom factor or the window
// clips its content at >100%.
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
  if (MODE === "float") {
    await refreshZoom();
    startFloatObserver();
    // Let webamp lay out its panels first, then wrap the window around them.
    syncCluster();
    setTimeout(() => syncCluster(), 300);
    setTimeout(() => syncCluster(), 1200);
    // Drags grow the window live; the full re-wrap (with slot counter-shift)
    // happens on a trailing debounce after pointerup, so webamp's own final
    // position write lands before we shift the coordinate space under it.
    document.addEventListener("pointerup", () => scheduleRewrap(), true);
    document.addEventListener("pointercancel", () => scheduleRewrap(), true);
    // Panel toggles and store churn change the cluster size.
    webamp.store.subscribe(() => scheduleClusterSync(pointerDown));
    // Zoom changes from ANY source (hotkeys, menu, tray, bridge calls) alter
    // the viewport — a resize event fires — so rewrap + rescale from there.
    window.addEventListener("resize", () => {
      refreshZoom();
      scheduleRewrap();
    });
  }
  // ---------- eject button -> Media Library ----------
  // Webamp's eject opens a local-file picker, which is useless here (the app
  // streams from Plex). Intercept at capture phase so webamp's own handler
  // never fires, and toggle the Media Library instead.
  document.addEventListener(
    "mousedown",
    (e) => {
      const eject = e.target && e.target.closest ? e.target.closest("#eject") : null;
      if (!eject) return;
      e.preventDefault();
      e.stopPropagation();
      window.plex.toggleLibrary();
    },
    true
  );

  // ---------- Winamp-style right-click menu ----------
  // Preempts webamp's generic panel menu (which lacks app-level items);
  // webamp's own menu stays reachable via the skin's O button (click).
  // Webamp opens its DOM menu on right-BUTTONDOWN, before the contextmenu
  // event dispatches — so suppressing the menu ALSO requires swallowing the
  // right-mousedown at capture phase (stopPropagation before webamp's root
  // listener sees it). The subsequent contextmenu event then reaches our
  // handler and opens the native menu instead.
  const interactiveSel =
    "input, textarea, select, .track-cell, .playlist-tracks, .slider-handle, [role='slider'], .context-menu";
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 2) return;
      const panel = e.target.closest("#webamp [class*='window']");
      if (!panel) return;
      if (e.target.closest(interactiveSel)) return;
      e.stopPropagation();
    },
    true
  );
  document.addEventListener(
    "contextmenu",
    (e) => {
      const panel = e.target.closest("#webamp [class*='window']");
      if (!panel) return;
      if (e.target.closest(interactiveSel)) return;
      e.preventDefault();
      e.stopPropagation();
      window.plex.openContextMenu?.(
        Math.round(e.clientX * currentZoom),
        Math.round(e.clientY * currentZoom)
      );
    },
    true
  );
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
  scheduleClusterSync();
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
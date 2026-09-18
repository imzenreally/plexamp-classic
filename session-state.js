const DEFAULT_LIBRARY_BOUNDS = { width: 1100, height: 720 };

const DEFAULT_SESSION = Object.freeze({
  version: 1,
  player: { mode: "native", zoomFactor: 1, bounds: null, cluster: null, alwaysOnTop: false },
  panels: { main: true, playlist: false, equalizer: false, milkdrop: false },
  // Native-mode panel windows: { open, bounds } per real OS window.
  panelsNative: {
    main: { open: true },
    playlist: { open: false },
    equalizer: { open: false },
    milkdrop: { open: false },
  },
  library: { open: false, bounds: null },
});

function copyDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_SESSION));
}

function validCluster(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Number.isFinite(value.width) && Number.isFinite(value.height) &&
    value.width >= 40 && value.width <= 4000 &&
    value.height >= 40 && value.height <= 4000;
}

function validBounds(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Number.isFinite(value.width) && Number.isFinite(value.height) &&
    value.width >= 500 && value.height >= 400;
}

function repairedBounds(bounds, workArea) {
  const fallback = {
    width: Math.min(DEFAULT_LIBRARY_BOUNDS.width, Math.max(500, workArea.width - 40)),
    height: Math.min(DEFAULT_LIBRARY_BOUNDS.height, Math.max(400, workArea.height - 40)),
  };
  if (!validBounds(bounds) || bounds.width > workArea.width || bounds.height > workArea.height) {
    return { x: workArea.x + 20, y: workArea.y + 20, ...fallback };
  }

  const visibleWidth = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const visibleHeight = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
  if (visibleWidth < 80 || visibleHeight < 80) {
    return { x: workArea.x + 20, y: workArea.y + 20, width: bounds.width, height: bounds.height };
  }

  return {
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width)),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height)),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function normalizeSession(raw) {
  const state = copyDefault();
  if (!raw || raw.version !== 1) return state;

  if (raw.player?.mode === "desktop" || raw.player?.mode === "windowed" || raw.player?.mode === "float" || raw.player?.mode === "native") {
    // "desktop"/"float" were the single-surface floating modes; both map to
    // native (real panel windows) at read time so legacy sessions upgrade.
    state.player.mode = raw.player.mode === "windowed" ? "windowed" : "native";
  }
  if (Number.isFinite(raw.player?.zoomFactor) && raw.player.zoomFactor >= 0.75 && raw.player.zoomFactor <= 2) {
    state.player.zoomFactor = raw.player.zoomFactor;
  }
  if (validCluster(raw.player?.cluster)) {
    state.player.cluster = {
      x: Math.round(raw.player.cluster.x),
      y: Math.round(raw.player.cluster.y),
      width: Math.round(raw.player.cluster.width),
      height: Math.round(raw.player.cluster.height),
    };
  }
  if (validBounds(raw.player?.bounds)) {
    state.player.bounds = {
      x: Math.round(raw.player.bounds.x),
      y: Math.round(raw.player.bounds.y),
      width: Math.round(raw.player.bounds.width),
      height: Math.round(raw.player.bounds.height),
    };
  }
  if (typeof raw.player?.alwaysOnTop === "boolean") {
    state.player.alwaysOnTop = raw.player.alwaysOnTop;
  }
  for (const panel of Object.keys(state.panels)) {
    if (typeof raw.panels?.[panel] === "boolean") state.panels[panel] = raw.panels[panel];
  }
  // Native panel windows: merge open flags and bounds per panel id.
  for (const id of Object.keys(state.panelsNative)) {
    const src = raw.panelsNative?.[id];
    if (src && typeof src === "object") {
      if (typeof src.open === "boolean" || typeof src.bounds === "object") {
        state.panelsNative[id] = {
          ...state.panelsNative[id],
          ...(typeof src.open === "boolean" ? { open: src.open } : {}),
          ...(src.bounds && Number.isFinite(src.bounds.x) && Number.isFinite(src.bounds.y) && Number.isFinite(src.bounds.width) && Number.isFinite(src.bounds.height)
            ? { bounds: { x: Math.round(src.bounds.x), y: Math.round(src.bounds.y), width: Math.round(src.bounds.width), height: Math.round(src.bounds.height) } }
            : {}),
        };
      }
    } else if (typeof raw.panels?.[id] === "boolean") {
      // Upgrade legacy float/windowed visibility into real panel windows.
      state.panelsNative[id].open = id === "main" ? true : raw.panels[id];
    }
  }
  if (typeof raw.library?.open === "boolean") state.library.open = raw.library.open;
  if (validBounds(raw.library?.bounds)) {
    state.library.bounds = {
      x: Math.round(raw.library.bounds.x),
      y: Math.round(raw.library.bounds.y),
      width: Math.round(raw.library.bounds.width),
      height: Math.round(raw.library.bounds.height),
    };
  }
  // A visible main player is the only stable base surface; a corrupt session
  // must never relaunch the app into an empty, inaccessible desktop overlay.
  state.panels.main = true;
  return state;
}

module.exports = { DEFAULT_SESSION, normalizeSession, repairedBounds };

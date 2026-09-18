const { app, BrowserWindow, ipcMain, shell, session, protocol, net, globalShortcut, Menu, screen, Tray } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const auth = require("./auth");
const { DEFAULT_SESSION, normalizeSession, repairedBounds } = require("./session-state");
const { normalizeRelatedReleaseGroups } = require("./search-tree");

// Web Audio must be allowed without a user gesture (headless/VNC use, autoplay)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// app:// origin — ES modules (butterchurn bundle) cannot load from file://
// app-stream:// — local proxy for audio bytes (self-signed TLS tolerance)
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: "app-stream",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// ---------- optional .env (LAN default server) ----------
const ENV_PATH = path.join(__dirname, ".env");
try {
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const ENV_HOST = process.env.PLEX_HOST || "";
const ENV_TOKEN =
  !process.env.PLEX_TOKEN || process.env.PLEX_TOKEN === "your-plex-token-here"
    ? ""
    : process.env.PLEX_TOKEN;
const ENV_SECTION = process.env.PLEX_SECTION || "";

let playerWindow = null;
let libraryWindow = null;

// ---------- durable session state ----------
// Webamp owns panel geometry. Electron owns the outer player/library windows;
// session-state.json stores only the visibility/mode/zoom and Electron bounds.
let sessionState = null;
let isQuitting = false;
let isRestartingPlayer = false;

function playerModePath() {
  return path.join(app.getPath("userData"), "player-mode.json");
}
function sessionStatePath() {
  return path.join(app.getPath("userData"), "session-state.json");
}
function readPlayerMode() {
  try {
    const mode = JSON.parse(fs.readFileSync(playerModePath(), "utf8")).mode;
    // desktop/float are legacy names for the panel-windows design; native now.
    return mode === "windowed" ? "windowed" : "native";
  } catch {
    return "native";
  }
}
function writePlayerMode(mode) {
  fs.mkdirSync(path.dirname(playerModePath()), { recursive: true });
  fs.writeFileSync(playerModePath(), JSON.stringify({ mode }));
}
function cloneDefaultSession() {
  return JSON.parse(JSON.stringify(DEFAULT_SESSION));
}
function readSessionState() {
  if (sessionState) return sessionState;
  try {
    sessionState = normalizeSession(JSON.parse(fs.readFileSync(sessionStatePath(), "utf8")));
  } catch {
    // Keep the pre-session player-mode preference on a first run/migration.
    sessionState = cloneDefaultSession();
    sessionState.player.mode = readPlayerMode();
  }
  return sessionState;
}
function writeSessionState() {
  const target = sessionStatePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(sessionState, null, 2)}\n`);
  fs.renameSync(temp, target);
}
function updateSession(patch) {
  const next = JSON.parse(JSON.stringify(readSessionState()));
  if (patch?.player && typeof patch.player === "object") {
    if (patch.player.mode === "desktop" || patch.player.mode === "float" || patch.player.mode === "native") {
      next.player.mode = "native";
    } else if (patch.player.mode === "windowed") {
      next.player.mode = "windowed";
    }
    if (Number.isFinite(patch.player.zoomFactor)) next.player.zoomFactor = patch.player.zoomFactor;
    if (patch.player.bounds === null || typeof patch.player.bounds === "object") next.player.bounds = patch.player.bounds;
    if (patch.player.cluster === null || typeof patch.player.cluster === "object") next.player.cluster = patch.player.cluster;
  }
  if (patch?.panels && typeof patch.panels === "object") {
    for (const key of Object.keys(next.panels)) {
      if (typeof patch.panels[key] === "boolean") next.panels[key] = patch.panels[key];
    }
  }
  if (patch?.panelsNative && typeof patch.panelsNative === "object") {
    for (const id of Object.keys(next.panelsNative)) {
      const src = patch.panelsNative[id];
      if (src && typeof src === "object") {
        if (typeof src.open === "boolean") {
          next.panelsNative[id] = { ...next.panelsNative[id], open: src.open };
        }
        if (src.bounds && typeof src.bounds === "object") {
          next.panelsNative[id] = { ...next.panelsNative[id], bounds: src.bounds };
        }
      }
    }
  }
  if (patch?.library && typeof patch.library === "object") {
    if (typeof patch.library.open === "boolean") next.library.open = patch.library.open;
    if (patch.library.bounds === null || typeof patch.library.bounds === "object") next.library.bounds = patch.library.bounds;
  }
  sessionState = normalizeSession(next);
  writeSessionState();
  return sessionState;
}
function trackedBounds(win, key) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  updateSession(key === "player" ? { player: { bounds } } : { library: { bounds } });
}
function attachBoundsTracking(win, key) {
  win.on("move", () => trackedBounds(win, key));
  win.on("resize", () => trackedBounds(win, key));
}

// ---------- windows ----------
function createPlayerWindow() {
  const saved = readSessionState();
  // Native mode: every panel (main/playlist/equalizer/milkdrop) is its own
  // REAL OS window. No transparent cluster surface exists, so there is
  // nothing invisible to eat clicks (the Wayland/KDE killer), no cluster
  // bounds math, and the compositor handles dragging/snapping/multi-monitor.
  // "desktop"/"float" are legacy names that map to native at read time.
  const mode = saved.player.mode === "windowed" ? "windowed" : "native";
  if (mode === "native") {
    createNativeWindows(saved);
    return;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const restored = saved.player.bounds ? repairedBounds(saved.player.bounds, workArea) : null;
  playerWindow = new BrowserWindow({
    ...(restored || { width: 740, height: 480 }),
    frame: false,
    hasShadow: true,
    resizable: true,
    movable: true,
    backgroundColor: "#1e1e24",
    alwaysOnTop: saved.player.alwaysOnTop,
    title: "Winamp Classic",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachBoundsTracking(playerWindow, "player");
  attachLibraryHotkey(playerWindow);
  playerWindow.loadURL("app://winamp/player.html?mode=windowed");
  playerWindow.webContents.once("did-finish-load", () => {
    const zoom = readSessionState().player.zoomFactor;
    if (zoom !== 1) playerWindow?.webContents.setZoomFactor(zoom);
  });
}

// ---------- native panel windows ----------
// The leader (main) window hosts webamp itself; playlist/equalizer/milkdrop
// are custom-styled satellite windows that read/write the SAME webamp store
// through the panel: IPC bridge below. Each window's bounds live in the
// session under panelsNative.<id>.bounds.
const PANELS = {
  main: { title: "Winamp Classic", w: 275, h: 116, page: "player.html?mode=native&panel=main" },
  playlist: { title: "Winamp Playlist", w: 275, h: 116, page: "playlist-window.html" },
  equalizer: { title: "Winamp Equalizer", w: 275, h: 116, page: "equalizer-window.html" },
  milkdrop: { title: "Winamp Visualizer", w: 275, h: 116, page: "visualizer-window.html" },
};
const nativeWindows = new Map(); // id -> BrowserWindow

function panelBounds(saved, id, fallbackX, fallbackY) {
  const b = saved.panelsNative?.[id]?.bounds;
  if (b) {
    const wa = screen.getDisplayMatching(b).workArea;
    const width = Math.max(180, Math.min(b.width, wa.width));
    const height = Math.max(80, Math.min(b.height, wa.height));
    return {
      x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)),
      y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)),
      width: Math.round(width),
      height: Math.round(height),
    };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const zoom = saved.player?.zoomFactor || 1;
  return {
    x: wa.x + fallbackX,
    y: wa.y + fallbackY,
    width: Math.round(PANELS[id].w * zoom),
    height: Math.round(PANELS[id].h * zoom),
  };
}

function createNativeWindows(saved) {
  const layout = saved.panelsNative || {};
  for (const id of Object.keys(PANELS)) {
    if (id !== "main" && layout[id]?.open === false) continue; // user-closed satellites
    createPanelWindow(id, saved);
  }
}

function createPanelWindow(id, saved) {
  const spec = PANELS[id];
  const fallbacks = { main: [24, 24], playlist: [24, 156], equalizer: [319, 24], milkdrop: [319, 156] };
  const [fx, fy] = fallbacks[id] || [24, 24];
  const bounds = panelBounds(saved || readSessionState(), id, fx, fy);
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    hasShadow: true,
    resizable: true,
    movable: true,
    backgroundColor: "#000000",
    alwaysOnTop: (saved || readSessionState()).player.alwaysOnTop,
    skipTaskbar: false,
    title: spec.title,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  nativeWindows.set(id, win);
  if (id === "main") {
    playerWindow = win;
    attachLibraryHotkey(win);
  }
  win.on("closed", () => {
    if (nativeWindows.get(id) === win) nativeWindows.delete(id);
    if (id === "main") {
      if (playerWindow === win) playerWindow = null;
      if (!isQuitting && !isRestartingPlayer) {
        isQuitting = true;
        app.quit();
      }
    }
    if (!isQuitting && !isRestartingPlayer && id !== "main") {
      updateSession({ panelsNative: { [id]: { open: false } } });
      rebuildMenu();
    }
  });
  win.on("moved", () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    debouncePanelBounds(id, b);
  });
  win.on("resized", () => {
    if (win.isDestroyed()) return;
    debouncePanelBounds(id, win.getBounds());
  });
  win.loadURL(`app://winamp/${spec.page}`);
  win.webContents.once("did-finish-load", () => {
    const zoom = readSessionState().player.zoomFactor;
    if (zoom !== 1) win.webContents.setZoomFactor(zoom);
  });
}

const panelBoundsTimers = new Map();
function debouncePanelBounds(id, b) {
  clearTimeout(panelBoundsTimers.get(id));
  panelBoundsTimers.set(id, setTimeout(() => {
    updateSession({ panelsNative: { [id]: { bounds: { x: b.x, y: b.y, width: b.width, height: b.height } } } });
  }, 400));
}

function togglePanelWindow(id) {
  const existing = nativeWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.close();
    updateSession({ panelsNative: { [id]: { open: false } } });
  } else {
    createPanelWindow(id);
    updateSession({ panelsNative: { [id]: { open: true } } });
    // wake the leader's FFT tap when the visualizer opens
    if (id === "milkdrop") {
      const leader = nativeWindows.get("main");
      if (leader && !leader.isDestroyed()) leader.webContents.send("panel:forward", { __vizWindowOpened: true });
    }
  }
  rebuildMenu();
}

// ---------- panel state bridge (leader <-> satellites) ----------
// Satellites get/put webamp store state through the main process, which
// forwards to the leader window (the only one with a webamp instance).
function forwardToLeader(action) {
  const leader = nativeWindows.get("main");
  if (leader && !leader.isDestroyed()) {
    leader.webContents.send("panel:forward", action);
  }
}

// Panel toggle that routes correctly per mode: native windows toggle real
// windows; windowed/legacy modes dispatch webamp TOGGLE_WINDOW in the player.
function sendToPlayerOrToggle(id) {
  if (readSessionState().player.mode === "native" && id !== "main") {
    togglePanelWindow(id);
    return;
  }
  sendToPlayer("panel:toggle", id);
}

function panelIsOpen(saved, id) {
  const win = nativeWindows.get(id);
  return saved.player.mode === "native"
    ? Boolean(win && !win.isDestroyed())
    : Boolean(saved.panels[id]);
}

function setPanelsAlwaysOnTop(alwaysOnTop) {
  if (readSessionState().player.mode === "native") {
    for (const win of nativeWindows.values()) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(alwaysOnTop);
    }
  } else if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.setAlwaysOnTop(alwaysOnTop);
  }
  updateSession({ player: { alwaysOnTop } });
}

function setPanelsZoom(factor) {
  const saved = readSessionState();
  const oldFactor = saved.player.zoomFactor || 1;
  const ratio = factor / oldFactor;
  if (saved.player.mode === "native") {
    for (const id of Object.keys(PANELS)) {
      const win = nativeWindows.get(id);
      if (win && !win.isDestroyed()) {
        const b = win.getBounds();
        const bounds = { ...b, width: Math.round(b.width * ratio), height: Math.round(b.height * ratio) };
        win.setBounds(bounds);
        win.webContents.setZoomFactor(factor);
        updateSession({ panelsNative: { [id]: { bounds } } });
      } else if (saved.panelsNative?.[id]?.bounds) {
        const b = saved.panelsNative[id].bounds;
        updateSession({ panelsNative: { [id]: { bounds: { ...b, width: Math.round(b.width * ratio), height: Math.round(b.height * ratio) } } } });
      }
    }
  } else if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.setZoomFactor(factor);
  }
  updateSession({ player: { zoomFactor: factor } });
}

const panelStateWaiters = new Map(); // key -> resolve
const PANEL_ACTIONS = {
  playlist: new Set(["CLICKED_TRACK", "CTRL_CLICKED_TRACK", "SHIFT_CLICKED_TRACK", "PLAY_TRACK", "BUFFER_TRACK", "REMOVE_TRACKS", "STOP", "REMOVE_ALL_TRACKS", "SET_TRACK_ORDER"]),
  equalizer: new Set(["SET_BAND_VALUE", "SET_EQ_ON", "SET_EQ_OFF", "SET_EQ_AUTO"]),
};
function panelIdForSender(sender) {
  for (const [id, win] of nativeWindows) {
    if (!win.isDestroyed() && win.webContents === sender) return id;
  }
  return null;
}

function validatedPanelAction(senderPanel, action) {
  if (!action || typeof action.type !== "string" || !PANEL_ACTIONS[senderPanel]?.has(action.type)) return null;
  const type = action.type;
  if (["CLICKED_TRACK", "CTRL_CLICKED_TRACK", "SHIFT_CLICKED_TRACK"].includes(type)) {
    return Number.isInteger(action.index) && action.index >= 0 && action.index < 100000 ? { type, index: action.index } : null;
  }
  if (["PLAY_TRACK", "BUFFER_TRACK"].includes(type)) {
    return Number.isInteger(action.id) && action.id >= 0 ? { type, id: action.id } : null;
  }
  if (["REMOVE_TRACKS", "SET_TRACK_ORDER"].includes(type)) {
    const key = type === "REMOVE_TRACKS" ? "ids" : "trackOrder";
    const value = action[key];
    if (!Array.isArray(value) || value.length > 10000 || new Set(value).size !== value.length || !value.every((id) => Number.isInteger(id) && id >= 0)) return null;
    return { type, [key]: [...value] };
  }
  if (type === "SET_BAND_VALUE") {
    const bands = new Set(["preamp", "60", "170", "310", "600", "1000", "3000", "6000", "12000", "14000", "16000"]);
    return bands.has(String(action.band)) && Number.isFinite(action.value) && action.value >= 0 && action.value <= 100
      ? { type, band: String(action.band), value: action.value }
      : null;
  }
  if (type === "SET_EQ_AUTO") return action.value === false ? { type, value: false } : null;
  return { type };
}

ipcMain.on("panel:stateReply", (e, { id, state } = {}) => {
  const leader = nativeWindows.get("main");
  if (!leader || leader.isDestroyed() || e.sender !== leader.webContents || typeof id !== "string") return;
  const resolve = panelStateWaiters.get(id);
  if (resolve) {
    panelStateWaiters.delete(id);
    resolve(state);
  }
});

ipcMain.handle("panel:getState", (e, slice) => {
  return new Promise((resolve) => {
    const senderPanel = panelIdForSender(e.sender);
    if (!senderPanel || senderPanel === "main" || !new Set(["playlist", "equalizer", "media", "all"]).has(slice)) return resolve(null);
    const leader = nativeWindows.get("main");
    if (!leader || leader.isDestroyed()) return resolve(null);
    const key = `panelstate:${Date.now()}:${Math.random()}`;
    panelStateWaiters.set(key, resolve);
    leader.webContents.send("panel:queryState", { id: key, slice });
    setTimeout(() => {
      if (panelStateWaiters.has(key)) {
        panelStateWaiters.delete(key);
        resolve(null);
      }
    }, 2000);
  });
});

ipcMain.on("panel:action", (e, action) => {
  const senderPanel = panelIdForSender(e.sender);
  const validated = validatedPanelAction(senderPanel, action);
  if (validated) forwardToLeader(validated);
});

// broadcast: leader pushes state deltas to every satellite
ipcMain.on("panel:broadcast", (e, state) => {
  const leader = nativeWindows.get("main");
  if (!leader || leader.isDestroyed() || e.sender !== leader.webContents) return;
  for (const [id, win] of nativeWindows) {
    if (id === "main") continue;
    if (!win.isDestroyed()) win.webContents.send("panel:state", state);
  }
});

// viz FFT relay: leader -> visualizer window only (30fps byte arrays)
ipcMain.on("panel:vizData", (e, data) => {
  const leader = nativeWindows.get("main");
  if (!leader || leader.isDestroyed() || e.sender !== leader.webContents || !Array.isArray(data?.wave) || data.wave.length > 2048) return;
  const viz = nativeWindows.get("milkdrop");
  if (viz && !viz.isDestroyed()) viz.webContents.send("panel:vizData", data);
});

function createLibraryWindow() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.show();
    libraryWindow.focus();
    rebuildMenu();
    return;
  }
  const saved = readSessionState();
  const workArea = screen.getPrimaryDisplay().workArea;
  const bounds = repairedBounds(saved.library.bounds, workArea);
  libraryWindow = new BrowserWindow({
    ...bounds,
    backgroundColor: "#0a0a0c",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 10, y: 10 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  updateSession({ library: { open: true, bounds } });
  rebuildMenu();
  attachBoundsTracking(libraryWindow, "library");
  libraryWindow.loadURL("app://winamp/library.html");
  libraryWindow.once("ready-to-show", () => libraryWindow.show());
  libraryWindow.on("closed", () => {
    if (!isQuitting) updateSession({ library: { open: false } });
    libraryWindow = null;
    rebuildMenu();
  });
}

// Linux: frameless windows mean no menu bar is shown, so the View menu's
// Ctrl+L accelerator never fires there (GTK registers accelerators only
// with a visible menu). Handle it at the window level instead.
function attachLibraryHotkey(win) {
  // before-input-event fires inside webContents regardless of app
  // activation state — on ALL platforms. In float mode the app often isn't
  // frontmost (skipTaskbar, no activation on panel click), so menu
  // accelerators are unreliable; this path always works.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const meta = input.meta || input.control;
    if (meta && (input.key === "l" || input.key === "L")) {
      event.preventDefault();
      toggleLibrary();
    } else if (meta && (input.key === "q" || input.key === "Q")) {
      event.preventDefault();
      isQuitting = true;
      app.quit();
    }
  });
}

function toggleLibrary() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    // Toggle semantics that can't strand the user: if the window exists but
    // isn't visible (minimized, another Space, off-screen), bring it to the
    // front instead of closing it. Only a *visible, focused* window toggles
    // closed. ⌘L must never feel like "nothing happened".
    const visible = libraryWindow.isVisible() && libraryWindow.isFocused();
    if (visible) {
      libraryWindow.close();
    } else {
      if (libraryWindow.isMinimized()) libraryWindow.restore();
      libraryWindow.show();
      libraryWindow.focus();
    }
  } else {
    createLibraryWindow();
  }
  rebuildMenu();
}

function setPlayerModeAndRestart(mode) {
  if (mode === readSessionState().player.mode && playerWindow && !playerWindow.isDestroyed()) {
    return; // radio menu item re-click; don't churn the window
  }
  updateSession({ player: { mode } });
  writePlayerMode(mode); // retain compatibility with existing installations.
  const oldPlayer = playerWindow;
  const oldNativeWindows = [...nativeWindows.values()];
  isRestartingPlayer = true;
  try {
    createPlayerWindow();
    if (oldNativeWindows.length) {
      for (const win of oldNativeWindows) {
        if (!win.isDestroyed()) win.destroy();
      }
    } else if (oldPlayer && !oldPlayer.isDestroyed()) {
      oldPlayer.destroy();
    }
  } finally {
    isRestartingPlayer = false;
  }
  rebuildMenu();
}

// ---------- plex helpers ----------
// All server calls go through auth.plexFetchJson — TLS-tolerant so federated
// servers over https (self-signed) work exactly like LAN http ones.
async function plex(server, pathname) {
  return auth.plexFetchJson(`${server.baseUrl}${pathname}`, {
    headers: {
      "X-Plex-Token": server.token,
      Accept: "application/json",
    },
  });
}

// ---------- auth IPC ----------
ipcMain.handle("auth:status", async () => {
  try {
    const token = auth.readAccountToken();
    const envDefault = Boolean(ENV_HOST && ENV_TOKEN);
    if (!token) return { logged: false, envDefault };
    const user = await auth.fetchUser(token);
    return { logged: true, user, envDefault };
  } catch (e) {
    return { logged: false, error: e.message, envDefault: Boolean(ENV_HOST && ENV_TOKEN) };
  }
});

ipcMain.handle("auth:beginLogin", async () => {
  const { id, code } = await auth.createPin();
  shell.openExternal(auth.authUrlFor(code));
  return { pinId: id, code };
});

ipcMain.handle("auth:poll", async (_e, pinId) => {
  const token = await auth.pollPinOnce(pinId);
  if (token) {
    auth.saveAccountToken(token);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle("auth:logout", async () => {
  auth.clearAccountToken();
  return { ok: true };
});

// ---------- servers IPC ----------
ipcMain.handle("plex:servers", async () => {
  const out = [];
  if (ENV_HOST && ENV_TOKEN) {
    out.push({
      name: "Default (LAN)",
      baseUrl: ENV_HOST,
      token: ENV_TOKEN,
      owned: true,
      source: "env",
    });
  }
  const token = auth.readAccountToken();
  if (token) {
    try {
      const resources = await auth.fetchResources(token);
      for (const r of resources) {
        const dupe = out.find((s) => sameServer(s.baseUrl, r));
        if (dupe) {
          dupe.source = "env+account";
          continue;
        }
        out.push({
          name: r.name,
          baseUrl: null,
          token: r.accessToken,
          owned: r.owned,
          source: "account",
          resource: r,
        });
      }
    } catch (e) {
      console.error("resources error:", e.message);
    }
  }
  return out;
});

function sameServer(a, b) {
  try {
    const ua = new URL(a);
    return (b.connections || []).some(
      (c) => `${c.protocol}://${c.address}:${c.port}` === ua.href
    );
  } catch {
    return false;
  }
}

ipcMain.handle("plex:selectServer", async (_e, serverRef) => {
  let server;
  if (serverRef.source === "env") {
    server = { baseUrl: ENV_HOST, token: ENV_TOKEN };
  } else {
    const probed = await auth.probeBestConnection(serverRef.resource);
    if (!probed) throw new Error(`No reachable connection for ${serverRef.name}`);
    server = { baseUrl: probed, token: serverRef.token };
  }
  const d = await plex(server, "/library/sections");
  const sections = d.MediaContainer.Directory.filter((x) => x.type === "artist").map(
    (x) => ({ title: x.title, key: x.key })
  );
  return { server, sections };
});

// ---------- browsing IPC (server context per call) ----------
ipcMain.handle("plex:sections", async (_e, server) => {
  const d = await plex(server, "/library/sections");
  return d.MediaContainer.Directory.filter((x) => x.type === "artist").map(
    (x) => ({ title: x.title, key: x.key })
  );
});

ipcMain.handle("plex:artists", async (_e, server, sectionKey) => {
  const d = await plex(server, `/library/sections/${sectionKey}/all?type=8`);
  return (d.MediaContainer.Metadata || [])
    .filter((x) => x.title)
    .map((x) => ({ title: x.title, ratingKey: x.ratingKey }));
});

ipcMain.handle("plex:albums", async (_e, server, ratingKey) => {
  const d = await plex(server, `/library/metadata/${encodeURIComponent(ratingKey)}/children`);
  return (d.MediaContainer.Metadata || []).map((x) => ({
    title: x.title,
    year: x.year || "",
    ratingKey: x.ratingKey,
    artist: x.parentTitle || "",
  }));
});

ipcMain.handle("plex:relatedReleases", async (_e, server, ratingKey) => {
  const d = await plex(server, `/library/metadata/${encodeURIComponent(ratingKey)}/related`);
  return normalizeRelatedReleaseGroups(d.MediaContainer.Hub || []);
});

// Plex's section /search endpoint is not available on every server version.
// Hubs search is the stable cross-server endpoint; sectionId scopes its useful
// music results to the selected library while Plex may still return empty/non-
// music hubs, which we deliberately discard.
ipcMain.handle("plex:search", async (_e, server, sectionKey, rawQuery) => {
  const query = String(rawQuery || "").trim();
  if (!query) return { artists: [], albums: [], tracks: [] };
  if (query.length > 160) throw new Error("Search query is too long");
  const d = await plex(
    server,
    `/hubs/search?query=${encodeURIComponent(query)}&sectionId=${encodeURIComponent(sectionKey)}`
  );
  const out = { artists: [], albums: [], tracks: [] };
  for (const hub of d.MediaContainer.Hub || []) {
    const items = hub.Metadata || [];
    if (hub.type === "artist") {
      out.artists.push(...items.map((x) => ({
        type: "artist", title: x.title, ratingKey: x.ratingKey,
      })));
    } else if (hub.type === "album") {
      out.albums.push(...items.map((x) => ({
        type: "album", title: x.title, artist: x.parentTitle || "",
        year: x.year || "", ratingKey: x.ratingKey,
      })));
    } else if (hub.type === "track") {
      out.tracks.push(...items.map((x) => ({
        type: "track", title: x.title, artist: x.grandparentTitle || x.parentTitle || "",
        album: x.parentTitle || "", duration: x.duration ? Math.round(x.duration / 1000) : 0,
        ratingKey: x.ratingKey,
      })));
    }
  }
  // A compact result set is intentional: it keeps keyboard navigation and
  // renderer work responsive even on large, federated libraries.
  for (const key of Object.keys(out)) out[key] = out[key].slice(0, 24);
  return out;
});

// ---------- stream proxy ----------
// Renderer <audio> can't accept federated servers' self-signed TLS. So the
// renderer requests streams via app-stream://<key> and the main process
// fetches the real URL (TLS-tolerant) and pipes the bytes back.
const streamCache = new Map(); // key -> { url, headers }

function makeStreamTrack(server, x) {
  if (!x) return null;
  const part = x.Media?.[0]?.Part?.[0];
  if (!part) return null;
  const key = Math.random().toString(36).slice(2);
  streamCache.set(key, {
    url: `${server.baseUrl}${part.key}`,
    headers: { "X-Plex-Token": server.token },
  });
  return {
    title: x.title,
    artist: x.grandparentTitle || x.parentTitle || "",
    album: x.parentTitle || "",
    duration: x.duration ? Math.round(x.duration / 1000) : 0,
    url: `app-stream://${key}`,
  };
}

ipcMain.handle("plex:tracks", async (_e, server, ratingKey) => {
  const d = await plex(server, `/library/metadata/${ratingKey}/children`);
  return (d.MediaContainer.Metadata || [])
    .map((x) => makeStreamTrack(server, x))
    .filter(Boolean);
});

ipcMain.handle("plex:track", async (_e, server, ratingKey) => {
  const d = await plex(server, `/library/metadata/${ratingKey}`);
  const track = makeStreamTrack(server, (d.MediaContainer.Metadata || [])[0]);
  return track ? [track] : [];
});

// ---------- media keys ----------
ipcMain.on("media:register", (event) => {
  if (!isPlayerSender(event)) return;
  globalShortcut.register("MediaPlayPause", () =>
    playerWindow?.webContents.send("media", "toggle")
  );
  globalShortcut.register("MediaNextTrack", () =>
    playerWindow?.webContents.send("media", "next")
  );
  globalShortcut.register("MediaPreviousTrack", () =>
    playerWindow?.webContents.send("media", "prev")
  );
});
ipcMain.on("media:unregister", (event) => {
  if (isPlayerSender(event)) globalShortcut.unregisterAll();
});

// ---------- library -> player relay ----------
ipcMain.on("library:enqueue", (event, tracks) => {
  if (!isLibrarySender(event) || !Array.isArray(tracks) || tracks.length > 10000) return;
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send("player:enqueue", tracks);
  }
});

// ---------- player window: size to winamp cluster (windowed mode) ----------
ipcMain.on("player:setBounds", (e, { width, height } = {}) => {
  if (!playerWindow || playerWindow.isDestroyed()) return;
  if (e.sender !== playerWindow.webContents || !Number.isFinite(width) || !Number.isFinite(height)) return;
  const cur = playerWindow.getBounds();
  const padding = readSessionState().player.mode === "windowed" ? 16 : 0;
  const w = Math.min(Math.max(180, Math.round(width) + padding), 1400);
  const h = Math.min(Math.max(80, Math.round(height) + padding), 1200);
  if (Math.abs(cur.width - w) > 2 || Math.abs(cur.height - h) > 2) {
    playerWindow.setSize(w, h);
  }
});

// ---------- float mode: cluster window follows the panels ----------
// The renderer reports the on-screen bounding box of the visible webamp
// panels (zoom-adjusted). The main process keeps the transparent float
// window exactly wrapped around that cluster and persists its origin so
// panel layout survives restarts.
ipcMain.on("player:setCluster", (event, { x, y, width, height } = {}) => {
  if (!playerWindow || playerWindow.isDestroyed()) return;
  if (!isPlayerSender(event) || ![x, y, width, height].every(Number.isFinite)) return;
  // Size is capped to the UNION of all displays' work areas. The float
  // window legitimately spans displays while panels are dragged between
  // them — capping to the single nearest display (the old behavior)
  // re-introduced the invisible wall on multi-monitor setups.
  const all = screen.getAllDisplays().map((d) => d.workArea);
  const maxW = Math.max(...all.map((wa) => wa.width));
  const maxH = Math.max(...all.map((wa) => wa.height));
  const next = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.min(Math.max(40, Math.round(width)), maxW),
    height: Math.min(Math.max(40, Math.round(height)), maxH),
  };
  if (Number.isFinite(next.x) && Number.isFinite(next.y)) {
    try {
      playerWindow.setBounds(next);
      console.log(`[float] setBounds -> ${JSON.stringify(playerWindow.getBounds())}`);
    } catch (e) {
      console.log(`[float] setBounds THREW: ${e.message}`);
    }
  } else {
    console.log(`[float] non-finite coords ignored: ${JSON.stringify({ x, y })}`);
  }
  clusterSyncDebounced();
});

ipcMain.handle("player:getDisplays", (event) => isPlayerSender(event)
  ? screen.getAllDisplays().map((d) => ({ workArea: d.workArea }))
  : []);

// Eject-button / hotkey library toggle (same semantics as the menu item).
ipcMain.handle("library:toggle", (event) => isPlayerSender(event) ? toggleLibrary() : false);

// Debounced persistence of the cluster origin (not the full geometry —
// webamp owns panel-relative layout; we store only where the cluster
// sits on screen).
let clusterSyncTimer = null;
function clusterSyncDebounced() {
  clearTimeout(clusterSyncTimer);
  clusterSyncTimer = setTimeout(() => {
    if (!playerWindow || playerWindow.isDestroyed()) return;
    const b = playerWindow.getBounds();
    updateSession({ player: { cluster: { x: b.x, y: b.y, width: b.width, height: b.height } } });
  }, 400);
}

// ---------- click-through control (desktop mode) ----------
ipcMain.on("player:setIgnore", (event, ignore) => {
  if (isPlayerSender(event) && typeof ignore === "boolean") {
    playerWindow.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

function isPlayerSender(event) {
  return Boolean(playerWindow && !playerWindow.isDestroyed() && event.sender === playerWindow.webContents);
}

function isLibrarySender(event) {
  return Boolean(libraryWindow && !libraryWindow.isDestroyed() && event.sender === libraryWindow.webContents);
}

// ---------- session bridge ----------
ipcMain.handle("session:get", (event) => isPlayerSender(event) ? readSessionState() : null);

// ---------- webamp panel visibility <-> View menu ----------
ipcMain.on("panels:changed", (event, panels) => {
  if (!isPlayerSender(event)) return;
  if (panels && typeof panels === "object") {
    updateSession({ panels });
  }
  rebuildMenu();
});
ipcMain.on("panel:toggle", (e, id) => {
  if (!["playlist", "equalizer", "milkdrop"].includes(id)) return;
  const senderPanel = panelIdForSender(e.sender);
  // Native mode: panels are real windows — toggle the window itself.
  if (readSessionState().player.mode === "native") {
    if (!senderPanel || (senderPanel !== "main" && senderPanel !== id)) return;
    togglePanelWindow(id);
    return;
  }
  if (!playerWindow || playerWindow.isDestroyed() || e.sender !== playerWindow.webContents) return;
  sendToPlayer("panel:toggle", id);
});

// ---------- player mode toggle ----------
ipcMain.handle("player:getMode", (event) => isPlayerSender(event) ? readSessionState().player.mode : null);
ipcMain.handle("player:setMode", (event, mode) => {
  if (!isPlayerSender(event)) return readSessionState().player.mode;
  const normalized = mode === "windowed" ? "windowed" : mode === "float" || mode === "desktop" || mode === "native" ? "native" : null;
  if (!normalized) return readSessionState().player.mode;
  setPlayerModeAndRestart(normalized);
  return normalized;
});

// ---------- fractional scaling (zoom) ----------
ipcMain.handle("player:getZoom", (event) => {
  if (!isPlayerSender(event)) return null;
  if (playerWindow && !playerWindow.isDestroyed()) return playerWindow.webContents.getZoomFactor();
  return readSessionState().player.zoomFactor;
});
ipcMain.handle("player:setZoom", (event, factor) => {
  if (!isPlayerSender(event)) return readSessionState().player.zoomFactor;
  if (!Number.isFinite(factor) || factor < 0.75 || factor > 2) return readSessionState().player.zoomFactor;
  setPanelsZoom(factor);
  return factor;
});

ipcMain.handle("app:hasTray", () => Boolean(tray));

// ---------- Winamp-style context menu (right-click on the skin) ----------
// Same structure on every platform; pops up at the pointer. The renderer
// listens for contextmenu events over the webamp panels and asks for this.
ipcMain.handle("player:contextMenu", (event, { x, y } = {}) => {
  if (!isPlayerSender(event) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const saved = readSessionState();
  const item = (label, checked, click, extra = {}) =>
    ({ label, type: "checkbox", checked, click, ...extra });
  const sep = { type: "separator" };
  const context = Menu.buildFromTemplate([
    item("Playlist", panelIsOpen(saved, "playlist"), () => sendToPlayerOrToggle("playlist")),
    item("Equalizer", panelIsOpen(saved, "equalizer"), () => sendToPlayerOrToggle("equalizer")),
    item("Visualizer (MilkDrop)", panelIsOpen(saved, "milkdrop"), () => sendToPlayerOrToggle("milkdrop")),
    sep,
    item("Media Library", Boolean(saved.library.open), () => toggleLibrary()),
    item("Always on Top", Boolean(saved.player.alwaysOnTop), () => {
      const alwaysOnTop = Boolean(playerWindow && !playerWindow.isDestroyed() && !playerWindow.isAlwaysOnTop());
      setPanelsAlwaysOnTop(alwaysOnTop);
      rebuildMenu();
      rebuildTray();
    }),
    sep,
    {
      label: "Scale",
      submenu: [1, 1.15, 1.25, 1.5, 1.75, 2, 0.75].map((f) => ({
        label: f === 1 ? "100% (normal)" : `${Math.round(f * 100)}%`,
        type: "checkbox",
        checked: Math.abs(saved.player.zoomFactor - f) < 0.01,
        click: () => {
          setPanelsZoom(f);
          rebuildMenu();
          rebuildTray();
        },
      })),
    },
    {
      label: "Player Mode",
      submenu: [
        item("Native Panel Windows", saved.player.mode !== "windowed", () => setPlayerModeAndRestart("native")),
        item("Windowed Player", saved.player.mode === "windowed", () => setPlayerModeAndRestart("windowed")),
      ],
    },
    sep,
    {
      label: "Quit Plexamp Classic",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  context.popup({ window: playerWindow, x, y });
});

// ---------- env passthrough ----------
ipcMain.handle("env:section", () => ENV_SECTION || null);
ipcMain.handle("presets:hasLocalPack", () =>
  fs.existsSync(path.join(__dirname, "vendor", "presets-og-pack.mjs"))
);

// ---------- menu ----------
// View menu: checkbox "tiles" for every webamp panel + Media Library, with
// live checkmark state driven by the player's panel store and session state.
// On Linux the app menu bar never shows (frameless windows), so the same
// controls are exposed through a system tray menu.

function sendToPlayer(channel, ...args) {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send(channel, ...args);
  }
}

// Linux tray: a compact version of the View menu — panels, library,
// player mode, scale, always-on-top.
let tray = null;
function rebuildTray() {
  if (process.platform !== "linux") return;
  const saved = readSessionState();
  const item = (label, checked, click, extra = {}) => ({ label, type: "checkbox", checked, click, ...extra });
  const sep = { type: "separator" };
  const context = Menu.buildFromTemplate([
    item("Playlist", panelIsOpen(saved, "playlist"), () => sendToPlayerOrToggle("playlist")),
    item("Equalizer", panelIsOpen(saved, "equalizer"), () => sendToPlayerOrToggle("equalizer")),
    item("Visualizer (MilkDrop)", panelIsOpen(saved, "milkdrop"), () => sendToPlayerOrToggle("milkdrop")),
    sep,
    item("Media Library", Boolean(saved.library.open), () => toggleLibrary()),
    item("Always on Top", Boolean(saved.player.alwaysOnTop), () => {
      const alwaysOnTop = Boolean(playerWindow && !playerWindow.isDestroyed() && !playerWindow.isAlwaysOnTop());
      setPanelsAlwaysOnTop(alwaysOnTop);
      rebuildMenu();
      rebuildTray();
    }),
    sep,
    {
      label: "Scale",
      submenu: [1, 1.15, 1.25, 1.5, 1.75, 2, 0.75].map((f) => ({
        label: f === 1 ? "100% (normal)" : `${Math.round(f * 100)}%`,
        type: "checkbox",
        checked: Math.abs(saved.player.zoomFactor - f) < 0.01,
        click: () => {
          setPanelsZoom(f);
          rebuildMenu();
          rebuildTray();
        },
      })),
    },
    {
      label: "Player Mode",
      submenu: [
        item("Native Panel Windows", saved.player.mode === "native", () => setPlayerModeAndRestart("native")),
        item("Windowed Player", saved.player.mode === "windowed", () => setPlayerModeAndRestart("windowed")),
      ],
    },
    sep,
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  if (!tray) {
    // Tray icon candidates: the icon electron-builder places next to the
    // executable in packaged builds, the resources dir, or the repo's icon
    // set when running from source. If none exist, skip the tray rather
    // than crash — the frameless player still runs.
    const candidates = [
      path.join(path.dirname(process.execPath), "plexamp-classic.png"),
      app.isPackaged ? path.join(process.resourcesPath, "build", "icons", "512x512.png") : null,
      path.join(__dirname, "build", "icons", "512x512.png"),
    ].filter(Boolean);
    const iconPath = candidates.find((p) => fs.existsSync(p));
    if (!iconPath) {
      console.warn("tray: no icon found; skipping system tray");
      return;
    }
    tray = new Tray(iconPath);
    tray.setToolTip("Plexamp Classic");
  }
  tray.setContextMenu(context);
}

function rebuildMenu() {
  const saved = readSessionState();
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Main Player",
          type: "checkbox",
          checked: true,
          enabled: false, // the main player is the app's base surface
          click: () => {},
        },
        {
          label: "Playlist",
          type: "checkbox",
          checked: panelIsOpen(saved, "playlist"),
          click: () => sendToPlayerOrToggle("playlist"),
        },
        {
          label: "Equalizer",
          type: "checkbox",
          checked: panelIsOpen(saved, "equalizer"),
          click: () => sendToPlayerOrToggle("equalizer"),
        },
        {
          label: "Visualizer (MilkDrop)",
          type: "checkbox",
          checked: panelIsOpen(saved, "milkdrop"),
          click: () => sendToPlayerOrToggle("milkdrop"),
        },
        { type: "separator" },
        {
          label: "Media Library",
          type: "checkbox",
          checked: Boolean(libraryWindow && !libraryWindow.isDestroyed()),
          accelerator: "CmdOrCtrl+L",
          click: toggleLibrary,
        },
        { type: "separator" },
        {
          label: "Scale",
          submenu: [1, 1.15, 1.25, 1.5, 1.75, 2, 0.75].map((f) => ({
            label: f === 1 ? "100% (normal)" : `${Math.round(f * 100)}%`,
            type: "checkbox",
            checked: Math.abs(saved.player.zoomFactor - f) < 0.01,
            click: () => {
              setPanelsZoom(f);
              rebuildMenu();
            },
          })),
        },
        { type: "separator" },
        {
          label: "Native Panel Windows",
          type: "checkbox",
          checked: saved.player.mode !== "windowed",
          accelerator: "CmdOrCtrl+P",
          click: () => setPlayerModeAndRestart("native"),
        },
        {
          label: "Windowed Player",
          type: "checkbox",
          checked: saved.player.mode === "windowed",
          accelerator: "CmdOrCtrl+O",
          click: () => setPlayerModeAndRestart("windowed"),
        },
        { type: "separator" },
        {
          label: "Always on Top",
          type: "checkbox",
          checked: Boolean(playerWindow && !playerWindow.isDestroyed() && playerWindow.isAlwaysOnTop()),
          accelerator: "CmdOrCtrl+T",
          click: () => {
            const alwaysOnTop = Boolean(playerWindow && !playerWindow.isDestroyed() && !playerWindow.isAlwaysOnTop());
            setPanelsAlwaysOnTop(alwaysOnTop);
            rebuildMenu();
          },
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  rebuildTray();
}

const APP_PUBLIC_FILES = new Set([
  "player.html", "player.js", "library.html", "library.js", "search-tree.js",
  "butterchurn-loader.mjs", "playlist-window.html", "playlist-window.js",
  "equalizer-window.html", "equalizer-window.js", "visualizer-window.html",
  "visualizer-window.js", "vendor/webamp.bundle.min.js",
  "vendor/webamp.butterchurn-bundle.min.mjs", "vendor/presets-og-pack.mjs",
  "node_modules/butterchurn/lib/butterchurn.min.js",
  "node_modules/butterchurn-presets/lib/butterchurnPresets.min.js",
]);

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    const u = new URL(request.url);
    let rel;
    try {
      rel = decodeURIComponent(u.pathname);
    } catch {
      return new Response("invalid path", { status: 400 });
    }
    if (rel === "/") rel = "/player.html";
    // Resolve under the application root and reject traversal (including
    // encoded separators such as ..%2f). app:// serves code and must never
    // expose .env, auth state, or arbitrary local files.
    const root = path.resolve(__dirname);
    const appPath = rel.replace(/^\/+/, "");
    const filePath = path.resolve(root, appPath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      return new Response("forbidden", { status: 403 });
    }
    if (!APP_PUBLIC_FILES.has(appPath)) {
      return new Response("not found", { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".wsz": "application/octet-stream",
    }[ext] || "application/octet-stream";
    return net.fetch(pathToFileURL(filePath).toString(), {
      headers: { "Content-Type": mime },
    });
  });

  // app-stream://<key> — pipe audio bytes from the cached stream URL using
  // Node's TLS-tolerant http/https (federated servers = self-signed certs).
  const { plexFetchStream } = require("./auth");
  protocol.handle("app-stream", async (request) => {
    const raw = new URL(request.url);
    const key = raw.hostname || raw.pathname.slice(1);
    const entry = streamCache.get(key);
    if (!entry) return new Response("unknown stream key", { status: 404 });
    try {
      const range = request.headers.get("range") || undefined;
      const nodeRes = await plexFetchStream(entry.url, {
        headers: {
          "X-Plex-Token": entry.headers["X-Plex-Token"],
          ...(range ? { Range: range } : {}),
        },
        timeoutMs: 15000,
      });
      // Node http.IncomingMessage -> web ReadableStream
      const nodeStreamToWeb = (res) =>
        new ReadableStream({
          start(controller) {
            res.on("data", (c) => controller.enqueue(new Uint8Array(c)));
            res.on("end", () => controller.close());
            res.on("error", (e) => controller.error(e));
          },
          cancel() {
            res.destroy();
          },
        });
      const headers = {
        "Content-Type": nodeRes.headers["content-type"] || "audio/mpeg",
        "Accept-Ranges": nodeRes.headers["accept-ranges"] || "bytes",
      };
      if (nodeRes.headers["content-range"])
        headers["Content-Range"] = nodeRes.headers["content-range"];
      if (nodeRes.headers["content-length"])
        headers["Content-Length"] = nodeRes.headers["content-length"];
      return new Response(nodeStreamToWeb(nodeRes), {
        status: nodeRes.statusCode,
        headers,
      });
    } catch (e) {
      return new Response(`stream error: ${e.message}`, { status: 502 });
    }
  });

  // Strip Origin/Referer so the renderer can fetch Plex streams cross-origin.
  const strip = (details, cb) => {
    delete details.requestHeaders["Origin"];
    delete details.requestHeaders["Referer"];
    cb({ requestHeaders: details.requestHeaders });
  };
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    strip
  );

  rebuildMenu();
  const saved = readSessionState();
  createPlayerWindow();
  if (saved.library.open) createLibraryWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPlayerWindow();
      if (readSessionState().library.open) createLibraryWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    updateSession({ library: { open: true, bounds: libraryWindow.getBounds() } });
  }
  if (playerWindow && !playerWindow.isDestroyed()) {
    updateSession({ player: { zoomFactor: playerWindow.webContents.getZoomFactor() } });
    if (readSessionState().player.mode === "windowed") {
      updateSession({ player: { bounds: playerWindow.getBounds() } });
    }
  }
  if (readSessionState().player.mode === "native") {
    for (const [id, win] of nativeWindows) {
      if (!win.isDestroyed()) {
        updateSession({ panelsNative: { [id]: { open: true, bounds: win.getBounds() } } });
      }
    }
  }
});
app.on("window-all-closed", (event) => {
  if (isRestartingPlayer) {
    event.preventDefault();
    return;
  }
  app.quit();
});
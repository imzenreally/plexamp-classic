const { app, BrowserWindow, ipcMain, shell, session, protocol, net, globalShortcut, Menu, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const auth = require("./auth");
const { DEFAULT_SESSION, normalizeSession, repairedBounds } = require("./session-state");

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
    return mode === "windowed" ? "windowed" : "desktop";
  } catch {
    return "desktop";
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
    if (patch.player.mode === "desktop" || patch.player.mode === "windowed") next.player.mode = patch.player.mode;
    if (Number.isFinite(patch.player.zoomFactor)) next.player.zoomFactor = patch.player.zoomFactor;
    if (patch.player.bounds === null || typeof patch.player.bounds === "object") next.player.bounds = patch.player.bounds;
  }
  if (patch?.panels && typeof patch.panels === "object") {
    for (const key of Object.keys(next.panels)) {
      if (typeof patch.panels[key] === "boolean") next.panels[key] = patch.panels[key];
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
  const mode = saved.player.mode;
  if (mode === "desktop") {
    const wa = screen.getPrimaryDisplay().workArea;
    playerWindow = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: wa.width,
      height: wa.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      backgroundColor: "#00000000",
      alwaysOnTop: false,
      skipTaskbar: true,
      title: "Winamp Classic",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    playerWindow.setIgnoreMouseEvents(true, { forward: true });
    playerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    playerWindow.loadURL("app://winamp/player.html?mode=desktop");
  } else {
    const workArea = screen.getPrimaryDisplay().workArea;
    const restored = saved.player.bounds ? repairedBounds(saved.player.bounds, workArea) : null;
    playerWindow = new BrowserWindow({
      ...(restored || { width: 740, height: 480 }),
      frame: false,
      hasShadow: true,
      resizable: true,
      movable: true,
      backgroundColor: "#1e1e24",
      alwaysOnTop: false,
      title: "Winamp Classic",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    attachBoundsTracking(playerWindow, "player");
    playerWindow.loadURL("app://winamp/player.html?mode=windowed");
  }
  playerWindow.webContents.once("did-finish-load", () => {
    const zoom = readSessionState().player.zoomFactor;
    if (zoom !== 1) playerWindow?.webContents.setZoomFactor(zoom);
  });
}

function createLibraryWindow() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.show();
    libraryWindow.focus();
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
  attachBoundsTracking(libraryWindow, "library");
  libraryWindow.loadURL("app://winamp/library.html");
  libraryWindow.once("ready-to-show", () => libraryWindow.show());
  libraryWindow.on("closed", () => {
    if (!isQuitting) updateSession({ library: { open: false } });
    libraryWindow = null;
  });
}

function toggleLibrary() {
  if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.close();
  else createLibraryWindow();
}

function setPlayerModeAndRestart(mode) {
  updateSession({ player: { mode } });
  writePlayerMode(mode); // retain compatibility with existing installations.
  const oldPlayer = playerWindow;
  isRestartingPlayer = true;
  try {
    createPlayerWindow();
    if (oldPlayer && !oldPlayer.isDestroyed()) oldPlayer.destroy();
  } finally {
    isRestartingPlayer = false;
  }
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
  const d = await plex(server, `/library/metadata/${ratingKey}/children`);
  return (d.MediaContainer.Metadata || []).map((x) => ({
    title: x.title,
    year: x.year || "",
    ratingKey: x.ratingKey,
  }));
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
ipcMain.on("media:register", () => {
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
ipcMain.on("media:unregister", () => globalShortcut.unregisterAll());

// ---------- library -> player relay ----------
ipcMain.on("library:enqueue", (_e, tracks) => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.send("player:enqueue", tracks);
  }
});

// ---------- player window: size to winamp cluster (windowed mode) ----------
ipcMain.on("player:setBounds", (_e, { width, height }) => {
  if (!playerWindow || playerWindow.isDestroyed()) return;
  const cur = playerWindow.getBounds();
  const w = Math.min(Math.round(width) + 16, 1400);
  const h = Math.min(Math.round(height) + 16, 1200);
  if (Math.abs(cur.width - w) > 2 || Math.abs(cur.height - h) > 2) {
    playerWindow.setSize(w, h);
  }
});

// ---------- click-through control (desktop mode) ----------
ipcMain.on("player:setIgnore", (_e, ignore) => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// ---------- session bridge ----------
ipcMain.handle("session:get", () => readSessionState());
ipcMain.handle("session:update", (_e, patch) => updateSession(patch));

// ---------- player mode toggle ----------
ipcMain.handle("player:getMode", () => readSessionState().player.mode);
ipcMain.handle("player:setMode", (_e, mode) => {
  if (mode !== "desktop" && mode !== "windowed") return readSessionState().player.mode;
  setPlayerModeAndRestart(mode);
  return mode;
});

// ---------- fractional scaling (zoom) ----------
ipcMain.handle("player:getZoom", () => {
  if (playerWindow && !playerWindow.isDestroyed()) return playerWindow.webContents.getZoomFactor();
  return readSessionState().player.zoomFactor;
});
ipcMain.handle("player:setZoom", (_e, factor) => {
  if (!Number.isFinite(factor) || factor < 0.75 || factor > 2) return readSessionState().player.zoomFactor;
  updateSession({ player: { zoomFactor: factor } });
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.webContents.setZoomFactor(factor);
  return factor;
});

// ---------- env passthrough ----------
ipcMain.handle("env:section", () => ENV_SECTION || null);
ipcMain.handle("presets:hasLocalPack", () =>
  fs.existsSync(path.join(__dirname, "vendor", "presets-og-pack.mjs"))
);

// ---------- menu ----------
const template = [
  { role: "appMenu" },
  { role: "editMenu" },
  {
    label: "View",
    submenu: [
      { label: "Toggle Media Library", accelerator: "CmdOrCtrl+L", click: toggleLibrary },
      { type: "separator" },
      {
        label: "Scale",
        submenu: [1, 1.15, 1.25, 1.5, 1.75, 2, 0.75].map((f) => ({
          label: f === 1 ? "100% (normal)" : `${Math.round(f * 100)}%`,
          click: () => {
            updateSession({ player: { zoomFactor: f } });
            playerWindow?.webContents.setZoomFactor(f);
          },
        })),
      },
      { type: "separator" },
      {
        label: "Desktop Panels",
        accelerator: "CmdOrCtrl+P",
        click: () => setPlayerModeAndRestart("desktop"),
      },
      {
        label: "Windowed Player",
        accelerator: "CmdOrCtrl+O",
        click: () => setPlayerModeAndRestart("windowed"),
      },
      { type: "separator" },
      {
        label: "Always on Top",
        accelerator: "CmdOrCtrl+T",
        click: () => playerWindow?.setAlwaysOnTop(!playerWindow.isAlwaysOnTop()),
      },
    ],
  },
  { role: "windowMenu" },
];

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    const u = new URL(request.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === "/") rel = "/player.html";
    const filePath = path.join(__dirname, rel);
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
});
app.on("window-all-closed", (event) => {
  if (isRestartingPlayer) {
    event.preventDefault();
    return;
  }
  app.quit();
});
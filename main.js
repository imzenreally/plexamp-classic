const { app, BrowserWindow, ipcMain, shell, session, protocol, net, globalShortcut, Menu, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const auth = require("./auth");

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

// ---------- player mode (desktop panels vs windowed) ----------
function playerModePath() {
  return path.join(app.getPath("userData"), "player-mode.json");
}
function readPlayerMode() {
  try {
    return JSON.parse(fs.readFileSync(playerModePath(), "utf8")).mode || "desktop";
  } catch {
    return "desktop";
  }
}
function writePlayerMode(mode) {
  fs.mkdirSync(path.dirname(playerModePath()), { recursive: true });
  fs.writeFileSync(playerModePath(), JSON.stringify({ mode }));
}

// ---------- windows ----------
function createPlayerWindow() {
  const mode = readPlayerMode(); // 'desktop' | 'windowed'
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
    // Desktop-panels: click-through everywhere except the winamp cluster.
    // The renderer toggles this as the pointer enters/leaves panel rects.
    playerWindow.setIgnoreMouseEvents(true, { forward: true });
    // Panels visible on every Space (widget-like); toggle with ⌘T for on-top.
    playerWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: false,
    });
    playerWindow.loadURL("app://winamp/player.html?mode=desktop");
  } else {
    playerWindow = new BrowserWindow({
      width: 740,
      height: 480,
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
    playerWindow.loadURL("app://winamp/player.html?mode=windowed");
  }
}

function createLibraryWindow() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.show();
    libraryWindow.focus();
    return;
  }
  libraryWindow = new BrowserWindow({
    width: 1100,
    height: 720,
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
  libraryWindow.loadURL("app://winamp/library.html");
  libraryWindow.once("ready-to-show", () => libraryWindow.show());
  libraryWindow.on("closed", () => {
    libraryWindow = null;
  });
}

function toggleLibrary() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.close();
  } else {
    createLibraryWindow();
  }
}

function setPlayerModeAndRestart(mode) {
  writePlayerMode(mode);
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy();
  createPlayerWindow();
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

// ---------- stream proxy ----------
// Renderer <audio> can't accept federated servers' self-signed TLS. So the
// renderer requests streams via app-stream://<key> and the main process
// fetches the real URL (TLS-tolerant) and pipes the bytes back.
const streamCache = new Map(); // key -> { url, headers }

ipcMain.handle("plex:tracks", async (_e, server, ratingKey) => {
  const d = await plex(server, `/library/metadata/${ratingKey}/children`);
  return (d.MediaContainer.Metadata || []).map((x) => {
    const part = x.Media?.[0]?.Part?.[0];
    let url = null;
    if (part) {
      const key = Math.random().toString(36).slice(2);
      streamCache.set(key, {
        url: `${server.baseUrl}${part.key}`,
        headers: { "X-Plex-Token": server.token },
      });
      url = `app-stream://${key}`;
    }
    return {
      title: x.title,
      artist: x.grandparentTitle || x.parentTitle || "",
      album: x.parentTitle || "",
      duration: x.duration ? Math.round(x.duration / 1000) : 0,
      url,
    };
  }).filter((t) => t.url);
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

// ---------- player mode toggle ----------
ipcMain.handle("player:getMode", () => readPlayerMode());
ipcMain.handle("player:setMode", (_e, mode) => {
  writePlayerMode(mode);
  // relaunch player window in the new mode
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy();
  createPlayerWindow();
});

// ---------- fractional scaling (zoom) ----------
ipcMain.handle("player:getZoom", () => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    return playerWindow.webContents.getZoomFactor();
  }
  return 1;
});
ipcMain.handle("player:setZoom", (_e, factor) => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.setZoomFactor(factor);
  }
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
          click: () => playerWindow?.webContents.setZoomFactor(f),
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
  createPlayerWindow();
  createLibraryWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPlayerWindow();
      createLibraryWindow();
    }
  });
});

app.on("window-all-closed", () => app.quit());
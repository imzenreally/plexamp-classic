const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("plex", {
  // platform (renderer has no `process` under contextIsolation)
  platform: process.platform,
  // auth
  authStatus: () => ipcRenderer.invoke("auth:status"),
  beginLogin: () => ipcRenderer.invoke("auth:beginLogin"),
  poll: (pinId) => ipcRenderer.invoke("auth:poll", pinId),
  logout: () => ipcRenderer.invoke("auth:logout"),
  // servers
  servers: () => ipcRenderer.invoke("plex:servers"),
  selectServer: (ref) => ipcRenderer.invoke("plex:selectServer", ref),
  // browsing (server context per call)
  sections: (server) => ipcRenderer.invoke("plex:sections", server),
  artists: (server, sectionKey) => ipcRenderer.invoke("plex:artists", server, sectionKey),
  albums: (server, ratingKey) => ipcRenderer.invoke("plex:albums", server, ratingKey),
  relatedReleases: (server, ratingKey) => ipcRenderer.invoke("plex:relatedReleases", server, ratingKey),
  search: (server, sectionKey, query) => ipcRenderer.invoke("plex:search", server, sectionKey, query),
  tracks: (server, ratingKey) => ipcRenderer.invoke("plex:tracks", server, ratingKey),
  track: (server, ratingKey) => ipcRenderer.invoke("plex:track", server, ratingKey),
  // media keys (player window)
  registerMediaKeys: () => ipcRenderer.send("media:register", { play: true, pause: true, toggle: true }),
  onMediaKey: (cb) => ipcRenderer.on("media", (_e, action) => cb(action)),
  // library -> player enqueue
  enqueueTracks: (tracks) => ipcRenderer.send("library:enqueue", tracks),
  // player -> library toggle (eject button / hotkey)
  toggleLibrary: () => ipcRenderer.invoke("library:toggle"),
  // native panel windows: state bridge + window ops
  panelGetState: (slice) => ipcRenderer.invoke("panel:getState", slice),
  panelAction: (action) => ipcRenderer.send("panel:action", action),
  panelBroadcast: (state) => ipcRenderer.send("panel:broadcast", state),
  onPanelState: (cb) => ipcRenderer.on("panel:state", (_e, state) => cb(state)),
  onPanelQuery: (cb) => ipcRenderer.on("panel:queryState", (_e, q) => cb(q)),
  onPanelForward: (cb) => ipcRenderer.on("panel:forward", (_e, action) => cb(action)),
  panelReply: (reply) => ipcRenderer.send("panel:stateReply", reply),
  panelToggle: (id) => ipcRenderer.send("panel:toggle", id),
  togglePanelWindow: (id) => ipcRenderer.send("panel:toggle", id),
  // viz FFT stream: leader -> main -> visualizer window
  vizData: (data) => ipcRenderer.send("panel:vizData", data),
  onVizData: (cb) => ipcRenderer.on("panel:vizData", (_e, data) => cb(data)),
  onEnqueue: (cb) => ipcRenderer.on("player:enqueue", (_e, tracks) => cb(tracks)),
  // webamp panel visibility -> menu checkmarks (player -> main)
  sendPanelsChanged: (panels) => ipcRenderer.send("panels:changed", panels),
  // menu clicks -> player (main -> player)
  onPanelToggle: (cb) => ipcRenderer.on("panel:toggle", (_e, id) => cb(id)),
  // window sizing (player window, windowed mode)
  setWindowBounds: (bounds) => ipcRenderer.send("player:setBounds", bounds),
  // float mode: cluster bounding box (screen coords, zoom-adjusted)
  setCluster: (cluster) => ipcRenderer.send("player:setCluster", cluster),
  // all displays' work areas, for multi-monitor union clamping
  getDisplays: () => ipcRenderer.invoke("player:getDisplays"),
  // Winamp-style right-click menu
  openContextMenu: (x, y) => ipcRenderer.invoke("player:contextMenu", { x, y }),
  // click-through control (player window, desktop mode)
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send("player:setIgnore", ignore),
  // fractional scaling
  getZoom: () => ipcRenderer.invoke("player:getZoom"),
  setZoom: (factor) => ipcRenderer.invoke("player:setZoom", factor),
  // mode
  getMode: () => ipcRenderer.invoke("player:getMode"),
  setMode: (mode) => ipcRenderer.invoke("player:setMode", mode),
  // read-only session state (main player only; main process authenticates sender)
  getSession: () => ipcRenderer.invoke("session:get"),
  // linux tray presence (used by tests)
  hasTray: () => ipcRenderer.invoke("app:hasTray"),
  // env passthrough
  getEnvSection: () => ipcRenderer.invoke("env:section"),
  hasLocalPresetPack: () => ipcRenderer.invoke("presets:hasLocalPack"),
});
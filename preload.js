const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("plex", {
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
  search: (server, sectionKey, query) => ipcRenderer.invoke("plex:search", server, sectionKey, query),
  tracks: (server, ratingKey) => ipcRenderer.invoke("plex:tracks", server, ratingKey),
  track: (server, ratingKey) => ipcRenderer.invoke("plex:track", server, ratingKey),
  // media keys (player window)
  registerMediaKeys: () => ipcRenderer.send("media:register", { play: true, pause: true, toggle: true }),
  onMediaKey: (cb) => ipcRenderer.on("media", (_e, action) => cb(action)),
  // library -> player enqueue
  enqueueTracks: (tracks) => ipcRenderer.send("library:enqueue", tracks),
  onEnqueue: (cb) => ipcRenderer.on("player:enqueue", (_e, tracks) => cb(tracks)),
  // window sizing (player window, windowed mode)
  setWindowBounds: (bounds) => ipcRenderer.send("player:setBounds", bounds),
  // click-through control (player window, desktop mode)
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send("player:setIgnore", ignore),
  // fractional scaling
  getZoom: () => ipcRenderer.invoke("player:getZoom"),
  setZoom: (factor) => ipcRenderer.invoke("player:setZoom", factor),
  // mode
  getMode: () => ipcRenderer.invoke("player:getMode"),
  setMode: (mode) => ipcRenderer.invoke("player:setMode", mode),
  // env passthrough
  getEnvSection: () => ipcRenderer.invoke("env:section"),
  hasLocalPresetPack: () => ipcRenderer.invoke("presets:hasLocalPack"),
});
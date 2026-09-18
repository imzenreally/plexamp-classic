/* playlist-window.js — native-mode satellite: Winamp-styled playlist.
 * State lives in the leader's webamp store; this window reads it via
 * panel:getState and writes via panel:action (store actions). The leader
 * pushes broadcast updates on every store change.
 */
(() => {
  let state = { tracks: {}, trackOrder: [], currentTrack: null, selected: new Set(), status: "STOPPED" };
  const listEl = document.getElementById("list");
  const countEl = document.getElementById("count");

  // ---------- state in ----------
  async function pull() {
    const s = await window.plex.panelGetState("playlist");
    if (s) {
      state.tracks = s.tracks || {};
      state.trackOrder = s.trackOrder || [];
      state.currentTrack = s.currentTrack;
      state.selected = new Set(s.selectedTracks || []);
      state.status = s.status;
      render();
    }
  }
  window.plex.onPanelState((s) => {
    if (!s || !s.playlist) return;
    state.tracks = s.tracks || {};
    state.trackOrder = s.playlist.trackOrder || [];
    state.currentTrack = s.playlist.currentTrack;
    state.selected = new Set(s.playlist.selectedTracks || []);
    state.status = s.media ? s.media.status : state.status;
    render();
  });

  // ---------- render ----------
  function fmt(t) {
    if (t == null || !Number.isFinite(t)) return "";
    const m = Math.floor(t / 60);
    const sec = Math.round(t % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  function render() {
    listEl.textContent = "";
    let shown = 0;
    state.trackOrder.forEach((id, i) => {
      const tr = state.tracks[id];
      if (!tr) return; // deduped/shared ids may have gaps; skip gracefully
      shown++;
      const row = document.createElement("div");
      row.className = "row" + (state.selected.has(id) ? " selected" : "") + (id === state.currentTrack ? " playing" : "");
      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = String(i + 1).padStart(2, "0") + ".";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${tr.artist || "Unknown"} - ${tr.title || "Unknown"}`;
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = fmt(tr.duration);
      row.append(idx, name, time);
      row.dataset.id = id;
      listEl.appendChild(row);
    });
    countEl.textContent = `${shown} item${shown === 1 ? "" : "s"}`;
  }

  // ---------- interaction ----------
  function trackIdForRow(row) {
    return state.trackOrder.find((id) => String(id) === row.dataset.id);
  }

  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const id = trackIdForRow(row);
    if (id == null) return;
    const index = state.trackOrder.indexOf(id);
    if (e.shiftKey) {
      window.plex.panelAction({ type: "SHIFT_CLICKED_TRACK", index });
    } else if (e.metaKey || e.ctrlKey) {
      window.plex.panelAction({ type: "CTRL_CLICKED_TRACK", index });
    } else {
      window.plex.panelAction({ type: "CLICKED_TRACK", index });
    }
  });

  listEl.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const id = trackIdForRow(row);
    if (id == null) return;
    window.plex.panelAction({ type: state.status === "STOPPED" ? "BUFFER_TRACK" : "PLAY_TRACK", id });
  });

  document.getElementById("btn-remove").addEventListener("click", () => {
    if (!state.selected.size) return;
    window.plex.panelAction({ type: "REMOVE_TRACKS", ids: [...state.selected] });
    state.selected.clear();
  });
  document.getElementById("btn-clear").addEventListener("click", () => {
    window.plex.panelAction({ type: "STOP" });
    window.plex.panelAction({ type: "REMOVE_ALL_TRACKS" });
    state.selected.clear();
  });
  document.getElementById("btn-play").addEventListener("click", () => {
    const first = [...state.selected][0] ?? state.currentTrack ?? state.trackOrder[0];
    if (first != null) window.plex.panelAction({ type: state.status === "STOPPED" ? "BUFFER_TRACK" : "PLAY_TRACK", id: first });
  });

  // drag reorder: HTML5-free — simple mousedown-drag with insertion line
  let dragId = null;
  listEl.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".row");
    if (!row || e.button !== 0) return;
    dragId = trackIdForRow(row);
  });
  listEl.addEventListener("mousemove", (e) => {
    if (dragId == null) return;
    const rows = [...listEl.querySelectorAll(".row")];
    rows.forEach((r) => r.classList.remove("drop-before"));
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".row");
    if (target && trackIdForRow(target) !== dragId) target.classList.add("drop-before");
  });
  listEl.addEventListener("mouseup", (e) => {
    if (dragId == null) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".row");
    const targetId = target ? trackIdForRow(target) : null;
    if (targetId != null && targetId !== dragId) {
      const ids = [...state.trackOrder];
      const from = ids.indexOf(dragId);
      ids.splice(from, 1);
      const to = ids.indexOf(targetId);
      ids.splice(to, 0, dragId);
      window.plex.panelAction({ type: "SET_TRACK_ORDER", trackOrder: ids });
    }
    dragId = null;
    listEl.querySelectorAll(".row").forEach((r) => r.classList.remove("drop-before"));
  });

  // window chrome
  document.querySelector(".sys-btn.close").addEventListener("click", () => window.plex.panelToggle("playlist"));
  document.querySelector(".sys-btn.shade").addEventListener("click", () => window.plex.panelToggle("playlist"));

  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "Delete") document.getElementById("btn-remove").click();
  });

  pull();
  const poll = setInterval(pull, 2000); // fallback if broadcasts stop
  window.addEventListener("beforeunload", () => clearInterval(poll));
})();
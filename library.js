/* Media Library: Plex browsing + compact, race-safe multi-entity search. */
let server = null;
let currentSection = null;
let allArtists = [];
let activeArtist = null;
let searchTimer = null;
let searchGeneration = 0;

const $ = (id) => document.getElementById(id);
const setStatus = (text) => { $("status").textContent = text; };
const fold = (value) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[‘’]/g, "'")
  .toLowerCase();
const duration = (seconds) => {
  const n = Number(seconds) || 0;
  return n ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}` : "";
};

async function boot() {
  const status = await window.plex.authStatus();
  renderLoginBar(status);
  const servers = await window.plex.servers();
  const envDefault = servers.find((s) => s.source === "env" || s.source === "env+account");
  if (envDefault) {
    await selectServer(envDefault);
  } else {
    renderServerList(servers, status);
  }
}

function renderLoginBar(status) {
  const bar = $("loginbar");
  bar.innerHTML = "";
  const who = document.createElement("span");
  if (status.logged) {
    who.textContent = status.user.name;
    bar.appendChild(who);
    const out = document.createElement("button");
    out.textContent = "Log out";
    out.onclick = async () => { await window.plex.logout(); location.reload(); };
    bar.appendChild(out);
  } else {
    who.textContent = "Log in with Plex for shared servers";
    bar.appendChild(who);
    const login = document.createElement("button");
    login.textContent = "Log in";
    login.onclick = beginLogin;
    bar.appendChild(login);
  }
}

async function beginLogin() {
  const { pinId, code } = await window.plex.beginLogin();
  $("loginbar").querySelector("span").textContent = `Approve Plex login: ${code}`;
  const timer = setInterval(async () => {
    const result = await window.plex.poll(pinId);
    if (result.ok) { clearInterval(timer); location.reload(); }
  }, 1500);
}

function renderServerList(servers) {
  const box = $("servers");
  box.innerHTML = "";
  if (!servers.length) {
    box.innerHTML = `<div class="empty">No Plex servers found. Log in with Plex to discover owned and shared servers.</div>`;
    return;
  }
  for (const item of servers) {
    const card = document.createElement("button");
    card.className = "servercard chrome";
    const title = item.source === "env" || item.source === "env+account"
      ? item.name
      : `${item.name} ${item.owned ? "(owned)" : "(shared)"}`;
    card.innerHTML = `<div class="t"></div><div class="y"></div>`;
    card.querySelector(".t").textContent = title;
    card.querySelector(".y").textContent = item.source === "env" || item.source === "env+account"
      ? "LAN default" : "Plex account connection";
    card.onclick = () => selectServer(item);
    box.appendChild(card);
  }
}

async function changeServer() {
  searchGeneration += 1;
  $("library").style.display = "none";
  $("changeserver").style.display = "none";
  const servers = await window.plex.servers();
  renderServerList(servers);
  $("servers").style.display = "flex";
}

async function selectServer(item) {
  $("servers").innerHTML = `<div class="empty">Connecting to ${item.name}…</div>`;
  try {
    const result = await window.plex.selectServer(
      item.source === "env" || item.source === "env+account"
        ? { source: "env" }
        : { source: "account", name: item.name, token: item.token, resource: item.resource }
    );
    server = result.server;
    const select = $("server");
    select.innerHTML = "";
    for (const section of result.sections) {
      const option = document.createElement("option");
      option.value = section.key;
      option.textContent = `${item.name} — ${section.title}`;
      select.appendChild(option);
    }
    $("servers").style.display = "none";
    $("library").style.display = "flex";
    $("changeserver").style.display = "inline-block";
    select.style.display = "inline-block";
    const preferredKey = await window.plex.getEnvSection?.();
    const preferred = result.sections.find((x) => x.key === preferredKey) || result.sections[0];
    if (!preferred) throw new Error("No music libraries are available on this server");
    select.value = preferred.key;
    await loadArtists(preferred.key);
    setStatus(`CONNECTED · ${item.name} · select an artist or search the music library`);
  } catch (error) {
    $("servers").innerHTML = `<div class="empty">Connection failed: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadArtists(sectionKey) {
  const generation = ++searchGeneration;
  currentSection = sectionKey;
  activeArtist = null;
  $("view-title").textContent = "BROWSE ARTISTS";
  $("view-meta").textContent = "Loading artist index…";
  $("artists").innerHTML = `<div class="hint">Loading artists…</div>`;
  $("content").innerHTML = `<div class="empty">Select an artist or search Plex music.</div>`;
  try {
    const artists = await window.plex.artists(server, sectionKey);
    if (generation !== searchGeneration) return;
    allArtists = artists.sort((a, b) => a.title.localeCompare(b.title));
    renderArtists($("search").value);
    $("view-meta").textContent = `${allArtists.length.toLocaleString()} artists`;
    setStatus(`ARTIST INDEX READY · ${allArtists.length.toLocaleString()} artists · Cmd+F to search`);
  } catch (error) {
    if (generation !== searchGeneration) return;
    $("artists").innerHTML = `<div class="hint">Could not load artists.</div>`;
    setStatus(`ARTIST INDEX ERROR · ${error.message}`);
  }
}

function renderArtists(filter = "") {
  const query = fold(filter.trim());
  const matches = query ? allArtists.filter((artist) => fold(artist.title).includes(query)) : allArtists;
  const visible = matches.slice(0, 250);
  const box = $("artists");
  box.innerHTML = "";
  for (const artist of visible) {
    const button = document.createElement("button");
    button.className = `artist${activeArtist === artist.ratingKey ? " active" : ""}`;
    button.textContent = artist.title;
    button.title = artist.title;
    button.dataset.nav = "artist";
    button.onclick = () => selectArtist(artist);
    box.appendChild(button);
  }
  if (!visible.length) box.innerHTML = `<div class="hint">No artists match this filter.</div>`;
  if (matches.length > visible.length) {
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = `Showing first ${visible.length} of ${matches.length}. Refine the search.`;
    box.appendChild(note);
  }
}

async function selectArtist(artist) {
  activeArtist = artist.ratingKey;
  renderArtists($("search").value);
  $("view-title").textContent = "ARTIST DISCOGRAPHY";
  $("view-meta").textContent = artist.title;
  $("content").innerHTML = `<div class="empty">Loading albums for ${escapeHtml(artist.title)}…</div>`;
  setStatus(`LOADING ARTIST · ${artist.title}`);
  try {
    const albums = await window.plex.albums(server, artist.ratingKey);
    renderAlbums(albums, artist.title);
    setStatus(`ARTIST READY · ${artist.title} · ${albums.length} album${albums.length === 1 ? "" : "s"}`);
  } catch (error) {
    $("content").innerHTML = `<div class="empty">Could not load albums for ${escapeHtml(artist.title)}.</div>`;
    setStatus(`ARTIST ERROR · ${error.message}`);
  }
}

function renderAlbums(albums, artistName) {
  const content = $("content");
  content.innerHTML = "";
  if (!albums.length) {
    content.innerHTML = `<div class="empty">No albums found for ${escapeHtml(artistName)}.</div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "album-grid";
  for (const album of albums) grid.appendChild(makeEntry(album, "album", () => queueAlbum(album)));
  content.appendChild(grid);
}

function makeEntry(item, type, activate) {
  const button = document.createElement("button");
  button.className = `entry ${type}`;
  button.dataset.kind = type.toUpperCase();
  button.dataset.nav = type;
  button.title = [item.title, item.artist, item.album].filter(Boolean).join(" — ");
  const sub = type === "artist" ? "Open discography"
    : type === "album" ? [item.artist, item.year].filter(Boolean).join(" · ") || "Play album"
    : [item.artist, item.album, duration(item.duration)].filter(Boolean).join(" · ");
  button.innerHTML = `<span class="entry-title"></span><span class="entry-sub"></span>`;
  button.querySelector(".entry-title").textContent = item.title;
  button.querySelector(".entry-sub").textContent = sub;
  button.onclick = activate;
  return button;
}

let searchTree = [];
let expandedTreeNodes = new Set();

function treeNodeById(id, nodes = searchTree) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (Array.isArray(node.children)) {
      const found = treeNodeById(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

function treeParentId(id, nodes = searchTree, parentId = null) {
  for (const node of nodes) {
    if (node.id === id) return parentId;
    if (Array.isArray(node.children)) {
      const found = treeParentId(id, node.children, node.id);
      if (found !== null) return found;
    }
  }
  return null;
}

function treeMeta(node) {
  if (node.kind === "artist") return node.loading ? "Loading discography…" : "Artist · expand for discography";
  if (node.kind === "other") return `${node.children.length} global match${node.children.length === 1 ? "" : "es"}`;
  if (node.kind === "category") return `${node.children.length} release${node.children.length === 1 ? "" : "s"}`;
  if (node.kind === "album") return [node.item.artist, node.item.year].filter(Boolean).join(" · ") || "Queue full album";
  return [node.item.artist, node.item.album, duration(node.item.duration)].filter(Boolean).join(" · ");
}

function renderSearchTree(focusId = null) {
  const content = $("content");
  content.innerHTML = "";
  const tree = document.createElement("div");
  tree.className = "search-tree";
  const rows = window.SearchTree.visibleRows(searchTree, expandedTreeNodes);
  for (const { node, depth } of rows) {
    const branch = node.kind === "artist" || node.kind === "other" || node.kind === "category";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `tree-row tree-${node.kind}${depth === 0 && node.kind === "artist" ? " tree-root" : ""}`;
    row.dataset.nav = "tree";
    row.dataset.treeId = node.id;
    row.style.paddingLeft = `${8 + depth * 20}px`;
    row.title = node.title;
    const twist = document.createElement("span");
    twist.className = "tree-twist";
    twist.textContent = branch ? (expandedTreeNodes.has(node.id) ? "▾" : "▸") : "•";
    const main = document.createElement("span");
    main.className = "tree-main";
    const title = document.createElement("span");
    title.className = "tree-title";
    title.textContent = node.title;
    const meta = document.createElement("span");
    meta.className = "tree-meta";
    meta.textContent = treeMeta(node);
    main.append(title, meta);
    row.append(twist, main);
    row.onclick = () => activateTreeNode(node, row);
    tree.appendChild(row);
  }
  content.appendChild(tree);
  const guide = document.createElement("div");
  guide.className = "search-guide inset";
  guide.innerHTML = "<b>TREE CONTROLS</b><span>↑↓ SELECT</span><span>←→ COLLAPSE / EXPAND</span><span>ENTER PLAY / OPEN</span><span>ARTIST: DIRECT PLEX DISCOGRAPHY</span>";
  content.appendChild(guide);
  if (focusId) content.querySelector(`[data-tree-id="${CSS.escape(focusId)}"]`)?.focus();
}

async function activateTreeNode(node, row) {
  if (node.kind === "album") return queueAlbum(node.item);
  if (node.kind === "track") return queueTrack(node.item);
  if (window.SearchTree.isDiscographyLoading(node)) return;
  if (window.SearchTree.shouldLoadDiscography(node)) {
    node.loading = true;
    renderSearchTree(node.id);
    const treeAtStart = searchTree;
    try {
      const [albums, relatedGroups] = await Promise.all([
        window.plex.albums(server, node.item.ratingKey),
        window.plex.relatedReleases(server, node.item.ratingKey),
      ]);
      if (treeAtStart !== searchTree || $("search").value.trim() === "") return;
      node.children = window.SearchTree.mergeDiscography(albums, relatedGroups);
      node.loading = false;
      expandedTreeNodes = window.SearchTree.toggleExpanded(expandedTreeNodes, node.id);
      const releaseCount = node.children.reduce((count, group) => count + group.children.length, 0);
      setStatus(`ARTIST READY · ${node.title} · ${releaseCount} Plex release${releaseCount === 1 ? "" : "s"}`);
    } catch (error) {
      node.children = [];
      node.loading = false;
      setStatus(`ARTIST ERROR · ${node.title} · ${error.message}`);
    }
    renderSearchTree(node.id);
    return;
  }
  expandedTreeNodes = window.SearchTree.toggleExpanded(expandedTreeNodes, node.id);
  renderSearchTree(node.id);
}

function renderSearchResults(results, query) {
  const total = results.artists.length + results.albums.length + results.tracks.length;
  $("view-title").textContent = "ARTIST-FIRST SEARCH";
  $("view-meta").textContent = total ? `“${query}” · ${total} global match${total === 1 ? "" : "es"}` : `“${query}”`;
  if (!total) {
    $("content").innerHTML = `<div class="empty">No artists, albums, or tracks found for “${escapeHtml(query)}”.</div>`;
    return;
  }
  searchTree = window.SearchTree.buildSearchTree(results);
  expandedTreeNodes = new Set(searchTree.filter((node) => node.kind === "other").map((node) => node.id));
  renderSearchTree();
}

async function queueAlbum(album) {
  setStatus(`READING ALBUM · ${album.title}`);
  try {
    const tracks = await window.plex.tracks(server, album.ratingKey);
    if (!tracks.length) throw new Error("Plex did not return playable tracks");
    window.plex.enqueueTracks(tracks);
    const minutes = Math.round(tracks.reduce((sum, track) => sum + track.duration, 0) / 60);
    setStatus(`PLAYING ALBUM · ${album.title} · ${tracks.length} tracks · ${minutes} min → WINAMP`);
  } catch (error) {
    setStatus(`ALBUM ERROR · ${album.title} · ${error.message}`);
  }
}

async function queueTrack(track) {
  setStatus(`READING TRACK · ${track.title}`);
  try {
    const tracks = await window.plex.track(server, track.ratingKey);
    if (!tracks.length) throw new Error("Plex did not return a playable track");
    window.plex.enqueueTracks(tracks);
    setStatus(`PLAYING TRACK · ${track.title}${track.artist ? ` · ${track.artist}` : ""} → WINAMP`);
  } catch (error) {
    setStatus(`TRACK ERROR · ${track.title} · ${error.message}`);
  }
}

function scheduleSearch() {
  const raw = $("search").value;
  renderArtists(raw);
  clearTimeout(searchTimer);
  const generation = ++searchGeneration;
  const query = raw.trim();
  if (!query) {
    $("view-title").textContent = activeArtist ? "ARTIST DISCOGRAPHY" : "BROWSE ARTISTS";
    $("view-meta").textContent = activeArtist ? "" : `${allArtists.length.toLocaleString()} artists`;
    if (!activeArtist) $("content").innerHTML = `<div class="empty">Select an artist or search Plex music.</div>`;
    setStatus(`ARTIST INDEX · ${allArtists.length.toLocaleString()} artists · type to search Plex`);
    return;
  }
  $("view-title").textContent = "SEARCHING PLEX";
  $("view-meta").textContent = `“${query}”`;
  $("content").innerHTML = `<div class="empty">Searching artists, albums, and tracks…</div>`;
  setStatus(`SEARCHING · ${query}`);
  searchTimer = setTimeout(async () => {
    try {
      const results = await window.plex.search(server, currentSection, query);
      if (generation !== searchGeneration) return;
      // Server search handles albums/tracks. Supplement artist results from the
      // existing index so punctuation/diacritic-normalized artist matches stay useful.
      const seen = new Set(results.artists.map((artist) => artist.ratingKey));
      for (const artist of allArtists) {
        if (fold(artist.title).includes(fold(query)) && !seen.has(artist.ratingKey)) {
          results.artists.push({ ...artist, type: "artist" });
          seen.add(artist.ratingKey);
        }
      }
      results.artists = results.artists.slice(0, 24);
      renderSearchResults(results, query);
      const total = results.artists.length + results.albums.length + results.tracks.length;
      setStatus(`SEARCH READY · ${total} result${total === 1 ? "" : "s"} · ↑↓ then Enter to activate`);
    } catch (error) {
      if (generation !== searchGeneration) return;
      $("content").innerHTML = `<div class="empty">Search failed. Check the Plex connection and try again.</div>`;
      $("view-title").textContent = "SEARCH ERROR";
      setStatus(`SEARCH ERROR · ${error.message}`);
    }
  }, 250);
}

function keyboardNavigate(event) {
  if (event.metaKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    $("search").focus();
    $("search").select();
    return;
  }
  if (event.key === "Escape" && $("search").value) {
    event.preventDefault();
    $("search").value = "";
    scheduleSearch();
    return;
  }
  if (event.target === $("search")) return;
  const targets = [...document.querySelectorAll("[data-nav]")];
  if (!targets.length) return;
  const active = document.activeElement;
  const index = targets.indexOf(active);
  if (["ArrowUp", "ArrowDown"].includes(event.key)) {
    const next = event.key === "ArrowDown"
      ? Math.min(targets.length - 1, Math.max(0, index + 1))
      : Math.max(0, index <= 0 ? 0 : index - 1);
    event.preventDefault();
    targets[next].focus();
    return;
  }
  const id = active?.dataset?.treeId;
  const node = id && treeNodeById(id);
  if (!node) return;
  const isBranch = node.kind === "artist" || node.kind === "other" || node.kind === "category";
  if (event.key === "Enter") {
    event.preventDefault();
    activateTreeNode(node, active);
  } else if (event.key === "ArrowRight" && isBranch && !expandedTreeNodes.has(id)) {
    event.preventDefault();
    activateTreeNode(node, active);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (isBranch && expandedTreeNodes.has(id)) {
      expandedTreeNodes = window.SearchTree.toggleExpanded(expandedTreeNodes, id);
      renderSearchTree(id);
    } else {
      const parent = treeParentId(id);
      if (parent) renderSearchTree(parent);
    }
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value || "");
  return div.innerHTML;
}

$("search").addEventListener("input", scheduleSearch);
$("clear-search").addEventListener("click", () => {
  $("search").value = "";
  $("search").focus();
  scheduleSearch();
});
$("server").addEventListener("change", (event) => loadArtists(event.target.value));
$("changeserver").addEventListener("click", changeServer);
document.addEventListener("keydown", keyboardNavigate);

boot();

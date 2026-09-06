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

function renderSearchResults(results, query) {
  const content = $("content");
  content.innerHTML = "";
  const sections = [
    ["ARTISTS", results.artists, (item) => selectArtist(item), "artist"],
    ["ALBUMS", results.albums, (item) => queueAlbum(item), "album"],
    ["TRACKS", results.tracks, (item) => queueTrack(item), "track"],
  ];
  const total = sections.reduce((sum, [, items]) => sum + items.length, 0);
  $("view-title").textContent = "SEARCH RESULTS";
  $("view-meta").textContent = total ? `“${query}” · ${total} result${total === 1 ? "" : "s"}` : `“${query}”`;
  if (!total) {
    content.innerHTML = `<div class="empty">No artists, albums, or tracks found for “${escapeHtml(query)}”.</div>`;
    return;
  }
  for (const [title, items, activate, type] of sections) {
    if (!items.length) continue;
    const section = document.createElement("section");
    section.className = "section";
    section.innerHTML = `<div class="section-head"><span>${title}</span><span class="section-count">${items.length}</span></div>`;
    const grid = document.createElement("div");
    grid.className = "entry-grid";
    for (const item of items) grid.appendChild(makeEntry(item, type, () => activate(item)));
    section.appendChild(grid);
    content.appendChild(section);
  }
  const guide = document.createElement("div");
  guide.className = "search-guide inset";
  guide.innerHTML = "<b>SEARCH COMMANDS</b><span>SCOPE: current Plex music library</span><span>ARTIST: discography</span><span>ALBUM: full playlist</span><span>TRACK: single song</span>";
  content.appendChild(guide);
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
  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
  const targets = [...document.querySelectorAll("[data-nav]")];
  if (!targets.length) return;
  const active = document.activeElement;
  const index = targets.indexOf(active);
  const next = event.key === "ArrowDown"
    ? Math.min(targets.length - 1, Math.max(0, index + 1))
    : Math.max(0, index <= 0 ? 0 : index - 1);
  event.preventDefault();
  targets[next].focus();
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

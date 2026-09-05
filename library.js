/* library.js — the Media Library window.
 * Bootstraps server selection (env default or Plex login), browses artists/
 * albums, and sends albums to the player window via main-process relay.
 */
let server = null;
let currentSection = null;
let allArtists = [];
let activeArtist = null;
let activeAlbum = null;

const $ = (id) => document.getElementById(id);

async function boot() {
  const status = await window.plex.authStatus();
  renderLoginBar(status);
  const servers = await window.plex.servers();
  const envDefault = servers.find(
    (s) => s.source === "env" || s.source === "env+account"
  );
  if (envDefault) {
    await selectServer(envDefault);
    // Keep the picker available so the user can switch servers.
    document.getElementById("changeserver").style.display = "inline-block";
  } else {
    renderServerList(servers, status);
  }
}

// re-open the server picker (all servers incl. shared/federated)
async function changeServer() {
  const servers = await window.plex.servers();
  const status = await window.plex.authStatus();
  document.getElementById("library").style.display = "none";
  document.getElementById("changeserver").style.display = "none";
  renderServerList(servers, status);
  document.getElementById("servers").style.display = "flex";
}

function renderLoginBar(status) {
  const bar = $("loginbar");
  bar.innerHTML = "";
  const who = document.createElement("span");
  if (status.logged) {
    who.textContent = `${status.user.name}`;
    bar.appendChild(who);
    const out = document.createElement("button");
    out.textContent = "Log out";
    out.onclick = async () => {
      await window.plex.logout();
      location.reload();
    };
    bar.appendChild(out);
  } else {
    who.textContent = "Log in with Plex for shared/federated servers";
    bar.appendChild(who);
    const btn = document.createElement("button");
    btn.textContent = "Log in with Plex";
    btn.onclick = beginLogin;
    bar.appendChild(btn);
  }
}

async function beginLogin() {
  const { pinId, code } = await window.plex.beginLogin();
  $("loginbar").querySelector("span").textContent =
    `Approve in your browser (code ${code})…`;
  const timer = setInterval(async () => {
    const r = await window.plex.poll(pinId);
    if (r.ok) {
      clearInterval(timer);
      location.reload();
    }
  }, 1500);
}

function renderServerList(servers, status) {
  const box = $("servers");
  box.innerHTML = "";
  if (!servers.length) {
    box.innerHTML = `<div class="empty">No servers found. Log in with Plex to discover yours (including shared/federated servers).</div>`;
    return;
  }
  const cur = document.createElement("div");
  cur.className = "empty";
  cur.style.width = "100%";
  cur.style.padding = "0 0 0 4px";
  cur.textContent = "Pick a server:";
  box.appendChild(cur);
  for (const s of servers) {
    const el = document.createElement("div");
    el.className = "servercard";
    const label =
      s.source === "env" || s.source === "env+account"
        ? `${s.name}`
        : `${s.name} ${s.owned ? "(owned)" : "(shared)"}`;
    el.innerHTML = `<div class="t"></div><div class="y"></div>`;
    el.querySelector(".t").textContent = label;
    el.querySelector(".y").textContent =
      s.source === "env" || s.source === "env+account"
        ? "LAN default from .env"
        : "via Plex account";
    el.onclick = () => selectServer(s);
    box.appendChild(el);
  }
}

async function selectServer(s) {
  $("status").textContent = `Connecting to ${s.name}…`;
  let result;
  try {
    result = await window.plex.selectServer(
      s.source === "env" || s.source === "env+account"
        ? { source: "env" }
        : { source: "account", name: s.name, token: s.token, resource: s.resource }
    );
  } catch (e) {
    $("status").textContent = `Connection failed: ${e.message}`;
    return;
  }
  server = result.server;
  const sec = $("server");
  sec.innerHTML = "";
  for (const x of result.sections) {
    const opt = document.createElement("option");
    opt.value = x.key;
    opt.textContent = `${s.name} — ${x.title}`;
    sec.appendChild(opt);
  }
  $("servers").style.display = "none";
  $("library").style.display = "flex";
  sec.style.display = "inline-block";
  document.getElementById("changeserver").style.display = "inline-block";
  // prefer the section matching the .env PLEX_SECTION; else the first one
  const envSection = await window.plex.getEnvSection?.();
  const preferred =
    result.sections.find((x) => x.key === envSection) || result.sections[0];
  if (preferred) {
    sec.value = preferred.key;
    await loadArtists(preferred.key);
  }
  $("status").textContent = `Connected: ${s.name} — click an album to send it to Winamp`;
}

async function loadArtists(sectionKey) {
  currentSection = sectionKey;
  $("artists").innerHTML = `<div class="empty">Loading artists…</div>`;
  allArtists = await window.plex.artists(server, sectionKey);
  renderArtists("");
  $("status").textContent = `${allArtists.length} artists loaded.`;
  $("albums").innerHTML = `<div class="empty">Select an artist.</div>`;
  $("albums").className = "";
}

function renderArtists(filter) {
  const list = filter
    ? allArtists.filter((a) => a.title.toLowerCase().includes(filter))
    : allArtists;
  const box = $("artists");
  box.innerHTML = "";
  for (const a of list) {
    const el = document.createElement("div");
    el.className = "artist" + (activeArtist === a.ratingKey ? " active" : "");
    el.textContent = a.title;
    el.title = a.title;
    el.onclick = () => selectArtist(a);
    box.appendChild(el);
  }
}

async function selectArtist(a) {
  activeArtist = a.ratingKey;
  renderArtists($("search").value.toLowerCase());
  $("albums").innerHTML = `<div class="empty">Loading…</div>`;
  const albums = await window.plex.albums(server, a.ratingKey);
  const box = $("albums");
  box.className = "";
  box.innerHTML = "";
  if (!albums.length) {
    box.innerHTML = `<div class="empty">No albums found.</div>`;
    return;
  }
  for (const alb of albums) {
    const el = document.createElement("div");
    el.className = "album" + (activeAlbum === alb.ratingKey ? " active" : "");
    el.innerHTML = `<div class="t"></div><div class="y"></div><div class="hint">Click to enqueue</div>`;
    el.querySelector(".t").textContent = alb.title;
    el.querySelector(".y").textContent = alb.year ? String(alb.year) : "";
    el.onclick = () => queueAlbum(alb, el);
    box.appendChild(el);
  }
}

async function queueAlbum(alb, el) {
  const tracks = await window.plex.tracks(server, alb.ratingKey);
  if (!tracks.length) return;
  document
    .querySelectorAll(".album.active")
    .forEach((x) => x.classList.remove("active"));
  el.classList.add("active");
  activeAlbum = alb.ratingKey;
  window.plex.enqueueTracks(tracks);
  const mins = (tracks.reduce((s, t) => s + t.duration, 0) / 60).toFixed(0);
  $("status").textContent = `▶ ${alb.title} — ${tracks.length} tracks, ${mins} min → sent to Winamp`;
}

$("search").addEventListener("input", (e) =>
  renderArtists(e.target.value.toLowerCase())
);
$("server").addEventListener("change", (e) => loadArtists(e.target.value));
document
  .getElementById("changeserver")
  .addEventListener("click", changeServer);

boot();
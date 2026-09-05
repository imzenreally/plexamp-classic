// auth.js — Plex account auth (PIN flow) + resource discovery + connection probing
const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PLEX_API = "https://plex.tv/api/v2";

// ---------- per-install identity ----------
function storePath() {
  return path.join(app.getPath("userData"), "auth.json");
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}

function clientIdentifier() {
  const data = readStore();
  if (!data.clientIdentifier) {
    data.clientIdentifier = crypto.randomUUID();
    writeStore(data);
  }
  return data.clientIdentifier;
}

// ---------- token persistence ----------
function saveAccountToken(token) {
  const data = readStore();
  data.accountToken = token;
  writeStore(data);
}

function readAccountToken() {
  return readStore().accountToken || null;
}

function clearAccountToken() {
  const data = readStore();
  delete data.accountToken;
  writeStore(data);
}

// ---------- plex.tv helpers ----------
async function plexTV(pathname, { token, method = "GET" } = {}) {
  const headers = {
    "X-Plex-Client-Identifier": clientIdentifier(),
    "X-Plex-Product": "plexamp-classic",
    "X-Plex-Version": "0.2.0",
    Accept: "application/json",
  };
  if (token) headers["X-Plex-Token"] = token;
  const res = await fetch(`${PLEX_API}${pathname}`, { headers, method });
  if (!res.ok) throw new Error(`plex.tv ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

// ---------- PIN flow ----------
async function createPin() {
  // strong=true -> 4-char code, auth#?code URL (no typing needed)
  const pin = await plexTV("/pins?strong=true", { method: "POST" });
  return { id: pin.id, code: pin.code };
}

async function pollPinOnce(pinId) {
  const pin = await plexTV(`/pins/${pinId}`);
  return pin.authToken || null;
}

function authUrlFor(code) {
  const cid = clientIdentifier();
  return (
    `https://app.plex.tv/auth#?clientID=${encodeURIComponent(cid)}` +
    `&code=${encodeURIComponent(code)}` +
    `&context[device][product]=plexamp-classic`
  );
}

async function fetchUser(token) {
  const u = await plexTV("/user", { token });
  return {
    id: u.id,
    username: u.username,
    name: u.friendlyName || u.name || u.username,
    thumb: u.thumb || null,
  };
}

// ---------- resource discovery (the federation layer) ----------
async function fetchResources(accountToken) {
  const list = await plexTV(
    "/resources?includeHttps=1&includeRelay=1",
    { token: accountToken }
  );
  // PMS entries only, with a usable token
  return list.filter(
    (r) => r.product === "Plex Media Server" && r.accessToken
  );
}

// Probe a server's advertised connections, best-first:
// local LAN -> public non-relay -> Plex relay. Returns base URL or null.
// Uses plexFetch (TLS-tolerant) — Plex home servers present self-signed certs.
async function probeBestConnection(resource, timeoutMs = 2500) {
  const conns = resource.connections || [];
  const ordered = [
    ...conns.filter((c) => c.local && !c.relay),
    ...conns.filter((c) => !c.local && !c.relay),
    ...conns.filter((c) => c.relay),
  ];
  for (const c of ordered) {
    const base = `${c.protocol}://${c.address}:${c.port}`;
    try {
      const res = await plexFetchText(`${base}/`, {
        headers: {
          "X-Plex-Token": resource.accessToken,
          Accept: "application/json",
        },
        timeoutMs,
      });
      if (res.statusCode === 200) return base; // reachable + token accepted
    } catch {
      // unreachable -> next candidate
    }
  }
  return null;
}

// ---------- TLS-tolerant fetch for Plex ----------
// Plex home servers use self-signed certs. Node's global fetch (undici)
// rejects them and ignores Node's https.Agent. So we drive http/https.get
// directly with rejectUnauthorized: false — same trust model as official
// Plex clients.
const nodeHttp = require("http");
const nodeHttps = require("https");

// Returns { statusCode, headers, body } — body fully buffered (single reader).
async function plexFetchText(url, { headers = {}, timeoutMs = 5000 } = {}) {
  const mod = url.startsWith("https") ? nodeHttps : nodeHttp;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      { headers, timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function plexFetchJson(url, opts) {
  const res = await plexFetchText(url, {
    ...opts,
    headers: { ...(opts?.headers || {}), Accept: "application/json" },
  });
  if (res.statusCode >= 400) {
    throw new Error(`HTTP ${res.statusCode} from ${url.slice(0, 60)}`);
  }
  return JSON.parse(res.body);
}

// Streaming variant for the audio proxy — returns the raw Node response
// (NOT buffered) so bytes pipe through with Range support.
function plexFetchStream(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const mod = url.startsWith("https") ? nodeHttps : nodeHttp;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      { headers, timeout: timeoutMs, rejectUnauthorized: false },
      (res) => resolve(res)
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

module.exports = {
  clientIdentifier,
  saveAccountToken,
  readAccountToken,
  clearAccountToken,
  createPin,
  pollPinOnce,
  authUrlFor,
  fetchUser,
  fetchResources,
  probeBestConnection,
  plexFetchText,
  plexFetchJson,
  plexFetchStream,
};
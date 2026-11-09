#!/usr/bin/env node
/* =============================================================================
 * Tunarr Studio backend
 * -----------------------------------------------------------------------------
 * A tiny zero-dependency Node service. It does four jobs:
 *   1. Serves the Tunarr Studio UI (tunarr-studio.html) on the same origin.
 *   2. Proxies /api/* to the real Tunarr server (no CORS issues).
 *   3. Persists per-channel programming preferences to a JSON file on the
 *      volume, under /studio-api/prefs — so settings survive reloads and are
 *      shared across every device that opens the app.
 *   4. Runs a periodic "guide feeder": for any channel with a saved schedule,
 *      it re-applies that schedule on an interval so Tunarr's guide always has
 *      maxDays of programming ahead and never runs dry.
 *
 * Config via environment (see docker-compose):
 *   TUNARR_BASE    e.g. http://tunarr.local:8000   (required)
 *   PORT           listen port (default 80)
 *   PREFS_FILE     path to the JSON store (default /data/prefs.json)
 *   FEED_INTERVAL  minutes between guide-feed runs (default 360 = 6h)
 *   UI_FILE        path to tunarr-studio.html (default /app/tunarr-studio.html)
 *   TUNARR_BASIC_AUTH_USER / TUNARR_BASIC_AUTH_PASSWORD
 *                  optional. Use the same values as Tunarr's own basic-auth
 *                  settings. When both are set, Studio sends them on every
 *                  Tunarr API call AND requires the same login from browsers,
 *                  so Studio can't be used to get around Tunarr's auth. When
 *                  unset, Studio has no login (matching a default Tunarr).
 *
 * No npm install required — uses only Node core modules.
 * ===========================================================================*/

'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');

const TUNARR_BASE = (process.env.TUNARR_BASE || 'http://tunarr.local:8000').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '80', 10);
const PREFS_FILE = process.env.PREFS_FILE || '/data/prefs.json';
const UI_FILE = process.env.UI_FILE || '/app/tunarr-studio.html';
const FEED_INTERVAL_MIN = parseInt(process.env.FEED_INTERVAL || '360', 10);

/* ------------------------------------------------------------- basic auth */
// Same env var names Tunarr uses, so one pair of values configures both.
const AUTH_USER = process.env.TUNARR_BASIC_AUTH_USER || '';
const AUTH_PASS = process.env.TUNARR_BASIC_AUTH_PASSWORD || '';
const AUTH_ON = Boolean(AUTH_USER && AUTH_PASS);
const UPSTREAM_AUTH = AUTH_ON
  ? 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`, 'utf8').toString('base64')
  : null;

// Constant-time comparison (hash first so lengths always match).
function safeEqual(a, b) {
  const h = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function browserAuthorized(header) {
  if (!AUTH_ON) return true;
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
  catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Evaluate both so timing doesn't reveal which half was wrong.
  const userOk = safeEqual(decoded.slice(0, i), AUTH_USER);
  const passOk = safeEqual(decoded.slice(i + 1), AUTH_PASS);
  return userOk && passOk;
}

/* ------------------------------------------------------------------ prefs */
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
  catch { return { channels: {} }; }
}
function savePrefs(p) {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2));
    return true;
  } catch (e) { console.error('savePrefs failed:', e.message); return false; }
}

/* ------------------------------------------------------- tunarr API helper */
function tunarr(method, apiPath, body, { noAuth = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(TUNARR_BASE + apiPath);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request(u, {
      method,
      headers: {
        'Accept': 'application/json',
        ...(UPSTREAM_AUTH && !noAuth ? { 'Authorization': UPSTREAM_AUTH } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(txt ? JSON.parse(txt) : null); }
          catch { resolve(txt); }
        } else {
          const err = new Error(`HTTP ${res.statusCode} ${method} ${apiPath}: ${txt.slice(0, 300)}`);
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* --------------------------------------------------------- guide feeder */
// Re-applies each saved random schedule so Tunarr keeps maxDays of guide ahead.
// SAFETY: the API is rooted at <base>/api (so the path needs the /api prefix),
// and we never replay blindly. A saved schedule could carry program ids from an
// older Tunarr database, and posting dead ids can EMPTY the channel. Guard:
// read the channel's CURRENT content first and SKIP if it already has none — if
// a schedule has gone stale it has presumably already emptied the channel, and
// we must not re-post (which would just keep it empty). A channel that still has
// content means its schedule is live, so replaying it (verbatim, preserving the
// saved program pool) is safe and refreshes the guide window.
async function feedGuides(reason) {
  const prefs = loadPrefs();
  const ids = Object.keys(prefs.channels || {});
  if (!ids.length) return;
  console.log(`[feed] (${reason}) checking ${ids.length} saved schedule(s)`);
  for (const id of ids) {
    const entry = prefs.channels[id];
    if (!entry || !entry.scheduleBody) continue;
    try {
      const current = await tunarr('GET', `/api/channels/${id}/programming`);
      const liveCount = ((current && current.lineup) || [])
        .filter(e => e.type === 'content').length;
      if (!liveCount) {
        console.warn(`[feed]   SKIP ${entry.name || id}: channel currently has no content (won't replay into a void)`);
        continue;
      }
      const after = await tunarr('POST', `/api/channels/${id}/programming`, entry.scheduleBody);
      const made = (after && (after.totalPrograms != null
        ? after.totalPrograms
        : ((after.lineup || []).filter(e => e.type === 'content').length))) || 0;
      if (!made) {
        console.error(`[feed]   WARNING ${entry.name || id}: replay produced 0 programs — schedule may be stale`);
      }
      entry.lastFedAt = Date.now();
      console.log(`[feed]   ok: ${entry.name || id} (${made} programs)`);
    } catch (e) {
      console.error(`[feed]   FAILED ${entry.name || id}: ${e.message}`);
    }
  }
  savePrefs(prefs);
}

/* ----------------------------------------------------------- http server */
const UI_HTML = (() => {
  try { return fs.readFileSync(UI_FILE); }
  catch { return Buffer.from('<h1>tunarr-studio.html not found</h1>'); }
})();

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      try { resolve(txt ? JSON.parse(txt) : null); } catch { resolve(null); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // ---- login gate (only when TUNARR_BASIC_AUTH_* are set) ----
  if (!browserAuthorized(req.headers.authorization)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Tunarr Studio", charset="UTF-8"',
      'Content-Type': 'text/plain',
    });
    return res.end('Authentication required');
  }

  // ---- Studio prefs API (our own) ----
  if (p === '/studio-api/prefs' && req.method === 'GET') {
    return sendJSON(res, 200, loadPrefs());
  }
  if (p.startsWith('/studio-api/prefs/') && req.method === 'PUT') {
    const id = decodeURIComponent(p.slice('/studio-api/prefs/'.length));
    const body = await readBody(req);
    const prefs = loadPrefs();
    prefs.channels = prefs.channels || {};
    prefs.channels[id] = { ...(prefs.channels[id] || {}), ...body, updatedAt: Date.now() };
    const ok = savePrefs(prefs);
    return sendJSON(res, ok ? 200 : 500, ok ? prefs.channels[id] : { error: 'save failed' });
  }
  if (p.startsWith('/studio-api/prefs/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/studio-api/prefs/'.length));
    const prefs = loadPrefs();
    if (prefs.channels) delete prefs.channels[id];
    savePrefs(prefs);
    return sendJSON(res, 200, { ok: true });
  }
  // manual trigger to feed guides now
  if (p === '/studio-api/feed' && req.method === 'POST') {
    feedGuides('manual').catch(e => console.error(e));
    return sendJSON(res, 202, { ok: true, message: 'feeding started' });
  }

  // ---- proxy /api/* to Tunarr ----
  // Tunarr's REST API is rooted at <base>/api, so forward the full path
  // (including the /api prefix) unchanged. TUNARR_BASE must NOT include /api.
  if (p.startsWith('/api/')) {
    const body = (req.method !== 'GET' && req.method !== 'HEAD') ? await readBody(req) : undefined;
    try {
      const result = await tunarr(req.method, p + (u.search || ''), body);
      return sendJSON(res, 200, result);
    } catch (e) {
      // A 401 from Tunarr means Studio's own credentials are missing or wrong.
      // Don't pass it through as 401: that reads as "your login failed" to the
      // browser. Report it as a gateway error that names the setting to fix.
      if (e.status === 401) {
        return sendJSON(res, 502, { error: AUTH_ON
          ? 'Tunarr rejected Studio\'s credentials. Check that TUNARR_BASIC_AUTH_USER/PASSWORD match Tunarr\'s.'
          : 'Tunarr requires a login. Set TUNARR_BASIC_AUTH_USER and TUNARR_BASIC_AUTH_PASSWORD on the Studio container (same values as Tunarr).' });
      }
      return sendJSON(res, e.status || 502, { error: e.message });
    }
  }

  // ---- serve the UI ----
  if (p === '/' || p === '/index.html' || p === '/tunarr-studio.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(UI_HTML);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Startup check: report whether Tunarr requires auth and whether our settings fit.
async function probeTunarrAuth() {
  let tunarrNeedsAuth;
  try { await tunarr('GET', '/api/channels', undefined, { noAuth: true }); tunarrNeedsAuth = false; }
  catch (e) {
    if (e.status === 401) tunarrNeedsAuth = true;
    else { console.warn(`[auth] couldn't reach Tunarr at startup (${e.message}); will keep trying on use`); return; }
  }
  if (!tunarrNeedsAuth) {
    console.log(AUTH_ON
      ? '[auth] Tunarr has no login; Studio login is ON (credentials set)'
      : '[auth] Tunarr has no login; Studio login is OFF');
    return;
  }
  if (!AUTH_ON) {
    console.error('[auth] Tunarr requires a login but TUNARR_BASIC_AUTH_USER/PASSWORD are not set — API calls will fail');
    return;
  }
  try { await tunarr('GET', '/api/channels'); console.log('[auth] Tunarr login OK; Studio login is ON'); }
  catch (e) {
    console.error(e.status === 401
      ? '[auth] Tunarr rejected the configured credentials — check they match Tunarr\'s'
      : `[auth] Tunarr check failed: ${e.message}`);
  }
}

server.listen(PORT, () => {
  console.log(`Tunarr Studio backend on :${PORT}  ->  ${TUNARR_BASE}`);
  console.log(`Prefs: ${PREFS_FILE}  ·  guide feed every ${FEED_INTERVAL_MIN} min`);
  probeTunarrAuth().catch(e => console.error(e));
  // feed once on startup (after a short delay so Tunarr is reachable), then on interval
  setTimeout(() => feedGuides('startup').catch(e => console.error(e)), 15000);
  setInterval(() => feedGuides('interval').catch(e => console.error(e)), FEED_INTERVAL_MIN * 60 * 1000);
});

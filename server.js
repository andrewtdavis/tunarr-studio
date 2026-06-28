#!/usr/bin/env node
/* =============================================================================
 * Tunarr Studio backend
 * -----------------------------------------------------------------------------
 * A tiny zero-dependency Node service that replaces the plain nginx container.
 * It does four jobs:
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
 *
 * No npm install required — uses only Node core modules.
 * ===========================================================================*/

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const TUNARR_BASE = (process.env.TUNARR_BASE || 'http://tunarr.local:8000').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '80', 10);
const PREFS_FILE = process.env.PREFS_FILE || '/data/prefs.json';
const UI_FILE = process.env.UI_FILE || '/app/tunarr-studio.html';
const FEED_INTERVAL_MIN = parseInt(process.env.FEED_INTERVAL || '360', 10);

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
function tunarr(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(TUNARR_BASE + apiPath);
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request(u, {
      method,
      headers: {
        'Accept': 'application/json',
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
          reject(new Error(`HTTP ${res.statusCode} ${method} ${apiPath}: ${txt.slice(0, 300)}`));
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
      const m = /HTTP (\d+)/.exec(e.message);
      return sendJSON(res, m ? +m[1] : 502, { error: e.message });
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

server.listen(PORT, () => {
  console.log(`Tunarr Studio backend on :${PORT}  ->  ${TUNARR_BASE}`);
  console.log(`Prefs: ${PREFS_FILE}  ·  guide feed every ${FEED_INTERVAL_MIN} min`);
  // feed once on startup (after a short delay so Tunarr is reachable), then on interval
  setTimeout(() => feedGuides('startup').catch(e => console.error(e)), 15000);
  setInterval(() => feedGuides('interval').catch(e => console.error(e)), FEED_INTERVAL_MIN * 60 * 1000);
});

# Tunarr Studio

A companion web app for [Tunarr](https://tunarr.com) ("fake live TV" from a
Plex library) that makes day-to-day channel management easy enough for anyone
in the house to use.

**Why it exists:** I set up Tunarr to run always-on channels from our own
library, and I wanted my wife to be able to manage them too: see what's on,
skip something nobody's watching, add or drop shows, and adjust how often each
one airs, from a phone or tablet, without learning Tunarr's admin UI. Studio is
that simpler control panel.

It's a single-file vanilla-JS UI (`tunarr-studio.html`) served by a small
zero-dependency Node backend (`server.js`). The backend proxies the Tunarr REST
API (same origin, no CORS), saves per-channel preferences on the server so every
device sees the same settings, and periodically re-applies saved schedules so
Tunarr's guide never runs dry.

## Features

- **Manage shows** — a channel's lineup grouped into shows with episode counts;
  remove shows, or set a per-show weight fader so some air more often.
- **Build options** — rebuild as a random schedule or a manual lineup, with
  episode order (series / random / continue / shuffle seasons), N-episode
  blocks, equal-airtime normalization, and a multi-day schedule window.
- **On now** — see what's playing, skip to the next program, jump to a
  specific show, or reshuffle the channel.
- **Add from Plex** — search the library through Tunarr, filter by content
  rating, and add whole shows to a channel.
- **Saved preferences** — weights and build options are stored server-side in
  `data/prefs.json` and restored when you reopen a channel.
- **Guide feeder** — re-applies each channel's saved random schedule every
  `FEED_INTERVAL` minutes (default 6 hours) so the guide stays populated.

## Install

```
server.js                  Node backend (UI + /api proxy + prefs + guide feeder)
tunarr-studio.html         the UI
docker-compose.yml         node:22-alpine container (deploy this)
docker-compose.nginx.yml   previous nginx setup, kept for rollback
default.conf.template      nginx config used by the rollback setup
data/                      prefs store (prefs.json, gitignored)
```

1. Copy `server.js` and `tunarr-studio.html` to a folder, e.g.
   `/mnt/pool/apps/tunarr-studio/`, and create a writable `data/` subfolder.
2. Edit `docker-compose.yml`: set `TUNARR_BASE` to your Tunarr server, set
   `TZ`, and fix the volume paths.
3. `docker compose up -d`, or on TrueNAS: Apps → Custom App → install via YAML.
4. Open `http://<host>:8088`.

`server.js` uses only Node core modules, so there's no build step.

## Environment variables

| var | default | meaning |
|-----|---------|---------|
| `TUNARR_BASE` | `http://tunarr.local:8000` | Tunarr server base URL |
| `PORT` | `80` | listen port inside the container |
| `PREFS_FILE` | `/data/prefs.json` | preferences store |
| `UI_FILE` | `/app/tunarr-studio.html` | UI path |
| `FEED_INTERVAL` | `360` | minutes between guide re-feeds |

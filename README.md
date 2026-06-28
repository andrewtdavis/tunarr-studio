# Tunarr Studio

A companion web app for [Tunarr](https://tunarr.com) ("fake live TV" from a Plex
library) that lets a non-technical user manage channel programming: group a
channel's shows, weight/rebuild the schedule, reorder the upcoming lineup,
save/restore named collections, and spin up new themed channels from the Plex
library.

**Why it exists:** I set up Tunarr to run always-on channels from our own
library, and I wanted my wife to be able to manage them too: see what's on,
skip something nobody's watching, add or drop shows, and adjust how often each
one airs, from a phone or tablet, without learning Tunarr's admin UI. Studio is
that simpler control panel.

It's a single-file vanilla-JS UI (`tunarr-studio.html`) served by a tiny
zero-dependency Node backend (`server.js`) that also proxies the Tunarr API
(same origin, no CORS), persists preferences, and keeps the guide fed.

Talks to a Tunarr server's REST API at `<TUNARR_BASE>/api`.

## Architecture

```
browser ──> server.js (:80 in container, :8088 on host)
              ├── /                serves tunarr-studio.html
              ├── /api/*           reverse-proxy -> TUNARR_BASE/api/*   (Tunarr)
              ├── /studio-api/prefs  GET/PUT/DELETE  per-channel prefs + collections
              └── guide feeder     re-applies saved random schedules every FEED_INTERVAL
prefs persisted to /data/prefs.json (host volume)
```

The backend uses only Node core modules — `node:22-alpine` runs it directly,
no build step.

## Repo layout

```
server.js                  Node backend (UI + /api proxy + /studio-api prefs + guide feeder)
tunarr-studio.html         Single-file UI
docker-compose.yml         PRODUCTION (Node). Deploy this.
docker-compose.nginx.yml   LEGACY nginx setup, kept for rollback only
data/                      prefs store (prefs.json); contents gitignored
README.md
```

## Features

- **Manage tab** — shows grouped by series (alphabetical), per-show weight
  faders, rebuild as a **random schedule** or **manual lineup**, episode
  ordering, equal-airtime normalize, remove shows.
- **Up Next tab** — upcoming lineup in play order with projected air times;
  drag to reorder, save back (keeps the current program playing seamlessly).
- **Add from Plex tab** — search the Plex library through Tunarr by title or
  metadata (genre / actor / director / studio / year / tag), shows or movies,
  add to the channel.
- **Collections** — save the current lineup under an arbitrary name and
  restore/delete later (e.g. swap "Barney favorites" ↔ "Toon classics").
- **Add channel** — analyzes the library's genres and suggests themed channels
  (Crime Dramas, Sci-Fi, Rom-Coms, Cartoons, …), then creates + auto-populates
  one; or build a custom channel by genre + type.
- **Safety net** — every lineup-changing action auto-snapshots the previous
  lineup ("Restore previous"); the guide feeder keeps random schedules topped up.

## Environment variables (server.js)

| var | default | meaning |
|-----|---------|---------|
| `TUNARR_BASE` | `http://tunarr.local:8000` | Tunarr API base — **no** trailing `/api` |
| `PORT` | `80` | listen port inside the container |
| `PREFS_FILE` | `/data/prefs.json` | prefs/collections store |
| `UI_FILE` | `/app/tunarr-studio.html` | UI path |
| `FEED_INTERVAL` | `360` | minutes between guide re-feeds |

## Production cutover (nginx → Node)

The Node version uses the **same host volume dir and external port** as the old
nginx app, so it's a drop-in swap.

1. **Stage the files** in the existing host volume dir:
   ```sh
   cd /mnt/pool/apps/tunarr-studio
   # copy the new server.js + tunarr-studio.html here (overwriting the old html)
   mkdir -p data && chmod -R o+rwX data
   ```
2. **Stop** the old container (TrueNAS: stop the `tunarr-studio` app), or just
   re-deploy with the new compose (same container name replaces it).
3. **Apply** `docker-compose.yml` (TrueNAS: Apps → Custom App → install/edit via
   YAML, paste the file). It pulls `node:22-alpine` and runs `node /app/server.js`.
4. **Verify**:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://<host>:8088/            # 200 (UI)
   curl -s http://<host>:8088/api/channels | head -c 200                   # channel JSON (proxy)
   curl -s http://<host>:8088/studio-api/prefs                             # {"channels":{}} or saved prefs
   ```
   Then open `http://<host>:8088` and confirm the channel loads.

The old `default.conf.template` can stay on the host volume — it's only used by
the nginx (rollback) setup and is ignored by the Node version.

### Rollback

Re-apply `docker-compose.nginx.yml` (same port, same html, uses the
still-present `default.conf.template`). Note: under nginx the `/studio-api`
prefs endpoint doesn't exist, so collections/backups fall back to per-browser
`localStorage` and the guide feeder doesn't run — but the UI itself still works.

## Local dev loop (no Docker)

Run the backend against the live Tunarr API on a side port so production is
untouched:
```sh
PORT=8090 TUNARR_BASE=http://tunarr.local:8000 \
  PREFS_FILE=$PWD/data/prefs.json UI_FILE=$PWD/tunarr-studio.html \
  node server.js
# open http://<host>:8090   (Ctrl-C + re-run to reload after edits)
```
The UI is one HTML file; edit and refresh. `server.js` reads the HTML into
memory at startup, so restart it after editing the HTML.

## Notes on Tunarr (1.3.6) quirks baked into the code

- **`/api` prefix**: Tunarr's API is rooted at `<base>/api`; `TUNARR_BASE` must
  NOT include `/api` (both the proxy and the feeder add it).
- **Random schedules** must use `padStyle: 'slot'` — `'episode'` emits ~1
  program and ignores `maxDays` (this previously wiped channels).
- **Manual lineup** content entries require `{type, id, duration}` — omitting
  `duration` 400s the whole POST.
- **Free-text search is broken server-side** (returns a hit count but zero
  documents), so the UI filters titles client-side over the filtered result set.
- **Channel create** (`POST /api/channels {type:'new', channel:{…}}`) returns a
  server-assigned id; the UI matches the new channel by number as a fallback.

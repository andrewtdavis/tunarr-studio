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
docker-compose.yml         Container deployment (node:22-alpine)
data/                      prefs store (prefs.json); contents gitignored
docs/                      setup + connection guides
README.md
```

## Install

Tunarr Studio runs as a small container. You need a **Tunarr server already
running** — Studio drives it through its API.

- **TrueNAS Scale:** [`docs/truenas-setup.md`](docs/truenas-setup.md) — full
  fresh-install walkthrough (Custom App via YAML).
- **Connecting it to Tunarr + watching the channels:**
  [`docs/connect-to-tunarr.md`](docs/connect-to-tunarr.md).

Short version (any Docker host):

1. Copy `server.js` and `tunarr-studio.html` to a folder, and make a writable
   `data/` subdir next to them.
2. Edit `docker-compose.yml`: set `TUNARR_BASE` to your Tunarr server (no
   trailing `/api`), set `TZ`, and fix the three volume paths.
3. `docker compose up -d` (or paste the YAML into TrueNAS → Custom App).
4. Open `http://<host>:8088`.

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

## Roadmap

- **Commercials / bumpers as filler** — play era-appropriate ads and channel
  bumpers between shows (via Tunarr filler lists / `fillerCollections`) so a
  channel feels like real broadcast TV, with a per-channel filler control in the
  UI. See Tunarr's filler docs:
  https://tunarr.com/configure/channels/filler/
- Multi-server support (switch between Tunarr instances from the UI).
- Per-channel transcode / stream-mode controls surfaced in the UI.

## Environment variables (server.js)

| var | default | meaning |
|-----|---------|---------|
| `TUNARR_BASE` | `http://tunarr.local:8000` | Tunarr API base — **no** trailing `/api` |
| `PORT` | `80` | listen port inside the container |
| `PREFS_FILE` | `/data/prefs.json` | prefs/collections store |
| `UI_FILE` | `/app/tunarr-studio.html` | UI path |
| `FEED_INTERVAL` | `360` | minutes between guide re-feeds |
| `TUNARR_BASIC_AUTH_USER` | *(unset)* | optional — match Tunarr's basic-auth user (see Security) |
| `TUNARR_BASIC_AUTH_PASSWORD` | *(unset)* | optional — match Tunarr's basic-auth password |

## Verify a deployment

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:8088/   # 200 (UI)
curl -s http://<host>:8088/api/channels | head -c 200          # channel JSON (proxy)
curl -s http://<host>:8088/studio-api/prefs                    # {"channels":{}} or saved prefs
```

Then open `http://<host>:8088` and confirm your channels load.

## Security

Tunarr Studio has **no login of its own**. That matches a default Tunarr
install, whose API is also unauthenticated — anyone who can reach Studio can
change channel programming, exactly as anyone who can reach Tunarr's own UI
can today. Studio doesn't widen that exposure, but it doesn't narrow it either.

- **Keep it on your LAN.** Don't port-forward `:8088` to the internet.
- **Remote access:** put it behind a VPN (WireGuard, Tailscale) or an
  authenticating reverse proxy (Authelia, Authentik, Caddy/nginx with basic
  auth) rather than exposing it directly.
- **Tunarr's optional basic-auth login** (`TUNARR_BASIC_AUTH_USER` /
  `TUNARR_BASIC_AUTH_PASSWORD`, in recent Tunarr builds) is supported. Set the
  **same two variables, with the same values**, on the Studio container. Studio
  then sends them on every Tunarr call (proxy and guide feeder) and asks
  browsers for the same login, so it can't be used to get around Tunarr's auth.
  Leave them unset and Studio has no login, as before.
- The startup log reports how this lines up, e.g. `[auth] Tunarr login OK;
  Studio login is ON`, or a warning if Tunarr wants a login Studio wasn't given.
- Basic auth sends the password with every request, so use it over a trusted
  LAN/VPN or behind HTTPS.

## Local dev loop (no Docker)

Run the backend directly against a Tunarr server on a spare port (useful for
testing changes without touching a running deployment):
```sh
PORT=8090 TUNARR_BASE=http://tunarr.local:8000 \
  PREFS_FILE=$PWD/data/prefs.json UI_FILE=$PWD/tunarr-studio.html \
  node server.js
# open http://<host>:8090   (Ctrl-C + re-run to reload after edits)
```
`server.js` reads the HTML into memory at startup, so restart it after editing
`tunarr-studio.html`.

## Notes on Tunarr (1.3.6) quirks baked into the code

These were found by testing against a live Tunarr instance and are load-bearing.
If you extend this code, the reliable approach is to **probe the live API
read-only first and match the code to what actually comes back** — don't guess
response shapes, since Tunarr's API changes between versions.

- **`/api` prefix**: Tunarr's API is rooted at `<base>/api`; `TUNARR_BASE` must
  NOT include `/api` (both the proxy and the feeder add it).
- **Random schedules** must use `padStyle: 'slot'` — `'episode'` emits ~1
  program and ignores `maxDays` (this previously wiped channels).
- **Each random-schedule slot needs its own `id` (uuid)** — a missing slot id
  400s the POST.
- **Manual lineup** content entries require `{type, id, duration}` — omitting
  `duration` 400s the whole POST.
- **Show data is nested**: `GET /channels/:id/programming` returns condensed
  programs where the show lives at `programs[id].program.show.{id,title}`.
- **Free-text search is broken server-side** (returns a hit count but zero
  documents), so the UI filters titles client-side over a metadata-filtered
  result set. For "show" vs "movie", filter with a tree on `type` — not
  `restrictSearchTo`.
- **Channel create** (`POST /api/channels {type:'new', channel:{…}}`) returns a
  server-assigned id; the UI matches the new channel by number as a fallback.

## License

[MIT](LICENSE) — not affiliated with Tunarr, Plex, Jellyfin, Emby, or iXsystems.

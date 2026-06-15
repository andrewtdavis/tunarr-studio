# Tunarr Studio

A companion web app for [Tunarr](https://tunarr.com) ("fake live TV" from a
Plex library) that makes day-to-day channel management easy enough for anyone
in the house to use.

**Why it exists:** I set up Tunarr to run always-on channels from our own
library, and I wanted my wife to be able to manage them too: see what's on,
skip something nobody's watching, add or drop shows, and adjust how often each
one airs, from a phone or tablet, without learning Tunarr's admin UI. Studio is
that simpler control panel.

It's a single-file vanilla-JS UI (`tunarr-studio.html`) served by nginx, which
also proxies the Tunarr REST API so the page and the API share one origin (no
CORS).

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

## Install

```
tunarr-studio.html      the UI
default.conf.template   nginx config (proxies /api to Tunarr)
docker-compose.yml      nginx:1.27-alpine container
```

1. Copy `tunarr-studio.html` and `default.conf.template` to a folder, e.g.
   `/mnt/pool/apps/tunarr-studio/`, and make them readable by the container
   (`chmod o+r`).
2. Edit `docker-compose.yml`: set `TUNARR_HOST` / `TUNARR_PORT` to your Tunarr
   server and fix the volume paths.
3. `docker compose up -d`, or on TrueNAS: Apps → Custom App → install via YAML.
4. Open `http://<host>:8088`.

Restart the container after replacing the HTML.

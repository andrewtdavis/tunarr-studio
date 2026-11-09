# Connecting Tunarr Studio to Tunarr (and watching your channels)

Tunarr Studio is a control surface — it drives an existing **Tunarr** server
through its REST API. This guide covers (1) pointing Studio at Tunarr, and (2)
getting the resulting channels onto a player so you can actually watch them.

If you're new to Tunarr itself, its docs are the source of truth:

- **Tunarr home / docs:** https://tunarr.com
- **Install / run:** https://tunarr.com/getting-started/installation/
- **First-run setup:** https://tunarr.com/getting-started/setup/
- **Media sources (Plex/Jellyfin/Emby):** https://tunarr.com/configure/media-sources/
- **Channels:** https://tunarr.com/configure/channels/
- **Programming:** https://tunarr.com/configure/programming/
- **Clients (how to watch):** https://tunarr.com/configure/clients/

---

## 1. Have Tunarr set up first

Before Studio is useful, Tunarr needs:

1. **A media source** — connect Tunarr to your Plex / Jellyfin / Emby server (or
   point it at local folders). See
   https://tunarr.com/configure/media-sources/
2. **At least one channel with programming** — Tunarr builds channels from the
   media it can see. See https://tunarr.com/configure/channels/ and
   https://tunarr.com/configure/programming/

Once a channel exists with shows on it, Studio can manage it.

---

## 2. Point Studio at Tunarr

Studio finds Tunarr via the **`TUNARR_BASE`** environment variable in
`docker-compose.yml`:

```yaml
TUNARR_BASE: "http://<your-tunarr-host>:8000"   # NO trailing /api
```

- Use an address the **Studio container** can reach (IP or resolvable hostname).
- Tunarr's default API port is **8000**.
- **Do not** append `/api` — Studio adds it to every call. Tunarr's API is rooted
  at `<base>/api`, so `TUNARR_BASE` is just the scheme + host + port.

That's the whole connection. Because Studio serves its UI and proxies the Tunarr
API from the **same origin** (`:8088`), the browser never deals with CORS — open
`http://<truenas-ip>:8088` and it connects automatically.

> If you open `tunarr-studio.html` directly as a `file://` (not behind the
> backend), the UI talks to Tunarr directly, and recent Tunarr builds only allow
> same-origin requests unless you set `TUNARR_CORS_ORIGINS` on the Tunarr side.
> Saved collections and the guide feeder also won't work without the backend.
> Run it behind `server.js` (the container) — that's the supported setup.

### If Tunarr has a login

If you've turned on Tunarr's optional basic-auth login
(`TUNARR_BASIC_AUTH_USER` / `TUNARR_BASIC_AUTH_PASSWORD` on the Tunarr
container), set the **same two variables with the same values** on the Studio
container (they're already in `docker-compose.yml`, commented out):

```yaml
TUNARR_BASIC_AUTH_USER: "admin"
TUNARR_BASIC_AUTH_PASSWORD: "change-me"
```

Studio will log in to Tunarr with them and show your browser a login prompt for
the same username and password. Check the container log on startup:

- `[auth] Tunarr login OK; Studio login is ON` — all set.
- `[auth] Tunarr requires a login but ... are not set` — add the two variables.
- `[auth] Tunarr rejected the configured credentials` — the values don't match
  Tunarr's.

---

## 3. Watch the channels (add Tunarr to a player)

Studio manages programming, but you watch through a **player**. Tunarr presents
your channels two ways, and both are documented at
https://tunarr.com/configure/clients/ :

- **As a spoofed HDHomeRun tuner** — add it to Plex / Jellyfin / Emby as a live
  TV tuner. The server then shows your Tunarr channels in its Live TV guide.
- **As M3U + XMLTV URLs** — use with any IPTV player (e.g. Tivimate, m3u-capable
  apps), or any client that ingests those.

### Plex specifically

See https://tunarr.com/configure/clients/plex/ for the current steps. In short:

1. In Plex: **Settings → Live TV & DVR → Set Up** (add a device/tuner).
2. If Plex doesn't auto-discover Tunarr, enter its address manually
   (`http://<tunarr-host>:8000`).
3. Provide the **XMLTV guide URL** when prompted (Tunarr exposes one; the Plex
   client doc shows the exact path).
4. Finish the wizard — your Tunarr channels appear under Live TV.

> **Plex Pass is required** for Plex's Live TV & DVR section. That's a Plex
> limitation, not Tunarr's or Studio's.

### Jellyfin / Emby / IPTV apps

Follow https://tunarr.com/configure/clients/ — generally you add Tunarr's M3U
URL as a tuner and its XMLTV URL as the guide source.

---

## 4. Avoiding transcoding (optional but recommended)

If you want channels to **direct-play** instead of transcoding 24/7, use
Tunarr's **HLS Direct** streaming mode, which segments source files without
re-encoding. For Plex, pair it with the MPEG-TS container. See:
https://tunarr.com/configure/channels/transcoding/

Caveat: enabling a **watermark / channel bug** in Tunarr forces a transcode
(ffmpeg has to burn the overlay into the video), so it's incompatible with pure
HLS Direct. If you want a channel bug without transcoding, composite it into the
source media instead.

---

## Quick connection checklist

- [ ] Tunarr running and reachable at `http://<host>:8000`
- [ ] Tunarr has a media source + at least one channel with programming
- [ ] `TUNARR_BASE` set correctly (no `/api`) in `docker-compose.yml`
- [ ] Studio reachable at `http://<truenas-ip>:8088` and listing channels
- [ ] Tunarr added to your player (HDHomeRun tuner or M3U/XMLTV) to watch

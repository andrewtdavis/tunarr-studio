# Installing Tunarr Studio on TrueNAS Scale

This is a fresh-install walkthrough for **TrueNAS Scale** (Electric Eel /
25.04+, which uses Docker/Docker-Compose for apps). You'll run Tunarr Studio as
a **Custom App** from the provided `docker-compose.yml`.

> Prerequisites: a running Tunarr server reachable on your network, and a pool
> where you can create an app dataset. You do **not** need Tunarr and Tunarr
> Studio on the same host — Studio just needs to reach Tunarr's API over HTTP.

---

## 1. Put the files on a dataset

Pick (or create) a location on a pool for the app's files. A common pattern is
an `apps` dataset:

```sh
# adjust "pool" to your actual pool name
mkdir -p /mnt/pool/apps/tunarr-studio/data
```

Copy these two files into `/mnt/pool/apps/tunarr-studio/`:

- `server.js`
- `tunarr-studio.html`

(You can `scp` them, use the TrueNAS file UI, or `git clone` the repo somewhere
and copy them over.)

Make the directory readable/writable by the container. `node:22-alpine` runs as
root by default, so this is mostly belt-and-suspenders, but it avoids surprises:

```sh
chmod -R o+rwX /mnt/pool/apps/tunarr-studio
```

Your layout should look like:

```
/mnt/pool/apps/tunarr-studio/
├── server.js
├── tunarr-studio.html
└── data/            # prefs + backups get written here at runtime
```

---

## 2. Edit the compose file

Open `docker-compose.yml` and change three things:

```yaml
services:
  tunarr-studio:
    image: node:22-alpine
    container_name: tunarr-studio
    working_dir: /app
    command: ["node", "/app/server.js"]
    ports:
      - "8088:80"                                    # host:container — change 8088 if taken
    environment:
      TUNARR_BASE: "http://tunarr.local:8000"        # (1) your Tunarr server, NO trailing /api
      PORT: "80"
      PREFS_FILE: "/data/prefs.json"
      UI_FILE: "/app/tunarr-studio.html"
      FEED_INTERVAL: "360"                           # minutes between guide re-feeds
      TZ: "America/Los_Angeles"                      # (2) your timezone — affects the guide
    volumes:
      - /mnt/pool/apps/tunarr-studio/server.js:/app/server.js:ro          # (3) fix these
      - /mnt/pool/apps/tunarr-studio/tunarr-studio.html:/app/tunarr-studio.html:ro
      - /mnt/pool/apps/tunarr-studio/data:/data
    restart: unless-stopped
```

1. **`TUNARR_BASE`** — your Tunarr server's base URL. Use an IP or a hostname
   your TrueNAS box can resolve, e.g. `http://192.168.1.50:8000`. **Do not**
   include `/api` — the app adds it.
2. **`TZ`** — set your timezone. Tunarr Studio uses it for schedule/guide times.
3. **The three volume paths** — change `/mnt/pool/apps/tunarr-studio` to the
   real path from step 1.

> **Port note:** `8088:80` means the app is reachable on host port **8088**.
> Change the left number if 8088 is already in use.

---

## 3. Install as a Custom App

In the TrueNAS web UI:

1. **Apps → Discover Apps → Custom App** (top-right, there's a "Custom App"
   button), or **Apps → Discover Apps → the three-dot menu → Install via YAML**.
2. Choose the **"Install via YAML"** option.
3. Paste your edited `docker-compose.yml`.
4. Deploy.

TrueNAS pulls `node:22-alpine` and starts `node /app/server.js`. No build step —
the backend is zero-dependency.

---

## 4. Verify

From a shell on the TrueNAS host (or any machine on the network, swapping in the
host's address):

```sh
# UI loads (expect 200)
curl -s -o /dev/null -w '%{http_code}\n' http://<truenas-ip>:8088/

# proxy to Tunarr works (expect channel JSON)
curl -s http://<truenas-ip>:8088/api/channels | head -c 200

# prefs store responds (expect {"channels":{}} or your saved prefs)
curl -s http://<truenas-ip>:8088/studio-api/prefs
```

Then open **`http://<truenas-ip>:8088`** in a browser. It should connect
automatically (same-origin) and list your Tunarr channels.

---

## Troubleshooting

**UI loads but no channels / "failed to reach Tunarr".**
`TUNARR_BASE` is wrong or unreachable from the container. Test from inside the
container:
```sh
docker exec -it tunarr-studio sh -c 'wget -qO- $TUNARR_BASE/api/channels | head -c 200'
```
If that fails, fix the address (and remember: no trailing `/api`).

**403 / permission denied in the logs.**
The container can't read the mounted files, or can't write `data/`. Re-run the
`chmod -R o+rwX` from step 1 on the host.

**Changes to `tunarr-studio.html` don't show up.**
`server.js` caches the HTML in memory at startup. **Restart the container** after
editing the UI file.

**Port already in use.**
Change the host side of `ports:` (e.g. `"8099:80"`) and redeploy.

**View logs:**
```sh
docker logs -f tunarr-studio
```
On startup you'll see the listen line and, after a short delay, the first
guide-feed run.

---

## Updating

Replace `server.js` / `tunarr-studio.html` on the dataset with new versions and
**restart the app** (TrueNAS: stop/start the app, or `docker restart
tunarr-studio`). The compose and `data/` don't need to change.

---

## Permissions & persistence notes

- The `data/` volume holds `prefs.json` (per-channel preferences and saved
  collections) and lineup backups. It persists across restarts and is shared by
  **every browser/device** that opens the app — so you and anyone else manage
  the same saved state.
- Files written by the container are owned by the container's user (root by
  default). If you later run the container as a non-root user, make sure that
  UID can write `data/`.

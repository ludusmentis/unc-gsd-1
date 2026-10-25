# Deploying nursehound to Unraid (R011)

This runbook covers building the Docker image, running it on Unraid via docker-compose,
wiring the Cloudflare Tunnel to `un.clord.org`, registering the Spotify redirect URI,
pre-seeding the friend-account allowlist, and backing up the database.

## What the image is

One Node 20 process serves Next.js (`.next` build output) + socket.io, executing
TypeScript source via `tsx` (a runtime dependency — no build-output conversion of
`src/server/*`). The multi-stage Dockerfile runs `npm ci` + `npm run build` in a
build stage and copies `node_modules`, `.next`, `src`, `scripts`, and configs into a
non-root runtime stage. All app state lives in SQLite at `DB_PATH`
(default `./data/nursehound.db`, bind-mounted to the host so it survives rebuilds).

## Environment variables (complete list)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `SPOTIFY_CLIENT_ID` | yes | — | From the Spotify dashboard app. Secret — pass via environment only, never bake into the image. |
| `SPOTIFY_CLIENT_SECRET` | yes | — | Same. In docker-compose it is interpolated from the shell/env file. |
| `DB_PATH` | no | `./data/nursehound.db` (in-container path). Keep the default and bind-mount `/app/data`; override only for tests. |
| `PORT` | no | `3000` (container) | Compose maps `${PORT:-3000}:3000` — the host-side port. The container always listens on 3000. |
| `NODE_ENV` | no | `production` (set in image) | Set automatically. |

## 1. Build and run on Unraid

```sh
# on the Unraid host (or any machine with Docker), from the repo checkout:
export SPOTIFY_CLIENT_ID=...
export SPOTIFY_CLIENT_SECRET=...
# optional host port override (default 3000):
# export PORT=3123
docker compose up -d --build
```

Or with the Unraid Docker-Compose-Manager plugin: point a new stack at
`docker-compose.yml` (set the env vars in the stack template), or run:

```sh
docker build -t nursehound .
docker run -d --rm -p 3000:3000 \
  -e SPOTIFY_CLIENT_ID -e SPOTIFY_CLIENT_SECRET \
  -v /mnt/user/appdata/nursehound/data:/app/data \
  --name nursehound nursehound
```

Check health: `docker logs nursehound` should print structured JSON, including a
`{"scope":"server","event":"listening","port":3000}` line; then
`curl http://<unraid-host>:3000/` should return the landing page HTML.

Container-smoke gate: `BASE_URL=http://127.0.0.1:<host-port> node scripts/verify-deploy.mjs`
(HTTP + socket.io create/join against the running container).

## 2. Cloudflare Tunnel → un.clord.org

Run cloudflared on Unraid (Community Applications `cloudflared` container or the
CA template) with a tunnel mapped to the local service:

```sh
cloudflared tunnel --url http://<unraid-host>:3000   # then bind the hostname in the Zero Trust dashboard
# or, in config.yml:
#   ingress:
#     - hostname: un.clord.org
#       service: http://<unraid-host>:3000
```

Requirements:

- **WebSocket pass-through**: the tunnel routes `/socket.io/*` transparently —
  Cloudflare supports WebSockets on proxied hostnames; just leave the hostname
  proxied (orange cloud) and do not add any "Disable WebSocket" transform rules.
  No extra config is needed; verify with a WS handshake:
  `curl -i -N "https://un.clord.org/socket.io/?EIO=4&transport=polling"` (should 200 with engine.io payload).
- **Host header preserved**: `src/server/spotify/auth.ts#envFromHost` picks the
  redirect URI env by inspecting the request Host header —
  `un.clord.org` → `prod`, anything else → `dev`. Cloudflare tunnels preserve the
  original Host header by default, so no override is needed. **Do not add a Host
  header rewrite rule**, or Spotify OAuth will redirect to the dev URI.

Verify: `curl -s https://un.clord.org/ | head -5` returns HTML, and
`BASE_URL=https://un.clord.org node scripts/verify-deploy.mjs` passes end-to-end.

## 3. Spotify dashboard redirect URI registration

In the Spotify Developer Dashboard → your app → Settings → Redirect URIs, register:

- `https://un.clord.org/api/spotify/callback` (prod)
- your local dev callback (already used in development)

Mismatched redirects will fail with Spotify `INVALID_CLIENT` / `redirect_uri_mismatch`
errors. The exact prod callback path is the one produced by the `prod` env in
`src/server/spotify/auth.ts` (`redirectUri(envFromHost(host))`) — confirm by
visiting `https://un.clord.org/` and starting a login; the Spotify consent screen
should show `un.clord.org` as the return address.

## 4. Friend-account allowlist (pre-game-night step)

The host should pre-add friend accounts before game night (see the app's
friend/allowlist flow in `src/server/sessions.ts` + UI). Have each friend share
their Spotify account email (or OAuth user id), add them via the host UI, and have
each friend log in once at `https://un.clord.org/` to accept the friend invite —
this avoids doing invites over the tunnel mid-party when everyone is impatient.

## 5. Database backup

All state (rooms, games, sessions, allowlist) lives in one SQLite file. Back up by
stopping the container and copying the bind mount:

```sh
docker compose stop
cp /mnt/user/appdata/nursehound/data/nursehound.db /mnt/user/backups/nursehound-$(date +%F).db
docker compose start
```

(SQLite is single-writer; copy while the container is stopped, or use
`sqlite3 nursehound.db ".backup '/mnt/user/backups/...'`" for a hot copy.)
Unraid's `appdata` share is normally included in the array-level backup — confirm
the share is included in your backup plan.

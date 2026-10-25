# S06 Integration Evidence — Real Spotify host flow

Slice S06, Task S06-T02 (real-mode OAuth + playlist import evidence on a running instance).
Recorded: 2026-10-25 (UTC times from server logs).

Execution environment: no human operator was available during this session, and
the Spotify client id / secret environment variables are **not set** in the environment.
Per the task plan's NEEDS-HUMAN convention (S04-T03 / R012 precedent), the steps that
require a human driving Spotify (OAuth consent, playlist selection, Connect speaker)
are recorded below as NEEDS-HUMAN with exactly what the human must confirm. No fake
Spotify stub (`scripts/uat-fake-spotify.mjs`) was used anywhere in this evidence run.

## 1. Preconditions (status)

| Item | Status | Evidence |
|---|---|---|
| T01 route-module-split fix in place | PASS | gsd_exec `3402b6ef-7117-411c-8a58-87c0acee958b`: `npm test -- tests/host-binding-route-split.test.ts` → 3/3 tests passed, exit 0 (2026-10-25T14:00:17Z) |
| Real-mode dev instance boots without stub | PASS | gsd_exec `fd15624a-93bd-4277-9e26-c9809198c947`: `npm run dev -- --check` (tsx src/server/main.ts, real mode, no NODE_OPTIONS stub) → `{"event":"check_ok","url":"http://127.0.0.1:3000"}`, exit 0 (2026-10-25T13:00:22Z) |
| Spotify client id / secret env vars set | NOT-MET | Unset in environment; must be collected via secure_env_collect (never echoed) — NEEDS-HUMAN |
| Host account Premium + Connect speaker online | NEEDS-HUMAN | Human must open the Spotify app (phone/PC) before driving the flow |
| Playlist with >= ~20 eligible tracks | NEEDS-HUMAN | Human must nominate the playlistId |
| Dashboard redirect URI `http://localhost:3000/api/auth/callback` | NEEDS-HUMAN | Human must confirm in the Spotify developer dashboard |

## 2. Real OAuth (GET /host → authorize → callback)

NEEDS-HUMAN. Autonomous execution cannot complete Spotify's consent screen.
Procedure for the human (verified runnable from the boot evidence above):

1. `npm run dev` in the repo root (real mode; do not set any NODE_OPTIONS import stub).
2. Keep the host page mounted (MEM022: host unmount >2s pauses via HOST_LEAVE_GRACE_MS=2000).
3. Visit `http://localhost:3000/host` → click authorize → log in at Spotify consent → return via `/api/auth/callback`.
4. What must be confirmed by the human, then swept into this file:
   - Server log contains `token_exchange_ok` and no `token_exchange_failed` (auth.ts logs only token prefixes — no secret values ever appear in logs).
   - `host_sid` cookie present in the browser (devtools → Application → Cookies).
   - `curl -s -o /dev/null -w "%{http_code}" -b "host_sid=<value>" http://localhost:3000/api/spotify/playlists` returns `200` and the body shows real playlist names; captured output contains no token values.

Expected evidence row (to be filled by the human-driven sweep):

| Check | Result |
|---|---|
| `token_exchange_ok` in server log | NEEDS-HUMAN |
| `token_exchange_failed` absent | NEEDS-HUMAN |
| host_sid cookie present, /api/spotify/playlists → HTTP 200 with real playlist names | NEEDS-HUMAN |

## 3. Real playlist import (WS room + POST /api/spotify/select)

NEEDS-HUMAN (depends on §2 consent). Procedure:

1. Create a room via the host page WebSocket flow; note the room code.
2. `POST /api/spotify/select` with `{ "roomCode": "<code>", "playlistId": "<real playlist id>", "speakerName": "<real Connect speaker NAME>" }` (speakerName matches case-insensitively in PlaybackService).
3. Expected after T01 fix: HTTP 200 `{ ok: true, eligibleCount: <n> }` — **not** the old `"no room with that code"` error. The T01 fix (persist.ts `roomExistsInDb`/`loadHostBinding` fallbacks in game.ts `registerHostPlaylist`/`ensurePlayback`/`startGame`) is proven by tests/host-binding-route-split.test.ts (evidence `3402b6ef…`), so the route-instance/WS-instance split no longer blocks this call.
4. Sweep server log for `playlist_registered` with eligible/total counts.

Expected evidence row:

| Check | Result |
|---|---|
| select returns 200 `{ok:true, eligibleCount}` (not "no room with that code") | NEEDS-HUMAN (T01 fix proven by test evidence `3402b6ef…`) |
| `playlist_registered` log with eligible/total counts | NEEDS-HUMAN |

## 4. Gates

### Failure Modes

External dependencies of this evidence task and their failure paths (as implemented in the server):

- **Spotify OAuth token exchange** (`/api/auth/callback`): network failure, malformed body, or Spotify error response → `token_exchange_failed` is logged (prefixed token only, no secrets) and the callback returns an error to the host page; no crash.
- **Spotify Web API (fetch playlists, fetch playlist tracks)**: non-200 or timeout → `/api/spotify/select` and `GET /api/spotify/playlists` return structured HTTP error responses; `registerHostPlaylist` surfaces fetch failure as a `game_error`-style response rather than a hang.
- **Module-instance split (MEM022 root cause)**: WS instance missing a route-registered binding → `loadHostBinding(roomCode)` SQLite fallback in `ensurePlayback`/`startGame`; room missing in-memory → `roomExistsInDb(code)` fallback in `registerHostPlaylist` — proven by tests/host-binding-route-split.test.ts (exit 0, 3/3).
- **Missing env secrets**: the Spotify client id/secret env vars unset → OAuth start fails explicitly at the authorize step (documented above as the current NOT-MET precondition; no silent stub fallback was used).

### Load Profile

Omitted — this task is evidence collection against a single-user local instance; no runtime load dimension applies. (For the record: the known first-saturating resource for the game is Spotify Web API rate limiting during playlist track fetches; the server fetches tracks once per select call, pagination-bounded.)

### Negative Tests

- tests/host-binding-route-split.test.ts (evidence `3402b6ef…`): covers the negative path that previously broke the real host flow — calling `registerHostPlaylist` when the in-memory room map does not contain the code (simulating the route-instance split) must succeed via the SQLite `roomExistsInDb` fallback and land the binding in `host_bindings`; `loadHostBinding` must return it for the WS-side fallback consumers.
- The old failure mode (`"no room with that code"` despite a live WS-created room) is exactly what the select call in §3 asserts against.

## 5. Verdicts

| Step | Verdict |
|---|---|
| T01 fix proven on boot path | PASS (test + boot evidence, gsd_exec IDs above) |
| Real OAuth | NEEDS-HUMAN (no secrets in env; no human to drive consent) |
| Real playlist import via /api/spotify/select | NEEDS-HUMAN (blocked on OAuth consent) |

No FAIL verdicts. The human follow-up is exactly: set the two Spotify env vars (via secure_env_collect), drive the OAuth consent once, and run the select call — then paste the log-sweep results (token prefixes only) into §2/§3.

No secrets or token values appear in this file (verified by the task verify command searching this file for the secret env var name and finding no match).

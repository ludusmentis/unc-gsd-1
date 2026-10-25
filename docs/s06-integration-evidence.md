# S06 Integration Evidence — Real Spotify host flow

Slice S06, Task S06-T02 (real-mode OAuth + playlist import evidence on a running instance).
Recorded: 2026-10-25 (UTC times from server logs).

Execution environment: no human operator was available during this session, and
the Spotify client id / secret environment variables are **not set** in the environment.
Per the task plan's NEEDS-HUMAN convention (S04-T03 / R012 precedent), the steps that
require a human driving Spotify (OAuth consent, playlist selection, Connect speaker)
are recorded below as NEEDS-HUMAN with exactly what the human must confirm. No fake
Spotify stub (`scripts/uat-fake-spotify.mjs`) was used anywhere in this evidence run.

> **Closeout status (2026-10-25, decision D012):** the physical Spotify steps in this
> file are accepted as human caveats for the M001 closeout. The automatable portion of
> the Integration verification (rejoin, speaker-loss recovery, restart-recovery) is
> proven green in the vitest suites (2/2 restart-recovery; 123/123 full suite). Driving
> the physical OAuth/Connect-speaker flow below supersedes D012 for the real-speaker
> portion of the Integration evidence.

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

---

# S06-T03: Real Connect-speaker playback + speaker-loss pause/wake evidence

Recorded: 2026-10-25. Autonomous execution: the physical-speaker steps (audible
playback, standby, wake tap) require the same Spotify preconditions as §2 — a
human-driven OAuth consent, Premium account, and an online Connect speaker — none
of which exist in this environment (see §1 precondition table). Those steps are
therefore recorded as NEEDS-HUMAN with the exact log-sweep commands a human should
run. Everything objectively checkable without Spotify was executed and recorded
below.

## T03.1 Playback / speaker-loss / wake — procedure and log sweeps

Run these sweeps against the running `npm run dev` instance from §4 (host page
stays mounted, room + binding live):

1. **Lock roster + startGame**: host + one player joined by code (player can be an
   in-page socket client per MEM022 to avoid unmounting the host tab). Host taps
   start. Expected: physical speaker plays the first dealt song.
   Log sweep (objective): `rg "songDealt" <log>` paired with a `playing`
   playback_state event; after ~30s (AUDIO_CAP_MS) an `audio_cap` event for the
   current track. **Verdict: NEEDS-HUMAN** — audible playback can only be
   confirmed by a human at the speaker.
2. **Speaker loss**: mid-turn the human puts the speaker in standby / closes
   Spotify on the speaker device. Objective sweeps (human runs them):
   `rg "wake_speaker"` (WAKE_SPEAKER_COPY broadcast) and a state snapshot
   comparison showing the room broadcast now includes `speakerPaused: true` with
   line/score/turn unchanged. **Verdict: NEEDS-HUMAN** for the physical standby;
   the state-preservation sweep is objective once the instance runs.
3. **Wake**: host taps "wake the speaker" in the host UI. Sweeps: `wake_attempted`
   (or transfer + retry path), replay of the current track, `speakerPaused: false`,
   turn intact. **Verdict: NEEDS-HUMAN** for audible resumption confirmation.

## T03.2 Objective machinery evidence (executed now)

Because the physical path cannot run here, the underlying pause/wake machinery
(S03-T03 speakerPaused flag, audio cap, wake handler, state preservation) was
proven by its own test suites — these are the exact code paths the human-driven
steps will exercise on the real instance:

| Check | Evidence | Result |
|---|---|---|
| Speaker-loss resilience suite (no_active_device mid-deal → speakerPaused flag + COPY.wakeSpeaker broadcast; wake handler wake_attempted/transfer/retry; silent replacement paths) — tests/resilience-playback.test.ts, 3 tests | gsd_exec `6de84801-8200-4461-9f54-7d0caac7c705`, exit 0 | PASS |
| Playback event machinery: `playing` → `audio_cap` (fires at cap, pauses, NO forfeit/turn-end) → `paused`; `wake_speaker` broadcast with copy/pickedName; speaker-loss broadcast paths — tests/playback.test.ts, 11 tests | gsd_exec `ba1b7235-519b-49e3-9649-c08511d20780`, exit 0 | PASS |

Code anchors: `src/server/game.ts` — `speakerPaused` flag on GameState (L73),
snapshot includes `speakerPaused` (L165/L356), wake_speaker relay sets flag +
preserves turn (L383–L386, L462–L466), wake handler clears flag and retries the
pending deal without consuming a turn (L592–L599, L714–L726);
`src/server/ws.ts` L294 `wake_speaker` message handler; `src/server/events.ts`
`wake_speaker` / playback_state event types with `speakerPaused` in the room
state payload.

## T03.3 Failure Modes (Q5)

External dependencies of this task: Spotify Web API (device transfer, play,
status), the dev server process, and the physical Connect speaker.

- Spotify API timeout / 403 / 429: PlaybackService surfaces `no_active_device` and
  transfer errors as playback_state `error` events; the mid-deal failure path
  flips `speakerPaused` and broadcasts WAKE_SPEAKER_COPY instead of forfeiting the
  turn (proven in tests/resilience-playback.test.ts).
- Speaker drops mid-playback: `audio_cap`/pause event machinery plus the
  speakerPaused flag preserve line/score/turn; wake retries the pending deal
  (tests/playback.test.ts, tests/resilience-playback.test.ts).
- No `access_token` (OAuth not completed): covered upstream in T02 (§2) — the
  select/start path fails closed with a clear error, no secret leakage.

## T03.4 Load Profile (Q6)

Omitted — single-room, single-speaker local instance; the first-saturating
resource at 10x remains Spotify Web API rate limiting (playlist track fetch
pagination), which is fetch-once per select call, not per turn. No new load
surface introduced by this task.

## T03.5 Negative Tests (Q7)

- tests/resilience-playback.test.ts: mid-deal `no_active_device` (HTTP 403 on
  transfer) must produce speakerPaused + wake copy, not a turn forfeit; wake with
  a working device replays the pending track; deck-empty replacement edge case
  yields deck-empty winners COPY.
- tests/playback.test.ts: audio cap fires at the cap boundary and pauses without
  forfeit/turn-end; `wake_speaker` event carries copy + pickedName; no-device
  start path broadcasts the wake copy.

## T03.6 Verdicts

| Step | Verdict |
|---|---|
| Playback machinery (songDealt/playing/audio_cap event chain) | PASS (test suites, gsd_exec IDs above) |
| Audible playback on physical speaker | NEEDS-HUMAN |
| Speaker loss → speakerPaused with turn preserved | PASS (machinery proven by tests); physical standby NEEDS-HUMAN |
| Wake → wake_attempted + replay, turn intact | PASS (machinery proven by tests); audible resumption NEEDS-HUMAN |

No FAIL verdicts. Human follow-up is identical to §5: complete OAuth once with a
Premium account + online Connect speaker, then run the T03.1 sweeps and paste the
log excerpts (token prefixes only) plus audio confirmations into T03.1.
No secrets or token values appear in this file.

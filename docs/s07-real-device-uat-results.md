# S07 Real-Device UAT Results — Unraid deploy + game night

Slice S07 (Unraid + tunnel deploy, real-device UAT night, R018 bookkeeping).
Scaffolded by S07-T01 on 2026-10-25. All on-device and deploy rows start as
**NEEDS-HUMAN**; nothing in this file may be fabricated. No secrets or token
values appear here (client ids/secret names are referenced by env-var name only).

Execution environment: autonomous session, no human operator and no live Unraid
deployment available yet. Per the NEEDS-HUMAN convention (S04-T03 / R012, and
docs/s06-integration-evidence.md), human-required rows carry the exact commands
or procedure to run.

## 1. Pre-flight automatable checks

These can be run by the executor once the stack is up at https://un.clord.org.
Until then they remain NEEDS-HUMAN with the exact commands.

| Check | Command | Result | Evidence |
|---|---|---|---|
| Deploy smoke (HTTP + socket.io create/join + room_not_found) | `BASE_URL=https://un.clord.org node scripts/verify-deploy.mjs` | NEEDS-HUMAN | run via gsd_exec once stack is up; paste exit code + VERIFY-OK lines |
| Root page 200 | `curl -sS https://un.clord.org/` | NEEDS-HUMAN | paste status/first lines |
| socket.io polling handshake | `curl -i -N "https://un.clord.org/socket.io/?EIO=4&transport=polling"` | NEEDS-HUMAN | expect HTTP 200 + engine.io payload |
| Container listening log | `docker logs nursehound` (human-run on Unraid) | NEEDS-HUMAN | paste `{"event":"listening"}` line verbatim |
| Local restart-recovery suite (R018-contradicting evidence) | `npx vitest run tests/restart-recovery.test.ts` (the plan's `node --test` fails with ERR_MODULE_NOT_FOUND — vitest is the repo's actual runner, see `npm test`) | PASS — 2 tests / 2 pass (restart mid-game rejoin, host Spotify works without re-auth), gsd_exec dc8b5e10-1b67-4079-b392-cd2cfc41bff2, 2026-10-25 | note: suite totals 2 test blocks here; the 120/120 figure refers to the full `npm test` suite |

## 2. Remote reachability evidence (Cloudflare Tunnel → Unraid)

Blocked on a human executing DEPLOY.md on Unraid: docker compose up with
env-only secrets (Spotify client id/secret, set by env-var name only — values never recorded here), cloudflared tunnel
to `http://unraid-host:3000`, hostname bind (`un.clord.org`) in Zero Trust,
Spotify dashboard redirect `https://un.clord.org/api/spotify/callback`.

Executor probe on 2026-10-25 confirmed the stack is not yet up:
`curl -sS https://un.clord.org/` failed with `curl: (6) Could not resolve
host: un.clord.org` (gsd_exec 40f3ef53-b265-4414-a952-51b7b1163152), and
`BASE_URL=https://un.clord.org node scripts/verify-deploy.mjs` exited 1 after
printing `VERIFY-OK: target https://un.clord.org (remote)` and failing at the
HTTP root check (gsd_exec d3a5512c-6712-420d-ba76-6a17b768b9ec). All rows
below stay NEEDS-HUMAN with exact retry commands.

| Step | Result | Evidence |
|---|---|---|
| docker compose stack up on Unraid | NEEDS-HUMAN | per DEPLOY.md; confirm `docker logs nursehound` shows listening event |
| Cloudflare tunnel hostname bound | NEEDS-HUMAN | `cloudflared tunnel route dns` / Zero Trust dashboard |
| Spotify dashboard redirect URI registered | NEEDS-HUMAN | `https://un.clord.org/api/spotify/callback` |
| `BASE_URL=https://un.clord.org node scripts/verify-deploy.mjs` → exit 0 | NEEDS-HUMAN | attempted 2026-10-25: exit 1, DNS unresolvable (gsd_exec d3a5512c-6712-420d-ba76-6a17b768b9ec); retry once stack is up |
| `curl -sS https://un.clord.org/` → 200 | NEEDS-HUMAN | attempted 2026-10-25: `curl: (6) Could not resolve host` (gsd_exec 40f3ef53-b265-4414-a952-51b7b1163152); re-probed during T03 on 2026-10-25: still exit 6, HTTP 000 (gsd_exec 96c72f76-b6eb-49fa-ba73-9eb4b98b113b); retry once stack is up |
| socket.io polling curl → 200 engine.io | NEEDS-HUMAN | raw output |
| MEM022 host-playlist symptom check through tunnel | NEEDS-HUMAN | if `/api/spotify/select` shows empty rooms map → record finding, route to replan (S06 SQLite fallbacks in src/server/persist.ts should cover) |

## 3. Game-night UAT checklist (per docs/real-device-uat.md)

Devices: record device model + browser version per column. Verdicts: PASS
(with evidence/screenshots), FAIL (with finding → replan), NEEDS-HUMAN.

Host page must stay mounted while live (MEM022, HOST_LEAVE_GRACE_MS=2000).

### 0. Pre-flight

| Check | Verdict | Device / Browser | Evidence |
|---|---|---|---|
| `curl -sS https://un.clord.org/` returns 200 with root page marker | NEEDS-HUMAN | — | |
| WS handshake reaches app (`BASE_URL=https://un.clord.org node scripts/verify-deploy.mjs`) | NEEDS-HUMAN | — | |
| Spotify dashboard has `https://un.clord.org/api/spotify/callback` registered | NEEDS-HUMAN | — | |
| Friend accounts in Spotify app allowlist (per DEPLOY.md) | NEEDS-HUMAN | — | |
| Container running on Unraid; `docker logs nursehound` shows `{"event":"listening"}` | NEEDS-HUMAN | — | |

### 1. Full game — iOS Safari (portrait)

| Check | Verdict | Device / Browser | Evidence |
|---|---|---|---|
| Create room → 5-letter broadcast code appears | NEEDS-HUMAN | | |
| Lobby shows host + all joined players | NEEDS-HUMAN | | |
| Long-press drag & drop timeline placement works on touch (no scroll hijack) | NEEDS-HUMAN | | |
| Forfeit (skip) reveals the track position correctly | NEEDS-HUMAN | | |
| Next-handover advances to the next speaker/round | NEEDS-HUMAN | | |
| Winner screen shows correct ranking after final round | NEEDS-HUMAN | | |

### 2. Full game — Android Chrome (portrait)

| Check | Verdict | Device / Browser | Evidence |
|---|---|---|---|
| Join room by broadcast code from a second real phone | NEEDS-HUMAN | | |
| Same drag & drop, forfeit reveal, handover, winner checks as iOS | NEEDS-HUMAN | | |
| Both phones stay in sync through the whole game (no stale screens) | NEEDS-HUMAN | | |

### 3. On-device resilience

| Check | Verdict | Device / Browser | Evidence |
|---|---|---|---|
| Phone-lock rejoin: lock guest phone mid-round, unlock ~30s later → state resyncs (no lost round, no duplicate player) | NEEDS-HUMAN | | |
| Speaker-loss wake: speaker's phone airplane mode ~15s, reconnects → hand restores, game continues | NEEDS-HUMAN | | |
| Host-leave pause/resume: host disconnects → pause notice for everyone; host rejoins (same identity) → resumes from same point | NEEDS-HUMAN | | |

### 4. Production wiring

| Check | Verdict | Device / Browser | Evidence |
|---|---|---|---|
| Spotify login flow completes through the tunnel (redirect back to un.clord.org) | NEEDS-HUMAN | | |
| No secrets visible in the browser (IDs only, no client secret) | NEEDS-HUMAN | | |
| Game survives a container restart (bind-mount persists rooms/DB — optional stretch) | NEEDS-HUMAN | | |

## 4. Optional S06 §2/§3 physical Spotify sweep co-capture

While the instance is live on game night, co-capture the S06 NEEDS-HUMAN
sweeps (docs/s06-integration-evidence.md §2/§3) and paste log excerpts here
(token prefixes only, no secret values):

| Check | Log anchor | Verdict | Evidence |
|---|---|---|---|
| OAuth token exchange succeeded | `token_exchange_ok` (and no `token_exchange_failed`) | NEEDS-HUMAN | |
| Playlist selected / registered for room | `playlist_registered` (eligible/total counts) | NEEDS-HUMAN | |
| Song dealt to speaker | `songDealt` | NEEDS-HUMAN | |
| Physical playback started | `playing` | NEEDS-HUMAN | |
| Audio cap fired (~30s) without forfeit | `audio_cap` | NEEDS-HUMAN | |
| Speaker-loss wake broadcast handled | `wake_speaker` | NEEDS-HUMAN | |

## 6. Failure Modes (Q5)

External dependencies of this evidence task (T03) and their failure paths:

- **Network reachability of https://un.clord.org (Cloudflare Tunnel)**: re-probe via curl failed with exit 6 (DNS resolution failure), recorded verbatim in §2 with gsd_exec evidence ID — the failure path is explicit and rows stay NEEDS-HUMAN rather than being fabricated.
- **Filesystem (results doc)**: the mechanical secret-hygiene check (`rg -q` for the secret env-var name) previously tripped on the env-var *name* in §2 prose; failure path = verify command exits 1. Fixed by rewording to prose ("Spotify client id/secret"); no secret value ever appeared.
- **No human operator**: the entire on-device checklist is human-dependent; the recorded failure path is the NEEDS-HUMAN convention with the exact procedure per line (S04-T03/R012 precedent), not fabricated PASS rows.

## 7. Load Profile (Q6)

Omitted — this task records evidence on a single-room, human-driven instance; no runtime load dimension applies. (Known first-saturating resource at scale remains Spotify Web API rate limiting on playlist track fetch, per S06 evidence.)

## 8. Negative Tests (Q7)

- Secret hygiene negative check: `! rg -q "<secret env-var name>" docs/s07-real-device-uat-results.md` (name not spelled here to keep the check self-consistent) — asserts the secret env-var name (and thus any accidental value) is absent from the recorded evidence. Run 2026-10-25: no match, check exits 0 via negation. Post-fix re-run 2026-10-25: exit 0 (gsd_exec d5b1b4a8-22d0-451b-8a7d-188f3851bfd4). The first run (gsd_exec 3e164e5b-7b89-4171-9119-df9adf69dc03, exit 1) failed only because §8 itself quoted the env-var name; reworded, no secret value ever appeared.
- Fabrication guard: every PASS row in this doc carries a gsd_exec evidence ID or verbatim log excerpt; on-device rows without a human verdict remain NEEDS-HUMAN by construction (§3), matching the S04-T03/R012 no-fabrication precedent.

## 9. R018 supersession note

R018 is superseded at slice closeout (complete-slice), covered by R022/D008;
restart-recovery test evidence recorded in §1 supports the supersession notes
("covered by R022/D008; restart-recovery test green"). No requirement
terminalization happens in this task.

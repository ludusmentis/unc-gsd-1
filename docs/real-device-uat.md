# Real-Device UAT Checklist — R012

**Milestone:** M001 · **Slice:** S04 · **Evidence type:** NEEDS-HUMAN
**Target:** https://un.clord.org (Cloudflare Tunnel → Unraid docker-compose)
**Devices:** real iOS Safari (portrait) + real Android Chrome (portrait)

> **Closeout status (2026-10-25, decision D012):** this checklist is an accepted
> human caveat for M001 closeout — it is the superseding path to live proof, not
> an open blocker. The milestone closed on the automated suites (123/123), the
> local Docker container deploy-smoke, and the real-browser three-client flow.
> Completing this checklist and recording results in
> `docs/s07-real-device-uat-results.md` supersedes D012 and restores live
> verification for R011/R012.

This checklist is the human verification path for R012 (real-device play) and
the resilience requirements. Automated evidence covers only reachability and the
WS smoke (scripts/verify-deploy.mjs); everything below requires a person on a
real phone. Record PASS/FAIL per line, with notes; screenshot failures.

---

## 0. Pre-flight (any machine)

- [ ] `curl -sS https://un.clord.org/` returns HTTP 200 with the root page marker
- [ ] WS handshake reaches the app: connect to `https://un.clord.org/socket.io/` (path `/game` namespace) and observe a successful upgrade (e.g. run `BASE_URL=https://un.clord.org node scripts/verify-deploy.mjs`) — tunnel passes WebSockets and preserves the Host header
- [ ] Spotify dashboard has `https://un.clord.org/api/spotify/callback` registered as a redirect URI
- [ ] Friend accounts added to the Spotify app allowlist (per DEPLOY.md) before game night
- [ ] Container running on Unraid; `docker logs nursehound` shows structured JSON `{"event":"listening"}`

## 1. Full game — iOS Safari (portrait)

Host the room from one phone (or the same phone):

- [ ] Create room → 5-letter broadcast code appears
- [ ] Lobby shows host + all joined players
- [ ] Long-press drag & drop timeline placement works on touch (no scroll hijack)
- [ ] Forfeit (skip) reveals the track position correctly
- [ ] Next-handover advances to the next speaker/round
- [ ] Winner screen shows correct ranking after final round

## 2. Full game — Android Chrome (portrait)

- [ ] Join room by broadcast code from a second real phone
- [ ] Same drag & drop, forfeit reveal, handover, and winner checks as iOS
- [ ] Both phones stay in sync through the whole game (no stale screens)

## 3. On-device resilience

- [ ] **Phone-lock rejoin:** lock a guest's phone mid-round, unlock ~30s later → state resyncs (no lost round, no duplicate player)
- [ ] **Speaker-loss wake:** speaker's phone loses network (airplane mode ~15s), reconnects → their hand restores and game continues
- [ ] **Host-leave pause/resume:** host disconnects → game pauses for everyone with a clear notice; host rejoins (same identity) → game resumes from the same point

## 4. Production wiring

- [ ] Spotify login flow completes through the tunnel (redirect back to un.clord.org)
- [ ] No secrets visible in the browser (IDs only, no client secret)
- [ ] Game survives a container restart (data bind-mount persists rooms/DB — optional stretch)

---

**Closeout:** attach this completed checklist (with device models + browser versions) as the NEEDS-HUMAN UAT evidence for S04 slice closeout. Any FAIL blocks R012 sign-off.

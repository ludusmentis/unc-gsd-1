# Requirements & Quality Bar

## Active Requirements

| ID | Requirement | Owner |
|---|---|---|
| R001 | Host creates a game from a Spotify playlist (OAuth, playlist + speaker pick, shuffled deck, room code) | M001/S01 |
| R002 | Players join via room code; no accounts | M001/S01 |
| R003 | Dealt song plays on shared Spotify speaker until placed (~30s cap) | M001/S01 |
| R004 | Personal chronological line, seeded with one anchor song | M001/S01 |
| R005 | Pairwise scoring; forfeit with reveal; first-to-10 win; longest-line fallback; shared victory on tie | M001/S02 |
| R006 | Live WebSocket sync of turns, lines, scores, playback on every phone | M001/S02 |
| R007 | Full game loop: turn rotation, idle nudges, host skip, winner screen | M001/S02 |
| R008 | Idiot-proof failure recovery; never a technical error or dead end | M001/S03 |
| R009 | Rejoin via room code restores line, score, turn exactly | M001/S03 |
| R010 | Gen Z voice for all user-visible copy | M001/S03 |
| R011 | Docker container deployable on Unraid via Cloudflare Tunnel at un.clord.org | M001/S04 |
| R012 | Verified on real phones: iOS Safari + Android Chrome, portrait | M001/S04 |
| R013 | Unplayable/date-less tracks silently skipped and replaced | M001/S03 |
| R014 | Lobby shows players (2–8) and playlist; roster locks at start | M001/S01 |
| R015 | Only tracks with unambiguous release dates enter the deck | M001/S01 |

## Deferred

- R016 — Multiple concurrent game rooms on one instance.

## Out of Scope

- R017 — No matchmaking, internet-remote play, player accounts, or
  cross-internet real-time competition.

## Quality Bar

### Test Strategy
- **Unit (exhaustive):** scoring logic — pairwise ordering, forfeit, anchor
  seeding, win conditions, deck filtering. Pure logic, must never be wrong.
- **Integration:** room join and turn sync via WebSocket with simulated
  multi-client sessions; Spotify API mocked with fixtures.
- **Manual / real environment:** actual Spotify login, playlist, and playback
  on a real speaker; a real group playing a full game. This cannot be honestly
  automated.

### Definition of Done (M001)
- A real group plays a full game on their phones with real Spotify playback
  through `un.clord.org` — nothing in the flow requires technical knowledge.
- All error paths behave per the UX spec; all copy in Gen Z voice.
- Docker image builds and runs on Unraid, reachable via the tunnel.
- Scoring unit tests green; sync integration tests green.

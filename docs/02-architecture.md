# Architecture Spec

## 1. Shape

A **single Node.js web application** serving:

- the mobile web UI (players' phones),
- a WebSocket server for real-time game state sync,
- Spotify OAuth (authorization-code flow — the client secret must live
  server-side),
- Spotify Web API calls (playlists, playback control).

## 2. Host Model

1. Host opens `https://un.clord.org`, logs in with **Spotify OAuth**
   (redirect URI registered on that domain).
2. Host picks a **playlist** and a **speaker device** (their Spotify Connect
   device).
3. App shuffles eligible tracks into the deck and creates a **room with a
   short join code**.
4. Players join from their phones by entering the code. No accounts; identity is
   a session token kept on the phone.
5. Host is also a regular player; hosting adds no advantage or burden.

## 3. Audio Model — Shared Speaker via Spotify Connect

- The server commands the host's Spotify device via the Player API
  (`PUT /me/player`, `PUT /me/player/play`, etc.).
- **No audio ever streams from our app.** Spotify's own client plays the
  tracks; the group hears them together.
- Requirements: host has **Spotify Premium**; players need no accounts.
- Alternatives considered and rejected:
  - *Web Playback SDK per phone* — every player would need Premium and private
    audio; wrong for a shared-room party.
  - *30s preview clips per phone* — private audio again, weaker experience.
  - *Peer-to-peer / local-only server* — the Cloudflare tunnel already exists
    and a server massively simplifies OAuth and sync.

## 4. Live Sync

- WebSocket connection per phone.
- Server is the single source of truth for: room membership, deck order,
  turn rotation, each player's line, scores, playback events.
- Every client mirrors state changes (turn taken, song placed, forfeit reveal,
  scores) in real time.

## 5. Deployment

- Ships as a **Docker container** for the user's **Unraid** home server.
- Exposed to the internet through the existing **Cloudflare Tunnel** at
  `https://un.clord.org`.
- Cloudflare terminates TLS; WebSockets pass through the tunnel unchanged.

## 6. Spotify App Constraints

- A Spotify **developer app** with registered redirect URI
  (`https://un.clord.org/...`) is required.
- In development mode the app is restricted to an **allowlist of Spotify
  accounts** — the host adds friends' emails so they can all log in if they
  ever host. (Only the host actually logs in to play.)
- Premium-only playback applies to the host account.
- Token handling: refresh tokens used with automatic silent refresh; session
  must survive an hours-long game night.

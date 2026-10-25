# Game Design Spec — Song Timeline Party Game

> Same-room party game where friends sort songs chronologically.

## 1. Pitch

A group of friends in the same room plays a music game on their phones.
A Spotify playlist defines the game's songs — shuffled into a deck, like a card
game. On your turn you're dealt one song that plays on a shared speaker, and you
slot it into your personal chronological line. Place it right and it scores;
place it wrong and you lose it (but learn where it belonged). First to 10
correct placements wins.

## 2. Players & Context

- **2–8 players**, each on their own phone (mobile web, no install).
- Same room; turns are hotseat-style (not simultaneous).
- Only the **host** needs a Spotify Premium account. Players need nothing.
- Explicitly out of scope: matchmaking, internet-remote play, player accounts,
  real-time competitive network play.

## 3. Game Flow

### 3.1 Lobby
1. Host opens the app, logs in with Spotify, picks a playlist and their speaker
   device, and creates a room with a short join code.
2. Players open the app on their phones, enter the code, and appear in the
   lobby. The lobby shows all joined players and the chosen playlist.
3. Host starts the game — the roster is **locked** at this point (no mid-game
   joins; a late friend means a fresh game).

### 3.2 Setup
- The playlist's tracks are shuffled into a **deck (stack)**.
- Tracks that cannot be played, or whose release dates are missing/imprecise,
  are filtered out silently before the game starts.
- Each player's personal line is **seeded with one face-up anchor song** so
  every placement is a real decision from turn one.

### 3.3 Turn
1. The active player is dealt **one song** from the deck.
2. The song plays on the shared speaker (via Spotify remote control) from the
   deal until the player places it, capped at ~30 seconds.
3. The player slots the song into their personal chronological line on their
   phone. All phones show the active player's line and move live.
4. **No turn timer.** Idle players get gentle nudges on all phones; the host
   can skip a stalled turn — that is the only stall-breaker.

### 3.4 Scoring
- A placed song is **correct iff it is correctly ordered (pairwise) against
  every song already in the player's line** — a correctly ordered pair scores.
- **Correct:** the song scores and stays in the line.
- **Wrong:** the song is **forfeited** — no score. The correct placement is
  revealed first (learning moment), then the song is discarded.

### 3.5 End of Game
- **Normal win:** the first player to accumulate **10 correctly placed songs**
  wins.
- **Deck exhausted first:** the player with the **longest correct line** wins.
- **Tie:** **shared victory** — it's a draw.

## 4. Content Source

- One Spotify playlist = one game's content. Curation happens outside the app.
- Release dates come from Spotify's track/album metadata; only tracks with
  unambiguous chronological dates are usable.

## 5. Tone

All user-visible copy uses **Gen Z terminology**: short, playful,
emoji-friendly. One sentence plus one button. Never corporate, never technical.
Examples: "Spotify's being moody 💀 — hit this to fix it", "that's rough 🫠",
"W, gg".

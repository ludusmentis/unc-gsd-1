# UX & Error-Handling Spec

## Design Rule

The app is for **non-technical users**. It never shows a technical error, a
stack trace, an error code, or a dead end. Every failure either resolves
itself or presents exactly one plain-language action. Every screen has one
obvious next step.

## Voice

**All user-visible copy in Gen Z slang**: short, playful, emoji-friendly.
One sentence + one button. Examples:
- Speaker lost: "Spotify's being moody 💀 — hit this to fix it"
- Reconnecting: "sec, reconnecting…"
- Wrong placement: "that's rough 🫠 — it goes here:"
- Win: "W, gg"

## Failure Matrix

### Spotify / playback
| Failure | Behavior |
|---|---|
| Token expiry mid-game | Silent auto-refresh; session survives the whole night |
| Speaker disconnects / goes quiet | Game **pauses**; phones show one-tap retry; no turn lost |
| Unplayable track (local file, unavailable, no usable date) | **Silently skipped** and replaced with next deck card; nobody sees anything |
| API hiccup (rate limit, 5xx) | Automatic retry with backoff; host sees one plain sentence + retry button only if it persists |

### Players
| Failure | Behavior |
|---|---|
| Phone locks / tab closes / battery dies / connection drops | Rejoin with the same room code; line, score, and turn position restored exactly |
| Player idle on their turn | Gentle nudges on all phones; host can skip the turn |
| Accidental double-taps | No irreversible action without confirmation; a line can never be corrupted |

### Session
| Failure | Behavior |
|---|---|
| Host leaves | Game pauses: "waiting for host 👀"; host rejoin restores the game; explicit end-game path so players are never stranded |
| Lobby under/overflow | 2–8 players enforced; roster locked at start |

## UX Principles

- Joining = typing one code. Nothing else is ever typed.
- No logins for players. No settings surfaced during a game.
- Reveal moments (forfeit, winner) are shared spectacles on every phone.

## Interaction Decisions (grilled & confirmed)

1. **Placement is drag & drop** (user choice) — with oversized touch targets,
   clearly highlighted drop zones between songs, and a scroll-safe gesture
   (long-press-to-lift or handle) so it never fights the page.
2. **Drop = answer.** Placement commits immediately on drop; no confirm step,
   no undo (prevents brute-force re-placing).
3. **Turn handover:** the player who just went taps a "next 🔜" button on their
   phone; no auto-advance countdown.
4. **Year visibility:** years on a player's already-placed songs are visible to
   them (their line is an informative timeline); the dealt song's year is
   hidden until placed, then revealed on placement (correct or forfeit).
5. **Watcher screen:** current song card (they hear it anyway) + one random
   Gen Z commentary line from a pool of ~50 ("bro is thinking hard 🤔"),
   + scores. No live view of the active player's line.

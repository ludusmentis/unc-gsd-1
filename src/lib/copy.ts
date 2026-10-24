/**
 * Gen Z copy — single source of truth for every client-facing message.
 * Never raw errors, never English-teacher text (slice verification contract:
 * client errors funnel to one recovery path).
 */

export const COPY = {
  connectSpotifyFirst: {
    error: 'connect spotify first',
    recovery: 'tap "connect spotify" on the host screen',
  },
  spotifyLinkExpired: {
    error: 'spotify link expired',
    recovery: 'reconnect spotify on the host screen',
  },
  playlistTooSmall: {
    error: 'that playlist is too smol, pick a bigger one',
    recovery: 'host: pick a playlist with more day-precise tracks',
  },
  noPlaylist: {
    error: 'host hasnt locked a playlist yet',
    recovery: 'host: pick one in the lobby',
  },
  needMorePlayers: {
    error: 'need at least 2 players',
    recovery: 'share the room code with a friend',
  },
  wakeSpeaker: {
    error: "speaker's asleep rn",
    recovery: 'host: tap to wake it up',
  },
  stillSleepy: {
    error: 'still sleepy, give it a sec and try again',
    recovery: 'host: tap wake again',
  },
  playbackFail: {
    error: 'speaker said no',
    recovery: 'host: try starting again',
  },
  gameStarted: 'locked in — first song incoming',
  nudge: "bestie the song's still playing — place it rn",
  skip: 'host skipped the vibe — next song incoming',
  forfeitReveal: 'nah — it dropped in {year}, it goes right there',
  handover: 'locked in — tap next 🔜 when ready',
  win: 'W 🏆 first to 10 — run it back?',
  winShared: 'tied W 🏆 — y\'all both ate, run it back?',
  lose: 'L 😩 — the timeline was undefeated, run it back?',
  next: 'next 🔜',
  skipHost: 'skip 🔀',
  deckEmpty: 'outta songs — longest timeline takes the W 🏆',
} as const;
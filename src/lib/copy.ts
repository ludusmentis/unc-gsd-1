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
} as const;
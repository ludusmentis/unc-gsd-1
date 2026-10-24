// Shared WS event schema (server-authoritative). All gameplay state flows
// server -> client via broadcasts; client -> server only via actions that
// carry the session token issued at join time.

export type SessionToken = string;

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
}

export interface RoomState {
  code: string;
  status: 'lobby' | 'locked' | 'in_progress' | 'ended';
  players: Player[];
  maxPlayers: number;
  minPlayers: number;
  playlistName: string | null;
}

// ---- client -> server actions ----
export type ClientAction =
  | { type: 'create_room'; name: string }
  | { type: 'join_room'; code: string; name: string }
  | { type: 'leave_room' }
  | { type: 'lock_roster' }
  | { type: 'place_song'; trackId: string; slotIndex: number }
  // placeholder game action for the mocked loop; S01 keeps server-authoritative gating
  | { type: 'ping_state' }
  | { type: 'wake_speaker' };

/** Envelope for any client action: forged actions without a valid session
 * token bound to the socket's identity are rejected. */
export interface ActionEnvelope {
  token: SessionToken;
  action: ClientAction;
}

export type ServerError = { error: string; recovery?: string };

/** Track summary the server broadcasts with deal/placement events. */
export interface TrackSummary {
  id: string;
  name: string;
  artists: string[];
  albumName: string;
  releaseDate: string;
  year: string;
}

// ---- server -> client events ----
export type ServerEvent =
  | { type: 'joined'; room: RoomState; you: Player; token: SessionToken }
  | { type: 'room_created'; room: RoomState; you: Player; token: SessionToken }
  | { type: 'lobby'; room: RoomState }
  | { type: 'roster_locked'; room: RoomState }
  | { type: 'game_started'; room: RoomState }
  | { type: 'song_dealt'; track: TrackSummary; anchors: Record<string, TrackSummary> }
  | { type: 'game_error'; error: string; recovery?: string }
  | { type: 'playback_state'; state: 'playing' | 'paused' | 'audio_cap' | 'wake_speaker' | 'error'; copy?: string; message?: string }
  | { type: 'song_placed'; playerId: string; trackId: string; slotIndex: number }
  | { type: 'rejected'; reason: string; error: string; recovery?: string };

export const ERROR_MESSAGES = {
  invalid_token: { error: 'who are you?? session expired', recovery: 'rejoin the room with the code' },
  room_full: { error: 'this room is packed', recovery: 'wait for the next game' },
  room_not_found: { error: 'no room with that code', recovery: 'check the code on the host screen' },
  room_locked: { error: 'the game already started', recovery: 'ask the host for the next round' },
  bad_name: { error: 'pick a name (1-24 chars)', recovery: 'type your name and try again' },
  not_host: { error: "only the host can do that", recovery: 'chill, wait for the host' },
  bad_action: { error: 'nah, that did nothing', recovery: 'refresh the page' },
  not_your_turn: { error: "not your turn rn", recovery: 'wait for your song' },
} satisfies Record<string, ServerError>;

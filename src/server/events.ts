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
  // handover: the just-played player taps next; host can force-deal
  | { type: 'next_turn' }
  | { type: 'skip_turn' }
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

/** One entry in a player's timeline: track id + full server summary. */
export interface LineEntry {
  trackId: string;
  summary: TrackSummary;
}

/** Full server-authoritative snapshot broadcast after every mutation. */
export interface GameStateSync {
  status: RoomState['status'];
  turn: { playerId: string; track: TrackSummary } | null;
  lines: Record<string, LineEntry[]>;
  scores: Record<string, number>;
  awaitingNext: string | null;
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
  | { type: 'state_sync'; state: GameStateSync }
  | { type: 'turn_result'; playerId: string; track: TrackSummary; slotIndex: number }
  | { type: 'turn_forfeit'; playerId: string; track: TrackSummary; year: string; correctSlots: number[] }
  | { type: 'awaiting_next'; playerId: string }
  | { type: 'game_over'; winnerIds: string[]; reason: 'first_to_10' | 'deck_empty'; copy: string }
  | { type: 'nudge'; playerId: string; copy: string }
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
  not_host_for_skip: { error: 'only the host can skip a turn', recovery: 'let them cook 🎤' },
  not_awaiting_you: { error: "it's not your call rn", recovery: 'wait for the active player' },
  game_not_in_progress: { error: "the game aint running rn", recovery: 'head back to the lobby' },
} satisfies Record<string, ServerError>;

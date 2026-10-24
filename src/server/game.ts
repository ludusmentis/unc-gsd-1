import type { Server as IOServer } from 'socket.io';
import type { Room } from './rooms';
import { getRoom } from './rooms';
import {
  buildDeck,
  eligibleTracks,
  createDealer,
  requiredDeckSize,
  type Dealer,
  type DeckTrack,
} from './deck';
import {
  PlaybackService,
  createPlaybackService,
  type PlaybackEvent,
} from './playback';
import { fetchPlaylistTracks, type SpotifyTrack } from './spotify/api';
import { getValidAccessToken } from './spotify/auth';
import { COPY } from '../lib/copy';
import type { TrackSummary, ServerEvent } from './events';

/**
 * Game orchestrator — wires roster lock to deck build, first deal, playback
 * on the host speaker, pause-on-placement, and round-robin re-deal. The WS
 * layer calls into this module; clients never touch game state directly.
 */

interface HostBinding {
  sessionId: string; // host Spotify session (cookie) — access token lives here
  playlistId: string;
  playlistName: string;
  speakerName: string;
  tracks: SpotifyTrack[] | null; // cached at registration
  eligibleCount: number;
}

interface GameRuntime {
  dealer: Dealer;
  anchors: Map<string, TrackSummary>; // playerId -> anchor song
  playback: PlaybackService;
  current: { playerId: string; track: DeckTrack } | null;
  turnOrder: string[]; // playerId rotation
  turnIdx: number;
}

const bindings = new Map<string, HostBinding>();
const games = new Map<string, GameRuntime>();

// ---- injectable deps (tests mock Spotify here; prod uses the real one) ----

export interface GameDeps {
  getAccessToken(sessionId: string): Promise<string>;
  fetchTracks(accessToken: string, playlistId: string): Promise<SpotifyTrack[]>;
  createPlayback(accessToken: string, speakerName: string, onEvent: (e: PlaybackEvent) => void): PlaybackService;
}

const defaultDeps: GameDeps = {
  getAccessToken: (sid) => getValidAccessToken(sid),
  fetchTracks: (token, playlistId) => fetchPlaylistTracks(token, playlistId),
  createPlayback: (accessToken, speakerName, onEvent) =>
    createPlaybackService({ accessToken, pickedSpeakerName: speakerName, onEvent }),
};

let deps: GameDeps = defaultDeps;

/** Test hook: override Spotify access (mocked Spotify in tests). */
export function configureGameDeps(override: Partial<GameDeps>): void {
  deps = { ...defaultDeps, ...override };
}

export function _resetGamesForTests(): void {
  bindings.clear();
  games.clear();
  deps = defaultDeps;
}

// ---- helpers ----

export function toTrackSummary(t: SpotifyTrack): TrackSummary {
  return {
    id: t.id,
    name: t.name,
    artists: t.artists?.map((a) => a.name) ?? [],
    albumName: t.album?.name ?? '',
    releaseDate: t.album?.release_date ?? '',
    year: (t.album?.release_date ?? '').slice(0, 4),
  };
}

function roomEvent(io: IOServer, roomCode: string, e: ServerEvent) {
  io.of('/game').to(roomCode).emit('event', e);
}

function logGame(roomCode: string, event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'game', room: roomCode, event, ...extra }));
}

/**
 * Host locked in a playlist + speaker (from the select API route, which
 * carries the host session cookie). Fetches + caches playlist tracks once
 * and returns the eligible-track count for the lobby (R019 visibility).
 */
export async function registerHostPlaylist(
  roomCode: string,
  opts: { sessionId: string; playlistId: string; playlistName: string; speakerName: string },
): Promise<{ ok: true; eligibleCount: number } | { ok: false; error: string; recovery?: string }> {
  const room = getRoom(roomCode);
  if (!room) return { ok: false, error: 'no room with that code', recovery: 'check the code' };
  try {
    const accessToken = await deps.getAccessToken(opts.sessionId);
    const tracks = await deps.fetchTracks(accessToken, opts.playlistId);
    const eligibleCount = eligibleTracks(tracks).length;
    bindings.set(roomCode, {
      sessionId: opts.sessionId,
      playlistId: opts.playlistId,
      playlistName: opts.playlistName,
      speakerName: opts.speakerName,
      tracks,
      eligibleCount,
    });
    logGame(roomCode, 'playlist_registered', {
      playlistId: opts.playlistId,
      eligible: eligibleCount,
      total: tracks.length,
    });
    return { ok: true, eligibleCount };
  } catch (err) {
    logGame(roomCode, 'playlist_register_failed', { detail: String(err).slice(0, 120) });
    return { ok: false, ...COPY.spotifyLinkExpired };
  }
}

export function getHostBinding(roomCode: string): { eligibleCount: number; playlistName: string } | null {
  const b = bindings.get(roomCode);
  return b ? { eligibleCount: b.eligibleCount, playlistName: b.playlistName } : null;
}

/**
 * Called by the WS layer right after the host locks the roster. Builds the
 * deck against the final roster (R019), deals the first song, and starts
 * playback on the host speaker. Failures broadcast game_error with copy.
 */
export async function startGame(roomCode: string, io: IOServer): Promise<void> {
  const room = getRoom(roomCode);
  if (!room || room.status !== 'locked') return;
  const binding = bindings.get(roomCode);
  if (!binding || !binding.tracks) {
    // Roster stays locked (late joins stay rejected); host retries start
    // after picking a playlist in the lobby.
    roomEvent(io, roomCode, { type: 'game_error', ...COPY.noPlaylist });
    return;
  }
  const rosterSize = room.players.length;
  const result = buildDeck(binding.tracks, rosterSize);
  if (!result.ok) {
    logGame(roomCode, 'deck_rejected', { eligible: result.eligibleCount, required: result.required });
    roomEvent(io, roomCode, {
      type: 'game_error',
      error: COPY.playlistTooSmall.error,
      recovery: `${COPY.playlistTooSmall.recovery} (got ${result.eligibleCount}, need ${result.required})`,
    });
    return;
  }

  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(binding.sessionId);
  } catch (err) {
    logGame(roomCode, 'token_refresh_failed', { detail: String(err).slice(0, 120) });
    roomEvent(io, roomCode, { type: 'game_error', ...COPY.spotifyLinkExpired });
    return;
  }

  const dealer = createDealer(result.deck);
  const anchors = new Map<string, TrackSummary>();
  for (const p of room.players) {
    const a = result.anchors[room.players.indexOf(p) % result.anchors.length];
    anchors.set(p.id, toTrackSummary(a));
  }
  const playback = deps.createPlayback(accessToken, binding.speakerName, (e) =>
    relayPlayback(io, roomCode, e),
  );
  room.status = 'in_progress';
  room.playlistName = binding.playlistName;
  games.set(roomCode, {
    dealer,
    anchors,
    playback,
    current: null,
    turnOrder: room.players.map((p) => p.id),
    turnIdx: 0,
  });
  logGame(roomCode, 'game_started', { players: rosterSize, deck: result.eligibleCount });
  roomEvent(io, roomCode, { type: 'game_started', room: clientRoom(room) });
  await dealNext(roomCode, io);
}

function clientRoom(room: Room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players,
    maxPlayers: room.maxPlayers,
    minPlayers: room.minPlayers,
    playlistName: room.playlistName,
  };
}

function relayPlayback(io: IOServer, roomCode: string, e: PlaybackEvent) {
  const state =
    e.type === 'playing' ? 'playing'
    : e.type === 'paused' ? 'paused'
    : e.type === 'audio_cap' ? 'audio_cap'
    : e.type === 'wake_speaker' ? 'wake_speaker'
    : 'error';
  roomEvent(io, roomCode, {
    type: 'playback_state',
    state,
    copy: e.type === 'wake_speaker' ? e.copy : undefined,
    message: e.type === 'playback_error' ? e.message : undefined,
  } satisfies ServerEvent);
  logGame(roomCode, `playback_${e.type}`, {
    trackId: 'trackId' in e ? e.trackId : undefined,
    deviceId: 'deviceId' in e ? e.deviceId : undefined,
  });
}

/** Deal the next song to the next player in rotation and start playback. */
export async function dealNext(roomCode: string, io: IOServer): Promise<void> {
  const game = games.get(roomCode);
  const room = getRoom(roomCode);
  if (!game || !room) return;
  const track = game.dealer.deal();
  if (!track) {
    room.status = 'ended';
    roomEvent(io, roomCode, { type: 'lobby', room: clientRoom(room) });
    logGame(roomCode, 'deck_exhausted');
    return;
  }
  const playerId = game.turnOrder[game.turnIdx % game.turnOrder.length];
  game.turnIdx++;
  game.current = { playerId, track };
  const anchorsObj: Record<string, TrackSummary> = {};
  for (const [pid, a] of game.anchors) anchorsObj[pid] = a;
  roomEvent(io, roomCode, {
    type: 'song_dealt',
    track: toTrackSummary(track),
    anchors: anchorsObj,
  } satisfies ServerEvent);
  logGame(roomCode, 'song_dealt', { player: playerId, trackId: track.id });
  await game.playback.playDeal(track);
}

/**
 * Called by the WS layer after a validated place_song. If it was the active
 * player committing the currently dealt track: pause playback, move to the
 * next turn. Other placements (spectators/out-of-turn) are broadcast-only.
 */
export async function onPlaced(roomCode: string, playerId: string, trackId: string, io: IOServer): Promise<void> {
  const game = games.get(roomCode);
  if (!game || !game.current) return;
  if (game.current.playerId !== playerId || game.current.track.id !== trackId) return;
  logGame(roomCode, 'turn_committed', { player: playerId, trackId });
  await game.playback.pause('placement');
  game.current = null;
  await dealNext(roomCode, io);
}

/**
 * One-tap wake path (host): transfer playback to the picked speaker, then
 * retry the pending deal.
 */
export async function wakeSpeaker(roomCode: string, io: IOServer): Promise<void> {
  const game = games.get(roomCode);
  if (!game) return;
  const woke = await game.playback.wake();
  if (woke.ok && game.current) {
    logGame(roomCode, 'wake_retry');
    await game.playback.playDeal(game.current.track);
  }
}

export function currentTurn(roomCode: string): { playerId: string; trackId: string } | null {
  const g = games.get(roomCode);
  return g?.current ? { playerId: g.current.playerId, trackId: g.current.track.id } : null;
}

export function requiredForRoster(roomCode: string): number {
  const room = getRoom(roomCode);
  return room ? requiredDeckSize(room.players.length) : 0;
}
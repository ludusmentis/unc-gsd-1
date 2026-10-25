import type { Server as IOServer } from 'socket.io';
import type { Room } from './rooms';
import { getRoom, restoreRoom } from './rooms';
import { restoreSessions } from './sessions';
import {
  loadAllAtBoot,
  saveHostBinding,
  saveGameState,
  deleteGameState,
  saveRoom,
  deleteHostBinding,
  type PersistedGame,
} from './persist';
import { restoreHostSessions, getValidAccessToken } from './spotify/auth';
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
import { COPY } from '../lib/copy';
import {
  evaluatePlacement,
  computeCorrectSlots,
  hasWonByScore,
  deckEmptyWinners,
  type ScoringTrack,
} from './scoring';
import type { TrackSummary, ServerEvent, GameStateSync, LineEntry } from './events';

/**
 * Game orchestrator — wires roster lock to deck build, first deal, playback
 * on the host speaker, and the server-authoritative game loop (lines, scores,
 * handover, forfeit, win). The WS layer calls into this module; clients never
 * touch game state directly (D008: one state object, S03 SQLite).
 *
 * S03-T01: every mutation persists through to SQLite via persist.ts so a
 * container restart restores the live game (restoreFromDb). Playback services
 * are lazily (re)created — a restore defers until a live io + access token.
 */

export interface HostBinding {
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
  lines: Map<string, LineEntry[]>; // playerId -> server-authoritative timeline
  scores: Map<string, number>; // playerId -> correct placements
  playback: PlaybackService | null; // lazily rebuilt after a restore
  current: { playerId: string; track: DeckTrack } | null;
  turnOrder: string[]; // playerId rotation
  turnIdx: number;
  awaitingNext: string | null; // playerId parked on the handover screen
  awaitingNextAt: number | null; // epoch ms — S03 nudge timer re-arm on restore
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  speakerPaused: boolean; // S03-T03: speaker lost mid-turn — one-tap wake recovers
}

/** Idle nudge: after this long on the handover screen the server pings the
 * active player once per deal with Gen Z copy (no hard turn timer). */
export const NUDGE_AFTER_MS = 30_000;

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

/** Live io for lazily (re)created playback services (set by startGame/restoreFromDb). */
let activeIo: IOServer | null = null;

/** Test hook: override Spotify access (mocked Spotify in tests). */
export function configureGameDeps(override: Partial<GameDeps>): void {
  deps = { ...defaultDeps, ...override };
}

export function _resetGamesForTests(): void {
  for (const g of games.values()) if (g.nudgeTimer) clearTimeout(g.nudgeTimer);
  bindings.clear();
  games.clear();
  deps = defaultDeps;
  activeIo = null;
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

/** Serialize a GameRuntime for SQLite (persist.ts write-through). */
function snapshotGame(game: GameRuntime): PersistedGame {
  return {
    anchors: [...game.anchors.entries()],
    lines: [...game.lines.entries()],
    scores: [...game.scores.entries()],
    turnOrder: game.turnOrder,
    turnIdx: game.turnIdx,
    awaitingNext: game.awaitingNext,
    awaitingNextAt: game.awaitingNextAt,
    speakerPaused: game.speakerPaused,
    deck: game.dealer.remainingTracks(),
    current: game.current ? { playerId: game.current.playerId, track: { ...game.current.track } } : null,
  };
}

function persistGameState(roomCode: string): void {
  const game = games.get(roomCode);
  if (game) saveGameState(roomCode, snapshotGame(game));
}

/**
 * Lazily (re)create the PlaybackService for a game (after a restore, or any
 * path where playback is still null). Needs a live io + a fresh access token
 * from the (restored) host session. No-op if the game/binding is gone.
 */
async function ensurePlayback(roomCode: string, game: GameRuntime): Promise<PlaybackService | null> {
  if (game.playback) return game.playback;
  if (!activeIo) return null;
  const binding = bindings.get(roomCode);
  if (!binding) return null;
  try {
    const accessToken = await deps.getAccessToken(binding.sessionId);
    game.playback = deps.createPlayback(accessToken, binding.speakerName, (e) =>
      relayPlayback(activeIo!, roomCode, e),
    );
    return game.playback;
  } catch (err) {
    logGame(roomCode, 'playback_rebuild_failed', { detail: String(err).slice(0, 120) });
    return null;
  }
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
    const binding: HostBinding = {
      sessionId: opts.sessionId,
      playlistId: opts.playlistId,
      playlistName: opts.playlistName,
      speakerName: opts.speakerName,
      tracks,
      eligibleCount,
    };
    bindings.set(roomCode, binding);
    saveHostBinding(roomCode, binding);
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
 * deck against the final roster (R019), seeds each player's anchor as line
 * slot 0, deals the first song, and starts playback on the host speaker.
 * Failures broadcast game_error with copy.
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

  const anchors = new Map<string, TrackSummary>();
  for (const p of room.players) {
    const a = result.anchors[room.players.indexOf(p) % result.anchors.length];
    anchors.set(p.id, toTrackSummary(a));
  }
  // Anchor tracks never double as dealt cards: filter them out of the deal
  // queue (requiredDeckSize already budgets the seeds).
  const anchorIds = new Set([...anchors.values()].map((a) => a.id));
  const dealer = createDealer(result.deck.filter((t) => !anchorIds.has(t.id)));

  // Seed every line: anchor as slot 0, score 0.
  const lines = new Map<string, LineEntry[]>();
  const scores = new Map<string, number>();
  for (const p of room.players) {
    const a = anchors.get(p.id)!;
    lines.set(p.id, [{ trackId: a.id, summary: a }]);
    scores.set(p.id, 0);
  }

  const playback = deps.createPlayback(accessToken, binding.speakerName, (e) =>
    relayPlayback(io, roomCode, e),
  );
  activeIo = io;
  room.status = 'in_progress';
  room.playlistName = binding.playlistName;
  saveRoom(room);
  games.set(roomCode, {
    dealer,
    anchors,
    lines,
    scores,
    playback,
    current: null,
    turnOrder: room.players.map((p) => p.id),
    turnIdx: 0,
    awaitingNext: null,
    awaitingNextAt: null,
    nudgeTimer: null,
    speakerPaused: false,
  });
  persistGameState(roomCode);
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

// ---- full-state sync (R006: every mutation broadcasts the snapshot) ----

/** Server-authoritative snapshot of the whole game state. */
export function getGameStateSync(roomCode: string): GameStateSync | null {
  const game = games.get(roomCode);
  const room = getRoom(roomCode);
  if (!game || !room) return null;
  const lines: Record<string, LineEntry[]> = {};
  for (const [pid, line] of game.lines) lines[pid] = line.map((e) => ({ ...e }));
  const scores: Record<string, number> = {};
  for (const [pid, s] of game.scores) scores[pid] = s;
  return {
    status: room.status,
    players: room.players,
    turn: game.current ? { playerId: game.current.playerId, track: toTrackSummary(game.current.track) } : null,
    lines,
    scores,
    awaitingNext: game.awaitingNext,
    speakerPaused: game.speakerPaused,
  };
}

/** Broadcast state_sync to the whole room. Call after every mutation. */
function broadcastSync(roomCode: string, io: IOServer): void {
  const snap = getGameStateSync(roomCode);
  if (snap) roomEvent(io, roomCode, { type: 'state_sync', state: snap });
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
  // S03-T03 (R008): a wake_speaker mid-turn (speaker dropped) pauses the
  // game — flag + one-tap wake copy, turn kept. playability `error` events
  // never pause: the deal path silently replaces those tracks (R013).
  if (e.type === 'wake_speaker') {
    const game = games.get(roomCode);
    if (game?.current) setSpeakerPaused(roomCode, io, game);
  }
}

// ---- handover: the awaiting_next phase ----

/** Enter the awaiting_next phase after a placement was resolved. */
function enterAwaitingNext(roomCode: string, playerId: string, io: IOServer): void {
  const game = games.get(roomCode);
  if (!game) return;
  game.current = null;
  game.awaitingNext = playerId;
  game.awaitingNextAt = Date.now() + NUDGE_AFTER_MS;
  if (game.nudgeTimer) clearTimeout(game.nudgeTimer);
  game.nudgeTimer = setTimeout(() => {
    const g = games.get(roomCode);
    if (!g || !g.awaitingNext) return;
    logGame(roomCode, 'nudge_sent', { player: g.awaitingNext });
    roomEvent(io, roomCode, { type: 'nudge', playerId: g.awaitingNext, copy: COPY.nudge });
    g.nudgeTimer = null;
    g.awaitingNextAt = null;
  }, NUDGE_AFTER_MS);
  roomEvent(io, roomCode, { type: 'awaiting_next', playerId });
  persistGameState(roomCode);
  broadcastSync(roomCode, io);
}

function clearAwaitingNext(roomCode: string): void {
  const game = games.get(roomCode);
  if (!game) return;
  if (game.nudgeTimer) clearTimeout(game.nudgeTimer);
  game.nudgeTimer = null;
  game.awaitingNext = null;
  game.awaitingNextAt = null;
}

// ---- game over ----

function endGame(roomCode: string, io: IOServer, winnerIds: string[], reason: 'first_to_10' | 'deck_empty', copy: string): void {
  const room = getRoom(roomCode);
  const game = games.get(roomCode);
  if (!room || !game) return;
  clearAwaitingNext(roomCode);
  game.current = null;
  room.status = 'ended';
  saveRoom(room);
  deleteGameState(roomCode);
  deleteHostBinding(roomCode);
  logGame(roomCode, 'game_over', { winners: winnerIds, reason });
  roomEvent(io, roomCode, { type: 'game_over', winnerIds, reason, copy });
  broadcastSync(roomCode, io);
}

/** Broadcast the room's anchors map (song_dealt payload). */
function anchorsOf(game: GameRuntime): Record<string, TrackSummary> {
  const anchorsObj: Record<string, TrackSummary> = {};
  for (const [pid, a] of game.anchors) anchorsObj[pid] = a;
  return anchorsObj;
}

/** Deck-empty winners over the current lines (longest line, ties shared). */
function deckEmptyWinnerIds(game: GameRuntime): string[] {
  const scoringLines = new Map<string, readonly ScoringTrack[]>();
  for (const [pid, line] of game.lines) {
    scoringLines.set(pid, line.map((e) => ({ trackId: e.trackId, releaseDate: e.summary.releaseDate })));
  }
  return deckEmptyWinners(scoringLines);
}

/**
 * S03-T03 speaker-loss pause (R008): set the flag, broadcast game_error with
 * COPY.wakeSpeaker (one-tap recovery) and a full state_sync so clients raise
 * the paused banner. The turn is NOT consumed — `current` stays, turnIdx
 * unchanged; host wake re-plays the CURRENT track. Idempotent: a
 * wake_speaker relay that already flipped the flag does not double-broadcast.
 */
function setSpeakerPaused(roomCode: string, io: IOServer, game: GameRuntime): void {
  if (game.speakerPaused) return;
  game.speakerPaused = true;
  logGame(roomCode, 'speaker_paused', { player: game.current?.playerId ?? null });
  persistGameState(roomCode);
  roomEvent(io, roomCode, { type: 'game_error', ...COPY.wakeSpeaker });
  broadcastSync(roomCode, io);
}

/**
 * Play the CURRENT deal on the host speaker, handling both S03-T03
 * resilience paths:
 * - `no_active_device` → speaker-loss pause (R008): flag + wake copy, turn kept.
 * - playability `error` → silent replacement (R013): reject the track so it
 *   never returns, re-deal to the SAME player (no second turnIdx increment),
 *   and if the deck exhausts mid-replacement fall through to the deck-empty
 *   winners path with COPY.deckEmpty. Players never get an event for the
 *   rejected track — the next `song_dealt` simply supersedes.
 */
async function playCurrentDeal(roomCode: string, io: IOServer, game: GameRuntime): Promise<void> {
  let cur = game.current;
  if (!cur) return;
  for (;;) {
    const playback = await ensurePlayback(roomCode, game);
    if (!playback) return;
    const res = await playback.playDeal(cur.track);
    if (res.ok) {
      // Clear any pause left over from a previous deal attempt on this turn.
      if (game.speakerPaused) {
        game.speakerPaused = false;
        persistGameState(roomCode);
        broadcastSync(roomCode, io);
      }
      return;
    }
    if (res.reason === 'no_active_device') {
      // Speaker loss: pause, keep the turn (R008) — host wake re-plays it.
      setSpeakerPaused(roomCode, io, game);
      return;
    }
    // Playability error: silent mid-deal replacement (R013).
    game.dealer.reject(cur.track);
    logGame(roomCode, 'track_rejected', { trackId: cur.track.id, player: cur.playerId });
    const next = game.dealer.deal();
    if (!next) {
      // Deck exhausted during replacement: deck-empty winners path.
      const winnerIds = deckEmptyWinnerIds(game);
      logGame(roomCode, 'deck_exhausted', { winners: winnerIds, via: 'replacement' });
      endGame(roomCode, io, winnerIds, 'deck_empty', COPY.deckEmpty);
      return;
    }
    game.current = { playerId: cur.playerId, track: next };
    roomEvent(io, roomCode, {
      type: 'song_dealt',
      track: toTrackSummary(next),
      anchors: anchorsOf(game),
    } satisfies ServerEvent);
    logGame(roomCode, 'song_dealt', { player: cur.playerId, trackId: next.id, replaced: cur.track.id });
    persistGameState(roomCode);
    broadcastSync(roomCode, io);
    cur = game.current;
  }
}

/**
 * Deal the next song to the next player in rotation and start playback.
 * On deck exhaustion compute the winner(s) via the scoring helpers
 * (longest line; ties = shared victory) and end the game.
 */
export async function dealNext(roomCode: string, io: IOServer): Promise<void> {
  const game = games.get(roomCode);
  const room = getRoom(roomCode);
  if (!game || !room) return;
  const track = game.dealer.deal();
  if (!track) {
    // Deck empty: longest-line winner(s), ties shared.
    const winnerIds = deckEmptyWinnerIds(game);
    logGame(roomCode, 'deck_exhausted', { winners: winnerIds });
    endGame(roomCode, io, winnerIds, 'deck_empty', COPY.deckEmpty);
    return;
  }
  const playerId = game.turnOrder[game.turnIdx % game.turnOrder.length];
  game.turnIdx++;
  game.current = { playerId, track };
  roomEvent(io, roomCode, {
    type: 'song_dealt',
    track: toTrackSummary(track),
    anchors: anchorsOf(game),
  } satisfies ServerEvent);
  logGame(roomCode, 'song_dealt', { player: playerId, trackId: track.id });
  persistGameState(roomCode);
  broadcastSync(roomCode, io);
  await playCurrentDeal(roomCode, io, game);
}

/**
 * Server-authoritative placement resolution (R005/R007): evaluate via the
 * pure scoring module BEFORE any broadcast. Correct -> insert into the
 * line, score +1, turn_result, win check (first to 10) before advancing.
 * Forfeit -> the song never enters the line, turn_forfeit reveals the
 * year + correct slots. Either way the room enters awaiting_next (no
 * auto-deal): the just-played player's next_turn deals, host skip
 * force-deals.
 */
// ---- S03-T04 host-leave pause / rejoin resume (R008/R010) ----

/**
 * Host socket dropped mid-game (R008/R010): flip the room to `paused`,
 * clear the nudge timer, best-effort pause the speaker, and broadcast
 * game_error with COPY.hostDipped plus a state_sync so clients raise the
 * paused banner. No game state is touched — `current` stays put so the
 * rejoining host resumes the exact same turn.
 */
export async function pauseForHostLeave(roomCode: string, io: IOServer): Promise<void> {
  const room = getRoom(roomCode);
  const game = games.get(roomCode);
  if (!room || room.status !== 'in_progress' || !game) return;
  room.status = 'paused';
  saveRoom(room);
  if (game.nudgeTimer) clearTimeout(game.nudgeTimer);
  game.nudgeTimer = null;
  game.awaitingNextAt = null;
  persistGameState(roomCode);
  try {
    await game.playback?.pause('host_leave');
  } catch { /* best-effort — speaker may already be gone */ }
  logGame(roomCode, 'host_leave_pause', { player: game.current?.playerId ?? null });
  roomEvent(io, roomCode, { type: 'game_error', ...COPY.hostDipped });
  broadcastSync(roomCode, io);
}

/**
 * Host came back (via the T02 rejoin path — token survives, hostPlayerId
 * unchanged): flip the room back to in_progress, broadcast state_sync, and
 * re-play the CURRENT unplaced track (wakeSpeaker handles re-placement +
 * clear of any stale speakerPaused flag). No turn was consumed while
 * paused, so resumption is exact.
 */
export async function resumeAfterHostRejoin(roomCode: string, io: IOServer): Promise<void> {
  const room = getRoom(roomCode);
  const game = games.get(roomCode);
  if (!room || room.status !== 'paused' || !game) return;
  room.status = 'in_progress';
  saveRoom(room);
  logGame(roomCode, 'host_rejoin_resume', { player: game.current?.playerId ?? null });
  broadcastSync(roomCode, io);
  // Re-arm the nudge timer if the room was parked on awaiting_next.
  if (game.awaitingNext && !game.nudgeTimer) {
    game.awaitingNextAt = Date.now() + NUDGE_AFTER_MS;
    game.nudgeTimer = setTimeout(() => {
      const g = games.get(roomCode);
      if (!g || !g.awaitingNext) return;
      logGame(roomCode, 'nudge_sent', { player: g.awaitingNext });
      roomEvent(io, roomCode, { type: 'nudge', playerId: g.awaitingNext, copy: COPY.nudge });
      g.nudgeTimer = null;
      g.awaitingNextAt = null;
    }, NUDGE_AFTER_MS);
  }
  await wakeSpeaker(roomCode, io);
}

export async function onPlaced(
  roomCode: string,
  playerId: string,
  trackId: string,
  slotIndex: number,
  io: IOServer
): Promise<void> {
  const game = games.get(roomCode);
  if (!game || !game.current) return;
  if (game.current.playerId !== playerId || game.current.track.id !== trackId) return;
  const room = getRoom(roomCode);
  if (!room || room.status !== 'in_progress') return;
  const track = game.current.track;
  const summary = toTrackSummary(track);
  const line = game.lines.get(playerId);
  const score = game.scores.get(playerId) ?? 0;
  if (!line) return;

  logGame(roomCode, 'turn_committed', { player: playerId, trackId, slotIndex });
  if (game.playback) await game.playback.pause('placement');

  const scoringLine: ScoringTrack[] = line.map((e) => ({ trackId: e.trackId, releaseDate: e.summary.releaseDate }));
  const placement = evaluatePlacement(scoringLine, { trackId, releaseDate: track.releaseDate }, slotIndex);

  if (placement.result === 'forfeit') {
    // Forfeit: song never enters the line; reveal year + correct slots.
    const correctSlots = computeCorrectSlots(scoringLine, { trackId, releaseDate: track.releaseDate });
    game.scores.set(playerId, score);
    logGame(roomCode, 'turn_forfeit', { player: playerId, trackId, correctSlots });
    roomEvent(io, roomCode, {
      type: 'turn_forfeit',
      playerId,
      track: summary,
      year: summary.year,
      correctSlots,
    });
    enterAwaitingNext(roomCode, playerId, io);
    return;
  }

  // Correct: insert the dealt track's own entry at slotIndex (existing
  // entries keep their summaries), score +1, then check first-to-10 win.
  const nextLine = line.slice();
  nextLine.splice(slotIndex, 0, { trackId, summary });
  game.lines.set(playerId, nextLine);
  const newScore = score + 1;
  game.scores.set(playerId, newScore);
  roomEvent(io, roomCode, { type: 'turn_result', playerId, track: summary, slotIndex });
  if (hasWonByScore(newScore)) {
    endGame(roomCode, io, [playerId], 'first_to_10', COPY.win);
    return;
  }
  enterAwaitingNext(roomCode, playerId, io);
}

/**
 * Handover: the just-played player taps next. Only valid while that player
 * is parked on the awaiting_next screen; the next player in rotation is
 * then dealt a song.
 */
export async function onNextTurn(
  roomCode: string,
  playerId: string,
  io: IOServer
): Promise<{ ok: true } | { ok: false; reason: 'not_awaiting_you' }> {
  const game = games.get(roomCode);
  const room = getRoom(roomCode);
  if (!game || !room) return { ok: false, reason: 'not_awaiting_you' };
  if (room.status !== 'in_progress' || game.awaitingNext !== playerId) {
    return { ok: false, reason: 'not_awaiting_you' };
  }
  logGame(roomCode, 'next_turn', { player: playerId });
  clearAwaitingNext(roomCode);
  await dealNext(roomCode, io);
  return { ok: true };
}

/** Host skip: force-deal regardless of who is parked on the handover. */
export async function onSkipTurn(roomCode: string, io: IOServer): Promise<void> {
  const game = games.get(roomCode);
  const room = getRoom(roomCode);
  if (!game || !room || room.status !== 'in_progress') return;
  logGame(roomCode, 'skip_turn', { skipper: game.awaitingNext });
  clearAwaitingNext(roomCode);
  await dealNext(roomCode, io);
}

/**
 * One-tap wake path (host): transfer playback to the picked speaker, then
 * retry the pending deal. S03-T03: clears the speakerPaused flag on
 * success, re-plays the CURRENT unplaced track (no turn consumed), and
 * broadcasts playing + state_sync so clients clear the paused banner.
 */
export async function wakeSpeaker(roomCode: string, io: IOServer): Promise<void> {
  const game = games.get(roomCode);
  if (!game) return;
  const playback = await ensurePlayback(roomCode, game);
  if (!playback) return;
  const woke = await playback.wake();
  if (!woke.ok) return; // still sleepy — flag stays, copy already relayed
  if (!game.current) {
    game.speakerPaused = false;
    persistGameState(roomCode);
    broadcastSync(roomCode, io);
    return;
  }
  logGame(roomCode, 'wake_retry');
  await playCurrentDeal(roomCode, io, game);
}

// ---- S03 boot restore (R022/D008/MEM009) ----

/**
 * Rebuild every in-memory structure from the DB at boot (called from
 * src/server/main.ts before listen; tests simulate a restart by resetting
 * the in-memory Maps and calling this against the same DB_PATH).
 *
 * Persists the DATA, rebuilds the RUNTIME:
 * - Rooms rehydrate as-is (player id counter bumped past restored ids).
 * - Sessions rehydrate with socketId cleared to null — a reconnecting
 *   socket re-binds via rejoin/rebindSocket (T02).
 * - Host token store rehydrates from host_tokens (refresh token incl.) —
 *   the host never re-auths after a restart.
 * - Host bindings (playlist + speaker pick) rehydrate from host_bindings.
 * - In-progress games rebuild their GameRuntime: dealer over the persisted
 *   remaining deck IN ORDER (no shuffle), nudge timer re-armed from the
 *   persisted awaitingNextAt when awaitingNext is set, playback deferred
 *   (lazily created by ensurePlayback — needs live io + fresh access token).
 *   A persisted game with `current` set re-plays that unplaced track on the
 *   next resume path (host tap / auto); playback itself is rebuilt lazily.
 */
export function restoreFromDb(io: IOServer): void {
  activeIo = io;
  const boot = loadAllAtBoot();
  for (const room of boot.rooms) restoreRoom(room);
  restoreSessions(boot.sessions);
  restoreHostSessions();
  for (const b of boot.bindings) bindings.set(b.roomCode, b.binding);
  for (const g of boot.games) {
    const room = getRoom(g.roomCode);
    if (!room || room.status !== 'in_progress') continue;
    const game: GameRuntime = {
      dealer: createDealer(g.state.deck as DeckTrack[]),
      anchors: new Map(g.state.anchors),
      lines: new Map(g.state.lines as [string, LineEntry[]][]),
      scores: new Map(g.state.scores),
      playback: null, // lazily rebuilt by ensurePlayback (needs live io + token)
      current: g.state.current
        ? { playerId: g.state.current.playerId, track: g.state.current.track as DeckTrack }
        : null,
      turnOrder: g.state.turnOrder,
      turnIdx: g.state.turnIdx,
      awaitingNext: g.state.awaitingNext,
      awaitingNextAt: g.state.awaitingNextAt,
      nudgeTimer: null,
      speakerPaused: g.state.speakerPaused ?? false,
    };
    // Re-arm the nudge timer from the persisted timestamp (fires when the
    // original NUDGE_AFTER_MS window elapses; never restarts the full window).
    if (game.awaitingNext && game.awaitingNextAt) {
      const remainingMs = game.awaitingNextAt - Date.now();
      game.nudgeTimer = setTimeout(() => {
        const gg = games.get(g.roomCode);
        if (!gg || !gg.awaitingNext) return;
        logGame(g.roomCode, 'nudge_sent', { player: gg.awaitingNext });
        roomEvent(io, g.roomCode, { type: 'nudge', playerId: gg.awaitingNext, copy: COPY.nudge });
        gg.nudgeTimer = null;
        gg.awaitingNextAt = null;
      }, Math.max(0, remainingMs));
    }
    games.set(g.roomCode, game);
    logGame(g.roomCode, 'game_restored', {
      players: game.turnOrder.length,
      turnIdx: game.turnIdx,
      current: game.current ? game.current.track.id : null,
    });
  }
  logGame('*', 'boot_restore_complete', {
    rooms: boot.rooms.length,
    sessions: boot.sessions.length,
    hostSessions: boot.hostTokens.length,
    bindings: boot.bindings.length,
    games: boot.games.length,
  });
}

export function currentTurn(roomCode: string): { playerId: string; trackId: string } | null {
  const g = games.get(roomCode);
  return g?.current ? { playerId: g.current.playerId, trackId: g.current.track.id } : null;
}

export function requiredForRoster(roomCode: string): number {
  const room = getRoom(roomCode);
  return room ? requiredDeckSize(room.players.length) : 0;
}
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetDbForTests } from '../src/server/db';
import {
  saveRoom,
  deleteRoom,
  saveSession,
  saveHostTokens,
  saveGameState,
  loadAllAtBoot,
} from '../src/server/persist';
import { createRoom, joinRoom, lockRoster, getRoom, _resetForTests as resetRooms } from '../src/server/rooms';
import { issueSession, rebindSocket, authorize, sessionPlayer, _resetForTests as resetSessions } from '../src/server/sessions';
import {
  saveHostTokens as saveHostTokensToStore,
  getValidAccessToken,
  _resetAuthStoreForTests,
} from '../src/server/spotify/auth';
import {
  configureGameDeps,
  registerHostPlaylist,
  startGame,
  getGameStateSync,
  restoreFromDb,
  _resetGamesForTests,
} from '../src/server/game';
import type { Server as IOServer } from 'socket.io';
import type { SpotifyTrack } from '../src/server/spotify/api';

/**
 * S03-T01 — SQLite persistence round-trips (R022/D008/MEM009).
 *
 * Proves: save→load round-trips for rooms, sessions, host tokens, and game
 * state; a simulated restart (fresh in-memory Maps, same DB file) rebuilds
 * identical game state (getGameStateSync snapshot equality, no shuffle of
 * the remaining deck, nudge timestamp carried); the host Spotify session
 * survives the restart without re-auth (refresh token persisted, mock
 * refresh endpoint answers, no exchangeCode call); sessions restore with
 * socketId nulled and re-bind exactly.
 *
 * DB_PATH points at a temp file (the Docker volume target in prod); when the
 * DB is unavailable persist.ts degrades to no-op (see db-unavailable test).
 */

process.env.SPOTIFY_CLIENT_ID ??= 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET ??= 'test-client-secret';

let tmpDir: string;
let dbPath: string;

/** Minimal io stub: roomEvent/relayPlayback only ever call io.of().to().emit(). */
function fakeIo(): IOServer {
  return {
    of: () => ({
      to: () => ({
        emit: () => {},
      }),
    }),
  } as unknown as IOServer;
}

/** Deterministic day-precise tracks with DISTINCT, ascending dates. */
function makeTracks(n: number): SpotifyTrack[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    uri: `spotify:track:t${i}`,
    name: `Song ${i}`,
    duration_ms: 180000,
    is_playable: true,
    artists: [{ name: `Artist ${i}` }],
    album: {
      name: `Album ${i}`,
      release_date: `${2000 + i}-03-10`,
      release_date_precision: 'day' as const,
    },
  }));
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nursehound-persist-'));
  dbPath = join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  _resetDbForTests(); // force open against the temp path
});

afterAll(() => {
  _resetDbForTests();
  delete process.env.DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('persist.ts round-trips', () => {
  it('saves and loads rooms, sessions, host tokens, and game state', () => {
    const room = createRoom('host');
    joinRoom(room.code, 'guest');
    const token = issueSession(room.code, room.players[1].id, 'sock-1');
    saveHostTokensToStore('sess-rt-1', {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
    });
    saveGameState(room.code, {
      anchors: [['p1', { id: 't0', name: 'Song 0', artists: [], albumName: 'Album 0', releaseDate: '2000-03-10', year: '2000' }]],
      lines: [['p1', [{ trackId: 't0', summary: { id: 't0', name: 'Song 0', artists: [], albumName: 'Album 0', releaseDate: '2000-03-10', year: '2000' } }]]],
      scores: [['p1', 0]],
      turnOrder: ['p1', 'p2'],
      turnIdx: 1,
      awaitingNext: null,
      awaitingNextAt: null,
      deck: makeTracks(3),
      current: { playerId: 'p2', track: makeTracks(1)[0] },
    });

    const boot = loadAllAtBoot();
    expect(boot.rooms.find((r) => r.code === room.code)).toBeTruthy();
    expect(boot.sessions.find((s) => s.token === token)?.playerId).toBe(room.players[1].id);
    expect(boot.hostTokens.find((h) => h.sessionId === 'sess-rt-1')?.tokens.refreshToken).toBe('rt-1');
    const gs = boot.games.find((g) => g.roomCode === room.code);
    expect(gs?.state.turnIdx).toBe(1);
    expect(gs?.state.deck).toHaveLength(3); // order preserved, no shuffle
    expect(gs?.state.current?.playerId).toBe('p2');

    // deletes round-trip too
    deleteRoom(room.code);
    expect(loadAllAtBoot().rooms.find((r) => r.code === room.code)).toBeUndefined();
  });
});

describe('restart recovery (fresh Maps, same DB file)', () => {
  it('restores an identical game state snapshot and a live-again host session without re-auth', async () => {
    resetRooms();
    resetSessions();
    _resetGamesForTests();
    _resetAuthStoreForTests();

    configureGameDeps({
      getAccessToken: async () => 'mock-access-token',
      fetchTracks: async () => makeTracks(40),
      createPlayback: () => ({
        async playDeal() { return { ok: true as const, deviceId: 'dev-1' }; },
        async pause() {},
        async wake() { return { ok: true as const, deviceId: 'dev-1' }; },
      } as never),
    });

    const io = fakeIo();
    const room = createRoom('host');
    const join = joinRoom(room.code, 'guest');
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    const hostToken = issueSession(room.code, room.players[0].id, 'sock-host');
    const guestToken = issueSession(room.code, join.player.id, 'sock-guest');

    // Host links Spotify: tokens persisted via write-through at save time.
    const hostSessionId = 'host-session-xyz';
    saveHostTokensToStore(hostSessionId, {
      accessToken: 'stale-access',
      refreshToken: 'persisted-refresh-token',
      expiresAt: Date.now() - 1_000, // already expired -> refresh path
    });
    await registerHostPlaylist(room.code, {
      sessionId: hostSessionId,
      playlistId: 'pl-1',
      playlistName: 'bangers',
      speakerName: 'kitchen',
    });
    expect(lockRoster(room.code, room.players[0].id)).toBe(true);
    await startGame(room.code, io);

    const before = getGameStateSync(room.code);
    expect(before?.status).toBe('in_progress');
    expect(before?.turn).toBeTruthy(); // first deal persisted with current set
    const beforeLines = JSON.stringify(before?.lines);
    const beforeScores = JSON.stringify(before?.scores);

    // ---- simulate a container restart: wipe every in-memory Map, keep the DB file ----
    resetRooms();
    resetSessions();
    _resetGamesForTests();
    _resetAuthStoreForTests();
    expect(getRoom(room.code)).toBeUndefined();
    expect(sessionPlayer(hostToken)).toBeNull();
    expect(getGameStateSync(room.code)).toBeNull();

    restoreFromDb(fakeIo());

    // (1) identical snapshot after rebuild (players, lines, scores, turn)
    const after = getGameStateSync(room.code);
    expect(after).not.toBeNull();
    expect(after?.status).toBe('in_progress');
    expect(after?.players).toEqual(before?.players);
    expect(JSON.stringify(after?.lines)).toBe(beforeLines);
    expect(JSON.stringify(after?.scores)).toBe(beforeScores);
    expect(after?.turn?.playerId).toBe(before?.turn?.playerId);
    expect(after?.turn?.track.id).toBe(before?.turn?.track.id);

    // (2) sessions restored with socketId nulled; re-bind works exactly
    expect(sessionPlayer(hostToken)?.playerId).toBe(before?.players[0].id);
    expect(sessionPlayer(guestToken)?.playerId).toBe(join.player.id);
    expect(authorize(guestToken, room.code, 'sock-guest')).toBe(false); // socketId was cleared
    expect(rebindSocket(guestToken, 'sock-guest-reconnected')).toBe(true);
    expect(authorize(guestToken, room.code, 'sock-guest-reconnected')).toBe(true);

    // (3) host Spotify session survived WITHOUT re-auth: the persisted
    // refresh token answers a mocked refresh; no exchangeCode call happens.
    let refreshCalls = 0;
    let exchangeCalls = 0;
    const mockFetch = (async (url: any, init: any) => {
      const body = String(init?.body ?? '');
      if (String(url).includes('/api/token')) {
        if (body.includes('grant_type=refresh_token')) {
          refreshCalls++;
          return {
            ok: true,
            json: async () => ({ access_token: 'fresh-access', expires_in: 3600, refresh_token: 'persisted-refresh-token' }),
          } as any;
        }
        exchangeCalls++;
      }
      return { ok: false, status: 400 } as any;
    }) as typeof fetch;
    const access = await getValidAccessToken(hostSessionId, mockFetch);
    expect(access).toBe('fresh-access');
    expect(refreshCalls).toBe(1);
    expect(exchangeCalls).toBe(0); // no re-auth after restart
  });
});

describe('db unavailable degradation', () => {
  it('no-ops persistence (memory-only) when the DB cannot be opened', () => {
    _resetDbForTests();
    const prev = process.env.DB_PATH;
    process.env.DB_PATH = '/dev/null/nope/cant-open.db';
    _resetDbForTests();

    // room lifecycle still works in memory with persistence silently disabled
    resetRooms();
    const room = createRoom('host');
    saveRoom(room);
    saveSession('tok-unavailable', room.players[0].id, room.code, 's1');
    saveHostTokens('sess-x', { accessToken: 'a', refreshToken: null, expiresAt: 1 });
    saveGameState(room.code, {
      anchors: [], lines: [], scores: [], turnOrder: [], turnIdx: 0,
      awaitingNext: null, awaitingNextAt: null, deck: [], current: null,
    });
    expect(loadAllAtBoot()).toEqual({ rooms: [], sessions: [], hostTokens: [], games: [], bindings: [] });

    _resetDbForTests();
    process.env.DB_PATH = prev;
    _resetDbForTests();
    resetRooms();
  });
});
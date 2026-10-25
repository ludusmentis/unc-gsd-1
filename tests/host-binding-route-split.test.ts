import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetDbForTests } from '../src/server/db';
import {
  roomExistsInDb,
  loadHostBinding,
  saveRoom,
} from '../src/server/persist';
import type { Room } from '../src/server/rooms';
import {
  createRoom,
  joinRoom,
  lockRoster,
  getRoom,
  restoreRoom,
  _resetForTests as resetRooms,
} from '../src/server/rooms';
import {
  configureGameDeps,
  registerHostPlaylist,
  startGame,
  getGameStateSync,
  _resetGamesForTests,
} from '../src/server/game';
import type { GameDeps } from '../src/server/game';
import type { Server as IOServer } from 'socket.io';
import type { SpotifyTrack } from '../src/server/spotify/api';

/**
 * S06-T01 — MEM022 route-module-split fix.
 *
 * Next.js route handlers (POST /api/spotify/select) bundle their own module
 * instances of src/server/*, separate from the custom server that owns the
 * WS layer's rooms/bindings Maps. Before the fix, registerHostPlaylist in
 * the route instance saw an EMPTY rooms Map and failed with
 * "no room with that code" even though the WS instance created the room.
 *
 * This suite simulates the split inside one process: the "WS instance"
 * creates the room (in-memory + SQLite), then the "route instance" sees an
 * empty rooms Map (resetRooms) and must still register the binding via the
 * roomExistsInDb fallback. Then the "WS instance" (fresh bindings Map) must
 * pick the binding up via the loadHostBinding fallback in startGame —
 * without a boot-restore/restart.
 */

process.env.SPOTIFY_CLIENT_ID ??= 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET ??= 'test-client-secret';

let tmpDir: string;

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

/** Full deps override (MEM018): re-stated so the test never touches Spotify. */
function fakeDeps(): GameDeps {
  return {
    getAccessToken: async () => 'mock-access-token',
    fetchTracks: async () => makeTracks(40),
    createPlayback: () =>
      ({
        async playDeal() {
          return { ok: true as const, deviceId: 'dev-1' };
        },
        async pause() {},
        async wake() {
          return { ok: true as const, deviceId: 'dev-1' };
        },
      } as never) as ReturnType<GameDeps['createPlayback']>,
  };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nursehound-route-split-'));
  process.env.DB_PATH = join(tmpDir, 'test.db');
  _resetDbForTests();
});

afterAll(() => {
  _resetDbForTests();
  delete process.env.DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('MEM022 route-module-split: /api/spotify/select path', () => {
  it('registerHostPlaylist succeeds with an empty in-memory rooms Map (DB fallback)', async () => {
    _resetGamesForTests();
    resetRooms();
    configureGameDeps(fakeDeps());

    // ---- "WS instance": creates the room, persists it to SQLite ----
    const room = createRoom('host');
    const join = joinRoom(room.code, 'guest');
    expect(join.ok).toBe(true);
    expect(lockRoster(room.code, room.players[0].id)).toBe(true);

    // ---- "route instance": fresh module instance -> empty rooms Map ----
    resetRooms();
    expect(getRoom(room.code)).toBeUndefined();
    expect(roomExistsInDb(room.code)).toBe(true); // the room is real, in the other instance

    const result = await registerHostPlaylist(room.code, {
      sessionId: 'host-session-route-split',
      playlistId: 'pl-1',
      playlistName: 'bangers',
      speakerName: 'kitchen',
    });
    // Before the fix this was { ok: false, error: 'no room with that code' }.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligibleCount).toBe(40);

    // Binding landed in host_bindings (the only cross-instance channel).
    const fromDb = loadHostBinding(room.code);
    expect(fromDb).not.toBeNull();
    expect(fromDb?.sessionId).toBe('host-session-route-split');
    expect(fromDb?.speakerName).toBe('kitchen');
    expect(fromDb?.tracks).toHaveLength(40);
  });

  it('startGame (WS instance, empty bindings Map) picks the binding up via loadHostBinding', async () => {
    _resetGamesForTests();
    resetRooms();
    configureGameDeps(fakeDeps());

    // Recreate the cross-instance state: room in SQLite (WS instance),
    // binding in SQLite (route instance) — neither in memory anywhere.
    const wsRoom = createRoom('host');
    const join = joinRoom(wsRoom.code, 'guest');
    expect(join.ok).toBe(true);
    lockRoster(wsRoom.code, wsRoom.players[0].id);
    const saved: Room = JSON.parse(JSON.stringify(wsRoom));

    await registerHostPlaylist(wsRoom.code, {
      sessionId: 'host-session-ws-side',
      playlistId: 'pl-2',
      playlistName: 'party',
      speakerName: 'Living Room',
    });

    // Simulate the WS instance AFTER its boot restore of rooms but with an
    // empty bindings Map (the binding was registered by the route instance
    // post-boot — previously only boot-restore hydrated it, MEM022 workaround).
    _resetGamesForTests(); // clears bindings AND resets deps to defaults
    configureGameDeps(fakeDeps());
    resetRooms();
    restoreRoom(saved); // WS instance has the room in memory
    saveRoom(saved);
    expect(getRoom(wsRoom.code)?.status).toBe('locked');

    const before = loadHostBinding(wsRoom.code);
    expect(before?.playlistId).toBe('pl-2');

    await startGame(wsRoom.code, fakeIo());

    const state = getGameStateSync(wsRoom.code);
    expect(state?.status).toBe('in_progress');
    expect(state?.turn).toBeTruthy(); // first song dealt via the DB-fallback binding
    if (state?.turn) {
      expect(state.turn.playerId).toBe(wsRoom.players[0].id);
    }
  });

  it('still rejects codes that exist in neither memory nor SQLite', async () => {
    _resetGamesForTests();
    resetRooms();
    configureGameDeps(fakeDeps());

    const result = await registerHostPlaylist('ZZZZZ', {
      sessionId: 'sess-x',
      playlistId: 'pl-x',
      playlistName: 'x',
      speakerName: 'x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('no room with that code');
    expect(loadHostBinding('ZZZZZ')).toBeNull();
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { attachWs, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms } from '../src/server/rooms';
import { _resetGamesForTests, configureGameDeps, registerHostPlaylist, restoreFromDb } from '../src/server/game';
import { _resetDbForTests } from '../src/server/db';
import {
  saveHostTokens,
  getValidAccessToken,
  _resetAuthStoreForTests,
} from '../src/server/spotify/auth';
import type { PlaybackService } from '../src/server/playback';
import type { SpotifyTrack } from '../src/server/spotify/api';
import type { PlaybackEvent } from '../src/server/playback';
import type { ServerEvent } from '../src/server/events';
import { ERROR_MESSAGES } from '../src/server/events';
import { COPY } from '../src/lib/copy';

/**
 * S03-T05 — cross-seam restart-recovery integration test (R022 acceptance).
 *
 * Drives a REAL game to a mid-game state over live socket.io (T02/T03/T04
 * seams included: persistence write-through from T01), then simulates a
 * container restart by wiping every in-memory Map against the same DB file
 * and re-running the boot restore path (`restoreFromDb`), then reconnects
 * every client via `rejoin` tokens and asserts:
 *   (1) identical state_sync snapshot (players, lines, scores, turn),
 *   (2) the host performs a Spotify action WITHOUT re-auth (mocked refresh
 *       endpoint answers from the persisted refresh token; zero
 *       exchangeCode calls),
 *   (3) the game loop continues: the mid-turn player places and the turn
 *       resolves normally.
 *
 * Plus a copy audit: every `rejected` / `game_error` payload carries
 * COPY-sourced error + recovery (exactly one action), never raw errors.
 */

const GAME_NS = '/game';

process.env.SPOTIFY_CLIENT_ID ??= 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET ??= 'test-client-secret';

let httpServer: Server;
let ioServer: ReturnType<typeof attachWs> | null = null;
let port: number;

let tmpDir: string;
let dbCounter = 0;

let emitPlayback: ((e: PlaybackEvent) => void) | null = null;
let refreshCalls = 0;
let exchangeCalls = 0;
let accessTokenRequests = 0;

/** Mocked Spotify token endpoint: refresh answers, exchange never happens. */
const mockFetch = (async (url: any, init: any) => {
  const body = String(init?.body ?? '');
  if (String(url).includes('/api/token')) {
    if (body.includes('grant_type=refresh_token')) {
      refreshCalls++;
      return {
        ok: true,
        json: async () => ({
          access_token: 'fresh-access',
          expires_in: 3600,
          refresh_token: 'persisted-refresh-token',
        }),
      } as any;
    }
    exchangeCalls++;
  }
  return { ok: false, status: 400 } as any;
}) as typeof fetch;

function fakePlayback(): PlaybackService {
  return {
    async playDeal(track: { id: string }) {
      emitPlayback?.({ type: 'playing', trackId: track.id, deviceId: 'dev-1' });
      return { ok: true as const, deviceId: 'dev-1' };
    },
    async pause() { return; },
    async wake() { return { ok: true as const, deviceId: 'dev-1' }; },
  } as unknown as PlaybackService;
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

/** Which insertion slots are correct for a track against a line. */
function validSlots(line: { releaseDate: string }[], releaseDate: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= line.length; i++) {
    const before = line.slice(0, i).every((e) => e.releaseDate <= releaseDate);
    const after = line.slice(i).every((e) => e.releaseDate >= releaseDate);
    if (before && after) out.push(i);
  }
  return out;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nursehound-restart-'));
  httpServer = createServer();
  ioServer = attachWs(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => ioServer?.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  _resetDbForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh DB file per test: restart-recovery must isolate rows exactly.
  process.env.DB_PATH = join(tmpDir, `t${++dbCounter}.db`);
  _resetDbForTests();
  resetRooms();
  resetSessions();
  resetWs();
  _resetGamesForTests();
  _resetAuthStoreForTests();
  refreshCalls = 0;
  exchangeCalls = 0;
  accessTokenRequests = 0;
  emitPlayback = null;
  configureGameDeps({
    // The REAL auth store path (persisted tokens) — proves no re-auth.
    getAccessToken: async (sessionId: string) => {
      accessTokenRequests++;
      return getValidAccessToken(sessionId, mockFetch);
    },
    fetchTracks: async () => makeTracks(60),
    createPlayback: (_t, _s, onEvent) => {
      emitPlayback = onEvent;
      return fakePlayback();
    },
  });
});

function connect(): Promise<Socket> {
  return new Promise((resolve) => {
    const s = io(`http://localhost:${port}${GAME_NS}`, { path: '/socket.io' });
    s.on('connect', () => resolve(s));
  });
}

function emit(s: Socket, token: string, action: unknown) {
  s.emit('action', { token, action });
}

function collect(s: Socket): ServerEvent[] {
  const buf: ServerEvent[] = [];
  s.on('event', (e: ServerEvent) => buf.push(e));
  return buf;
}

async function waitFor(buf: ServerEvent[], type: string, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idx = buf.findIndex((e) => e.type === type);
    if (idx !== -1) return buf.splice(idx, 1)[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${type}`);
}

async function syncNow(s: Socket, token: string, buf: ServerEvent[]) {
  // Drop every stale queued state_sync — only the fresh ping answer counts.
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i].type === 'state_sync') buf.splice(i, 1);
  emit(s, token, { type: 'ping_state' });
  return waitFor(buf, 'state_sync');
}

type Room = Awaited<ReturnType<typeof setupRoom3>>;

/** Host + two guests over LIVE sockets (persistence write-through on). */
async function setupRoom3() {
  const host = await connect();
  const p2 = await connect();
  const p3 = await connect();
  const bufs = [collect(host), collect(p2), collect(p3)];
  emit(host, '', { type: 'create_room', name: 'hosty' });
  const created = await waitFor(bufs[0], 'room_created');
  const code = created.room.code as string;
  emit(p2, '', { type: 'join_room', code, name: 'bestie2' });
  const j2 = await waitFor(bufs[1], 'joined');
  emit(p3, '', { type: 'join_room', code, name: 'bestie3' });
  const j3 = await waitFor(bufs[2], 'joined');
  return {
    code,
    sockets: [host, p2, p3] as [Socket, Socket, Socket],
    bufs,
    ids: [created.room.players[0].id as string, j2.you.id as string, j3.you.id as string],
    tokens: [created.token as string, j2.token as string, j3.token as string],
  };
}

describe('S03-T05 restart recovery (R022 end-to-end)', () => {
  it('survives a server restart mid-game: rejoin restores exact state, host Spotify works without re-auth, the loop continues', async () => {
    const r = await setupRoom3();
    // Host links Spotify; tokens persist via write-through (T01). Save
    // BEFORE register — registerHostPlaylist pulls an access token for the
    // session (expired -> exercises the refresh path through the real store).
    saveHostTokens('sid-restart', {
      accessToken: 'stale-access',
      refreshToken: 'persisted-refresh-token',
      expiresAt: Date.now() - 1_000, // expired -> refresh path
    });
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-restart', playlistId: 'big',
      playlistName: 'Bangers', speakerName: 'Party Speaker',
    });
    if (!reg.ok) throw new Error('registration failed');
    emit(r.sockets[0], r.tokens[0], { type: 'lock_roster' });
    await waitFor(r.bufs[0], 'roster_locked');
    await waitFor(r.bufs[0], 'game_started');
    await waitFor(r.bufs[0], 'song_dealt');

    // --- drive to a real mid-game state: a few placements so lines/scores
    // --- diverge, ending with a player mid-turn (current set).
    const lineOf = (snap: any, id: string) =>
      snap.state.lines[id].map((e: any) => ({ releaseDate: e.summary.releaseDate }));

    // Turn 1: host places correctly (score 1).
    {
      const snap = await syncNow(r.sockets[0], r.tokens[0], r.bufs[0]);
      const track = snap.state.turn.track;
      const slots = validSlots(lineOf(snap, r.ids[0]), track.releaseDate);
      expect(slots.length).toBeGreaterThan(0);
      emit(r.sockets[0], r.tokens[0], { type: 'place_song', trackId: track.id, slotIndex: slots[0] });
      await waitFor(r.bufs[0], 'turn_result');
      await waitFor(r.bufs[0], 'awaiting_next');
      emit(r.sockets[0], r.tokens[0], { type: 'next_turn' });
      await waitFor(r.bufs[0], 'song_dealt');
    }
    // Turn 2: player 2 forfeits (score stays 0) — lines diverge.
    {
      const snap = await syncNow(r.sockets[1], r.tokens[1], r.bufs[1]);
      const track = snap.state.turn.track;
      const line = lineOf(snap, r.ids[1]);
      const all = Array.from({ length: line.length + 1 }, (_, k) => k);
      const slots = validSlots(line, track.releaseDate);
      const bad = all.find((k) => !slots.includes(k))!;
      emit(r.sockets[1], r.tokens[1], { type: 'place_song', trackId: track.id, slotIndex: bad });
      await waitFor(r.bufs[1], 'turn_forfeit');
      await waitFor(r.bufs[1], 'awaiting_next');
      emit(r.sockets[1], r.tokens[1], { type: 'next_turn' });
      await waitFor(r.bufs[1], 'song_dealt');
    }
    // Now player 3 is mid-turn (current set, unplaced). Pre-restart snapshot:
    const pre = await syncNow(r.sockets[2], r.tokens[2], r.bufs[2]);
    expect(pre.state.status).toBe('in_progress');
    expect(pre.state.turn?.playerId).toBe(r.ids[2]);
    expect(pre.state.scores[r.ids[0]]).toBe(1);
    expect(pre.state.scores[r.ids[1]]).toBe(0);

    // ---- simulate a container restart: kill every client, wipe every
    // ---- in-memory Map, keep the DB file, re-run the boot restore path.
    r.sockets.forEach((s) => s.disconnect());
    await new Promise((res) => setTimeout(res, 100));
    resetRooms();
    resetSessions();
    resetWs();
    _resetGamesForTests();
    _resetAuthStoreForTests();
    // Deps are process-level config (env) — they SURVIVE a real container
    // restart, so re-apply them here too (the reset restores defaults).
    configureGameDeps({
      getAccessToken: async (sessionId: string) => {
        accessTokenRequests++;
        return getValidAccessToken(sessionId, mockFetch);
      },
      fetchTracks: async () => makeTracks(60),
      createPlayback: (_t, _s, onEvent) => {
        emitPlayback = onEvent;
        return fakePlayback();
      },
    });

    restoreFromDb(ioServer!);

    // ---- reconnect every client with its STORED token via rejoin (T02).
    const reSocks = [await connect(), await connect(), await connect()];
    const reBufs = reSocks.map((s) => collect(s));
    for (let i = 0; i < 3; i++) {
      emit(reSocks[i], r.tokens[i], { type: 'rejoin' });
      const re = await waitFor(reBufs[i], 'rejoined');
      expect(re.you.id).toBe(r.ids[i]);
      expect(re.token).toBe(r.tokens[i]);
    }

    // (1) identical snapshot after rebuild: players, lines, scores, turn.
    const post = await Promise.all(
      reSocks.map((s, i) => syncNow(s, r.tokens[i], reBufs[i])),
    );
    for (const p of post.slice(1)) expect(p.state).toEqual(post[0].state);
    expect(post[0].state.status).toBe('in_progress');
    expect(post[0].state.players).toEqual(pre.state.players);
    expect(post[0].state.lines).toEqual(pre.state.lines);
    expect(post[0].state.scores).toEqual(pre.state.scores);
    expect(post[0].state.turn).toEqual(pre.state.turn);
    expect(post[0].state.turn?.playerId).toBe(r.ids[2]);

    // (2) the host performs a Spotify action WITHOUT re-auth: the mid-turn
    // player placing (and the host's next_turn) drives the playback layer,
    // which lazily recreates via the REAL auth store restored from the DB —
    // the mocked refresh endpoint answers; exchangeCode never fires.
    const line3 = pre.state.lines[r.ids[2]].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    const track = pre.state.turn.track;
    const slots = validSlots(line3, track.releaseDate);
    expect(slots.length).toBeGreaterThan(0);
    emit(reSocks[2], r.tokens[2], { type: 'place_song', trackId: track.id, slotIndex: slots[0] });
    await waitFor(reBufs[2], 'turn_result');
    await waitFor(reBufs[2], 'awaiting_next');
    // The rejoined mid-turn player (the drop victim) advances the handover —
    // next_turn is the JUST-PLAYED player's action, not the host's (R020).
    emit(reSocks[2], r.tokens[2], { type: 'next_turn' });
    const dealt = await waitFor(reBufs[2], 'song_dealt');
    expect(dealt.track.id).not.toBe(track.id);

    expect(accessTokenRequests).toBeGreaterThanOrEqual(1); // a real token was needed
    expect(refreshCalls).toBeGreaterThanOrEqual(1); // refreshed from the PERSISTED refresh token
    expect(exchangeCalls).toBe(0); // no re-auth after restart

    // (3) the game loop continues: turn resolution landed in state.
    const cont = await syncNow(reSocks[0], r.tokens[0], reBufs[0]);
    expect(cont.state.scores[r.ids[2]]).toBe(pre.state.scores[r.ids[2]] + 1);
    expect(cont.state.lines[r.ids[2]]).toHaveLength(line3.length + 1);
    expect(cont.state.turn?.playerId).toBe(r.ids[0]); // rotation carried on

    reSocks.forEach((s) => s.disconnect());
  }, 30000);
});

/** Recursively collect every string value in COPY. */
function collectCopyStrings(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof obj === 'string') out.add(obj);
  else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) collectCopyStrings(v, out);
  return out;
}

describe('S03-T05 copy audit: no raw error strings leak (R008/R013/R021)', () => {
  it('every rejected payload carries COPY-sourced error + recovery with exactly one action', async () => {
    const allowed = collectCopyStrings(COPY);
    for (const m of Object.values(ERROR_MESSAGES)) {
      allowed.add((m as any).error);
      allowed.add((m as any).recovery);
    }

    // This audit is about COPY only — plain mocks avoid the auth seam.
    // (configureGameDeps REPLACES deps, so re-state the full override.)
    configureGameDeps({
      getAccessToken: async () => 'mock-access-token',
      fetchTracks: async () => makeTracks(60),
      createPlayback: (_t, _s, onEvent) => {
        emitPlayback = onEvent;
        return fakePlayback();
      },
    });

    const r = await setupRoom3();
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-copy', playlistId: 'big', playlistName: 'Bangers', speakerName: 'Spk',
    });
    emit(r.sockets[0], r.tokens[0], { type: 'lock_roster' });
    await waitFor(r.bufs[0], 'roster_locked');
    await waitFor(r.bufs[0], 'game_started');
    await waitFor(r.bufs[0], 'song_dealt');

    // Garbage token rejoin -> invalid_token COPY.
    const stray = await connect();
    const strayBuf = collect(stray);
    emit(stray, 'totally-fake-token', { type: 'rejoin' });
    const rej1 = await waitFor(strayBuf, 'rejected');
    expect(rej1.reason).toBe('invalid_token');
    expect(allowed.has(rej1.error)).toBe(true);
    expect(allowed.has(rej1.recovery)).toBe(true);

    // Non-host skip -> not_host_for_skip COPY.
    emit(r.sockets[1], r.tokens[1], { type: 'skip_turn' });
    const rej2 = await waitFor(r.bufs[1], 'rejected');
    expect(rej2.reason).toBe('not_host_for_skip');
    expect(allowed.has(rej2.error)).toBe(true);
    expect(allowed.has(rej2.recovery)).toBe(true);

    // Locked-room late join -> room_locked COPY.
    const late = await connect();
    const lateBuf = collect(late);
    emit(late, '', { type: 'join_room', code: r.code, name: 'Late' });
    const rej3 = await waitFor(lateBuf, 'rejected');
    expect(rej3.reason).toBe('room_locked');
    expect(allowed.has(rej3.error)).toBe(true);
    expect(allowed.has(rej3.recovery)).toBe(true);

    // Every rejected event observed anywhere in this run carried a COPY
    // error + recovery pair (one action each) — no raw/undefined strings.
    for (const e of [...strayBuf, ...lateBuf]) {
      if (e.type === 'rejected') {
        expect(typeof (e as any).error).toBe('string');
        expect(typeof (e as any).recovery).toBe('string');
        expect((e as any).error.length).toBeGreaterThan(0);
      }
    }

    stray.disconnect();
    late.disconnect();
    r.sockets.forEach((s) => s.disconnect());
  });
});
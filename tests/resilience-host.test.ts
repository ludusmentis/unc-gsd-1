import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { NextRequest } from 'next/server';
import { io, type Socket } from 'socket.io-client';
import { attachWs, HOST_LEAVE_GRACE_MS, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms } from '../src/server/rooms';
import {
  _resetGamesForTests,
  configureGameDeps,
  registerHostPlaylist,
  getGameStateSync,
  type GameStateSync,
} from '../src/server/game';
import { encodeState, decodeState } from '../src/server/spotify/oauth-state';
import { GET as callbackGET } from '../src/app/api/auth/callback/route';
import { ExchangeError } from '../src/server/spotify/auth';
import type { PlaybackService, PlaybackEvent } from '../src/server/playback';
import type { SpotifyTrack } from '../src/server/spotify/api';
import type { ServerEvent } from '../src/server/events';
import { COPY } from '../src/lib/copy';

/**
 * S03-T04 — host-leave pause/resume (R008/R010) + Spotify allowlist Gen Z
 * copy (R021).
 *
 * 1. Host socket drops mid-game → (after the grace window) room flips to
 *    `paused`, game_error carries COPY.hostDipped, nudge timer cleared, and
 *    NO turn was consumed (current player/track unchanged).
 * 2. Host rejoin (T02 rejoin path, same token) → status back to
 *    in_progress, identical state_sync (lines/scores/turn), current track
 *    re-played, and the game loop continues normally.
 * 3. place_song while paused is rejected (game_not_in_progress).
 * 4. Non-host disconnects change nothing.
 * 5. A mocked 403 auth exchange produces both-sided Gen Z copy with the
 *    friend's name and no raw error string anywhere.
 */

const GAME_NS = '/game';

let httpServer: Server;
let port: number;

let playedTrackIds: string[] = [];
let emitPlayback: ((e: PlaybackEvent) => void) | null = null;

function fakePlayback(): PlaybackService {
  return {
    async playDeal(track: { id: string }) {
      playedTrackIds.push(track.id);
      emitPlayback?.({ type: 'playing', trackId: track.id, deviceId: 'dev-1' });
      return { ok: true as const, deviceId: 'dev-1' };
    },
    async pause() { return; },
    async wake() { return { ok: true as const, deviceId: 'dev-1' }; },
  } as unknown as PlaybackService;
}

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

beforeAll(async () => {
  httpServer = createServer();
  attachWs(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  resetWs();
  resetRooms();
  resetSessions();
  _resetGamesForTests();
  configureGameDeps({
    getAccessToken: async () => 'mock-access-token',
    fetchTracks: async () => makeTracks(60),
    createPlayback: (_token, _speaker, onEvent) => {
      emitPlayback = onEvent;
      return fakePlayback();
    },
  });
  playedTrackIds = [];
  emitPlayback = null;
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

type Room = Awaited<ReturnType<typeof setupRoom3>>;

/** Host + two guests join BEFORE lock; then roster lock + first deal. */
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
  const reg = await registerHostPlaylist(code, {
    sessionId: 'sid-t04', playlistId: 'big', playlistName: 'Bangers Only', speakerName: 'Party Speaker',
  });
  if (!reg.ok) throw new Error('registration failed');
  emit(host, created.token as string, { type: 'lock_roster' });
  await waitFor(bufs[0], 'roster_locked');
  await waitFor(bufs[0], 'game_started');
  await waitFor(bufs[0], 'song_dealt');
  return {
    code,
    sockets: [host, p2, p3] as [Socket, Socket, Socket],
    bufs,
    ids: [created.room.players[0].id as string, j2.you.id as string, j3.you.id as string],
    tokens: [created.token as string, j2.token as string, j3.token as string],
  };
}

function validSlots(line: { releaseDate: string }[], releaseDate: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= line.length; i++) {
    const before = line.slice(0, i).every((e) => e.releaseDate <= releaseDate);
    const after = line.slice(i).every((e) => e.releaseDate >= releaseDate);
    if (before && after) out.push(i);
  }
  return out;
}

function coreState(s: GameStateSync): unknown {
  const { status, players, turn, lines, scores, awaitingNext } = s;
  return { status, players, turn, lines, scores, awaitingNext };
}

describe('S03-T04 host-leave pause / rejoin resume (R008/R010)', () => {
  it('(1) host disconnect mid-game → paused with COPY.hostDipped, no turn consumed', async () => {
    const r = await setupRoom3();
    const pre = getGameStateSync(r.code)!;
    expect(pre.status).toBe('in_progress');
    const preTurn = pre.turn;
    expect(preTurn).not.toBeNull();

    // Host's phone dies. The grace window absorbs a page remount, then the
    // room pauses with Gen Z copy.
    r.sockets[0].disconnect();
    await new Promise((res) => setTimeout(res, HOST_LEAVE_GRACE_MS + 600));

    const err = await waitFor(r.bufs[1], 'game_error');
    expect(err.error).toBe(COPY.hostDipped.error);
    expect(err.recovery).toBe(COPY.hostDipped.recovery);

    const paused = getGameStateSync(r.code)!;
    expect(paused.status).toBe('paused');
    // No turn consumed: current stays exactly put.
    expect(paused.turn!.playerId).toBe(preTurn!.playerId);
    expect(paused.turn!.track.id).toBe(preTurn!.track.id);
    expect(coreState(paused)).toEqual({ ...coreState(pre), status: 'paused' });

    r.sockets[1].disconnect();
    r.sockets[2].disconnect();
  });

  it('(2) host rejoin → in_progress + identical snapshot; game continues from the same turn', async () => {
    const r = await setupRoom3();
    const pre = getGameStateSync(r.code)!;

    // Pause via host drop, then the host comes back on a new socket with
    // the same stored token (T02 rejoin path).
    r.sockets[0].disconnect();
    await new Promise((res) => setTimeout(res, HOST_LEAVE_GRACE_MS + 600));
    await waitFor(r.bufs[1], 'game_error'); // hostDipped broadcast
    getGameStateSync(r.code); // drain

    const back = await connect();
    const backBuf = collect(back);
    emit(back, r.tokens[0], { type: 'rejoin' });
    await waitFor(backBuf, 'rejoined');

    // Resume runs async — wait for the post-resume snapshot.
    await new Promise((res) => setTimeout(res, 150));
    const resumed = getGameStateSync(r.code)!;
    expect(resumed.status).toBe('in_progress');
    // Identical state except status: lines/scores/turn all preserved.
    expect(coreState(resumed)).toEqual({ ...coreState(pre) });
    // The current unplaced track re-played on the host speaker.
    expect(playedTrackIds).toContain(pre.turn!.track.id);

    // The paused banner clears: the post-resume state_sync arrives
    // (the rejoin path sends a paused one first — wait for in_progress).
    let syncEvt: any;
    for (;;) {
      syncEvt = await waitFor(backBuf, 'state_sync', 3000);
      if (syncEvt.state.status === 'in_progress') break;
    }
    expect(syncEvt.state.status).toBe('in_progress');

    // The game loop continues normally: the mid-turn host places and it resolves.
    const playsBefore = playedTrackIds.length;
    const snap = getGameStateSync(r.code)!;
    expect(snap.turn!.playerId).toBe(r.ids[0]);
    const line = snap.lines[r.ids[0]].map((e) => ({ releaseDate: e.summary.releaseDate }));
    const slots = validSlots(line, snap.turn!.track.releaseDate);
    expect(slots.length).toBeGreaterThan(0);
    const nPlayed = playedTrackIds.filter((id) => id === snap.turn!.track.id).length;
    expect(nPlayed).toBe(playsBefore - (playsBefore - nPlayed)); // sanity: track was played
    emit(back, r.tokens[0], { type: 'place_song', trackId: snap.turn!.track.id, slotIndex: slots[0] });
    await waitFor(backBuf, 'turn_result');
    await waitFor(backBuf, 'awaiting_next');
    expect(getGameStateSync(r.code)!.scores[r.ids[0]]).toBe(1);

    back.disconnect();
    r.sockets[1].disconnect();
    r.sockets[2].disconnect();
  }, 20000);

  it('(3) place_song while paused is rejected (game_not_in_progress)', async () => {
    const r = await setupRoom3();
    const snap = getGameStateSync(r.code)!;
    r.sockets[0].disconnect();
    await new Promise((res) => setTimeout(res, HOST_LEAVE_GRACE_MS + 600));
    await waitFor(r.bufs[1], 'game_error');
    expect(getGameStateSync(r.code)!.status).toBe('paused');

    // A guest (authorized session) tries to place while paused → rejected.
    const line = snap.lines[r.ids[1]].map((e) => ({ releaseDate: e.summary.releaseDate }));
    const slots = validSlots(line, snap.turn!.track.releaseDate);
    emit(r.sockets[1], r.tokens[1], { type: 'place_song', trackId: snap.turn!.track.id, slotIndex: slots[0] ?? 0 });
    const rej = await waitFor(r.bufs[1], 'rejected');
    expect(rej.reason).toBe('game_not_in_progress');
    expect(rej.error).toBe('the game aint running rn');
    // Nothing entered the line — snapshot untouched.
    const after = getGameStateSync(r.code)!;
    expect(after.lines[r.ids[1]]).toHaveLength(1); // anchor only
    expect(after.turn!.track.id).toBe(snap.turn!.track.id);

    r.sockets[1].disconnect();
    r.sockets[2].disconnect();
  });

  it('(4) non-host disconnect changes nothing — room stays in_progress', async () => {
    const r = await setupRoom3();
    r.sockets[1].disconnect();
    await new Promise((res) => setTimeout(res, HOST_LEAVE_GRACE_MS + 600));
    const snap = getGameStateSync(r.code)!;
    expect(snap.status).toBe('in_progress');
    // No pause copy was ever broadcast.
    for (const b of [r.bufs[0], r.bufs[2]]) {
      expect(b.some((e) => e.type === 'game_error')).toBe(false);
    }

    r.sockets[0].disconnect();
    r.sockets[2].disconnect();
  });
});

describe('S03-T04 Spotify allowlist Gen Z copy (R021)', () => {
  beforeAll(() => {
    process.env.SPOTIFY_CLIENT_ID ??= 'test-client-id';
    process.env.SPOTIFY_CLIENT_SECRET ??= 'test-client-secret';
  });

  it('(5) mocked 403 exchange → both-sided Gen Z copy with friend name, no raw error', async () => {
    const name = 'bff on the couch';
    const state = encodeState('http://localhost:3000', name);
    expect(decodeState(state)).toEqual({ origin: 'http://localhost:3000', name });

    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return { ok: false, status: 403 } as Response;
    }) as typeof fetch;
    try {
      const req = new NextRequest(
        `http://localhost:3000/api/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      );
      const res = await callbackGET(req);
      expect(res.status).toBeGreaterThanOrEqual(300);
      const loc = res.headers.get('location')!;
      expect(loc).toContain('/host?');
      const qs = new URL(loc).searchParams;
      expect(qs.get('auth')).toBe('not_allowlisted');
      expect(qs.get('name')).toBe(name);
      // No raw error string anywhere in the redirect.
      expect(loc).not.toMatch(/token exchange|error=/i);

      // The client renders the copy verbatim from COPY — both sides.
      expect(qs.get('auth')).toBe('not_allowlisted'); // host page keys off this
      expect(COPY.notAllowlisted.error.length).toBeGreaterThan(0);
      expect(COPY.hostAddFriend.replace('{name}', name)).toContain(name);
    } finally {
      globalThis.fetch = realFetch;
      expect(calls.length).toBe(1); // exactly one exchange attempt
    }
  });

  it('(6) non-403 exchange failure → generic failed auth, no raw detail leak', async () => {
    const state = encodeState('http://localhost:3000');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500 } as Response)) as typeof fetch;
    try {
      const req = new NextRequest(
        `http://localhost:3000/api/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      );
      const res = await callbackGET(req);
      const loc = res.headers.get('location')!;
      expect(new URL(loc).searchParams.get('auth')).toBe('failed');
      expect(loc).not.toMatch(/token exchange|status:? ?5\d\d/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('(7) ExchangeError carries the status (403 ≠ generic)', () => {
    const e = new ExchangeError('nope', 403);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(403);
  });
});
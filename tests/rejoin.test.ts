import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { attachWs, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms } from '../src/server/rooms';
import { _resetGamesForTests, configureGameDeps, registerHostPlaylist } from '../src/server/game';
import type { PlaybackService } from '../src/server/playback';
import type { SpotifyTrack } from '../src/server/spotify/api';
import type { PlaybackEvent } from '../src/server/playback';
import type { ServerEvent } from '../src/server/events';

/**
 * S03-T02 — player rejoin with exact state restore (R009).
 * A phone that drops (locked phone, dead battery, tab closed, page remount)
 * reconnects with its stored token via `rejoin` and gets back the exact
 * line/score/turn snapshot. Rejoin re-binds identity only — never game state
 * (R020) — so a non-acting rejoiner still cannot place for the active player.
 */

const GAME_NS = '/game';

let httpServer: Server;
let ioServer: ReturnType<typeof attachWs> | null = null;
let port: number;

let emitPlayback: ((e: PlaybackEvent) => void) | null = null;

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
  ioServer = attachWs(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => ioServer?.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  resetRooms();
  resetSessions();
  resetWs();
  _resetGamesForTests();
  configureGameDeps({
    getAccessToken: async () => 'mock-access-token',
    fetchTracks: async () => makeTracks(60),
    createPlayback: (_t, _s, onEvent) => {
      emitPlayback = onEvent;
      return fakePlayback();
    },
  });
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

async function setupRoom2() {
  const host = await connect();
  const p2 = await connect();
  const bufs = [collect(host), collect(p2)];
  emit(host, '', { type: 'create_room', name: 'hosty' });
  const created = await waitFor(bufs[0], 'room_created');
  const code = created.room.code as string;
  emit(p2, '', { type: 'join_room', code, name: 'bestie2' });
  const j2 = await waitFor(bufs[1], 'joined');
  return {
    code,
    sockets: [host, p2] as [Socket, Socket],
    bufs,
    ids: [created.room.players[0].id as string, j2.you.id as string],
    tokens: [created.token as string, j2.token as string],
  };
}

describe('S03-T02 rejoin: exact state restore (R009)', () => {
  it('a dropped phone rejoins with its stored token and gets the exact pre-drop snapshot', async () => {
    const r = await setupRoom2();
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-rejoin', playlistId: 'big', playlistName: 'Bangers', speakerName: 'Spk',
    });
    if (!reg.ok) throw new Error('registration failed');
    emit(r.sockets[0], r.tokens[0], { type: 'lock_roster' });
    await waitFor(r.bufs[0], 'roster_locked');
    await waitFor(r.bufs[0], 'game_started');
    await waitFor(r.bufs[0], 'song_dealt');

    // pre-drop snapshot for player 2 (the future drop victim)
    const pre = await (async () => {
      emit(r.sockets[1], r.tokens[1], { type: 'ping_state' });
      return waitFor(r.bufs[1], 'state_sync');
    })();
    const preState = pre.state;

    // player 2's phone dies mid-turn: socket drops
    r.sockets[1].disconnect();
    await new Promise((res) => setTimeout(res, 50));

    // reconnect with the SAME stored token via rejoin
    const re = await connect();
    const reBuf = collect(re);
    emit(re, r.tokens[1], { type: 'rejoin' });
    const rejoined = await waitFor(reBuf, 'rejoined');
    expect(rejoined.you.id).toBe(r.ids[1]);
    expect(rejoined.token).toBe(r.tokens[1]);
    expect(rejoined.room.code).toBe(r.code);
    // the player was NOT re-added — roster unchanged
    expect(rejoined.room.players).toHaveLength(2);

    // immediate authoritative snapshot: exactly the pre-drop values
    const post = await waitFor(reBuf, 'state_sync');
    expect(post.state).toEqual(preState);
    expect(post.state.lines[r.ids[1]]).toEqual(preState.lines[r.ids[1]]);
    expect(post.state.scores[r.ids[1]]).toBe(preState.scores[r.ids[1]]);
    expect(post.state.turn).toEqual(preState.turn);

    // and the rejoined socket can act (ping_state still works mid-session)
    emit(re, r.tokens[1], { type: 'ping_state' });
    const again = await waitFor(reBuf, 'state_sync');
    expect(again.state).toEqual(preState);

    re.disconnect();
    r.sockets[0].disconnect();
  });

  it('a garbage token is rejected invalid_token on rejoin', async () => {
    const r = await setupRoom2();
    const s = await connect();
    const buf = collect(s);
    emit(s, 'totally-fake-token-xyz', { type: 'rejoin' });
    const rej = await waitFor(buf, 'rejected');
    expect(rej.reason).toBe('invalid_token');
    expect(rej.error).toBeTruthy();
    expect(rej.recovery).toBeTruthy();
    s.disconnect();
    r.sockets.forEach((x) => x.disconnect());
  });

  it('a rejoined non-acting session cannot place for the active player', async () => {
    const r = await setupRoom2();
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-rejoin2', playlistId: 'big', playlistName: 'Bangers', speakerName: 'Spk',
    });
    if (!reg.ok) throw new Error('registration failed');
    emit(r.sockets[0], r.tokens[0], { type: 'lock_roster' });
    await waitFor(r.bufs[0], 'roster_locked');
    await waitFor(r.bufs[0], 'game_started');
    await waitFor(r.bufs[0], 'song_dealt');

    // player 2 drops and rejoins while it is the HOST's turn
    r.sockets[1].disconnect();
    const re = await connect();
    const reBuf = collect(re);
    emit(re, r.tokens[1], { type: 'rejoin' });
    await waitFor(reBuf, 'rejoined');
    await waitFor(reBuf, 'state_sync');

    // not their turn: placing the active (host) track as player 2 is a
    // server-side no-op — the action only ever evaluates for the session
    // owner, and it is not the session owner's turn (R020).
    const hostSnap = await (async () => {
      emit(r.sockets[0], r.tokens[0], { type: 'ping_state' });
      return waitFor(r.bufs[0], 'state_sync');
    })();
    const activeTrackId = hostSnap.state.turn.track.id;
    const line = hostSnap.state.lines[r.ids[1]].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    const slots = validSlots(line, hostSnap.state.turn.track.releaseDate);
    emit(re, r.tokens[1], { type: 'place_song', trackId: activeTrackId, slotIndex: slots[0] ?? 0 });
    // broadcast song_placed fires (optimistic echo), but NO turn_result /
    // turn_forfeit / awaiting_next / state_sync follow-up ever lands...
    await new Promise((res) => setTimeout(res, 250));
    for (const e of reBuf) {
      expect(['turn_result', 'turn_forfeit', 'awaiting_next', 'state_sync']).not.toContain(e.type);
    }
    // ...and the authoritative state is untouched for both players
    const after = await (async () => {
      emit(r.sockets[0], r.tokens[0], { type: 'ping_state' });
      return waitFor(r.bufs[0], 'state_sync');
    })();
    expect(after.state.lines[r.ids[0]].length).toBe(hostSnap.state.lines[r.ids[0]].length);
    expect(after.state.lines[r.ids[1]].length).toBe(hostSnap.state.lines[r.ids[1]].length);
    expect(after.state.scores).toEqual(hostSnap.state.scores);
    expect(after.state.turn).toEqual(hostSnap.state.turn);

    re.disconnect();
    r.sockets[0].disconnect();
  });

  it('rejoin never mutates game state: snapshots are identical before and after', async () => {
    const r = await setupRoom2();
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-rejoin3', playlistId: 'big', playlistName: 'Bangers', speakerName: 'Spk',
    });
    if (!reg.ok) throw new Error('registration failed');
    emit(r.sockets[0], r.tokens[0], { type: 'lock_roster' });
    await waitFor(r.bufs[0], 'roster_locked');
    await waitFor(r.bufs[0], 'game_started');
    await waitFor(r.bufs[0], 'song_dealt');

    const before = await (async () => {
      emit(r.sockets[0], r.tokens[0], { type: 'ping_state' });
      return waitFor(r.bufs[0], 'state_sync');
    })();

    // BOTH players rejoin on fresh sockets
    r.sockets[0].disconnect();
    r.sockets[1].disconnect();
    const re0 = await connect();
    const re1 = await connect();
    const b0 = collect(re0);
    const b1 = collect(re1);
    emit(re0, r.tokens[0], { type: 'rejoin' });
    emit(re1, r.tokens[1], { type: 'rejoin' });
    await waitFor(b0, 'rejoined');
    await waitFor(b1, 'rejoined');
    const s0 = await waitFor(b0, 'state_sync');
    const s1 = await waitFor(b1, 'state_sync');
    expect(s0.state).toEqual(before.state);
    expect(s1.state).toEqual(before.state);

    re0.disconnect(); re1.disconnect();
  });
});
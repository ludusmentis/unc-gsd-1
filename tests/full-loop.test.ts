import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { attachWs, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms } from '../src/server/rooms';
import {
  _resetGamesForTests,
  configureGameDeps,
  getHostBinding,
} from '../src/server/game';
import type { PlaybackService } from '../src/server/playback';
import type { SpotifyTrack } from '../src/server/spotify/api';
import type { PlaybackEvent } from '../src/server/playback';
import type { ServerEvent } from '../src/server/events';

/**
 * Full-loop integration test (T05) with Spotify fully mocked:
 * host creates room -> playlist registered -> friend joins -> host locks
 * roster -> deck builds -> first song is dealt -> fake playback "plays" ->
 * active player places it -> playback pauses -> next deal rotates.
 */

const GAME_NS = '/game';

let httpServer: Server;
let ioServer: ReturnType<typeof attachWs> | null = null;
let port: number;

// ---- fake playback recording calls ----
let playbackCalls: string[] = [];
let playbackEvents: PlaybackEvent[] = [];
let playResult: 'ok' | 'no_device' = 'ok';
let emitPlayback: ((e: PlaybackEvent) => void) | null = null;

function fakePlayback(): PlaybackService {
  return {
    async playDeal(track: { id: string }) {
      playbackCalls.push(`play:${track.id}`);
      if (playResult === 'no_device') {
        const e: PlaybackEvent = { type: 'wake_speaker', copy: "speaker's asleep rn — tap to wake it up", pickedName: 'Speaker' };
        playbackEvents.push(e); emitPlayback?.(e);
        return { ok: false as const, reason: 'no_active_device' as const, copy: e.copy };
      }
      const e: PlaybackEvent = { type: 'playing', trackId: track.id, deviceId: 'dev-1' };
      playbackEvents.push(e); emitPlayback?.(e);
      return { ok: true as const, deviceId: 'dev-1' };
    },
    async pause(cause) {
      playbackCalls.push(`pause:${cause}`);
      emitPlayback?.({ type: 'paused', trackId: null, deviceId: 'dev-1' });
      return;
    },
    async wake() {
      playbackCalls.push('wake');
      const e: PlaybackEvent = { type: 'wake_attempted', deviceId: 'dev-1' };
      playbackEvents.push(e); emitPlayback?.(e);
      return { ok: true as const, deviceId: 'dev-1' };
    },
  } as unknown as PlaybackService;
}

// ---- fake playlist: 30 day-precise playable tracks (roster 2 needs 24) ----
function makeTracks(n: number, precision: 'day' | 'year' = 'day'): SpotifyTrack[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    uri: `spotify:track:t${i}`,
    name: `Song ${i}`,
    duration_ms: 180000,
    is_playable: true,
    artists: [{ name: `Artist ${i}` }],
    album: {
      name: `Album ${i}`,
      release_date: precision === 'day' ? '2020-01-01' : '2020',
      release_date_precision: precision,
    },
  }));
}

const REGISTERED_TRACKS = makeTracks(30);

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
    fetchTracks: async (_token, playlistId) =>
      playlistId === 'small' ? makeTracks(3) : REGISTERED_TRACKS,
    createPlayback: (_token, _speaker, onEvent) => {
      emitPlayback = onEvent;
      return fakePlayback();
    },
  });
  playbackCalls = [];
  playbackEvents = [];
  emitPlayback = null;
  playResult = 'ok';
});

function connect(): Promise<Socket> {
  return new Promise((resolve) => {
    const s = io(`http://localhost:${port}${GAME_NS}`, { path: '/socket.io' });
    s.on('connect', () => resolve(s));
  });
}

function emit(s: Socket, env: unknown) {
  s.emit('action', env);
}

/** Collect every event from the start so fast same-tick broadcasts aren't missed. */
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

async function setupRoom() {
  const host = await connect();
  const guest = await connect();
  const hostBuf = collect(host);
  const guestBuf = collect(guest);
  emit(host, { token: '', action: { type: 'create_room', name: 'hosty' } });
  const created = await waitFor(hostBuf, 'room_created');
  emit(guest, { token: '', action: { type: 'join_room', code: created.room.code, name: 'bestie' } });
  const joined = await waitFor(guestBuf, 'joined');
  return { host, guest, code: created.room.code as string, hostToken: created.token as string, guestToken: joined.token as string, hostBuf, guestBuf };
}

describe('full loop: create -> join -> lock -> deal -> play -> place (mocked spotify)', () => {
  it('runs the whole loop end to end with rotation and pause-on-commit', async () => {
    const { host, guest, code, hostToken, guestToken, hostBuf, guestBuf } = await setupRoom();

    // playlist registration (normally via the select API route w/ host cookie)
    const reg = await (await import('../src/server/game')).registerHostPlaylist(code, {
      sessionId: 'sid-test',
      playlistId: 'pl-big',
      playlistName: 'Bangers Only',
      speakerName: 'Party Speaker',
    });
    expect(reg.ok).toBe(true);
    expect(reg.eligibleCount).toBe(30);
    expect(getHostBinding(code)?.playlistName).toBe('Bangers Only');

    // host locks the roster -> roster_locked -> game_started -> song_dealt
    emit(host, { token: hostToken, action: { type: 'lock_roster' } });
    const lockedHost = await waitFor(hostBuf, 'roster_locked');
    expect(lockedHost.room.status).toBe('locked');
    const started = await waitFor(hostBuf, 'game_started');
    expect(started.room.status).toBe('in_progress');
    expect(started.room.playlistName).toBe('Bangers Only');
    const dealtHost = await waitFor(hostBuf, 'song_dealt');
    const dealtGuest = await waitFor(guestBuf, 'song_dealt');
    expect(dealtHost.track.id).toBe(dealtGuest.track.id);
    // per-player anchors, deterministic + distinct-capable
    expect(Object.keys(dealtHost.anchors).length).toBe(2);
    expect(dealtHost.anchors.hosty ?? dealtHost.anchors[Object.keys(dealtHost.anchors)[0]]).toBeTruthy();
    // playback played the dealt track on the picked speaker
    expect(playbackCalls).toContain(`play:${dealtHost.track.id}`);
    await waitFor(hostBuf, 'playback_state');

    // active player (host was dealt first) places the dealt song -> broadcast + pause
    emit(host, { token: hostToken, action: { type: 'place_song', trackId: dealtHost.track.id, slotIndex: 1 } });
    const placedHost = await waitFor(hostBuf, 'song_placed');
    const placedGuest = await waitFor(guestBuf, 'song_placed');
    expect(placedHost.playerId).toBe(placedGuest.playerId);
    expect(placedHost.trackId).toBe(dealtHost.track.id);

    // rotation: the next song is dealt automatically (after pause-on-commit)
    const dealt2Host = await waitFor(hostBuf, 'song_dealt');
    expect(dealt2Host.track.id).not.toBe(dealtHost.track.id);
    expect(playbackCalls).toContain('pause:placement');
    expect(playbackCalls).toContain(`play:${dealt2Host.track.id}`);

    host.disconnect();
    guest.disconnect();
  });

  it('rejects a roster lock by a non-host', async () => {
    const { guest, guestToken, guestBuf } = await setupRoom();
    emit(guest, { token: guestToken, action: { type: 'lock_roster' } });
    const rej = await waitFor(guestBuf, 'rejected');
    expect(rej.reason).toBe('not_host');
    guest.disconnect();
  });

  it('rejects start when the playlist is too small for the roster (R019), stays locked, and retries with a bigger playlist', async () => {
    const { host, guest, code, hostToken, hostBuf, guestBuf } = await setupRoom();
    const g = await import('../src/server/game');
    const reg = await g.registerHostPlaylist(code, {
      sessionId: 'sid-test',
      playlistId: 'small',
      playlistName: 'Tiny',
      speakerName: 'Party Speaker',
    });
    expect(reg.ok).toBe(true); // registration only reports the count
    emit(host, { token: hostToken, action: { type: 'lock_roster' } });
    await waitFor(hostBuf, 'roster_locked');
    const errHost = await waitFor(hostBuf, 'game_error');
    const errGuest = await waitFor(guestBuf, 'game_error');
    expect(errHost.error).toContain('too smol');
    expect(errHost.recovery).toContain('need');
    expect(errGuest.error).toBe(errHost.error);
    // roster stays locked: late joins still rejected while the host fixes it
    const late = await connect();
    const lateBuf = collect(late);
    emit(late, { token: '', action: { type: 'join_room', code, name: 'Late' } });
    const rej = await waitFor(lateBuf, 'rejected');
    expect(rej.reason).toBe('room_locked');
    late.disconnect();

    // host picks a bigger playlist and retries the start (same lock action)
    const reg2 = await g.registerHostPlaylist(code, {
      sessionId: 'sid-test',
      playlistId: 'pl-big',
      playlistName: 'Bangers Only',
      speakerName: 'Party Speaker',
    });
    expect(reg2.ok).toBe(true);
    emit(host, { token: hostToken, action: { type: 'lock_roster' } });
    const started = await waitFor(hostBuf, 'game_started');
    expect(started.room.status).toBe('in_progress');
    await waitFor(hostBuf, 'song_dealt');
    host.disconnect();
    guest.disconnect();
  });

  it('emits the wake-speaker path when the picked speaker is absent (mocked no device)', async () => {
    const { host, guest, code, hostToken, hostBuf, guestBuf } = await setupRoom();
    playResult = 'no_device';
    const g = await import('../src/server/game');
    await g.registerHostPlaylist(code, {
      sessionId: 'sid-test',
      playlistId: 'pl-big',
      playlistName: 'Bangers Only',
      speakerName: 'Party Speaker',
    });
    emit(host, { token: hostToken, action: { type: 'lock_roster' } });
    const dealt = await waitFor(hostBuf, 'song_dealt');
    const wake = await waitFor(hostBuf, 'playback_state');
    expect(wake.state).toBe('wake_speaker');
    expect(wake.copy).toContain('asleep');
    expect(playbackCalls).toContain(`play:${dealt.track.id}`);

    // host taps wake -> wake attempted; retry plays the pending deal
    emit(host, { token: hostToken, action: { type: 'wake_speaker' } });
    const attempted = await waitFor(hostBuf, 'playback_state');
    void attempted;
    expect(playbackCalls).toContain('wake');
    host.disconnect();
    guest.disconnect();
  });

  it('fails start without a registered playlist and hands back Gen Z copy', async () => {
    const { host, guest, hostToken, hostBuf } = await setupRoom();
    emit(host, { token: hostToken, action: { type: 'lock_roster' } });
    await waitFor(hostBuf, 'roster_locked');
    const err = await waitFor(hostBuf, 'game_error');
    expect(err.error).toContain('hasnt locked a playlist');
    host.disconnect();
    guest.disconnect();
  });
});
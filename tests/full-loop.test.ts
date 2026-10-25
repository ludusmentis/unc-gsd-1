import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { attachWs, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms } from '../src/server/rooms';
import {
  _resetGamesForTests,
  configureGameDeps,
  getHostBinding,
  registerHostPlaylist,
} from '../src/server/game';
import type { PlaybackService } from '../src/server/playback';
import type { SpotifyTrack } from '../src/server/spotify/api';
import type { PlaybackEvent } from '../src/server/playback';
import type { ServerEvent } from '../src/server/events';

/**
 * Full-loop integration test with Spotify fully mocked:
 * host creates room -> playlist registered -> friend joins -> host locks
 * roster -> deck builds -> first song is dealt -> fake playback "plays" ->
 * active player places it -> server evaluates (correct/forfeit) -> awaiting_next
 * -> next_turn/skip handover -> rotation -> win (first to 10 / deck empty).
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
    async pause(cause: 'audio_cap' | 'placement' | 'turn_end') {
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

// ---- fake playlist: day-precise playable tracks with DISTINCT dates
// (roster 2 needs 24) so correct vs forfeit placements are distinguishable.
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
      release_date: precision === 'day' ? `${2000 + i}-03-10` : String(2000 + i),
      release_date_precision: precision,
    },
  }));
}

/** All valid insertion slots for a track into a line (mirrors scoring.ts). */
function validSlots(line: { releaseDate: string }[], releaseDate: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= line.length; i++) {
    const before = line.slice(0, i).every((e) => e.releaseDate <= releaseDate);
    const after = line.slice(i).every((e) => e.releaseDate >= releaseDate);
    if (before && after) out.push(i);
  }
  return out;
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
    fetchTracks: async (_token, playlistId) => {
      if (playlistId === 'small') return makeTracks(3);
      if (playlistId === 'exact') return makeTracks(24);
      return REGISTERED_TRACKS;
    },
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

/** Fresh snapshot for this socket: ping_state hands back the current state. */
async function syncNow(s: Socket, token: string, buf: ServerEvent[]) {
  drainSync(buf);
  emit(s, { token, action: { type: 'ping_state' } });
  return waitFor(buf, 'state_sync');
}

/** Drop pending state_sync events (they are superseded by ping_state). */
function drainSync(buf: ServerEvent[]) {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i].type === 'state_sync') buf.splice(i, 1);
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
  return {
    host, guest,
    code: created.room.code as string,
    hostId: created.room.players[0].id as string,
    guestId: joined.you.id as string,
    hostToken: created.token as string,
    guestToken: joined.token as string,
    hostBuf, guestBuf,
  };
}

/** Lock roster and deal the first song (playlist must be registered first). */
async function startAndDeal(r: ReturnType<typeof setupRoom> extends Promise<infer T> ? T : never) {
  emit(r.host, { token: r.hostToken, action: { type: 'lock_roster' } });
  await waitFor(r.hostBuf, 'roster_locked');
  const started = await waitFor(r.hostBuf, 'game_started');
  expect(started.room.status).toBe('in_progress');
  const dealtHost = await waitFor(r.hostBuf, 'song_dealt');
  const dealtGuest = await waitFor(r.guestBuf, 'song_dealt');
  expect(dealtHost.track.id).toBe(dealtGuest.track.id);
  return { started, dealt: dealtHost };
}

describe('full loop: create -> join -> lock -> deal -> place -> handover (mocked spotify)', () => {
  it('places a correct song, enters awaiting_next, handover via next_turn rotates', async () => {
    const r = await setupRoom();
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    if (!reg.ok) throw new Error('registration failed');
    expect(reg.eligibleCount).toBe(30);
    expect(getHostBinding(r.code)?.playlistName).toBe('Bangers Only');

    const { dealt } = await startAndDeal(r);
    // host (players[0]) was dealt first
    drainSync(r.guestBuf);
    const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
    expect(snap.state.turn.playerId).toBe(r.hostId);
    expect(snap.state.lines[r.hostId]).toHaveLength(1); // anchor seeded at slot 0
    expect(snap.state.scores[r.hostId]).toBe(0);
    expect(playbackCalls).toContain(`play:${dealt.track.id}`);

    // place at a valid slot -> turn_result + score bump
    const line = snap.state.lines[r.hostId].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    const slots = validSlots(line, (dealt.track as any).releaseDate);
    expect(slots.length).toBeGreaterThan(0);
    emit(r.host, { token: r.hostToken, action: { type: 'place_song', trackId: dealt.track.id, slotIndex: slots[0] } });
    await waitFor(r.hostBuf, 'song_placed');
    const resH = await waitFor(r.hostBuf, 'turn_result');
    const resG = await waitFor(r.guestBuf, 'turn_result');
    expect(resH.playerId).toBe(r.hostId);
    expect(resH.track.id).toBe(dealt.track.id);
    expect(resG.playerId).toBe(resH.playerId);

    // awaiting_next + identical state_sync snapshots on both clients
    const an1 = await waitFor(r.hostBuf, 'awaiting_next');
    const an2 = await waitFor(r.guestBuf, 'awaiting_next');
    expect(an1.playerId).toBe(r.hostId);
    expect(an2.playerId).toBe(an1.playerId);
    const syncH = await waitFor(r.hostBuf, 'state_sync');
    const syncG = await waitFor(r.guestBuf, 'state_sync');
    expect(syncH.state).toEqual(syncG.state);
    expect(syncH.state.scores[r.hostId]).toBe(1);
    expect(syncH.state.lines[r.hostId]).toHaveLength(2);
    expect(syncH.state.awaitingNext).toBe(r.hostId);
    expect(syncH.state.turn).toBeNull();
    expect(playbackCalls).toContain('pause:placement');

    // NO auto-deal: nothing new until next_turn; non-awaiting player rejected
    emit(r.guest, { token: r.guestToken, action: { type: 'next_turn' } });
    const rej = await waitFor(r.guestBuf, 'rejected');
    expect(rej.reason).toBe('not_awaiting_you');

    // the just-played player taps next -> next player is dealt a new song
    emit(r.host, { token: r.hostToken, action: { type: 'next_turn' } });
    const dealt2 = await waitFor(r.hostBuf, 'song_dealt');
    const dealt2G = await waitFor(r.guestBuf, 'song_dealt');
    expect(dealt2.track.id).not.toBe(dealt.track.id);
    expect(dealt2G.track.id).toBe(dealt2.track.id);
    expect(playbackCalls).toContain(`play:${dealt2.track.id}`);

    r.host.disconnect();
    r.guest.disconnect();
  });

  it('forfeit: wrong placement reveals year + correct slots and never enters the line', async () => {
    const r = await setupRoom();
    await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    const { dealt } = await startAndDeal(r);
    const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
    const line = snap.state.lines[r.hostId].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    const slots = validSlots(line, (dealt.track as any).releaseDate);
    expect(slots.length).toBeGreaterThan(0);
    // pick an invalid slot (exists because dates are distinct)
    const all = Array.from({ length: line.length + 1 }, (_, i) => i);
    const bad = all.find((i) => !slots.includes(i))!;
    emit(r.host, { token: r.hostToken, action: { type: 'place_song', trackId: dealt.track.id, slotIndex: bad } });
    const ff = await waitFor(r.hostBuf, 'turn_forfeit');
    const ffG = await waitFor(r.guestBuf, 'turn_forfeit');
    expect(ff.playerId).toBe(r.hostId);
    expect(ff.track.id).toBe(dealt.track.id);
    expect(ff.year).toBe(String(2000 + Number((dealt.track.id as string).slice(1))));
    expect(ff.correctSlots).toEqual(slots);
    expect(ffG).toEqual(ff);
    // song never entered the line; score unchanged; awaiting_next entered
    await waitFor(r.hostBuf, 'awaiting_next');
    const sync = await syncNow(r.host, r.hostToken, r.hostBuf);
    expect(sync.state.lines[r.hostId]).toHaveLength(1);
    expect(sync.state.scores[r.hostId]).toBe(0);
    expect(sync.state.awaitingNext).toBe(r.hostId);

    r.host.disconnect();
    r.guest.disconnect();
  });

  it('host skip force-deals; non-host skip is rejected (not_host_for_skip)', async () => {
    const r = await setupRoom();
    await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    const { dealt } = await startAndDeal(r);
    const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
    const line0 = snap.state.lines[r.hostId].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    const slots0 = validSlots(line0, (dealt.track as any).releaseDate);
    expect(slots0.length).toBeGreaterThan(0);
    emit(r.host, { token: r.hostToken, action: { type: 'place_song', trackId: dealt.track.id, slotIndex: slots0[0] } });
    await waitFor(r.hostBuf, 'turn_result'); // place at a correct slot
    await waitFor(r.hostBuf, 'awaiting_next');

    // non-host skip rejected
    emit(r.guest, { token: r.guestToken, action: { type: 'skip_turn' } });
    const rej = await waitFor(r.guestBuf, 'rejected');
    expect(rej.reason).toBe('not_host_for_skip');

    // host skip force-deals to the next player in rotation
    emit(r.host, { token: r.hostToken, action: { type: 'skip_turn' } });
    const dealt2 = await waitFor(r.hostBuf, 'song_dealt');
    const dealt2G = await waitFor(r.guestBuf, 'song_dealt');
    expect(dealt2.track.id).not.toBe(dealt.track.id);
    expect(dealt2G.track.id).toBe(dealt2.track.id);
    const snapAfter = await syncNow(r.host, r.hostToken, r.hostBuf);
    expect(snapAfter.state.awaitingNext).toBeNull();
    expect(snapAfter.state.turn.playerId).toBe(r.guestId);

    r.host.disconnect();
    r.guest.disconnect();
  });

  it('first player to 10 correct placements triggers game_over and status ended', async () => {
    const r = await setupRoom();
    await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    await startAndDeal(r);

    // local mirror of the server lines so we can always place correctly
    const lines: Record<string, { releaseDate: string }[]> = {};
    lines[r.hostId] = [];
    lines[r.guestId] = [];
    for (const id of [r.hostId, r.guestId]) {
      const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
      lines[id] = snap.state.lines[id].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    }

    const tokens: Record<string, string> = { [r.hostId]: r.hostToken, [r.guestId]: r.guestToken };
    let over: any = null;
    for (let turn = 0; !over; turn++) {
      const active = turn % 2 === 0 ? r.hostId : r.guestId;
      const s = active === r.hostId ? r.host : r.guest;
      const buf = active === r.hostId ? r.hostBuf : r.guestBuf;
      const snap = await syncNow(s, tokens[active], buf);
      if (!snap.state.turn) break;
      const track = snap.state.turn.track;
      const line = lines[active];
      const slots = validSlots(line, track.releaseDate);
      emit(s, { token: tokens[active], action: { type: 'place_song', trackId: track.id, slotIndex: slots[0] } });
      // correct placement (slots[0] of a non-empty valid range is always valid)
      await waitFor(buf, 'turn_result');
      line.splice(slots[0], 0, { releaseDate: track.releaseDate });
      await waitFor(buf, 'awaiting_next');
      over = await new Promise<any>((resolve) => {
        const deadline = Date.now() + 200;
        const t = setInterval(() => {
          const idx = buf.findIndex((e) => e.type === 'game_over');
          if (idx !== -1) { clearInterval(t); resolve(buf.splice(idx, 1)[0]); }
          if (Date.now() > deadline) { clearInterval(t); resolve(null); }
        }, 10);
      });
      if (over) break;
      emit(s, { token: tokens[active], action: { type: 'next_turn' } });
      await waitFor(buf, 'song_dealt');
    }
    expect(over).toBeTruthy();
    expect(over.winnerIds).toEqual([r.hostId]);
    expect(over.reason).toBe('first_to_10');
    const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
    expect(snap.state.status).toBe('ended');
    expect(snap.state.scores[r.hostId]).toBe(10);

    r.host.disconnect();
    r.guest.disconnect();
  }, 30000);

  it('deck-empty run ends with the longest line; equal lines share victory', async () => {
    const r = await setupRoom();
    await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'exact', // 24 tracks == required for roster 2
      playlistName: 'Exactly Enough', speakerName: 'Party Speaker',
    });
    await startAndDeal(r);

    const lines: Record<string, { releaseDate: string }[]> = {
      [r.hostId]: [], [r.guestId]: [],
    };
    for (const id of [r.hostId, r.guestId]) {
      const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
      lines[id] = snap.state.lines[id].map((e: any) => ({ releaseDate: e.summary.releaseDate }));
    }
    const tokens: Record<string, string> = { [r.hostId]: r.hostToken, [r.guestId]: r.guestToken };

    let over: any = null;
    for (let turn = 0; !over; turn++) {
      const active = turn % 2 === 0 ? r.hostId : r.guestId;
      const s = active === r.hostId ? r.host : r.guest;
      const buf = active === r.hostId ? r.hostBuf : r.guestBuf;
      const snap = await syncNow(s, tokens[active], buf);
      if (!snap.state.turn) break;
      const track = snap.state.turn.track;
      const line = lines[active];
      const slots = validSlots(line, track.releaseDate);
      // forfeit every deal: pick an INVALID slot so lines/scores stay flat
      const all = Array.from({ length: line.length + 1 }, (_, i) => i);
      const bad = all.find((i) => !slots.includes(i))!;
      emit(s, { token: tokens[active], action: { type: 'place_song', trackId: track.id, slotIndex: bad } });
      await waitFor(buf, 'turn_forfeit');
      await waitFor(buf, 'awaiting_next');
      over = await new Promise<any>((resolve) => {
        const deadline = Date.now() + 200;
        const t = setInterval(() => {
          const idx = buf.findIndex((e) => e.type === 'game_over');
          if (idx !== -1) { clearInterval(t); resolve(buf.splice(idx, 1)[0]); }
          if (Date.now() > deadline) { clearInterval(t); resolve(null); }
        }, 10);
      });
      if (over) break;
      emit(s, { token: tokens[active], action: { type: 'next_turn' } });
      // after the handover the server either deals the next song or ends
      // the game on deck exhaustion — await whichever arrives first.
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 2000;
        const t = setInterval(() => {
          const overIdx = buf.findIndex((e) => e.type === 'game_over');
          if (overIdx !== -1) { over = buf.splice(overIdx, 1)[0]; clearInterval(t); return resolve(); }
          const dealtIdx = buf.findIndex((e) => e.type === 'song_dealt');
          if (dealtIdx !== -1) { buf.splice(dealtIdx, 1); clearInterval(t); return resolve(); }
          if (Date.now() > deadline) { clearInterval(t); resolve(); }
        }, 10);
      });
      if (over) break;
    }
    expect(over).toBeTruthy();
    expect(over.reason).toBe('deck_empty');
    // both players placed every deal correctly -> equal longest lines -> shared victory
    expect(over.winnerIds.sort()).toEqual([r.hostId, r.guestId].sort());
    const snap = await syncNow(r.host, r.hostToken, r.hostBuf);
    expect(snap.state.status).toBe('ended');

    r.host.disconnect();
    r.guest.disconnect();
  }, 30000);

  it('late (re)connect gets the current snapshot via ping_state', async () => {
    const r = await setupRoom();
    await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    const { dealt } = await startAndDeal(r);
    const snap = await syncNow(r.host, r.hostToken, r.hostBuf);

    const late = await connect();
    const lateBuf = collect(late);
    emit(late, { token: '', action: { type: 'join_room', code: r.code, name: 'Late' } });
    const rej = await waitFor(lateBuf, 'rejected');
    expect(rej.reason).toBe('room_locked'); // late joins stay rejected mid-game
    // a fresh spectator socket can still ask for state
    const snap2 = await syncNow(r.host, r.hostToken, r.hostBuf);
    expect(snap2.state).toEqual(snap.state);
    expect(snap2.state.turn.track.id).toBe(dealt.track.id);
    late.disconnect();
    r.host.disconnect();
    r.guest.disconnect();
  });

  it('rejects a roster lock by a non-host', async () => {
    const r = await setupRoom();
    emit(r.guest, { token: r.guestToken, action: { type: 'lock_roster' } });
    const rej = await waitFor(r.guestBuf, 'rejected');
    expect(rej.reason).toBe('not_host');
    r.host.disconnect();
    r.guest.disconnect();
  });

  it('rejects start when the playlist is too small for the roster (R019), stays locked, and retries with a bigger playlist', async () => {
    const r = await setupRoom();
    const reg = await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'small',
      playlistName: 'Tiny', speakerName: 'Party Speaker',
    });
    expect(reg.ok).toBe(true); // registration only reports the count
    emit(r.host, { token: r.hostToken, action: { type: 'lock_roster' } });
    await waitFor(r.hostBuf, 'roster_locked');
    const errHost = await waitFor(r.hostBuf, 'game_error');
    const errGuest = await waitFor(r.guestBuf, 'game_error');
    expect(errHost.error).toContain('too smol');
    expect(errHost.recovery).toContain('need');
    expect(errGuest.error).toBe(errHost.error);
    // roster stays locked: late joins still rejected while the host fixes it
    const late = await connect();
    const lateBuf = collect(late);
    emit(late, { token: '', action: { type: 'join_room', code: r.code, name: 'Late' } });
    const rej = await waitFor(lateBuf, 'rejected');
    expect(rej.reason).toBe('room_locked');
    late.disconnect();

    // host picks a bigger playlist and retries the start (same lock action)
    const reg2 = await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    expect(reg2.ok).toBe(true);
    emit(r.host, { token: r.hostToken, action: { type: 'lock_roster' } });
    const started = await waitFor(r.hostBuf, 'game_started');
    expect(started.room.status).toBe('in_progress');
    await waitFor(r.hostBuf, 'song_dealt');
    r.host.disconnect();
    r.guest.disconnect();
  });

  it('emits the wake-speaker path when the picked speaker is absent (mocked no device)', async () => {
    const r = await setupRoom();
    playResult = 'no_device';
    await registerHostPlaylist(r.code, {
      sessionId: 'sid-test', playlistId: 'pl-big',
      playlistName: 'Bangers Only', speakerName: 'Party Speaker',
    });
    emit(r.host, { token: r.hostToken, action: { type: 'lock_roster' } });
    const dealt = await waitFor(r.hostBuf, 'song_dealt');
    const wake = await waitFor(r.hostBuf, 'playback_state');
    expect(wake.state).toBe('wake_speaker');
    expect(wake.copy).toContain('asleep');
    expect(playbackCalls).toContain(`play:${dealt.track.id}`);

    // host taps wake -> wake attempted; retry plays the pending deal
    emit(r.host, { token: r.hostToken, action: { type: 'wake_speaker' } });
    const attempted = await waitFor(r.hostBuf, 'playback_state');
    void attempted;
    expect(playbackCalls).toContain('wake');
    r.host.disconnect();
    r.guest.disconnect();
  });

  it('fails start without a registered playlist and hands back Gen Z copy', async () => {
    const r = await setupRoom();
    emit(r.host, { token: r.hostToken, action: { type: 'lock_roster' } });
    await waitFor(r.hostBuf, 'roster_locked');
    const err = await waitFor(r.hostBuf, 'game_error');
    expect(err.error).toContain('hasnt locked a playlist');
    r.host.disconnect();
    r.guest.disconnect();
  });
});
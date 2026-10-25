import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { attachWs, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms } from '../src/server/rooms';
import {
  _resetGamesForTests,
  configureGameDeps,
  registerHostPlaylist,
  getGameStateSync,
} from '../src/server/game';
import type { PlaybackService, PlaybackEvent } from '../src/server/playback';
import type { SpotifyTrack } from '../src/server/spotify/api';
import type { ServerEvent } from '../src/server/events';
import { COPY } from '../src/lib/copy';

/**
 * S03-T03 — resilience playback tests (R008 speaker-loss pause + R013 silent
 * mid-deal track replacement).
 *
 * 1. no_active_device mid-deal → speakerPaused flag + COPY.wakeSpeaker
 *    game_error broadcast; host wake retries the CURRENT track and NO turn
 *    was consumed (current player/track + turnIdx unchanged); success clears
 *    the flag and broadcasts playing + state_sync.
 * 2. playability `error` mid-deal → dealer.reject + silent re-deal to the
 *    SAME player (no second turnIdx increment), no client-facing error for
 *    the rejected track — the next song_dealt simply supersedes.
 * 3. deck exhaustion during replacement ends via the deck-empty winners
 *    path with COPY.deckEmpty.
 *
 * Same three-client socket.io harness as tests/game-loop.test.ts, with a
 * programmable fake PlaybackService (scripted playDeal/wake results).
 */

const GAME_NS = '/game';

let httpServer: Server;
let port: number;

type PlayOutcome =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'no_active_device'; copy: string }
  | { ok: false; reason: 'error'; message: string };

/** Programmable fake PlaybackService — scripts queue results per call. */
let playScript: PlayOutcome[] = [];
let wakeScript: ({ ok: true; deviceId: string } | { ok: false; copy: string })[] = [];
let playedTrackIds: string[] = [];
let emitPlayback: ((e: PlaybackEvent) => void) | null = null;

function fakePlayback(): PlaybackService {
  return {
    async playDeal(track: { id: string }) {
      const res = playScript.length > 0 ? playScript.shift()! : { ok: true as const, deviceId: 'dev-1' };
      if (res.ok) {
        playedTrackIds.push(track.id);
        emitPlayback?.({ type: 'playing', trackId: track.id, deviceId: res.deviceId });
      } else if (res.reason === 'no_active_device') {
        emitPlayback?.({ type: 'wake_speaker', copy: COPY.wakeSpeaker.error, pickedName: 'Party Speaker' });
      }
      return res;
    },
    async pause() { /* not exercised here */ },
    async wake() {
      const res = wakeScript.length > 0 ? wakeScript.shift()! : { ok: true as const, deviceId: 'dev-1' };
      if (res.ok) emitPlayback?.({ type: 'wake_attempted', deviceId: res.deviceId });
      return res;
    },
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
  resetRooms();
  resetSessions();
  resetWs();
  _resetGamesForTests();
  configureGameDeps({
    getAccessToken: async () => 'mock-access-token',
    fetchTracks: async (_token, playlistId) => {
      // 'exact36' = exactly requiredDeckSize(3) → 36 eligible − 3 anchors = 33 deals.
      if (playlistId === 'exact36') return makeTracks(36);
      return makeTracks(60);
    },
    createPlayback: (_token, _speaker, onEvent) => {
      emitPlayback = onEvent;
      return fakePlayback();
    },
  });
  playScript = [];
  wakeScript = [];
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

/** Host + two guests join BEFORE lock: a locked 3-phone roster. */
async function setupRoom3(playlistId = 'big') {
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
    sessionId: 'sid-t03', playlistId, playlistName: 'Bangers Only', speakerName: 'Party Speaker',
  });
  if (!reg.ok) throw new Error('registration failed');
  return {
    code,
    sockets: [host, p2, p3] as [Socket, Socket, Socket],
    bufs,
    ids: [created.room.players[0].id as string, j2.you.id as string, j3.you.id as string],
    tokens: [created.token as string, j2.token as string, j3.token as string],
  };
}

/** Lock + start and return the first song_dealt (host deals first). */
async function startAndDeal(r: Room) {
  emit(r.sockets[0], r.tokens[0], { type: 'lock_roster' });
  await waitFor(r.bufs[0], 'roster_locked');
  await waitFor(r.bufs[0], 'game_started');
  return await waitFor(r.bufs[0], 'song_dealt');
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

describe('S03-T03 speaker-loss pause (R008)', () => {
  it('(1) no_active_device mid-deal → paused flag + wake copy; host wake retries the CURRENT track, no turn consumed', async () => {
    const r = await setupRoom3();
    // First deal fails: speaker gone.
    playScript.push({ ok: false, reason: 'no_active_device', copy: COPY.wakeSpeaker.error });
    const dealt = await startAndDeal(r);
    const trackId = dealt.track.id as string;

    // paused broadcast arrived on all clients (game_error with COPY.wakeSpeaker)
    const errs = await Promise.all(r.bufs.map((b) => waitFor(b, 'game_error')));
    for (const e of errs) {
      expect(e.error).toBe(COPY.wakeSpeaker.error);
      expect(e.recovery).toBe(COPY.wakeSpeaker.recovery);
    }

    // Turn NOT consumed: current stays on the same player + track.
    const mid = getGameStateSync(r.code)!;
    expect(mid.speakerPaused).toBe(true);
    expect(mid.turn!.playerId).toBe(r.ids[0]);
    expect(mid.turn!.track.id).toBe(trackId);

    // Host wakes: transfer + re-play the CURRENT track (no new deal).
    wakeScript.push({ ok: true, deviceId: 'dev-1' });
    playScript.push({ ok: true, deviceId: 'dev-1' });
    emit(r.sockets[0], r.tokens[0], { type: 'wake_speaker' });
    // may relay several playback_state events (incl. the pre-wake
    // wake_speaker one) — wait specifically for the post-wake `playing`.
    let playing: any = null;
    for (;;) {
      playing = await waitFor(r.bufs[0], 'playback_state', 3000);
      if (playing.state === 'playing') break;
    }

    // The current track was re-played exactly once and no turn was consumed.
    expect(playedTrackIds.filter((id) => id === trackId).length).toBe(1);
    const after = getGameStateSync(r.code)!;
    expect(after.speakerPaused).toBe(false);
    expect(after.turn!.playerId).toBe(r.ids[0]);
    expect(after.turn!.track.id).toBe(trackId);

    // state_sync broadcast after the clear so clients drop the banner.
    await waitFor(r.bufs[1], 'state_sync', 2000);

    r.sockets.forEach((s) => s.disconnect());
  });

  it('(2) playability error mid-deal → reject + silent re-deal to the SAME player, no client-facing error event', async () => {
    const r = await setupRoom3();
    // First deal: unplayable. Replacement deal: fine.
    playScript.push({ ok: false, reason: 'error', message: 'spotify 404 on play' });
    const dealt1 = await startAndDeal(r);
    const badId = dealt1.track.id as string;

    // The replacement deal supersedes — same player (host), new track.
    const dealt2 = await waitFor(r.bufs[0], 'song_dealt', 3000);
    expect(dealt2.track.id).not.toBe(badId);
    const replaced = getGameStateSync(r.code)!;
    expect(replaced.turn!.playerId).toBe(r.ids[0]); // SAME player — no second rotation
    expect(replaced.speakerPaused).toBe(false); // playability errors never pause

    // The bad track never plays and is blacklisted from ever returning.
    expect(playedTrackIds).not.toContain(badId);

    // No client-facing error event for the rejected track anywhere.
    for (const b of r.bufs) {
      expect(b.some((e) => e.type === 'game_error')).toBe(false);
    }

    // The game continues normally: host places the replacement track.
    const snap = getGameStateSync(r.code)!;
    const line = snap.lines[r.ids[0]].map((e) => ({ releaseDate: e.summary.releaseDate }));
    const slots = validSlots(line, snap.turn!.track.releaseDate);
    expect(slots.length).toBeGreaterThan(0);
    emit(r.sockets[0], r.tokens[0], { type: 'place_song', trackId: snap.turn!.track.id, slotIndex: slots[0] });
    await waitFor(r.bufs[0], 'turn_result');
    await waitFor(r.bufs[0], 'awaiting_next');
    expect(getGameStateSync(r.code)!.scores[r.ids[0]]).toBe(1);

    r.sockets.forEach((s) => s.disconnect());
  });
});

describe('S03-T03 deck exhaustion during silent replacement (R013)', () => {
  it('(3) replacement finds the deck empty → deck-empty winners with COPY.deckEmpty', async () => {
    // 3 players, 36 eligible tracks (exact requiredDeckSize) → deck of 33
    // deals after the 3 anchors are seeded out. Everyone forfeits every
    // placement (lines stay at anchors — no first-to-10 risk), consuming
    // 32 deals; the 33rd deal is scripted unplayable → reject → deck empty →
    // deck-empty winners path with COPY.deckEmpty.
    const r = await setupRoom3('exact36');
    await startAndDeal(r); // deal #1 of 33

    const totalDeals = 33;
    for (let t = 0; t < totalDeals - 1; t++) {
      const i = t % 3;
      const snap = getGameStateSync(r.code)!;
      if (!snap.turn) throw new Error(`no turn at t=${t}`);
      const line = snap.lines[r.ids[i]].map((e) => ({ releaseDate: e.summary.releaseDate }));
      const slots = validSlots(line, snap.turn!.track.releaseDate);
      const all = Array.from({ length: line.length + 1 }, (_, k) => k);
      const bad = all.find((k) => !slots.includes(k))!;
      emit(r.sockets[i], r.tokens[i], { type: 'place_song', trackId: snap.turn!.track.id, slotIndex: bad });
      await waitFor(r.bufs[0], 'turn_forfeit');
      await waitFor(r.bufs[0], 'awaiting_next');
      if (t < totalDeals - 2) {
        emit(r.sockets[i], r.tokens[i], { type: 'next_turn' });
        await waitFor(r.bufs[0], 'song_dealt');
      }
    }

    // The LAST deal (#33) is unplayable: its replacement finds the deck
    // empty → game over via the deck-empty winners path. The player parked on
    // awaiting_next is the last loop iteration's actor (t=31 → i=1).
    playScript.push({ ok: false, reason: 'error', message: 'spotify 404 on play' });
    const lastActor = (totalDeals - 2) % 3; // i at t = totalDeals - 2 = 31
    emit(r.sockets[lastActor], r.tokens[lastActor], { type: 'next_turn' });
    await waitFor(r.bufs[0], 'song_dealt'); // deal #33 was still broadcast
    const over = await waitFor(r.bufs[0], 'game_over', 3000);
    expect(over.reason).toBe('deck_empty');
    expect(over.copy).toBe(COPY.deckEmpty);
    // everyone's line stayed at the anchor → shared victory for all three
    expect((over.winnerIds as string[]).sort()).toEqual([...r.ids].sort());
    expect(getGameStateSync(r.code)!.status).toBe('ended');

    r.sockets.forEach((s) => s.disconnect());
  }, 60000);
});
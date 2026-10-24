import { describe, it, expect, vi } from 'vitest';
import {
  PlaybackService,
  AUDIO_CAP_MS,
  WAKE_SPEAKER_COPY,
  type PlaybackEvent,
} from '../src/server/playback';
import {
  SpotifyPlayerError,
  type PlayerFetch,
  type SpotifyDevice,
} from '../src/server/spotify/player';
import devicesFixture from '../src/server/spotify/fixtures/devices.json';

const fixtureDevices = devicesFixture as SpotifyDevice[];

const TRACK = { id: 't1', uri: 'spotify:track:t1' };

/** Fake transport: routes by endpoint, records every call. */
function fakeTransport(devices: SpotifyDevice[], overrides: Partial<Record<string, { status: number }>> = {}) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl: PlayerFetch = async (url, init) => {
    calls.push({ method: init.method ?? 'GET', url: String(url) });
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\/v1/, '').split('?')[0];
    const ov = overrides[String(url)] ?? overrides[path];
    const status = ov?.status ?? 204;
    return new Response(path === '/me/player/devices' ? JSON.stringify({ devices }) : null, {
      status,
    });
  };
  return { calls, fetchImpl };
}

function makeService(
  devices: SpotifyDevice[],
  opts: {
    picked?: string;
    overrides?: Partial<Record<string, { status: number }>>;
    onEvent?: (e: PlaybackEvent) => void;
    capMs?: number;
  } = {},
) {
  const transport = fakeTransport(devices, opts.overrides);
  const setTimer = vi.fn((_fn: () => void, _ms: number) => ({ id: 1 }));
  const clearTimer = vi.fn();
  const svc = new PlaybackService({
    fetchDevices: async () => {
      transport.calls.push({ method: 'GET', url: 'devices-dep' });
      return devices;
    },
    fetchImpl: transport.fetchImpl,
    pickedSpeakerName: opts.picked ?? 'Party Speaker',
    capMs: opts.capMs ?? AUDIO_CAP_MS,
    setTimer: setTimer as unknown as (fn: () => void, ms: number) => unknown,
    clearTimer: clearTimer as unknown as (t: unknown) => void,
    onEvent: opts.onEvent,
  });
  return { svc, calls: transport.calls, setTimer, clearTimer };
}

describe('playback service', () => {
  it('re-fetches the device list before every deal (never cached)', async () => {
    const { svc, calls } = makeService(fixtureDevices);
    await svc.playDeal(TRACK);
    await svc.playDeal({ id: 't2', uri: 'spotify:track:t2' });
    const deviceFetches = calls.filter((c) => c.url === 'devices-dep');
    expect(deviceFetches.length).toBe(2);
    // play commands went to the matched speaker, not the active phone
    expect(calls.filter((c) => c.url.includes('/me/player/play')).every((c) => c.url.includes('dev-speaker-1'))).toBe(true);
  });

  it('matches the host-picked speaker by name, preferring the active one', async () => {
    const activeSpeaker = fixtureDevices.map((d) => (d.id === 'dev-speaker-1' ? { ...d, is_active: true } : d));
    const { svc, calls } = makeService(activeSpeaker, { picked: 'PARTY SPEAKER' });
    const res = await svc.playDeal(TRACK);
    expect(res).toEqual({ ok: true, deviceId: 'dev-speaker-1' });
    expect(calls.some((c) => c.url.includes('/me/player/play?device_id=dev-speaker-1'))).toBe(true);
  });

  it('arms a ~30s audio cap that pauses audio but keeps placement open (R003)', async () => {
    const pauses: (() => void)[] = [];
    const events: PlaybackEvent[] = [];
    const { svc, setTimer } = makeService(fixtureDevices, {
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'paused') pauses.push(() => undefined);
      },
    });
    const res = await svc.playDeal(TRACK);
    expect(res).toEqual({ ok: true, deviceId: 'dev-speaker-1' });
    expect(setTimer).toHaveBeenCalledTimes(1);
    const [fn, ms] = (setTimer as ReturnType<typeof vi.fn>).mock.calls[0] as [() => void, number];
    expect(ms).toBe(AUDIO_CAP_MS);
    // cap fires -> pause called, audio_cap event emitted; NO forfeit/turn-end event
    await fn();
    expect(events.map((e) => e.type)).toEqual(['playing', 'audio_cap', 'paused']);
    expect(events.find((e) => e.type === 'audio_cap')).toMatchObject({ trackId: 't1' });
    expect(svc).toBeTruthy();
    expect(pauses.length).toBe(1);
  });

  it('disarms the cap when placement is committed (pause on commit)', async () => {
    const { svc, calls, clearTimer } = makeService(fixtureDevices);
    await svc.playDeal(TRACK);
    calls.length = 0;
    await svc.pause('placement');
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.includes('/me/player/pause?device_id=dev-speaker-1'))).toBe(true);
    // second pause still resolves via a fresh device fetch (cap state cleared)
    await svc.pause('turn_end');
    expect(calls.filter((c) => c.url === 'devices-dep').length).toBeGreaterThanOrEqual(1);
  });

  it('emits wake event when the picked speaker is absent from the fresh device list, with Gen Z copy', async () => {
    const events: PlaybackEvent[] = [];
    // Speaker is in standby and not listed at all — only the host phone is active.
    const missingSpeaker = fixtureDevices.filter((d) => d.id !== 'dev-speaker-1');
    const { svc, calls } = makeService(missingSpeaker, { onEvent: (e) => events.push(e) });
    const res = await svc.playDeal(TRACK);
    expect(res).toEqual({ ok: false, reason: 'no_active_device', copy: WAKE_SPEAKER_COPY });
    expect(events.find((e) => e.type === 'wake_speaker')).toMatchObject({
      copy: "speaker's asleep rn — tap to wake it up",
      pickedName: 'Party Speaker',
    });
    // no play command was issued
    expect(calls.filter((c) => c.url.includes('play')).length).toBe(0);
  });

  it('plays to a listed-but-inactive picked speaker via explicit device_id (Spotify wakes it)', async () => {
    const offline = [{ id: 'dev-speaker-1', name: 'Party Speaker', type: 'Speaker', is_active: false }];
    const { svc, calls } = makeService(offline);
    const res = await svc.playDeal(TRACK);
    expect(res).toEqual({ ok: true, deviceId: 'dev-speaker-1' });
    expect(calls.some((c) => c.url.includes('/me/player/play?device_id=dev-speaker-1'))).toBe(true);
  });

  it('wake() transfers playback to the matched device and reports the device id', async () => {
    const offline = [{ id: 'dev-speaker-1', name: 'Party Speaker', type: 'Speaker', is_active: false }];
    const { svc, calls } = makeService(offline);
    const res = await svc.wake();
    expect(res).toEqual({ ok: true, deviceId: 'dev-speaker-1' });
    expect(calls.some((c) => c.url.includes('/me/player') && !c.url.includes('devices') && c.method === 'PUT')).toBe(true);
  });

  it('surfaces Spotify errors without secrets', async () => {
    const events: PlaybackEvent[] = [];
    const { svc } = makeService(fixtureDevices, {
      overrides: { '/me/player/play': { status: 403 } },
      onEvent: (e) => events.push(e),
    });
    const res = await svc.playDeal(TRACK);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('error');
    const errEvent = events.find((e) => e.type === 'playback_error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { message: string }).message).toContain('403');
  });

  it('bubbles network failure from the device fetch', async () => {
    const svc = new PlaybackService({
      fetchDevices: async () => {
        throw new Error('ECONNRESET');
      },
      fetchImpl: fakeTransport([]).fetchImpl,
      pickedSpeakerName: 'Party Speaker',
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });
    const res = await svc.playDeal(TRACK);
    expect(res).toEqual({ ok: false, reason: 'error', message: 'ECONNRESET' });
  });

  it('ignores restricted devices and emits the wake path when nothing usable is listed', async () => {
    const restricted = [{ id: 'dev-speaker-1', name: 'Party Speaker', type: 'Speaker', is_active: true, is_restricted: true }];
    const events: PlaybackEvent[] = [];
    const { svc } = makeService(restricted, { onEvent: (e) => events.push(e) });
    const res = await svc.playDeal(TRACK);
    expect(res).toEqual({ ok: false, reason: 'no_active_device', copy: WAKE_SPEAKER_COPY });
    expect(events.some((e) => e.type === 'wake_speaker')).toBe(true);
  });

  it('SpotifyPlayerError carries status and endpoint', () => {
    const err = new SpotifyPlayerError(404, '/me/player/play');
    expect(err.status).toBe(404);
    expect(err.endpoint).toBe('/me/player/play');
  });
});
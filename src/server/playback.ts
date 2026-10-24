import {
  getDevices,
  playTrack,
  pausePlayback,
  transferPlayback,
  defaultPlayerFetch,
  SpotifyPlayerError,
  type PlayerFetch,
  type SpotifyDevice,
} from './spotify/player';

/**
 * Playback service — plays the dealt song on the host's picked Connect speaker.
 *
 * Contract:
 * - Device list is re-fetched fresh before EVERY deal (device ids churn; never
 *   cached — the host's speaker id from last turn may already be dead).
 * - The host-picked speaker is matched by NAME (stable across reconnects,
 *   unlike ids), case-insensitive.
 * - Play is audio-only with a ~30s cap: placement stays open, no auto-forfeit
 *   (R003). When the cap fires we pause and emit `audio_cap`.
 * - Pause on placement / turn end via pause().
 * - If the picked speaker is absent from the fresh list (standby, renamed,
 *   restricted), we emit a `wake_speaker` event with Gen Z copy and return a
 *   no-active-device result; the host taps "wake the speaker" which calls
 *   wake() (transfer + retry). A listed-but-idle speaker is played directly
 *   via explicit device_id (Spotify wakes it).
 * - All failures bubble as PlaybackError / SpotifyPlayerError; Spotify API
 *   response codes are logged, never secrets.
 */

import type { DeckTrack } from './deck';

export const AUDIO_CAP_MS = 30_000;

export const WAKE_SPEAKER_COPY = "speaker's asleep rn — tap to wake it up";

export type PlaybackEvent =
  | { type: 'playing'; trackId: string; deviceId: string }
  | { type: 'audio_cap'; trackId: string; deviceId: string }
  | { type: 'paused'; trackId: string | null; deviceId: string }
  | { type: 'wake_speaker'; copy: string; pickedName: string }
  | { type: 'wake_attempted'; deviceId: string }
  | { type: 'playback_error'; message: string };

export type PlayResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'no_active_device'; copy: string }
  | { ok: false; reason: 'error'; message: string };

export interface PlaybackDeps {
  /** Fetches the fresh device list. Called before every deal. */
  fetchDevices: () => Promise<SpotifyDevice[]>;
  /** Raw player transport for play/pause/transfer (test-injectable). */
  fetchImpl: PlayerFetch;
  /** Speaker name the host picked in the room. */
  pickedSpeakerName: string;
  /** Audio cap in ms (default ~30s). */
  capMs?: number;
  /** Timer scheduler, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Event sink — structured playback events for the WS layer to relay. */
  onEvent?: (event: PlaybackEvent) => void;
}

export class PlaybackError extends Error {}

/**
 * Wire a PlaybackService to the real Spotify transport for a host access token.
 * The device list is fetched via getDevices() — the service calls its deps
 * afresh before every deal, so ids are never cached.
 */
export function createPlaybackService(opts: {
  accessToken: string;
  pickedSpeakerName: string;
  onEvent?: (event: PlaybackEvent) => void;
  capMs?: number;
}): PlaybackService {
  const fetchImpl = defaultPlayerFetch(opts.accessToken);
  return new PlaybackService({
    fetchDevices: () => getDevices(fetchImpl),
    fetchImpl,
    pickedSpeakerName: opts.pickedSpeakerName,
    onEvent: opts.onEvent,
    capMs: opts.capMs,
  });
}

export class PlaybackService {
  private readonly deps: PlaybackDeps;
  private readonly capMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private capTimer: unknown = null;
  private capDeviceId: string | null = null;
  private capTrackId: string | null = null;

  constructor(deps: PlaybackDeps) {
    this.deps = deps;
    this.capMs = deps.capMs ?? AUDIO_CAP_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  private emit(event: PlaybackEvent) {
    this.deps.onEvent?.(event);
  }

  /**
   * Resolve the host-picked speaker from a FRESH device list (never cached),
   * matched by name (case-insensitive), regardless of is_active — Spotify
   * wakes a listed-but-idle speaker when play names its device_id. No
   * fallback to other devices: if the picked name is absent (speaker in
   * standby, renamed, or restricted) we go to the wake path.
   */
  private async resolveDevice(): Promise<
    { device: SpotifyDevice } | { device: null; devices: SpotifyDevice[] }
  > {
    const devices = await this.deps.fetchDevices(); // ALWAYS fresh — never cached
    const wanted = this.deps.pickedSpeakerName.trim().toLowerCase();
    const matching = devices.filter(
      (d) => d.id && !d.is_restricted && d.name.trim().toLowerCase() === wanted,
    );
    const target = matching.find((d) => d.is_active) ?? matching[0];
    return target ? { device: target } : { device: null, devices };
  }

  /**
   * Play the dealt track. Audio-only: after capMs the audio pauses but the
   * turn/placement stays open (R003 — no auto-forfeit).
   */
  async playDeal(track: Pick<DeckTrack, 'id' | 'uri'>): Promise<PlayResult> {
    try {
      const resolved = await this.resolveDevice();
      if (!resolved.device) {
        this.emit({ type: 'wake_speaker', copy: WAKE_SPEAKER_COPY, pickedName: this.deps.pickedSpeakerName });
        return { ok: false, reason: 'no_active_device', copy: WAKE_SPEAKER_COPY };
      }
      await playTrack(this.deps.fetchImpl, resolved.device.id, track.uri);
      this.emit({ type: 'playing', trackId: track.id, deviceId: resolved.device.id });
      this.armCap(track.id, resolved.device.id);
      return { ok: true, deviceId: resolved.device.id };
    } catch (err) {
      const message = err instanceof SpotifyPlayerError ? `spotify ${err.status} on ${err.endpoint}` : (err as Error).message;
      this.emit({ type: 'playback_error', message });
      return { ok: false, reason: 'error', message };
    }
  }

  /** Arm the audio cap. Clears any previous cap first. */
  private armCap(trackId: string, deviceId: string) {
    this.disarmCap();
    this.capDeviceId = deviceId;
    this.capTrackId = trackId;
    this.capTimer = this.setTimer(async () => {
      this.capTimer = null;
      await this.pause('audio_cap').catch(() => undefined);
    }, this.capMs);
  }

  private disarmCap() {
    if (this.capTimer !== null) {
      this.clearTimer(this.capTimer);
      this.capTimer = null;
    }
  }

  /**
   * Pause playback (placement committed or turn ended). Also disarms the
   * audio cap — pausing for any reason satisfies the cap.
   */
  async pause(cause: 'audio_cap' | 'placement' | 'turn_end'): Promise<void> {
    this.disarmCap();
    let deviceId = this.capDeviceId;
    if (!deviceId) {
      const resolved = await this.resolveDevice();
      if (!resolved.device) {
        this.emit({ type: 'paused', trackId: null, deviceId: 'none' });
        return;
      }
      deviceId = resolved.device.id;
    }
    await pausePlayback(this.deps.fetchImpl, deviceId);
    if (cause === 'audio_cap') {
      this.emit({ type: 'audio_cap', trackId: this.capTrackId!, deviceId });
    }
    this.emit({ type: 'paused', trackId: this.capTrackId, deviceId });
    this.capDeviceId = null;
    this.capTrackId = null;
  }

  /**
   * One-tap "wake the speaker" path: the host taps, we transfer playback to
   * the (freshly re-fetched) matching device and hand back the deviceId so
   * the caller can retry the deal.
   */
  async wake(): Promise<{ ok: true; deviceId: string } | { ok: false; copy: string }> {
    try {
      const resolved = await this.resolveDevice();
      if (!resolved.device) {
        this.emit({ type: 'wake_speaker', copy: WAKE_SPEAKER_COPY, pickedName: this.deps.pickedSpeakerName });
        return { ok: false, copy: WAKE_SPEAKER_COPY };
      }
      if (!resolved.device.is_active) {
        await transferPlayback(this.deps.fetchImpl, resolved.device.id);
      }
      this.emit({ type: 'wake_attempted', deviceId: resolved.device.id });
      return { ok: true, deviceId: resolved.device.id };
    } catch (err) {
      const message = err instanceof SpotifyPlayerError ? `spotify ${err.status} on ${err.endpoint}` : (err as Error).message;
      this.emit({ type: 'playback_error', message });
      return { ok: false, copy: "still sleepy, give it a sec and try again" };
    }
  }
}
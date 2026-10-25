import { SPOTIFY_API_URL } from './auth';

/**
 * Spotify Connect player API wrapper — server-side only. Injectable fetch so
 * tests can mock responses. Every call logs the Spotify response code (never
 * secrets) per the slice observability contract.
 */

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted?: boolean;
}

interface DevicesResponse {
  devices?: SpotifyDevice[];
}

function logPlayer(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'spotify-player', event, ...extra }));
}

export class SpotifyPlayerError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(`spotify player error ${status} for ${endpoint}`);
  }
}

/** Injectable transport: defaults to real fetch with bearer auth. */
export type PlayerFetch = (url: string, init: RequestInit) => Promise<Response>;

export function defaultPlayerFetch(accessToken: string): PlayerFetch {
  return async (url, init) => {
    const res = fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
    });
    return res;
  };
}

async function playerCall<T>(
  fetchImpl: PlayerFetch,
  method: 'GET' | 'PUT',
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API_URL}${endpoint}`;
  try {
    const res = await fetchImpl(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    logPlayer('player_call', { endpoint, method, status: res.status });
    if (!res.ok) {
      // 403/404 on play/pause is common (premium required, device gone) — surface as error
      throw new SpotifyPlayerError(res.status, endpoint);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (err) {
    if (err instanceof SpotifyPlayerError) throw err;
    logPlayer('player_call_failed', { endpoint, method, message: (err as Error).message });
    throw err; // network/timeout bubble up
  }
}

/** List the host's Connect devices. Must be called fresh before each deal. */
export async function getDevices(fetchImpl: PlayerFetch): Promise<SpotifyDevice[]> {
  const data = await playerCall<DevicesResponse>(fetchImpl, 'GET', '/me/player/devices');
  return data?.devices ?? [];
}

/** Play a single track on a device. */
export async function playTrack(
  fetchImpl: PlayerFetch,
  deviceId: string,
  uri: string,
): Promise<void> {
  await playerCall<undefined>(
    fetchImpl,
    'PUT',
    `/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    { uris: [uri] },
  );
}

/** Pause playback on a device. */
export async function pausePlayback(fetchImpl: PlayerFetch, deviceId: string): Promise<void> {
  await playerCall<undefined>(
    fetchImpl,
    'PUT',
    `/me/player/pause?device_id=${encodeURIComponent(deviceId)}`,
  );
}

/** Transfer playback to a device (wake path) without starting anything. */
export async function transferPlayback(
  fetchImpl: PlayerFetch,
  deviceId: string,
): Promise<void> {
  await playerCall<undefined>(fetchImpl, 'PUT', '/me/player', { device_ids: [deviceId], play: false });
}
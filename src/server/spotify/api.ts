import { SPOTIFY_API_URL } from './auth';

/**
 * Spotify Web API client — server-side only. All calls take an access token
 * (obtained via the auto-refresh hook in auth.ts) and an injectable fetch
 * for tests. Pagination is explicit: playlist fetches follow `next` cursors
 * up to a hard page cap so a malformed response cannot loop forever.
 */

export const PLAYLIST_PAGE_SIZE = 100;
export const MAX_PLAYLIST_PAGES = 100; // 10k tracks — far above party-game scale

export interface SpotifyArtist {
  name: string;
}

export interface SpotifyAlbum {
  name: string;
  release_date: string; // e.g. '2021-03-05' (precision may be coarser)
  release_date_precision: 'year' | 'month' | 'day';
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  is_local?: boolean;
  is_playable?: boolean | null;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  tracks: { total: number };
}

interface Paged<T> {
  items: T[];
  next: string | null;
  total?: number;
}

/** Playlist track page: each item wraps the track (which may be null). */
export interface PlaylistPage {
  items?: { track?: SpotifyTrack | null }[];
  next?: string | null;
}
interface PlaylistItem {
  track?: SpotifyTrack | null;
}

function logApi(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'spotify-api', event, ...extra }));
}

async function apiFetch<T>(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    logApi('request_failed', { url: url.split('?')[0], status: res.status });
    throw new Error(`spotify api error ${res.status} for ${url.split('?')[0]}`);
  }
  return (await res.json()) as T;
}

/** List the host's playlists (single page — enough for the picker UI). */
export async function fetchPlaylists(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyPlaylist[]> {
  const page = await apiFetch<Paged<SpotifyPlaylist>>(
    `${SPOTIFY_API_URL}/me/playlists?limit=${PLAYLIST_PAGE_SIZE}`,
    accessToken,
    fetchImpl,
  );
  logApi('playlists_fetched', { count: page.items?.length ?? 0 });
  return page.items ?? [];
}

/**
 * Fetch all tracks of a playlist, following pagination cursors.
 * Throws on malformed responses (missing items array) and on
 * exceeding MAX_PLAYLIST_PAGES (runaway pagination guard).
 */
export async function fetchPlaylistTracks(
  accessToken: string,
  playlistId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url: string | null = `${SPOTIFY_API_URL}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${PLAYLIST_PAGE_SIZE}`;
  let pages = 0;
  while (url && pages < MAX_PLAYLIST_PAGES) {
    const page: PlaylistPage = await apiFetch<PlaylistPage>(url, accessToken, fetchImpl);
    if (!Array.isArray(page.items)) {
      logApi('malformed_page', { playlistId, page: pages });
      throw new Error(`malformed playlist page for ${playlistId}`);
    }
    for (const item of page.items as PlaylistItem[]) {
      const t = item.track;
      if (t && t.id && t.uri) tracks.push(t);
    }
    url = page.next ?? null;
    pages++;
  }
  if (url) {
    logApi('pagination_limit_hit', { playlistId, pages });
    throw new Error(`playlist ${playlistId} exceeded ${MAX_PLAYLIST_PAGES} pages`);
  }
  logApi('playlist_tracks_fetched', { playlistId, count: tracks.length, pages });
  return tracks;
}

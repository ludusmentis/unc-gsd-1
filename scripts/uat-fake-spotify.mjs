/**
 * UAT-only fake Spotify preload (S05-T01 sanctioned workaround for the
 * Spotify OAuth 401 in local UAT — see .gsd/phases/01-song-timeline-party-game
 * /01-05-PLAN.md: "fake playback deps / seeded playlist workaround").
 *
 * Loaded via NODE_OPTIONS="--import ./scripts/uat-fake-spotify.mjs" so the
 * real Next.js dev server (src/server/main.ts) and its route handlers run
 * unchanged; only outbound fetches to *.spotify.com are stubbed:
 *   - accounts.spotify.com/api/token  -> fake token exchange/refresh
 *   - /v1/me/playlists                -> one seeded playlist
 *   - /v1/playlists/<id>/tracks       -> 40 seeded tracks (>= required 36)
 *   - /v1/me/player/devices           -> one active "UAT Speaker" device
 *   - /v1/me/player/*                 -> 204 no-content
 * Everything else falls through to the real fetch.
 *
 * NOT product source: no app/runtime module imports this; it exists purely
 * as the runtime-lane equivalent of tests' configureGameDeps fake deps.
 */
const PLAYLIST_ID = 'uat-playlist-1';

const seededTracks = Array.from({ length: 40 }, (_, i) => {
  const year = 1980 + i;
  return {
    track: {
      id: `uat-track-${i}`,
      name: `UAT Song ${year}`,
      uri: `spotify:track:uat-${i}`,
      duration_ms: 200000,
      is_local: false,
      is_playable: true,
      artists: [{ name: `UAT Artist ${i % 5}` }],
      album: {
        name: `UAT Album ${year}`,
        release_date: `${year}-06-15`,
        release_date_precision: 'day',
      },
    },
  };
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noContent = () => new Response(null, { status: 204 });

export function fakeSpotifyFetch(url, init) {
  const u = typeof url === 'string' ? url : url?.url ?? String(url);
  if (!u.includes('spotify.com')) return null; // fall through to real fetch

  if (u.startsWith('https://accounts.spotify.com/api/token')) {
    return json({
      access_token: 'UAT_ACCESS_TOKEN',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'user-read-private playlist-read-private user-read-playback-state user-modify-playback-state',
      refresh_token: 'UAT_REFRESH_TOKEN',
    });
  }
  if (u.startsWith('https://api.spotify.com/v1/me/playlists')) {
    return json({
      items: [{ id: PLAYLIST_ID, name: 'UAT Seeded Decades', tracks: { total: 40 } }],
      next: null,
      total: 1,
    });
  }
  if (u.includes(`/v1/playlists/${PLAYLIST_ID}/tracks`)) {
    return json({ items: seededTracks, next: null, total: 40 });
  }
  if (u.startsWith('https://api.spotify.com/v1/me/player/devices')) {
    return json({
      devices: [{
        id: 'UAT-speaker',
        is_active: true,
        is_restricted: false,
        name: 'UAT Speaker',
        type: 'Computer',
        volume_percent: 80,
      }],
    });
  }
  if (u.includes('/v1/me/player')) {
    // play / pause / transfer — accept and no-content
    return noContent();
  }
  return null; // unknown spotify surface: fall through (never fake silently)
}

const realFetch = globalThis.fetch;
globalThis.fetch = function patchedFetch(input, init) {
  try {
    const stub = fakeSpotifyFetch(input, init);
    if (stub) return Promise.resolve(stub);
  } catch {
    /* fall through to real fetch */
  }
  return realFetch.call(this, input, init);
};
console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'uat-fake-spotify', event: 'loaded' }));
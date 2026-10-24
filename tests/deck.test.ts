import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fixture from '../src/server/spotify/fixtures/playlist.json';
import type { SpotifyTrack } from '../src/server/spotify/api';
import {
  isEligible,
  eligibleTracks,
  shuffle,
  buildDeck,
  createDealer,
  requiredDeckSize,
  DECK_TOO_SMALL_COPY,
  type DeckTrack,
} from '../src/server/deck';
import {
  exchangeCode,
  refreshTokens,
  saveHostTokens,
  getValidAccessToken,
  getHostTokens,
  newHostSessionId,
  _resetAuthStoreForTests,
  redirectUri,
  envFromHost,
} from '../src/server/spotify/auth';
import { fetchPlaylistTracks, fetchPlaylists, MAX_PLAYLIST_PAGES } from '../src/server/spotify/api';

const fixtureTracks = fixture.tracks.items.map(
  (i) => (i as { track: SpotifyTrack }).track,
);

function mkTrack(id: string, date: string, precision: 'year' | 'month' | 'day', extra: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id,
    name: id,
    uri: `spotify:track:${id}`,
    duration_ms: 200000,
    is_playable: true,
    artists: [{ name: 'X' }],
    album: { name: 'Al', release_date: date, release_date_precision: precision },
    ...extra,
  };
}

function synthTracks(n: number): SpotifyTrack[] {
  return Array.from({ length: n }, (_, i) =>
    mkTrack(`s${String(i).padStart(4, '0')}`, '2010-01-01', 'day'),
  );
}

// ---------------------------------------------------------------------------
// Deck: precision / playability filter (R013/R015)
// ---------------------------------------------------------------------------

describe('deck: precision and playability filter', () => {
  it('excludes year-only and month-only release dates', () => {
    const yearOnly = mkTrack('y', '1965', 'year');
    const monthOnly = mkTrack('m', '1990-05', 'month');
    expect(isEligible(yearOnly)).toBe(false);
    expect(isEligible(monthOnly)).toBe(false);
  });

  it('excludes local files and unplayable tracks', () => {
    expect(isEligible(mkTrack('l', '2001-01-01', 'day', { is_local: true }))).toBe(false);
    expect(isEligible(mkTrack('u', '2008-08-08', 'day', { is_playable: false }))).toBe(false);
  });

  it('fixture yields exactly the 8 day-precision playable tracks', () => {
    const eligible = eligibleTracks(fixtureTracks);
    expect(eligible).toHaveLength(8);
    expect(eligible.map((t) => t.id)).not.toContain('t-year-1');
    expect(eligible.map((t) => t.id)).not.toContain('t-month-1');
    expect(eligible.map((t) => t.id)).not.toContain('t-local-1');
    expect(eligible.map((t) => t.id)).not.toContain('t-unplayable-1');
    expect(eligible[0].releaseDate).toBe('1999-04-01');
  });

  it('rejects a non-YYYY-MM-DD day-precision date string defensively', () => {
    expect(isEligible(mkTrack('weird', 'not-a-date', 'day'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deck: shuffle coverage
// ---------------------------------------------------------------------------

describe('deck: shuffle', () => {
  it('shuffle covers the whole playlist (same multiset, same length)', () => {
    const shuffled = shuffle(fixtureTracks);
    expect(shuffled).toHaveLength(fixtureTracks.length);
    const byId = (a: SpotifyTrack[]) => [...a].map((t) => t.id).sort();
    expect(byId(shuffled)).toEqual(byId(fixtureTracks));
  });

  it('shuffled order differs from input for a large list', () => {
    const big = synthTracks(50);
    let differs = false;
    for (let i = 0; i < 5 && !differs; i++) {
      if (shuffle(big).some((t, idx) => t.id !== big[idx].id)) differs = true;
    }
    expect(differs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deck: anchor seed determinism
// ---------------------------------------------------------------------------

describe('deck: anchor seed', () => {
  it('is deterministic for the same seed and roster', () => {
    const tracks = synthTracks(40); // requiredDeckSize(3) === 36
    const a = buildDeck(tracks, 3, { seed: 'pl1' });
    const b = buildDeck(tracks, 3, { seed: 'pl1' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.anchors.map((t) => t.id)).toEqual(b.anchors.map((t) => t.id));
      expect(a.deck.map((t) => t.id)).toEqual(b.deck.map((t) => t.id));
    }
  });

  it('produces one anchor per player, all from the deck', () => {
    const res = buildDeck(synthTracks(50), 4, { seed: 'pl2' }); // required === 48
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.anchors).toHaveLength(4);
      const deckIds = new Set(res.deck.map((t) => t.id));
      for (const anchor of res.anchors) expect(deckIds.has(anchor.id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Deck: size validation vs roster size (R019)
// ---------------------------------------------------------------------------

describe('deck: deck-size validation (R019)', () => {
  it('required deck size scales with roster (10 rounds + 2/player)', () => {
    expect(requiredDeckSize(2)).toBe(24);
    expect(requiredDeckSize(8)).toBe(96);
  });

  it('rejects a playlist below the threshold with Gen Z copy', () => {
    // 8 eligible fixture tracks < required 24 for a 2-player roster
    const res = buildDeck(fixtureTracks, 2);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('too_few_tracks');
      expect(res.eligibleCount).toBe(8);
      expect(res.required).toBe(24);
      expect(res.recovery).toBe(DECK_TOO_SMALL_COPY);
      expect(res.recovery).toBe('that playlist is too smol, pick a bigger one');
    }
  });

  it('accepts a deck exactly at the threshold (boundary)', () => {
    const atMin = buildDeck(synthTracks(24), 2);
    expect(atMin.ok).toBe(true);
    const belowMin = buildDeck(synthTracks(23), 2);
    expect(belowMin.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dealer: deal iterator with reject(track) (P001)
// ---------------------------------------------------------------------------

describe('dealer: deal iterator with reject', () => {
  const deck: DeckTrack[] = eligibleTracks(synthTracks(5));

  it('deals every track once, then null when exhausted', () => {
    const dealer = createDealer(deck);
    const dealt: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = dealer.deal()!;
      expect(t).toBeTruthy();
      dealt.push(t.id);
    }
    expect(dealer.deal()).toBeNull();
    expect(new Set(dealt).size).toBe(5);
  });

  it('reject(track) silently removes a problem track; replacement is dealt next', () => {
    const dealer = createDealer(deck);
    const first = dealer.deal()!;
    const second = dealer.deal()!;
    dealer.reject(first); // S03-style swap: reject the dealt track
    const third = dealer.deal()!;
    expect(third.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);
    // blacklisted track is never re-dealt; everything else comes out exactly once
    const rest: string[] = [];
    let t: DeckTrack | null;
    while ((t = dealer.deal())) rest.push(t.id);
    const allDealt = [second.id, third.id, ...rest];
    expect(allDealt).toHaveLength(4);
    expect(new Set(allDealt).size).toBe(4);
    expect(allDealt).not.toContain(first.id);
    expect(allDealt).toContain(second.id);
    expect(dealer.remaining()).toBe(0);
  });

  it('reject(track) also prunes a not-yet-dealt track from the queue', () => {
    const dealer = createDealer(deck);
    const notDealtYet = deck[3];
    dealer.reject(notDealtYet);
    const ids: string[] = [];
    let t: DeckTrack | null;
    while ((t = dealer.deal())) ids.push(t.id);
    expect(ids).not.toContain(notDealtYet.id);
    expect(ids).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Spotify auth: mocked integration flow
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
  savedEnv.SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
  process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
  process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
  _resetAuthStoreForTests();
});

afterEach(() => {
  process.env.SPOTIFY_CLIENT_ID = savedEnv.SPOTIFY_CLIENT_ID;
  process.env.SPOTIFY_CLIENT_SECRET = savedEnv.SPOTIFY_CLIENT_SECRET;
});

type MockCall = { url: string; body?: string };

function mockSpotifyFetch(handler: (url: string, body?: string) => { status: number; json: unknown }) {
  const calls: MockCall[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const { status, json } = handler(url, init?.body ? String(init.body) : undefined);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('spotify auth flow (mocked)', () => {
  it('exchanges an authorization code for tokens server-side', async () => {
    const { impl, calls } = mockSpotifyFetch((url, body) => {
      expect(url).toBe('https://accounts.spotify.com/api/token');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=abc123');
      expect(body).toContain(encodeURIComponent('http://localhost:3000/api/auth/callback'));
      return {
        status: 200,
        json: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: 'playlist-read-private' },
      };
    });
    const tokens = await exchangeCode('abc123', redirectUri('dev'), impl);
    expect(tokens.accessToken).toBe('AT1');
    expect(tokens.refreshToken).toBe('RT1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    // client secret sent to spotify, but never exposed in the token payload
    expect(tokens).not.toHaveProperty('client_secret');
  });

  it('bubbles the error when the exchange fails (bad/expired code)', async () => {
    const { impl } = mockSpotifyFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }));
    await expect(exchangeCode('stale', redirectUri('dev'), impl)).rejects.toThrow('400');
  });

  it('stores tokens per host session and auto-refreshes near expiry', async () => {
    const sid = newHostSessionId();
    saveHostTokens(sid, {
      accessToken: 'AT-old',
      refreshToken: 'RT1',
      expiresAt: Date.now() + 10_000, // inside the 60s early-refresh window
    });
    const { impl, calls } = mockSpotifyFetch((_url, body) => {
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=RT1');
      return { status: 200, json: { access_token: 'AT-fresh', expires_in: 3600 } };
    });
    const token = await getValidAccessToken(sid, impl);
    expect(token).toBe('AT-fresh');
    expect(calls).toHaveLength(1);
    // refresh token preserved when Spotify omits a new one
    expect(getHostTokens(sid)?.refreshToken).toBe('RT1');
  });

  it('returns a valid token without refreshing while it is fresh', async () => {
    const sid = newHostSessionId();
    saveHostTokens(sid, { accessToken: 'AT-fresh2', refreshToken: 'RT2', expiresAt: Date.now() + 3600_000 });
    const { impl, calls } = mockSpotifyFetch(() => ({ status: 200, json: {} }));
    expect(await getValidAccessToken(sid, impl)).toBe('AT-fresh2');
    expect(calls).toHaveLength(0);
  });

  it('refreshTokens throws when Spotify rejects the refresh token', async () => {
    const { impl } = mockSpotifyFetch(() => ({ status: 401, json: { error: 'invalid_grant' } }));
    await expect(refreshTokens('bogus', impl)).rejects.toThrow('401');
  });

  it('envFromHost picks the prod redirect URI on un.clord.org', () => {
    expect(envFromHost('un.clord.org')).toBe('prod');
    expect(redirectUri('prod')).toBe('https://un.clord.org/api/auth/callback');
    expect(envFromHost('localhost:3000')).toBe('dev');
  });
});

// ---------------------------------------------------------------------------
// Spotify API: playlist fetch with pagination (mocked)
// ---------------------------------------------------------------------------

describe('spotify api: playlist pagination (mocked)', () => {
  it('follows the next cursor across pages', async () => {
    const page1 = {
      items: [{ track: mkTrack('p1a', '2001-01-01', 'day') }, { track: mkTrack('p1b', '2002-02-02', 'day') }],
      next: 'https://api.spotify.com/v1/playlists/pl/trackspage2',
    };
    const page2 = { items: [{ track: mkTrack('p2a', '2003-03-03', 'day') }], next: null };
    const { impl, calls } = mockSpotifyFetch((url) => {
      if (url.includes('page2')) return { status: 200, json: page2 };
      return { status: 200, json: page1 };
    });
    const tracks = await fetchPlaylistTracks('AT', 'pl', impl);
    expect(tracks.map((t) => t.id)).toEqual(['p1a', 'p1b', 'p2a']);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/playlists/pl/tracks');
    expect(calls[0].url).toContain('limit=100');
  });

  it('throws on a malformed page (missing items)', async () => {
    const { impl } = mockSpotifyFetch(() => ({ status: 200, json: { nope: true } }));
    await expect(fetchPlaylistTracks('AT', 'pl', impl)).rejects.toThrow('malformed');
  });

  it('throws on an API error status instead of returning garbage', async () => {
    const { impl } = mockSpotifyFetch(() => ({ status: 403, json: { error: { message: 'forbidden' } } }));
    await expect(fetchPlaylistTracks('AT', 'pl', impl)).rejects.toThrow('403');
  });

  it('never follows more than MAX_PLAYLIST_PAGES cursors', async () => {
    const loopPage = {
      items: [{ track: mkTrack('x', '2001-01-01', 'day') }],
      next: 'https://api.spotify.com/v1/playlists/pl/trackspage-loop',
    };
    const { impl } = mockSpotifyFetch(() => ({ status: 200, json: loopPage }));
    await expect(fetchPlaylistTracks('AT', 'pl', impl)).rejects.toThrow('exceeded');
    void MAX_PLAYLIST_PAGES;
  });

  it('fetchPlaylists returns the host playlist list', async () => {
    const { impl } = mockSpotifyFetch(() => ({
      status: 200,
      json: { items: [{ id: 'pl1', name: 'Bangers', tracks: { total: 40 } }] },
    }));
    const lists = await fetchPlaylists('AT', impl);
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Bangers');
  });
});

import type { SpotifyTrack } from './spotify/api';

/**
 * Deck module — filter, validate, shuffle, anchor seed, deal iterator.
 *
 * R015/R013: only tracks with release_date_precision === 'day' that are
 * playable (not local files, not unavailable) enter the deck.
 * R019: deck size is validated against roster size before a room is
 * created; too-small playlists are rejected with a Gen Z message.
 * P001: dealing is a pull-from-iterator with reject(track) so S03 can
 * silently replace problem tracks mid-game without refactoring.
 */

export const ROUNDS_PER_GAME = 10; // first-to-10 scoring needs enough turns
export const MIN_TRACKS_PER_PLAYER = 2; // anchor seed + first dealt track

/** Required deck size for a roster: enough for 10 rounds each plus 2/player seeds. */
export function requiredDeckSize(rosterSize: number): number {
  return ROUNDS_PER_GAME * rosterSize + MIN_TRACKS_PER_PLAYER * rosterSize;
}

export type DeckTrack = SpotifyTrack & { releaseDate: string };

export type DeckBuildResult =
  | { ok: true; deck: DeckTrack[]; eligibleCount: number; anchors: DeckTrack[] }
  | { ok: false; reason: 'too_few_tracks'; eligibleCount: number; required: number; recovery: string };

export const DECK_TOO_SMALL_COPY =
  'that playlist is too smol, pick a bigger one';

/** R013/R015 eligibility: playable, not local, precise release date. */
export function isEligible(track: SpotifyTrack): boolean {
  if (track.is_local) return false;
  if (track.is_playable === false) return false;
  if (track.album?.release_date_precision !== 'day') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(track.album.release_date ?? '');
}

export function eligibleTracks(tracks: SpotifyTrack[]): DeckTrack[] {
  return tracks
    .filter(isEligible)
    .map((t) => ({ ...t, releaseDate: t.album.release_date }));
}

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32) — stable anchor seeds per playlist.
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** Fisher–Yates shuffle (injectable rng). Returns a new array. */
export function shuffle<T>(items: T[], rng: Rng = mulberry32(hashString(String(Date.now())))): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build the deck for a room. Deterministic given (seed, playlist): the same
 * inputs always produce the same shuffled deck and anchor seeds.
 */
export function buildDeck(
  tracks: SpotifyTrack[],
  rosterSize: number,
  opts: { seed?: string } = {},
): DeckBuildResult {
  const eligible = eligibleTracks(tracks);
  const required = requiredDeckSize(rosterSize);
  if (eligible.length < required) {
    return {
      ok: false,
      reason: 'too_few_tracks',
      eligibleCount: eligible.length,
      required,
      recovery: DECK_TOO_SMALL_COPY,
    };
  }
  const seed = opts.seed ?? 'nursehound';
  const shuffled = shuffle(eligible, mulberry32(hashString(seed)));
  // Anchor seeds: one per player, evenly spread across the deck so anchors
  // differ per player and are deterministic.
  const anchors: DeckTrack[] = [];
  const step = Math.floor(shuffled.length / rosterSize);
  for (let p = 0; p < rosterSize; p++) {
    anchors.push(shuffled[Math.min(p * step, shuffled.length - 1)]);
  }
  return { ok: true, deck: shuffled, eligibleCount: eligible.length, anchors };
}

// ---------------------------------------------------------------------------
// Deal iterator with reject(track) — P001 pattern.
// ---------------------------------------------------------------------------

export interface Dealer {
  /** Pull the next track, or null when the deck is exhausted. */
  deal(): DeckTrack | null;
  /**
   * Reject a problem track (S03 R013): the track is removed from the
   * remaining deck and blacklisted so it is never re-dealt; the caller
   * calls deal() again for its silent replacement.
   */
  reject(track: DeckTrack): void;
  /** Tracks remaining (excluding rejected blacklists). */
  remaining(): number;
  /** Remaining tracks in deal order (S03 persistence: no shuffle on restore). */
  remainingTracks(): DeckTrack[];
}

export function createDealer(deck: DeckTrack[]): Dealer {
  const queue = [...deck];
  const blacklisted = new Set<string>();

  const prune = () => {
    while (queue.length > 0 && blacklisted.has(queue[0].id)) queue.shift();
  };

  return {
    deal() {
      prune();
      return queue.length > 0 ? queue.shift()! : null;
    },
    reject(track: DeckTrack) {
      blacklisted.add(track.id);
      const idx = queue.findIndex((t) => t.id === track.id);
      if (idx !== -1) queue.splice(idx, 1);
    },
    remaining() {
      return queue.filter((t) => !blacklisted.has(t.id)).length;
    },
    remainingTracks() {
      prune();
      return queue.map((t) => ({ ...t }));
    },
  };
}

// Pure scoring module for the timeline game.
// Server-authoritative: all functions are side-effect free and operate on
// TrackSummary-shaped entries ({ trackId, releaseDate, year }). Dates are
// compared as full release_date strings (ISO yyyy-mm-dd compares
// lexicographically == chronologically). No Spotify, no network, no state.

/** Minimal track shape needed for scoring; structurally compatible with TrackSummary from events.ts. */
export interface ScoringTrack {
  trackId: string;
  releaseDate: string;
  year?: number;
}

export const WIN_SCORE = 10;

export type PlacementResult =
  | { result: 'correct'; line: ScoringTrack[] }
  | { result: 'forfeit' };

function validDate(d: unknown): d is string {
  return typeof d === 'string' && d.length > 0;
}

/**
 * A track may be inserted at `slotIndex` iff it is pairwise ordered against
 * every existing line entry: every entry before the slot must have a
 * release_date <= the track's, and every entry at/after the slot must have a
 * release_date >= the track's. Same-date ties satisfy both, so a tied track
 * is correct in either direction.
 */
export function isValidSlot(
  line: readonly ScoringTrack[],
  track: ScoringTrack,
  slotIndex: number
): boolean {
  if (!validDate(track.releaseDate) || !Number.isInteger(slotIndex)) return false;
  if (slotIndex < 0 || slotIndex > line.length) return false;
  for (let i = 0; i < slotIndex; i++) {
    if (!validDate(line[i]?.releaseDate)) return false;
    if (line[i].releaseDate > track.releaseDate) return false;
  }
  for (let i = slotIndex; i < line.length; i++) {
    if (!validDate(line[i]?.releaseDate)) return false;
    if (track.releaseDate > line[i].releaseDate) return false;
  }
  return true;
}

/**
 * Evaluate a placement. Returns 'correct' with the resulting line (the track
 * inserted at slotIndex — the anchor at slot 0 is just a line entry like any
 * other), or 'forfeit' when the slot is invalid. Never mutates the input.
 */
export function evaluatePlacement(
  line: readonly ScoringTrack[],
  track: ScoringTrack,
  slotIndex: number
): PlacementResult {
  if (!isValidSlot(line, track, slotIndex)) return { result: 'forfeit' };
  const next = line.slice();
  next.splice(slotIndex, 0, { ...track });
  return { result: 'correct', line: next };
}

/**
 * All valid insertion slots for a track, as the minimal contiguous range.
 * Used for the forfeit reveal ("the year and the correct spot").
 * Returns [] when the track cannot be placed anywhere (bad/missing date).
 */
export function computeCorrectSlots(
  line: readonly ScoringTrack[],
  track: ScoringTrack
): number[] {
  const slots: number[] = [];
  for (let i = 0; i <= line.length; i++) {
    if (isValidSlot(line, track, i)) slots.push(i);
  }
  return slots;
}

/** First-to-10 win condition. */
export function hasWonByScore(score: number): boolean {
  return score >= WIN_SCORE;
}

/**
 * Deck-empty win: longest line wins. Ties are shared victories.
 * Accepts a Map of playerId -> line (the shape game.ts keeps).
 */
export function deckEmptyWinners(lines: ReadonlyMap<string, readonly ScoringTrack[]>, tieBreaker?: (a: string, b: string) => number): string[] {
  const ids = [...lines.keys()].filter((id) => lines.get(id) !== undefined);
  if (ids.length === 0) return [];
  let maxLen = 0;
  for (const id of ids) maxLen = Math.max(maxLen, lines.get(id)!.length);
  const winners = ids.filter((id) => lines.get(id)!.length === maxLen);
  if (tieBreaker && winners.length > 1) {
    return winners.sort((a, b) => tieBreaker(a, b));
  }
  return winners;
}
import { describe, expect, it } from 'vitest';
import {
  WIN_SCORE,
  computeCorrectSlots,
  deckEmptyWinners,
  evaluatePlacement,
  hasWonByScore,
  isValidSlot,
  type ScoringTrack,
} from '../src/server/scoring';

const t = (id: string, releaseDate: string): ScoringTrack => ({
  trackId: id,
  releaseDate,
  year: Number(releaseDate.slice(0, 4)),
});

describe('evaluatePlacement / isValidSlot', () => {
  // anchor at slot 0 treated as a normal line entry
  const line = () => [t('a', '1973-01-01'), t('b', '1985-06-15'), t('c', '2001-09-11')];

  it('correct: before the first entry', () => {
    const r = evaluatePlacement(line(), t('new', '1962-03-04'), 0);
    expect(r).toEqual({ result: 'correct', line: [t('new', '1962-03-04'), ...line()] });
  });

  it('correct: after the last entry', () => {
    const r = evaluatePlacement(line(), t('new', '2020-05-05'), 3);
    expect(r.result).toBe('correct');
    expect(r.result === 'correct' && r.line.length).toBe(4);
    expect(r.result === 'correct' && r.line[3].trackId).toBe('new');
  });

  it('correct: between entries', () => {
    const r = evaluatePlacement(line(), t('new', '1990-02-02'), 2);
    expect(r.result).toBe('correct');
    expect(r.result === 'correct' && r.line.map((x) => x.trackId)).toEqual(['a', 'b', 'new', 'c']);
  });

  it('forfeit: wrong slot (too early)', () => {
    expect(evaluatePlacement(line(), t('new', '1990-02-02'), 1)).toEqual({ result: 'forfeit' });
  });

  it('forfeit: wrong slot (too late)', () => {
    expect(evaluatePlacement(line(), t('new', '1980-08-08'), 3)).toEqual({ result: 'forfeit' });
  });

  it('forfeit: out-of-range slot', () => {
    expect(evaluatePlacement(line(), t('new', '2020-01-01'), 4)).toEqual({ result: 'forfeit' });
    expect(evaluatePlacement(line(), t('new', '1962-01-01'), -1)).toEqual({ result: 'forfeit' });
  });

  it('forfeit: missing/invalid release date', () => {
    expect(evaluatePlacement(line(), { trackId: 'x', releaseDate: '' }, 0)).toEqual({ result: 'forfeit' });
    expect(evaluatePlacement(line(), { trackId: 'x', releaseDate: undefined as unknown as string }, 1)).toEqual({ result: 'forfeit' });
  });

  it('does not mutate the input line', () => {
    const l = line();
    evaluatePlacement(l, t('new', '1990-01-01'), 2);
    expect(l.map((x) => x.trackId)).toEqual(['a', 'b', 'c']);
  });

  it('same-date tie is correct in either direction', () => {
    // track tied with entry b (1985-06-15): before AND after b are both correct
    const tie = t('tie', '1985-06-15');
    expect(evaluatePlacement(line(), tie, 1).result).toBe('correct'); // before b
    expect(evaluatePlacement(line(), tie, 2).result).toBe('correct'); // after b
    // tied with the anchor at slot 0: slot 0 and slot 1 both valid
    const tieAnchor = t('ta', '1973-01-01');
    expect(evaluatePlacement(line(), tieAnchor, 0).result).toBe('correct');
    expect(evaluatePlacement(line(), tieAnchor, 1).result).toBe('correct');
    expect(evaluatePlacement(line(), tieAnchor, 2).result).toBe('forfeit');
  });

  it('tie spans multiple valid slots (minimal contiguous range)', () => {
    const l = [t('a', '1990-01-01'), t('b', '1990-01-01')];
    const tie = t('tie', '1990-01-01');
    expect(computeCorrectSlots(l, tie)).toEqual([0, 1, 2]);
    expect(isValidSlot(l, tie, 3)).toBe(false);
  });

  it('anchor at slot 0 is compared like any other line entry', () => {
    // older than anchor -> must go before it, not after
    expect(evaluatePlacement(line(), t('old', '1950-01-01'), 0).result).toBe('correct');
    expect(evaluatePlacement(line(), t('old', '1950-01-01'), 1).result).toBe('forfeit');
  });
});

describe('computeCorrectSlots (forfeit reveal)', () => {
  it('returns the minimal valid slot(s) for a forfeited track', () => {
    const l = [t('a', '1973-01-01'), t('c', '2001-09-11')];
    expect(computeCorrectSlots(l, t('x', '1985-06-15'))).toEqual([1]);
  });

  it('returns empty for tracks with bad dates', () => {
    expect(computeCorrectSlots([t('a', '2000-01-01')], t('x', ''))).toEqual([]);
  });

  it('single-entry line: valid slots are 0 and/or 1', () => {
    expect(computeCorrectSlots([t('a', '2000-01-01')], t('x', '1999-12-31'))).toEqual([0]);
    expect(computeCorrectSlots([t('a', '2000-01-01')], t('x', '2000-01-01'))).toEqual([0, 1]);
    expect(computeCorrectSlots([t('a', '2000-01-01')], t('x', '2001-01-01'))).toEqual([1]);
  });

  it('empty line: only slot 0 valid', () => {
    expect(computeCorrectSlots([], t('x', '2000-01-01'))).toEqual([0]);
  });
});

describe('win helpers', () => {
  it('win at 10 (and above), not before', () => {
    expect(hasWonByScore(10)).toBe(true);
    expect(hasWonByScore(11)).toBe(true);
    expect(hasWonByScore(9)).toBe(false);
    expect(hasWonByScore(0)).toBe(false);
    expect(WIN_SCORE).toBe(10);
  });

  it('deck-empty longest line wins', () => {
    const lines = new Map<string, ScoringTrack[]>([
      ['p1', [t('a', '2000-01-01'), t('b', '2001-01-01')]],
      ['p2', [t('c', '2002-01-01')]],
    ]);
    expect(deckEmptyWinners(lines)).toEqual(['p1']);
  });

  it('equal-max lines share victory', () => {
    const lines = new Map<string, ScoringTrack[]>([
      ['p1', [t('a', '2000-01-01'), t('b', '2001-01-01')]],
      ['p2', [t('c', '2000-01-01'), t('d', '2002-01-01')]],
      ['p3', [t('e', '2005-01-01')]],
    ]);
    expect(deckEmptyWinners(lines)).toContain('p1');
    expect(deckEmptyWinners(lines)).toContain('p2');
    expect(deckEmptyWinners(lines)).toHaveLength(2);
  });

  it('empty lines map yields no winners', () => {
    expect(deckEmptyWinners(new Map())).toEqual([]);
  });

  it('apply tieBreaker ordering when provided', () => {
    const lines = new Map<string, ScoringTrack[]>([
      ['p1', [t('a', '2000-01-01')]],
      ['p2', [t('b', '2001-01-01')]],
    ]);
    // tieBreaker only orders the shared-victory list, never picks a single winner
    expect(deckEmptyWinners(lines, (a) => (a === 'p1' ? -1 : 1))).toEqual(['p1', 'p2']);
    expect(deckEmptyWinners(lines, (a) => (a === 'p1' ? 1 : -1))).toEqual(['p2', 'p1']);
  });
});
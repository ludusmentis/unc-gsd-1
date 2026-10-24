import { describe, it, expect } from 'vitest';
import {
  clampSlot,
  insertionIndex,
  slotFromPoint,
  buildSlots,
  slotKey,
  placeSongEnvelope,
  isValidSlotIndex,
  yearLabel,
  MAX_LINE_SLOTS,
  MIN_TARGET_PX,
  LONG_PRESS_MS,
  type TrackSummary,
} from '../src/lib/dnd';
import { isValidPlacement, MAX_LINE_SLOTS as SERVER_MAX_SLOTS } from '../src/server/ws';
import { entriesToSlots } from '../src/lib/dnd';
import { randomQuip, QUIP_COUNT } from '../src/lib/commentary';
import { COPY } from '../src/lib/copy';

const song = (id: string, year = '1999'): TrackSummary => ({
  id,
  name: `Song ${id}`,
  artists: ['Artist'],
  albumName: 'Album',
  releaseDate: `${year}-07-01`,
  year,
});

describe('slot index math', () => {
  it('insertionIndex: before first, between, after last, empty line', () => {
    const centers = [100, 300, 500];
    expect(insertionIndex(0, centers)).toBe(0);
    expect(insertionIndex(99, centers)).toBe(0);
    expect(insertionIndex(150, centers)).toBe(1);
    expect(insertionIndex(299, centers)).toBe(1);
    expect(insertionIndex(400, centers)).toBe(2);
    expect(insertionIndex(9999, centers)).toBe(3);
    expect(insertionIndex(50, [])).toBe(0);
  });

  it('slotFromPoint: hit inside a zone, near-miss snaps to nearest, empty list', () => {
    const rects = [
      { left: 0, top: 0, right: 200, bottom: 48 },
      { left: 200, top: 0, right: 400, bottom: 48 },
    ];
    expect(slotFromPoint(100, 24, rects)).toBe(0);
    expect(slotFromPoint(350, 24, rects)).toBe(1);
    expect(slotFromPoint(205, 60, rects)).toBe(1); // just below zone 1
    expect(slotFromPoint(1, 1000, rects)).toBe(0); // vertical far miss, x nearest zone 0
    expect(slotFromPoint(0, 0, [])).toBe(-1);
  });

  it('clampSlot clamps non-integers and out-of-range values', () => {
    expect(clampSlot(-5, 3)).toBe(0);
    expect(clampSlot(1.5, 3)).toBe(0);
    expect(clampSlot(2, 3)).toBe(2);
    expect(clampSlot(99, 3)).toBe(3);
    expect(clampSlot(NaN, 3)).toBe(0);
  });

  it('drop-zone floor is 48px and long-press is 350ms', () => {
    expect(MIN_TARGET_PX).toBe(48);
    expect(LONG_PRESS_MS).toBe(350);
  });
});

describe('anchor seed line model', () => {
  it('line is seeded with the anchor song first, even with placements', () => {
    const slots = buildSlots(song('anchor'), [
      { trackId: 'b', slotIndex: 1, track: song('b') },
      { trackId: 'a', slotIndex: 0, track: song('a') },
    ]);
    expect(slots[0].kind).toBe('anchor');
    if (slots[0].kind === 'anchor') expect(slots[0].track.id).toBe('anchor');
    expect(slots.map((s) => (s.kind === 'placed' ? s.trackId : 'anchor'))).toEqual(['anchor', 'a', 'b']);
  });

  it('placements render in slot order; unknown tracks render as placeholders', () => {
    const slots = buildSlots(null, [
      { trackId: 'z', slotIndex: 5, track: null },
      { trackId: 'a', slotIndex: 2, track: song('a') },
    ]);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ kind: 'placed', trackId: 'a', slotIndex: 2 });
    expect(slots[1]).toMatchObject({ kind: 'placed', trackId: 'z', track: null });
  });

  it('negative: malformed slot indices are dropped from the line', () => {
    const slots = buildSlots(null, [
      { trackId: 'good', slotIndex: 0 },
      { trackId: 'neg', slotIndex: -1 },
      { trackId: 'frac', slotIndex: 1.5 },
      { trackId: 'nan', slotIndex: NaN },
      { trackId: 'huge', slotIndex: MAX_LINE_SLOTS + 1 },
    ]);
    expect(slots.map((s) => (s.kind === 'placed' ? s.trackId : null))).toEqual(['good']);
  });

  it('slotKey is stable and distinguishes anchor from placements', () => {
    const slots = buildSlots(song('a'), [{ trackId: 'b', slotIndex: 0, track: song('b') }]);
    expect(slotKey(slots[0], 0)).toBe('anchor');
    expect(slotKey(slots[1], 1)).toMatch(/^slot-0-b-1$/);
  });
});

describe('commit event shape', () => {
  it('place_song envelope carries token, trackId and integer slotIndex', () => {
    const env = placeSongEnvelope('tok123', 'track-9', 3);
    expect(env.token).toBe('tok123');
    expect(env.action).toEqual({ type: 'place_song', trackId: 'track-9', slotIndex: 3 });
    expect(env.action.type === 'place_song' && Number.isInteger(env.action.slotIndex)).toBe(true);
  });

  it('isValidSlotIndex accepts 0..MAX and rejects non-integers/negatives/overflows', () => {
    expect(isValidSlotIndex(0)).toBe(true);
    expect(isValidSlotIndex(MAX_LINE_SLOTS)).toBe(true);
    expect(isValidSlotIndex(-1)).toBe(false);
    expect(isValidSlotIndex(1.5)).toBe(false);
    expect(isValidSlotIndex('3')).toBe(false);
    expect(isValidSlotIndex(null)).toBe(false);
    expect(isValidSlotIndex(MAX_LINE_SLOTS + 1)).toBe(false);
  });

  it('client cap mirrors the server WS gate cap', () => {
    expect(SERVER_MAX_SLOTS).toBe(MAX_LINE_SLOTS);
  });
});

describe('server placement gate (R020 surface)', () => {
  it('valid placements pass', () => {
    expect(isValidPlacement('abc123', 0)).toBe(true);
    expect(isValidPlacement('abc123', SERVER_MAX_SLOTS)).toBe(true);
  });

  it('negative: malformed trackIds and slotIndices are rejected', () => {
    expect(isValidPlacement('', 0)).toBe(false);
    expect(isValidPlacement('x'.repeat(65), 0)).toBe(false);
    expect(isValidPlacement(42, 0)).toBe(false);
    expect(isValidPlacement(null, 0)).toBe(false);
    expect(isValidPlacement('abc', -1)).toBe(false);
    expect(isValidPlacement('abc', 2.5)).toBe(false);
    expect(isValidPlacement('abc', '0')).toBe(false);
    expect(isValidPlacement('abc', Infinity)).toBe(false);
    expect(isValidPlacement('abc', NaN)).toBe(false);
  });
});

describe('server snapshot line rendering (T04)', () => {
  const sum = (id: string, year: string) => ({
    id,
    name: `Song ${id}`,
    artists: ['Artist'],
    albumName: 'Album',
    releaseDate: `${year}-07-01`,
    year,
  });

  it('entriesToSlots: anchor first, entries in server order with summaries', () => {
    const slots = entriesToSlots([
      { trackId: 'a', summary: sum('a', '1990') },
      { trackId: 'b', summary: sum('b', '1995') },
      { trackId: 'c', summary: sum('c', '2000') },
    ]);
    expect(slots[0].kind).toBe('anchor');
    if (slots[0].kind === 'anchor') expect(slots[0].track.year).toBe('1990');
    expect(slots.map((s) => (s.kind === 'placed' ? s.trackId : 'anchor'))).toEqual(['anchor', 'b', 'c']);
    expect(slots.filter((s) => s.kind === 'placed').every((s) => s.kind === 'placed' && s.track?.year)).toBe(true);
  });

  it('entriesToSlots: empty snapshot renders empty line', () => {
    expect(entriesToSlots([])).toEqual([]);
  });
});

describe('watcher commentary (T04)', () => {
  it('quip pool holds ~50 non-empty entries and picks deterministic values', () => {
    expect(QUIP_COUNT).toBeGreaterThanOrEqual(50);
    const a = randomQuip(() => 0);
    const b = randomQuip(() => 0.999);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(randomQuip(() => 0)).toBe(a);
    expect(randomQuip(() => 0.999)).toBe(b);
  });
});

describe('client copy source (T04)', () => {
  it('forfeitReveal interpolates the year; handover/next/skip strings exist', () => {
    expect(COPY.forfeitReveal.replace('{year}', '1988')).toBe('nah — it dropped in 1988, it goes right there');
    expect(COPY.handover.length + COPY.next.length + COPY.skipHost.length).toBeGreaterThan(0);
    expect(COPY.win.includes('W')).toBe(true);
    expect(COPY.winShared.includes('tied')).toBe(true);
    expect(COPY.lose.includes('L')).toBe(true);
  });
});

describe('card labels', () => {
  it('yearLabel falls back to ???? for missing years', () => {
    expect(yearLabel(song('a'))).toBe('1999');
    expect(yearLabel(null)).toBe('????');
    expect(yearLabel({ ...song('a'), year: '' })).toBe('????');
  });
});
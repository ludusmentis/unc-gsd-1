/**
 * Drag & drop math and interaction primitives (pure + pointer helpers).
 *
 * T04 contract: long-press-to-lift, oversized drop zones (>= 48px),
 * highlighted targets, immediate commit, no confirm/undo (D004).
 * All geometry is pure so tests/line.test.ts can cover it without a DOM.
 */
import type { ActionEnvelope, TrackSummary } from '@/server/events';
import type { LineEntry as ServerLineEntry } from '@/server/events';
export type { TrackSummary };

/** Minimum touch target for drop zones (iOS/Android accessibility floor). */
export const MIN_TARGET_PX = 48;
/** Long-press delay before a drag lifts (ms). */
export const LONG_PRESS_MS = 350;
/** Must match the server cap in src/server/ws.ts. */
export const MAX_LINE_SLOTS = 64;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function clampSlot(i: number, count: number): number {
  if (!Number.isInteger(i) || i < 0) return 0;
  if (i > count) return count;
  return i;
}

/** Server-side mirror of the client cap check. */
export function isValidSlotIndex(v: unknown): boolean {
  return (
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_LINE_SLOTS
  );
}

/**
 * Insertion index for a pointer x against ascending slot centers:
 * the first slot whose center is right of the pointer.
 */
export function insertionIndex(x: number, centers: number[]): number {
  for (let i = 0; i < centers.length; i++) {
    if (x < centers[i]) return i;
  }
  return centers.length;
}

/**
 * Which drop zone contains the point, else the nearest zone by center
 * distance (so a near-miss still lands on a >=48px target).
 */
export function slotFromPoint(x: number, y: number, rects: Rect[]): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    if (dx === 0 && dy === 0) return i;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Line model: the personal line is seeded with the anchor song at slot 0;
// placements insert at slotIndex (0 = directly after the anchor).
// ---------------------------------------------------------------------------

export type LineEntry =
  | { kind: 'anchor'; track: TrackSummary }
  | { kind: 'placed'; track: TrackSummary | null; trackId: string; slotIndex: number };

/**
 * Build the ordered display line: anchor seed first, then placements in
 * slot order. Placements beyond MAX_LINE_SLOTS are dropped.
 */
export function buildSlots(
  anchor: TrackSummary | null,
  placements: { trackId: string; slotIndex: number; track?: TrackSummary | null }[],
): LineEntry[] {
  const slots: LineEntry[] = [];
  if (anchor) slots.push({ kind: 'anchor', track: anchor });
  const sorted = [...placements]
    .filter((p) => isValidSlotIndex(p.slotIndex))
    .sort((a, b) => a.slotIndex - b.slotIndex);
  for (const p of sorted) {
    slots.push({ kind: 'placed', track: p.track ?? null, trackId: p.trackId, slotIndex: p.slotIndex });
  }
  return slots;
}

/**
 * Server-authoritative line entries (T04) -> display slots. Entry 0 is
 * the anchor seed; entries keep their server summaries so years render.
 */
export function entriesToSlots(entries: readonly ServerLineEntry[]): LineEntry[] {
  if (entries.length === 0) return [];
  const placements = entries.slice(1).map((e, i) => ({
    trackId: e.trackId,
    slotIndex: i + 1,
    track: e.summary,
  }));
  return buildSlots(entries[0].summary, placements);
}

/** Stable key for React lists and drop-zone ids. */
export function slotKey(entry: LineEntry, i: number): string {
  return entry.kind === 'anchor' ? 'anchor' : `slot-${entry.slotIndex}-${entry.trackId}-${i}`;
}

/** Authoritative commit envelope — immediate, no confirm/undo (D004). */
export function placeSongEnvelope(token: string, trackId: string, slotIndex: number): ActionEnvelope {
  return { token, action: { type: 'place_song', trackId, slotIndex } };
}

/** Year label shown on song cards. */
export function yearLabel(track: TrackSummary | null | undefined): string {
  if (!track?.year) return '????';
  return track.year;
}
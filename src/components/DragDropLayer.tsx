'use client';

import { useEffect, useState } from 'react';
import type { TrackSummary } from '@/server/events';
import { MIN_TARGET_PX, slotFromPoint, yearLabel, type Rect } from '@/lib/dnd';

/**
 * Drag layer: while a dealt song is lifted, tracks the pointer, highlights
 * the drop zone under it (>= 48px targets), and commits immediately on
 * release — no confirm/undo (D004). Works for touch and mouse via pointer
 * events. Reads drop-zone geometry from [data-drop-slot] elements.
 */
export interface DragDropLayerProps {
  lifted: TrackSummary | null;
  /** Pointer position (for the floating ghost); null when not dragging. */
  onPointer?: (x: number, y: number) => void;
  /** Commit at the given drop-zone index — fires exactly once per drag. */
  onCommit: (dropZoneIndex: number) => void;
  onActiveSlotChange?: (slot: number) => void;
}

export default function DragDropLayer({ lifted, onPointer, onCommit, onActiveSlotChange }: DragDropLayerProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragging = lifted !== null;

  useEffect(() => {
    if (!dragging) {
      setPos(null);
      return;
    }
    const zones = (): { rects: Rect[]; els: Element[] } => {
      const els = Array.from(document.querySelectorAll('[data-drop-slot]'));
      const rects = els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      return { rects, els };
    };

    const move = (e: PointerEvent) => {
      setPos({ x: e.clientX, y: e.clientY });
      onPointer?.(e.clientX, e.clientY);
      const { rects } = zones();
      onActiveSlotChange?.(slotFromPoint(e.clientX, e.clientY, rects));
    };
    const up = (e: PointerEvent) => {
      const { rects } = zones();
      const idx = slotFromPoint(e.clientX, e.clientY, rects);
      onCommit(idx >= 0 ? idx : -1);
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  if (!dragging || !pos) return null;

  return (
    <div
      aria-label="drag ghost"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        transform: 'translate(-50%, -50%) rotate(-2deg)',
        padding: '14px 18px',
        borderRadius: 16,
        background: '#1c212c',
        border: '2px solid #1db954',
        color: '#f2f4f8',
        pointerEvents: 'none',
        zIndex: 1000,
        boxShadow: '0 12px 32px #0009',
        maxWidth: 280,
      }}
    >
      <strong style={{ fontSize: 16, display: 'block' }}>{lifted.name}</strong>
      <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
        {lifted.artists.join(', ')} — {yearLabel(lifted)}
      </div>
    </div>
  );
}

/** Drop zones must always be at least this tall — exported for page-level asserts. */
export { MIN_TARGET_PX as DROP_ZONE_MIN };
'use client';

import type { TrackSummary } from '@/server/events';
import { MIN_TARGET_PX, slotKey, yearLabel, type LineEntry } from '@/lib/dnd';

/**
 * Personal line component (T04, server-authoritative): rendered from the
 * state_sync snapshot — entry 0 is the anchor seed, the rest are placed
 * tracks with their server summaries so years render. Drop zones are
 * oversized (>= 48px tall), highlight while a drag is active, and the
 * forfeit reveal (highlightSlots) marks the correct spot(s).
 */
export interface SongLineProps {
  /** Ordered display slots (from entriesToSlots over the server snapshot). */
  entries: LineEntry[];
  /** True while a dealt song is lifted; drop zones render highlighted. */
  dragging: boolean;
  /** Index of the drop zone currently under the pointer (-1 = none). */
  activeSlot: number;
  /** Forfeit reveal: slot indices to highlight as the correct spot(s). */
  highlightSlots?: number[];
  onDropAt?: (slotIndex: number) => void;
}

function cardStyle(kind: LineEntry['kind'], revealed: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '12px 14px',
    borderRadius: 14,
    background: kind === 'anchor' ? '#1db95422' : '#1c212c',
    border:
      kind === 'anchor' ? '2px solid #1db954'
      : revealed ? '2px solid #ffb454'
      : '2px solid #2a2f3a',
    minHeight: MIN_TARGET_PX,
    boxSizing: 'border-box',
  };
  return base;
}

export default function SongLine({ entries, dragging, activeSlot, highlightSlots = [], onDropAt }: SongLineProps) {
  const revealed = new Set(highlightSlots);
  return (
    <section aria-label="your line">
      <h2 style={{ fontSize: 16, margin: '0 0 8px', opacity: 0.7 }}>
        your line <span style={{ opacity: 0.6 }}>(anchor seed first)</span>
      </h2>
      <ol style={listStyle}>
        {entries.map((entry, i) => (
          <li key={slotKey(entry, i)} style={itemStyle}>
            <div
              role="button"
              aria-label={`drop zone ${i}${revealed.has(i) ? ' (correct spot)' : ''}`}
              data-drop-slot={i}
              data-correct-spot={revealed.has(i) ? '1' : undefined}
              style={{
                ...zoneStyle,
                outline: dragging ? `2px dashed ${activeSlot === i ? '#1db954' : '#3a4152'}` : '2px dashed transparent',
                background:
                  dragging && activeSlot === i ? '#1db95426'
                  : revealed.has(i) ? '#ffb45433'
                  : 'transparent',
                borderColor: revealed.has(i) ? '#ffb454' : undefined,
              }}
              onPointerUp={dragging ? () => onDropAt?.(i) : undefined}
            >
              drop here
            </div>
            <div style={cardStyle(entry.kind, revealed.has(i))}>
              {entry.kind === 'anchor' ? (
                <>
                  <strong style={nameStyle}>⚓ {entry.track.name}</strong>
                  <div style={metaStyle}>
                    {entry.track.artists.join(', ')} — {yearLabel(entry.track)}
                  </div>
                </>
              ) : entry.track ? (
                <>
                  <strong style={nameStyle}>{entry.track.name}</strong>
                  <div style={metaStyle}>
                    {entry.track.artists.join(', ')} — {yearLabel(entry.track)}
                  </div>
                </>
              ) : (
                <>
                  <strong style={nameStyle}>a song</strong>
                  <div style={metaStyle}>waiting for details…</div>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const itemStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };

const zoneStyle: React.CSSProperties = {
  minHeight: MIN_TARGET_PX,
  borderRadius: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  color: '#6b7385',
  border: '2px dashed transparent',
  touchAction: 'none',
  userSelect: 'none',
};

const nameStyle: React.CSSProperties = { fontSize: 16, display: 'block' };
const metaStyle: React.CSSProperties = { fontSize: 13, opacity: 0.65, marginTop: 2 };
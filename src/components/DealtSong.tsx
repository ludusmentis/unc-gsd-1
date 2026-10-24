'use client';

import { useEffect, useRef, useState } from 'react';
import type { TrackSummary } from '@/server/events';
import { LONG_PRESS_MS, yearLabel } from '@/lib/dnd';

/**
 * Dealt song card. Long-press (touch or held mouse button) lifts the song
 * for dragging — no tap-to-confirm, no undo (D004). The lift fires once
 * per press; releasing or scrolling cancels the timer.
 */
export interface DealtSongProps {
  track: TrackSummary | null;
  /** True while this song is currently lifted by the drag layer. */
  lifted: boolean;
  onLift?: (track: TrackSummary) => void;
  disabled?: boolean;
}

export default function DealtSong({ track, lifted, onLift, disabled }: DealtSongProps) {
  const [pressing, setPressing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!track) {
    return (
      <div style={{ ...card, opacity: 0.5, border: '2px dashed #2a2f3a', background: 'transparent' }}>
        waiting for the next song…
      </div>
    );
  }

  const start = () => {
    if (disabled || lifted) return;
    setPressing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setPressing(false);
      if (trackRef.current) onLift?.(trackRef.current);
    }, LONG_PRESS_MS);
  };
  const cancel = () => {
    setPressing(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  return (
    <div
      role="button"
      aria-label={`dealt song ${track.name}`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      style={{
        ...card,
        transform: lifted ? 'scale(1.04)' : pressing ? 'scale(0.98)' : 'none',
        boxShadow: lifted ? '0 12px 32px #0009' : 'none',
        border: lifted ? '2px solid #1db954' : '2px solid #2a2f3a',
        touchAction: 'none',
        userSelect: 'none',
        transition: 'transform 120ms ease, box-shadow 120ms ease',
      }}
    >
      <strong style={nameStyle}>{track.name}</strong>
      <div style={metaStyle}>
        {track.artists.join(', ')} — {yearLabel(track)}
      </div>
      <div style={{ ...metaStyle, marginTop: 6, opacity: 0.45 }}>
        {lifted ? 'drop it in your line' : 'hold to lift'}
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  padding: 18,
  borderRadius: 16,
  background: '#1c212c',
  border: '2px solid #2a2f3a',
  color: '#f2f4f8',
  cursor: 'grab',
};

const nameStyle: React.CSSProperties = { fontSize: 22, display: 'block' };
const metaStyle: React.CSSProperties = { fontSize: 14, opacity: 0.65, marginTop: 4 };
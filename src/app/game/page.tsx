'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { connectGameSocket, sendAction } from '@/lib/socket';
import type { ServerEvent, TrackSummary } from '@/server/events';
import { placeSongEnvelope } from '@/lib/dnd';
import DealtSong from '@/components/DealtSong';
import SongLine from '@/components/SongLine';
import DragDropLayer from '@/components/DragDropLayer';

/**
 * Game screen (T04): dealt song card + drag & drop into the anchor-seeded
 * personal line. Placement is sent to the server (which validates the acting
 * session per R020) and broadcast to all clients; commit is immediate, no
 * confirm/undo (D004). Portrait mobile-first; pointer events cover mouse.
 */
interface Placement {
  trackId: string;
  slotIndex: number;
  track: TrackSummary | null;
  mine: boolean;
}

export default function GamePage() {
  const socketRef = useRef<ReturnType<typeof connectGameSocket> | null>(null);
  const [token, setToken] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [anchor, setAnchor] = useState<TrackSummary | null>(null);
  const [dealt, setDealt] = useState<TrackSummary | null>(null);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [lifted, setLifted] = useState<TrackSummary | null>(null);
  const [activeSlot, setActiveSlot] = useState(-1);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = sessionStorage.getItem('token') ?? '';
    const code = sessionStorage.getItem('code') ?? '';
    setToken(t);
    setRoomCode(code);
    try {
      const a = sessionStorage.getItem('anchor');
      if (a) setAnchor(JSON.parse(a) as TrackSummary);
    } catch { /* corrupt seed ignored — line still works without anchor */ }

    const socket = connectGameSocket();
    socketRef.current = socket;
    socket.on('event', (e: ServerEvent) => {
      if (e.type === 'song_dealt') {
        setDealt(e.track);
        if (e.yourAnchor) {
          setAnchor(e.yourAnchor);
          sessionStorage.setItem('anchor', JSON.stringify(e.yourAnchor));
        }
      } else if (e.type === 'song_placed') {
        // Echo of our own commit (already applied locally) or another
        // player's placement elsewhere in the room.
        setPlacements((prev) => {
          if (prev.some((p) => p.trackId === e.trackId)) return prev;
          const known = e.trackId === dealtRef.current?.id ? dealtRef.current : null;
          return [...prev, { trackId: e.trackId, slotIndex: e.slotIndex, track: known, mine: e.trackId === dealtRef.current?.id && liftedRef.current === null }];
        });
        if (e.trackId === dealtRef.current?.id) setDealt(null);
      } else if (e.type === 'rejected') {
        setErr(`${e.error} — ${e.recovery ?? ''}`);
      }
    });
    return () => { socket.disconnect(); };
  }, []);

  // Refs mirroring state so the socket handler sees fresh values without
  // re-binding listeners.
  const dealtRef = useRef<TrackSummary | null>(null);
  dealtRef.current = dealt;
  const liftedRef = useRef<TrackSummary | null>(null);
  liftedRef.current = lifted;

  const commit = (track: TrackSummary, dropZoneIndex: number) => {
    setLifted(null);
    setActiveSlot(-1);
    if (dropZoneIndex < 0) return; // released outside the line — cancel, no undo state
    const slotIndex = dropZoneIndex; // zone i == slot i (anchor occupies display position 0)
    if (!token || !socketRef.current) {
      setErr('session lost — rejoin the room with the code');
      return;
    }
    // Immediate commit (D004): apply locally, then send; the server broadcast
    // is deduped by trackId above.
    setPlacements((prev) =>
      prev.some((p) => p.trackId === track.id)
        ? prev
        : [...prev, { trackId: track.id, slotIndex, track, mine: true }],
    );
    sendAction(socketRef.current, placeSongEnvelope(token, track.id, slotIndex));
    setDealt(null);
  };

  const missing = !token || !roomCode;

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <span style={styles.code}>room {roomCode || '—'}</span>
        {missing && <Link href="/join" style={styles.joinLink}>join first →</Link>}
      </header>

      <section aria-label="dealt song">
        <h2 style={{ fontSize: 16, margin: '0 0 8px', opacity: 0.7 }}>now place this one</h2>
        <DealtSong track={dealt} lifted={lifted !== null} onLift={(t) => setLifted(t)} disabled={missing} />
      </section>

      <SongLine
        anchor={anchor}
        placements={placements}
        dragging={lifted !== null}
        activeSlot={activeSlot}
        onDropAt={(i) => lifted && commit(lifted, i)}
      />

      <DragDropLayer
        lifted={lifted}
        onCommit={(idx) => lifted && commit(lifted, idx)}
        onActiveSlotChange={setActiveSlot}
      />

      {err && <p style={styles.err}>{err}</p>}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    padding: 20,
    background: '#0b0d12',
    color: '#f2f4f8',
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 480,
    margin: '0 auto',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  code: { fontSize: 18, fontWeight: 700, letterSpacing: 2 },
  joinLink: { color: '#1db954', fontSize: 14, textDecoration: 'none' },
  err: { color: '#ff7a90', fontSize: 14 },
};
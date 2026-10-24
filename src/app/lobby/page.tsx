'use client';

import { useEffect, useState } from 'react';
import { connectGameSocket, sendAction } from '@/lib/socket';
import type { RoomState, ServerEvent } from '@/server/events';

export default function LobbyPage() {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const socket = connectGameSocket();
    (window as any).__gameSocket = socket;
    const token = sessionStorage.getItem('token') ?? '';
    const code = sessionStorage.getItem('code') ?? '';

    socket.on('event', (e: ServerEvent) => {
      if (e.type === 'lobby') {
        setRoom(e.room);
      } else if (e.type === 'roster_locked') {
        setRoom(e.room);
        setLocked(true);
      } else if (e.type === 'rejected') {
        setErr(`${e.error} — ${e.recovery ?? ''}`);
      }
    });

    // re-request lobby state (mocked flow: no stored player identity yet)
    if (code) {
      sendAction(socket, { token, action: { type: 'ping_state' } });
    }
    return () => { socket.disconnect(); };
  }, []);

  const lockRoster = () => {
    const socket = (window as any).__gameSocket;
    const token = sessionStorage.getItem('token') ?? '';
    if (socket) sendAction(socket, { token, action: { type: 'lock_roster' } });
  };

  return (
    <main style={styles.main}>
      {room && (
        <>
          <p style={styles.codeLabel}>room code</p>
          <h1 style={styles.code}>{room.code}</h1>
          <p style={styles.meta}>
            {room.players.length}/{room.maxPlayers} in · need {room.minPlayers}+ to start ·
            playlist: {room.playlistName ?? 'mocked (T02)'}
          </p>
          <ul style={styles.list}>
            {room.players.map((p) => (
              <li key={p.id} style={styles.player}>
                {p.name}{p.isHost ? ' 👑' : ''}
              </li>
            ))}
          </ul>
          <button
            style={styles.btn}
            onClick={lockRoster}
            disabled={locked || room.players.length < room.minPlayers}
          >
            {locked ? 'locked in ✓' : 'start the game'}
          </button>
        </>
      )}
      {err && <p style={styles.err}>{err}</p>}
      <p style={styles.sub}>game screen ships in T04 — this lobby proves the sync loop.</p>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', gap: 12, padding: 24, background: '#0b0d12', color: '#f2f4f8', fontFamily: 'system-ui, sans-serif', maxWidth: 420, margin: '0 auto' },
  codeLabel: { margin: 0, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 2, fontSize: 12 },
  code: { fontSize: 56, margin: 0, letterSpacing: 6 },
  meta: { opacity: 0.7, margin: 0 },
  list: { listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  player: { padding: 14, borderRadius: 12, background: '#141821', fontSize: 17 },
  btn: { padding: 18, fontSize: 18, fontWeight: 700, borderRadius: 16, border: 'none', background: '#1db954', color: '#04120a', minHeight: 48, cursor: 'pointer' },
  err: { color: '#ff7a90' },
  sub: { opacity: 0.55, fontSize: 14 },
};

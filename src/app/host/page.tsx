'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectGameSocket, sendAction } from '@/lib/socket';
import type { ServerEvent } from '@/server/events';

export default function HostPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const socket = connectGameSocket();
    (window as any).__gameSocket = socket;
    socket.on('event', (e: ServerEvent) => {
      if (e.type === 'room_created') {
        sessionStorage.setItem('token', e.token);
        sessionStorage.setItem('code', e.room.code);
        router.push('/lobby');
      } else if (e.type === 'rejected') {
        setErr(`${e.error} — ${e.recovery ?? ''}`);
      }
    });
    return () => { socket.disconnect(); };
  }, [router]);

  const createRoom = () => {
    const socket = (window as any).__gameSocket;
    if (socket) sendAction(socket, { token: '', action: { type: 'create_room', name } });
  };

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>host a room</h1>
      <input
        style={styles.input}
        placeholder="your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={24}
      />
      <button style={styles.btn} onClick={createRoom} disabled={name.trim().length === 0}>
        create room
      </button>
      {err && <p style={styles.err}>{err}</p>}
      <p style={styles.sub}>mocked playlist for now — Spotify wiring lands in T02.</p>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', gap: 16, padding: 24, background: '#0b0d12', color: '#f2f4f8', fontFamily: 'system-ui, sans-serif', justifyContent: 'center', maxWidth: 420, margin: '0 auto' },
  title: { fontSize: 32, marginTop: 0 },
  input: { padding: 18, fontSize: 18, borderRadius: 12, border: '2px solid #2a2f3a', background: '#141821', color: '#f2f4f8', minHeight: 48 },
  btn: { padding: 18, fontSize: 18, fontWeight: 700, borderRadius: 16, border: 'none', background: '#1db954', color: '#04120a', minHeight: 48, cursor: 'pointer' },
  err: { color: '#ff7a90' },
  sub: { opacity: 0.55, fontSize: 14 },
};

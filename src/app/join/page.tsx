'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectGameSocket, sendAction } from '@/lib/socket';
import { saveIdentity } from '@/lib/session-store';
import type { ServerEvent } from '@/server/events';

export default function JoinPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const socket = connectGameSocket();
    (window as any).__gameSocket = socket;
    socket.on('event', (e: ServerEvent) => {
      if (e.type === 'joined') {
        saveIdentity({ token: e.token, code: e.room.code, playerId: e.you.id, isHost: false });
        router.push('/lobby');
      } else if (e.type === 'rejected') {
        setErr(`${e.error} — ${e.recovery ?? ''}`);
      }
    });
    return () => { socket.disconnect(); };
  }, [router]);

  const join = () => {
    const socket = (window as any).__gameSocket;
    if (socket) sendAction(socket, { token: '', action: { type: 'join_room', code: code.trim().toUpperCase(), name } });
  };

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>join a room</h1>
      <input
        style={{ ...styles.input, letterSpacing: 4, textAlign: 'center', textTransform: 'uppercase' }}
        placeholder="ROOM CODE"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        maxLength={5}
        inputMode="text"
        autoCapitalize="characters"
      />
      <input
        style={styles.input}
        placeholder="your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={24}
      />
      <button style={styles.btn} onClick={join} disabled={code.trim().length === 0 || name.trim().length === 0}>
        let me in
      </button>
      {err && <p style={styles.err}>{err}</p>}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', gap: 16, padding: 24, background: '#0b0d12', color: '#f2f4f8', fontFamily: 'system-ui, sans-serif', justifyContent: 'center', maxWidth: 420, margin: '0 auto' },
  title: { fontSize: 32, marginTop: 0 },
  input: { padding: 18, fontSize: 18, borderRadius: 12, border: '2px solid #2a2f3a', background: '#141821', color: '#f2f4f8', minHeight: 48 },
  btn: { padding: 18, fontSize: 18, fontWeight: 700, borderRadius: 16, border: 'none', background: '#1db954', color: '#04120a', minHeight: 48, cursor: 'pointer' },
  err: { color: '#ff7a90' },
};

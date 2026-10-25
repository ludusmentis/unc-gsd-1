'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { connectGameSocket, sendAction } from '@/lib/socket';
import { saveIdentity } from '@/lib/session-store';
import { COPY } from '@/lib/copy';
import type { ServerEvent } from '@/server/events';

function HostPageInner() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // S03-T04 (R021): a 403 allowlist rejection redirects back here with
  // ?auth=not_allowlisted&name=<friend> — both-sided Gen Z copy, one plain
  // action per side, never a raw auth error.
  const sp = useSearchParams();
  const authParam = sp?.get('auth');
  const friendName = sp?.get('name');
  const blocked = authParam === 'not_allowlisted';

  useEffect(() => {
    const socket = connectGameSocket();
    (window as any).__gameSocket = socket;
    socket.on('event', (e: ServerEvent) => {
      if (e.type === 'room_created') {
        saveIdentity({ token: e.token, code: e.room.code, playerId: e.you.id, isHost: true });
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

      {/* R021: allowlist rejection — both sides get one plain action. The
          login attempter retries; the host gets the friend's name + the
          Spotify user-management link. */}
      {blocked && (
        <section aria-label="spotify blocked" style={styles.blocked}>
          <p style={styles.sub}>
            {COPY.notAllowlisted.error} — {COPY.notAllowlisted.recovery}
          </p>
          <a
            style={styles.btn}
            href={`/api/auth/start${friendName ? `?name=${encodeURIComponent(friendName)}` : ''}`}
          >
            {COPY.notAllowlisted.retry}
          </a>
          {friendName && (
            <p style={styles.sub}>
              {COPY.hostAddFriend.replace('{name}', friendName)} —{' '}
              <a style={styles.link} href={COPY.spotifyUserManagement} target="_blank" rel="noreferrer">
                {COPY.userManagementLink}
              </a>
            </p>
          )}
        </section>
      )}

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
  blocked: {
    background: '#231325', border: '1px solid #b0455f', borderRadius: 14,
    padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
  },
  link: { color: '#1db954', textDecoration: 'none' },
};

/** useSearchParams needs a Suspense boundary for static prerender (Next 14). */
export default function HostPage() {
  return (
    <Suspense fallback={null}>
      <HostPageInner />
    </Suspense>
  );
}

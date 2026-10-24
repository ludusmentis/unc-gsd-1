'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectGameSocket, sendAction } from '@/lib/socket';
import { COPY } from '@/lib/copy';
import type { RoomState, ServerEvent } from '@/server/events';
import LobbyPanel from '@/components/LobbyPanel';

/**
 * Lobby (T05): shows joined players, chosen playlist + eligible-track count
 * (R019), and the host's start button that locks the roster. Host picks the
 * playlist + speaker first (POST /api/spotify/select with the host cookie);
 * on roster lock the server deals the first song and this page routes the
 * room to /game.
 */

interface PlaylistOption { id: string; name: string; total: number }

export default function LobbyPage() {
  const router = useRouter();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [eligible, setEligible] = useState<number | null>(null);
  const [required, setRequired] = useState<number | null>(null);
  const [playlistLockedIn, setPlaylistLockedIn] = useState(false);
  const [starting, setStarting] = useState(false);

  // host-only playlist picker state
  const [playlists, setPlaylists] = useState<PlaylistOption[]>([]);
  const [picked, setPicked] = useState<string>('');
  const [speaker, setSpeaker] = useState('');

  useEffect(() => {
    const token = sessionStorage.getItem('token') ?? '';
    setIsHost(sessionStorage.getItem('isHost') === '1');

    const socket = connectGameSocket();
    (window as any).__gameSocket = socket;
    socket.on('event', (e: ServerEvent) => {
      if (e.type === 'lobby') {
        setRoom(e.room);
        setRequired(playersNeeded(e.room));
      } else if (e.type === 'roster_locked' || e.type === 'game_started') {
        if (e.type === 'game_started') setRoom(e.room);
      } else if (e.type === 'song_dealt') {
        router.push('/game');
      } else if (e.type === 'game_error') {
        setErr(e.recovery ? `${e.error} — ${e.recovery}` : e.error);
        setStarting(false);
      } else if (e.type === 'playback_state' && e.state === 'wake_speaker') {
        setErr(e.copy ?? COPY.wakeSpeaker.recovery);
      } else if (e.type === 'rejected') {
        setErr(`${e.error} — ${e.recovery ?? ''}`);
      }
    });

    // re-request authoritative lobby state for this session
    if (token) sendAction(socket, { token, action: { type: 'ping_state' } });

    // host: offer the playlist picker (requires the OAuth cookie)
    if (sessionStorage.getItem('isHost') === '1') {
      fetch('/api/spotify/playlists')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.playlists && setPlaylists(d.playlists))
        .catch(() => undefined);
    }
    return () => { socket.disconnect(); };
  }, [router]);

  const lockPlaylist = async () => {
    setErr(null);
    const code = sessionStorage.getItem('code') ?? '';
    try {
      const res = await fetch('/api/spotify/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          playlistId: picked,
          playlistName: playlists.find((p) => p.id === picked)?.name ?? 'playlist',
          speakerName: speaker,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.recovery ? `${d.error} — ${d.recovery}` : d.error);
        return;
      }
      setEligible(d.eligibleCount);
      setPlaylistLockedIn(true);
      setRoom((r) => (r ? { ...r, playlistName: d.playlistName } : r));
    } catch {
      setErr(`${COPY.playbackFail.error} — ${COPY.playbackFail.recovery}`);
    }
  };

  const startGame = () => {
    const socket = (window as any).__gameSocket;
    const token = sessionStorage.getItem('token') ?? '';
    setStarting(true);
    if (socket) sendAction(socket, { token, action: { type: 'lock_roster' } });
  };

  const playersNeeded = (r: RoomState) => r.players.length; // required = 12 * roster, shown via eligible gap

  return (
    <main style={s.main}>
      {room ? (
        <LobbyPanel
          room={room}
          isHost={isHost}
          eligibleCount={eligible}
          requiredCount={required === null ? null : required * 12}
          playlistLockedIn={playlistLockedIn}
          starting={starting}
          onStart={startGame}
        />
      ) : (
        <p style={s.sub}>finding your room…</p>
      )}

      {isHost && room?.status === 'lobby' && (
        <section style={s.pickBox} aria-label="pick playlist and speaker">
          <h2 style={s.pickTitle}>host setup</h2>
          <select style={s.input} value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">pick a playlist…</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.total})</option>
            ))}
          </select>
          <input
            style={s.input}
            placeholder="speaker name (as in spotify connect)"
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
          />
          <button style={s.btn2} onClick={lockPlaylist} disabled={!picked || !speaker.trim()}>
            {playlistLockedIn ? 'playlist locked ✓' : 'lock in playlist'}
          </button>
        </section>
      )}

      {err && <p style={s.err}>{err}</p>}
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh', display: 'flex', flexDirection: 'column', gap: 12, padding: 24,
    background: '#0b0d12', color: '#f2f4f8', fontFamily: 'system-ui, sans-serif', maxWidth: 420, margin: '0 auto',
  },
  pickBox: { padding: 16, borderRadius: 12, background: '#141821', display: 'flex', flexDirection: 'column', gap: 10 },
  pickTitle: { margin: 0, fontSize: 18 },
  input: {
    padding: 16, fontSize: 16, borderRadius: 12, border: '2px solid #2a2f3a',
    background: '#0b0d12', color: '#f2f4f8', minHeight: 48,
  },
  btn: {
    padding: 16, fontSize: 16, fontWeight: 700, borderRadius: 12, border: 'none',
    background: '#2a6cff', color: '#fff', minHeight: 48, cursor: 'pointer',
  },
  btn2: {
    padding: 16, fontSize: 16, fontWeight: 700, borderRadius: 12, border: 'none',
    background: '#1db954', color: '#04120a', minHeight: 48, cursor: 'pointer',
  },
  err: { color: '#ff7a90' },
  sub: { opacity: 0.55, fontSize: 14 },
};
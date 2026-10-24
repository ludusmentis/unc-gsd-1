'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { connectGameSocket, sendAction } from '@/lib/socket';
import type { ServerEvent, GameStateSync, TrackSummary, LineEntry as ServerLineEntry } from '@/server/events';
import { placeSongEnvelope, entriesToSlots, yearLabel, type LineEntry as DisplaySlot } from '@/lib/dnd';
import { COPY } from '@/lib/copy';
import { randomQuip } from '@/lib/commentary';
import DealtSong from '@/components/DealtSong';
import SongLine from '@/components/SongLine';
import DragDropLayer from '@/components/DragDropLayer';

/**
 * Game screen (T04, server-authoritative): renders entirely from the
 * state_sync snapshot — whose turn, all players' lines/years, scores,
 * awaiting-next phase, turn results (correct bump / forfeit reveal),
 * host skip, nudges (toasts), watcher commentary, and the winner screen.
 * Local placements[] are gone: the server is the only source of truth.
 */

type Toast = { id: number; text: string };

type TurnOutcome =
  | { kind: 'correct'; playerId: string; track: TrackSummary; slotIndex: number }
  | { kind: 'forfeit'; playerId: string; track: TrackSummary; year: string; correctSlots: number[] }
  | null;

type GameOver = { winnerIds: string[]; reason: 'first_to_10' | 'deck_empty'; copy: string } | null;

export default function GamePage() {
  const socketRef = useRef<ReturnType<typeof connectGameSocket> | null>(null);

  const [token, setToken] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [myId, setMyId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [snap, setSnap] = useState<GameStateSync | null>(null);
  const [anchor, setAnchor] = useState<TrackSummary | null>(null);
  const [dealt, setDealt] = useState<TrackSummary | null>(null);
  const [lifted, setLifted] = useState<TrackSummary | null>(null);
  const [activeSlot, setActiveSlot] = useState(-1);
  const [outcome, setOutcome] = useState<TurnOutcome>(null);
  const [revealSlots, setRevealSlots] = useState<number[]>([]);
  const [over, setOver] = useState<GameOver>(null);
  const [quip, setQuip] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const toastId = useRef(0);

  const toast = (text: string) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  };

  const myRef = useRef({ myId: '', isHost: false });
  myRef.current = { myId, isHost };

  useEffect(() => {
    const t = sessionStorage.getItem('token') ?? '';
    const code = sessionStorage.getItem('code') ?? '';
    const id = sessionStorage.getItem('playerId') ?? '';
    setToken(t);
    setRoomCode(code);
    setMyId(id);
    setIsHost(sessionStorage.getItem('isHost') === '1');
    try {
      const a = sessionStorage.getItem('anchor');
      if (a) setAnchor(JSON.parse(a) as TrackSummary);
    } catch { /* corrupt seed ignored — snapshot carries the truth anyway */ }

    const socket = connectGameSocket();
    socketRef.current = socket;

    socket.on('event', (e: ServerEvent) => {
      switch (e.type) {
        case 'state_sync':
          setSnap(e.state);
          // Snapshot wins over any stale anchor seed / dealt card echo.
          if (e.state.status !== 'in_progress') setDealt(null);
          break;
        case 'song_dealt': {
          setDealt(e.track);
          setOutcome(null);
          setRevealSlots([]);
          const mine = (id && e.anchors[id]) || null;
          if (mine) {
            setAnchor(mine);
            sessionStorage.setItem('anchor', JSON.stringify(mine));
          }
          setQuip(randomQuip());
          break;
        }
        case 'turn_result':
          setOutcome({ kind: 'correct', playerId: e.playerId, track: e.track, slotIndex: e.slotIndex });
          setQuip(randomQuip());
          break;
        case 'turn_forfeit':
          setOutcome({ kind: 'forfeit', playerId: e.playerId, track: e.track, year: e.year, correctSlots: e.correctSlots });
          setRevealSlots(e.correctSlots);
          setQuip(randomQuip());
          break;
        case 'awaiting_next':
          if (e.playerId !== id) setDealt(null);
          break;
        case 'game_over':
          setOver({ winnerIds: e.winnerIds, reason: e.reason, copy: e.copy });
          setDealt(null);
          break;
        case 'nudge':
          toast(e.copy);
          break;
        case 'game_error':
          toast(`${e.error} — ${e.recovery ?? ''}`);
          break;
        case 'rejected':
          setErr(`${e.error} — ${e.recovery ?? ''}`);
          break;
      }
    });

    // (Re)connect sync: ask for the authoritative snapshot immediately.
    socket.on('connect', () => {
      if (t) sendAction(socket, { token: t, action: { type: 'ping_state' } });
    });
    if (socket.connected && t) sendAction(socket, { token: t, action: { type: 'ping_state' } });

    return () => { socket.disconnect(); };
  }, []);

  // Derived from the snapshot (data-driven rendering, R006).
  const players = snap?.players ?? [];
  const turnPlayerId = snap?.turn?.playerId ?? null;
  const myTurn = turnPlayerId !== null && turnPlayerId === myId;
  const awaitingNext = snap?.awaitingNext ?? null;
  const scores = snap?.scores ?? {};

  const myEntries: ServerLineEntry[] = snap?.lines?.[myId] ?? (anchor ? [{ trackId: anchor.id, summary: anchor }] : []);
  const mySlots: DisplaySlot[] = useMemo(() => entriesToSlots(myEntries), [JSON.stringify(myEntries)]);

  const outcomeCopy = (() => {
    if (!outcome) return null;
    if (outcome.kind === 'forfeit') {
      return COPY.forfeitReveal.replace('{year}', outcome.year);
    }
    return COPY.handover;
  })();

  const commit = (track: TrackSummary, dropZoneIndex: number) => {
    setLifted(null);
    setActiveSlot(-1);
    if (dropZoneIndex < 0) return; // released outside the line — cancel, no undo state
    if (!token || !socketRef.current) {
      setErr('session lost — rejoin the room with the code');
      return;
    }
    // Immediate send (D004): the server evaluates and the snapshot + result
    // events render the authoritative outcome.
    sendAction(socketRef.current, placeSongEnvelope(token, track.id, dropZoneIndex));
  };

  const send = (action: { type: 'next_turn' } | { type: 'skip_turn' } | { type: 'ping_state' }) => {
    if (!token || !socketRef.current) {
      setErr('session lost — rejoin the room with the code');
      return;
    }
    sendAction(socketRef.current, { token, action });
  };

  const missing = !token || !roomCode;

  // ---- winner screen (R007) ----
  if (over) {
    const iWon = over.winnerIds.includes(myId);
    const shared = over.winnerIds.length > 1;
    const winners = players.filter((p) => over.winnerIds.includes(p.id));
    const headline = shared ? COPY.winShared : iWon ? COPY.win : COPY.lose;
    return (
      <main style={styles.main}>
        <h1 style={styles.h1}>{headline}</h1>
        <p style={styles.p}>
          🏆 {winners.map((w) => w.name).join(' & ')} — {over.reason === 'first_to_10' ? 'first to 10' : 'longest timeline'}
        </p>
        <p style={styles.small}>{over.copy}</p>
        <section aria-label="final scores">
          <ol style={styles.list}>
            {players.map((p) => (
              <li key={p.id} style={styles.li}>
                <span>{over.winnerIds.includes(p.id) ? '👑 ' : ''}{p.name}</span>
                <span style={styles.score}>{scores[p.id] ?? 0} pts · {(snap?.lines?.[p.id] ?? []).length} songs</span>
              </li>
            ))}
          </ol>
        </section>
        <Link href="/lobby" style={styles.cta}>run it back 🔄</Link>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <span style={styles.code}>room {roomCode || '—'}</span>
        {missing && <Link href="/join" style={styles.joinLink}>join first →</Link>}
      </header>

      {/* everyone's scores (R006: watchers see it all) */}
      <section aria-label="scores">
        <ol style={styles.list}>
          {players.map((p) => (
            <li key={p.id} style={styles.li}>
              <span>{p.id === turnPlayerId ? '🎤 ' : ''}{p.name}{p.id === myId ? ' (you)' : ''}</span>
              <span style={styles.score}>{scores[p.id] ?? 0}</span>
            </li>
          ))}
        </ol>
      </section>

      {quip && <p style={styles.quip} aria-label="commentary">{quip}</p>}

      {/* active player + handover state */}
      {awaitingNext ? (
        <section aria-label="handover" style={styles.handover}>
          <p style={styles.p}>{COPY.handover}</p>
          <div style={styles.row}>
            {awaitingNext === myId && (
              <button style={styles.cta} onClick={() => send({ type: 'next_turn' })}>{COPY.next}</button>
            )}
            {isHost && (
              <button style={styles.ghost} onClick={() => send({ type: 'skip_turn' })}>{COPY.skipHost}</button>
            )}
          </div>
        </section>
      ) : myTurn ? (
        <section aria-label="your turn">
          <h2 style={styles.h2}>your turn — place this one</h2>
          <DealtSong track={dealt} lifted={lifted !== null} onLift={(t) => setLifted(t)} disabled={missing} />
        </section>
      ) : (
        <section aria-label="waiting">
          <h2 style={styles.h2}>
            {turnPlayerId
              ? `${players.find((p) => p.id === turnPlayerId)?.name ?? 'someone'} is cooking…`
              : 'waiting for the next song…'}
          </h2>
          <DealtSong track={null} lifted={false} disabled />
        </section>
      )}

      {/* turn outcome: correct bump or forfeit reveal (R005) */}
      {outcome && outcomeCopy && (
        <p style={styles.outcome} aria-label="turn outcome">
          {outcome.kind === 'forfeit'
            ? `${outcomeCopy} (drop zones ${outcome.correctSlots.map((s) => s + 1).join(' / ')})`
            : outcomeCopy}
        </p>
      )}

      {/* my line, rendered from the server snapshot */}
      <SongLine
        entries={mySlots}
        dragging={lifted !== null}
        activeSlot={activeSlot}
        highlightSlots={revealSlots}
        onDropAt={(i) => lifted && commit(lifted, i)}
      />

      {/* watchers: the active player's line building live (R006) */}
      {turnPlayerId && turnPlayerId !== myId && (snap?.lines?.[turnPlayerId]?.length ?? 0) > 0 && (
        <section aria-label="active player line" style={styles.watcher}>
          <h3 style={styles.h3}>
            {players.find((p) => p.id === turnPlayerId)?.name}&apos;s line so far
          </h3>
          <ol style={styles.list}>
            {(snap?.lines?.[turnPlayerId] ?? []).map((entry) => (
              <li key={entry.trackId} style={styles.li}>
                <span>{entry.summary.name}</span>
                <span style={styles.score}>{yearLabel(entry.summary)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <DragDropLayer
        lifted={lifted}
        onCommit={(idx) => lifted && commit(lifted, idx)}
        onActiveSlotChange={setActiveSlot}
      />

      {toasts.map((t) => (
        <div key={t.id} role="status" style={styles.toast}>{t.text}</div>
      ))}
      {err && <p style={styles.err}>{err}</p>}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
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
  h1: { fontSize: 26, textAlign: 'center' },
  h2: { fontSize: 16, margin: 0, opacity: 0.85 },
  h3: { fontSize: 14, margin: '0 0 6px', opacity: 0.7 },
  p: { fontSize: 14, margin: 0 },
  small: { fontSize: 12, opacity: 0.6, margin: 0 },
  quip: { fontSize: 13, fontStyle: 'italic', opacity: 0.7, margin: 0 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  li: { display: 'flex', justifyContent: 'space-between', fontSize: 14, background: '#151a24', borderRadius: 10, padding: '8px 12px' },
  score: { opacity: 0.7 },
  handover: { background: '#1c212c', borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 10 },
  cta: {
    background: '#1db954', color: '#04140a', border: 'none', borderRadius: 12,
    padding: '12px 20px', fontSize: 16, fontWeight: 700, cursor: 'pointer',
    textDecoration: 'none', textAlign: 'center',
  },
  ghost: {
    background: 'transparent', color: '#f2f4f8', border: '2px solid #2a2f3a', borderRadius: 12,
    padding: '12px 20px', fontSize: 16, cursor: 'pointer',
  },
  outcome: { fontSize: 15, background: '#231325', borderRadius: 12, padding: '10px 14px', border: '1px solid #b0455f' },
  watcher: { background: '#131720', borderRadius: 14, padding: 12 },
  toast: {
    position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
    background: '#1db954', color: '#04140a', borderRadius: 999, padding: '10px 18px',
    fontSize: 14, fontWeight: 600, zIndex: 2000, boxShadow: '0 8px 24px #0008',
    maxWidth: '90vw',
  },
  err: { color: '#ff7a90', fontSize: 14 },
};
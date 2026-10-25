'use client';

import type { RoomState, ServerEvent } from '@/server/events';
import { COPY } from '@/lib/copy';

/**
 * Lobby panel (T05): room code, joined players (2-8), chosen playlist +
 * eligible-track count (R019 visibility), and the host's start button that
 * locks the roster. Gen Z copy everywhere; >=48px touch targets.
 */

export interface LobbyPanelProps {
  room: RoomState;
  isHost: boolean;
  eligibleCount: number | null;
  requiredCount: number | null;
  playlistLockedIn: boolean;
  starting: boolean;
  onStart: () => void;
}

export default function LobbyPanel({
  room,
  isHost,
  eligibleCount,
  requiredCount,
  playlistLockedIn,
  starting,
  onStart,
}: LobbyPanelProps) {
  // 'locked' with no game yet = a failed start; the host retries start.
  const canStart =
    isHost && !starting &&
    (room.status === 'lobby' || room.status === 'locked') &&
    room.players.length >= room.minPlayers;
  return (
    <section aria-label="lobby">
      <p style={s.codeLabel}>room code</p>
      <h1 style={s.code}>{room.code}</h1>
      <p style={s.meta}>
        {room.players.length}/{room.maxPlayers} in · need {room.minPlayers}+ to start
      </p>

      <ul style={s.list}>
        {room.players.map((p) => (
          <li key={p.id} style={s.player}>
            {p.name}
            {p.isHost ? ' 👑' : ''}
          </li>
        ))}
      </ul>

      <div style={s.playlistBox}>
        <p style={s.playlistTitle}>{room.playlistName ?? 'no playlist yet'}</p>
        {eligibleCount !== null && (
          <p style={{ ...s.playlistMeta, ...(canShowRisk(eligibleCount, requiredCount) ? s.risky : {}) }}>
            {eligibleCount} eligible tracks{requiredCount ? ` · need ${requiredCount} for this roster` : ''}
          </p>
        )}
        {!playlistLockedIn && isHost && (
          <p style={s.playlistMeta}>{COPY.noPlaylist.recovery}</p>
        )}
      </div>

      {isHost && (
        <button style={s.btn} onClick={onStart} disabled={!canStart}>
          {starting
            ? 'locking it in…'
            : room.status === 'lobby' || room.status === 'locked'
              ? canStart
                ? 'start the game'
                : 'waiting for players…'
              : 'locked in ✓'}
        </button>
      )}
      {!isHost && (
        <p style={s.waiting}>{room.status === 'lobby' ? 'waiting for the host to start…' : COPY.gameStarted}</p>
      )}
    </section>
  );
}

/** R019 early warning: eligible count below what this roster will need. */
function canShowRisk(eligible: number | null, required: number | null): boolean {
  return eligible !== null && required !== null && eligible < required;
}

const s: Record<string, React.CSSProperties> = {
  codeLabel: { margin: 0, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 2, fontSize: 12 },
  code: { fontSize: 56, margin: 0, letterSpacing: 6 },
  meta: { opacity: 0.7, margin: 0 },
  list: { listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' },
  player: { padding: 14, borderRadius: 12, background: '#141821', fontSize: 17 },
  playlistBox: { padding: 14, borderRadius: 12, background: '#141821', display: 'flex', flexDirection: 'column', gap: 4 },
  playlistTitle: { margin: 0, fontWeight: 700, fontSize: 16 },
  playlistMeta: { margin: 0, opacity: 0.7, fontSize: 14 },
  risky: { color: '#ffb35c' },
  btn: {
    padding: 18, fontSize: 18, fontWeight: 700, borderRadius: 16, border: 'none',
    background: '#1db954', color: '#04120a', minHeight: 48, cursor: 'pointer', marginTop: 12,
  },
  btnDisabled: { opacity: 0.5, cursor: 'default' },
  waiting: { opacity: 0.6, fontSize: 15 },
};
import { getDb } from './db';
import { createHash } from 'node:crypto';
import type { Room } from './rooms';
import type { SpotifyTokens } from './spotify/auth';
import type { HostBinding } from './game';

/**
 * Write-through persistence helpers (S03-T01, R022/D008/MEM009).
 *
 * Every mutation seam calls one of these small synchronous helpers right
 * after it mutates the in-memory Map, so the DB is always current. When the
 * DB is unavailable (no writable path, tests without DB_PATH expectations)
 * every call degrades to a no-op after one structured log — the game runs
 * memory-only; a restart then loses state, which is the pre-S03 behavior.
 *
 * Never log tokens/secrets — sha-prefixed ids only (see sessions.hash /
 * the sha8 helper below).
 */

export interface PersistedGame {
  anchors: [string, { id: string; name: string; artists: string[]; albumName: string; releaseDate: string; year: string }][];
  lines: [string, { trackId: string; summary: unknown }[]][];
  scores: [string, number][];
  turnOrder: string[];
  turnIdx: number;
  awaitingNext: string | null;
  awaitingNextAt: number | null; // epoch ms — to re-arm the nudge timer
  speakerPaused: boolean; // S03-T03: speaker lost mid-turn — survives restart
  deck: unknown[]; // remaining deck in order (no shuffle on restore)
  current: { playerId: string; track: unknown } | null;
}

export interface PersistedRoom {
  room: Room;
}

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

function logPersist(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'persist', event, ...extra }));
}

// ---- rooms ----

export function saveRoom(room: Room): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO rooms (code, room_json) VALUES (?, ?)')
      .run(room.code, JSON.stringify(room));
  } catch (err) {
    logPersist('save_room_failed', { room: room.code, detail: String(err).slice(0, 120) });
  }
}

export function deleteRoom(code: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
  } catch (err) {
    logPersist('delete_room_failed', { room: code, detail: String(err).slice(0, 120) });
  }
}

// ---- sessions ----

export function saveSession(token: string, playerId: string, roomId: string, socketId: string | null): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO session_tokens (token, player_id, room_id, socket_id) VALUES (?, ?, ?, ?)')
      .run(token, playerId, roomId, socketId);
  } catch (err) {
    logPersist('save_session_failed', { room: roomId, detail: String(err).slice(0, 120) });
  }
}

export function deleteSession(token: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM session_tokens WHERE token = ?').run(token);
  } catch (err) {
    logPersist('delete_session_failed', { detail: String(err).slice(0, 120) });
  }
}

export function expireRoomSessions(roomId: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM session_tokens WHERE room_id = ?').run(roomId);
  } catch (err) {
    logPersist('expire_room_sessions_failed', { room: roomId, detail: String(err).slice(0, 120) });
  }
}

// ---- host spotify tokens ----

export function saveHostTokens(sessionId: string, tokens: SpotifyTokens): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO host_tokens (session_id, tokens_json, created_at) VALUES (?, ?, ?)')
      .run(sessionId, JSON.stringify(tokens), Date.now());
  } catch (err) {
    logPersist('save_host_tokens_failed', { session: sha8(sessionId), detail: String(err).slice(0, 120) });
  }
}

export function deleteHostTokens(sessionId: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM host_tokens WHERE session_id = ?').run(sessionId);
  } catch (err) {
    logPersist('delete_host_tokens_failed', { session: sha8(sessionId), detail: String(err).slice(0, 120) });
  }
}

// ---- host bindings (playlist + speaker pick per room) ----

export function saveHostBinding(roomCode: string, binding: HostBinding): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO host_bindings (room_code, binding_json) VALUES (?, ?)')
      .run(roomCode, JSON.stringify(binding));
  } catch (err) {
    logPersist('save_host_binding_failed', { room: roomCode, detail: String(err).slice(0, 120) });
  }
}

export function deleteHostBinding(roomCode: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM host_bindings WHERE room_code = ?').run(roomCode);
  } catch (err) {
    logPersist('delete_host_binding_failed', { room: roomCode, detail: String(err).slice(0, 120) });
  }
}

// ---- game state ----

export function saveGameState(roomCode: string, state: PersistedGame): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO game_state (room_code, state_json) VALUES (?, ?)')
      .run(roomCode, JSON.stringify(state));
  } catch (err) {
    logPersist('save_game_state_failed', { room: roomCode, detail: String(err).slice(0, 120) });
  }
}

export function deleteGameState(roomCode: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM game_state WHERE room_code = ?').run(roomCode);
  } catch (err) {
    logPersist('delete_game_state_failed', { room: roomCode, detail: String(err).slice(0, 120) });
  }
}

// ---- boot restore ----

export interface BootState {
  rooms: Room[];
  sessions: { token: string; playerId: string; roomId: string; socketId: string | null }[];
  hostTokens: { sessionId: string; tokens: SpotifyTokens }[];
  games: { roomCode: string; state: PersistedGame }[];
  bindings: { roomCode: string; binding: HostBinding }[];
}

/**
 * Load everything persisted. Called once at boot (src/server/main.ts before
 * listen; also by tests to simulate a restart). Sessions come back with
 * socketId from the row (restore rebinds to null anyway — the caller decides).
 */
export function loadAllAtBoot(): BootState {
  const db = getDb();
  if (!db) {
    logPersist('boot_restore_skipped', { reason: 'db_unavailable' });
    return { rooms: [], sessions: [], hostTokens: [], games: [], bindings: [] };
  }
  const rooms = (db.prepare('SELECT room_json FROM rooms').all() as { room_json: string }[])
    .map((r) => JSON.parse(r.room_json) as Room);
  const sessions = (db.prepare('SELECT token, player_id, room_id, socket_id FROM session_tokens').all() as {
    token: string; player_id: string; room_id: string; socket_id: string | null;
  }[]).map((s) => ({ token: s.token, playerId: s.player_id, roomId: s.room_id, socketId: s.socket_id }));
  const hostTokens = (db.prepare('SELECT session_id, tokens_json FROM host_tokens').all() as {
    session_id: string; tokens_json: string;
  }[]).map((h) => ({ sessionId: h.session_id, tokens: JSON.parse(h.tokens_json) as SpotifyTokens }));
  const games = (db.prepare('SELECT room_code, state_json FROM game_state').all() as {
    room_code: string; state_json: string;
  }[]).map((g) => ({ roomCode: g.room_code, state: JSON.parse(g.state_json) as PersistedGame }));
  const bindings = (db.prepare('SELECT room_code, binding_json FROM host_bindings').all() as {
    room_code: string; binding_json: string;
  }[]).map((b) => ({ roomCode: b.room_code, binding: JSON.parse(b.binding_json) as HostBinding }));
  logPersist('boot_restore_loaded', {
    rooms: rooms.length,
    sessions: sessions.length,
    hostTokens: hostTokens.length,
    games: games.length,
    bindings: bindings.length,
  });
  return { rooms, sessions, hostTokens, games, bindings };
}
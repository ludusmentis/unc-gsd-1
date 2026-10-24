import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { SessionToken } from './events';

/**
 * Session tokens are opaque (32 random bytes, base64url) and are validated
 * against the socket id they were issued to. Tokens expire when the room
 * they belong to ends (rooms.ts drops the session record).
 */

interface Session {
  token: SessionToken;
  socketId: string;
  playerId: string;
  roomId: string;
}

// keyed by token
const sessions = new Map<SessionToken, Session>();

export function issueSession(roomId: string, playerId: string, socketId: string): SessionToken {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { token, socketId, playerId, roomId });
  return token;
}

export function rebindSocket(token: SessionToken, socketId: string): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  s.socketId = socketId;
  return true;
}

/** True iff token is valid, belongs to roomId, and is bound to this socket id. */
export function authorize(token: SessionToken, roomId: string, socketId: string): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  const a = Buffer.from(s.token);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return s.roomId === roomId && s.socketId === socketId;
}

export function sessionPlayer(token: SessionToken): { playerId: string; roomId: string } | null {
  const s = sessions.get(token);
  return s ? { playerId: s.playerId, roomId: s.roomId } : null;
}

/** Expire all sessions for a room — called when the game ends. */
export function expireRoomSessions(roomId: string): void {
  for (const [tok, s] of sessions) {
    if (s.roomId === roomId) sessions.delete(tok);
  }
}

export function hash(token: SessionToken): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function _resetForTests(): void {
  sessions.clear();
}

import { randomInt } from 'node:crypto';
import type { Player, RoomState } from './events';
import { expireRoomSessions } from './sessions';
import { saveRoom, deleteRoom as persistDeleteRoom, expireRoomSessions as persistExpireRoomSessions } from './persist';

/**
 * Room state manager — server-authoritative. Room codes are 5 chars drawn
 * from an unambiguous charset (no 0/O/1/I/L or lookalikes), giving
 * log2(31^5) ≈ 24.7 bits of entropy (R020: >= 20 bits).
 */

export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars, no 0O1IL
export const ROOM_CODE_ENTROPY_BITS = Math.log2(ROOM_CODE_CHARSET.length ** ROOM_CODE_LENGTH); // ~24.67

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export interface Room extends RoomState {
  hostPlayerId: string;
}

const rooms = new Map<string, Room>();

let playerIdCounter = 0;
const nextPlayerId = () => `p${++playerIdCounter}`;

export function generateRoomCode(): string {
  let code: string;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARSET[randomInt(ROOM_CODE_CHARSET.length)];
    }
  } while (rooms.has(code));
  return code;
}

export function createRoom(hostName: string): Room {
  const code = generateRoomCode();
  const host: Player = { id: nextPlayerId(), name: hostName, isHost: true };
  const room: Room = {
    code,
    status: 'lobby',
    players: [host],
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    playlistName: null,
    hostPlayerId: host.id,
  };
  rooms.set(code, room);
  saveRoom(room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export type JoinResult =
  | { ok: true; room: Room; player: Player }
  | { ok: false; reason: 'room_not_found' | 'room_full' | 'room_locked' };

export function joinRoom(code: string, playerName: string): JoinResult {
  const room = getRoom(code);
  if (!room) return { ok: false, reason: 'room_not_found' };
  if (room.status !== 'lobby') return { ok: false, reason: 'room_locked' };
  if (room.players.length >= room.maxPlayers) return { ok: false, reason: 'room_full' };
  const player: Player = { id: nextPlayerId(), name: playerName, isHost: false };
  room.players.push(player);
  saveRoom(room);
  return { ok: true, room, player };
}

export function removePlayer(code: string, playerId: string): void {
  const room = getRoom(code);
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== playerId);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    persistDeleteRoom(room.code);
    expireRoomSessions(room.code);
    persistExpireRoomSessions(room.code);
  } else {
    saveRoom(room);
  }
}

export function lockRoster(code: string, playerId: string): boolean {
  const room = getRoom(code);
  if (!room || room.hostPlayerId !== playerId || room.status !== 'lobby') return false;
  if (room.players.length < room.minPlayers) return false;
  room.status = 'locked';
  saveRoom(room);
  return true;
}

/** S03 boot restore: rehydrate a persisted room row. Bumps the player id
 * counter past any restored ids so new players never collide. */
export function restoreRoom(room: Room): void {
  rooms.set(room.code, room);
  for (const p of room.players) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) playerIdCounter = Math.max(playerIdCounter, Number(m[1]));
  }
}

export function validName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 24;
}

export function roomCount(): number {
  return rooms.size;
}

export function _resetForTests(): void {
  rooms.clear();
}

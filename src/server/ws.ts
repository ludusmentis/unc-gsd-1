import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import type { ActionEnvelope, ServerEvent } from './events';
import { ERROR_MESSAGES } from './events';
import {
  createRoom,
  getRoom,
  joinRoom,
  lockRoster,
  removePlayer,
  validName,
  _resetForTests,
} from './rooms';
import { authorize, issueSession, rebindSocket, sessionPlayer, hash, expireRoomSessions, _resetForTests as resetSessions } from './sessions';
import { startGame, onPlaced, wakeSpeaker } from './game';

const ROOM_NS = '/game';

/** Upper bound on line slots a client may claim (sanity cap, not gameplay). */
export const MAX_LINE_SLOTS = 64;

interface SocketData {
  token?: string;
  roomCode?: string;
}

/**
 * Structured room lifecycle logging. Never log session tokens/secrets —
 * log a short sha256 prefix instead.
 */
function logRoom(roomCode: string, event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'room', room: roomCode, event, ...extra }));
}

function toClientRoom(room: ReturnType<typeof getRoom> & {}) {
  return {
    code: room.code,
    status: room.status,
    players: room.players,
    maxPlayers: room.maxPlayers,
    minPlayers: room.minPlayers,
    playlistName: room.playlistName,
  };
}

function broadcastLobby(io: IOServer, roomCode: string) {
  const room = getRoom(roomCode);
  if (!room) return;
  io.of(ROOM_NS).to(roomCode).emit('event', {
    type: 'lobby',
    room: toClientRoom(room),
  } satisfies ServerEvent);
}

/** Placement payload validation shared by the WS gate. */
export function isValidPlacement(trackId: unknown, slotIndex: unknown): boolean {
  return (
    typeof trackId === 'string' && trackId.length > 0 && trackId.length <= 64 &&
    typeof slotIndex === 'number' && Number.isInteger(slotIndex) &&
    slotIndex >= 0 && slotIndex <= MAX_LINE_SLOTS
  );
}

export function attachWs(httpServer: HttpServer): IOServer {
  const io = new IOServer(httpServer, { path: '/socket.io', cors: { origin: '*' } });

  io.of(ROOM_NS).on('connection', (socket: Socket & { data: SocketData }) => {
    const send = (e: ServerEvent) => socket.emit('event', e);
    const reject = (reason: keyof typeof ERROR_MESSAGES) =>
      send({ type: 'rejected', reason, ...ERROR_MESSAGES[reason] });

    socket.on('action', (env: ActionEnvelope) => {
      // ---- create_room: no token yet, but must carry a name ----
      if (env?.action?.type === 'create_room') {
        if (!validName(env.action.name)) return reject('bad_name');
        const room = createRoom(env.action.name.trim());
        const host = room.players[0];
        const token = issueSession(room.code, host.id, socket.id);
        socket.data = { token, roomCode: room.code };
        socket.join(room.code);
        logRoom(room.code, 'room_created', { host: host.id });
        send({ type: 'room_created', room: toClientRoom(room), you: host, token });
        return;
      }

      // ---- join_room: no token yet ----
      if (env?.action?.type === 'join_room') {
        if (!validName(env.action.name)) return reject('bad_name');
        const res = joinRoom(env.action.code, env.action.name.trim());
        if (!res.ok) {
          logRoom(String(env.action.code), 'join_rejected', { reason: res.reason });
          return reject(res.reason);
        }
        const token = issueSession(res.room.code, res.player.id, socket.id);
        socket.data = { token, roomCode: res.room.code };
        socket.join(res.room.code);
        logRoom(res.room.code, 'player_joined', { player: res.player.id, players: res.room.players.length });
        send({ type: 'joined', room: toClientRoom(res.room), you: res.player, token });
        broadcastLobby(io, res.room.code);
        return;
      }

      // ---- everything else requires a valid session bound to this socket ----
      const token = env?.token;
      if (typeof token !== 'string' || !socket.data?.roomCode || !authorize(token, socket.data.roomCode, socket.id)) {
        logRoom(socket.data?.roomCode ?? '?', 'action_rejected', { action: env?.action?.type, token: token ? hash(token) : null });
        return reject('invalid_token');
      }
      const roomCode = socket.data.roomCode;
      const session = sessionPlayer(token)!;
      const room = getRoom(roomCode);
      if (!room) return reject('room_not_found');

      switch (env.action.type) {
        case 'lock_roster': {
          if (room.hostPlayerId !== session.playerId) return reject('not_host');
          // Already locked (a previous start failed, e.g. playlist too
          // small)? This is a retry: re-run start, don't re-lock.
          const retry = room.status === 'locked';
          if (retry || lockRoster(roomCode, session.playerId)) {
            if (!retry) {
            logRoom(roomCode, 'roster_locked', { players: room.players.length });
            io.of(ROOM_NS).to(roomCode).emit('event', {
              type: 'roster_locked',
              room: toClientRoom(room),
            } satisfies ServerEvent);
            // Fire-and-forget: deck build + first deal + playback start.
            }
            startGame(roomCode, io).catch((err) =>
              logRoom(roomCode, 'game_start_failed', { detail: String(err).slice(0, 120) }),
            );
          } else {
            return reject('bad_action');
          }
          break;
        }
        case 'place_song': {
          // Server-authoritative placement (R020): the session was already
          // authorized above; here we validate the action payload shape and
          // broadcast to every client in the room.
          const { trackId, slotIndex } = env.action;
          if (!isValidPlacement(trackId, slotIndex)) return reject('bad_action');
          logRoom(roomCode, 'song_placed', { player: session.playerId, trackId, slotIndex });
          io.of(ROOM_NS).to(roomCode).emit('event', {
            type: 'song_placed',
            playerId: session.playerId,
            trackId,
            slotIndex,
          } satisfies ServerEvent);
          // Active player committing the dealt track: pause + next deal.
          onPlaced(roomCode, session.playerId, trackId, io).catch((err) =>
            logRoom(roomCode, 'place_followup_failed', { detail: String(err).slice(0, 120) }),
          );
          break;
        }
        case 'wake_speaker': {
          if (room.hostPlayerId !== session.playerId) return reject('not_host');
          logRoom(roomCode, 'wake_requested', { player: session.playerId });
          wakeSpeaker(roomCode, io).catch((err) =>
            logRoom(roomCode, 'wake_failed', { detail: String(err).slice(0, 120) }),
          );
          break;
        }
        case 'ping_state': {
          broadcastLobby(io, roomCode);
          break;
        }
        case 'leave_room': {
          removePlayer(roomCode, session.playerId);
          logRoom(roomCode, 'player_left', { player: session.playerId });
          socket.leave(roomCode);
          broadcastLobby(io, roomCode);
          break;
        }
        default:
          return reject('bad_action');
      }
    });

    socket.on('disconnect', () => {
      const { token, roomCode } = socket.data ?? {};
      if (token && roomCode) {
        const session = sessionPlayer(token);
        if (session) {
          logRoom(roomCode, 'socket_disconnected', { player: session.playerId });
        }
      }
    });
  });

  return io;
}

/** Rejoin support: a known token can re-bind to a new socket id. */
export function tryRejoin(io: IOServer, token: string, socketId: string): string | null {
  const session = sessionPlayer(token);
  if (session && rebindSocket(token, socketId)) {
    const room = getRoom(session.roomId);
    if (room) {
      logRoom(session.roomId, 'session_rebound', { player: session.playerId });
      return session.roomId;
    }
  }
  return null;
}

export function endRoom(io: IOServer, roomCode: string) {
  const room = getRoom(roomCode);
  if (!room) return;
  room.status = 'ended';
  io.of(ROOM_NS).to(roomCode).emit('event', { type: 'lobby', room: toClientRoom(room) } satisfies ServerEvent);
  expireRoomSessions(roomCode);
  logRoom(roomCode, 'room_ended');
}

export { _resetForTests, resetSessions };
export const ROOM_NAMESPACE = ROOM_NS;
export { broadcastLobby, logRoom };

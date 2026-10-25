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
  _resetForTests as resetRoomsForTests,
} from './rooms';
import { authorize, issueSession, rebindSocket, sessionPlayer, hash, expireRoomSessions, _resetForTests as resetSessions } from './sessions';
import {
  startGame,
  onPlaced,
  wakeSpeaker,
  onNextTurn,
  onSkipTurn,
  getGameStateSync,
  pauseForHostLeave,
  resumeAfterHostRejoin,
} from './game';

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

/** Grace window before a host socket drop actually pauses the room
 * (S03-T04). A page navigation (lobby -> game) remounts the host's socket
 * and would otherwise false-pause on every game start; the rejoin that
 * follows inside the window cancels the pending pause. */
export const HOST_LEAVE_GRACE_MS = 2000;

const pendingHostPause = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingHostPause(roomCode: string): void {
  const t = pendingHostPause.get(roomCode);
  if (t) {
    clearTimeout(t);
    pendingHostPause.delete(roomCode);
  }
}

function scheduleHostPause(io: IOServer, roomCode: string): void {
  cancelPendingHostPause(roomCode);
  pendingHostPause.set(
    roomCode,
    setTimeout(() => {
      pendingHostPause.delete(roomCode);
      pauseForHostLeave(roomCode, io).catch((err) =>
        logRoom(roomCode, 'host_leave_pause_failed', { detail: String(err).slice(0, 120) }),
      );
    }, HOST_LEAVE_GRACE_MS),
  );
  logRoom(roomCode, 'host_leave_scheduled', { graceMs: HOST_LEAVE_GRACE_MS });
}

/** Test hook: drop any pending host-leave pause timers. */
export function _clearPendingHostPauses(): void {
  for (const t of pendingHostPause.values()) clearTimeout(t);
  pendingHostPause.clear();
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

    socket.on('action', async (env: ActionEnvelope) => {
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

      // ---- rejoin: explicit identity re-bind (R009) BEFORE token
      // authorization. A token issued to an earlier socket (page remount,
      // phone lock, tab close, server restart) re-binds to this socket and
      // immediately receives the authoritative snapshot. Never mutates game
      // state (R020). A token bound to this same socket (or bound fresh)
      // both pass; a garbage token gets invalid_token like anywhere else.
      if (env?.action?.type === 'rejoin') {
        const reToken = typeof env.token === 'string' ? env.token : '';
        const reSession = reToken ? sessionPlayer(reToken) : null;
        if (!reSession) {
          logRoom('?', 'rejoin_rejected', { token: reToken ? hash(reToken) : null });
          return reject('invalid_token');
        }
        if (!rebindSocket(reToken, socket.id)) {
          return reject('invalid_token');
        }
        const reRoom = getRoom(reSession.roomId);
        if (!reRoom) return reject('room_not_found');
        socket.data = { token: reToken, roomCode: reRoom.code };
        socket.join(reRoom.code);
        logRoom(reRoom.code, 'session_rebound', { player: reSession.playerId });
        // The host rebinding within the grace window cancels any pending
        // host-leave pause (lobby -> game page remount, quick phone lock).
        if (reRoom.hostPlayerId === reSession.playerId) cancelPendingHostPause(reRoom.code);
        const you = reRoom.players.find((p) => p.id === reSession.playerId);
        if (you) {
          send({ type: 'rejoined', room: toClientRoom(reRoom), you, token: reToken });
        }
        const snap = getGameStateSync(reRoom.code);
        if (snap) {
          send({ type: 'state_sync', state: snap });
        } else {
          broadcastLobby(io, reRoom.code);
        }
        // S03-T04 (R008/R010): the host rejoining a host-leave-paused room
        // flips it back to in_progress and resumes the current turn
        // exactly (re-plays the unplaced track; no turn was consumed).
        if (reRoom.status === 'paused' && reRoom.hostPlayerId === reSession.playerId) {
          await resumeAfterHostRejoin(reRoom.code, io);
        }
        return;
      }

      // ---- rejoin (legacy path): a token issued to an earlier socket (previous page's
      // mount, or a pre-restart persisted session) re-binds to this socket.
      // Without this, every client page navigation remounts the socket and
      // the stale binding dooms the stored token (invalid_token).
      const carriedToken = env?.token;
      if (
        typeof carriedToken === 'string' &&
        (!socket.data?.roomCode || !authorize(carriedToken, socket.data.roomCode, socket.id))
      ) {
        const rejoinedRoom = tryRejoin(io, carriedToken, socket.id);
        if (rejoinedRoom) {
          socket.data = { token: carriedToken, roomCode: rejoinedRoom };
          socket.join(rejoinedRoom);
        }
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
          // S03-T04: placements only run in_progress — a host-leave paused
          // room rejects them (resume happens on host rejoin).
          if (room.status !== 'in_progress') return reject('game_not_in_progress');
          // Server-authoritative placement (R020): the session was already
          // authorized above; here we validate the action payload shape,
          // then the server evaluates via the pure scoring module and emits
          // the one authoritative result event (turn_result / turn_forfeit)
          // plus a full state_sync snapshot.
          const { trackId, slotIndex } = env.action;
          if (!isValidPlacement(trackId, slotIndex)) return reject('bad_action');
          logRoom(roomCode, 'song_placed', { player: session.playerId, trackId, slotIndex });
          io.of(ROOM_NS).to(roomCode).emit('event', {
            type: 'song_placed',
            playerId: session.playerId,
            trackId,
            slotIndex,
          } satisfies ServerEvent);
          // Active player committing the dealt track: evaluate, then handover.
          onPlaced(roomCode, session.playerId, trackId, slotIndex, io).catch((err) =>
            logRoom(roomCode, 'place_followup_failed', { detail: String(err).slice(0, 120) }),
          );
          break;
        }
        case 'next_turn': {
          // Handover: only the just-played player can advance from the
          // awaiting_next screen.
          if (room.status !== 'in_progress') return reject('game_not_in_progress');
          const res = await onNextTurn(roomCode, session.playerId, io);
          if (!res.ok) return reject('not_awaiting_you');
          break;
        }
        case 'skip_turn': {
          // Host-only force-deal: skips whoever is parked on the handover.
          if (room.hostPlayerId !== session.playerId) return reject('not_host_for_skip');
          if (room.status !== 'in_progress') return reject('game_not_in_progress');
          logRoom(roomCode, 'skip_turn', { host: session.playerId });
          onSkipTurn(roomCode, io).catch((err) =>
            logRoom(roomCode, 'skip_followup_failed', { detail: String(err).slice(0, 120) }),
          );
          break;
        }
        case 'ping_state': {
          // (Re)connect sync: a live game hands back the full snapshot;
          // otherwise the lobby roster.
          const snap = getGameStateSync(roomCode);
          if (snap) {
            send({ type: 'state_sync', state: snap });
          } else {
            broadcastLobby(io, roomCode);
          }
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
      if (!token || !roomCode) return;
      const session = sessionPlayer(token);
      if (!session) return;
      logRoom(roomCode, 'socket_disconnected', { player: session.playerId });
      // S03-T04 (R008/R010): host dropping mid-game pauses the room after a
      // short grace window (see HOST_LEAVE_GRACE_MS) — Gen Z copy, nudge
      // timer cleared, speaker paused best-effort. Non-host disconnects
      // change nothing — they rejoin via the T02 path.
      const room = getRoom(roomCode);
      if (room && room.status === 'in_progress' && room.hostPlayerId === session.playerId) {
        scheduleHostPause(io, roomCode);
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
      if (room.hostPlayerId === session.playerId) cancelPendingHostPause(room.code);
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

export function _resetForTests(): void {
  _clearPendingHostPauses();
  resetRoomsForTests();
}
export { resetSessions };
export const ROOM_NAMESPACE = ROOM_NS;
export { broadcastLobby, logRoom };

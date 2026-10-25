import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { attachWs, _resetForTests as resetWs, resetSessions } from '../src/server/ws';
import { _resetForTests as resetRooms, ROOM_CODE_CHARSET, ROOM_CODE_LENGTH, ROOM_CODE_ENTROPY_BITS, generateRoomCode, MIN_PLAYERS, MAX_PLAYERS } from '../src/server/rooms';
import { issueSession, authorize, expireRoomSessions } from '../src/server/sessions';
import type { ServerEvent } from '../src/server/events';

const GAME_NS = '/game';

let httpServer: Server;
let port: number;

beforeAll(async () => {
  httpServer = createServer();
  attachWs(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  resetRooms();
  resetSessions();
  resetWs();
});

function connect(): Promise<Socket> {
  return new Promise((resolve) => {
    const s = io(`http://localhost:${port}${GAME_NS}`, { path: '/socket.io' });
    s.on('connect', () => resolve(s));
  });
}

function emit(s: Socket, env: unknown) {
  s.emit('action', env);
}

function nextEvent(s: Socket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    s.on('event', (e: ServerEvent) => {
      if (e.type === type) { clearTimeout(t); resolve(e); }
    });
  });
}

function once(s: Socket, timeoutMs = 5000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for event')), timeoutMs);
    s.on('event', (e: ServerEvent) => { clearTimeout(t); resolve(e); });
  });
}

describe('room code generation (R020)', () => {
  it('uses an unambiguous charset and >= 20 bits of entropy', () => {
    expect(ROOM_CODE_CHARSET).not.toMatch(/[O0I1L]/);
    expect(ROOM_CODE_CHARSET.length).toBe(31); // A-Z minus O,I,L = 23 letters... verify below
    expect(ROOM_CODE_LENGTH).toBe(5);
    expect(ROOM_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(20);
  });

  it('produces codes only from the charset at the right length', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(new RegExp(`^[${ROOM_CODE_CHARSET}]{${ROOM_CODE_LENGTH}}$`));
    }
  });

  it('roster bounds are 2-8', () => {
    expect(MIN_PLAYERS).toBe(2);
    expect(MAX_PLAYERS).toBe(8);
  });
});

describe('session authorization (R020)', () => {
  it('authorizes the socket a token was issued to', () => {
    const tok = issueSession('ABCDE', 'p1', 'socket-a');
    expect(authorize(tok, 'ABCDE', 'socket-a')).toBe(true);
    expect(authorize(tok, 'ABCDE', 'socket-b')).toBe(false); // different socket — forgery
    expect(authorize('not-the-token', 'ABCDE', 'socket-a')).toBe(false);
    expect(authorize(tok, 'OTHER', 'socket-a')).toBe(false); // wrong room
  });

  it('expires all tokens when the room ends', () => {
    const tok = issueSession('ABCDE', 'p1', 'socket-a');
    expireRoomSessions('ABCDE');
    expect(authorize(tok, 'ABCDE', 'socket-a')).toBe(false);
  });
});

describe('room protocol over WebSocket', () => {
  it('rejoin: a stored token re-binds to a new socket after page navigation (S02 fix)', async () => {
    const host = await connect();
    const created = once(host) as Promise<any>;
    emit(host, { token: '', action: { type: 'create_room', name: 'Host' } });
    const createdEv = await created;
    const code = createdEv.room.code as string;
    const token = createdEv.token as string;

    // New page (lobby/game) mounts a fresh socket and pings with the stored
       // token. Before the fix this was rejected invalid_token (token bound to
    // the creating socket id, tryRejoin never wired).
    const page2 = await connect();
    const lobbyOrSync = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for lobby')), 5000);
      page2.on('event', (e: ServerEvent) => {
        if (e.type === 'lobby' || e.type === 'state_sync') { clearTimeout(t); resolve(e); }
      });
    });
    emit(page2, { token, action: { type: 'ping_state' } });
    const e = await lobbyOrSync;
    expect(e.type === 'lobby' || e.type === 'state_sync').toBe(true);
    if (e.type === 'lobby') expect(e.room.code).toBe(code);

    // The re-bound socket must now be authorized for room actions.
    // A guest joins first so the room survives the host's leave_room
    // (an emptied room is deleted and broadcasts nothing).
    const guest = await connect();
    const joined = once(guest) as Promise<any>;
    emit(guest, { token: '', action: { type: 'join_room', code, name: 'Guest' } });
    await joined;

    const left = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for lobby after leave')), 5000);
      // The leaver (page2) gets no broadcast (socket.leave runs first);
      // the remaining guest sees the roster update.
      guest.on('event', (ev3: ServerEvent) => {
        if (ev3.type === 'lobby' && !(ev3 as any).room.players.some((p: any) => p.name === 'Host')) {
          clearTimeout(t); resolve(ev3);
        }
      });
    });
    emit(page2, { token, action: { type: 'leave_room' } });
    const leftEv = await left;
    expect((leftEv as any).room.players).toHaveLength(1);
    expect((leftEv as any).room.players[0].name).toBe('Guest');

    // A forged token still cannot rejoin.
    const forger = await connect();
    const rej2 = nextEvent(forger, 'rejected');
    emit(forger, { token: 'forged-token-xyz', action: { type: 'ping_state' } });
    const r = await rej2;
    expect(r.type).toBe('rejected');

    host.disconnect(); page2.disconnect(); forger.disconnect(); guest.disconnect();
  });

  it('two clients join and receive identical lobby broadcasts', async () => {
    const host = await connect();
    const created = once(host) as Promise<any>;
    emit(host, { token: '', action: { type: 'create_room', name: 'Host' } });
    const createdEv = await created;
    const code = createdEv.room.code as string;
    expect(createdEv.you.isHost).toBe(true);
    expect(createdEv.token).toBeTruthy();

    const guest = await connect();
    const joined = once(guest) as Promise<any>;
    emit(guest, { token: '', action: { type: 'join_room', code, name: 'Guest' } });
    const joinedEv = await joined;
    expect(joinedEv.you.isHost).toBe(false);

    // both sockets should now receive identical lobby broadcasts
    const hostLobby = nextEvent(host, 'lobby');
    const guestLobby = nextEvent(guest, 'lobby');
    emit(host, { token: createdEv.token, action: { type: 'ping_state' } });
    const [h, g] = await Promise.all([hostLobby, guestLobby]);
    expect(h.room).toEqual(g.room);
    expect(h.room.players).toHaveLength(2);
    expect(h.room.players.map((p: any) => p.name).sort()).toEqual(['Guest', 'Host']);

    host.disconnect(); guest.disconnect();
  });

  it('rejects forged actions with an invalid or missing token', async () => {
    const host = await connect();
    const created = once(host) as Promise<any>;
    emit(host, { token: '', action: { type: 'create_room', name: 'Host' } });
    const createdEv = await created;
    const code = createdEv.room.code;

    const attacker = await connect();
    // never joined, sends lock_roster with a fabricated token
    const rej1 = nextEvent(attacker, 'rejected');
    emit(attacker, { token: 'forged-token-abc', action: { type: 'lock_roster' } });
    const r1 = await rej1;
    expect(r1.type).toBe('rejected');
    expect((r1 as any).error).toContain('session');

    // a joined non-host also cannot lock
    const guest = await connect();
    const joined = once(guest) as Promise<any>;
    emit(guest, { token: '', action: { type: 'join_room', code, name: 'Guest' } });
    const joinedEv = await joined;
    const rej2 = nextEvent(guest, 'rejected');
    emit(guest, { token: joinedEv.token, action: { type: 'lock_roster' } });
    const r2 = await rej2;
    expect(r2.type).toBe('rejected');
    expect((r2 as any).error).toContain('host');

    // a valid host token carried by a NEW socket now re-binds (rejoin fix):
    // token possession is session authority (bearer semantics — the same
    // rule the S03 boot restore relies on). The lock goes through.
    const rejoiner = await connect();
    const locked = nextEvent(rejoiner, 'roster_locked');
    emit(rejoiner, { token: createdEv.token, action: { type: 'lock_roster' } });
    const lockEv = await locked;
    expect(lockEv.room.status).toBe('locked');

    // a token from a room that never existed still cannot rejoin
    const ghost = await connect();
    const rej4 = nextEvent(ghost, 'rejected');
    emit(ghost, { token: 'totally-fabricated-token', action: { type: 'lock_roster' } });
    const r4 = await rej4;
    expect(r4.type).toBe('rejected');

    host.disconnect(); guest.disconnect(); attacker.disconnect(); rejoiner.disconnect(); ghost.disconnect();
  });

  it('host locks the roster once min players reached; lock broadcast to all', async () => {
    const host = await connect();
    const created = once(host) as Promise<any>;
    emit(host, { token: '', action: { type: 'create_room', name: 'Host' } });
    const { room, token } = await created;

    const guest = await connect();
    const joined = once(guest) as Promise<any>;
    emit(guest, { token: '', action: { type: 'join_room', code: room.code, name: 'G' } });
    await joined;

    const hostLock = nextEvent(host, 'roster_locked');
    const guestLock = nextEvent(guest, 'roster_locked');
    emit(host, { token, action: { type: 'lock_roster' } });
    const [h, g] = await Promise.all([hostLock, guestLock]);
    expect(h.room.status).toBe('locked');
    expect(h.room.status).toEqual(g.room.status);

    // joining a locked room is rejected
    const late = await connect();
    const rej = nextEvent(late, 'rejected');
    emit(late, { token: '', action: { type: 'join_room', code: room.code, name: 'Late' } });
    const r = await rej;
    expect(r.type).toBe('rejected');

    host.disconnect(); guest.disconnect(); late.disconnect();
  });

  it('rejects joins to nonexistent rooms and full rooms', async () => {
    const s = await connect();
    const rej1 = nextEvent(s, 'rejected');
    emit(s, { token: '', action: { type: 'join_room', code: 'ZZZZZ', name: 'X' } });
    expect((await rej1).type).toBe('rejected');

    const host = await connect();
    const created = once(host) as Promise<any>;
    emit(host, { token: '', action: { type: 'create_room', name: 'H' } });
    const { room } = await created;

    const clients: Socket[] = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      const c = await connect();
      const j = once(c) as Promise<any>;
      emit(c, { token: '', action: { type: 'join_room', code: room.code, name: `P${i}` } });
      await j;
      clients.push(c);
    }
    const extra = await connect();
    const rej2 = nextEvent(extra, 'rejected');
    emit(extra, { token: '', action: { type: 'join_room', code: room.code, name: 'Extra' } });
    expect((await rej2).type).toBe('rejected');

    s.disconnect(); host.disconnect(); extra.disconnect();
    clients.forEach((c) => c.disconnect());
  });

  it('rejects malformed actions and bad names', async () => {
    const s = await connect();
    const rej1 = nextEvent(s, 'rejected');
    emit(s, { token: '', action: { type: 'create_room', name: '' } });
    expect((await rej1).type).toBe('rejected');

    const rej2 = nextEvent(s, 'rejected');
    emit(s, null);
    expect((await rej2).type).toBe('rejected');

    s.disconnect();
  });
});

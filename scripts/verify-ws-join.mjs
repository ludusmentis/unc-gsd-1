#!/usr/bin/env node
/**
 * Automated ws-join verification (T01):
 *  - boots the real WS layer (scripts/ws-server.ts wraps src/server/ws.ts attachWs)
 *  - client A creates a room; client B joins by the broadcast code
 *  - asserts the server assigned authoritative, distinct identities
 *  - asserts an invalid room code is rejected with room_not_found
 *
 * Deliberately boots a WS-only server (no Next.js) so verification is
 * deterministic and race-free: it never touches .next, so a concurrent
 * `next build` (gate commands may background it) cannot break it.
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3999;
const URL = `http://127.0.0.1:${PORT}`;

const server = spawn('npx', ['tsx', 'scripts/ws-server.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let stdout = '';
server.stdout.on('data', (d) => { stdout += d; });

function fail(msg) {
  console.error(`VERIFY-FAIL: ${msg}`);
  server.kill('SIGTERM');
  process.exit(1);
}

async function waitForListening(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.includes('"event":"listening"')) return;
    if (server.exitCode !== null) fail(`server exited early: ${stdout}`);
    await wait(250);
  }
  fail('server never reached listening state');
}

function connect() {
  const sock = io(`${URL}/game`, { path: '/socket.io', transports: ['websocket', 'polling'] });
  sock.on('connect_error', (e) => console.error('socket connect_error:', e.message));
  sock.on('disconnect', (r) => console.error('socket disconnected:', r));
  return sock;
}

function onceEvent(sock, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), timeoutMs);
    sock.on('event', (e) => {
      if (e.type === type) { clearTimeout(t); resolve(e); }
    });
  });
}

async function main() {
  await waitForListening();

  const host = connect();
  const hostRoomPromise = onceEvent(host, 'room_created');
  host.emit('action', { action: { type: 'create_room', name: 'Host' } });
  const hostRoom = await hostRoomPromise;
  const roomCode = hostRoom.room.code;
  if (!roomCode || typeof roomCode !== 'string' || roomCode.length !== 5) {
    fail(`server did not issue a valid room code: ${JSON.stringify(hostRoom)}`);
  }
  if (!hostRoom.you?.id || !hostRoom.you.isHost) {
    fail(`server did not assign authoritative host identity: ${JSON.stringify(hostRoom.you)}`);
  }

  const guest = connect();
  const joinPromise = onceEvent(guest, 'joined');
  const lobbyPromise = onceEvent(guest, 'lobby', 8000).catch(() => null);
  guest.emit('action', { action: { type: 'join_room', code: roomCode, name: 'Guest' } });
  const joined = await joinPromise;
  if (!joined.you?.id || joined.you.isHost) {
    fail(`server did not assign authoritative guest identity: ${JSON.stringify(joined.you)}`);
  }
  if (joined.you.id === hostRoom.you.id) {
    fail(`identities collide: host and guest both ${joined.you.id}`);
  }
  if (joined.room.players.length !== 2) {
    fail(`expected 2 players in room, got ${joined.room.players.length}`);
  }
  await lobbyPromise; // guest also receives the lobby broadcast — non-fatal

  // Invalid room code must be rejected.
  const bad = connect();
  const rejPromise = onceEvent(bad, 'rejected');
  bad.emit('action', { action: { type: 'join_room', code: 'ZZZZZ', name: 'Ghost' } });
  const rej = await rejPromise;
  if (rej.reason !== 'room_not_found') {
    fail(`invalid code rejected with wrong reason: ${JSON.stringify(rej)}`);
  }

  host.close(); guest.close(); bad.close();
  console.log('VERIFY-OK: two clients joined room', roomCode,
    'as', hostRoom.you.id, 'and', joined.you.id,
    '; invalid room code rejected with room_not_found');
  server.kill('SIGTERM');
  process.exit(0);
}

main().catch((err) => fail(err.message));

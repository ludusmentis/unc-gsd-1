#!/usr/bin/env node
/**
 * BASE_URL-parameterized deploy smoke (S04-T02):
 *  - If BASE_URL is set: do NOT boot a server. Run HTTP + socket.io checks
 *    against the already-running deployment (container / tunnel).
 *  - If BASE_URL is unset: self-host `npx tsx scripts/ws-server.ts` on a free
 *    port (same pattern as scripts/verify-ws-join.mjs) and run identical
 *    checks, so the script is a standalone gate.
 *
 * Checks:
 *  - GET BASE_URL/ answers 200 with a known root marker.
 *  - socket.io client connects to the /game namespace (path /socket.io),
 *    creates a room, a second client joins via the broadcast code.
 *  - Server-assigned identities are authoritative and distinct.
 *  - Invalid room code is rejected with room_not_found.
 *
 * Prints VERIFY-OK lines; exits nonzero on any failure. Never logs secrets.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { io } from 'socket.io-client';

const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');

// The real Next.js root page carries the literal marker; the ws-only self-host
// server answers with JSON {ok:true,ws:true} at / — accept either marker.
const MARKERS = ['host a room', '"ws":true'];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null; // self-hosted server process (if any)

function fail(msg) {
  console.error(`VERIFY-FAIL: ${msg}`);
  if (child) child.kill('SIGTERM');
  process.exit(1);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function selfHost() {
  const port = await freePort();
  child = spawn('npx', ['tsx', 'scripts/ws-server.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (stdout.includes('"event":"listening"')) return url;
    if (child.exitCode !== null) fail(`self-hosted server exited early: ${stdout}`);
    await wait(250);
  }
  fail('self-hosted server never reached listening state');
}

async function checkHttpRoot(url) {
  const res = await fetch(`${url}/`);
  if (res.status !== 200) fail(`GET ${url}/ returned status ${res.status}, expected 200`);
  const body = await res.text();
  if (!MARKERS.some((m) => body.includes(m))) {
    fail(`GET ${url}/ body lacks known root marker (${MARKERS.join(' | ')})`);
  }
  console.log(`VERIFY-OK: HTTP GET ${url}/ -> 200 with known root marker`);
}

function connect(url) {
  const sock = io(`${url}/game`, { path: '/socket.io', transports: ['websocket', 'polling'] });
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

async function checkWsJoin(url) {
  const host = connect(url);
  const hostRoomPromise = onceEvent(host, 'room_created');
  host.emit('action', { action: { type: 'create_room', name: 'Host' } });
  const hostRoom = await hostRoomPromise;
  const roomCode = hostRoom.room?.code;
  if (!roomCode || typeof roomCode !== 'string' || roomCode.length !== 5) {
    fail(`server did not issue a valid room code: ${JSON.stringify(hostRoom)}`);
  }
  if (!hostRoom.you?.id || !hostRoom.you.isHost) {
    fail(`server did not assign authoritative host identity: ${JSON.stringify(hostRoom.you)}`);
  }
  console.log(`VERIFY-OK: room created via WS, broadcast code ${roomCode}, host id ${hostRoom.you.id}`);

  const guest = connect(url);
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
  console.log(`VERIFY-OK: guest joined by code ${roomCode} with distinct identity ${joined.you.id}`);

  const bad = connect(url);
  const rejPromise = onceEvent(bad, 'rejected');
  bad.emit('action', { action: { type: 'join_room', code: 'ZZZZZ', name: 'Ghost' } });
  const rej = await rejPromise;
  if (rej.reason !== 'room_not_found') {
    fail(`invalid code rejected with wrong reason: ${JSON.stringify(rej)}`);
  }
  console.log('VERIFY-OK: invalid room code rejected with room_not_found');

  host.close(); guest.close(); bad.close();
}

async function main() {
  const url = BASE_URL || (await selfHost());
  const mode = BASE_URL ? 'remote' : 'self-hosted';
  console.log(`VERIFY-OK: target ${url} (${mode})`);
  await checkHttpRoot(url);
  await checkWsJoin(url);
  if (child) child.kill('SIGTERM');
  console.log(`VERIFY-OK: deploy smoke passed (${mode}) against ${url}`);
  process.exit(0);
}

// stdio cleanup — kill child on any exit path
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (child) child.kill('SIGTERM');
    process.exit(1);
  });
}
process.on('exit', () => { if (child) child.kill('SIGTERM'); });

main().catch((err) => fail(err.message));

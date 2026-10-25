/**
 * Minimal WS-only server for scripts/verify-ws-join.mjs.
 *
 * Boots the production WebSocket layer (src/server/ws.ts attachWs) on a bare
 * HTTP server without Next.js. This deliberately removes any dependency on a
 * .next production build, so the ws-join verification is deterministic even
 * when a concurrent `next build` is rewriting .next (gate commands may
 * background the build).
 */
import { createServer } from 'node:http';
import { attachWs } from '../src/server/ws';

const PORT = Number(process.env.PORT ?? 3998);

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ws: true }));
});

attachWs(httpServer);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'server', event: 'listening', port: PORT, wsOnly: true }));
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

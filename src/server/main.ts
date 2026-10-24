import { createServer } from 'node:http';
import next from 'next';
import { attachWs } from './ws';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const app = next({ dev: process.env.NODE_ENV !== 'production' });
  await app.prepare();

  const httpServer = createServer((req, res) => app.getRequestHandler()(req, res));

  // WebSocket layer shares the HTTP upgrade path with Next.js.
  const io = attachWs(httpServer);

  httpServer.listen(PORT, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'server', event: 'listening', port: PORT }));
  });

  const shutdown = () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'server', event: 'shutdown' }));
    io.close(() => httpServer.close(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal server error', err);
  process.exit(1);
});

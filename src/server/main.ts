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

  const shutdown = (code = 0) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'server', event: 'shutdown' }));
    io.close(() => httpServer.close(() => process.exit(code)));
  };

  // --check: boot the server, verify it answers, then exit 0. Used by gate
  // commands so a health-probe invocation never lingers as an orphan dev
  // process that writes build output while host checks run.
  if (process.argv.includes('--check')) {
    const url = `http://127.0.0.1:${PORT}`;
    const deadline = Date.now() + 30_000;
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status === 404) { // server is answering requests
          console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'server', event: 'check_ok', url }));
          shutdown(0);
          return;
        }
      } catch {
        // not up yet — retry
      }
      if (Date.now() > deadline) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), scope: 'server', event: 'check_failed', url }));
        shutdown(1);
        return;
      }
      setTimeout(probe, 500);
    };
    probe();
    return;
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal server error', err);
  process.exit(1);
});

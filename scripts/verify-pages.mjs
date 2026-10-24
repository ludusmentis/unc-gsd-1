// Boots the real server (Next + WS), checks the lobby/host/join/game pages
// render HTTP 200, then exits. Self-terminating — no orphan dev server.
import { spawn } from 'node:child_process';

const PORT = 3189;
const child = spawn('npx', ['tsx', 'src/server/main.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const fail = (msg) => {
  console.error(JSON.stringify({ scope: 'verify-pages', ok: false, msg }));
  child.kill('SIGTERM');
  process.exit(1);
};
child.on('exit', (code) => {
  if (exited) return;
  fail(`server exited early (code ${code})`);
});

let exited = false;
const deadline = Date.now() + 60_000;
const pages = ['/', '/host', '/join', '/lobby', '/game'];

const poll = async () => {
  try {
    for (const p of pages) {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
      if (res.status !== 200) fail(`${p} returned ${res.status}`);
    }
    exited = true;
    console.log(JSON.stringify({ scope: 'verify-pages', ok: true, pages, port: PORT }));
    child.kill('SIGTERM');
    process.exit(0);
  } catch {
    if (Date.now() > deadline) fail('server never became reachable');
    setTimeout(poll, 500);
  }
};
poll();
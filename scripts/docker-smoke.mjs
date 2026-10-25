#!/usr/bin/env node
/**
 * Container build/run smoke proof (S04-T03, R011):
 *  1. `docker build -t nursehound .` (skip with SKIP_BUILD=1 if already built)
 *  2. `docker run -d --rm -p 3123:3000 --name nursehound-smoke nursehound`
 *  3. Poll http://127.0.0.1:3123/ until it answers (60s), honoring the
 *     structured {"event":"listening"} log line via `docker logs`.
 *  4. Run the same HTTP + WS checks as scripts/verify-deploy.mjs with
 *     BASE_URL=http://127.0.0.1:3123 by spawning it.
 *  5. ALWAYS stop the container in a finally block.
 *
 * Prints VERIFY-OK lines; exits nonzero on any failure. Never logs secrets.
 */
import { spawn, spawnSync } from 'node:child_process';

const HOST_PORT = process.env.SMOKE_PORT || '3123';
const CONTAINER = 'nursehound-smoke';
const IMAGE = 'nursehound';
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`VERIFY-FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function logTail(label, out) {
  const lines = out.split('\n').filter(Boolean).slice(-8);
  for (const line of lines) console.error(`  ${label}: ${line}`);
}

async function main() {
  // Pre-flight: docker CLI + daemon must be present.
  if (run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) {
    fail('docker CLI or daemon unavailable — start Docker/colima before running this smoke');
  }
  console.log('VERIFY-OK: docker daemon reachable');

  // 1. Build (unless SKIP_BUILD=1).
  if (process.env.SKIP_BUILD === '1') {
    console.log('VERIFY-OK: SKIP_BUILD=1 — assuming image already built');
  } else {
    console.log('VERIFY-OK: building image (docker build -t nursehound .)…');
    const build = run('docker', ['build', '-t', IMAGE, '.']);
    if (build.status !== 0) {
      logTail('build', build.stderr + build.stdout);
      fail('docker build failed');
    }
    console.log('VERIFY-OK: docker build succeeded');
  }

  // Safety: remove any stale container from an earlier crashed run.
  run('docker', ['rm', '-f', CONTAINER]);

  try {
    // 2. Run detached.
    const runRes = run('docker', [
      'run', '-d', '--rm',
      '-p', `${HOST_PORT}:3000`,
      '-e', `DB_PATH=/app/data/nursehound.db`,
      '--name', CONTAINER,
      IMAGE,
    ]);
    if (runRes.status !== 0) {
      logTail('run', runRes.stderr);
      fail('docker run failed');
    }
    console.log(`VERIFY-OK: container ${CONTAINER} running, mapped ${HOST_PORT}->3000`);

    // 3. Poll until the app answers (60s), honoring the listening log line.
    const deadline = Date.now() + 60000;
    let answered = false;
    while (Date.now() < deadline) {
      const logs = run('docker', ['logs', CONTAINER]).stdout;
      const listening = logs.includes('"event":"listening"');
      if (listening) {
        try {
          const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(3000) });
          if (res.status === 200) { answered = true; break; }
        } catch { /* still booting */ }
      }
      const inspect = run('docker', ['inspect', '-f', '{{.State.Status}}', CONTAINER]);
      if (inspect.stdout.trim() !== 'running') {
        logTail('docker-logs', logs);
        fail(`container exited early (state=${inspect.stdout.trim()})`);
      }
      await wait(500);
    }
    if (!answered) {
      logTail('docker-logs', run('docker', ['logs', CONTAINER]).stdout);
      fail(`app did not answer on ${BASE_URL} within 60s`);
    }
    console.log(`VERIFY-OK: app answered HTTP on ${BASE_URL} (structured listening log observed)`);

    // 4. Same HTTP + WS checks as verify-deploy, pointed at the container.
    const verify = run('node', ['scripts/verify-deploy.mjs'], {
      env: { ...process.env, BASE_URL },
    });
    process.stdout.write(verify.stdout);
    process.stderr.write(verify.stderr);
    if (verify.status !== 0) fail('verify-deploy checks against the container failed');
    console.log(`VERIFY-OK: deploy smoke (HTTP + socket.io create/join/reject) passed against container at ${BASE_URL}`);
  } finally {
    // 5. ALWAYS stop the container.
    const stop = run('docker', ['stop', '-t', '5', CONTAINER]);
    if (stop.status === 0) console.log(`VERIFY-OK: container ${CONTAINER} stopped and removed`);
    else console.error(`WARN: docker stop ${CONTAINER} failed: ${stop.stderr.trim()}`);
  }

  console.log('VERIFY-OK: docker-smoke passed end-to-end');
  process.exit(0);
}

main().catch((err) => fail(err.message));

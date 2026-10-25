import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type SqliteDb = InstanceType<typeof Database>;

/**
 * SQLite handle for S03 persistence (R022/D008/MEM009): every piece of
 * server state (rooms, sessions, host Spotify tokens, game runtime data)
 * is written through to disk so a container restart on Unraid never kills
 * a live game night.
 *
 * - Path from `process.env.DB_PATH` (default `./data/nursehound.db` —
 *   the Docker volume target).
 * - WAL mode: small synchronous writes, crash-safe.
 * - Degrades to null (persist.ts no-ops) if the DB cannot be opened —
 *   the game keeps running in memory-only mode with one structured log.
 */

const DEFAULT_DB_PATH = './data/nursehound.db';

let db: SqliteDb | null = null;
let broken = false;

function logDb(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'db', event, ...extra }));
}

/** Open (lazily, once) and initialize the database. Null if unavailable. */
export function getDb(): SqliteDb | null {
  if (db || broken) return db;
  try {
    const path = process.env.DB_PATH ?? DEFAULT_DB_PATH;
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        room_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_tokens (
        token TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        socket_id TEXT
      );
      CREATE TABLE IF NOT EXISTS host_tokens (
        session_id TEXT PRIMARY KEY,
        tokens_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_state (
        room_code TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_bindings (
        room_code TEXT PRIMARY KEY,
        binding_json TEXT NOT NULL
      );
    `);
    logDb('db_opened', { path });
    return db;
  } catch (err) {
    broken = true;
    logDb('db_unavailable', { detail: String(err).slice(0, 160) });
    return null;
  }
}

/** Test hook: close and forget the handle so a new DB_PATH takes effect. */
export function _resetDbForTests(): void {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
  }
  db = null;
  broken = false;
}
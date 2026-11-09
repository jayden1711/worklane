// Every connection to an events database waits for a lock rather than failing at once. The one way to read one
// read-only (the dashboard's reads, hooks, the migration plan): opened here, with the same wait as the log's writers.
import { DatabaseSync } from 'node:sqlite';
import type { StoredEvent } from './types.js';

/**
 * How long a connection waits on another one's lock before SQLite says "database is locked". WHY: in WAL mode a reader
 * still meets a lock: the last connection to close checkpoints and drops the WAL under an exclusive lock, which any
 * process's close (a CLI write, the dashboard's own audit write, a log the garbage collector closes) can take while a
 * read opens. Without a wait that read fails, and the dashboard answers 500.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** An events database opened read-only, waiting out another connection's lock (BUSY_TIMEOUT_MS). The caller closes it. */
export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Every event of an events database, read-only, in id order, payloads parsed (a shadow run's log, say). */
export function readEvents(path: string): StoredEvent[] {
  const db = openReadOnly(path);
  try {
    const rows = db.prepare('SELECT id, ts, type, actor, source, payload FROM events ORDER BY id').all() as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), ts: String(r.ts), type: r.type, actor: String(r.actor), source: r.source, payload: JSON.parse(String(r.payload)) }) as StoredEvent);
  } finally {
    db.close();
  }
}

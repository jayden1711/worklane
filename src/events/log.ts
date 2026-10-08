// The append-only event log (SQLite via node:sqlite). Append-only is
// enforced by the database: triggers reject UPDATE and DELETE, so no code
// path can rewrite history. Payloads are validated and redacted on write.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventSchemas, type EventPayload, type EventType, type StoredEvent } from './types.js';
import { redact } from './redact.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

export class EventLog {
  readonly db: DatabaseSync;
  private listeners = new Set<(e: StoredEvent) => void>();

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  append<T extends EventType>(type: T, payload: EventPayload<T>, actor: string, source: StoredEvent['source'] = 'coordinator'): StoredEvent<T> {
    const parsed = EventSchemas[type].parse(payload) as EventPayload<T>;
    const clean = redact(parsed);
    const ts = new Date().toISOString();
    const r = this.db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(ts, type, actor, source, JSON.stringify(clean));
    const e: StoredEvent<T> = { id: Number(r.lastInsertRowid), ts, type, actor, source, payload: clean };
    for (const l of this.listeners) l(e);
    return e;
  }

  /** Events after `afterId`, optionally of some types. */
  read(afterId = 0, types?: EventType[]): StoredEvent[] {
    const rows = (
      types?.length
        ? this.db.prepare(`SELECT * FROM events WHERE id > ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id`).all(afterId, ...types)
        : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(afterId)
    ) as { id: number; ts: string; type: EventType; actor: string; source: StoredEvent['source']; payload: string }[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  lastId(): number {
    const r = this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null };
    return r.id ?? 0;
  }

  subscribe(fn: (e: StoredEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.db.close();
  }
}

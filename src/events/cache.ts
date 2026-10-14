// The event log as one dashboard process keeps it in memory: read whole once, then only what was appended since
// (`id > last`), so a request costs a query for nothing new rather than reading and parsing the whole log again.
// Views that are a fold over the events alone are kept per snapshot (memo), so an unchanged log costs nothing.
//
// The log is append-only (triggers refuse UPDATE and DELETE, src/events/log.ts); only a migration (a new
// user_version) or a different file at the path (a restore, a move) changes what was read, and either reads it whole
// again. INVARIANT: every event and every snapshot handed out is frozen, so no view can change what the next request
// reads: a view that tries throws, and that request fails rather than every later one going wrong.
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { StoredEvent } from './types.js';

type Row = { id: number; ts: string; type: string; actor: string; source: string; payload: string };

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};

/** An events database opened read-only, waiting out another connection's lock. */
export type OpenRead = (path: string) => DatabaseSync;
const openRead: OpenRead = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
};

export class EventCache {
  private snap: readonly StoredEvent[] = Object.freeze([]);
  private last = 0;
  /** What was read: the file (device and inode) and its schema version; a change to either reads it whole again. */
  private identity = '';
  private memos = new Map<string, unknown>();
  /** How many times the log was read whole (tests). */
  fullReads = 0;

  constructor(
    readonly path: string,
    private readonly open: OpenRead = openRead,
  ) {}

  /**
   * Every event, oldest first, as the log has it now. Frozen at run time (typed mutable only so the views' signatures
   * stay as they are): never change it, or anything in it; a copy (filter, slice, spread) is yours.
   */
  all(): StoredEvent[] {
    this.refresh();
    return this.snap as StoredEvent[];
  }

  /** The events after `id`, oldest first (the log as it is now). */
  after(id: number): StoredEvent[] {
    const all = this.all();
    // Ids rise with position: the first one after `id`, by bisection.
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (all[mid]!.id > id) hi = mid;
      else lo = mid + 1;
    }
    return all.slice(lo);
  }

  /** The last event's id (0 for none). */
  lastId(): number {
    this.refresh();
    return this.last;
  }

  /**
   * `fn` of the events as they are now, computed once per snapshot and kept until the log changes. Only for a pure fold
   * of the events (`key` names it and anything else it depends on, such as the day). The value is frozen like the events.
   */
  memo<T>(key: string, fn: (events: StoredEvent[]) => T): T {
    const events = this.all();
    if (this.memos.has(key)) return this.memos.get(key) as T;
    const v = deepFreeze(fn(events));
    this.memos.set(key, v);
    return v;
  }

  private refresh(): void {
    if (!existsSync(this.path)) {
      if (this.identity !== 'none') this.reset('none');
      return;
    }
    const st = statSync(this.path);
    const db = this.open(this.path);
    let rows: Row[];
    try {
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      const identity = `${st.dev}:${st.ino}:${version}`;
      // A table that isn't there yet (a log being made) reads as no events.
      const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
      if (!hasTable) {
        if (this.identity !== identity || this.snap.length) this.reset(identity);
        return;
      }
      const max = Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get() as { m: number }).m);
      if (identity !== this.identity || max < this.last) {
        this.reset(identity);
        this.fullReads++;
      }
      if (max === this.last) return;
      rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(this.last) as Row[];
    } finally {
      db.close();
    }
    if (!rows.length) return;
    const fresh = rows.map((r) => deepFreeze({ ...r, payload: JSON.parse(r.payload) }) as StoredEvent);
    this.snap = Object.freeze(this.snap.length ? [...this.snap, ...fresh] : fresh);
    this.last = fresh.at(-1)!.id;
    this.memos.clear();
  }

  private reset(identity: string) {
    this.identity = identity;
    this.snap = Object.freeze([]);
    this.last = 0;
    this.memos.clear();
  }
}

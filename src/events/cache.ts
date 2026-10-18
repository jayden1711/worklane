// The event log as one dashboard process keeps it in memory: read whole once, then only what was appended since
// (`id > last`), so a request costs a query for nothing new rather than reading and parsing the whole log again.
// Views that are a fold over the events alone are kept per snapshot (memo), so an unchanged log costs nothing; a
// fold that can go on from where it was (fold) steps through only what was appended. An answer made of several views
// takes them from one snapshot (snapshot), so an event appended between two of them can't be in one and not the other.
//
// The log is append-only (triggers refuse UPDATE and DELETE, src/events/log.ts); only a migration (a new
// user_version) or a different file at the path (a restore, a move) changes what was read, and either reads it whole
// again. INVARIANT: every event and every snapshot handed out is frozen, so no view can change what the next request
// reads: a view that tries throws, and that request fails rather than every later one going wrong.
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openReadOnly } from './read-only.js';
import type { StoredEvent } from './types.js';

type Row = { id: number; ts: string; type: string; actor: string; source: string; payload: string };

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};

/** An events database opened read-only, waiting out another connection's lock (src/events/read-only.ts). */
export type OpenRead = (path: string) => DatabaseSync;

/**
 * The log as one read of it found it, and the views kept of exactly those events (EventCache.snapshot). However many
 * events another process appends meanwhile, a snapshot's views are all of the same events.
 */
export interface EventSnapshot {
  /** Its events, oldest first, frozen as EventCache.all's are. */
  all(): StoredEvent[];
  /** Its last event's id (0 for none). */
  lastId(): number;
  /** EventCache.memo, of these events. */
  memo<T>(key: string, fn: (events: StoredEvent[]) => T): T;
  /** EventCache.fold, stepped through these events and no further. */
  fold<S>(key: string, init: () => S, step: (s: S, e: StoredEvent) => void): S;
  /** Itself: an answer that takes its snapshot from what it is handed reads this one, never a later one. */
  snapshot(): EventSnapshot;
}

/** Where an answer takes its one snapshot from: the cache (the log as it is now), or a snapshot already taken. */
export interface Snapshots {
  snapshot(): EventSnapshot;
}

export class EventCache {
  private snap: readonly StoredEvent[] = Object.freeze([]);
  private last = 0;
  /** What was read: the file (device and inode) and its schema version; a change to either reads it whole again. */
  private identity = '';
  private memos = new Map<string, unknown>();
  /** Folds carried forward across appends (fold), each with how many events it has seen. */
  private folds = new Map<string, { s: unknown; n: number }>();
  /** How many times the log was read whole (tests). */
  fullReads = 0;

  constructor(
    readonly path: string,
    private readonly open: OpenRead = openReadOnly,
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
   * The log as it is now, read once: every view of it (all, memo, fold) is of these events, however many are appended
   * meanwhile. An answer made of more than one view reads them all from one snapshot.
   */
  snapshot(): EventSnapshot {
    this.refresh();
    const events = this.snap as StoredEvent[];
    const last = this.last;
    const s: EventSnapshot = {
      all: () => events,
      lastId: () => last,
      memo: <T>(key: string, fn: (events: StoredEvent[]) => T): T => this.memoOf(events, key, fn),
      fold: <S>(key: string, init: () => S, step: (s: S, e: StoredEvent) => void): S => this.foldOf(events, key, init, step),
      snapshot: () => s,
    };
    return s;
  }

  /**
   * `fn` of the events as they are now, computed once per snapshot and kept until the log changes. Only for a pure fold
   * of the events (`key` names it and anything else it depends on, such as the day). The value is frozen like the events.
   */
  memo<T>(key: string, fn: (events: StoredEvent[]) => T): T {
    return this.snapshot().memo(key, fn);
  }

  /**
   * A fold of the events kept across snapshots: `step` sees each event once, in the log's order, as it is appended, so
   * a read after an append costs the new events only. Read whole again (from `init()`) only when the log is (reset).
   * The state is the fold's: read it, never change it outside `step`. A `step` that throws drops the fold, so the next
   * read starts it again rather than going on from a half-applied event.
   */
  fold<S>(key: string, init: () => S, step: (s: S, e: StoredEvent) => void): S {
    return this.snapshot().fold(key, init, step);
  }

  private memoOf<T>(events: StoredEvent[], key: string, fn: (events: StoredEvent[]) => T): T {
    // WHY: only the newest snapshot's views are kept; one taken before the cache read more is computed and not kept.
    const kept = events === this.snap;
    if (kept && this.memos.has(key)) return this.memos.get(key) as T;
    const v = deepFreeze(fn(events));
    if (kept) this.memos.set(key, v);
    return v;
  }

  private foldOf<S>(events: StoredEvent[], key: string, init: () => S, step: (s: S, e: StoredEvent) => void): S {
    // WHY: the kept fold may be past an older snapshot's last event, or of another file (a reset): that one folds its own.
    if (events !== this.snap) {
      const s = init();
      for (const e of events) step(s, e);
      return s;
    }
    let f = this.folds.get(key) as { s: S; n: number } | undefined;
    if (!f) {
      f = { s: init(), n: 0 };
      this.folds.set(key, f);
    }
    try {
      for (; f.n < events.length; f.n++) step(f.s, events[f.n]!);
    } catch (e) {
      this.folds.delete(key);
      throw e;
    }
    return f.s;
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
    this.folds.clear();
  }
}

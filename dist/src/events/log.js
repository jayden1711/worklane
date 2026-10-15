// The append-only event log (SQLite via node:sqlite). Append-only is
// enforced by the database: triggers reject UPDATE and DELETE, so no code
// path can rewrite history. Payloads are validated and redacted on write.
import { groupOnly, groupOnlyDir } from '../os/index.js';
import { dirname } from 'node:path';
import { EventSchemas } from './types.js';
import { redact } from './redact.js';
import { stampNewLog } from '../migrations.js';
import { openWaiting } from './open.js';
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
/** SQLite's primary result codes for a write the storage refused (https://sqlite.org/rescode.html): SQLITE_IOERR, SQLITE_FULL. */
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;
/** Node's errno codes for the same, from a file write. */
const FS_FULL = new Set(['ENOSPC', 'EDQUOT']);
/**
 * Why a write failed because the storage refused it (the disk or quota is full, or an I/O error writing it), or null
 * for anything else. INVARIANT: only storage failures; a schema, constraint or programming error is null, so its
 * caller still throws.
 */
export function storageFailure(e) {
    if (!e || typeof e !== 'object')
        return null;
    const x = e;
    if (typeof x.code === 'string' && FS_FULL.has(x.code))
        return `${x.code}: ${String(x.message ?? '').slice(0, 200)}`;
    // WHY: a child process (git) that failed for the same reason says so only in its message.
    const said = typeof x.message === 'string' ? /No space left on device|Disk quota exceeded/.exec(x.message) : null;
    if (said)
        return said[0];
    if (x.code === 'ERR_SQLITE_ERROR' && typeof x.errcode === 'number') {
        // WHY: an extended code carries its primary one in the low byte (SQLITE_IOERR_WRITE is 778: 10 | 3 << 8).
        const primary = x.errcode & 0xff;
        if (primary === SQLITE_FULL || primary === SQLITE_IOERR)
            return `SQLite ${x.errcode}: ${String(x.errstr ?? x.message ?? '').slice(0, 200)}`;
    }
    return null;
}
/** At most this many events wait in memory while the log can't be written (EventLog's `buffer` option). */
export const BUFFER_MAX = 20_000;
export class EventLog {
    path;
    opts;
    db;
    listeners = new Set();
    /** Events the storage refused, oldest first, each with the time it happened: written by flush(). */
    pending = [];
    /** Events refused while the buffer was full: lost, and counted. */
    droppedCount = 0;
    failure = null;
    failureListeners = new Set();
    constructor(path, opts = {}) {
        this.path = path;
        this.opts = opts;
        if (path !== ':memory:')
            groupOnlyDir(dirname(path));
        // The lock wait is set before any statement, journal_mode's included (src/events/open.ts).
        this.db = openWaiting(path);
        if (path !== ':memory:')
            groupOnly(path);
        this.db.exec('PRAGMA journal_mode = WAL');
        const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
        this.db.exec(SCHEMA);
        // A new log starts at the engine's state version; an existing one moves only through migrations.ts.
        if (fresh)
            stampNewLog(this.db);
        if (path !== ':memory:')
            groupOnly(path, `${path}-wal`, `${path}-shm`);
    }
    append(type, payload, actor, source = 'coordinator') {
        const parsed = EventSchemas[type].parse(payload);
        const clean = redact(parsed);
        const ts = new Date().toISOString();
        // INVARIANT: order is kept. Once one event waits, every later one waits behind it until flush() writes them all.
        if (this.pending.length) {
            // WHY: a caller's transaction claims something with this write (machine-requests.ts claim); held outside it, the
            // claim would hold nothing. It throws as the storage did, and the caller rolls back.
            if (this.inTransaction())
                throw new Error(`the event log can't be written (${this.failure?.reason ?? 'the storage refused it'}); ${this.pending.length} events wait in memory`);
            return this.hold({ id: 0, ts, type, actor, source, payload: clean });
        }
        let r;
        try {
            r = this.insert(ts, type, actor, source, clean);
        }
        catch (err) {
            const why = storageFailure(err);
            // WHY: inside a caller's transaction the caller rolls back and answers; a buffered event would land outside it.
            if (!why || !this.opts.buffer || this.inTransaction())
                throw err;
            // WHY: kept first, then said: whoever listens (the disk guard) sees it waiting.
            const held = this.hold({ id: 0, ts, type, actor, source, payload: clean });
            this.failed(why);
            return held;
        }
        const e = { id: Number(r.lastInsertRowid), ts, type, actor, source, payload: clean };
        for (const l of this.listeners)
            l(e);
        return e;
    }
    /** Whether a caller's transaction is open on this connection (isTransaction, from Node 22.16; asked of SQLite before). */
    inTransaction() {
        const known = this.db.isTransaction;
        if (typeof known === 'boolean')
            return known;
        try {
            this.db.exec('BEGIN');
        }
        catch {
            return true; // "cannot start a transaction within a transaction"
        }
        this.db.exec('ROLLBACK');
        return false;
    }
    insert(ts, type, actor, source, payload) {
        return this.db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(ts, type, actor, source, JSON.stringify(payload));
    }
    /**
     * Keep an event the storage refused, with a provisional id: the next after the log's last (or the last kept), the id
     * it gets when written unless another process writes first (on a full disk, none can). INVARIANT: ids keep rising,
     * so code that compares them (an event after another) reads the kept events as it will read them once written.
     */
    hold(e) {
        if (this.pending.length >= (this.opts.buffer?.max ?? BUFFER_MAX)) {
            this.droppedCount++;
            return { ...e, id: 0 };
        }
        const held = { ...e, id: (this.pending.at(-1)?.id ?? this.lastId()) + 1 };
        this.pending.push(held);
        return held;
    }
    failed(reason) {
        this.failure = { at: new Date().toISOString(), reason };
        for (const l of this.failureListeners)
            l(this.failure);
    }
    /** Events waiting in memory to be written (the storage refused them), and those lost because the buffer was full. */
    buffered() {
        return { count: this.pending.length, dropped: this.droppedCount, failure: this.failure };
    }
    /** Called on each write the storage refuses (the first, and each failed flush). */
    onWriteFailure(fn) {
        this.failureListeners.add(fn);
        return () => this.failureListeners.delete(fn);
    }
    /**
     * Write the waiting events, in order, in one transaction: all of them or none. Returns how many were written, or
     * why none could be (the storage still refuses). Anything other than a storage failure throws.
     */
    flush() {
        if (!this.pending.length)
            return { written: 0, error: null };
        const out = [];
        try {
            this.db.exec('BEGIN IMMEDIATE');
            for (const e of this.pending)
                out.push({ ...e, id: Number(this.insert(e.ts, e.type, e.actor, e.source, e.payload).lastInsertRowid) });
            this.db.exec('COMMIT');
        }
        catch (err) {
            try {
                if (this.inTransaction())
                    this.db.exec('ROLLBACK');
            }
            catch {
                // WHY: nothing to roll back: SQLite rolled it back already
            }
            const why = storageFailure(err);
            if (!why)
                throw err;
            this.failed(why);
            return { written: 0, error: why };
        }
        this.pending = [];
        this.failure = null;
        for (const e of out)
            for (const l of this.listeners)
                l(e);
        return { written: out.length, error: null };
    }
    /**
     * Events after `afterId`, optionally of some types, ending with the events waiting to be written (provisional ids),
     * so what the coordinator decides from the log counts them: a report already posted is not posted again while the
     * disk is full.
     */
    read(afterId = 0, types) {
        const stored = this.readStored(afterId, types);
        if (!this.pending.length)
            return stored;
        return [...stored, ...this.pending.filter((e) => e.id > afterId && (!types?.length || types.includes(e.type)))];
    }
    readStored(afterId, types) {
        const rows = (types?.length
            ? this.db.prepare(`SELECT * FROM events WHERE id > ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id`).all(afterId, ...types)
            : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(afterId));
        return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    }
    lastId() {
        const r = this.db.prepare('SELECT MAX(id) AS id FROM events').get();
        return r.id ?? 0;
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=log.js.map
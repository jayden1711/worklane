// The one way to open an events database for writing: the lock wait is set before any other statement runs.
import { DatabaseSync } from 'node:sqlite';
import { BUSY_TIMEOUT_MS } from './read-only.js';
/**
 * An events database opened read-write, waiting out another connection's lock (BUSY_TIMEOUT_MS). The caller closes it.
 * WHY: a busy timeout set after the first statement is no wait for that statement. `PRAGMA journal_mode = WAL` ran
 * first and failed at once with "database is locked" when another process's close was checkpointing: the local
 * coordinator's service then exited 2 at start (the first-run page's Start writes its audit as the unit starts).
 */
export function openWaiting(path) {
    const db = new DatabaseSync(path);
    try {
        db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    catch (e) {
        db.close();
        throw e;
    }
    return db;
}
//# sourceMappingURL=open.js.map
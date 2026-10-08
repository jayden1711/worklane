// Backups of the event log. Success is reported only after reading the copy
// back: its checksum must match the snapshot and its latest event id must
// equal the log's. An exit code or "write returned" is never proof.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** Latest event id in a database image, read through a fresh read-only connection. */
function lastIdOf(bytes) {
    const dir = join(tmpdir(), `verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'check.db');
    try {
        writeFileSync(path, bytes);
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            const r = db.prepare('SELECT MAX(id) AS id FROM events').get();
            return r.id ?? 0;
        }
        finally {
            db.close();
        }
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export async function backup(log, store, now = new Date()) {
    const lastId = log.lastId();
    const key = `events-${now.toISOString().replace(/[:.]/g, '-')}-${lastId}.db`;
    const dir = join(tmpdir(), `snap-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const snapPath = join(dir, 'snap.db');
    try {
        log.db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
        const bytes = readFileSync(snapPath);
        const hash = sha256(bytes);
        const snapId = lastIdOf(bytes);
        if (snapId < lastId)
            return { ok: false, key, lastId, sha256: hash, error: `snapshot holds events up to ${snapId}, log is at ${lastId}` };
        try {
            await store.put(key, bytes);
        }
        catch (e) {
            return { ok: false, key, lastId, sha256: hash, error: `${store.name}: write failed: ${e.message}` };
        }
        const back = await store.get(key).catch((e) => {
            throw new Error(`${store.name}: read-back failed: ${e.message}`);
        });
        if (!back)
            return { ok: false, key, lastId, sha256: hash, error: `${store.name}: read-back found nothing at ${key}` };
        if (sha256(back) !== hash)
            return { ok: false, key, lastId, sha256: hash, error: `${store.name}: read-back checksum mismatch` };
        const backId = lastIdOf(back);
        if (backId !== snapId)
            return { ok: false, key, lastId, sha256: hash, error: `${store.name}: read-back holds events up to ${backId}, expected ${snapId}` };
        return { ok: true, key, lastId: snapId, sha256: hash };
    }
    catch (e) {
        return { ok: false, key, lastId, sha256: '', error: e.message };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** A directory store (local disk, a mounted drive, a synced folder). */
export function dirStore(root) {
    return {
        name: `dir:${root}`,
        async put(key, data) {
            mkdirSync(root, { recursive: true });
            writeFileSync(join(root, key), data);
        },
        async get(key) {
            try {
                return readFileSync(join(root, key));
            }
            catch {
                return null;
            }
        },
    };
}
//# sourceMappingURL=backup.js.map
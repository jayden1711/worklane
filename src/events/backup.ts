// Backups of the event log. Success is reported only after reading the copy
// back: its checksum must match the snapshot and its latest event id must
// equal the log's. An exit code or "write returned" is never proof.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { groupOnlyDir, writeGroupOnly } from '../os/index.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { EventLog } from './log.js';

/** Where backups go. `put` stores bytes; `get` reads them back independently. */
export interface BackupStore {
  name: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export interface BackupResult {
  ok: boolean;
  key: string;
  lastId: number;
  sha256: string;
  error?: string;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Latest event id in a database image, read through a fresh read-only connection. */
function lastIdOf(bytes: Buffer): number {
  const dir = join(tmpdir(), `verify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'check.db');
  try {
    writeFileSync(path, bytes);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const r = db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null };
      return r.id ?? 0;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function backup(log: EventLog, store: BackupStore, now = new Date()): Promise<BackupResult> {
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
    if (snapId < lastId) return { ok: false, key, lastId, sha256: hash, error: `snapshot holds events up to ${snapId}, log is at ${lastId}` };
    try {
      await store.put(key, bytes);
    } catch (e) {
      return { ok: false, key, lastId, sha256: hash, error: `${store.name}: write failed: ${(e as Error).message}` };
    }
    const back = await store.get(key).catch((e: Error) => {
      throw new Error(`${store.name}: read-back failed: ${e.message}`);
    });
    if (!back) return { ok: false, key, lastId, sha256: hash, error: `${store.name}: read-back found nothing at ${key}` };
    if (sha256(back) !== hash) return { ok: false, key, lastId, sha256: hash, error: `${store.name}: read-back checksum mismatch` };
    const backId = lastIdOf(back);
    if (backId !== snapId) return { ok: false, key, lastId, sha256: hash, error: `${store.name}: read-back holds events up to ${backId}, expected ${snapId}` };
    return { ok: true, key, lastId: snapId, sha256: hash };
  } catch (e) {
    return { ok: false, key, lastId, sha256: '', error: (e as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A directory store (local disk, a mounted drive, a synced folder). */
export function dirStore(root: string): BackupStore {
  return {
    name: `dir:${root}`,
    async put(key, data) {
      groupOnlyDir(root);
      writeGroupOnly(join(root, key), data);
    },
    async get(key) {
      try {
        return readFileSync(join(root, key));
      } catch {
        return null;
      }
    },
  };
}

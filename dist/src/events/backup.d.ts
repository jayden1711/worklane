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
export declare function backup(log: EventLog, store: BackupStore, now?: Date): Promise<BackupResult>;
/** A directory store (local disk, a mounted drive, a synced folder). */
export declare function dirStore(root: string): BackupStore;

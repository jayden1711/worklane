import { type Lock, type LockInfo } from './locks.js';
export declare const DEFAULT_MAX_AGENTS = 2;
export declare function machineCap(dir?: string): number;
/** Take a free agent slot, or null if the machine is at its cap. */
export declare function tryAgentSlot(owner: string, dir?: string): Lock | null;
export declare function fullRunLock(owner: string, waitMs: number, dir?: string): Promise<{
    lock: Lock;
} | {
    holder: LockInfo | null;
}>;
export interface SlotStatus {
    cap: number;
    agents: (LockInfo & {
        slot: string;
    })[];
    fullRun: LockInfo | null;
}
/** Live holders only; stale files (dead pids) don't count. */
export declare function slotStatus(dir?: string): SlotStatus;

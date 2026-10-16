import { type Lock, type LockInfo } from './locks.js';
export declare const DEFAULT_MAX_AGENTS = 2;
export declare function machineCap(dir?: string): number;
/**
 * Take an agent slot if fewer than the cap are running, machine-wide, across
 * every instance and harness. Counting and taking happen under one directory
 * lock, so two processes can't both see room for the last slot.
 */
export declare function tryAgentSlot(owner: string, dir?: string): Lock | null;
/**
 * Take the machine's full-run lock, waiting up to waitMs. Never while the updater drains the machine
 * (src/update-drain.ts): the drain is checked before every try, and a wait that ends inside one says so as its holder.
 */
export declare function fullRunLock(owner: string, waitMs: number, dir?: string, pollMs?: number): Promise<{
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
export interface EmergencyStop {
    by: string;
    at: string;
    reason: string;
}
/** The emergency stop in force on this machine, if any. */
export declare function emergencyStop(dir?: string): EmergencyStop | null;
/** Halt every agent on the machine, across instances and harnesses, until resumed. */
export declare function stopAll(by: string, reason: string, dir?: string): void;
export declare function resumeAll(dir?: string): boolean;

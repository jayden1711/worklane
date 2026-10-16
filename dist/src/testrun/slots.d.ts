import { type Lock, type LockInfo } from '../locks.js';
import { TEST_SLOTS_MAX, TEST_SLOTS_MIN } from '../machine.js';
export { TEST_SLOTS_MAX, TEST_SLOTS_MIN };
/** Without a setting: two runs, the recommendation for a 24-core, 30 GB machine with three instances and six agents. */
export declare const DEFAULT_TEST_SLOTS = 2;
export declare function testSlotCap(dir?: string): number;
/** The live test-run slots (dead holders don't count). */
export declare function testSlotsHeld(dir?: string): (LockInfo & {
    slot: string;
})[];
/**
 * Take a test slot if fewer than the cap are held and the engine updater isn't draining the machine (src/update-drain.ts),
 * counting and taking under the slot directory's lock. `limitMs`: the longest the run can take holding it, recorded in
 * the slot for the updater's drain to say when the machine will be quiet.
 */
export declare function tryTestSlot(owner: string, dir?: string, limitMs?: number): Lock | null;
/** Wait for a test slot (and for any update drain to end), however long it takes; rejects only when `signal` aborts. */
export declare function waitTestSlot(owner: string, o?: {
    dir?: string;
    pollMs?: number;
    signal?: AbortSignal;
    limitMs?: number;
}): Promise<Lock>;
export interface Capacity {
    cores: number;
    memGb: number;
    /** Each instance unit's MemoryMax, GB: what the instances may take. */
    instanceCapsGb: number[];
    /** The machine's agent slots, each taking about `agentCores` cores. */
    agentSlots: number;
    agentCores?: number;
    /** What one test run takes: its test workers' cores, and its peak memory with its database (measured or estimated). */
    perRun: {
        cores: number;
        memGb: number;
    };
    /** Kept back for the system and the coordinators. */
    reserve?: {
        cores: number;
        memGb: number;
    };
}
/**
 * The test slots this machine can afford: the cores left after the agents, and the memory left after the
 * instances' caps, each divided by what one run takes; the smaller, within 1..TEST_SLOTS_MAX.
 */
export declare function recommendTestSlots(c: Capacity): {
    slots: number;
    byCpu: number;
    byMemory: number;
    freeCores: number;
    freeMemGb: number;
};

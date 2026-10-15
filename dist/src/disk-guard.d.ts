import type { EventLog } from './events/log.js';
/** Where the sandbox keeps test runs' workspaces and stores (scripts/setup/test-user.sh). */
export declare const TEST_RUN_BASE: string;
/** The default floor: the larger of this many GiB and this share of the filesystem, free. */
export declare const FLOOR_GB = 10;
export declare const FLOOR_PCT = 5;
export declare const DISK_INCIDENT = "disk_full";
/** The first retry of the kept events, and the longest wait between retries. */
export declare const RETRY_MIN_MS = 5000;
export declare const RETRY_MAX_MS = 60000;
export interface Floor {
    gb: number;
    pct: number;
}
/** The bytes a filesystem of `totalBytes` must keep free. */
export declare const floorBytes: (f: Floor, totalBytes: number) => number;
export interface DiskGuardDeps {
    log: EventLog;
    instance: string;
    /** The filesystems to watch, by a path on each: the instance's state dir, the test runs' base. One not there is skipped. */
    paths: string[];
    floor: () => Floor;
    /** Free and total bytes of the filesystem holding `path`; null when it can't be measured (tests inject this). */
    free?: (path: string) => {
        freeBytes: number;
        totalBytes: number;
    } | null;
    /** The incident store's directory, when incidents are raised (an instance's coordinator); absent: the journal only. */
    incidents?: {
        dir?: string;
    };
    /** Runs in flight now, for the incident's detail. */
    inFlight?: () => number | undefined;
    /** A journal line (stderr under the service manager). */
    say?: (line: string) => void;
    now?: () => number;
}
interface Low {
    path: string;
    freeBytes: number;
    totalBytes: number;
    floor: number;
}
export declare class DiskGuard {
    private d;
    private nextRetryAt;
    private wait;
    /** The incident's severity as the store has it from here (null: none open; undefined: not known yet, at start). */
    private stored;
    private storedAt;
    private reportedDropped;
    private saidFull;
    private readonly off;
    constructor(d: DiskGuardDeps);
    private get now();
    private say;
    /** The watched filesystems below the floor now. */
    low(): Low[];
    /**
     * Why no new work may start now (a test run, an agent run, a batch), or null. INVARIANT: null only while no event
     * waits to be written and every watched filesystem is above the floor.
     */
    held(): string | null;
    private writeFailed;
    /** One pass: write the kept events again (with backoff), and bring the incident in line. Never throws on a full disk. */
    step(): void;
    /** Raise, update or resolve the incident as things are now; one the store refuses waits for a later step. */
    private sync;
    stop(): void;
}
/**
 * The guard for a coordinator's site: its state dir, and the test runs' base when it runs test runs. INVARIANT: the
 * incident names the instance by its name, as the Health page and the watchdog filter on it, never the process's
 * user@host id; a site with no instance (local mode) says it in the journal only.
 */
export declare function siteDiskGuard(o: {
    log: EventLog;
    stateDir: string;
    testRuns: boolean;
    instance: string | null;
    actor: string;
    floor: () => Floor;
    inFlight?: () => number | undefined;
    incidentsDir?: string;
    say?: (line: string) => void;
}): DiskGuard;
/** Run a guard's step on its own timer until stopped; a failure that isn't the disk's is said in the journal, and the next step tries again. */
export declare function startDiskGuard(g: DiskGuard, everyMs?: number, say?: (line: string) => void): () => void;
export {};

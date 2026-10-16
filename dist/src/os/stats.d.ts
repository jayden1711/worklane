export interface MemoryStats {
    totalBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
}
export interface UnitStats {
    unit: string;
    /** Bytes in use now; null when systemd doesn't account it (or the unit isn't running). */
    memoryCurrent: number | null;
    /** The unit's memory limit; null for none (infinity). */
    memoryMax: number | null;
    memorySwapCurrent: number | null;
    /** CPU time used since the unit started, in ns. */
    cpuUsageNSec: number | null;
    /** active, inactive, failed, ... */
    activeState: string | null;
}
export interface DiskStats {
    path: string;
    freeBytes: number;
    totalBytes: number;
}
export interface MachineStats {
    at: string;
    platform: string;
    memory: MemoryStats | null;
    /** 1, 5 and 15 minute load averages. */
    load: [number, number, number] | null;
    units: (UnitStats | {
        unit: string;
        error: string;
    })[] | null;
    disks: (DiskStats | {
        path: string;
        error: string;
    })[];
    /** What couldn't be read, and why. */
    unavailable: string[];
}
/** /proc/meminfo: the four values that matter, in bytes; null if any is missing. */
export declare function parseMeminfo(text: string): MemoryStats | null;
/** /proc/loadavg: the 1, 5 and 15 minute averages; null if malformed. */
export declare function parseLoadavg(text: string): [number, number, number] | null;
/** `systemctl show -p ...` output (KEY=VALUE lines) for one unit. "[not set]" and "infinity" are null. */
export declare function parseSystemctlShow(unit: string, text: string): UnitStats;
export interface StatsDeps {
    platform?: string;
    readFile?: (path: string) => string;
    /** Runs a command, returns its stdout; throws on failure. */
    exec?: (file: string, args: string[]) => string;
    statfs?: (path: string) => {
        blocks: number;
        bsize: number;
        bavail: number;
    };
    now?: () => Date;
}
/** Machine stats for these service units and paths. Never throws. */
export declare function machineStats(o?: {
    units?: string[];
    paths?: string[];
}, d?: StatsDeps): MachineStats;
/** What one agent run's processes (its process group) use right now: resident memory, CPU time so far, how many. */
export interface ProcessGroupUsage {
    rssBytes: number;
    cpuSeconds: number;
    processes: number;
}
/**
 * One /proc/<pid>/stat line: its process group, CPU ticks (user + system) and resident pages. The command name
 * (field 2) may hold spaces and parentheses, so the fields are counted from the last ')'. Null if malformed.
 */
export declare function parseProcStat(text: string): {
    pgrp: number;
    ticks: number;
    rssPages: number;
} | null;
/**
 * What each of these process groups uses now, from one pass over /proc (Linux; elsewhere, and for a group with no
 * readable process, nothing: not measured). An agent run starts in a process group of its own (run.started's pgid),
 * so a group is one run with everything it spawned. Never throws.
 */
export declare function processGroupUsage(pgids: number[], d?: Pick<StatsDeps, 'platform' | 'readFile'> & {
    list?: () => string[];
}): Map<number, ProcessGroupUsage>;
/** A service unit's run state, for the watchdog: whether it is up, and how often its manager restarted it. */
export interface UnitState {
    unit: string;
    /** systemd's LoadState: not-found means no such unit on this machine. */
    loadState: string | null;
    /** active, activating, failed, inactive, ... */
    activeState: string | null;
    /** running, auto-restart, dead, ... */
    subState: string | null;
    /** Restarts the manager made since the unit was last started by hand; null when not reported. */
    restarts: number | null;
}
/** `systemctl show -p LoadState,ActiveState,SubState,NRestarts` output for one unit. */
export declare function parseUnitState(unit: string, text: string): UnitState;
/**
 * These units' run states (Linux, systemd; an unprivileged `systemctl show` reads them). Null where units aren't
 * measured (other platforms): the caller then knows nothing, rather than that every unit is down. A unit that
 * couldn't be read is left out. Never throws.
 */
export declare function unitStates(units: string[], d?: Pick<StatsDeps, 'platform' | 'exec'>): UnitState[] | null;

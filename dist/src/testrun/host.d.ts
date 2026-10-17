import type { Readable } from 'node:stream';
import { type GpuGrant } from './gpu.js';
import { type NetworkGrant } from './network.js';
import { type Fetcher } from './fetch.js';
export declare const SANDBOX_HELPER: string;
/** The label on every container a run starts: wipe removes whatever carries its run's. */
export declare const RUN_LABEL: string;
export interface ExecResult {
    /** null: it timed out or was cancelled. */
    code: number | null;
    out: string;
    /** What the command used, where the host can tell (the sandbox's unit reports it). */
    stats?: SystemdRunStats;
    /** Its stderr alone (the sandbox's systemd-run lines taken out): what a failed setup step's check shows. */
    err?: string;
    /**
     * It was stopped at its own timeout: the sandbox's unit at its RuntimeMaxSec (systemd-run's "Finished with result:
     * timeout"; its exit code is then non-zero, not null), or the host's own timer. Never for a cancellation.
     */
    timedOut?: boolean;
    /** The sandbox unit's result as systemd-run's summary gives it ("success", "exit-code", "timeout", "signal", ...). */
    unitResult?: string | null;
    /** Only for a command that asked for the GPU: what the helper granted (./gpu.ts), or null when it said nothing. */
    gpu?: GpuGrant | null;
    /** Only for a command that asked for the network: what the helper granted (./network.ts), or null when it said nothing. */
    network?: NetworkGrant | null;
}
/** What a command asks of its host besides its environment. */
export interface ExecOptions {
    /** Ask for the GPU (a tier's `gpu: true`): granted only as root's file says (./gpu.ts). */
    gpu?: boolean;
    /**
     * Ask for the network for this tier (a tier's `network: true`, or "setup" for the setup steps): granted only when
     * root's file lists that tier for this instance (./network.ts). Absent: the command has no network.
     */
    network?: string;
}
/**
 * A setup step of a run (its workspace, a cache, its database) failed. `step` names it; `stderr` is the end of what
 * the helper or tool said on stderr, never its stdout (db-start prints the database's password there on success).
 */
export declare class SetupStepError extends Error {
    readonly step: string;
    /** What failed and its exit, in a line (the message adds the stderr's last lines). */
    readonly what: string;
    readonly stderr: string;
    constructor(step: string, 
    /** What failed and its exit, in a line (the message adds the stderr's last lines). */
    what: string, stderr: string);
}
/** Seconds from systemd's format_timespan: "0", "44ms", "1.234s", "1min 2.345s", "2h 3min 4s". null: not that format. */
export declare function parseTimespan(s: string): number | null;
/** MiB from systemd's format_bytes (IEC, one digit below the point, a trailing B below 1K): "0B", "512B", "256.0K", "1.5G". */
export declare function parseBytes(s: string): number | null;
export interface SystemdRunStats {
    cpuS: number | null;
    memPeakMb: number | null;
}
/** A run's variables as the sandbox helper's exec reads them on stdin: NAME=value, each ended by a NUL. */
export declare function runVars(env: Record<string, string>): string;
/**
 * systemd-run --wait's own lines in its stderr (not --quiet; the run's stderr is the same stream under --pipe):
 * "Running as unit: <unit>" near the start (with "; invocation ID: <id>" on some systemd 255 builds, not others), and its summary (result, CPU time, peak memory, ...)
 * at the very end, after the unit has stopped, so nothing a run prints can come after it. Only that final block is
 * read: a run's own "Memory peak: 999G" line is part of its output, never a stat. `own`: the [start, end) ranges of
 * `stderr` that are systemd-run's.
 */
export declare function systemdRunStats(stderr: string): {
    stats: SystemdRunStats;
    own: Array<[number, number]>;
    result: string | null;
};
/** What a run's Postgres is started with (test_run.database). */
export interface RunDbSpec {
    image: string;
    name: string;
    readyS: number;
    /** Postgres's max_connections (`-c max_connections=<n>`), within MAX_CONNECTIONS. */
    maxConnections: number;
}
export interface RunDatabase {
    url: string;
    /** The sandbox's: the directory of the database's Unix socket (it has no network, so no port). */
    socketDir?: string;
    /** The local host's: its port on 127.0.0.1. */
    port?: number;
    container: string;
}
export interface BundleRefs {
    branch: string;
    head: string;
    base: string;
    /** The commit to check out and the default branch's tip, in full (the bundle may carry neither: the store has them). */
    headSha: string;
    baseSha: string;
    /** Directories left out of the checkout (tests.yaml checkout.sparse_exclude); none for a full one. */
    exclude: readonly string[];
}
export interface RunHost {
    readonly kind: 'sandbox' | 'local';
    /**
     * A new run's workspace (./workspace.ts): the store takes what the bundle stream carries (the commit as `refs.head`,
     * the default branch as `refs.base`, either or both left out when the store has it), then a repo of the run's own
     * reads the store, with `refs.headSha` checked out (leaving `refs.exclude` out) and `refs.baseSha` as `refs.branch`
     * and origin/`refs.branch`.
     */
    create(id: string, bundle: Readable, refs: BundleRefs): Promise<{
        workdir: string;
    }>;
    /** The commits the instance's object store keeps (its tips), so a bundle can leave out what they reach. */
    storeTips(): Promise<string[]>;
    /** The change's paths, one per line, in a file of the run's (for {changed_files}). */
    changedFiles(id: string, files: readonly string[]): Promise<string>;
    /** A cache's directory for this key (made if new). */
    cache(name: string, key: string): Promise<string>;
    /** A directory every run of the instance shares (e.g. a test-port registry); no wipe removes it. */
    shared(name: string): Promise<string>;
    /** The run's own Postgres: a unique container, reached on its Unix socket (the sandbox's has no network). */
    startDb(id: string, db: RunDbSpec): Promise<RunDatabase>;
    /**
     * The fetch phase (./fetch.ts): what the run's lockfile pins, downloaded into cache `cache` (key `key`) with network,
     * running none of the repo's code. Its output and exit as a setup step's.
     */
    fetch(id: string, fetcher: Fetcher, cache: string, key: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult>;
    /**
     * Run a command in the workspace with exactly `env` (and the host's fixed PATH, HOME, TMPDIR, CI). With `o.gpu`, the
     * sandbox helper may grant the GPU; a wait for it counts against `timeoutMs`.
     */
    exec(id: string, command: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal, o?: ExecOptions): Promise<ExecResult>;
    /** The sandbox's own boundary check; a check that can't run is not ok. */
    check(): Promise<{
        ok: boolean;
        detail: string;
    }>;
    /** Remove everything of the run: its processes, containers, volumes and files. `left`: what is still there. */
    wipe(id: string): Promise<{
        ok: boolean;
        left: string[];
    }>;
    /** The helper's protocol version (./helper.ts); null when it has none or couldn't be asked, with its stderr. */
    helperVersion(): Promise<{
        version: number | null;
        stderr: string;
    }>;
}
export declare const RUN_ID: RegExp;
/** A new run id: the kind, the commit, and enough randomness that two runs of one commit never share one. */
export declare function newRunId(kind: 'fast' | 'full', sha: string): string;
/**
 * The URL of a database reached on its Unix socket: libpq, node-postgres and Prisma all take the socket's directory
 * as the `host` parameter (the socket is <dir>/.s.PGSQL.5432).
 */
export declare function postgresSocketUrl(dir: string, password: string, db: string): string;
/** The production host: every step through the sandbox helper, for instance `instance`'s test user. */
export declare function sandboxHost(instance: string, helper?: string, sudo?: string): RunHost;
/**
 * The unsandboxed host: the same steps as the current user under `base`, with `docker` from PATH (or the one
 * given). For the engine's tests and development only: nothing here keeps a run away from this user's files.
 */
export declare function localHost(base: string, o?: {
    docker?: string;
    path?: string;
}): RunHost;

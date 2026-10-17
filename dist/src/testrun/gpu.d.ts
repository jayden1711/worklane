import type { StoredEvent } from '../events/types.js';
export declare const GPU_FILE_NAME = "testrun-gpu.json";
/** Root's opt-in, as the engine reads it (under the test root in tests). */
export declare const gpuFilePath: () => string;
/** One GPU's lock: the sandbox helper holds it for each GPU command, and `<cli> gpu hold` for the owner's own jobs. */
export declare const gpuLockPath: (index: number) => string;
/** The oldest systemd the helper's GPU sandbox is proven on (CI's real-systemd job); below it a run gets no GPU. */
export declare const GPU_MIN_SYSTEMD = 255;
/** max_minutes: the longest one GPU command may run (the unit's RuntimeMaxSec is at most this), machine-wide. */
export declare const GPU_MAX_MINUTES: {
    readonly min: 1;
    readonly max: 120;
    readonly default: 20;
};
/** The root script that changes it, as a root shell runs it. */
export declare const GPU_SCRIPT: string;
export declare const gpuCommands: (instance: string) => {
    enable: string;
    disable: string;
    status: string;
    holder: string;
};
export interface GpuFile {
    maxMinutes: number;
    /** instance -> its GPUs' indices (/dev/nvidia<N>), in the file's order. */
    instances: Record<string, number[]>;
}
/** The file's text exactly as the script writes it (and the helper reads it): one instance a line. */
export declare function gpuFileText(f: GpuFile): string;
/** The file, or why it isn't one the helper reads: valid JSON in exactly the script's form, nothing more. */
export declare function parseGpuFile(text: string): GpuFile | {
    error: string;
};
/** What root's file says of one instance: on (its GPUs and the cap), off (and why), or unknown (it can't be read). */
export type GpuOptIn = {
    state: 'on';
    devices: number[];
    maxMinutes: number;
} | {
    state: 'off';
    why: string;
} | {
    state: 'unknown';
    why: string;
};
/**
 * Root's file as the helper would read it: root's, 0644, a regular file, in the script's form. A file the helper would
 * refuse is off (it grants nothing then); one this user can't read at all is unknown.
 */
export declare function readGpuFile(file?: string, rootUid?: number): GpuFile | {
    state: 'off' | 'unknown';
    why: string;
};
/** Root's file for `instance` (readGpuFile). */
export declare function gpuOptIn(instance: string, file?: string, rootUid?: number): GpuOptIn;
/** Every GPU any instance may use, ascending: what `<cli> gpu hold` locks unless told which. */
export declare function gpuIndices(f: GpuFile): number[];
/** Whether a run that asks for the GPU is planned as a GPU run: on, or a file that can't be read (never assume off). */
export declare const gpuPlanned: (o: GpuOptIn) => boolean;
/** What the helper said of a command that asked for the GPU. */
export type GpuGrant = {
    granted: true;
    indices: number[];
    devices: string[];
    maxS: number;
    waitedS: number;
    note: string;
} | {
    granted: false;
    why: string;
};
/**
 * The helper's GPU line: the very first line of an exec's stderr when it was given --gpu, before systemd-run's own
 * (nothing of the run's can come first). `own`: its [start, end) range, taken out of the run's output; a GPU still held
 * at the run's timeout stays in it (the check says who held it).
 */
export declare function gpuLine(stderr: string): {
    grant: GpuGrant | null;
    own: Array<[number, number]>;
};
/** A tier's GPU as its record and its check say it. */
export declare function gpuRecord(asked: boolean, g: GpuGrant | null): {
    granted: boolean;
    devices: string[];
    detail: string;
} | undefined;
/** The line a GPU tier's check starts with. */
export declare function gpuSummaryLine(r: {
    granted: boolean;
    devices: string[];
    detail: string;
}): string;
/**
 * A granted GPU command that didn't end by itself: stopped at its cap, killed (systemd's result), or cut off with no
 * exit. Our own cancel (a superseded head, a stopping coordinator) is not one. Such a run is never run again by itself.
 */
export declare function gpuStopped(g: GpuGrant | null, r: {
    code: number | null;
    timedOut?: boolean;
    unitResult?: string | null;
}, aborted: boolean): boolean;
/**
 * The GPU runs of `sha` (any, when null) that must never run again by themselves: planned as GPU runs and then cut
 * off (no testrun.finished, or one saying interrupted) or stopped (gpu_stopped). Their ids, oldest first.
 */
export declare function gpuRunsNotToRepeat(events: readonly StoredEvent[], sha?: string | null): string[];
/** What a GPU run that must not repeat says, for the record and the check. */
export declare const GPU_NO_REPEAT = "a GPU run that timed out, was killed or was cut off (the coordinator or the machine stopped) is never run again by itself: push a new commit to run it again";
/** The setup step a cut-off GPU run's posted check names (./checks.ts gives it its own title). */
export declare const GPU_STEP = "gpu";
/** What that check says: the run was cut off and is not run again by itself. */
export declare const gpuCutOffLine: (reason: string) => string;
/** The group whose members may hold a GPU's lock (`<cli> gpu hold`): the owner only, never an agent, test or coordinator user. */
export declare const GPU_GROUP: string;

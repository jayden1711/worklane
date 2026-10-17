import { type PushGuard } from './push-guard.js';
export interface PushLimits {
    max_file_mb: number;
    max_changed_lines: number;
    refuse_paths: string[];
}
export declare const DEFAULT_PUSH_LIMITS: PushLimits;
/** Every reason the range base..head may not be pushed; empty means it may. */
export declare function pushProblems(cwd: string, base: string, head: string, limits: PushLimits): string[];
export type PushResult = {
    ok: true;
} | {
    ok: false;
    refused: string[];
} | {
    ok: false;
    error: string;
};
/**
 * The only way the coordinator pushes code: the limits first, then the push.
 * `force` replaces the branch (a task branch the harness owns); `expect` updates
 * it only if the remote is still exactly at that commit (never over someone
 * else's push); with neither, the push succeeds only as a fast-forward.
 * `guard`: the default branch is never pushed (push-guard.ts), except as the direct land (land_mode direct); a push
 * to it is refused before anything else and recorded through the guard.
 */
export declare function checkedPush(o: {
    cwd: string;
    remote: string;
    base: string;
    head: string;
    ref: string;
    limits: PushLimits;
    guard: PushGuard;
    force?: boolean;
    expect?: string;
}): PushResult;

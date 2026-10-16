export interface HookInput {
    hook_event_name?: string;
    cwd?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    transcript_path?: string;
    stop_hook_active?: boolean;
    session_id?: string;
}
export interface HookOutput {
    stdout?: string;
    stderr?: string;
    exitCode: number;
}
export declare function findProjectRoot(start: string): string | null;
/** The `git commit` in a command line, if any, and whether it commits unstaged changes (-a). */
export declare function gitCommit(command: string): {
    all: boolean;
} | null;
/** How long the post-edit check may take; a slower check is ignored, never waited out. */
export declare const POST_EDIT_TIMEOUT_MS = 20000;
export declare function runHook(event: string, input: HookInput, env?: NodeJS.ProcessEnv, opts?: {
    postEditTimeoutMs?: number;
}): Promise<HookOutput>;
export declare function readStdin(): Promise<string>;

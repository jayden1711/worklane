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
export declare function runHook(event: string, input: HookInput, env?: NodeJS.ProcessEnv): Promise<HookOutput>;
export declare function readStdin(): Promise<string>;

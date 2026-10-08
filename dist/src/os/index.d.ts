export type OsKind = 'macos' | 'linux' | 'windows-wsl' | 'windows';
export type OsSetting = 'auto' | 'macos' | 'linux' | 'windows-wsl';
export declare function detectOs(setting?: OsSetting): OsKind;
/** Agents only run where Bash can be sandboxed; native Windows can't. */
export declare function canRunAgents(os: OsKind): boolean;
/** Machine-local state (event log, fingerprints, findings). Never inside a repo. */
export declare function stateDir(): string;
/** Full path of an executable on PATH, or null. */
export declare function which(cmd: string): string | null;
/** True if a process with this pid exists (signal 0 probes without killing). */
export declare function pidAlive(pid: number): boolean;
export declare function wslAvailable(): boolean;
export declare function homeDir(): string;
/** Spawn children in their own process group where the OS supports it, so a timeout kills the whole tree. */
export declare const spawnDetached: boolean;
export declare function killTree(pid: number | undefined, fallback: () => void): void;
/** Windows needs a shell to run npm's .cmd shims. */
export declare const shimsNeedShell: boolean;
/**
 * Environment for project commands the engine runs (checks, tests). Drops
 * variables that change how a nested runner behaves when the engine itself
 * runs under a test runner (node --test sets NODE_TEST_CONTEXT, which makes a
 * nested `node --test` report to the parent instead of exiting non-zero).
 */
export declare function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
/**
 * Machine-wide slot directory shared by every agent harness on the box (not
 * just this one), so the name is deliberately unbranded. Override with
 * AGENT_SLOTS_DIR. See docs/slots.md.
 */
export declare function slotsDir(): string;

export declare const RUNS_DIR = "runs";
/** Run records kept per state dir; the oldest go first. */
export declare const KEEP_RUNS = 500;
export interface RunStep {
    /** A shell command, or a file the agent wrote. */
    kind: 'command' | 'write';
    tool: string;
    what: string;
    status: 'ok' | 'error' | 'no result';
    /** The exit code, when the tool's output names one. */
    exitCode: number | null;
    output: string;
}
export interface RunRecord {
    v: 1;
    id: string;
    issue: number | null;
    role: string;
    model: string;
    startedAt: string;
    endedAt: string | null;
    reason: string | null;
    costUsd: number | null;
    turns: number | null;
    steps: RunStep[];
    /** Repo-relative where possible; each once, in the order first written. */
    files: string[];
    /** Tool calls that were neither commands nor writes (reads, searches): counted, not listed. */
    otherTools: number;
    /**
     * What the session looked at, repo-relative, each once: files it opened with Read and files a `git diff` or
     * `git show` named, each counted only once that call succeeded. Bounded; older records have none.
     */
    read?: string[];
    /** It ran a `git diff`/`git show` over a whole range with no path: every changed file's diff was shown. */
    diffedAll?: boolean;
    final: string;
    /** Some steps were dropped to keep the record bounded. */
    truncated: boolean;
    /** The longest run of byte-identical tool calls the stuck-run guard saw (absent: the guard was off, or no call repeated). */
    stuck?: {
        repeats: number;
        failures: number;
        tool: string;
        input: string;
    };
    /** The claude session this run was (absent: it reported none, or an older record): a later fix run resumes it. */
    sessionId?: string;
    /** The earlier session this run continued (claude --resume). */
    resumed?: string;
}
export type RunSummary = Pick<RunRecord, 'id' | 'issue' | 'role' | 'model' | 'startedAt' | 'endedAt' | 'reason' | 'costUsd' | 'turns' | 'files' | 'truncated'> & {
    commands: number;
    failedCommands: number;
};
/**
 * What a shell command showed of the repo's files through git: the paths after `--`, `rev:path` arguments, and
 * `all` for a diff or show of a range with no path (every changed file's diff). Each part of a compound command
 * (&&, ;, |) is read on its own. A listing of names or counts shows no contents and counts for nothing.
 */
export declare function gitDiffReads(command: string): {
    all: boolean;
    paths: string[];
};
/** The issue a run belongs to, from its worktree or task file (issue-<n>). */
export declare function runIssue(cwd: string, taskFile?: string): number | null;
export declare class RunRecorder {
    private stateDir;
    private rec;
    private pending;
    /** Reads waiting on their tool's result: a file counts as read only once the call that read it succeeded. */
    private pendingReads;
    private cwd;
    constructor(stateDir: string, o: {
        role: string;
        model: string;
        cwd: string;
        taskFile?: string;
        issue?: number;
        resumed?: string;
    }, now?: Date);
    get id(): string;
    /** One stream-json line from the agent's session. */
    line(j: unknown): void;
    /** Write the record when the run ends; keeps only the newest KEEP_RUNS. Never throws. */
    finish(end: {
        reason: string;
        costUsd: number;
        turns: number;
        model: string;
        final?: string;
        stuck?: RunRecord['stuck'];
        sessionId?: string;
    }, now?: Date): string | null;
    private noteRead;
    private relative;
}
/** One run's record, or null (unknown, or not a valid id: never a path outside the runs dir). */
export declare function readRun(stateDir: string, id: string): RunRecord | null;
/** An issue's runs, oldest first, without their steps. */
export declare function runsForIssue(stateDir: string, issue: number): RunSummary[];

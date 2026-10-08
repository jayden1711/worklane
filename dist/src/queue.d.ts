export interface Job {
    id: string;
    kind: 'full-run';
    cwd: string;
    command: string;
    idleProbe?: string | undefined;
    createdAt: string;
    status: 'queued' | 'waiting' | 'running' | 'passed' | 'failed' | 'error';
    runnerPid?: number;
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number | null;
    waitingFor?: string;
    log: string;
    error?: string;
    /** After the command: record main's baseline from its output, then remove the worktree it ran in. */
    after?: {
        baseline?: {
            eventsDb: string;
            sha: string;
            section: string;
            item: string;
            actor: string;
        };
        cleanup?: {
            repo: string;
            root: string;
            stateDir: string;
            name: string;
        };
    };
    result?: string;
}
export declare function readJob(stateDir: string, id: string): Job;
export declare function listJobs(stateDir: string): Job[];
/** Queue a job and start its detached runner. Returns immediately. */
export declare function queueJob(opts: {
    stateDir: string;
    cwd: string;
    command: string;
    idleProbe?: string | undefined;
    cliPath: string;
    after?: Job['after'];
}): Job;
/** The detached runner. Never "skips": it waits, runs, and records an outcome. */
export declare function runJob(stateDir: string, id: string, pollMs?: number): Promise<Job>;

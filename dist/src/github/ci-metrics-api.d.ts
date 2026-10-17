import type { CiCheckRun, CiMetricsApi } from '../ci-metrics.js';
type Fetch = typeof fetch;
/** A job log is read up to this many characters (its end, where a runner prints its results). */
export declare const JOB_LOG_CHARS = 20000000;
export declare class GitHubCiMetricsApi implements CiMetricsApi {
    private readonly repo;
    private readonly token;
    private readonly fetchImpl;
    private readonly api;
    constructor(repo: string, token: () => Promise<string>, fetchImpl?: Fetch, api?: string);
    private get;
    checkRuns(sha: string): Promise<CiCheckRun[]>;
    jobLog(id: number): Promise<string>;
}
export {};

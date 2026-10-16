import { type Role } from '../dashboard-auth.js';
import type { CheckRunAt, Compared, MainWatchApi, MergedPull, StatusAt } from '../main-watch.js';
type Fetch = typeof fetch;
export declare class GitHubMainWatchApi implements MainWatchApi {
    private readonly repo;
    private readonly token;
    private readonly fetchImpl;
    private readonly api;
    constructor(repo: string, token: () => Promise<string>, fetchImpl?: Fetch, api?: string);
    private get;
    private json;
    protection(branch: string): Promise<'enforced' | 'none'>;
    commitPulls(sha: string): Promise<MergedPull[]>;
    pull(n: number): Promise<MergedPull>;
    /** How far `head` is ahead of and behind `base` (one commit listed at most: only the counts are read). */
    compare(base: string, head: string): Promise<Compared>;
    checkRuns(sha: string): Promise<CheckRunAt[]>;
    statuses(sha: string): Promise<StatusAt[]>;
    role(login: string): Promise<Role | null>;
    /**
     * Who pushed `sha`: the actor of the branch's push (or force-push) that ended at it, from the repo's activity;
     * else the commit's GitHub author. Logins only (an email is never read). Null when neither answers.
     */
    pusher(branch: string, sha: string): Promise<{
        login: string;
        from: 'activity' | 'commit';
    } | null>;
}
export {};

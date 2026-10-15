import type { MergePostsApi, MergePull } from '../merge-posts.js';
type Fetch = typeof fetch;
export declare class GitHubMergePostsApi implements MergePostsApi {
    private readonly repo;
    private readonly token;
    private readonly fetchImpl;
    private readonly api;
    constructor(repo: string, token: () => Promise<string>, fetchImpl?: Fetch, api?: string);
    private json;
    commitPulls(sha: string): Promise<MergePull[]>;
    pull(n: number): Promise<MergePull>;
}
export {};

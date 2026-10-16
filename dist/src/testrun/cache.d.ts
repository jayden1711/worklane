import type { TestRunCache } from './config.js';
export declare function cacheKey(repo: string, sha: string, files: readonly string[]): string;
/** Each cache's variable -> its directory for this commit's key. */
export declare function cacheDirs(caches: readonly TestRunCache[], repo: string, sha: string, dir: (name: string, key: string) => Promise<string>): Promise<Record<string, string>>;

/** Each tool's cache variable, and its subdirectory in the instance's cache. */
export declare const CACHE_VARS: Record<string, string>;
/** An instance's cache directory: under its own root (beside its checkout), never anywhere shared. */
export declare function depCacheDir(instanceRoot: string): string;
/** The variables that point every supported tool at the instance's cache. */
export declare function depCacheEnv(cacheDir: string): Record<string, string>;
/**
 * Make the cache ready for the instance's agents: the directory and one per tool, owned by the coordinator,
 * group `gid` (the agents' shared group), 2770. Refuses a cache outside the instance's root.
 */
export declare function prepareDepCache(instanceRoot: string, gid: number): {
    dir: string;
    env: Record<string, string>;
};

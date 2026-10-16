/** The ecosystems with a built-in fetch. */
export declare const FETCHERS: readonly ["npm"];
export type Fetcher = (typeof FETCHERS)[number];
/** The variable a fetched npm cache must be given in, so the offline install step reads the same cache. */
export declare const NPM_CACHE_ENV = "npm_config_cache";
/** The helper's FETCH_NPM, run in the run's fetch directory (the workspace is ../work). */
export declare function npmFetchScript(): string;

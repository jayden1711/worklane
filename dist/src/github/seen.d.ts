/** A GitHub call made with `source`'s token was answered with a success (2xx). */
export declare function noteGitHubOk(source: object, at?: number): void;
/** When a call with `source`'s token last succeeded (ms), or null: none has in this process. */
export declare function githubOkAt(source: object): number | null;

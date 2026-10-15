export declare const GH_DEVICE_URL = "https://github.com/login/device";
/** What runs: the web (device) flow for github.com, git over https, so gh asks nothing else. */
export declare const GH_LOGIN_ARGS: readonly ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"];
/** How long a login waits for the person: GitHub's device codes last 15 minutes. */
export declare const GH_LOGIN_TIMEOUT_MS: number;
/** How often `gh auth status` is asked while waiting, at most (only when the page asks). */
export declare const GH_STATUS_EVERY_MS = 3000;
/** The child gh process, as this module uses it (tests stand in for it). */
export interface LoginChild {
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    on(event: 'close', cb: (code: number | null) => void): unknown;
    on(event: 'error', cb: (e: Error) => void): unknown;
    kill(): unknown;
}
export interface GhLoginDeps {
    /** Start `gh auth login --web ...`; its stdin is closed, so gh waits for no Enter. */
    spawn: () => LoginChild;
    /** `gh auth status`'s exit code: 0 when signed in to github.com. */
    status: () => number | null;
    /** Whether gh is installed at all. */
    installed: () => boolean;
    now: () => number;
    timeoutMs: number;
}
/** WHY: gh's login and status carry a GitHub token: no host-redirect variable reaches them (src/network.ts, #391). */
export declare const ghEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
export declare function systemGhLoginDeps(): GhLoginDeps;
export type GhLoginState = 'idle' | 'waiting' | 'done' | 'failed' | 'expired' | 'cancelled';
/** What the page sees. The code and URL only while waiting; never anything else gh printed. */
export interface GhLoginView {
    state: GhLoginState;
    /** The one-time device code to type on GitHub, once gh has shown it. */
    code: string | null;
    /** Always GitHub's device page when there is a code. */
    url: string | null;
    startedAt: string | null;
    expiresAt: string | null;
    /** Why it failed, one line; or what happened. */
    detail: string | null;
    /** gh is installed (the tools step); without it there is nothing to run. */
    installed: boolean;
}
/** One line of gh's failure output, masked: never a token, never more than a line. */
export declare function safeLine(text: string): string;
/** The relay: one login at a time, per dashboard. */
export declare class GhLogin {
    private child;
    private v;
    private lastStatus;
    private timer;
    private readonly d;
    constructor(deps?: Partial<GhLoginDeps>);
    view(): GhLoginView;
    /**
     * Where it stands, asking `gh auth status` (at most every few seconds) while a login waits: signed in counts as
     * done whichever way it happened, and the waiting gh is stopped.
     */
    poll(): GhLoginView;
    /** Start the device login. Refused while one waits, or when gh is missing or already signed in. */
    start(): GhLoginView;
    /** Stop a waiting login. */
    cancel(): GhLoginView;
    private finish;
}
export declare class GhLoginError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}

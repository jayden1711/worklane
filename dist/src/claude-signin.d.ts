import { type Ask, type Role } from './console/asks.js';
/** WHY: claude's login carries Anthropic credentials: no host-redirect variable reaches it (src/network.ts, #391). */
export declare const signinEnv: (relay: string | null, env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
/** How often a sign-in checks `claude auth status`, and how long it waits before giving up. */
export declare const SIGNIN_POLL_MS = 2000;
export declare const SIGNIN_TIMEOUT_MS: number;
/**
 * Whether a URL may be relayed: https on Anthropic's sign-in host, an OAuth authorize request whose redirect comes
 * back to localhost (Claude Code's own listener). INVARIANT: the paste-a-code URL (its redirect is Anthropic's
 * callback page) is refused, so nothing is ever pasted.
 */
export declare function relayableSigninUrl(raw: string): string | null;
export interface ClaudeStatus {
    loggedIn: boolean;
    method: string | null;
    /** The account's email as Claude Code's cached profile names it (see WHY above): shown as cached, never as current. */
    cachedAccount: string | null;
}
/** `claude auth status --json`'s answer, or null when it gave none. Never the token (the command doesn't print it). */
export declare function parseClaudeStatus(stdout: string): ClaudeStatus | null;
/** The running `claude auth login`, as the sign-in needs it. */
export interface SigninChild {
    kill(): void;
    onExit(fn: (code: number | null) => void): void;
}
export interface SigninDeps {
    /** Start `claude auth login` with this environment; its output goes nowhere. */
    login: (env: NodeJS.ProcessEnv) => SigninChild;
    status: () => Promise<ClaudeStatus | null>;
    relay: (dir: string, urlFile: string) => string | null;
    now: () => number;
    pollMs: number;
    timeoutMs: number;
}
export declare function systemSigninDeps(): SigninDeps;
export type SigninState = 'idle' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timed-out';
export interface SigninView {
    state: SigninState;
    /** Anthropic's sign-in page, while waiting (the owners only; null for anyone else, or before claude hands it over). */
    url: string | null;
    detail: string;
    startedAt: string | null;
    endedAt: string | null;
    /** What `claude auth status` said last: signed in, how, and the cached account (labelled cached on the page). */
    status: ClaudeStatus | null;
}
/** One `claude auth login` at a time, relayed and polled. Only ever local mode's (the dashboard checks). */
export declare class ClaudeSignin {
    private readonly d;
    /** Called once a sign-in ends, however it ended (the dashboard audits it). Never given the URL. */
    private readonly onEnd;
    private s;
    private child;
    private timer;
    private dir;
    private checking;
    constructor(d: SigninDeps, 
    /** Called once a sign-in ends, however it ended (the dashboard audits it). Never given the URL. */
    onEnd?: (state: SigninState, detail: string) => void);
    get running(): boolean;
    /** Start a sign-in. Throws when one is running already. */
    start(): void;
    cancel(why?: string): boolean;
    /** Read the relayed URL once it is there; then ask `claude auth status`. `exited`: claude auth login's exit code. */
    check(exited?: number | null): Promise<void>;
    private end;
    /** The view; the URL only for the instance's owners. */
    view(owner: boolean): SigninView;
}
/** Server mode's panel: the open paste box (add-project's claude-token ask) and what claude-account status last found. */
export interface ClaudeServerView {
    agentUser: string;
    /** add-project's open claude-token ask for this instance, when one is waiting: the page shows its paste box. */
    ask: (Ask & {
        canAnswer: boolean;
    }) | null;
    /** The agent user, as claude-account.sh status last found it (status.json); null when it hasn't run. */
    status: {
        at: string;
        loggedIn: boolean;
        method: string | null;
        cachedAccount: string | null;
        installedAt: string | null;
    } | null;
    /** The terminal's way: the same token, at a hidden prompt (for automation: on stdin). */
    command: string;
    /** The equivalent setup script, named on the screen and in the docs. */
    script: string;
}
export declare function claudeServerView(o: {
    instance: string;
    asks: readonly Ask[];
    role: Role | null;
    engineRoot: string;
    accountDir?: string;
}): ClaudeServerView;

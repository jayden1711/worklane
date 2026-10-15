import { type ChildProcess } from 'node:child_process';
export declare const sleep: (ms: number) => Promise<void>;
/**
 * How long the browser may take. The defaults suit a normal machine; a slow or loaded one (a shared CI runner)
 * scales them all with <PREFIX>_BROWSER_TIMEOUT_SCALE (1 to 20).
 */
export declare function browserTimeouts(env?: NodeJS.ProcessEnv): {
    /** Chrome started until its DevTools port and page are up (once more on a retry). */
    launchMs: number;
    /** One DevTools command (a navigation, a screenshot). */
    commandMs: number;
    /** A flow step waiting for its target or text. */
    stepMs: number;
    /** The DevTools WebSocket opening. */
    socketMs: number;
};
/** Record a process as running until stopTree sees it gone. */
export declare function track(p: ChildProcess, what: string): void;
/** What's still running (for tests: nothing may leak from one run into the next). */
export declare function liveProcesses(): {
    pid: number;
    what: string;
}[];
/** Poll `fn` until it returns something truthy, or fail after `ms` naming what was awaited (and the last error). */
export declare function until<T>(what: string, fn: () => T | Promise<T>, ms?: number, every?: number): Promise<NonNullable<T>>;
/** Chrome or Chromium on this machine: `given`, then the usual install places, then the PATH. null when there's none. */
export declare function findChrome(given?: string | null): string | null;
/** A free loopback port. */
export declare function freePort(): Promise<number>;
/** Whether something already listens on this loopback port. */
export declare function portInUse(port: number): Promise<boolean>;
type Params = Record<string, unknown>;
/** A minimal DevTools protocol client. */
export declare class Cdp {
    private ws;
    private next;
    private pending;
    private handlers;
    private constructor();
    static connect(url: string): Promise<Cdp>;
    /** A command, failing after `ms` if Chrome never answers (a hung browser must not hang its caller). */
    send<T = Params>(method: string, params?: Params, ms?: number): Promise<T>;
    on(method: string, fn: (p: Params) => void): void;
    close(): void;
}
export interface Browser {
    cdp: Cdp;
    proc: ChildProcess;
    /**
     * Stop Chrome (all its processes) and remove its profile. Never throws: a profile that can't be removed is
     * returned as a note, as cleanup is never a reason a check fails. Safe to call more than once.
     */
    close(): Promise<string | null>;
    /** What happened starting it (a start retried). */
    notes: string[];
}
/** Stop a process and everything in its group (Chrome's renderers, an app's children), and wait until it's gone. */
export declare function stopTree(p: ChildProcess, kill?: () => void): Promise<boolean>;
type LaunchOptions = {
    width?: number;
    height?: number;
    noSandbox?: boolean;
    extraArgs?: string[];
    profileRoot?: string;
    launchMs?: number;
};
/**
 * Start headless Chrome on a temporary profile and connect to its page. If its DevTools port never appears (a
 * loaded machine), it's stopped and started once more, and that is noted; any other failure, or a second
 * timeout, stops it and throws.
 */
export declare function launchChrome(chrome: string, o?: LaunchOptions): Promise<Browser>;
export {};

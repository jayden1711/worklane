/** WHY: one fixed URL per port, so a rerun prints exactly the same one. */
export declare const wizardUrl: (port: number) => string;
export type Probe = 'ours' | 'other' | 'none';
/** INVARIANT: the key goes in a header, never the URL; only a 200 with this checkout's key is 'ours'. */
export declare function probeDashboard(port: number, tokenFile: string, timeoutMs?: number): Promise<Probe>;
export interface DetachOptions {
    root: string;
    /** 0: any port (detachAnyPort), named in portFile by the dashboard itself. */
    port: number;
    portFile?: string;
    tokenFile: string;
    logFile: string;
    command: string[];
    waitMs?: number;
    /** WHY: tests stand in for the probe, the start and the clock. */
    probe?: (port: number, tokenFile: string) => Promise<Probe>;
    start?: (command: string[], logFile: string) => {
        pid: number | null;
        exited: () => number | null;
    };
    sleep?: (ms: number) => Promise<void>;
}
export interface Detached {
    url: string;
    started: boolean;
    pid?: number | null;
}
export declare class DetachError extends Error {
}
/** WHY: its own session, so the dashboard outlives the install command that started it. */
export declare function startDetached(command: string[], logFile: string): {
    pid: number | null;
    exited: () => number | null;
};
/**
 * The port a dashboard started with `--port 0` listens on, as it wrote it: a regular file of this user's, written by
 * nobody else (the probe sends the key to that port), holding one port number; else null.
 */
export declare function readDashboardPort(file: string): number | null;
/** Where a dashboard started with `--port-file` says which port it got: 0600, replaced in one rename. */
export declare function writeDashboardPort(file: string, port: number): void;
export declare function detachDashboard(o: DetachOptions): Promise<Detached>;
/** INVARIANT: the URL is the last line and the only one; the key's path is printed, never the key. */
export declare function detachedLines(d: Detached, o: {
    root: string;
    tokenFile: string;
    logFile: string;
}): string[];

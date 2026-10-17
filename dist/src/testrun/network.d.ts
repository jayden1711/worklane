export declare const NETWORK_FILE_NAME = "testrun-network.json";
/** Root's grants, as the engine reads them (under the test root in tests). */
export declare const networkFilePath: () => string;
/** The name the setup steps ask under: a tier can't be called this (./config.ts). */
export declare const SETUP_TIER = "setup";
/** The root script that changes it, as a root shell runs it. */
export declare const NETWORK_SCRIPT: string;
export declare const networkCommands: (instance: string) => {
    enable: string;
    disable: string;
    status: string;
};
export interface NetworkFile {
    /** instance -> the tiers granted the network, in the file's order. */
    instances: Record<string, string[]>;
}
export declare const NETWORK_TIER: RegExp;
/** The file's text exactly as the script writes it (and the helper reads it): one instance a line. */
export declare function networkFileText(f: NetworkFile): string;
/** The file, or why it isn't one the helper reads: valid JSON in exactly the script's form, nothing more. */
export declare function parseNetworkFile(text: string): NetworkFile | {
    error: string;
};
/** What root's file says of one instance: the tiers granted (maybe none), or unknown (it can't be read). */
export type NetworkPolicy = {
    state: 'on';
    tiers: string[];
} | {
    state: 'off';
    why: string;
} | {
    state: 'unknown';
    why: string;
};
/** Root's file for `instance`, as the helper would read it: a file it would refuse grants nothing (off). */
export declare function networkPolicy(instance: string, file?: string, rootUid?: number): NetworkPolicy;
/** What the helper said of a command that asked for the network. */
export type NetworkGrant = {
    granted: true;
    tier: string;
} | {
    granted: false;
    why: string;
};
/**
 * The helper's network line, which it prints only for a command that asked (exec --network): at `from` in the stderr
 * (right after any GPU line, before systemd-run's own). `own`: its [start, end) range, taken out of the run's output.
 */
export declare function networkLine(stderr: string, from?: number): {
    grant: NetworkGrant | null;
    own: Array<[number, number]>;
};
/** A tier's network as its record says it: none (the default, and any request not granted) or granted. */
export type NetworkRecord = {
    network: 'none' | 'granted';
    detail?: string;
};
export declare function networkRecord(asked: boolean, g: NetworkGrant | null): NetworkRecord;
/** The line a tier that asked for the network starts its check with. */
export declare function networkSummaryLine(r: NetworkRecord, instance: string, tier: string): string;

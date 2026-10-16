export interface Lane {
    /** Hosts sandboxed commands may reach (the sandbox's proxy checks each connection). */
    allowedDomains: string[];
}
export interface SandboxInput {
    lane: Lane;
    /** Paths no agent command may read: the coordinator's home, credential stores, other lanes' keys. */
    denyRead: string[];
}
/**
 * Settings passed to each agent run with --settings. Fail closed: if the
 * sandbox can't start (a missing dependency, an unsupported platform), the
 * run exits instead of running unsandboxed, and a blocked command can't be
 * retried outside the sandbox.
 */
export declare function sandboxSettings(s: SandboxInput): {
    sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        autoAllowBashIfSandboxed: boolean;
        network: {
            allowedDomains: string[];
        };
        filesystem: {
            denyRead: string[];
        };
    };
    permissions: {
        deny: string[];
    };
};
/** Credential stores in an agent user's home that its commands never need. */
export declare function homeCredentialStores(home: string): string[];
/** The hosts a run's settings let its commands reach (none when there are no settings). */
export declare function allowedDomainsOf(settings: unknown): string[];
/**
 * A copy of a run's settings that also denies these paths to its commands and to the Read tool (for one run; the
 * lane is unchanged). Settings with no sandbox get the Read rules only.
 */
export declare function withDeniedReads<T extends object>(settings: T, paths: readonly string[]): T;
/** A copy of a run's settings whose commands may also reach `hosts` (for one run; the lane is unchanged). */
export declare function withAllowedDomains<T extends object>(settings: T, hosts: string[]): T;

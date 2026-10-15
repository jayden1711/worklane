export declare const NETWORK_FILE: string;
/** Bounds on the file and its values. */
export declare const NETWORK_LIMITS: {
    readonly fileBytes: 4096;
    readonly proxy: 512;
    readonly noProxy: 1024;
    readonly caPath: 256;
    readonly caBytes: number;
    readonly caCerts: 64;
};
/** Whether `name` is a variable that redirects where a child sends its requests, or changes what TLS it trusts. */
export declare const isRedirectVar: (name: string) => boolean;
export declare const isRedirectGitKey: (key: string) => boolean;
/** The machine's outbound proxy, as network.json sets it. */
export interface MachineProxy {
    /** scheme://host[:port], as the children get it. */
    url: string;
    /** host[:port], for the Health page. */
    host: string;
    noProxy: string | null;
    file: string;
}
/** The machine's custom CA, as network.json names it. */
export interface MachineCa {
    path: string;
    /** How many certificates the file holds. */
    count: number;
    /** Each certificate's SHA-256 fingerprint, lowercase hex without separators. */
    fingerprints: string[];
}
export interface NetworkConfig {
    proxy: MachineProxy | null;
    ca: MachineCa | null;
    /** Why the file was refused; null when it's absent or fine. */
    error: string | null;
}
/** Why `raw` can't be the proxy URL, or null. */
export declare function proxyProblem(raw: unknown): string | null;
/** Why `raw` can't be the no_proxy list, or null. */
export declare function noProxyProblem(raw: unknown): string | null;
/** The CA file `raw` names, checked and parsed; or why it can't be used. */
export declare function readCaFile(raw: unknown, owner: number): {
    ca: MachineCa;
} | {
    error: string;
};
/**
 * The machine's network settings. No file is neither proxy nor CA, not an error. Refused (neither, and why): a file
 * anyone but root owns (`ownerUid`, 0 except in tests), one its group or others may write, a symlink, one too big,
 * not JSON, with an unknown key, a bad or credentialed proxy, or a CA file that fails readCaFile.
 */
export declare function readNetworkConfig(file?: string, o?: {
    ownerUid?: number;
}): NetworkConfig;
/**
 * Where the engine reads the machine's network settings. INVARIANT: the real file, root's; only a test points this
 * at another file (with its own uid as the owner), in its own process. Nothing reads it from an environment or config.
 */
export declare const machineNetwork: {
    file: string;
    ownerUid: number;
};
/** The machine's network settings, read now (a change applies to the next child, no restart). */
export declare const machineNetworkConfig: () => NetworkConfig;
/** The variables a valid custom CA sets: Node and claude add it to their bundle; Go (gh) and git read it as their CA file. */
export declare const CA_VARS: readonly ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "GIT_SSL_CAINFO"];
/**
 * `env` without any redirecting or trust-changing variable (isRedirectVar), git config key (isRedirectGitKey) or Node
 * TLS flag, then with the machine's proxy (both casings) and custom CA, when root set them. The same object.
 */
export declare function outboundEnv<T extends Record<string, string | undefined>>(env: T, net?: Pick<NetworkConfig, 'proxy' | 'ca'> | null): T;
/** What the Health page shows: the proxy and the CA from root's file, or why the file was refused; null when neither is set. */
export interface NetworkHealth {
    proxy: string | null;
    file: string;
    ca: {
        path: string;
        count: number;
        fingerprints: string[];
    } | null;
    error: string | null;
}
export declare function networkHealth(c?: NetworkConfig): NetworkHealth | null;

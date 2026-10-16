/** The variable that moves every system location under one directory (tests only; test/isolate.ts). */
export declare const SYSTEM_ROOT_VAR: string;
/** The test preload's per-run token: 64 hex characters, also written to TEST_MARK_FILE inside the root. */
export declare const TEST_TOKEN_VAR: string;
export declare const TEST_MARK_FILE = ".test-isolation";
/** Set by systemd in every process a unit starts (and inherited by its children). */
export declare const SYSTEMD_MARKERS: readonly ["INVOCATION_ID", "JOURNAL_STREAM"];
export declare class SystemRootRefused extends Error {
    name: string;
}
/**
 * Why <PREFIX>_SYSTEM_ROOT may not be honoured in this process, or null when it may (unset, or a test process the
 * preload marked). INVARIANT: an allowlist: only the preload's mark makes it honoured; root and systemd never.
 */
export declare function systemRootRefusal(env?: NodeJS.ProcessEnv, uid?: number | null): string | null;
/** `p` (an absolute system path) on this machine: itself, or under <PREFIX>_SYSTEM_ROOT when that is honoured here. */
export declare function systemPath(p: string): string;
/**
 * Why this command line may not run with <PREFIX>_SYSTEM_ROOT set at all, marked or not: the long-lived modes the
 * machine's units run (scripts/setup/service.sh, dashboards.sh, and `up`'s user units): `coordinator run` (one pass,
 * --once, is a command that ends, which tests run), an instance's dashboard (--instance … --service), the hub (--hub)
 * and its setup mode (--hub-setup). Null for any
 * other command. A checkout's dashboard (`dashboard --service --root <dir>`, which `dashboard --detach` starts in the
 * person's own session) is none: every unit's dashboard is an instance's (--instance) or the hub's.
 */
export declare function serviceModeRefusal(argv: string[], env?: NodeJS.ProcessEnv): string | null;
/** The roots below, as the real machine has them (the lint in test/isolate.test.ts looks for these in src/). */
export declare const SYSTEM_ROOTS: {
    readonly etc: "/etc/worklane";
    readonly varLib: "/var/lib/worklane";
    readonly libexec: "/usr/local/libexec";
    readonly opt: "/opt/worklane";
    readonly runLock: "/run/lock";
    readonly run: "/run/worklane";
    readonly units: "/etc/systemd/system";
    readonly varTmp: "/var/tmp";
};
/** /etc/<cli>/<name> */
export declare const etcPath: (name: string) => string;
/** /var/lib/<cli>/<name> */
export declare const varLibPath: (name: string) => string;
/** /usr/local/libexec/<cli>-<name>: a root helper. */
export declare const libexecPath: (name: string) => string;
/** /opt/<cli>/<name>: the installed engine. */
export declare const optPath: (name: string) => string;
/** /run/lock/<cli>-<name> */
export declare const runLockPath: (name: string) => string;
/** /run/<cli>/<name>: root's runtime files every user may read (the GPU test runs' locks). */
export declare const runPath: (name: string) => string;
/** /run/<cli>-mcp-<instance>: the instance's MCP broker's sockets (its unit's RuntimeDirectory). */
export declare const mcpRunPath: (instance: string, name: string) => string;
/** /var/lib/<cli>-mcp-<instance>: the broker's own state (blocked servers, the call log): its unit's StateDirectory. */
export declare const mcpStatePath: (instance: string, name: string) => string;
/** /etc/systemd/system/<unit> */
export declare const unitPath: (unit: string) => string;
/** /srv/<cli>/<instance>/<repo name>: a server instance's checkout (scripts/setup/lib.sh SRV_ROOT, add-project.sh). */
export declare const srvCheckoutPath: (instance: string, repoName: string) => string;
/** The test-run sandbox's base (scripts/setup/testrun-sandbox.sh): beside /var/lib/<cli>, its own directory. */
export declare const testRunBasePath: () => string;
/** /var/lib/<cli>-exp: experiment jobs' state (scripts/setup/experiments.sh), root's. */
export declare const expBasePath: () => string;
/** Single-user and development machines' slot directory (unbranded: every agent harness on the box shares it). */
export declare const devSlotsPath: () => string;
/**
 * The same locations as root sees them, never moved: only for text that tells a person what to run as root, or what
 * root's helper changes (a root shell and the helper are outside the engine, so they always mean the real files). The
 * engine never opens or runs one of these; what it opens or runs is built by the functions above.
 */
export declare const asRoot: {
    readonly etc: (name: string) => string;
    readonly varLib: (name: string) => string;
    readonly libexec: (name: string) => string;
    readonly opt: (name: string) => string;
    readonly run: (name: string) => string;
};

export declare const INCIDENTS_FILE = "incidents.json";
/** A resolved incident that breaks again within this long is the same incident, reopened (no second post). */
export declare const REOPEN_MS: number;
/** Resolved incidents kept for the history. */
export declare const HISTORY = 200;
/**
 * red: something is down or unsafe and work stops; amber: it will be, or work is slow, unless someone acts; info: a
 * notice, nothing to do (it never colours an instance's status).
 */
export type Severity = 'red' | 'amber' | 'info';
/** The kinds the watchdog raises itself (and the usage pause the coordinator raises), each with its fixed title and severity. Other modules may raise their own. */
export declare const KINDS: {
    readonly unit_down: {
        readonly title: "A service is down";
        readonly severity: "red";
    };
    readonly crash_loop: {
        readonly title: "A service is crash-looping";
        readonly severity: "red";
    };
    readonly update_rollback: {
        readonly title: "An engine update was rolled back";
        readonly severity: "red";
    };
    readonly update_stuck: {
        readonly title: "The engine is not updating";
        readonly severity: "amber";
    };
    readonly claude_auth: {
        readonly title: "Claude sign-in is failing";
        readonly severity: "red";
    };
    readonly claude_login_expiring: {
        readonly title: "A Claude login is about to expire";
        readonly severity: "amber";
    };
    readonly github_auth: {
        readonly title: "GitHub access is failing";
        readonly severity: "red";
    };
    readonly stalled: {
        readonly title: "Ready work is not moving";
        readonly severity: "amber";
    };
    readonly auto_merge_stopped: {
        readonly title: "The main watch stopped auto-merge";
        readonly severity: "red";
    };
    readonly disk_full: {
        readonly title: "Disk almost full";
        readonly severity: "red";
    };
    readonly update_signers_changed: {
        readonly title: "The release signers file changed outside updates.sh";
        readonly severity: "red";
    };
    readonly update_signer_added: {
        readonly title: "A release signer was added for engine updates";
        readonly severity: "amber";
    };
    readonly update_signer_staged: {
        readonly title: "A release signer was staged for engine updates";
        readonly severity: "amber";
    };
    readonly claude_profile_changed: {
        readonly title: "The agents' Claude account changed";
        readonly severity: "amber";
    };
    readonly test_sandbox: {
        readonly title: "The test sandbox check is failing";
        readonly severity: "red";
    };
    readonly helper_outdated: {
        readonly title: "The test sandbox helper is outdated: no test run starts";
        readonly severity: "red";
    };
    readonly update_sandbox_unconfirmed: {
        readonly title: "An engine update couldn't confirm the test sandbox";
        readonly severity: "amber";
    };
    readonly claude_usage_limit: {
        readonly title: "Claude usage limit reached: runs are paused";
        readonly severity: "amber";
    };
    readonly claude_account_failover: {
        readonly title: "Claude usage limit: moved to the next account";
        readonly severity: "info";
    };
    readonly config_invalid: {
        readonly title: "The config on the default branch is invalid";
        readonly severity: "amber";
    };
    readonly deploy_gate_diverged: {
        readonly title: "The deploy branch moved outside the gate";
        readonly severity: "red";
    };
    readonly deploy_post_check_failed: {
        readonly title: "Production failed its post-deploy check";
        readonly severity: "red";
    };
    readonly deploy_post_check_no_deploy: {
        readonly title: "Production didn't deploy the deploy branch's commit";
        readonly severity: "amber";
    };
    readonly task_budget: {
        readonly title: "A task is near its budget";
        readonly severity: "amber";
    };
};
export type WatchdogKind = keyof typeof KINDS;
export interface Incident {
    /** Stable for the incident's life: the Health page's anchor (#incident-<id>) and the post's link. */
    id: string;
    kind: string;
    key: string;
    /** The instance it is about; null for the machine (a disk, the hub, the updater). */
    instance: string | null;
    severity: Severity;
    /** Fixed per kind: never data. */
    title: string;
    /** What broke, redacted. */
    detail: string;
    /** The one action that fixes it, redacted. */
    fix: string;
    /** What the harness already tried on its own (restarts, a rollback, a retry), redacted. */
    tried: string[];
    since: string;
    lastSeen: string;
    resolvedAt: string | null;
    /** When the watchdog posted it, and its resolution; skipped: resolved before it was ever posted (never posted). */
    posted: {
        raised?: string;
        resolved?: string;
        skipped?: boolean;
    };
}
export interface IncidentFile {
    incidents: Incident[];
    /** When each recent post went out, machine-wide (the rate limit). */
    posts: string[];
}
export interface RaiseOptions {
    instance?: string | null;
    severity?: Severity;
    tried?: string[];
    /** The store's directory; the machine's slot directory when unset. */
    dir?: string;
    now?: Date;
}
/** The store's directory: the machine's slot directory, which every instance's coordinator can write. */
export declare const incidentsDir: (dir?: string) => string;
/** A Discord bot token's shape (three dot-separated base64url parts): never stored or posted, whoever's it is. */
export declare const DISCORD_TOKEN: RegExp;
/** A text with every secret-shaped string taken out. */
export declare const redactIncidentText: (s: string) => string;
/** The store as it is now; empty when missing or unreadable. */
export declare function readIncidents(dir?: string): IncidentFile;
/** Change the store under its lock: read, change, write. The change returns what the caller gets back. */
export declare function withIncidents<T>(dir: string | undefined, change: (f: IncidentFile) => T): T;
/**
 * Something is wrong: open an incident of this kind and key, or update the open one (its detail, fix and what was
 * tried; never a second incident). Returns the incident and whether it is new (or reopened).
 */
export declare function raiseIncident(kind: string, key: string, detail: string, fix: string, o?: RaiseOptions): {
    incident: Incident;
    opened: boolean;
};
/** It is fine now: close the open incident of this kind and key. Returns it, or null when none was open. */
export declare function resolveIncident(kind: string, key: string, o?: Pick<RaiseOptions, 'dir' | 'now'>): Incident | null;
/** The open incidents, oldest first. */
export declare const openIncidents: (f: IncidentFile) => Incident[];
/** Green: nothing open; amber: something will need a person; red: something is down or unsafe. */
export type HealthStatus = 'green' | 'amber' | 'red';
/** An instance's status from the open incidents about it and about the machine. */
export declare function healthStatus(incidents: Incident[], instance: string | null): HealthStatus;

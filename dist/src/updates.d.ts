export declare const UPDATES_CONFIG: string;
export declare const UPDATES_LOG: string;
/** The updater's last pass that found nothing newer (event "current"), or its last refusal or wait. */
export declare const UPDATES_STATE: string;
/** The engine the machine's services run: a link to /opt/<cli>/<sha>. */
export declare const ENGINE_CURRENT: string;
/** held: a commit that was rolled back, skipped until a newer one or until an admin releases it at a root shell (updates.sh --release-hold). */
/** The root command that releases a hold; nothing a coordinator or the dashboard can do releases one. */
export declare const RELEASE_HOLD: string;
/** chose: an older commit than main's tip is being installed (the tip, and every newer one, failed or held). */
/** signers_changed: the release signers file changed outside updates.sh --signer or --confirm-signer; release installs are held until acknowledged. */
export type UpdateEvent = 'attempt' | 'chose' | 'installed' | 'rolled_back' | 'held' | 'refused' | 'waiting' | 'build_failed' | 'error' | 'signers_changed' | CanaryEvent;
/** The canary (docs/canary.md): filed, then passed or failed. */
export type CanaryEvent = 'canary_filed' | 'canary_passed' | 'canary_failed';
export interface UpdateEntry {
    at: string;
    event: UpdateEvent;
    from?: string | null;
    to?: string | null;
    reason?: string;
    units?: string[];
    failed?: string[];
    /** On chose: main's tip then, and each newer commit passed over, with why. */
    tip?: string;
    skipped?: {
        sha: string;
        reason: string;
        held?: boolean;
        pending?: boolean;
    }[];
    back?: string;
    /** On a rollback: each failing unit's result, exit status, restarts and journal tail (redacted). */
    diagnosis?: {
        unit: string;
        result: string;
        status: string;
        restarts: number;
        journal: string;
    }[];
    /** On a rollback: the commit is now held. */
    held?: boolean;
    /** On an install (the new engine's) or a rollback (the old engine's): the root helpers replaced to match it. */
    helpers?: {
        path: string;
        state: string;
    }[];
    /** On a rollback: why the old engine's helpers couldn't all be put back. */
    helpers_error?: string;
    /** On a rollback because an instance's migration failed: which, and why. */
    migration?: {
        instance: string;
        error: string;
        restored?: string[];
        unrestored?: string[];
    };
    /** On a rollback because the canary failed: its issue, how far it got, its PR. */
    canary?: {
        issue: number | null;
        url: string | null;
        stage: string;
        pr: {
            number: number;
            url: string;
        } | null;
    };
    /** A canary line (reason: why it failed, or what passed): after an install or the daily one, its issue, the stage it reached, its PR, how long since it was filed. */
    trigger?: 'update' | 'daily';
    issue?: number | null;
    url?: string | null;
    stage?: string;
    pr?: {
        number: number;
        url: string;
    } | null;
    duration_ms?: number;
    timed_out?: boolean;
    deadline?: string;
}
/** An engine update that was rolled back and is held: the owner's to look at, until an install succeeds. */
export interface HeldUpdate {
    at: string;
    sha: string | null;
    reason: string;
    migration: boolean;
}
/** The held rollback, if the newest install or held rollback in the log is one. */
export declare function heldUpdate(log: UpdateEntry[]): HeldUpdate | null;
/** What the updater follows: signed release tags, or main's tip. */
export type UpdateChannel = 'release' | 'main';
/** The channel an updates.json selects: "release" only when it says so; absent (an existing install) is main. */
export declare function updateChannel(j: Record<string, unknown>): UpdateChannel;
/** The updater's settings, or null when it isn't set up on this machine. */
export declare function updateSettings(path?: string): {
    enabled: boolean;
    channel: UpdateChannel;
    repo_url: string;
    branch: string;
    required_checks: string[];
    canary: CanarySettings | null;
} | null;
/** The update log, newest last; torn or unknown lines are skipped. */
export declare function updateLog(path?: string, limit?: number): UpdateEntry[];
/** The canary as updates.json names it (the updater reads the same fields): its instance, its scratch repo, its time limit. */
export interface CanarySettings {
    instance: string;
    repo: string;
    timeLimitMinutes: number;
}
export declare const CANARY_TIME_LIMIT_MINUTES = 120;
/** The canary's last result: passed or failed, why, how long it took, its PR (or its issue when it got no PR). */
export interface CanaryResult {
    at: string;
    passed: boolean;
    trigger: 'update' | 'daily';
    stage: string | null;
    why: string | null;
    durationMs: number | null;
    timedOut: boolean;
    issue: {
        number: number;
        url: string | null;
    } | null;
    pr: {
        number: number;
        url: string;
    } | null;
    /** The engine commit it ran on after an install, when it was one. */
    sha: string | null;
}
/** What the Machine page's Updates panel shows: the engine running now, the last install, any hold, the canary. */
export interface UpdatesPanel {
    configured: boolean;
    enabled: boolean | null;
    installed: {
        sha: string | null;
        version: string | null;
    };
    lastInstall: {
        at: string;
        from: string | null;
        to: string | null;
    } | null;
    /** The updater's last pass that found nothing newer: when, on which channel, the installed version, the newest seen (#465). */
    lastCheck: LastCheck | null;
    /** The newest rollback, while no later install succeeded: when, what, why, and whether it is held. */
    rollback: {
        at: string;
        sha: string | null;
        reason: string;
        held: boolean;
        canary: boolean;
    } | null;
    /**
     * The updater is draining the machine for an install (src/update-drain.ts): since when, the commit it waits to
     * install, and what is still finishing (test runs, the full-run lock, agents). Null when it isn't, or the flag lapsed.
     */
    drain: UpdatesDrain | null;
    canary: {
        settings: CanarySettings | null;
        /** A canary filed and not yet passed or failed. */
        running: {
            at: string;
            trigger: 'update' | 'daily';
            issue: number | null;
            url: string | null;
            deadline: string | null;
        } | null;
        last: CanaryResult | null;
    };
}
export interface UpdatesDrain {
    since: string;
    until: string;
    to: string | null;
    testRuns: number;
    agents: number;
}
/** The engine the services run: its commit (the link's target) and version (its package.json); null where there's none. */
export declare function installedEngine(current?: string): {
    sha: string | null;
    version: string | null;
};
/** The Updates panel from the updater's log (oldest first), its settings and the engine installed now. */
export interface LastCheck {
    at: string;
    channel: 'release' | 'main';
    sha: string | null;
    version: string | null;
    /** The newest release tag (release channel) or main's head (main). */
    newest: string | null;
}
/** The state file's "current" entry, as the updater writes it on a pass with nothing newer; null for anything else. */
export declare function lastCheck(path?: string): LastCheck | null;
export declare function updatesPanel(log: UpdateEntry[], settings: ReturnType<typeof updateSettings>, installed: {
    sha: string | null;
    version: string | null;
}, drain?: UpdatesDrain | null, checked?: LastCheck | null): UpdatesPanel;

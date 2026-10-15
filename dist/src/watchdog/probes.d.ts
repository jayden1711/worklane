import type { StoredEvent } from '../events/types.js';
import type { UnitState } from '../os/stats.js';
import type { UpdateEntry } from '../updates.js';
import type { MachineChange } from '../machine.js';
import { type Incident, type Severity, type WatchdogKind } from './incidents.js';
export interface Finding {
    kind: WatchdogKind;
    key: string;
    instance: string | null;
    detail: string;
    fix: string;
    tried: string[];
    severity?: Severity;
}
/** Which open incidents a probe answers for: its kinds, for one instance (or the machine), or any; only these keys when given. */
export interface Scope {
    kinds: readonly WatchdogKind[];
    instance: string | null | 'any';
    /** The keys the probe could see this pass; an incident whose key it didn't see is left as it is. */
    keys?: ReadonlySet<string>;
}
/** Raise every finding and resolve every open incident in scope that wasn't found. */
export declare function reconcile(findings: Finding[], scope: Scope, o?: {
    dir?: string;
    now?: Date;
}): {
    raised: Incident[];
    resolved: Incident[];
};
/** The units the watchdog looks at: the hub, and each instance's coordinator and dashboard. */
export declare function watchedUnits(instances: string[]): {
    unit: string;
    instance: string | null;
    what: string;
}[];
/** Restarts within this long that make a crash loop. */
export declare const CRASH_LOOP: {
    readonly restarts: 3;
    readonly windowMs: number;
};
/** Restart counts seen per unit, oldest first: the watchdog keeps them between passes. */
export type RestartHistory = Map<string, {
    at: number;
    restarts: number;
}[]>;
/** Down (failed or stopped) and crash-looping units. Units not installed here (not-found) are not looked at. */
export declare function unitFindings(states: UnitState[], units: ReturnType<typeof watchedUnits>, history: RestartHistory, now: number): {
    findings: Finding[];
    seen: Set<string>;
};
/** A rolled-back engine update (held or not), until a later install. */
export declare function updateFindings(log: UpdateEntry[]): Finding[];
/** How long a signer's addition stays an open incident: posted once when seen, resolved (and posted once more) after this. */
export declare const SIGNER_NOTICE_MS: number;
/**
 * Every release signer added to the updater's allowed signers file in the last day, from the machine change log
 * (scripts/setup/updates-root.cjs writes one line per signer added, by updates.sh --signer or --confirm-signer): one
 * incident each, keyed by the key's fingerprint, naming the principal, the fingerprint and who ran it. A public key
 * and a principal are not secrets.
 */
export declare function signerFindings(changes: readonly MachineChange[], now: number): Finding[];
/**
 * Every release signer STAGED in the last day (the machine helper's stage-update-signer, asked for from a dashboard), from
 * the machine change log: one incident each, naming the principal, the fingerprint, the coordinator user that staged it
 * and so its instance. Staging trusts the key for nothing, but an owner should know someone asked, before anyone at
 * a root shell is asked to confirm it.
 */
export declare function stagedSignerFindings(changes: readonly MachineChange[], now: number): Finding[];
/** The share of a disk in use at or above which the watchdog alerts. */
export declare const DISK_PCT = 85;
/** Disks at or over the limit. `disks`: each path measured, with how much of its volume is used. */
export declare function diskFindings(disks: {
    path: string;
    usedPct: number;
    freeGb: number;
}[], limit?: number): Finding[];
/** Default hours ready work may sit with nothing moving before it's flagged (watchdog.json stall_hours). */
export declare const STALL_HOURS = 6;
/** How far back a failure counts: one hour for sign-in and GitHub access. */
export declare const AUTH_WINDOW_MS = 3600000;
/**
 * Watchdog passes in a row (one a minute) in which the instance's GitHub token couldn't be renewed because GitHub
 * wasn't reached (no answer at all, not a refusal) before that is reported, amber: GitHub not reachable. The token is
 * renewed once it has 10 minutes left (src/github-app.ts), so a blip of a minute or two (DNS, a dropped connection)
 * heals by itself with nobody told, and 5 failed passes still leave about 5 minutes of the old token: someone hears
 * of it before work that needs GitHub stops.
 */
export declare const GITHUB_UNREACHABLE_PASSES = 5;
/** A login that expires within this long is flagged. */
export declare const LOGIN_EXPIRY_MS: number;
export interface InstanceFacts {
    instance: string;
    events: StoredEvent[];
    now: number;
    stallHours?: number;
    /** The auto-merge stop file (state/auto-merge-stopped.json), when there is one. */
    stop: {
        reason: string;
        by: string | null;
    } | null;
    /** The agent user's Claude sign-in, as `claude auth status` reports it (never the token); null: not checked. */
    auth: {
        loggedIn: boolean;
        expiresAt?: string | null;
    } | null;
    /** When the probe first said signed out, of the probes in a row that say so (ms); unset: not known. */
    authFailingSince?: number;
    /**
     * Why GitHub refused the instance's token the last time one was asked for (an App token that wouldn't mint: a bad
     * key, a revoked installation, a 401); null when the last answer was a token. A network failure is not this.
     */
    githubTokenError: string | null;
    /** GitHub wasn't reached when a token was asked for, this many passes in a row (since `since`, ms); unset: it was. */
    githubUnreachable?: {
        passes: number;
        since: number;
        detail: string;
    } | null;
    /** When a GitHub call with the instance's token last succeeded (ms); unset or null: not known. */
    githubOkAt?: number | null;
    /** An emergency stop is in force: no work moves, on purpose. */
    emergency: boolean;
}
/** Every instance-level trigger: Claude sign-in and login expiry, GitHub access, stalled work, auto-merge stopped, the test sandbox. */
export declare function instanceFindings(f: InstanceFacts): Finding[];
/** The instance-level kinds: an instance's own probe answers for these, for itself only. */
export declare const INSTANCE_KINDS: readonly ["claude_auth", "claude_login_expiring", "github_auth", "stalled", "auto_merge_stopped", "test_sandbox", "helper_outdated"];

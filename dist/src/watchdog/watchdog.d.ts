import type { StoredEvent } from '../events/types.js';
import type { UnitState } from '../os/stats.js';
import type { UpdateEntry } from '../updates.js';
import { type Poster } from './post.js';
import type { MachineChange } from '../machine.js';
import type { WatchdogConfig } from './config.js';
/** How often the watchdog looks: once a minute. The agent's Claude sign-in is asked at most every AUTH_EVERY_MS. */
export declare const WATCHDOG_EVERY_MS = 60000;
export declare const AUTH_EVERY_MS: number;
export interface WatchdogDeps {
    /** This coordinator's instance. */
    instance: string;
    /** The machine-wide directory (the slot directory); the incident store and the locks are there. */
    dir?: string;
    /** The instance's event log. */
    events: () => StoredEvent[];
    /** The auto-merge stop file, when there is one. */
    stop: () => {
        reason: string;
        by: string | null;
    } | null;
    emergency: () => boolean;
    /** The agent user's Claude sign-in (claude auth status, never the token); null when it can't be asked. */
    auth?: () => {
        loggedIn: boolean;
        expiresAt?: string | null;
    } | null;
    /** Mints (or reads) the instance's GitHub token: a throw is a GitHub access failure, unless GitHub wasn't reached. */
    githubToken?: () => Promise<string>;
    /** When a GitHub call with the instance's token last succeeded (src/github/seen.ts); unset: not known. */
    githubOkAt?: () => number | null;
    /** The machine checks' inputs. */
    instances: () => string[];
    units: (units: string[]) => UnitState[] | null;
    updates: () => UpdateEntry[];
    /** The machine change log (the root helper's and updates.sh's): a release signer added shows there. Unset: not looked at. */
    machineChanges?: () => MachineChange[];
    disks: () => {
        path: string;
        usedPct: number;
        freeGb: number;
    }[];
    config: () => WatchdogConfig;
    /** Where this coordinator would post (its ops channel and bot), read every pass; null when it can't. */
    poster: () => {
        poster: Poster;
        dashboardUrl: string | null;
        secrets: string[];
    } | null;
    now?: () => Date;
    log?: (line: string) => void;
}
export declare class Watchdog {
    private d;
    private machineLock;
    private postLock;
    private history;
    private auth;
    /** When the probe first said signed out, of the probes in a row that say so; null while it says signed in. */
    private authFailingSince;
    private running;
    /** Why GitHub last refused the instance's token; kept while GitHub can't be reached, since no answer says it's fixed. */
    private tokenRefused;
    /** The passes in a row whose token request never reached GitHub; null once one does. */
    private unreachable;
    /** Stopped (its coordinator is shutting down): it never takes a role again, even from a pass already under way. */
    private stopped;
    constructor(d: WatchdogDeps);
    private get dir();
    /** Whether this coordinator holds the machine checks / the posting now (tests, and the log). */
    get elected(): {
        machine: boolean;
        post: boolean;
    };
    /** Take `which` if it's free (or its holder is dead); keep it once held. */
    private take;
    /** One pass: this instance's checks; the machine's, if elected; the posts, if elected to post. */
    pass(): Promise<void>;
    private instancePass;
    private machinePass;
    stop(): void;
}
/** Run a watchdog on its own timer until stopped; a failed pass is logged and the next one tries again. */
export declare function startWatchdog(d: WatchdogDeps, everyMs?: number): {
    watchdog: Watchdog;
    stop: () => void;
};

import type { Role } from './console/asks.js';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import { type MachineRequest } from './machine-requests.js';
import type { MachineRequester } from './machine-owners.js';
import type { RunAs } from './runner.js';
/** The root script, as an admin runs it on the machine (confirm-profile, and every instance's steps). */
export declare const CLAUDE_ACCOUNT_SCRIPT: string;
/** The login each agent user always had: never added or removed, always there to go back to. */
export declare const DEFAULT_PROFILE = "default";
/** A profile's name (claude-account.sh and the machine helper check the same). */
export declare const PROFILE_NAME: RegExp;
/** Where an agent user's profiles live, under its home. */
export declare const PROFILES_DIRNAME = ".claude-profiles";
/** The new profile's token in the asking instance's secrets dir (lib.sh's CLAUDE_PROFILE_CREDENTIAL). */
export declare const CLAUDE_PROFILE_CREDENTIAL = "claude-profile-token";
/** A relayed sign-in's one-time code in the asking instance's secrets dir (lib.sh's CLAUDE_LOGIN_CREDENTIAL). */
export declare const CLAUDE_LOGIN_CREDENTIAL = "claude-login-code";
/** The code Anthropic's sign-in page shows to paste (claude-account.sh login checks the same shape). */
export declare const LOGIN_CODE: RegExp;
/** A profile step with no new line for this long has stopped (its unit ended without a last line). */
export declare const PROFILE_OP_STALE_MS: number;
export declare const PROFILE_ACTIONS: readonly ["profile-add", "use", "remove", "login"];
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];
/** One agent user's last real call on a profile. */
export interface ProfileCheck {
    instance: string;
    user: string;
    /** The account's email, as `claude auth status` names it on that profile. */
    account: string | null;
    subscription: string | null;
    apiOk: boolean;
    apiError: string | null;
    checkedAt: string | null;
}
export interface Profiles {
    /**
     * Each profile. `staged`: added from a dashboard and not yet confirmed by a root admin on the machine (claude-account.sh
     * confirm-profile): nothing may use it. `instance`: the instance whose dashboard added it, if one did.
     */
    profiles: Record<string, {
        kind: string;
        addedAt: string | null;
        users: Record<string, ProfileCheck>;
        staged: boolean;
        instance: string | null;
    }>;
    /** Each instance's active profile; an instance not named is on default. */
    active: Record<string, {
        profile: string;
        since: string;
    }>;
    /** When each instance last switched profile (to default too). */
    switchedAt: Record<string, string>;
    /** Auto-failover on a usage limit: machine-wide, and per instance (which overrides it; an empty order is off). */
    failover: {
        machine: FailoverSetting | null;
        instances: Record<string, FailoverSetting>;
    };
}
/** The order of profiles to move through on a usage limit, and whether to move back after its reset. */
export interface FailoverSetting {
    order: string[];
    back: boolean;
}
/** profiles.json, or no profiles when there is none (or it can't be read). Anything not of its shape is left out. */
export declare function readProfiles(dir?: string): Profiles;
/** An instance's failover setting in force: its own, else the machine's; null when off (no order of two or more). */
export declare function failoverFor(instance: string, p?: Profiles): FailoverSetting | null;
/** The profile an instance's runs use now. */
export declare function activeProfile(instance: string, p?: Profiles): string;
/** A profile's dir for this agent user. */
export declare const profileDir: (r: RunAs, profile: string) => string;
/**
 * The login a run as this user uses: the instance's active profile's dir, for its agent user only (the eval user's
 * lane keeps its own login). `agentUser`: the instance's agent user. Read when each run starts.
 */
export declare function resolveLogin(r: RunAs, o: {
    instance: string;
    agentUser: string;
    dir?: string;
}): RunAs;
/**
 * Every profile's credentials file for this user, default's too: what no agent command may read, whichever profile it
 * runs on. Its own login is not something an agent needs to read, and another account's never is.
 */
export declare function profileCredentialFiles(r: RunAs, p: Profiles): string[];
/**
 * The runner's login hook for an instance (src/runner.ts CliRunner's `login`): each run's user on its active profile,
 * and every profile's credentials file for that user, for its commands' deny list. Profiles apply to the instance's
 * agent user only.
 */
export declare function profileLogin(o: {
    instance: string;
    agentUser: string;
    dir?: string;
}): {
    resolve: (r: RunAs) => RunAs;
    credentialFiles: (r: RunAs) => string[];
};
/** One line of profile-ops.jsonl. */
export interface ProfileOpLine {
    at: string;
    id: string;
    op: string;
    profile: string;
    step: string;
    state: string;
    instance: string | null;
    user: string | null;
    for: string | null;
    detail: string;
}
/** One profile-add, use or remove, folded from its lines. */
export interface ProfileOp {
    id: string;
    op: string;
    profile: string;
    /** The instance whose dashboard asked (null: a terminal). */
    for: string | null;
    status: 'running' | 'done' | 'failed' | 'stalled';
    startedAt: string;
    endedAt: string | null;
    /** Its last line's detail (how it ended, or what it is doing). */
    detail: string;
    /** A finished use: each instance's profile before it. */
    from: Record<string, string> | null;
    /** Each agent user's install, check and remove line, in order. */
    steps: {
        step: string;
        state: string;
        instance: string | null;
        user: string | null;
        detail: string;
    }[];
}
/** Every profile step in profile-ops.jsonl, oldest first; torn or foreign lines are skipped. */
export declare function readProfileOps(dir?: string, now?: number): ProfileOp[];
/** When this instance last switched profile, or null: a switch ends its usage-limit pause, and rechecks a held login. */
export declare const profileSwitchedAt: (instance: string, dir?: string) => string | null;
/** The later of two switch times (either may be null): an account switch, or a profile switch. */
export declare function latestSwitch(a: string | null, b: string | null): string | null;
/** The accounts × instances table: for each profile, each instance's agent user's last real call on it, and which is active. */
export declare function profilesTable(o: {
    dir?: string;
    instances?: string[];
}): {
    instances: string[];
    profiles: {
        name: string;
        kind: string;
        staged: boolean;
        /** The instance whose dashboard added it (only that instance's agent user has it), or null for a root admin's. */
        addedFor: string | null;
        addedAt: string | null;
        cells: {
            instance: string;
            user: string | null;
            active: boolean;
            account: string | null;
            subscription: string | null;
            apiOk: boolean | null;
            apiError: string | null;
            checkedAt: string | null;
        }[];
    }[];
    active: {
        [k: string]: string;
    };
    failover: {
        machine: FailoverSetting | null;
        instances: Record<string, FailoverSetting>;
    };
};
export type ProfilesTable = ReturnType<typeof profilesTable>;
/**
 * Record the failover setting for the coordinator to run through the machine helper (`claude-account failover
 * <order|off> back|stay`), for this dashboard's own instance: the same gate as a profile step. `order`: two to eight profiles, or null (off).
 */
export declare function requestFailoverSetting(log: EventLog, r: {
    order: unknown;
    back: unknown;
    who: {
        role: Role | null;
        requester: MachineRequester;
    };
    ownersFile?: string;
}): MachineRequest;
/**
 * Record a profile step for the coordinator to run through the machine helper: the same gate as any machine change
 * (a machine owner, on an allowed device, or the break-glass), the instance's owner role, one profile step or switch
 * at a time. Never runs anything.
 */
export declare function requestProfileOp(log: EventLog, r: {
    action: unknown;
    profile: unknown;
    who: {
        role: Role | null;
        requester: MachineRequester;
    };
    dir?: string;
    ownersFile?: string;
    now?: number;
}): MachineRequest;
/**
 * Store a new profile's token for this coordinator user only (0400), for profile-add to read once as root and delete.
 * Only a machine owner who may act here, only a token from claude setup-token. Every error is a fixed text: never the
 * value. Returns the file's path.
 */
export declare function storeProfileToken(o: {
    value: unknown;
    instance: string;
    who: {
        role: Role | null;
        requester: MachineRequester;
    };
    home?: string;
    ownersFile?: string;
}): string;
/**
 * The account.switched records this instance's log still needs: each finished `use` its dashboard asked for (the
 * op's `for`), not yet recorded (by op id). `by` is who asked, from the machine request it came from.
 */
export declare function unrecordedSwitches(events: readonly StoredEvent[], ops: readonly ProfileOp[], instance: string): {
    op: string;
    to: string;
    from: {
        [k: string]: string;
    };
    instances: string[];
    by: string;
    ok: boolean;
    detail: string;
}[];
/** Append each finished profile switch this instance's dashboard asked for as account.switched, once. Returns how many. */
export declare function recordProfileSwitches(log: EventLog, instance: string, dir?: string): number;
/** The panel's profile data: the accounts × instances table and the last few profile steps (newest first). */
export declare function profilesView(dir?: string, now?: number, instance?: string): {
    profiles: {
        instances: string[];
        profiles: {
            name: string;
            kind: string;
            staged: boolean;
            /** The instance whose dashboard added it (only that instance's agent user has it), or null for a root admin's. */
            addedFor: string | null;
            addedAt: string | null;
            cells: {
                instance: string;
                user: string | null;
                active: boolean;
                account: string | null;
                subscription: string | null;
                apiOk: boolean | null;
                apiError: string | null;
                checkedAt: string | null;
            }[];
        }[];
        active: {
            [k: string]: string;
        };
        failover: {
            machine: FailoverSetting | null;
            instances: Record<string, FailoverSetting>;
        };
    };
    profileOps: ProfileOp[];
    confirmScript: string;
    signin: {
        profile: string;
        status: "done" | "failed" | "stalled" | "running";
        detail: string;
        waitingForCode: boolean;
        url: null;
    } | {
        profile: string;
        status: "running";
        detail: string;
        waitingForCode: boolean;
        url: string | null;
    } | null;
};
/**
 * The link a relayed sign-in waits on (claude-account.sh login wrote it for this coordinator's user only): Anthropic's
 * sign-in page whose redirect is its own code page, and nothing else. null when there is none, or it is anything else.
 */
export declare function readSigninUrl(dir?: string): string | null;
/** This instance's relayed sign-in under way: its profile, whether it waits for the code, and (then) the link. */
export declare function signinView(o: {
    dir?: string;
    instance: string;
    now?: number;
}): {
    profile: string;
    status: "done" | "failed" | "stalled" | "running";
    detail: string;
    waitingForCode: boolean;
    url: null;
} | {
    profile: string;
    status: "running";
    detail: string;
    waitingForCode: boolean;
    url: string | null;
} | null;
/**
 * Store the code a machine owner pasted for this instance's relayed sign-in, for its coordinator user only (0400), for
 * claude-account.sh login to read once, as root, and delete. Only while that sign-in waits for it, only one (a code is
 * single-use: once one is stored or taken, another is refused), only a code's shape. Every error is a fixed text,
 * never the value. Returns the file's path.
 */
export declare function storeLoginCode(o: {
    value: unknown;
    instance: string;
    who: {
        role: Role | null;
        requester: MachineRequester;
    };
    dir?: string;
    home?: string;
    ownersFile?: string;
    now?: number;
}): string;

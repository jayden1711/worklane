import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import type { Role } from './console/asks.js';
import { type MachineRequester } from './machine-owners.js';
import { type MachineRequest } from './machine-requests.js';
/** Where claude-account.sh writes status.json, switch.jsonl and paused (root's, 0644; lib.sh's CLAUDE_ACCOUNT_DIR). */
export declare const CLAUDE_ACCOUNT_DIR: string;
/** The pasted token's file in this instance's secrets directory (lib.sh's CLAUDE_ACCOUNT_CREDENTIAL). */
export declare const CLAUDE_ACCOUNT_CREDENTIAL = "claude-account-token";
/** A token from `claude setup-token` (lib.sh's claude_token_ok, install_claude_token's check). */
export declare const SETUP_TOKEN: RegExp;
/** A switch with no new line for this long has stopped (its unit ended without a last line): the longest a step waits is 30 minutes. */
export declare const SWITCH_STALE_MS: number;
export declare const CLAUDE_ACCOUNT_ACTIONS: readonly ["status", "switch"];
export type ClaudeAccountAction = (typeof CLAUDE_ACCOUNT_ACTIONS)[number];
/** One agent user, as status.json has it. */
export interface AccountUser {
    instance: string;
    /** agent (the instance's agent user, which channel chat runs as too) or eval. */
    kind: string;
    user: string;
    /** Whether a Claude login is stored in its credentials file. */
    stored: boolean;
    loggedIn: boolean;
    authMethod: string | null;
    /** The account's email, as claude auth status names it (none for some logins). */
    account: string | null;
    org: string | null;
    subscription: string | null;
    /** The first 8 hex digits of the stored token's sha256: the same login shows the same id. */
    tokenId: string | null;
    expiresAt: string | null;
    installedAt: string | null;
    error: string | null;
    /**
     * Whether the API took the login on one minimal real call as that user (issue #463: claude auth status says a
     * credential is configured, not that it works); null when no call was made (signed out, or an older record).
     */
    apiOk: boolean | null;
    /** What Claude said when the API refused it (redacted by the script), else null. */
    apiError: string | null;
}
export interface AccountStatus {
    at: string;
    users: AccountUser[];
}
export type SwitchStep = 'switch' | 'pause' | 'token' | 'wait' | 'install' | 'check' | 'resume';
export type SwitchState = 'started' | 'done' | 'failed' | 'ask' | 'skipped';
export interface SwitchLine {
    at: string;
    step: SwitchStep;
    state: SwitchState;
    instance: string | null;
    user: string | null;
    detail: string;
}
/** One instance through the switch: each phase's last line, and each user's install and check. */
export interface SwitchInstance {
    name: string;
    pause: SwitchLine | null;
    wait: SwitchLine | null;
    users: {
        user: string;
        install: SwitchLine | null;
        check: SwitchLine | null;
    }[];
    /** A check line for the instance as a whole (no agent user found). */
    check: SwitchLine | null;
    resume: SwitchLine | null;
}
export interface SwitchView {
    startedAt: string;
    /** running; done or failed (its last line); stalled: no line for SWITCH_STALE_MS and no end. */
    status: 'running' | 'done' | 'failed' | 'stalled';
    /** Its last switch line's detail (how it ended, or what it is doing). */
    detail: string;
    /** Where the token comes from: this instance's dashboard (its name), or a terminal (null). */
    tokenFrom: string | null;
    /** Waiting for the token: an ask line and nothing after it on the token step. */
    waitingForToken: boolean;
    token: SwitchLine | null;
    instances: SwitchInstance[];
    lines: SwitchLine[];
}
/** status.json, or null when there is none yet (or it can't be read). */
export declare function readAccountStatus(dir?: string): AccountStatus | null;
/** The progress lines of the last switch (switch.jsonl); torn or foreign lines are skipped. */
export declare function readSwitchLines(dir?: string): SwitchLine[];
/**
 * When the last switch put this instance on the new login and started it again: its resume line's time, else null.
 * All of: a token was received (not "checked on its current login"), every one of the instance's agent users had it
 * installed and passed the auth check, and the instance was resumed. Its usage-limit pause then ends (the old
 * account's limit no longer applies); an instance whose check failed stays paused.
 */
export declare function switchedOnto(instance: string, lines?: readonly SwitchLine[]): string | null;
/** The last switch, folded per instance and user in the script's order; null when there has been none. */
export declare function switchView(lines: readonly SwitchLine[], now?: number): SwitchView | null;
/** Whether this person sees the Claude account panel: a machine owner, or the owner's break-glass. */
export declare const mayViewClaudeAccount: (r: Pick<MachineRequester, "login" | "breakGlass">, file?: string) => boolean;
/** Why this person may not refresh or switch now; null when they may (the same gate as any machine change). */
export declare function claudeAccountGate(who: {
    role: Role | null;
    requester: MachineRequester;
}, o?: {
    ownersFile?: string;
}): string | null;
/** The panel's data: each agent user's account, the last switch, this log's requests, and whether this person may act. */
export declare function claudeAccountView(o: {
    dir?: string;
    events: readonly StoredEvent[];
    who: {
        role: Role | null;
        requester: MachineRequester;
    };
    instance: string;
    ownersFile?: string;
    now?: number;
}): {
    machineOwner: boolean;
    machineOwners: string[];
    login: string;
    instance: string;
    allowed: boolean;
    why: string | null;
    canSwitch: boolean;
    busy: string | null;
    /** Whether this person may paste the token here now: the switch is waiting for it, from this instance. */
    canPasteToken: boolean;
    status: AccountStatus | null;
    switch: SwitchView | null;
    requests: MachineRequest[];
};
export type ClaudeAccountData = ReturnType<typeof claudeAccountView>;
/**
 * Record `claude-account status|switch` for the coordinator to run through the machine helper: the same gate as any
 * machine change (src/machine-requests.ts), and one switch at a time (none waiting for the coordinator, none running).
 */
export declare function requestClaudeAccount(log: EventLog, r: {
    action: unknown;
    requester: MachineRequester;
    dir?: string;
    ownersFile?: string;
    now?: number;
}): MachineRequest;
export declare class ClaudeTokenError extends Error {
    readonly status: 400 | 403 | 409;
    constructor(message: string, status?: 400 | 403 | 409);
}
/**
 * Store the pasted token for the running switch: only while it waits for one from this instance, only a token from
 * claude setup-token, for this coordinator user only (0400). Every error is a fixed text: never the value.
 * Returns the file's path.
 */
export declare function storeSwitchToken(o: {
    value: string;
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

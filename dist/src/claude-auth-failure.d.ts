import type { StoredEvent } from './events/types.js';
/** What the channel chat answers while the login is held, or when its own run was refused. */
export declare const AUTH_FAILED_CHAT_TEXT = "Claude sign-in failed on this machine; the owner has been told.";
/** At most this often the coordinator checks a held login by itself (one tiny real call). */
export declare const AUTH_RECHECK_MS: number;
/** The owner's re-check from the dashboard: at most this often, however often it is asked for. */
export declare const AUTH_OWNER_RECHECK_MS = 60000;
/**
 * The check's call: the cheapest model, one turn, a one-word answer, and a hard budget cap. A call the API refuses
 * (401/403) is not billed; one that is accepted costs about one short Haiku turn with Claude Code's system prompt
 * (about $0.02-0.03 on an API key; on a subscription login, a sliver of its usage), and ends the hold, so the checks
 * stop. docs/dashboard.md ("When Claude refuses the login") has the cost.
 */
export declare const AUTH_CHECK: {
    readonly model: "haiku";
    readonly prompt: "Reply with the single word: ok";
    readonly maxTurns: 1;
    readonly maxBudgetUsd: 0.05;
    readonly stallMs: 60000;
    readonly timeoutMs: 120000;
};
/** The login a run with no runner-reported login belongs to (a stand-in runner, a single-login instance). */
export declare const DEFAULT_LOGIN_KEY = "claude";
/**
 * Claude's own words for a refused login: an HTTP 401 or 403 from the API, the API's authentication_error or
 * permission_error, an invalid or expired API key or OAuth token, a revoked token, or its "please run /login".
 * Status codes count only next to "API Error" or a status word, never a bare number (an issue #401 in a message).
 */
export declare const AUTH_FAILED_TEXT: RegExp;
/**
 * Whether a run that did not succeed was refused its login: the result's api_error_status (401 or 403), an assistant
 * message claude marked `authentication_failed`, or Claude's words for it in the error result or its stderr.
 */
export declare function isAuthFailure(o: {
    apiErrorStatus?: number | null;
    assistantError?: string | null;
    text: string;
}): boolean;
/** Claude's message for a refused login, as the run's detail: redacted and capped, never a token. */
export declare function authFailedDetail(o: {
    apiErrorStatus?: number | null;
    text: string;
}): string;
/** The red claude_auth incident for an instance's refused logins: the coordinator raises it, the watchdog's probe keeps it. */
export declare const authIncidentKey: (instance: string) => string;
/** The incident's words for the logins held now, never a token. */
export declare function authIncidentText(holds: readonly AuthHold[]): {
    detail: string;
    fix: string;
    tried: string[];
};
/** One held login, as the log has it. */
export interface AuthHold {
    /** The login's key: its config dir (a path), or DEFAULT_LOGIN_KEY. */
    key: string;
    /** The login as Claude names it: its account email, else its org, else the agent user's login. Never a token. */
    login: string;
    /** Claude's message, redacted. */
    detail: string;
    /** The lane the refused run was in: a check runs there, as the same user. */
    lane: string;
    role: string;
    issue: number | null;
    since: string;
    /** The claude_auth.failed event's id: the ops channel notice's key. */
    id: number;
    /** The last check on it, if any. */
    lastCheck: {
        at: string;
        ok: boolean;
        detail: string;
    } | null;
}
/** Every login held now: the last claude_auth.failed of each key with no claude_auth.recovered of that key after it. */
export declare function authHoldsOf(events: StoredEvent[]): AuthHold[];
/** The ops channel's notices: one when a login is held, one when it works again. */
export declare function authHoldPost(h: AuthHold, o: {
    dashboardUrl?: string | null;
    instance: string;
}): string;
export declare function authRecoveredPost(login: string, o: {
    instance: string;
}): string;

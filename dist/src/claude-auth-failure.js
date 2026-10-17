import { redactString } from './events/redact.js';
/** What the channel chat answers while the login is held, or when its own run was refused. */
export const AUTH_FAILED_CHAT_TEXT = 'Claude sign-in failed on this machine; the owner has been told.';
/** At most this often the coordinator checks a held login by itself (one tiny real call). */
export const AUTH_RECHECK_MS = 10 * 60_000;
/** The owner's re-check from the dashboard: at most this often, however often it is asked for. */
export const AUTH_OWNER_RECHECK_MS = 60_000;
/**
 * The check's call: the cheapest model, one turn, a one-word answer, and a hard budget cap. A call the API refuses
 * (401/403) is not billed; one that is accepted costs about one short Haiku turn with Claude Code's system prompt
 * (about $0.02-0.03 on an API key; on a subscription login, a sliver of its usage), and ends the hold, so the checks
 * stop. docs/dashboard.md ("When Claude refuses the login") has the cost.
 */
export const AUTH_CHECK = { model: 'haiku', prompt: 'Reply with the single word: ok', maxTurns: 1, maxBudgetUsd: 0.05, stallMs: 60_000, timeoutMs: 120_000 };
/** The login a run with no runner-reported login belongs to (a stand-in runner, a single-login instance). */
export const DEFAULT_LOGIN_KEY = 'claude';
/** A token refresh that failed is a transient error (src/runner.ts TRANSIENT_ERROR), retried, never a refused login. */
const REFRESH = /failed to refresh oauth token|another claude code process is refreshing|exited mid-refresh/i;
/**
 * Claude's own words for a refused login: an HTTP 401 or 403 from the API, the API's authentication_error or
 * permission_error, an invalid or expired API key or OAuth token, a revoked token, or its "please run /login".
 * Status codes count only next to "API Error" or a status word, never a bare number (an issue #401 in a message).
 */
export const AUTH_FAILED_TEXT = /api error:?\s*40[13]\b|\b(?:status(?: code)?|http)\s*:?\s*40[13]\b|\b40[13]\s+(?:unauthorized|forbidden)\b|authentication_error|authentication_failed|permission_error|invalid (?:x-)?api[ -]key|invalid (?:oauth|bearer|access) token|oauth token (?:has )?(?:expired|been revoked|was revoked|is invalid|revoked)|token (?:has been|was) revoked|failed to authenticate|please run \/login|oauth authentication is currently not supported/i;
/**
 * Whether a run that did not succeed was refused its login: the result's api_error_status (401 or 403), an assistant
 * message claude marked `authentication_failed`, or Claude's words for it in the error result or its stderr.
 */
export function isAuthFailure(o) {
    if (REFRESH.test(o.text))
        return false;
    if (o.apiErrorStatus === 401 || o.apiErrorStatus === 403)
        return true;
    if (o.assistantError === 'authentication_failed')
        return true;
    return AUTH_FAILED_TEXT.test(o.text);
}
/** Claude's message for a refused login, as the run's detail: redacted and capped, never a token. */
export function authFailedDetail(o) {
    const said = o.text.replace(/\s+/g, ' ').trim() || '(claude said nothing more)';
    return redactString(`claude's login was refused${o.apiErrorStatus ? ` (HTTP ${o.apiErrorStatus})` : ''}: ${said}`).slice(0, 1000);
}
/** The red claude_auth incident for an instance's refused logins: the coordinator raises it, the watchdog's probe keeps it. */
export const authIncidentKey = (instance) => `${instance}:refused`;
/** The incident's words for the logins held now, never a token. */
export function authIncidentText(holds) {
    const named = holds.map((h) => `${h.login} (since ${h.since}): ${h.detail.slice(0, 300)}`).join('; ');
    const checks = holds.flatMap((h) => (h.lastCheck ? [`checked ${h.login} with a minimal real call at ${h.lastCheck.at}: ${h.lastCheck.ok ? 'answered' : h.lastCheck.detail.slice(0, 200)}`] : []));
    return {
        detail: `Claude refused ${holds.length === 1 ? 'a login' : `${holds.length} logins`} this instance's runs use: ${named}. No new Claude run starts on it until a call on it succeeds`,
        fix: `Sign the agent user in to Claude again (switch the Claude account, or a new setup-token for that user). It resumes on its own: the login is checked with one tiny real call every ${AUTH_RECHECK_MS / 60_000} minutes, at once after an account switch, or with Re-check on the dashboard`,
        tried: ['paused new Claude runs on that login (dispatch, chat, research, fix runs, evals); tasks requeued, no attempt counted', ...checks],
    };
}
/** Every login held now: the last claude_auth.failed of each key with no claude_auth.recovered of that key after it. */
export function authHoldsOf(events) {
    const holds = new Map();
    for (const e of events) {
        const p = e.payload;
        if (typeof p.key !== 'string')
            continue;
        if (e.type === 'claude_auth.failed') {
            const x = e.payload;
            const was = holds.get(x.key);
            // A second refusal while held keeps the hold's start (and its notice): it is the same outage.
            holds.set(x.key, { key: x.key, login: x.login, detail: x.detail, lane: x.lane, role: x.role, issue: x.issue, since: was?.since ?? e.ts, id: was?.id ?? e.id, lastCheck: was?.lastCheck ?? null });
        }
        else if (e.type === 'claude_auth.checked') {
            const h = holds.get(p.key);
            const x = e.payload;
            if (h)
                h.lastCheck = { at: e.ts, ok: x.ok, detail: x.detail };
        }
        else if (e.type === 'claude_auth.recovered')
            holds.delete(p.key);
    }
    return [...holds.values()];
}
/** The ops channel's notices: one when a login is held, one when it works again. */
export function authHoldPost(h, o) {
    return [
        `**Claude sign-in failed on ${o.instance}: no new Claude runs start on that login.**`,
        `Login: ${h.login}. Claude said: ${h.detail.slice(0, 600)}`,
        `What to do: sign the agent user in to Claude again (switch the Claude account, or a new setup-token for that user). It resumes on its own once a check call on the login succeeds; checked every ${AUTH_RECHECK_MS / 60_000} min, or at once with Re-check on the dashboard.`,
        ...(o.dashboardUrl ? [`${o.dashboardUrl.replace(/\/+$/, '')}/overview`] : []),
    ].join('\n');
}
export function authRecoveredPost(login, o) {
    return `Claude sign-in works again on ${o.instance} (${login}): runs start again.`;
}
//# sourceMappingURL=claude-auth-failure.js.map
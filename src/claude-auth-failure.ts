// A Claude login the API refuses (issue #463). `claude auth status` only says a credential is configured, not that
// Anthropic's API accepts it: a login can look signed in while every request comes back 401. A run that ends on such
// a refusal ends `auth_failed` (src/runner.ts), and from then on the login is held, as a fold over the event log so
// a restart keeps it:
//
//   claude_auth.failed     a run on the login was refused: the hold begins (the watchdog's red claude_auth incident)
//   claude_auth.checked    a minimal real call on the held login (the periodic check, the owner's re-check, or one
//                          after an account switch): ok or not, with Claude's words
//   claude_auth.recovered  a call on the login succeeded: the hold ends (the incident resolves, runs start again)
//
// While a login is held no new Claude run starts on it (src/coordinator/base.ts), and the coordinator checks it with
// one tiny real call at most every AUTH_RECHECK_MS, so the hold can end without anyone's help once the login works.
// Nothing here ever holds a token: a login is named by its account (as claude auth status names it) and its key, the
// login's config dir, which is a path.
import type { StoredEvent } from './events/types.js';
import { redactString } from './events/redact.js';
import { SIGN_IN_HOLD_REASON } from './governor-holds.js';

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
export const AUTH_CHECK = { model: 'haiku', prompt: 'Reply with the single word: ok', maxTurns: 1, maxBudgetUsd: 0.05, stallMs: 60_000, timeoutMs: 120_000 } as const;

/** The login a run with no runner-reported login belongs to (a stand-in runner, a single-login instance). */
export const DEFAULT_LOGIN_KEY = 'claude';

/** A token refresh that failed is a transient error (src/runner.ts TRANSIENT_ERROR), retried, never a refused login. */
const REFRESH = /failed to refresh oauth token|another claude code process is refreshing|exited mid-refresh/i;

/**
 * Claude's own words for a refused login: an HTTP 401 or 403 from the API, the API's authentication_error or
 * permission_error, an invalid or expired API key or OAuth token, a revoked token, or its "please run /login".
 * Status codes count only next to "API Error" or a status word, never a bare number (an issue #401 in a message).
 */
export const AUTH_FAILED_TEXT =
  /api error:?\s*40[13]\b|\b(?:status(?: code)?|http)\s*:?\s*40[13]\b|\b40[13]\s+(?:unauthorized|forbidden)\b|authentication_error|authentication_failed|permission_error|invalid (?:x-)?api[ -]key|invalid (?:oauth|bearer|access) token|oauth token (?:has )?(?:expired|been revoked|was revoked|is invalid|revoked)|token (?:has been|was) revoked|failed to authenticate|please run \/login|oauth authentication is currently not supported/i;

/**
 * Whether a run that did not succeed was refused its login: the result's api_error_status (401 or 403), an assistant
 * message claude marked `authentication_failed`, or Claude's words for it in the error result or its stderr.
 */
export function isAuthFailure(o: { apiErrorStatus?: number | null; assistantError?: string | null; text: string }): boolean {
  if (REFRESH.test(o.text)) return false;
  if (o.apiErrorStatus === 401 || o.apiErrorStatus === 403) return true;
  if (o.assistantError === 'authentication_failed') return true;
  return AUTH_FAILED_TEXT.test(o.text);
}

/** Claude's message for a refused login, as the run's detail: redacted and capped, never a token. */
export function authFailedDetail(o: { apiErrorStatus?: number | null; text: string }): string {
  const said = o.text.replace(/\s+/g, ' ').trim() || '(claude said nothing more)';
  return redactString(`claude's login was refused${o.apiErrorStatus ? ` (HTTP ${o.apiErrorStatus})` : ''}: ${said}`).slice(0, 1000);
}

/** The red claude_auth incident for an instance's refused logins: the coordinator raises it, the watchdog's probe keeps it. */
export const authIncidentKey = (instance: string) => `${instance}:refused`;

/**
 * A held login as the ops channel may have it: which lane's login, on what run, since when, and whether the last check
 * was answered. Never the account (its email, org or the user's login) nor Claude's words, which can name it.
 * WHY (#680): the incident and the notices below are posted to the Discord ops channel, whose readers are whoever is
 * in that channel, not a role on the instance. They take only this, so their text has nothing to name the account
 * with; which account it is, and what Claude said, are on the dashboard (the Machine page, the sign-in banner).
 */
export type OpsHold = Pick<AuthHold, 'lane' | 'role' | 'issue' | 'since'> & { lastCheck: Pick<NonNullable<AuthHold['lastCheck']>, 'at' | 'ok'> | null };

/** Which login, in words that name no account: the lane whose runs use it, and the run it was refused on. */
const whichLogin = (h: OpsHold) => `the ${h.lane} lane's login (refused on a ${h.role} run${h.issue !== null ? ` for #${h.issue}` : ''}, since ${h.since})`;

const CHECK_ACCOUNT = 'Which account it is, and what Claude said, are on the dashboard: check the account on the Machine page';

/** The incident's words for the logins held now (posted to the ops channel too): never the account, never a token. */
export function authIncidentText(holds: readonly OpsHold[]): { detail: string; fix: string; tried: string[] } {
  const checks = holds.flatMap((h) => (h.lastCheck ? [`checked the ${h.lane} lane's login with a minimal real call at ${h.lastCheck.at}: ${h.lastCheck.ok ? 'answered' : 'still refused'}`] : []));
  return {
    detail: `Claude refused ${holds.length === 1 ? 'a login' : `${holds.length} logins`} this instance's runs use: ${holds.map(whichLogin).join('; ')}. No new Claude run starts on it until a call on it succeeds. ${CHECK_ACCOUNT}`,
    fix: `Check the Claude account on the Machine page, and sign the agent user in to Claude again (switch the Claude account, or a new setup-token for that user). It resumes on its own: the login is checked with one tiny real call every ${AUTH_RECHECK_MS / 60_000} minutes, at once after an account switch, or with Re-check on the dashboard`,
    tried: ['paused new Claude runs on that login (dispatch, chat, research, fix runs, evals); tasks requeued, no attempt counted', ...checks],
  };
}

/**
 * The incident's detail for the machine's owners only (Incident.ownerDetail): each held login as Claude names it, with
 * Claude's words and the last check's. Never posted: the ops post reads the incident's `detail` (authIncidentText),
 * and the Health page shows this one to the machine owners alone (src/watchdog/view.ts, #680).
 */
export function authIncidentOwnerDetail(holds: readonly AuthHold[]): string {
  const named = holds.map((h) => `${h.login} (${h.lane} lane, since ${h.since}): ${h.detail.slice(0, 300)}${h.lastCheck && !h.lastCheck.ok ? `; last check at ${h.lastCheck.at}: ${h.lastCheck.detail.slice(0, 120)}` : ''}`).join('; ');
  return `Claude refused ${holds.length === 1 ? 'a login' : `${holds.length} logins`} this instance's runs use: ${named}. No new Claude run starts on it until a call on it succeeds`;
}

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
  lastCheck: { at: string; ok: boolean; detail: string } | null;
}

/**
 * A held login as the sign-in banner gets it (GET /api/usage). The owners and writers get the account as Claude names
 * it and Claude's words, to fix it. A viewer gets that a login was refused, since when, and whether the last check
 * was answered: never which account it is or what Claude said about it (issue #567).
 */
export function signinFailedView(h: AuthHold, full: boolean) {
  const lastCheck = h.lastCheck && (full ? h.lastCheck : { at: h.lastCheck.at, ok: h.lastCheck.ok });
  return full ? { login: h.login, detail: h.detail, since: h.since, lastCheck } : { since: h.since, lastCheck };
}

/** Every login held now: the last claude_auth.failed of each key with no claude_auth.recovered of that key after it. */
export function authHoldsOf(events: StoredEvent[]): AuthHold[] {
  const holds = new Map<string, AuthHold>();
  for (const e of events) {
    const p = e.payload as { key?: string };
    if (typeof p.key !== 'string') continue;
    if (e.type === 'claude_auth.failed') {
      const x = e.payload as { key: string; login: string; detail: string; lane: string; role: string; issue: number | null };
      const was = holds.get(x.key);
      // A second refusal while held keeps the hold's start (and its notice): it is the same outage.
      holds.set(x.key, { key: x.key, login: x.login, detail: x.detail, lane: x.lane, role: x.role, issue: x.issue, since: was?.since ?? e.ts, id: was?.id ?? e.id, lastCheck: was?.lastCheck ?? null });
    } else if (e.type === 'claude_auth.checked') {
      const h = holds.get(p.key);
      const x = e.payload as { ok: boolean; detail: string };
      if (h) h.lastCheck = { at: e.ts, ok: x.ok, detail: x.detail };
    } else if (e.type === 'claude_auth.recovered') holds.delete(p.key);
  }
  return [...holds.values()];
}

/**
 * The ops channel's notices: one when a login is held, one when it works again. Neither names the account (OpsHold,
 * #680): the held notice opens with the hold's own fixed words (SIGN_IN_HOLD_REASON, #567).
 */
export function authHoldPost(h: OpsHold, o: { dashboardUrl?: string | null; instance: string }): string {
  return [
    `**${SIGN_IN_HOLD_REASON}.**`,
    `Instance ${o.instance}: ${whichLogin(h)}. ${CHECK_ACCOUNT}.`,
    `What to do: sign the agent user in to Claude again (switch the Claude account, or a new setup-token for that user). It resumes on its own once a check call on the login succeeds; checked every ${AUTH_RECHECK_MS / 60_000} min, or at once with Re-check on the dashboard.`,
    ...(o.dashboardUrl ? [`${o.dashboardUrl.replace(/\/+$/, '')}/machine`] : []),
  ].join('\n');
}

export function authRecoveredPost(o: { instance: string }): string {
  return `Claude sign-in works again on ${o.instance}: runs start again.`;
}

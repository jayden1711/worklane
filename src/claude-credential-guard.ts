// Issue #711: the dashboard never takes a Claude credential. Anthropic's terms (docs/auth.md quotes them) say a
// developer may not "collect, store, or intermediate Claude.ai credentials or session tokens"; a Claude login is
// installed by root on the machine (credentials.sh), or by a person signing in to the unmodified
// `claude` there, and the engine only ever passes paths.
//
// So every request body the dashboard reads goes through this first: one that holds a token from `claude
// setup-token`, or the one-time code Anthropic's sign-in page shows to paste, is refused before any route sees it,
// whatever the route. Nothing is stored, and the refusal is a fixed text that never quotes the value.
import { userFacing } from './user-facing-error.js';

/** A token from `claude setup-token` (sk-ant-oat01-...), anywhere in a string. */
const SETUP_TOKEN_IN = /sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20}/;
/** The code Anthropic's sign-in page shows to paste back (<code>#<state>), as a whole value. */
const LOGIN_CODE_VALUE = /^[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,}$/;

export const CREDENTIAL_REFUSED =
  "that holds a Claude credential (a setup token, or a sign-in code), and the dashboard never takes one: install it at a root shell on the machine (credentials.sh <name> claude), or sign in there as the agent user; nothing was stored";


/**
 * The routes earlier versions took a Claude credential on: a switch's token, a new profile's token, a relayed
 * sign-in's code. Each answers 410 Gone to anyone, its body never read, so an older page (or anything else) learns the
 * way now is a root shell on the machine.
 */
export const REMOVED_CREDENTIAL_PATHS: ReadonlySet<string> = new Set(['/api/claude-account/token', '/api/claude-account/profile-add', '/api/claude-account/login-code']);
export const CREDENTIAL_ROUTE_GONE =
  "the dashboard no longer takes a Claude credential: a root admin installs one on the machine (sudo bash credentials.sh <name> claude), or signs in there as the agent user (sudo -u <agent user> -i claude auth login). See docs/auth.md";

/**
 * The credential names earlier versions had the dashboard store a Claude credential under (add-project's token, a
 * switch's token, a new profile's token, a relayed sign-in's code): the file's name in a secrets dir, and a
 * paste_secret ask's credential. No paste box writes one any more; claude-account.sh removes any left behind, the
 * coordinator withdraws an ask for one at startup, and none is ever answerable.
 */
export const CLAUDE_CREDENTIAL_NAMES: ReadonlySet<string> = new Set(['claude-token', 'claude-account-token', 'claude-profile-token', 'claude-login-code']);

/** Why the coordinator withdrew such an ask: a fixed text (an ask's event never holds a value). */
export const CLAUDE_ASK_WITHDRAWN =
  'issue #711: the dashboard never takes a Claude credential; a root admin installs it on the machine (sudo bash credentials.sh <name> claude), or signs in there as the agent user. See docs/auth.md';

/** Whether a value (a parsed JSON body, any depth) holds a Claude credential: in a string value, or a key. */
export function holdsClaudeCredential(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return SETUP_TOKEN_IN.test(v) || LOGIN_CODE_VALUE.test(v.trim());
  // Deeper than any body a route takes: refused rather than left unread.
  if (depth > 32) return true;
  if (Array.isArray(v)) return v.some((x) => holdsClaudeCredential(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, x]) => holdsClaudeCredential(k, depth + 1) || holdsClaudeCredential(x, depth + 1));
  return false;
}

/**
 * Throw a 400 with CREDENTIAL_REFUSED when the value holds a Claude credential; else return it as it is. It is a
 * UserFacingError (src/user-facing-error.ts), so the dashboard's outer catch shows the page the refusal (issue #864).
 */
export function refuseClaudeCredential<T>(v: T): T {
  if (holdsClaudeCredential(v)) throw userFacing(400, CREDENTIAL_REFUSED);
  return v;
}

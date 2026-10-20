// Issue #864: what a dashboard (or hub) error answer may say.
//
// The dashboard's outer catch once answered every error with its message, so a readFileSync failure gave the page
// `EACCES: permission denied, open '/<instance home>/policy.yaml'`, and any raw message (a file's text in a parse
// error, a child process's stderr) could follow. Now the catch shows the text of one kind of error only, this one, and
// answers anything else with a fixed text, the detail logged (redacted) on the machine.
//
// INVARIANT: a UserFacingError's text is one of USER_FACING_TEXTS below, a closed set kept in this file. userFacing()
// checks it at run time and throws on any other text, so a value read at run time never becomes one, whatever its
// static type says (an `any`, an explicit type argument, a cast, array covariance, Object.assign, a lying predicate:
// TypeScript's types can be talked round, so the type below is a convenience and the run-time set is the guarantee).
// The constructor takes a key only this module holds, so nothing else (a subclass, a caller) makes one; and shown()
// reads private fields, so a forged object, or a message changed after the fact, shows nothing of its own. A new text
// for the page is a new entry here, which review sees.
import { redactString } from './events/redact.js';

/** Every text a UserFacingError may carry: the whole set. Frozen; the run-time check below reads a private copy. */
export const USER_FACING_TEXTS = Object.freeze({
  /** readBody: a request body over its cap. */
  bodyTooLarge: 'body too large',
  /** readBody: a request body that isn't JSON (JSON.parse's own message quotes the body back). */
  bodyNotJson: "the request body isn't JSON",
  /** Issue #711: a request body that holds a Claude credential (src/claude-credential-guard.ts). */
  claudeCredentialRefused:
    "that holds a Claude credential (a setup token, or a sign-in code), and the dashboard never takes one: install it at a root shell on the machine (credentials.sh <name> claude), or sign in there as the agent user; nothing was stored",
} as const);

/** One of the vetted texts. */
export type UserFacingText = (typeof USER_FACING_TEXTS)[keyof typeof USER_FACING_TEXTS];

/** The run-time copy of the set: module-private, so nothing outside this file can add to it. */
const VETTED: ReadonlySet<string> = new Set<string>(Object.values(USER_FACING_TEXTS));

const KEY: unique symbol = Symbol('user-facing-error');

/** The text, once the key is this module's, the status an error's (400-599) and the text a vetted one; else a throw. */
function checked(key: symbol, status: number, text: unknown): string {
  if (key !== KEY) throw new TypeError('a UserFacingError is made only by userFacing(), from vetted text');
  if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError(`a UserFacingError's status is 400-599, not ${status}`);
  // Never quotes the text: it may be anything (a path, a token) that reached here around the type.
  if (typeof text !== 'string' || !VETTED.has(text)) throw new TypeError('userFacing: the text is not one of USER_FACING_TEXTS (src/user-facing-error.ts)');
  return text;
}

/**
 * T when it is a string literal type; never when it is `string` (a value read at run time) or a template literal type
 * with a hole in it (`open ${string}`: what `open ${path}` infers to). A type with a hole maps to an index signature,
 * which `{}` satisfies; a literal maps to a required key, which it doesn't. Distributed, so a union with one holed
 * member is refused too. A compile-time convenience only: the run-time set is the guarantee.
 */
export type VettedText<T extends string> = T extends unknown ? ({} extends Record<T, 1> ? never : T) : never;

export class UserFacingError extends Error {
  readonly #status: number;
  readonly #text: string;

  constructor(key: typeof KEY, status: number, text: string) {
    super(checked(key, status, text));
    this.name = 'UserFacingError';
    this.#status = status;
    this.#text = text;
  }

  /** What the page is shown for this error: its status and vetted text; null for anything else, a forgery included. */
  static shown(e: unknown): { status: number; text: string } | null {
    return typeof e === 'object' && e !== null && #text in e ? { status: (e as UserFacingError).#status, text: (e as UserFacingError).#text } : null;
  }
}

/**
 * An error whose text the page is shown, with its status (400-599). The text must be one of USER_FACING_TEXTS: any
 * other throws a TypeError, which an outer catch answers as the fixed 500.
 */
export function userFacing<const T extends UserFacingText>(status: number, text: VettedText<T>): UserFacingError {
  return new UserFacingError(KEY, status, text);
}

/** What an error answer says when the error isn't one meant for the page: never its message. */
export const INTERNAL_ERROR_TEXT = 'the dashboard hit an internal error; the detail is in its log on the machine';

/**
 * A server's last answer to an error (the dashboard's and the hub's request handlers): a UserFacingError's status and
 * vetted text, and for anything else a 500 with INTERNAL_ERROR_TEXT. The detail (which may name a path under the
 * instance home, a file's text or a child's stderr) goes to the server's own log on the machine only, through the
 * shared redactor (src/events/redact.ts), and names the route by method and path, never the query, which can hold a key.
 */
export function errorAnswer(e: unknown, req: { method?: string | undefined }, pathname: string, log: (line: string) => void = (l) => console.error(l)): { status: number; body: { error: string } } {
  const shown = UserFacingError.shown(e);
  if (shown) return { status: shown.status, body: { error: shown.text } };
  try {
    log(redactString(`${req.method ?? '?'} ${pathname} failed: ${e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e)}`));
  } catch {
    // A log (or a thrown value's own stack or toString) that throws never turns the fixed answer into a crash.
  }
  return { status: 500, body: { error: INTERNAL_ERROR_TEXT } };
}

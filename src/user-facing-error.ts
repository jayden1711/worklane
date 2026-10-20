// Issue #864: what a dashboard error answer may say.
//
// The dashboard's outer catch once answered every error with its message, so a readFileSync failure gave the page
// `EACCES: permission denied, open '/<instance home>/policy.yaml'`, and any raw message (a file's text in a parse
// error, a child process's stderr) could follow. Now the catch shows the text of one kind of error only, this one, and
// answers anything else with a fixed text, the detail logged on the machine.
//
// INVARIANT: a UserFacingError's text is vetted: a string literal in the source (or a const holding one), never a
// value read at run time. userFacing()'s type takes only a literal type, so a message, a path or a template with a
// value in it does not compile; the constructor takes a key only this module holds, so nothing else (a subclass, a
// caller) makes one; and shown() reads private fields, so a forged object, or a message changed after the fact, shows
// nothing of its own. The one way around it is a visible cast (`x as 'text'`), which review sees.

const KEY: unique symbol = Symbol('user-facing-error');

/** The text, once the key is this module's and the status an error's (400-599); else a throw, before anything is made. */
function checked(key: symbol, status: number, text: string): string {
  if (key !== KEY) throw new TypeError('a UserFacingError is made only by userFacing(), from vetted text');
  if (!Number.isInteger(status) || status < 400 || status > 599) throw new RangeError(`a UserFacingError's status is 400-599, not ${status}`);
  return text;
}

/**
 * T when it is a string literal type; never when it is `string` (a value read at run time) or a template literal type
 * with a hole in it (`open ${string}`: what `open ${path}` infers to). A type with a hole maps to an index signature,
 * which `{}` satisfies; a literal maps to a required key, which it doesn't. Distributed, so a union with one holed
 * member is refused too.
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

/** An error whose text the dashboard shows the page, with its status (400-599). The text must be a string literal. */
export function userFacing<const T extends string>(status: number, text: VettedText<T>): UserFacingError {
  return new UserFacingError(KEY, status, text);
}

// Issue #864: the only error whose text the dashboard's outer catch shows is a UserFacingError, and its text is one of
// the closed set USER_FACING_TEXTS (src/user-facing-error.ts), checked at run time. The literal-only type is a
// convenience on top; test/user-facing-error-probes.test.ts drives the ways around the type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_FACING_TEXTS, UserFacingError, userFacing } from '../src/user-facing-error.js';
import { CREDENTIAL_REFUSED } from '../src/claude-credential-guard.js';

test('#864: userFacing makes an error the outer catch shows: its status and its vetted text', () => {
  const e = userFacing(413, 'body too large');
  assert.ok(e instanceof Error);
  assert.deepEqual(UserFacingError.shown(e), { status: 413, text: 'body too large' });
  assert.equal(e.message, 'body too large', 'the message is the text, for logs and stacks');
  for (const text of Object.values(USER_FACING_TEXTS)) assert.equal(UserFacingError.shown(userFacing(400, text))?.text, text, 'every text in the set is one');
  assert.equal(CREDENTIAL_REFUSED, USER_FACING_TEXTS.claudeCredentialRefused, "#711's refusal is in the set");
});

test('#864: the set is closed: frozen, and a text added to it at run time is still refused', () => {
  assert.ok(Object.isFrozen(USER_FACING_TEXTS));
  assert.throws(() => {
    (USER_FACING_TEXTS as unknown as Record<string, string>).sneaky = "EACCES: permission denied, open '/x/y'";
  }, TypeError);
  assert.throws(() => userFacing(500, "EACCES: permission denied, open '/x/y'" as 'body too large'), /not one of USER_FACING_TEXTS/);
  // A String object holding a vetted text is not the text.
  assert.throws(() => userFacing(500, new String('body too large') as unknown as 'body too large'), /not one of USER_FACING_TEXTS/);
});

test('#864: the type, a convenience: a value read at run time, or a template with one in it, does not compile', () => {
  // Each line below must fail to compile (an unused @ts-expect-error fails the build), so the function is never run.
  const neverRun = (fromDisk: string, e: Error, loose: any, n: number, either: 'body too large' | `open ${string}`) => {
    // @ts-expect-error a template with a number in it is not a literal either
    userFacing(500, `try again in ${n} s`);
    // @ts-expect-error a union with one holed member is refused whole
    userFacing(500, either);
    // @ts-expect-error a plain string (a file's text, a path) is not vetted text
    userFacing(500, fromDisk);
    // @ts-expect-error a caught error's message is a string, not vetted text
    userFacing(500, e.message);
    // @ts-expect-error a template with a value in it is a string, not a literal
    userFacing(500, `could not open ${fromDisk}`);
    // @ts-expect-error nor is any
    userFacing(500, loose);
    // @ts-expect-error a literal that isn't in the set
    userFacing(500, 'a text nobody vetted');
  };
  void neverRun;
  const fixed = 'body too large';
  assert.equal(UserFacingError.shown(userFacing(400, fixed))?.text, fixed, 'a const holding a vetted literal is one');
  assert.equal(UserFacingError.shown(userFacing(400, `body too large`))?.text, 'body too large');
});

test("#864: nothing but userFacing makes one: not the constructor, a subclass or the prototype's shape", () => {
  // @ts-expect-error the constructor's first argument is a module-private key
  assert.throws(() => new UserFacingError(Symbol('key'), 500, 'body too large'), /made only by userFacing/);
  class Sneaky extends UserFacingError {
    constructor() {
      // @ts-expect-error a subclass has no key either
      super(Symbol('key'), 500, 'body too large');
    }
  }
  assert.throws(() => new Sneaky(), /made only by userFacing/);
  const forged = Object.create(UserFacingError.prototype) as UserFacingError;
  assert.ok(forged instanceof UserFacingError, 'instanceof alone would pass a forgery');
  assert.equal(UserFacingError.shown(forged), null, 'shown() checks the private field, so a forgery is shown as nothing');
  for (const other of [new Error('EACCES: permission denied, open /x'), { status: 400, message: 'x' }, 'text', null, undefined]) assert.equal(UserFacingError.shown(other), null);
});

test('#864: changing message after it is made changes nothing the page sees', () => {
  const e = userFacing(400, "the request body isn't JSON");
  e.message = "ENOENT: no such file or directory, open '/x/y'";
  assert.deepEqual(UserFacingError.shown(e), { status: 400, text: "the request body isn't JSON" });
});

test('#864: a status outside 400-599 is refused (fail closed: a vetted text is an error answer)', () => {
  for (const status of [200, 302, 399, 600, 450.5, Number.NaN]) assert.throws(() => userFacing(status, 'body too large'), /status/, String(status));
});

// Issue #864: the only error whose text the dashboard's outer catch shows is a UserFacingError, made only from
// vetted text: a string literal in the source, never a value read at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserFacingError, userFacing } from '../src/user-facing-error.js';

test('#864: userFacing makes an error the outer catch shows: its status and its literal text', () => {
  const e = userFacing(413, 'body too large');
  assert.ok(e instanceof Error);
  assert.deepEqual(UserFacingError.shown(e), { status: 413, text: 'body too large' });
  assert.equal(e.message, 'body too large', 'the message is the text, for logs and stacks');
});

test('#864: only a string literal type is vetted text; a value read at run time, or a template with one in it, does not compile', () => {
  // The guarantee is the type: each line below must fail to compile (an unused @ts-expect-error fails the build), so
  // the function is never run.
  const neverRun = (fromDisk: string, e: Error, loose: any, n: number, either: 'fixed' | `open ${string}`) => {
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
  };
  void neverRun;
  const fixed = 'a fixed text';
  assert.equal(UserFacingError.shown(userFacing(400, fixed))?.text, fixed, 'a const holding a literal is one');
  assert.equal(UserFacingError.shown(userFacing(400, `a template with no value`))?.text, 'a template with no value');
});

test("#864: nothing but userFacing makes one: not the constructor, a subclass or the prototype's shape", () => {
  // @ts-expect-error the constructor's first argument is a module-private key
  assert.throws(() => new UserFacingError(Symbol('key'), 500, 'x'), /made only by userFacing/);
  class Sneaky extends UserFacingError {
    constructor() {
      // @ts-expect-error a subclass has no key either
      super(Symbol('key'), 500, 'x');
    }
  }
  assert.throws(() => new Sneaky(), /made only by userFacing/);
  const forged = Object.create(UserFacingError.prototype) as UserFacingError;
  assert.ok(forged instanceof UserFacingError, 'instanceof alone would pass a forgery');
  assert.equal(UserFacingError.shown(forged), null, 'shown() checks the private field, so a forgery is shown as nothing');
  for (const other of [new Error('EACCES: permission denied, open /x'), { status: 400, message: 'x' }, 'text', null, undefined]) assert.equal(UserFacingError.shown(other), null);
});

test('#864: changing message after it is made changes nothing the page sees', () => {
  const e = userFacing(400, 'the vetted text');
  e.message = "ENOENT: no such file or directory, open '/x/y'";
  assert.deepEqual(UserFacingError.shown(e), { status: 400, text: 'the vetted text' });
});

test('#864: a status outside 400-599 is refused (fail closed: a vetted text is an error answer)', () => {
  for (const status of [200, 302, 399, 600, 450.5, Number.NaN]) assert.throws(() => userFacing(status, 'x'), /status/, String(status));
});

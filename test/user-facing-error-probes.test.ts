// Issue #864, round 2: every way the #879 review measured around the literal-only type (none of them a cast but the
// last two), driven at run time. Each throws in userFacing (the text isn't in the closed set USER_FACING_TEXTS), so
// the outer catch answers the fixed 500 and the page never sees the run-time text.
// And the server log's line goes through the shared redactor: a token in a thrown message is never logged as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorAnswer, INTERNAL_ERROR_TEXT, userFacing } from '../src/user-facing-error.js';

const PATH = "EACCES: permission denied, open '/home/example/.instance/policy.yaml'";
const body = JSON.stringify({ msg: PATH, k: PATH });

/** What the page gets when a handler runs `make` and throws its result, as the outer catch answers it. */
function answered(make: () => unknown): { status: number; body: { error: string } } {
  try {
    throw make();
  } catch (e) {
    return errorAnswer(e, { method: 'GET' }, '/api/x', () => {});
  }
}

const probes: [string, () => unknown][] = [
  // P12/P13: an explicit type argument, and any `any` value.
  ['an explicit type argument with a JSON.parse value', () => userFacing<'body too large'>(500, (JSON.parse(body) as { msg: any }).msg)],
  // Q40/Q41: an annotation on a parse result.
  [
    'an annotated parse result',
    () => {
      const x: { msg: 'body too large' } = JSON.parse(body);
      return userFacing(500, x.msg);
    },
  ],
  // Q23: array covariance.
  [
    'array covariance',
    () => {
      const a: 'body too large'[] = ['body too large'];
      const w: string[] = a;
      w[0] = PATH;
      return userFacing(500, a[0]!);
    },
  ],
  // Q30: Object.assign onto a literal-typed object.
  ['Object.assign over a literal', () => userFacing(500, Object.assign({ t: 'body too large' as const }, { t: PATH }).t)],
  // Q36: Object.assign onto a holder typed with the literal.
  [
    'Object.assign onto a typed holder',
    () => {
      const holder: { t: 'body too large' } = { t: 'body too large' };
      Object.assign(holder, { t: PATH });
      return userFacing(500, holder.t);
    },
  ],
  // P21: a type predicate that lies.
  [
    'a lying type predicate',
    () => {
      const isFixed = (x: string): x is 'body too large' => x.length > 0;
      const s: string = PATH;
      return isFixed(s) ? userFacing(500, s) : null;
    },
  ],
  // P22: an assertion function that lies.
  [
    'a lying assertion function',
    () => {
      function assertFixed(x: string): asserts x is 'body too large' {
        if (!x) throw new Error('empty');
      }
      const s: string = PATH;
      assertFixed(s);
      return userFacing(500, s);
    },
  ],
  // P24: a Record lookup.
  [
    'a Record<string, literal> lookup',
    () => {
      const r: Record<string, 'body too large'> = JSON.parse(body);
      return userFacing(500, r.k!);
    },
  ],
  // Q38: a Map lookup.
  ['a Map<string, literal> lookup', () => userFacing(500, new Map<string, 'body too large'>(Object.entries(JSON.parse(body))).get('msg')!)],
  // Q39: a parameter typed as the literal, filled by its caller.
  [
    'a parameter typed as the literal',
    () => {
      const make = (t: 'body too large') => userFacing(500, t);
      const fromBody: any = JSON.parse(body).msg;
      return make(fromBody);
    },
  ],
  // P18: a function whose declared return type is the literal.
  [
    'a function declared to return the literal',
    () => {
      const lie = (): 'body too large' => JSON.parse(body).msg;
      return userFacing(500, lie());
    },
  ],
  // P17/P29: the visible casts.
  ['a cast', () => userFacing(500, PATH as 'body too large')],
  ['a double cast', () => userFacing(500, (JSON.parse(body) as unknown as { msg: 'body too large' }).msg)],
];

for (const [name, make] of probes) {
  test(`#864 round 2: ${name} never reaches the page: userFacing refuses the run-time text, and the answer is the fixed 500`, () => {
    assert.throws(make, /not one of USER_FACING_TEXTS/, 'userFacing throws on a text outside the set');
    const a = answered(make);
    assert.deepEqual(a, { status: 500, body: { error: INTERNAL_ERROR_TEXT } });
    assert.ok(!JSON.stringify(a).includes('/home/example'), JSON.stringify(a));
  });
}

test('#864 round 2: the refusal never quotes the text it refused', () => {
  assert.throws(
    () => userFacing(500, PATH as 'body too large'),
    (e: Error) => /not one of USER_FACING_TEXTS/.test(e.message) && !e.message.includes('/home/example') && !String(e.stack).includes('/home/example'),
  );
});

test('#864 round 2: the logged line goes through the shared redactor: a GitHub or Claude token in a thrown message is never logged', () => {
  const ghp = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const oat = `sk-ant-oat01-${'Zy9_xW8-'.repeat(5)}`;
  const lines: string[] = [];
  const a = errorAnswer(new Error(`git push failed: https://x:${ghp}@github.com/o/r and ${oat} at ${PATH}`), { method: 'POST' }, '/api/x', (l) => void lines.push(l));
  assert.deepEqual(a, { status: 500, body: { error: INTERNAL_ERROR_TEXT } });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes(ghp) && !lines[0]!.includes(oat), lines[0]);
  assert.ok(!lines[0]!.includes('A1b2C3d4E5') && !lines[0]!.includes('Zy9_xW8'), `no part of either token: ${lines[0]}`);
  assert.ok(lines[0]!.includes('/home/example/.instance/policy.yaml'), 'the detail (a path) stays in the log on the machine');
  assert.ok(lines[0]!.includes('POST /api/x'));
  // A thrown string (not an Error) too.
  const more: string[] = [];
  errorAnswer(`token ${ghp}`, { method: 'GET' }, '/api/y', (l) => void more.push(l));
  assert.ok(!more[0]!.includes(ghp), more[0]);
});

// The redactor on the edges of its inputs: empty and one-character texts, a lone `$` and `$$`/`$&`/`$1` as text, a
// marker's own characters, keys read past their end (a one-letter key, a key that ends the text), private-use
// characters (freeMark's own range), fences with nothing after the opener, the setup pages' own lines (the first-run
// checklist, gh's and Claude Code's sign-in output), dashboard keys of every shape, and non-strings where a string is
// typed, through every export. The answers are a fixture recorded from the module (test/fixtures/redact-edges.json,
// the same on the round-15 and round-16 heads: 480,000 random cases and these differ in nothing); a change to any is a
// behaviour change review reads here. Each call must also answer promptly: a scan that fails to advance (an empty
// separator, an index that stays) would hang, so the corpus is run under a time budget. Round 16's wizard run failed
// from the config draft on with the redactor as the only change (run 43228960885); this test is the unit-level check of
// the class the organizer named (a value with an index past a string's end, an empty string, a non-string).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDashboardKey, readWindow, redact, redactClip, redactCut, redactRecords, redactString, secretKinds, TRACKER } from '../src/events/redact.js';
import { repoRoot } from './helpers.js';

interface Row {
  s: string;
  modes: string[];
  kinds: string[];
  window: string[];
  clip: { text: string; more: number };
  cut: string;
  records: string[];
  key: boolean;
}
interface Fixture {
  modes: Parameters<typeof redactString>[1][];
  rows: Row[];
  odd: [unknown, unknown][];
  nonStrings: Record<string, string>[];
}
/** A run of `seed` cut to `n` characters: the secret-shaped values are built here, never written out (the push gate's gitleaks reads a fixture as code). */
const run = (n: number, seed: string): string => {
  let s = '';
  while (s.length < n) s += seed;
  return s.slice(0, n);
};
/** The fixture's placeholders and the values they stand for: the keys, the token line, the PEM lines, the Basic pair, the dashboard key. */
const PLACE: [string, string][] = [
  ['\u00abKEY\u00bb', ['sk', 'live', run(46, 'Hq8Xk2Lm9Tb4Wp7Rv3Ny6Hc')].join('_')],
  ['\u00abV\u00bb', run(20, 'Zq81Xk2Lm9Tb4Wp7Rv3N')],
  ['\u00abGHO\u00bb', ['gho', '*'.repeat(36)].join('_')],
  ['\u00abPEM\u00bb', ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')],
  ['\u00abPEMEND\u00bb', ['-----END', 'RSA PRIVATE KEY-----'].join(' ')],
  ['\u00abBASIC\u00bb', Buffer.from('user:pass').toString('base64')],
  ['\u00abWLD\u00bb', ['wld', run(42, 'Ab3')].join('_')],
];
const decode = (v: unknown): unknown => (typeof v === 'string' ? PLACE.reduce((s, [ph, raw]) => s.split(ph).join(raw), v) : Array.isArray(v) ? v.map(decode) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [decode(k), decode(x)])) : v);
const FIXTURE = decode(JSON.parse(readFileSync(join(repoRoot, 'test', 'fixtures', 'redact-edges.json'), 'utf8'))) as Fixture;

const pictureOf = (s: string): Row => ({
  s,
  modes: FIXTURE.modes.map((o) => redactString(s, o)),
  kinds: secretKinds(s),
  window: [0, 1, 3, s.length].map((e) => readWindow(s, e)),
  clip: redactClip(s, 3),
  cut: redactCut(s, 3),
  records: redactRecords([s, '', s], TRACKER),
  key: isDashboardKey(s),
});

test('every export answers each edge input as recorded, and the whole corpus within a second', () => {
  assert.ok(FIXTURE.rows.length >= 59, 'the corpus');
  assert.ok(FIXTURE.rows.some((r) => r.s === '') && FIXTURE.rows.some((r) => r.s === '$') && FIXTURE.rows.some((r) => r.s === 'API_KEY') && FIXTURE.rows.some((r) => r.s.includes('apiKey')), 'the edges are in it');
  const t0 = performance.now();
  for (const row of FIXTURE.rows) assert.deepEqual(pictureOf(row.s), row, JSON.stringify(row.s));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `the corpus took ${ms.toFixed(0)} ms`);
});

test('redact() over non-strings and nested values (null, numbers, booleans, empty arrays and objects, a key that is empty, markers as values) answers as recorded', () => {
  const v = run(20, 'Zq81Xk2Lm9Tb4Wp7Rv3N');
  const odd: unknown[] = [null, undefined, 0, 1.5, true, [], {}, [''], { '': '' }, { API_KEY: v }, { a: [null, 1, { token: v, n: 2 }] }, ['$', '$$', '$&']];
  assert.equal(odd.length, FIXTURE.odd.length);
  // undefined has no JSON form: compared through JSON as the fixture was written.
  odd.forEach((v, i) => assert.deepEqual(JSON.parse(JSON.stringify([redact(v), redact(v, TRACKER)]) ?? 'null'), JSON.parse(JSON.stringify(FIXTURE.odd[i]) ?? 'null'), String(i)));
});

test('a non-string where a string is typed (a JavaScript caller): the same answer or the same error as recorded, never a hang', () => {
  const nonStr: unknown[] = [123, 0, null, undefined, true, {}, [], ['a'], { length: 3 }];
  assert.equal(nonStr.length, FIXTURE.nonStrings.length);
  const probe = (v: unknown): Record<string, string> => {
    const r: Record<string, string> = {};
    const s = v as string;
    for (const [n, f] of [['redactString', () => redactString(s)], ['secretKinds', () => secretKinds(s)], ['readWindow', () => readWindow(s, 2)], ['redactClip', () => redactClip(s, 3)], ['redactRecords', () => redactRecords([s])], ['isDashboardKey', () => isDashboardKey(s)], ['redact', () => redact(v)]] as const) {
      try {
        const x = f();
        r[n] = JSON.stringify(x) ?? String(x);
      } catch (e) {
        r[n] = `THROW ${(e as Error).constructor.name}`;
      }
    }
    return r;
  };
  nonStr.forEach((v, i) => assert.deepEqual(probe(v), FIXTURE.nonStrings[i], String(i)));
});

test('the answers hold with index properties and symbol methods defined on String.prototype after load', () => {
  const keys = ['-1', ...Array.from({ length: 300 }, (_, i) => `${i}`)];
  const before = FIXTURE.rows.map((r) => pictureOf(r.s));
  for (const k of keys) Object.defineProperty(String.prototype, k, { configurable: true, writable: true, value: 'a' });
  Object.defineProperty(String.prototype, Symbol.split, { configurable: true, writable: true, value: () => ['LEAK'] });
  let after: Row[];
  try {
    after = FIXTURE.rows.map((r) => pictureOf(r.s));
  } finally {
    for (const k of keys) delete (String.prototype as unknown as Record<string, unknown>)[k];
    delete (String.prototype as unknown as Record<symbol, unknown>)[Symbol.split];
  }
  assert.deepEqual(after, before);
});

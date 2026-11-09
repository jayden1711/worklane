// #941: the tables of src/ and scripts/ are data (src/check-tables.ts): loaded deep-frozen, so no code can change one
// after load. The write shapes R1184g-j found against the line reader (a member write, a callback's array, a replacer, an
// entry changed through an index or a for...of, delete, a shadowed built-in, a template's ${}, a namespace member, a
// RegExp's compile) each throw here against a real loaded table, or have nothing to write to. The two loaders (src/ and
// scripts/lib/) give the same answers on every tables file in the repo, and refuse the same bad files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { parseTables, regExpOf, TABLES_FILE, tablesFrom, tablesOf, type Pattern } from '../src/check-tables.js';
import * as review from '../src/review.js';
import { BUILTIN_PROTECTED } from '../src/guardrails/engine.js';
import { GIT_GUARD_PAIRS } from '../src/os/git.js';
import { REDACTION_PATTERNS, redactString } from '../src/events/redact.js';
import { repoRoot } from './helpers.js';

type Loader = { tablesFrom(text: string, file: string, fill?: (s: string) => string): { names: readonly string[]; get(n: string): unknown }; parseTables(text: string, file: string): Map<string, unknown> };
const scripts = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'check-tables.mjs')).href)) as Loader;
const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter((f) => TABLES_FILE.test(f));

/** A tables file's text with one table, `value` its data. */
const one = (value: unknown, kind = 'never-shrink') => JSON.stringify({ T: { '//': 'a probe', kind, value } });

/** Each throws a TypeError (strict mode: a write to a frozen object throws). */
function refused(label: string, write: () => unknown) {
  assert.throws(write, TypeError, `${label}: not refused`);
}

test('a loaded table is deep-frozen: a list, an object, a set and a pattern can\'t change, at any depth (#941)', () => {
  const t = tablesFrom(one({ list: ['a', ['b']], set: { $set: ['c'] }, re: { $regexp: 'x', flags: 'g' } }), 'probe.tables.json').get<{ list: (string | string[])[]; set: ReadonlySet<string>; re: Pattern }>('T');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.list) && Object.isFrozen(t.list[1]) && Object.isFrozen(t.re));
  refused('push', () => t.list.push('z'));
  refused('length = 0', () => (t.list.length = 0));
  refused('index write', () => ((t.list as string[])[0] = 'z'));
  refused('nested write', () => ((t.list[1] as string[]).length = 0));
  refused('delete', () => delete (t as Record<string, unknown>).list);
  refused('new key', () => ((t as Record<string, unknown>).extra = 1));
  assert.equal((t.set as unknown as { add?: unknown }).add, undefined, 'a FrozenSet has no add');
  refused('Set.prototype.add on it', () => Set.prototype.add.call(t.set as unknown as Set<string>, 'z'));
  refused('Set.prototype.clear on it', () => Set.prototype.clear.call(t.set as unknown as Set<string>));
  refused('its method replaced', () => ((t.set as unknown as Record<string, unknown>).has = () => false));
  assert.deepEqual([t.set.has('c'), t.set.size, [...t.set]], [true, 1, ['c']]);
  assert.ok(!(t.re instanceof RegExp), 'a pattern is data, not a RegExp');
  refused('RegExp.prototype.compile on a pattern', () => RegExp.prototype.compile.call(t.re as unknown as RegExp, '$^'));
  assert.ok(regExpOf(t.re).test('x') && regExpOf(t.re) !== regExpOf(t.re), 'regExpOf makes a new RegExp each time');
});

test("the R1184g-j write shapes, against real loaded tables, each throw (#941)", () => {
  const odd = review.ODD_PATH_CATEGORIES as string[];
  const locked = review.LOCKED_CATEGORIES as Record<string, string[]>;
  const parts = review.SELF_MODIFICATION_PARTS as { what: string; globs: string[] }[];
  refused('H4a length *= 0', () => (odd.length *= 0));
  refused("H4b ['splice'](0)", () => (odd as unknown as Record<string, (n: number) => void>)['splice']!(0));
  refused('H4c Array.prototype.splice.call', () => Array.prototype.splice.call(odd, 0, 9));
  refused('H4d splice?.(0)', () => odd.splice?.(0));
  refused('H4e an alias, then a write', () => {
    const all = odd;
    all.length = 0;
  });
  refused('I1 a write in a template', () => `${odd.splice(0)}`);
  refused("I2 a read member's callback empties its array", () => odd.some((_, i, a) => void a.splice(0)));
  refused('I3 a JSON.stringify replacer', () => JSON.stringify(odd, (k, v) => (k === '' && (v as string[]).splice(0), v)));
  refused('I4 an entry changed through an index', () => (parts[0]!.globs.length = 0));
  refused('I4 an entry changed through at()', () => parts.at(0)!.globs.splice(0));
  refused('I4 an entry changed in a for...of', () => {
    for (const p of parts) p.globs.length = 0;
  });
  refused('J4 delete T[k]', () => delete locked[review.SELF_MODIFICATION]);
  refused('J5 Object.values(T).forEach(a => a.splice(0))', () => Object.values(locked).forEach((a) => a.splice(0)));
  refused('J1 a member of the module object', () => ((review as unknown as { ODD_PATH_CATEGORIES: string[] }).ODD_PATH_CATEGORIES.length = 0));
  refused('J3 a shadowed built-in that splices what it is given', () => {
    class Set {
      constructor(a: string[]) {
        a.splice(0);
      }
    }
    return new Set(odd);
  });
  refused('a key added to an object table', () => (locked['loosened'] = []));
  refused('another module\'s table (the guard\'s)', () => (BUILTIN_PROTECTED as string[]).pop());
  refused('a pair of the git guard', () => ((GIT_GUARD_PAIRS[0] as unknown as string[])[1] = 'store'));
  // J5's compile: the redaction patterns handed out are copies, so compiling one changes nothing the redactor runs.
  const token = `ghp_${'a'.repeat(36)}`;
  for (const p of REDACTION_PATTERNS) p.re.compile('$^');
  assert.equal(redactString(`x ${token} y`), 'x gh*_[REDACTED] y', 'the redactor runs its own RegExps');
});

test('the two loaders give the same tables, deep-frozen, for every tables file in the repo (#941)', () => {
  const fill = (s: string) => s.split('{configDir}').join(BRAND.configDir).split('{cli}').join(BRAND.cli);
  const shape = (v: unknown): unknown => (v instanceof Object && Symbol.iterator in v && !Array.isArray(v) ? { set: [...(v as Iterable<unknown>)].map(shape) } : Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v);
  assert.equal(files.length, 16, `${files.length} tables files`);
  for (const f of files) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    const [a, b] = [tablesFrom(text, f), scripts.tablesFrom(text, f, fill)];
    assert.deepEqual(b.names, a.names, f);
    for (const n of a.names) {
      assert.deepEqual(shape(b.get(n)), shape(a.get(n)), `${f} ${n}`);
      assert.ok(Object.isFrozen(a.get(n)) && Object.isFrozen(b.get(n)), `${f} ${n} frozen`);
    }
  }
});

test('both loaders, and so the hold, refuse a file that is not a tables file (#941)', () => {
  const bad: [string, string][] = [
    ['not JSON', '{'],
    ['a list, not an object', '[]'],
    ['a name that is no table name', JSON.stringify({ 'not-a-name': { kind: 'never-shrink', value: [] } })],
    ['no kind', JSON.stringify({ T: { value: [] } })],
    ['another kind', JSON.stringify({ T: { kind: 'never-change', value: [] } })],
    ['a key besides kind and value', JSON.stringify({ T: { kind: 'never-shrink', value: [], extra: 1 } })],
    ['a tag not listed', one({ $function: 'x => x' })],
    ['a set that is not a list', one({ $set: 'abc' })],
    ['a tagged set with more', one({ $set: [], more: 1 })],
    ["a regexp that doesn't compile", one({ $regexp: '(', flags: '' })],
    ['flags not among dgimsuvy', one({ $regexp: 'x', flags: 'q' })],
    ['a number that is not finite', '{"T": {"kind": "never-shrink", "value": [1e400]}}'],
    ['a -0', '{"T": {"kind": "never-shrink", "value": [-0]}}'],
    ['another kind still', JSON.stringify({ T: { kind: 'never-loosen', value: [] } })],
  ];
  for (const [label, text] of bad) {
    assert.throws(() => parseTables(text, 'bad.tables.json'), Error, `src: ${label}`);
    assert.throws(() => scripts.parseTables(text, 'bad.tables.json'), Error, `scripts: ${label}`);
  }
  // A comment anywhere is dropped, at load and by the hold; a key named like the prototype is an own key, nothing more.
  const own = tablesFrom('{"T": {"kind": "never-shrink", "value": {"__proto__": ["x"]}}}', 'p.tables.json').get<Record<string, unknown>>('T');
  assert.deepEqual([Object.keys(own), Object.getPrototypeOf(own) === Object.prototype], [['__proto__'], true]);
  assert.deepEqual(tablesFrom(one([{ '//': 'why', a: 1 }]), 'c.tables.json').get('T'), [{ a: 1 }]);
});

test("a module reads only its own tables file, by its own URL: no path is written at the load site (#941)", () => {
  assert.equal(tablesOf(pathToFileURL(join(repoRoot, 'dist', 'src', 'review.js')).href).get<readonly string[]>('ALWAYS_L3').length, 2);
  assert.throws(() => tablesOf(pathToFileURL(join(repoRoot, 'dist', 'src', 'no-such-module.js')).href), /ENOENT/);
  assert.throws(() => tablesFrom(one([]), 'x.tables.json').get('MISSING'), /has no table MISSING/);
});

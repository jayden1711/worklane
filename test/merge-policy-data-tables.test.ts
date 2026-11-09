// #941: a data table (`<module>.tables.json`) is compared as parsed data, before and after, and never run
// (src/merge-policy-weakening.ts jsonTableFindings). An entry lost or changed in a never-shrink table waits, an entry
// added passes; an entry added or changed in a never-grow one waits; a table or the file gone, a kind changed, or a
// file that doesn't parse (before or after) waits. Pure fixtures, and one real repo through weakeningOf. And the
// changes the syntax matcher this replaces held by mistake (R1184i: #1141, #1080, an import widened) give no reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changeFiles } from '../src/coordinator/change-files.js';
import * as weakening from '../src/merge-policy-weakening.js';
import type { ChangeFile } from '../src/review.js';
import { exampleProject } from './helpers.js';

const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, ''));
const SHRUNK = "removes or changes an entry in a check's rules or a guard's list";
const GROWN = 'adds or changes an entry in an allowlist, exception or good-fixture list';
const GONE = "removes or renames a check's or guard's table";
const REG = 'removes or changes the mark that registers a check, a check-table or lint-test line';
const UNREADABLE = "can't read a change to check it, so it may weaken a check";

/** The pure hold for a change given as each file's text before and after (null: not there), its lines as a diff gives them. */
function weakens(before: Record<string, string | null>, after: Record<string, string | null>, tablesFiles?: ReadonlySet<string>): string[] {
  const minus = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    });
  };
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
  const files: ChangeFile[] = paths.map((path) => {
    const [b, a] = [(before[path] ?? '').split('\n'), (after[path] ?? '').split('\n')];
    const removed = minus(b, a).filter(Boolean);
    const added = minus(a, b).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  const deleted = new Set(paths.filter((p) => after[p] == null));
  return kinds(weakening.weakeningReasons({ files, deleted, before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope: undefined, ...(tablesFiles ? { tablesFiles } : {}) }));
}

const F = 'src/x-rules.tables.json';
/** A tables file: each table name to [kind, value]. */
const file = (tables: Record<string, [string, unknown]>) => `${JSON.stringify(Object.fromEntries(Object.entries(tables).map(([n, [kind, value]]) => [n, { '//': `${n}, a probe`, kind, value }])), null, 2)}\n`;
const BASE = file({
  CHECKS: ['never-shrink', ['a', 'b', 'c']],
  ALLOWED: ['never-grow', ['x']],
  PARTS: ['never-shrink', [{ what: 'p', globs: ['g1', 'g2'] }]],
  BY_KEY: ['never-shrink', { k: ['v'], o: 'on' }],
  WORDS: ['never-shrink', { $set: ['w1', 'w2'] }],
  SHAPES: ['never-shrink', [{ $regexp: '^a$', flags: 'i' }]],
});
const change = (f: (t: Record<string, { kind: string; value: unknown }>) => void) => {
  const t = JSON.parse(BASE) as Record<string, { kind: string; value: unknown }>;
  f(t);
  return `${JSON.stringify(t, null, 2)}\n`;
};
const held = (after: string | null, before: string | null = BASE) => weakens({ [F]: before }, { [F]: after });

test('a never-shrink data table: an entry lost or changed waits, at any depth, in any shape (#941)', () => {
  assert.deepEqual(held(change((t) => (t.CHECKS!.value as string[]).pop())), [SHRUNK], 'a list entry lost');
  assert.deepEqual(held(change((t) => ((t.CHECKS!.value as string[])[0] = 'A'))), [SHRUNK], 'a list entry changed');
  assert.deepEqual(held(change((t) => (t.CHECKS!.value = { $set: ['a', 'b', 'c'] }))), [SHRUNK], 'a list turned into a set');
  assert.deepEqual(held(change((t) => (t.CHECKS!.value = 'abc'))), [SHRUNK], 'a list turned into a string');
  assert.deepEqual(held(change((t) => ((t.PARTS!.value as { globs: string[] }[])[0]!.globs = ['g1']))), [SHRUNK], "a glob taken out of a part");
  assert.deepEqual(held(change((t) => ((t.PARTS!.value as { what: string }[])[0]!.what = 'q'))), [SHRUNK], "a part's name changed");
  assert.deepEqual(held(change((t) => delete (t.BY_KEY!.value as Record<string, unknown>).k)), [SHRUNK], 'a key lost');
  assert.deepEqual(held(change((t) => ((t.BY_KEY!.value as Record<string, unknown>).o = 'off'))), [SHRUNK], "a key's value changed");
  assert.deepEqual(held(change((t) => ((t.BY_KEY!.value as Record<string, unknown>).k = []))), [SHRUNK], "a key's list emptied");
  assert.deepEqual(held(change((t) => ((t.WORDS!.value as { $set: string[] }).$set = ['w1']))), [SHRUNK], 'a set entry lost');
  assert.deepEqual(held(change((t) => ((t.SHAPES!.value as { flags: string }[])[0]!.flags = ''))), [SHRUNK], "a regexp's flags changed");
});

test('a never-shrink data table: an entry added passes; a never-grow one waits on an entry added or changed (#941)', () => {
  assert.deepEqual(held(change((t) => (t.CHECKS!.value as string[]).push('d'))), [], 'a rule added');
  assert.deepEqual(held(change((t) => (t.PARTS!.value as { globs: string[] }[])[0]!.globs.push('g3'))), [], 'a glob added to a part');
  assert.deepEqual(held(change((t) => (t.PARTS!.value as unknown[]).push({ what: 'q', globs: ['g4'] }))), [], 'a part added');
  assert.deepEqual(held(change((t) => ((t.BY_KEY!.value as Record<string, unknown>).n = 'x'))), [], 'a key added');
  assert.deepEqual(held(change((t) => (t.CHECKS!.value as string[]).reverse())), [], 'reordered: no entry lost');
  assert.deepEqual(held(change((t) => (t.ALLOWED!.value as string[]).push('y'))), [GROWN], 'an allowlist entry added');
  assert.deepEqual(held(change((t) => ((t.ALLOWED!.value as string[])[0] = 'z'))), [GROWN], 'an allowlist entry changed');
  assert.deepEqual(held(change((t) => (t.ALLOWED!.value as string[]).pop())), [], 'an allowlist entry taken out');
  assert.deepEqual(held(change((t) => (t.NEW_RULES = { kind: 'never-shrink', value: ['n'] }))), [], 'a new table');
  assert.deepEqual(held(BASE.replace('"CHECKS, a probe"', '"reworded"')), [], 'a comment changed');
});

test("a data table or its file gone, its kind changed, or a file that doesn't parse waits (#941)", () => {
  assert.deepEqual(held(change((t) => delete t.CHECKS)), [GONE], 'a table taken out');
  assert.deepEqual(held(null), [GONE], 'the file deleted');
  assert.deepEqual(held(change((t) => (t.CHECKS!.kind = 'never-grow'))), [REG], 'its kind changed');
  assert.deepEqual(held(BASE.slice(0, -3)), [UNREADABLE], "the file doesn't parse after");
  assert.deepEqual(held(change((t) => (t.CHECKS!.value = { $function: 'x' }))), [UNREADABLE], 'a tag that is not one');
  assert.deepEqual(held(BASE, '{'), [UNREADABLE], "the file didn't parse before");
  assert.deepEqual(held('{', null), [UNREADABLE], "a new tables file that doesn't parse");
  assert.deepEqual(held(BASE, null), [], 'a new tables file');
  // The name's floor holds as for a marked table: a rule list's name holds it on shrinking whatever its kind says.
  assert.deepEqual(held(file({ BAD_WORDS: ['never-grow', ['b']] }), file({ BAD_WORDS: ['never-grow', ['a', 'b']] })), [SHRUNK]);
});

test('through git and weakeningOf: a data table shrunk waits, grown passes, its file renamed waits (#941)', () => {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Record<string, string | null>) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) rmSync(join(dir, p));
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const reasons = (base: string, head: string) => kinds(weakening.weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, base));
  const base = commit({ [F]: BASE, 'src/x-rules.ts': "import { tablesOf } from './check-tables.js';\nexport const CHECKS = tablesOf(import.meta.url).get('CHECKS');\n" });
  const shrunk = commit({ [F]: change((t) => (t.CHECKS!.value as string[]).pop()) });
  assert.deepEqual(reasons(base, shrunk), [SHRUNK]);
  const grown = commit({ [F]: change((t) => (t.CHECKS!.value as string[]).push('d')) });
  assert.deepEqual(reasons(shrunk, grown), [], 'growth after the shrink, measured from the shrink');
  const moved = commit({ [F]: null, 'src/x-other.tables.json': BASE });
  assert.ok(reasons(grown, moved).includes(GONE), 'renamed: its tables are gone from where the module reads them');
});

test("R1184i's false holds pass now: #1141 (a name added to an import from a table's module), #1080 (a module object's members used), an import widened (#941)", () => {
  const isolate = "export const DROPPED_CREDENTIALS = ['GH_TOKEN'];\n";
  // #1141: test/isolate.test.ts adds DROPPED_CREDENTIALS to its import from ./isolate.js, a table file.
  const t1141 = "import { HOST_TOOL_NAMES } from './isolate.js';\nvoid HOST_TOOL_NAMES;\n";
  assert.deepEqual(weakens({ 'test/isolate.ts': isolate, 'test/isolate.test.ts': t1141 }, { 'test/isolate.ts': isolate, 'test/isolate.test.ts': t1141.replace('{ HOST_TOOL_NAMES }', '{ DROPPED_CREDENTIALS, HOST_TOOL_NAMES }') }), []);
  // #1080: scripts/setup/updates-root.cjs, `helper` the machine helper's module object (which exports POLICY_ONLY).
  const root = "const helper = require('../machine/x-machine.cjs');\n";
  assert.deepEqual(weakens({ 'scripts/setup/updates-root.cjs': root }, { 'scripts/setup/updates-root.cjs': `${root}const fixed = helper.fixedPath;\nhelper.journal('x');\n` }), []);
  // An import of a module with tables, widened.
  const live = "import { gitSpawnSync } from '../os/git.js';\nvoid gitSpawnSync;\n";
  assert.deepEqual(weakens({ 'src/config/live.ts': live }, { 'src/config/live.ts': live.replace('{ gitSpawnSync }', '{ gitExecFileSync, gitSpawnSync }') }), []);
});

test('a tables file under a guard path is judged by its parsed compare alone: an entry appended, a comment edited, a re-indent pass; an entry lost waits (#941, R1184l)', () => {
  // src/merge-policy* is a guard path: every removed line of a guard file waits, and JSON has no trailing comma.
  const G = 'src/merge-policy-x.tables.json';
  const base = file({ FLOOR_RULES: ['never-shrink', ['a', 'b']] });
  const at = (text: string) => weakens({ [G]: base }, { [G]: text });
  assert.deepEqual(at(file({ FLOOR_RULES: ['never-shrink', ['a', 'b', 'c']] })), [], 'an entry appended');
  assert.deepEqual(at(base.replace('FLOOR_RULES, a probe', 'reworded')), [], 'a comment edited');
  assert.deepEqual(at(JSON.stringify(JSON.parse(base), null, 4)), [], 're-indented');
  assert.deepEqual(at(file({ FLOOR_RULES: ['never-shrink', ['a']] })), [SHRUNK], 'an entry lost');
});

test("a new tables file whose name differs only in case from another's waits: one is written over the other where case folds (#941, R1184l)", () => {
  const twin = 'src/X-rules.tables.json';
  assert.deepEqual(weakens({ [F]: BASE }, { [F]: BASE, [twin]: file({ CHECKS: ['never-shrink', ['a']] }) }, new Set([F])), [GONE]);
  assert.deepEqual(weakens({}, { 'src/y-rules.tables.json': BASE }, new Set([F])), [], 'a new tables file of its own name');
});

test('a number a table can\'t hold as itself (not finite, or -0) fails to parse, so it waits (#941, R1184l)', () => {
  for (const n of ['1e400', '-1e400', '-0']) assert.deepEqual(held(`{"CHECKS": {"kind": "never-shrink", "value": [${n}]}}`), [UNREADABLE], n);
  assert.deepEqual(held(change((t) => (t.CHECKS!.value as unknown[]).push(0, 1.5))), [], 'plain numbers added');
});

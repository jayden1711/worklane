// #869, #886's round-4 review: the checks the default branch registers hold a change whatever its base, and a table's
// old lines kept as dead text can't hide the live table from the line reader. Real git in scratch repos (weakeningOf
// with changeFiles, as the merge decision runs it), and fixtures for the pure reader. No repo file is read or edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changeFiles } from '../src/coordinator/change-files.js';
import * as weakening from '../src/merge-policy-weakening.js';
import type { ChangeFile } from '../src/review.js';
import { exampleProject } from './helpers.js';

const GROWN = 'adds or changes an entry in an allowlist, exception or good-fixture list';
const SHRUNK = "removes or changes an entry in a check's rules or a guard's list";
const GUARD = 'removes or changes a line of a guard or lint';
const GONE = "removes or renames a check's or guard's table";
const REG_GONE = 'removes or changes the mark that registers a check, a check-table or lint-test line';
const USED = "changes a check's or guard's table outside its own list";
const HIDDEN = "adds a line that could hide a check's table from the line reader, an escaped name or a declaration with its name on the next line";
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, ''));

type Files = Record<string, string | null>;

/**
 * The hold for a PR in a real repo: the base it was claimed at, the default branch's tip after it (`tip` changed on
 * top of the base), and the PR's head: on the base (a stale PR), or with the tip merged in first (`mergedTip`).
 */
function held(o: { base: Files; tip: Files; head: Files; mergedTip?: boolean; tipRev?: 'unreadable' }): string[] {
  return kinds(heldReasons(o));
}

/** held, with each reason whole. */
function heldReasons(o: { base: Files; tip: Files; head: Files; mergedTip?: boolean; tipRev?: 'unreadable' }): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Files) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) g('rm', '-q', '--', p);
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
    }
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const base = commit(o.base);
  g('checkout', '-q', '-b', 'default-tip');
  const tip = commit(o.tip);
  g('checkout', '-q', '-b', 'pr', base);
  if (o.mergedTip) g('merge', '-q', '--no-edit', tip);
  const head = commit(o.head);
  return weakening.weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, o.tipRev ? null : tip);
}

const P = 'test/rules.test.ts';
const table = (name: string, rows: string[], mark?: string) => `import { test } from 'node:test';\n${mark ? `// check-table: ${mark}\n` : ''}export const ${name} = [\n${rows.map((r) => `  '${r}',`).join('\n')}\n];\ntest('t', () => {});\n`;

test('registration at the tip (#1): a PR claimed before a table was marked, growing it, waits', () => {
  const r = held({ base: { [P]: table('NEW_ALLOWED', ['a', 'b']) }, tip: { [P]: table('NEW_ALLOWED', ['a', 'b'], 'never-grow') }, head: { [P]: table('NEW_ALLOWED', ['a', 'b', 'c']) } });
  assert.ok(r.includes(GROWN), r.join(' | '));
});

test('registration at the tip (#2): the same PR after merging the marked default branch in, then growing it, waits', () => {
  const r = held({ base: { [P]: table('NEW_ALLOWED', ['a', 'b']) }, tip: { [P]: table('NEW_ALLOWED', ['a', 'b'], 'never-grow') }, head: { [P]: table('NEW_ALLOWED', ['a', 'b', 'c'], 'never-grow') }, mergedTip: true });
  assert.ok(r.includes(GROWN), r.join(' | '));
});

test('registration at the tip (#3): a table marked on the default branch after the claim, then shrunk by the PR, waits', () => {
  const r = held({ base: { [P]: table('CHECKS', ['a', 'b', 'c']) }, tip: { [P]: table('CHECKS', ['a', 'b', 'c'], 'never-shrink') }, head: { [P]: table('CHECKS', ['a', 'b']) } });
  assert.ok(r.includes(SHRUNK), r.join(' | '));
});

test('registration at the tip (#4): a marked table and lint test made on the default branch after the claim, merged in, then shrunk, wait', () => {
  const N = 'test/new-guard.test.ts';
  const lint = (rows: string[]) => `// lint-test\n${table('BANNED_CALLS', rows, 'never-shrink')}`;
  const r = held({ base: { 'README.md': 'x\n' }, tip: { [N]: lint(['execSync', 'spawnSync', 'exec']) }, head: { [N]: lint(['execSync']) }, mergedTip: true });
  assert.ok(r.includes(SHRUNK), r.join(' | '));
  assert.ok(r.includes(GUARD), r.join(' | '));
});

test('registration at the tip: a stale PR that changes the file elsewhere keeps the mark through the merge (no wait); taking a merged-in mark out waits', () => {
  const base = table('CHECKS', ['a', 'b', 'c']);
  const marked = table('CHECKS', ['a', 'b', 'c'], 'never-shrink');
  assert.deepEqual(held({ base: { [P]: base }, tip: { [P]: marked }, head: { [P]: `${base}// a note\n` } }), []);
  assert.deepEqual(held({ base: { [P]: base }, tip: { [P]: marked }, head: { [P]: `${marked}// a note\n` }, mergedTip: true }), []);
  const r = held({ base: { [P]: base }, tip: { [P]: marked }, head: { [P]: `${base}// a note\n` }, mergedTip: true });
  assert.ok(r.includes(REG_GONE), r.join(' | '));
  // A marked table made on the default branch, merged in, then taken out of the PR's head: gone.
  const N = 'test/new-guard.test.ts';
  const t2 = held({ base: { [N]: "import { test } from 'node:test';\n" }, tip: { [N]: table('BANNED_CALLS', ['x', 'y'], 'never-shrink') }, head: { [N]: "import { test } from 'node:test';\n// emptied\n" }, mergedTip: true });
  assert.ok(t2.includes(GONE), t2.join(' | '));
});

test("registration at the tip: a tip it can't read makes the change wait", () => {
  const r = heldReasons({ base: { [P]: table('CHECKS', ['a']) }, tip: {}, head: { 'src/x.ts': 'export const x = 1;\n' }, tipRev: 'unreadable' });
  assert.equal(r.length, 1);
  assert.match(r[0]!, /the default branch's current tip couldn't be read/);
});

/** The pure hold for a change given as each file's text before and after, its lines as a diff gives them. */
function weakens(before: Record<string, string>, after: Record<string, string>): string[] {
  const minus = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    });
  };
  const files: ChangeFile[] = Object.keys(after).map((path) => {
    const [b, a] = [(before[path] ?? '').split('\n'), after[path]!.split('\n')];
    const removed = minus(b, a).filter(Boolean);
    const added = minus(a, b).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  return kinds(weakening.weakeningReasons({ files, deleted: new Set(), before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope: undefined }));
}

const F = 'test/x-rules.test.ts';
const BASE = "import { test } from 'node:test';\n// check-table: never-shrink\nexport const CHECKS = [\n  'a',\n  'b',\n  'c',\n];\ntest('t', () => { for (const c of CHECKS) void c; });\n";
const ESCAPED = "export const C\\u0048ECKS = ['a'];\n";

test('decoy (#5): the old lines kept in a comment or a template, the live table under an escaped name, wait', () => {
  const comment = BASE.replace('// check-table', '/*\n// check-table').replace('];\n', `];\n*/\n${ESCAPED}`);
  assert.ok(weakens({ [F]: BASE }, { [F]: comment }).includes(HIDDEN), 'comment decoy');
  const template = BASE.replace('// check-table', 'const DOC = `\n// check-table').replace('];\n', `];\n\`;\n${ESCAPED}`);
  assert.ok(weakens({ [F]: BASE }, { [F]: template }).includes(HIDDEN), 'template decoy');
  const L = 'test/x-lint.test.ts';
  const lint = `// lint-test\n${BASE}`;
  assert.ok(weakens({ [L]: lint }, { [L]: lint.replace('// check-table', '/*\n// check-table').replace('];\n', `];\n*/\n${ESCAPED}`) }).includes(HIDDEN), 'in a lint test');
});

test('decoy (#6): the old lines kept in a comment, the live table declared with its name on the next line, waits', () => {
  // The decoy carries the live declaration's second line as an extra entry, so it reads as one of the table's own lines.
  const head = BASE.replace('// check-table', '/*\n// check-table').replace("  'c',\n];\n", "  'c',\n  CHECKS = ['a'];\n];\n*/\nexport const\n  CHECKS = ['a'];\n");
  const r = weakens({ [F]: BASE }, { [F]: head });
  assert.ok(r.includes(HIDDEN), r.join(' | '));
  assert.ok(r.includes(USED), r.join(' | '));
});

test('decoy: ordinary added lines in a table file do not wait: `\\u` in a string, a named declaration, a rule added inside the table', () => {
  const add = (l: string) => weakens({ [F]: BASE }, { [F]: `${BASE}${l}\n` });
  assert.deepEqual(add("const accent = '\\u00e9';"), []);
  assert.deepEqual(add('const more = 1; // const'), []);
  assert.deepEqual(add('export const OTHER = [1];'), []);
  assert.deepEqual(weakens({ [F]: BASE }, { [F]: BASE.replace("  'c',\n", "  'c',\n  'd',\n") }), [], 'a rule added to a never-shrink table');
});

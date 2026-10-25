// #1069: once a PR's branch has merged in the default branch's tip, what merging the PR does to the default branch is
// measured too, so what the tip changed and the PR undoes (a line or file the tip added and the PR took out, a line the
// tip took out and the PR put back) waits. Real git in scratch repos (weakeningOf with changeFiles, as the merge
// decision runs it). No repo file is read or edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changeFiles } from '../src/coordinator/change-files.js';
import * as weakening from '../src/merge-policy-weakening.js';
import { exampleProject } from './helpers.js';

const GROWN = 'adds or changes an entry in an allowlist, exception or good-fixture list';
const SHRUNK = "removes or changes an entry in a check's rules or a guard's list";
const GUARD = 'removes or changes a line of a guard or lint';
const GONE = "removes or renames a check's or guard's table";
const REG_GONE = 'removes or changes the mark that registers a check, a check-table or lint-test line';
const DELETED = 'deletes a test file';
const ASSERTION = 'removes or changes a line with an assertion or a test on it';
const MARKER = 'adds a line with a skip, only or lint or type-check suppression mark';
const ALLOW_FILE = "adds a line to an allowlist file or a package manager's settings file";
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, ''));

type Files = Record<string, string | null>;

/**
 * The hold for a PR in a real repo: the base it was claimed at, the default branch's commits after it (`tip`, in
 * order; the last is its tip), and the PR's head on the base, after merging in the default branch's commit `mergeAt`
 * (an index into `tip`; none: a stale PR). Each reason whole.
 */
function heldReasons(o: { base: Files; tip: Files[]; head: Files; mergeAt?: number }): string[] {
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
  const tips = o.tip.map(commit);
  g('checkout', '-q', '-b', 'pr', base);
  if (o.mergeAt !== undefined) g('merge', '-q', '--no-edit', tips[o.mergeAt]!);
  const head = commit(o.head);
  return weakening.weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, tips.at(-1)!);
}

/** heldReasons for a PR that merged the tip in (one default-branch commit after the base), by kind. */
const mergedIn = (base: Files, tip: Files, head: Files) => kinds(heldReasons({ base, tip: [tip], head, mergeAt: 0 }));

const P = 'test/rules.test.ts';
const L = 'test/no-shell.test.ts';
const T = 'test/x.test.ts';
const table = (name: string, rows: string[], mark?: string) => `import { test } from 'node:test';\n${mark ? `// check-table: ${mark}\n` : ''}export const ${name} = [\n${rows.map((r) => `  '${r}',`).join('\n')}\n];\ntest('t', () => {});\n`;
const lint = (rows: string[], mark = true) => `${mark ? '// lint-test\n' : ''}import { test } from 'node:test';\n\nconst BANNED = [\n${rows.map((r) => `  '${r}',`).join('\n')}\n];\n\ntest('no shell calls in src', () => {});\n`;
const asserts = (lines: string[]) => `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('t', () => {\n${lines.map((l) => `  ${l}\n`).join('')}});\n`;
const WEB = { 'web/x.js': 'export const x = 2;\n' };

test('tip merged in: a tip mark taken out by writing the file back to its base text waits (net zero against the base)', () => {
  const base = table('CHECKS', ['a', 'b', 'c']);
  const r = mergedIn({ [P]: base, 'web/x.js': 'export const x = 1;\n' }, { [P]: table('CHECKS', ['a', 'b', 'c'], 'never-shrink') }, { [P]: base, ...WEB });
  assert.ok(r.includes(REG_GONE), r.join(' | '));
  const l = mergedIn({ [L]: lint(['execSync', 'spawnSync'], false), 'web/x.js': 'export const x = 1;\n' }, { [L]: lint(['execSync', 'spawnSync']) }, { [L]: lint(['execSync', 'spawnSync'], false), ...WEB });
  assert.ok(l.includes(REG_GONE), l.join(' | '));
});

test('tip merged in: a file only the tip has, deleted or moved by the PR, waits', () => {
  const N = 'test/new-rules.test.ts';
  const d = mergedIn({ 'web/x.js': 'export const x = 1;\n' }, { [N]: table('CHECKS', ['x', 'y'], 'never-shrink') }, { [N]: null, ...WEB });
  assert.ok(d.includes(GONE), d.join(' | '));
  const m = mergedIn({ README: 'x\n' }, { [L]: lint(['execSync', 'spawnSync']) }, { [L]: null, 'test/no-shell2.test.ts': lint(['execSync'], false) });
  assert.ok(m.includes(DELETED) && m.includes(GUARD), m.join(' | '));
  // An unmarked test file only the tip has, deleted with an unrelated change elsewhere.
  const t = mergedIn({ 'web/x.js': 'export const x = 1;\n' }, { 'test/y.test.ts': asserts(['assert.ok(true);']) }, { 'test/y.test.ts': null, ...WEB });
  assert.ok(t.includes(DELETED), t.join(' | '));
});

test('tip merged in: an entry or rule the tip added, taken out with the mark kept, waits (marked at the tip or at the base)', () => {
  const note = '// a note\n';
  const tipMarked = mergedIn({ [P]: table('CHECKS', ['a', 'b']) }, { [P]: table('CHECKS', ['a', 'b', 'c'], 'never-shrink') }, { [P]: `${table('CHECKS', ['a', 'b'], 'never-shrink')}${note}` });
  assert.ok(tipMarked.includes(SHRUNK), tipMarked.join(' | '));
  const baseMarked = mergedIn({ [P]: table('CHECKS', ['a', 'b'], 'never-shrink') }, { [P]: table('CHECKS', ['a', 'b', 'c'], 'never-shrink') }, { [P]: `${table('CHECKS', ['a', 'b'], 'never-shrink')}${note}` });
  assert.ok(baseMarked.includes(SHRUNK), baseMarked.join(' | '));
  const tipLint = mergedIn({ [L]: lint(['execSync'], false) }, { [L]: lint(['execSync', 'spawnSync']) }, { [L]: `${lint(['execSync'])}${note}` });
  assert.ok(tipLint.includes(GUARD), tipLint.join(' | '));
  const baseLint = mergedIn({ [L]: lint(['execSync']) }, { [L]: lint(['execSync', 'spawnSync']) }, { [L]: `${lint(['execSync'])}${note}` });
  assert.ok(baseLint.includes(GUARD), baseLint.join(' | '));
});

test('tip merged in: an assertion the tip added, taken out by the PR, waits (in a test the base has, or one only the tip has)', () => {
  const kept = asserts(['assert.ok(true);']);
  const grown = asserts(['assert.ok(true);', 'assert.equal(1, 1);']);
  const r = mergedIn({ [T]: kept }, { [T]: grown }, { [T]: `${kept}// a note\n` });
  assert.ok(r.includes(ASSERTION), r.join(' | '));
  const only = mergedIn({ README: 'x\n' }, { 'test/y.test.ts': grown }, { 'test/y.test.ts': `${kept}// a note\n` });
  assert.ok(only.includes(ASSERTION), only.join(' | '));
});

test('tip merged in: what the tip took out, put back by the PR, waits (an allowlist entry, a skip, an ignore-file line)', () => {
  const A = 'test/allow.test.ts';
  const allow = mergedIn({ [A]: table('ALLOWED', ['x', 'y'], 'never-grow') }, { [A]: table('ALLOWED', ['x'], 'never-grow') }, { [A]: `${table('ALLOWED', ['x', 'y'], 'never-grow')}// a note\n` });
  assert.ok(allow.includes(GROWN), allow.join(' | '));
  const skipped = "import { test } from 'node:test';\ntest.skip('a', () => {});\n";
  const skip = mergedIn({ 'test/a.test.ts': skipped }, { 'test/a.test.ts': "import { test } from 'node:test';\ntest('a', () => {});\n" }, { 'test/a.test.ts': `${skipped}// a note\n` });
  assert.ok(skip.includes(MARKER), skip.join(' | '));
  const ignore = mergedIn({ '.gitleaksignore': 'a:1\nb:2\n', 'web/x.js': 'export const x = 1;\n' }, { '.gitleaksignore': 'a:1\n' }, { '.gitleaksignore': 'a:1\nb:2\n', ...WEB });
  assert.ok(ignore.includes(ALLOW_FILE), ignore.join(' | '));
});

test('tip merged in: a weakening both measurements see is one reason, its place named once', () => {
  const r = heldReasons({ base: { [T]: asserts(['assert.ok(true);', 'assert.equal(2, 2);']) }, tip: [{ README: 'x\n' }], head: { [T]: asserts(['assert.ok(true);']) }, mergeAt: 0 });
  assert.equal(r.length, 1, r.join(' | '));
  assert.ok(r[0]!.startsWith(`${weakening.WEAKENING_REASON}${ASSERTION} (`), r[0]);
  assert.equal(r[0]!.split('assert.equal(2, 2);').length, 2, r[0]);
  assert.ok(!r[0]!.includes('more'), r[0]);
});

test('tip merged in: what genuinely weakens nothing still merges (a stale PR, the tip merged in, an older default-branch commit merged in)', () => {
  const base = table('CHECKS', ['a', 'b', 'c']);
  const marked = table('CHECKS', ['a', 'b', 'c'], 'never-shrink');
  // A stale PR beside a mark the tip added: the merge keeps it.
  assert.deepEqual(kinds(heldReasons({ base: { [P]: base }, tip: [{ [P]: marked }], head: { [P]: `${base}// a note\n` } })), []);
  // The tip merged in, then only an app change, or a rule added to the tip's marked table.
  assert.deepEqual(mergedIn({ 'web/x.js': 'export const x = 1;\n' }, { 'README.md': 'news\n' }, WEB), []);
  assert.deepEqual(mergedIn({ [P]: base }, { [P]: marked }, { [P]: table('CHECKS', ['a', 'b', 'c', 'd'], 'never-shrink') }), []);
  // An older commit of the default branch merged in; the default branch moved on since (an entry added, a test file
  // added) and the PR only adds a line of its own elsewhere.
  const r = heldReasons({
    base: { [P]: marked, 'web/x.js': 'export const x = 1;\n' },
    tip: [{ [P]: table('CHECKS', ['a', 'b', 'c', 'd'], 'never-shrink') }, { [P]: table('CHECKS', ['a', 'b', 'c', 'd', 'e'], 'never-shrink'), 'test/y.test.ts': asserts(['assert.ok(true);']) }],
    head: WEB,
    mergeAt: 0,
  });
  assert.deepEqual(kinds(r), []);
});

/**
 * A criss-cross: commit D forks before the claimed base, and the default branch takes it after the base through a
 * merge commit (the tip). The PR merges D itself, not the tip, so `git merge-base tip head` is the base alone; `--all`
 * also gives D. `d` is D's files, `head` the PR's after the merge.
 */
function crissCross(o: { root: Files; d: Files; head: Files }): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Files) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t!);
    }
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const root = commit(o.root);
  g('checkout', '-q', '-b', 'other');
  const d = commit(o.d);
  g('checkout', '-q', '-b', 'default-tip', root);
  const base = commit({ README: 'b\n' });
  g('merge', '-q', '--no-ff', '--no-edit', d);
  const tip = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'pr', base);
  g('merge', '-q', '--no-edit', d);
  const head = commit(o.head);
  assert.equal(g('merge-base', '--all', tip, head).split('\n').length, 2, 'two merge bases');
  return kinds(weakening.weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, tip));
}

test('tip merged in, criss-cross: an older default-branch commit merged in directly, then undone, waits', () => {
  const kept = asserts(['assert.ok(true);']);
  const a = crissCross({ root: { [T]: kept, 'web/x.js': '1\n' }, d: { [T]: asserts(['assert.ok(true);', 'assert.equal(1, 1);']) }, head: { [T]: kept, ...WEB } });
  assert.ok(a.includes(ASSERTION), a.join(' | '));
  const plain = table('CHECKS', ['a', 'b']);
  const m = crissCross({ root: { [P]: plain, 'web/x.js': '1\n' }, d: { [P]: table('CHECKS', ['a', 'b'], 'never-shrink') }, head: { [P]: plain, ...WEB } });
  assert.ok(m.includes(REG_GONE), m.join(' | '));
  // The control: the same merge, then only an app change.
  assert.deepEqual(crissCross({ root: { [T]: kept, 'web/x.js': '1\n' }, d: { [T]: asserts(['assert.ok(true);', 'assert.equal(1, 1);']) }, head: WEB }), []);
});

test("tip merged in: the default branch's own change after the merge-in is never taken for the PR's (it deletes a test)", () => {
  // Measured from the tip, not from where the head meets it: main deleting a test file since is main's change.
  const r = heldReasons({
    base: { [T]: asserts(['assert.ok(true);']), 'test/old.test.ts': asserts(['assert.ok(1);']), 'web/x.js': 'export const x = 1;\n' },
    tip: [{ README: 'r\n' }, { 'test/old.test.ts': null, [T]: asserts([]) }],
    head: WEB,
    mergeAt: 0,
  });
  assert.deepEqual(kinds(r), []);
});

test('stale PR: a change git carries onto a table or lint test the tip renamed or moved and marked waits', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'];
  const fewer = ['a', 'b', 'c', 'e'];
  // The tip renames LIST to CHECKS and marks it; the PR takes 'd' out of LIST.
  const renamed = kinds(heldReasons({ base: { [P]: table('LIST', rows) }, tip: [{ [P]: table('CHECKS', rows, 'never-shrink') }], head: { [P]: table('LIST', fewer) } }));
  assert.ok(renamed.includes(SHRUNK), renamed.join(' | '));
  // The tip moves the file and marks its table; the PR shrinks the table at the old path.
  const moved = kinds(heldReasons({ base: { [P]: table('CHECKS', rows) }, tip: [{ [P]: null, 'test/checks/rules.test.ts': table('CHECKS', rows, 'never-shrink') }], head: { [P]: table('CHECKS', fewer) } }));
  assert.ok(moved.includes(SHRUNK), moved.join(' | '));
  // The tip moves a test to test/lint/ and marks it a lint test; the PR takes a rule out at the old path.
  const rules = ['execSync', 'spawnSync', 'exec', 'fork'];
  const lintMoved = kinds(heldReasons({ base: { [L]: lint(rules, false) }, tip: [{ [L]: null, 'test/lint/no-shell.test.ts': lint(rules) }], head: { [L]: lint(['execSync', 'exec', 'fork'], false) } }));
  assert.ok(lintMoved.includes(GUARD), lintMoved.join(' | '));
});

test('stale PR: an unrelated change, while the tip renamed and marked a table, still merges', () => {
  const rows = ['a', 'b', 'c'];
  assert.deepEqual(heldReasons({ base: { [P]: table('LIST', rows), 'web/x.js': 'export const x = 1;\n' }, tip: [{ [P]: table('CHECKS', rows, 'never-shrink') }], head: WEB }), []);
  assert.deepEqual(heldReasons({ base: { [P]: table('CHECKS', rows), 'web/x.js': 'export const x = 1;\n' }, tip: [{ [P]: null, 'test/checks/rules.test.ts': table('CHECKS', rows, 'never-shrink') }], head: WEB }), []);
});

const v = (n: number) => ({ 'web/x.js': `export const x = ${n};\n` });

test('a merge into the tip that conflicts adds no reason: the conflict paths take it; its own change is still measured', () => {
  // An older commit of the default branch merged in, or a stale PR; the PR and the tip since change the same line.
  assert.deepEqual(heldReasons({ base: v(1), tip: [{ README: 'x\n' }, v(3)], head: v(2), mergeAt: 0 }), []);
  assert.deepEqual(heldReasons({ base: v(1), tip: [v(3)], head: v(2) }), []);
  // The conflict leaves the change from its base measured: an assertion it takes out still waits.
  const own = kinds(heldReasons({ base: { ...v(1), [T]: asserts(['assert.ok(true);', 'assert.equal(1, 1);']) }, tip: [v(3)], head: { ...v(2), [T]: asserts(['assert.ok(true);']) } }));
  assert.deepEqual(own, [ASSERTION]);
});

/**
 * A PR whose merge into the tip conflicts, then the head that resolves it: the tip merged in, the conflict resolved
 * as `resolution` says. The reasons for that head, by kind.
 */
function resolvedReasons(o: { base: Files; tip: Files; head: Files; resolution: Files }): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (files: Files) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t!);
    }
    g('add', '-A');
  };
  write(o.base);
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'default-tip');
  write(o.tip);
  g('commit', '-q', '-m', 'tip');
  const tip = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'pr', base);
  write(o.head);
  g('commit', '-q', '-m', 'pr');
  const first = g('rev-parse', 'HEAD');
  assert.deepEqual(weakening.weakeningOf(dir, base, first, changeFiles(dir, base, first), undefined, tip), [], 'the conflicting head: left to the conflict paths');
  assert.throws(() => g('merge', '-q', '--no-edit', tip), 'the merge-in conflicts');
  write(o.resolution);
  g('commit', '-q', '--no-edit');
  const head = g('rev-parse', 'HEAD');
  return kinds(weakening.weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, tip));
}

test("the head that resolves a conflict with the tip is measured: taking out an assertion the tip added there waits", () => {
  const kept = asserts(['assert.ok(true);']);
  const grown = asserts(['assert.ok(true);', 'assert.equal(1, 1);']);
  const o = { base: { ...v(1), [T]: kept }, tip: { ...v(3), [T]: grown }, head: v(2) };
  assert.deepEqual(resolvedReasons({ ...o, resolution: { ...v(4), [T]: kept } }), [ASSERTION]);
  // The control: the same resolution keeping the tip's assertion merges.
  assert.deepEqual(resolvedReasons({ ...o, resolution: v(4) }), []);
});

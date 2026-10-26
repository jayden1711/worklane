// #1077: a PR whose merge into the default branch's tip conflicts. The tree git still writes for it (conflict markers
// in the conflicted files, both sides' lines kept) is measured like a clean one, and a conflict in a file the hold
// reads strictly (a test, lint, guard, allowlist or table file) waits: GitHub's own merge may complete where git
// conflicts, and what it makes there is never read. The second measurement over its bound, or failing, keeps the
// first one's reasons beside its own. Real git in scratch repos; no repo file is read or edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { changeFiles, mergedTree } from '../src/coordinator/change-files.js';
import * as weakening from '../src/merge-policy-weakening.js';
import { exampleProject } from './helpers.js';

const ASSERTION = 'removes or changes a line with an assertion or a test on it';
const SHRUNK = "removes or changes an entry in a check's rules or a guard's list";
const MARKER = 'adds a line with a skip, only or lint or type-check suppression mark';
const CONFLICT = "conflicts with the default branch's current tip in a test, lint, guard, allowlist or table file, so what merging it makes there can't be read";
const UNREADABLE = "can't read a change to check it, so it may weaken a check";
const COULD_NOT_RUN = `${weakening.WEAKENING_REASON}the check for a removed or weakened test, lint or guard could not run`;
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, ''));

type Files = Record<string, string | null>;

/**
 * A stale PR in a real repo: the base, the default branch's one commit after it (`tip`), and the PR's head on the
 * base. The checkout is left where the coordinator's is, on the default branch (`checkout: 'head'` leaves it on the
 * PR's head). Each reason whole.
 */
function staleReasons(o: { base: Files; tip: Files; head: Files; checkout?: 'tip' | 'head' }): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Files) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) g('rm', '-q', '-r', '--', p);
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
  const head = commit(o.head);
  if (o.checkout !== 'head') g('checkout', '-q', 'default-tip');
  return weakening.weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, tip);
}

const asserts = (lines: string[]) => `import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('t', () => {\n${lines.map((l) => `  ${l}\n`).join('')}});\n`;
const v = (n: number) => ({ 'web/x.js': `export const x = ${n};\n` });

test('a stale PR that adds a test under a folder the tip renamed waits: git conflicts on where it goes, GitHub may not', () => {
  // `git merge-tree` reports CONFLICT (file location); with merge.directoryRenames=true it passes.
  const r = staleReasons({ base: { 'test/unit/a.test.ts': asserts(['assert.ok(true);']) }, tip: { 'test/unit': null, 'test/core/a.test.ts': asserts(['assert.ok(true);']) }, head: { 'test/unit/b.test.ts': asserts(['assert.ok(1);']) } });
  assert.deepEqual(kinds(r), [CONFLICT]);
  assert.match(r[0]!, /test\/core\/b\.test\.ts|test\/unit\/b\.test\.ts/);
});

test('a conflict only in app code is still left to the conflict paths: no reason', () => {
  assert.deepEqual(staleReasons({ base: v(1), tip: v(3), head: v(2) }), []);
  assert.deepEqual(staleReasons({ base: { 'src/unit/a.js': 'export const a = 1;\n' }, tip: { 'src/unit': null, 'src/core/a.js': 'export const a = 1;\n' }, head: { 'src/unit/b.js': 'export const b = 1;\n' } }), []);
});

test("a conflict's own lines are read from the tree git writes for it: a suppression the tip took out, kept on the PR's side, waits", () => {
  const base = { 'src/a.js': 'export function f() {\n  // eslint-disable-next-line no-console\n  console.log(0);\n}\n' };
  const tip = { 'src/a.js': 'export function f() {\n  return 1;\n}\n' };
  const head = { 'src/a.js': 'export function f() {\n  // eslint-disable-next-line no-console\n  console.log(2);\n}\n' };
  assert.deepEqual(kinds(staleReasons({ base, tip, head })), [MARKER]);
});

test(".gitattributes merge=union on a PR: where git reads the default branch's attributes the test file conflicts and waits; where it reads the PR's, both sides' lines are kept", () => {
  // The coordinator's checkout is the default branch (inferred), so git merges by its attributes, not the PR's.
  const base = { 'test/a.test.ts': asserts(['// a step', 'assert.ok(true);']) };
  const tip = { 'test/a.test.ts': asserts(['assert.equal(1, 1);', 'assert.ok(true);']) };
  const head = { '.gitattributes': 'test/** merge=union\n', 'test/a.test.ts': asserts(['// a step, reworded', 'assert.ok(true);']) };
  assert.deepEqual(kinds(staleReasons({ base, tip, head })), [CONFLICT]);
  // Read with the PR's union: the tip's assertion is kept beside the PR's line, nothing is taken out.
  assert.deepEqual(staleReasons({ base, tip, head, checkout: 'head' }), []);
});

test('a stale PR that conflicts with the tip and shrinks a table only the tip marked waits (the tip\'s marks still read)', () => {
  const P = 'test/rules.test.ts';
  const table = (rows: string[], mark?: string) => `import { test } from 'node:test';\n${mark ? `// check-table: ${mark}\n` : ''}export const CHECKS = [\n${rows.map((r) => `  '${r}',`).join('\n')}\n];\ntest('t', () => {});\n`;
  const r = kinds(staleReasons({ base: { ...v(1), [P]: table(['a', 'b', 'c']) }, tip: { ...v(3), [P]: table(['a', 'b', 'c'], 'never-shrink') }, head: { ...v(2), [P]: table(['a', 'b']) } }));
  assert.deepEqual(r, [SHRUNK]);
});

test('a conflict in a file the tip marks waits, also where the tree git writes keeps the tip\'s text (a PR deleting what the tip changed)', () => {
  const R = 'src/rules.js';
  const rules = (mark: boolean) => `${mark ? '// check-table: never-shrink\n' : ''}export const CHECKS = [\n  'a',\n  'b',\n];\n`;
  const r = kinds(staleReasons({ base: { [R]: rules(false) }, tip: { [R]: rules(true) }, head: { [R]: null } }));
  assert.deepEqual(r, [CONFLICT, "removes or renames a check's or guard's table"]);
});

/** A changed test file whose removed lines are assertions `a<from>` to `a<to - 1>`. */
const removing = (from: number, to: number): weakening.WeakeningInput => {
  const removedLines = Array.from({ length: to - from }, (_, k) => `assert.ok(a${from + k});`);
  return { files: [{ path: 'test/a.test.ts', added: 0, removed: removedLines.length, addedLines: [], removedLines }], deleted: new Set(), before: () => null, after: () => null, scope: undefined };
};

test('two measurements: at most three places named, and "and N more" from the larger count', () => {
  const places = (r: string) => /\((.*)\)$/s.exec(r)![1]!;
  const one = (r: string[]) => {
    assert.equal(r.length, 1, r.join(' | '));
    return places(r[0]!);
  };
  const first3 = [0, 1, 2].map((k) => `test/a.test.ts: "assert.ok(a${k});"`).join('; ');
  // Three in each, all different: three named.
  assert.equal(one(weakening.weakeningReasons(removing(0, 3), removing(3, 6))), first3);
  assert.equal(one(weakening.weakeningReasons(removing(0, 5), removing(0, 1))), `${first3}; and 2 more`);
  assert.equal(one(weakening.weakeningReasons(removing(0, 1), removing(1, 6))), `${first3}; and 2 more`);
});

test("the second measurement over its bound keeps the first one's reasons beside the bound's", () => {
  const big = 'x'.repeat(1000);
  const over: weakening.WeakeningInput = { files: [{ path: 'web/big.js', added: weakening.MAX_CHANGED_CHARS / 1000 + 1, removed: 0, addedLines: Array.from({ length: weakening.MAX_CHANGED_CHARS / 1000 + 1 }, () => big), removedLines: [] }], deleted: new Set(), before: () => null, after: () => null, scope: undefined };
  const bound = `${weakening.WEAKENING_REASON}${UNREADABLE} (the changed lines pass ${weakening.MAX_CHANGED_CHARS} characters)`;
  // Alone, the bound is the one reason, as before.
  assert.deepEqual(weakening.weakeningReasons(over), [bound]);
  assert.deepEqual(kinds(weakening.weakeningReasons(removing(0, 1), over)), [UNREADABLE, ASSERTION]);
  assert.deepEqual(kinds(weakening.weakeningReasons(over, removing(0, 1))), [UNREADABLE, ASSERTION]);
});

test("a conflict in a file whose name isn't UTF-8 waits: it names no file a check could be read from", () => {
  const conflicted = (p: string): weakening.WeakeningInput => ({ files: [], deleted: new Set(), before: () => null, after: () => null, scope: undefined, conflicts: [p] });
  assert.deepEqual(kinds(weakening.weakeningReasons(conflicted('web/x\uFFFD.bin'))), [CONFLICT]);
  assert.deepEqual(weakening.weakeningReasons(conflicted('web/x.bin')), []);
});

/**
 * `git` on PATH as a shim: `merge-tree` prints `out` and exits `code`; anything else runs the real git. For a git that
 * can't run `merge-tree --write-tree` (older than 2.38) and for output it doesn't expect.
 */
function withMergeTreeShim<T>(out: string, code: number, f: () => T): T {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(join(tmpdir(), 'git-shim-'));
  const shim = join(bin, 'git');
  // The output goes through a file: it may hold NULs, which no environment variable can.
  writeFileSync(join(bin, 'out'), out);
  writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = merge-tree ]; then cat "${join(bin, 'out')}"; exit ${code}; fi\ndone\nexec "$REAL_GIT" "$@"\n`);
  chmodSync(shim, 0o755);
  const saved = { PATH: process.env.PATH, REAL_GIT: process.env.REAL_GIT };
  Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, REAL_GIT: real });
  try {
    return f();
  } finally {
    for (const [k, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
}

/** A repo whose `tip` and `pr` branches change the same line of web/x.js from `base`. */
function conflicting(): { dir: string; tip: string; head: string; g: (...a: string[]) => string } {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (n: number) => {
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'web/x.js'), `export const x = ${n};\n`);
    g('add', '-A');
    g('commit', '-q', '-m', String(n));
    return g('rev-parse', 'HEAD');
  };
  const base = commit(1);
  const tip = commit(3);
  g('checkout', '-q', '-b', 'pr', base);
  return { dir, tip, head: commit(2), g };
}

test("mergedTree: the tip's side first in a conflict, every conflicted path, and a clean merge's tree as git writes it", () => {
  const { dir, tip, head, g } = conflicting();
  const m = mergedTree(dir, tip, head);
  assert.deepEqual(m.conflicts, ['web/x.js']);
  assert.equal(g('cat-file', 'blob', `${m.tree}:web/x.js`), `<<<<<<< ${tip}\nexport const x = 3;\n=======\nexport const x = 2;\n>>>>>>> ${head}`);
  const clean = mergedTree(dir, tip, tip);
  assert.deepEqual(clean, { tree: g('rev-parse', `${tip}^{tree}`), conflicts: [] });
});

test('mergedTree: refuses a revision that reads as an option, and output that is not a tree and its conflicts', () => {
  const { dir, tip, head } = conflicting();
  assert.throws(() => mergedTree(dir, '--output=x', head), /is not a revision/);
  assert.throws(() => mergedTree(dir, tip, '-h'), /is not a revision/);
  const tree = '0'.repeat(40);
  for (const [out, code] of [['', 0], ['not a tree\0', 0], [`${tree}\0web/x.js\0`, 0], [`${tree}\0`, 1], ['\0web/x.js\0', 1], [`${tree}\0web/x.js\0`, 2], [`${tree}\0`, 2], [`${tree}\0`, 128]] as const) {
    assert.throws(() => withMergeTreeShim(out, code, () => mergedTree(dir, tip, head)), /merge-tree .* failed/, JSON.stringify([out, code]));
  }
  assert.deepEqual(withMergeTreeShim(`${tree}\0`, 0, () => mergedTree(dir, tip, head)), { tree, conflicts: [] });
});

test("a git that can't write a merged tree (older than 2.38) makes every PR wait, its own change's reasons kept", () => {
  const o = { base: { 'test/t.test.ts': asserts(['assert.ok(true);', 'assert.equal(1, 1);']) }, tip: { README: 'x\n' }, head: { 'test/t.test.ts': asserts(['assert.ok(true);']) } };
  // An older git: merge-tree has no --write-tree (usage, exit 129); or a conflict's exit with no tree printed.
  for (const [out, code] of [["error: unknown option `write-tree'\nusage: git merge-tree <base-tree> <branch1> <branch2>\n", 129], ['usage: git merge-tree <base-tree> <branch1> <branch2>\n', 1]] as const) {
    const r = withMergeTreeShim(out, code, () => staleReasons(o));
    assert.equal(r.length, 2, r.join(' | '));
    assert.deepEqual(kinds(r.slice(0, 1)), [ASSERTION]);
    assert.ok(r[1]!.startsWith(COULD_NOT_RUN), r[1]);
    const control = withMergeTreeShim(out, code, () => staleReasons({ ...o, head: { 'web/x.js': 'export const x = 2;\n' } }));
    assert.equal(control.length, 1, control.join(' | '));
    assert.ok(control[0]!.startsWith(COULD_NOT_RUN), control[0]);
  }
});

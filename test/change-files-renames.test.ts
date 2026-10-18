// A renamed file is judged on its old and its new path (#683). With git's rename detection on, `git diff --numstat`
// prints one combined path for a rename with an edit (`test/{review.test.ts => review2.test.ts}`), which matches no
// glob: renaming a locked file and weakening it in the same change came out L0, and the content checks saw nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { changedFiles } from '../src/merge-base.js';
import { sizeFiles, sizeVerdict } from '../src/pr-rules.js';
import { computeLevel, type ChangeFile } from '../src/review.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A scratch repo with `files` committed; returns it and its first commit. */
function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rename-paths-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']]) git(dir, 'config', k!, v!);
  write(dir, files);
  return { dir, base: commit(dir, 'init') };
}

function write(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}

function commit(dir: string, msg: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Rename `from` to `to` and apply `edit` to its text, in one commit. */
function renameWithEdit(dir: string, from: string, to: string, edit: (text: string) => string): string {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  renameSync(join(dir, from), join(dir, to));
  writeFileSync(join(dir, to), edit(readFileSync(join(dir, to), 'utf8')));
  return commit(dir, `rename ${from}`);
}

/** The coordinator's own reader (CoordinatorBase.changeFiles), as merge-flow, landing, delegation and inspect call it. */
const changeFiles = (dir: string, base: string, head: string): ChangeFile[] =>
  (Coordinator.prototype as unknown as { changeFiles(cwd: string, base: string, head: string): ChangeFile[] }).changeFiles.call(Object.create(Coordinator.prototype), dir, base, head);

const LEVELS = {
  L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
  L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 },
  L2_notify: { when: ['dependency'] },
  L3_human: { when: ['engine-guards', 'deletes-data'], over_lines: 800 },
};
const cfg = ReviewConfig.parse({ version: 1, levels: LEVELS });
const level = (files: ChangeFile[], c = cfg) => computeLevel({ files, labels: [], moneyPaths: [] }, c);

/** A test file of `n` assertions, long enough that a small edit keeps it a rename (over git's 50% similarity). */
const testFile = (n: number) => `import assert from 'node:assert/strict';\n${Array.from({ length: n }, (_, i) => `test('case ${i}', () => assert.equal(f(${i}), ${i * 2}));`).join('\n')}\n`;

test('a rename with an edit of a locked test file lists both paths and comes out L3 / self-modification', () => {
  const { dir, base } = repo({ 'test/review.test.ts': testFile(20), 'README.md': '# x\n' });
  const head = renameWithEdit(dir, 'test/review.test.ts', 'test/review2.test.ts', (t) => t.replace(/test\('case 3'.*\n/, ''));
  // Git itself still pairs them (rename detection is on by default): the combined form is what the old reader got.
  assert.match(git(dir, 'diff', '--numstat', `${base}..${head}`), /test\/\{review\.test\.ts => review2\.test\.ts\}/);
  const files = changeFiles(dir, base, head);
  assert.deepEqual(files.map((f) => f.path).sort(), ['test/review.test.ts', 'test/review2.test.ts']);
  const lvl = level(files);
  assert.equal(lvl.level, 'L3', lvl.reasons.join('; '));
  assert.deepEqual(lvl.categories['self-modification'], ['test/review.test.ts']);
});

test('a rename with an edit of a review.yaml engine-guards file comes out L3', () => {
  // A file only review.yaml guards (not one the code locks), so the level comes from the configured category.
  const guarded = ReviewConfig.parse({ version: 1, categories: { 'engine-guards': ['docs/runbook.md'] }, levels: LEVELS });
  const runbook = `# Runbook\n\n${Array.from({ length: 30 }, (_, i) => `${i + 1}. Check step ${i + 1} before going on.`).join('\n')}\n`;
  const { dir, base } = repo({ 'docs/runbook.md': runbook });
  const head = renameWithEdit(dir, 'docs/runbook.md', 'docs/old-runbook.md', (t) => t.replace('Check step 4 before going on.', 'Skip step 4.'));
  const lvl = level(changeFiles(dir, base, head), guarded);
  assert.equal(lvl.level, 'L3', lvl.reasons.join('; '));
  assert.ok(lvl.reasons.includes('engine-guards: docs/runbook.md'), lvl.reasons.join('; '));
  assert.equal(lvl.categories['self-modification'], undefined, 'held by review.yaml alone');
});

test('the content checks see a renamed file\'s added lines', () => {
  const job = `export async function cleanup(db) {\n${Array.from({ length: 20 }, (_, i) => `  await db.touch('t${i}');`).join('\n')}\n}\n`;
  const { dir, base } = repo({ 'src/jobs/cleanup.js': job });
  const head = renameWithEdit(dir, 'src/jobs/cleanup.js', 'src/jobs/purge.js', (t) => t.replace("  await db.touch('t5');", "  await db.query('DELETE FROM sessions');"));
  const files = changeFiles(dir, base, head);
  const renamed = files.find((f) => f.path === 'src/jobs/purge.js');
  assert.ok(renamed?.addedLines?.includes("  await db.query('DELETE FROM sessions');"), JSON.stringify(files));
  const lvl = level(files);
  assert.deepEqual(lvl.categories['deletes-data'], ['src/jobs/purge.js']);
  assert.equal(lvl.level, 'L3', lvl.reasons.join('; '));
});

test('a path git would quote (a non-ASCII byte) is read as itself, and so is caught by its glob', () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { 'test/naïve.test.ts': testFile(2) });
  const head = commit(dir, 'add');
  const files = changeFiles(dir, base, head);
  assert.deepEqual(files.map((f) => f.path), ['test/naïve.test.ts']);
  assert.deepEqual(level(files).categories.tests, ['test/naïve.test.ts']);
});

test('an added line starting "++" and a removed one starting "--" are content, not diff headers', () => {
  const { dir, base } = repo({ 'src/count.c': 'int n;\n-- a note\nvoid f(void) {}\n' });
  write(dir, { 'src/count.c': 'int n;\nvoid f(void) {\n++n;\n}\n' });
  const head = commit(dir, 'edit');
  const [f] = changeFiles(dir, base, head);
  assert.ok(f!.addedLines!.includes('++n;'), JSON.stringify(f));
  assert.ok(f!.removedLines!.includes('-- a note'), JSON.stringify(f));
});

test('a repo set to detect copies (diff.renames=copies) still gets plain paths', () => {
  const { dir, base } = repo({ 'test/review.test.ts': testFile(20) });
  git(dir, 'config', 'diff.renames', 'copies');
  write(dir, { 'test/copy.test.ts': testFile(20), 'test/review.test.ts': testFile(19) });
  const head = commit(dir, 'copy');
  assert.match(git(dir, 'diff', '--numstat', `${base}..${head}`), /=>/, 'git pairs the copy with its source here');
  assert.deepEqual(changeFiles(dir, base, head).map((f) => f.path).sort(), ['test/copy.test.ts', 'test/review.test.ts']);
});

test('combined-state check: a rename on main names the path the PR may still touch (merge-base changedFiles)', () => {
  const { dir, base } = repo({ 'src/price.ts': testFile(20) });
  const head = renameWithEdit(dir, 'src/price.ts', 'src/cost.ts', (t) => t.replace('case 3', 'case three'));
  assert.deepEqual(changedFiles(dir, base, head).sort(), ['src/cost.ts', 'src/price.ts']);
});

test('size limit: an edit moved into a generated path still counts; a pure rename still counts 0', () => {
  const body = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  const { dir, base } = repo({ 'src/values.ts': body });
  const limits = { maxLines: 100, generated: ['**/*.generated.*'] };
  const moved = renameWithEdit(dir, 'src/values.ts', 'src/values.generated.ts', (t) => t.split('\n').map((l, i) => (i < 120 ? l.replace(/= (\d+);/, '= $1 + 1;') : l)).join('\n'));
  const edit = sizeVerdict(sizeFiles(dir, base, moved), limits);
  assert.deepEqual([edit.ok, edit.lines], [false, 240], edit.why);
  git(dir, 'reset', '-q', '--hard', base);
  const pure = renameWithEdit(dir, 'src/values.ts', 'src/values.generated.ts', (t) => t);
  const rename = sizeVerdict(sizeFiles(dir, base, pure), limits);
  assert.deepEqual([rename.ok, rename.lines], [true, 0], rename.why);
});

// Every other reader of changed paths that a level, merge, test-selection or guard decision rests on lists a rename
// as both its paths (--no-renames). One that only counts lines, or wants renames paired on purpose, says so here.
const PAIRED_ON_PURPOSE: Record<string, { line: RegExp; why: string }> = {
  'src/push-check.ts': { line: /'diff', '--numstat', range/, why: 'only sums the line counts (a rename counts its edit); no path is read' },
};

test('no reader of changed paths in src/ or scripts/ leaves rename detection on, unless it says why', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.(ts|mjs|cjs|js|sh)$/.test(e.name) || !e.name.includes('.')) files.push(join(d, e.name));
    }
  };
  walk(join(repoRoot, 'src'));
  walk(join(repoRoot, 'scripts'));
  const bad: string[] = [];
  for (const f of files) {
    const rel = relative(repoRoot, f).split('\\').join('/');
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (!/--(name-only|name-status|numstat|raw)\b/.test(l) || !/\b(diff|diff-tree|log|show)\b/.test(l) || /ls-tree/.test(l)) return;
        if (/--no-renames/.test(l)) return;
        if (PAIRED_ON_PURPOSE[rel]?.line.test(l)) return;
        bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 140)}`);
      });
  }
  assert.deepEqual(bad, [], 'add --no-renames, or list the reader in PAIRED_ON_PURPOSE with why its paths never matter');
});

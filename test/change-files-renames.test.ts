// A renamed file is judged on its old and its new path (#683). With git's rename detection on, `git diff --numstat`
// prints one combined path for a rename with an edit (`test/{review.test.ts => review2.test.ts}`), which matches no
// glob: renaming a locked file and weakening it in the same change came out L0, and the content checks saw nothing.
// The same class: a path git C-quotes (a non-ASCII byte, a tab, a quote, a backslash) or one with a newline in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import * as changeFilesModule from '../src/coordinator/change-files.js';
import { loosenedProblems } from '../src/delegation.js';
import { isProtectedPath } from '../src/guardrails/engine.js';
import { globToRegExp } from '../src/guardrails/glob.js';
// A namespace import, so the file still loads against a merge-base.ts without the stray check's helpers (fail-without).
import * as mergeBase from '../src/merge-base.js';
import { mergeDecision } from '../src/merge-policy.js';
import { riskClassOf, sizeFiles, sizeVerdict } from '../src/pr-rules.js';
import { computeLevel, type ChangeFile, type LevelInput } from '../src/review.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const IDENTITY = { name: 'Ada', email: 'ada@example.com' };

/** A scratch repo with `files` committed; returns it and its first commit. */
function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rename-paths-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', IDENTITY.email], ['user.name', IDENTITY.name], ['commit.gpgsign', 'false']]) git(dir, 'config', k!, v!);
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

/** The coordinator's inspect step (its protected-path guard comes before anything that needs a scanner or config). */
async function inspect(dir: string, base: string, head: string): Promise<{ rejected?: string }> {
  const c = Object.create(Coordinator.prototype) as object;
  Object.defineProperty(c, 'identity', { value: IDENTITY });
  // The push limits come right after the guard: reaching them means the guard let the change through.
  const guardrails = Object.defineProperty({ protected_paths: [] }, 'push', {
    get() {
      throw new Error('inspect got past the protected-path guard');
    },
  });
  Object.defineProperty(c, 'd', { value: { cfg: { guardrails } } });
  return (c as { inspect(n: number, path: string, base: string, head: string, repro: null): Promise<{ rejected?: string }> }).inspect(1, dir, base, head, null);
}

const LEVELS = {
  L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 },
  L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 },
  L2_notify: { when: ['dependency'] },
  L3_human: { when: ['engine-guards', 'deletes-data'], over_lines: 800 },
};
const cfg = ReviewConfig.parse({ version: 1, levels: LEVELS });
// The engine's own repo: no lock scope given (`as`, so this still compiles once #691 makes the scope a required key).
const level = (files: ChangeFile[], c = cfg) => computeLevel({ files, labels: [] as string[], moneyPaths: [] as RegExp[] } as LevelInput, c);

/** A test file of `n` assertions, long enough that a small edit keeps it a rename (over git's 50% similarity). */
const testFile = (n: number) => `import assert from 'node:assert/strict';\n${Array.from({ length: n }, (_, i) => `test('case ${i}', () => assert.equal(f(${i}), ${i * 2}));`).join('\n')}\n`;

test('a rename with an edit of a locked test file lists both paths and comes out L3 / self-modification', () => {
  const { dir, base } = repo({ 'test/review.test.ts': testFile(20), 'README.md': '# x\n' });
  const head = renameWithEdit(dir, 'test/review.test.ts', 'test/review2.test.ts', (t) => t.replace(/test\('case 3'.*\n/, ''));
  // Git itself pairs them when rename detection is on (pinned: a developer's own diff.renames=false would turn it
  // off): the combined form is what the old reader got.
  assert.match(git(dir, '-c', 'diff.renames=true', 'diff', '--numstat', `${base}..${head}`), /test\/\{review\.test\.ts => review2\.test\.ts\}/);
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
  assert.deepEqual(mergeBase.changedFiles(dir, base, head).sort(), ['src/cost.ts', 'src/price.ts']);
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

// ---- Odd bytes: every reader takes each path as itself (-z, through one helper)

test('the inspect guard refuses a protected path with an odd byte in its name, read as itself (.claude/agents/naïve.md)', async () => {
  const odd = ['.claude/agents/naïve.md', '.claude/agents/tab\there.md', '.claude/agents/say "hi".md', '.claude/agents/back\\slash.md'];
  const got: string[] = [];
  for (const p of odd) {
    const { dir, base } = repo({ 'README.md': '# x\n' });
    write(dir, { [p]: 'Be careful.\n' });
    const head = commit(dir, `add ${p}`);
    got.push(await inspect(dir, base, head).then((r) => r.rejected ?? JSON.stringify(r), (e: Error) => e.message));
  }
  assert.deepEqual(got, odd.map((p) => `changes protected harness files: ${p}`));
});

test('conflict fix: a resolver\'s edit to lib/naïve.ts, which the merge brought in cleanly, is a stray', () => {
  const big = (tag: string) => Array.from({ length: 30 }, (_, i) => `line ${i} ${tag}`).join('\n') + '\n';
  const { dir } = repo({ 'x.ts': 'one\ntwo\nthree\n', 'lib/naïve.ts': big('n') });
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, { 'x.ts': 'one\nTWO-pr\nthree\n' });
  commit(dir, 'pr');
  git(dir, 'checkout', '-q', 'main');
  write(dir, { 'x.ts': 'one\nTWO-main\nthree\n', 'lib/naïve.ts': `${big('n')}base\n` });
  const baseSha = commit(dir, 'base');
  git(dir, 'checkout', '-q', 'pr');
  const merged = mergeBase.mergeBaseInto(dir, baseSha, 'Merge main into pr', IDENTITY);
  assert.ok('conflicted' in merged, JSON.stringify(merged));
  assert.deepEqual([Object.keys(merged.conflicted), merged.otherFiles], [['x.ts'], ['lib/naïve.ts']]);
  const staged = mergeBase.stagedBlobs(dir, merged.otherFiles);
  write(dir, { 'x.ts': 'one\nTWO-pr TWO-main\nthree\n', 'lib/naïve.ts': `${big('n')}base\nevil\n` });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  assert.deepEqual(mergeBase.resolutionStrays(dir, ['x.ts'], merged.otherFiles, staged), ['lib/naïve.ts']);
});

test('scripts: slow-jobs.sh reads a PR\'s paths with -z, so scripts/setup/naïve.sh still runs the machine jobs', { skip: process.platform === 'win32' && 'bash' }, () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { 'scripts/setup/naïve.sh': 'echo hi\n' });
  const head = commit(dir, 'add a setup script');
  const r = spawnSync('bash', [join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', EVENT: 'pull_request', FULL: 'false', PR_BASE: base, PR_HEAD: head } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^run= testrun-real-systemd add-project-real-systemd auth-probe-real-users wizard-e2e-real-systemd $/m);
});

test('scripts: the updater\'s release check reads the release commit with -z, so dist/naïve.js is inside dist/', () => {
  const update = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as {
    verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): { ok: boolean; reason?: string };
  };
  const { dir } = repo({ 'package.json': '{"version":"1.0.0"}\n' });
  write(dir, { 'dist/naïve.js': '// built\n', 'dist/src/cli.js': '// built\n' });
  commit(dir, 'Release v1.0.1');
  git(dir, 'tag', '-a', 'v1.0.1', '-m', 'v1.0.1');
  git(dir, 'checkout', '-q', '--detach');
  git(dir, 'branch', '-f', 'main', 'HEAD~1');
  // The signature check is the release channel's own test's (release-channel.test.ts); here only the paths matter.
  const exec = (file: string, args: string[]) => (args.includes('verify-tag') ? '' : execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const v = update.verifyRelease(dir, 'v1.0.1', join(dir, 'package.json'), exec, join(mkdtempSync(join(tmpdir(), 'verify-')), 'v.git'));
  assert.deepEqual(v, { ok: true, base: git(dir, 'rev-parse', 'v1.0.1~1') });
});

test('changedNames: each path as itself (non-ASCII, tab, quote, backslash, newline, leading space), a rename as both', () => {
  const { dir, base } = repo({ 'src/old.ts': testFile(20) });
  const odd = ['src/naïve.ts', 'src/tab\there.ts', 'src/say "hi".ts', 'src/back\\slash.ts', 'src/new\nline.ts', ' lead.ts'];
  write(dir, Object.fromEntries(odd.map((p) => [p, `export const p = ${JSON.stringify(p)};\n`])));
  const head = renameWithEdit(dir, 'src/old.ts', 'src/renamed.ts', (t) => t.replace('case 3', 'case three'));
  const want = [...odd, 'src/old.ts', 'src/renamed.ts'].sort();
  assert.deepEqual(changeFilesModule.changedNames(dir, [`${base}..${head}`]).sort(), want);
  assert.deepEqual(changeFilesModule.changedNames(dir, ['-r', '-m', '--first-parent', '--no-commit-id', head], { tree: true }).sort(), want);
  assert.deepEqual(changeFilesModule.changedStatuses(dir, [`${base}..${head}`]).map((s) => `${s.status} ${s.path}`).sort(), want.map((p) => `${p === 'src/old.ts' ? 'D' : 'A'} ${p}`).sort());
  assert.equal(changeFilesModule.changedNamesOrNull(dir, ['no-such-commit']), null);
  // The repro check's untracked files, the same way (coordinator.ts: "changed more than the test").
  write(dir, { 'test/naïve repro.test.ts': '// new\n', 'test/new\nline.test.ts': '// new\n' });
  assert.deepEqual(changeFilesModule.untrackedNames(dir).sort(), ['test/naïve repro.test.ts', 'test/new\nline.test.ts']);
});

test('changedNames refuses an option that would turn renames back on, change the format or write a file', () => {
  const { dir, base } = repo({ 'a.ts': 'a\n' });
  for (const opt of ['--find-renames', '-M', '-M50%', '--find-copies', '-C', '--stat', '--output=x', '--relative', '--name-status', '--no-renames'])
    assert.throws(() => changeFilesModule.changedNames(dir, [opt, base]), /is not an option a name list takes/, opt);
});

test('the helper module exports functions only: no flag list another file could build a reader from', () => {
  for (const [name, v] of Object.entries(changeFilesModule)) assert.equal(typeof v, 'function', name);
});

// ---- A newline can't take a path out of a `**` glob

/** The evaluator's paths: a newline in a directory or file name under a guarded tree. */
const NEWLINE_PATHS = ['.claude/skills/a\nb/SKILL.md', 'src/guardrails/a\nb.ts', '.github/workflows/a\nb.yml', `${BRAND.configDir}/roles/a\nb.md`];

test('a path with a newline stays under its `**` glob: protected, and L3 under the engine\'s own review.yaml', () => {
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  // The built-in protected paths, and a project's own list on top.
  const guard = { protected_paths: ['src/guardrails/**', '.github/workflows/**'] };
  const each = (p: string) => ({ path: p, level: level([{ path: p, added: 1, removed: 0 }], engine).level, protected: isProtectedPath(p, guard) });
  // Each as its twin without the newline: L3, and protected unless it is the agents' own (roles are theirs to edit).
  assert.deepEqual(NEWLINE_PATHS.map(each), NEWLINE_PATHS.map((p) => ({ ...each(p.replace('\n', '')), path: p })));
  assert.deepEqual(NEWLINE_PATHS.map((p) => [each(p).level, each(p).protected]), [['L3', true], ['L3', true], ['L3', true], ['L3', false]]);
  assert.ok(globToRegExp('src/**/*.ts').test('src/a\nb/c.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'), 'a single * still stops at a slash');
});

test('a changed path with a control character is L3 "path with a control character" and never merges itself, whatever review.yaml lists', () => {
  // A review.yaml with no L3 category these paths fall in: only the control character can make them L3.
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  const one = (p: string) => {
    const lvl = level([{ path: p, added: 1, removed: 0 }], plain);
    const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level: lvl, waitCategories: [], limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
    return { path: p, level: lvl.level, reason: lvl.reasons.find((r) => r.startsWith('path with a control character')) ?? lvl.reasons.join('; '), cls: riskClassOf({ paths: [p], level: lvl, waitCategories: [] }).cls, auto: merge.auto, protected: isProtectedPath(p, { protected_paths: [] }) };
  };
  const odd = [...NEWLINE_PATHS, 'docs/a\nb.md', 'web/tab\there.ts', 'README\u001b[2J.md', 'src/del\u007f.ts', 'src/c1\u0085.ts'];
  assert.deepEqual(
    odd.map(one),
    odd.map((p) => ({
      path: p,
      level: 'L3',
      reason: `path with a control character: ${JSON.stringify(p)}`,
      cls: 'protected',
      auto: false,
      // The built-in protected paths alone: only the one under .claude/ (the roles are the agents' own to edit).
      protected: p === '.claude/skills/a\nb/SKILL.md',
    })),
  );
  // The same paths without the control character: not L3 under this review.yaml (so the character is what decides).
  assert.deepEqual(['docs/ab.md', 'web/tabhere.ts'].map((p) => one(p).level), ['L0', 'L1']);
  // The evaluator's four, with a project's own list on top of the built-in one.
  assert.deepEqual(NEWLINE_PATHS.map((p) => isProtectedPath(p, { protected_paths: ['src/guardrails/**', '.github/workflows/**'] })), [true, true, true, false]);
});

test('a newline path committed to a repo comes out of changeFiles as itself and is L3 / protected', async () => {
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { '.claude/skills/a\nb/SKILL.md': '# skill\n' });
  const head = commit(dir, 'add a skill');
  const files = changeFiles(dir, base, head);
  assert.deepEqual(files.map((f) => f.path), ['.claude/skills/a\nb/SKILL.md']);
  assert.equal(level(files, engine).level, 'L3');
  assert.deepEqual(await inspect(dir, base, head), { rejected: 'changes protected harness files: .claude/skills/a\nb/SKILL.md' });
});

// ---- A name that isn't valid UTF-8 can't be read as itself, so it waits for the owner

/** `text` as `rel` (bytes, so a name that isn't valid UTF-8 can be made anywhere) in the index of `dir`, no file on disk. */
function stageBytes(dir: string, rel: Buffer, text: string) {
  const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-index', '--add', '-z', '--index-info'], { cwd: dir, input: Buffer.concat([Buffer.from(`100644 ${sha}\t`), rel, Buffer.from([0])]) });
}
/** A name with the byte 0xff in it: `before` 0xff `after`. */
const ff = (before: string, after: string) => Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]);

test('a changed name that isn\'t valid UTF-8 is L3 "path that isn\'t valid UTF-8" and never merges itself, whatever review.yaml lists', () => {
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  // Review.yaml files that would let it through if anything could: no L3 at all, the category emptied, docs everywhere.
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const hostile = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } }, categories: { 'non-utf8-path': [], docs: ['**'] } });
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  /** The change `rel` adds, as each review.yaml judges it, and whether the merge gate (waiting on nothing) takes it. */
  const judge = (rel: Buffer, text: string) => {
    const { dir, base } = repo({ 'README.md': '# x\n' });
    stageBytes(dir, rel, text);
    git(dir, 'commit', '-q', '-m', 'add a file');
    const files = changeFiles(dir, base, git(dir, 'rev-parse', 'HEAD'));
    return [engine, plain, hostile].map((c) => {
      const lvl = level(files, c);
      const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level: lvl, waitCategories: [], limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
      const paths = files.map((f) => f.path);
      return { paths, level: lvl.level, reason: lvl.reasons.find((r) => r.startsWith('path that')), cls: riskClassOf({ paths, level: lvl, waitCategories: [] }).cls, auto: merge.auto };
    });
  };
  const want = (p: string) => ({ paths: [p], level: 'L3', reason: `path that isn't valid UTF-8: ${JSON.stringify(p)}`, cls: 'protected', auto: false });
  assert.deepEqual(judge(ff('web/bad', '.ts'), "await db.query('DROP TABLE users');\n"), Array(3).fill(want('web/bad�.ts')));
  assert.deepEqual(judge(ff('docs/bad', '.md'), '# notes\n'), Array(3).fill(want('docs/bad�.md')));
  // The same gate takes the plain twin, so the name is what holds the change above.
  assert.deepEqual(judge(Buffer.from('docs/ok.md'), '# notes\n').map((r) => [r.level, r.cls, r.auto]), Array(3).fill(['L0', 'docs-only', true]));
  // The helper's other readers name it the same way: never a string that drops or hides the bad byte.
  const { dir, base } = repo({ 'README.md': '# x\n' });
  stageBytes(dir, ff('src/bad', '.ts'), 'x\n');
  git(dir, 'commit', '-q', '-m', 'add');
  assert.deepEqual(changeFilesModule.changedNames(dir, [base, 'HEAD']), ['src/bad�.ts']);
  assert.deepEqual(changeFilesModule.changedStatuses(dir, [base, 'HEAD']), [{ status: 'A', path: 'src/bad�.ts' }]);
  // And review.yaml can't loosen it.
  assert.deepEqual(loosenedProblems({ levels: { L3_human: { when: [] } }, merge: { loosened: ['non-utf8-path'] } }), ['merge.loosened: non-utf8-path is high-risk or a safety floor and can never be loosened']);
});

test('conflict fix: a file whose name isn\'t valid UTF-8 and that the merge brought in cleanly is a stray (its blob can\'t be read)', { skip: process.platform !== 'linux' && 'names that are not UTF-8 on disk: Linux only' }, () => {
  const big = (tag: string) => Array.from({ length: 30 }, (_, i) => `line ${i} ${tag}`).join('\n') + '\n';
  const bad = (dir: string) => Buffer.concat([Buffer.from(`${dir}/`), ff('lib/bad', '.ts')]);
  const { dir } = repo({ 'x.ts': 'one\ntwo\nthree\n' });
  mkdirSync(join(dir, 'lib'));
  writeFileSync(bad(dir), big('n'));
  commit(dir, 'add lib/bad\\xff.ts');
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, { 'x.ts': 'one\nTWO-pr\nthree\n' });
  commit(dir, 'pr');
  git(dir, 'checkout', '-q', 'main');
  write(dir, { 'x.ts': 'one\nTWO-main\nthree\n' });
  writeFileSync(bad(dir), `${big('n')}base\n`);
  const baseSha = commit(dir, 'base');
  git(dir, 'checkout', '-q', 'pr');
  const merged = mergeBase.mergeBaseInto(dir, baseSha, 'Merge main into pr', IDENTITY);
  assert.ok('conflicted' in merged, JSON.stringify(merged));
  assert.deepEqual([Object.keys(merged.conflicted), merged.otherFiles], [['x.ts'], ['lib/bad�.ts']]);
  const staged = mergeBase.stagedBlobs(dir, merged.otherFiles);
  // The merge staged it, but its blob can't be asked for by name: that is said, never read as "not there".
  assert.deepEqual(staged, { 'lib/bad�.ts': mergeBase.UNREADABLE });
  write(dir, { 'x.ts': 'one\nTWO-pr TWO-main\nthree\n' });
  writeFileSync(bad(dir), `${big('n')}base\nevil\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  assert.deepEqual(mergeBase.resolutionStrays(dir, ['x.ts'], merged.otherFiles, staged), ['lib/bad�.ts']);
});

test('conflict fix: a conflicted file whose name isn\'t valid UTF-8 is a stray, even resolved to the branch\'s own side', { skip: process.platform !== 'linux' && 'names that are not UTF-8 on disk: Linux only' }, () => {
  const bad = (dir: string) => Buffer.concat([Buffer.from(`${dir}/`), ff('lib/bad', '.ts')]);
  const { dir } = repo({ 'x.ts': 'x\n' });
  mkdirSync(join(dir, 'lib'));
  writeFileSync(bad(dir), 'one\ntwo\nthree\n');
  commit(dir, 'add lib/bad\\xff.ts');
  git(dir, 'checkout', '-q', '-b', 'pr');
  writeFileSync(bad(dir), 'one\nTWO-pr\nthree\n');
  const prSide = commit(dir, 'pr');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(bad(dir), 'one\nTWO-main\nthree\n');
  const baseSha = commit(dir, 'base');
  git(dir, 'checkout', '-q', 'pr');
  const merged = mergeBase.mergeBaseInto(dir, baseSha, 'Merge main into pr', IDENTITY);
  assert.ok('conflicted' in merged, JSON.stringify(merged));
  assert.deepEqual([Object.keys(merged.conflicted), merged.otherFiles], [['lib/bad�.ts'], []]);
  const staged = mergeBase.stagedBlobs(dir, merged.otherFiles);
  // The branch's side, so the merge commit doesn't change it against the branch: only its name can say it.
  git(dir, 'checkout', '-q', prSide, '--', 'lib');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  assert.deepEqual(mergeBase.resolutionStrays(dir, Object.keys(merged.conflicted), merged.otherFiles, staged), ['lib/bad�.ts']);
});

test('conflict fix: a resolver that drops a file the merge brought in cleanly is a stray, even when its name reads like a stage spec (0:lib/x.ts)', { skip: process.platform === 'win32' && 'a colon in a file name' }, () => {
  // `:0:lib/x.ts` is stage 0 of lib/x.ts, not the file 0:lib/x.ts: a lookup of the index by `:<path>` finds no blob
  // for it, and once the resolver drops it, HEAD has none either. Two empty lookups must not pass as "unchanged".
  const { dir } = repo({ 'x.ts': 'one\ntwo\nthree\n' });
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, { 'x.ts': 'one\nTWO-pr\nthree\n' });
  commit(dir, 'pr');
  git(dir, 'checkout', '-q', 'main');
  write(dir, { 'x.ts': 'one\nTWO-main\nthree\n', '0:lib/x.ts': 'export const guard = true;\n' });
  const baseSha = commit(dir, 'base');
  git(dir, 'checkout', '-q', 'pr');
  const merged = mergeBase.mergeBaseInto(dir, baseSha, 'Merge main into pr', IDENTITY);
  assert.ok('conflicted' in merged, JSON.stringify(merged));
  assert.deepEqual([Object.keys(merged.conflicted), merged.otherFiles], [['x.ts'], ['0:lib/x.ts']]);
  const staged = mergeBase.stagedBlobs(dir, merged.otherFiles);
  write(dir, { 'x.ts': 'one\nTWO-pr TWO-main\nthree\n' });
  git(dir, 'rm', '-q', '-f', '--', '0:lib/x.ts');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  assert.deepEqual(mergeBase.resolutionStrays(dir, ['x.ts'], merged.otherFiles, staged), ['0:lib/x.ts']);
});

// ---- One way to list changed names or counts

/** The helper: the only module that asks git which paths a change touches or how many lines it changes. */
const HELPER = 'src/coordinator/change-files.ts';

/**
 * What lists changed paths or counts lines from git, or reads paths from a patch: each word is searched for in the
 * whole file text, so a call split over lines or a comment beside it doesn't hide it, nor does a distinctive flag
 * (`--name-only`, `diff-files`, ...) kept in a constant. A word list, not a proof. Known gaps: a flag built by
 * concatenation (`'--name' + '-only'`), a header regex that never spells the header, and a short or common flag
 * (`status -s`, `diff --check`) kept in a constant away from its subcommand.
 */
const READER_WORDS: Record<string, RegExp> = {
  'name-only': /name-only/g,
  'name-status': /name-status/g,
  numstat: /numstat/g,
  stat: /--stat\b|shortstat|dirstat|--(?:compact-)?summary\b/g,
  // diff-tree, diff-index and diff-files print the raw format (paths) with no flag at all.
  raw: /--raw\b|diff-tree|diff-index|diff-files/g,
  // ls-files lists the untracked, modified or deleted files of a worktree: what a run changed.
  'worktree changes': /--others\b|--modified\b|--deleted\b|--unmerged\b/g,
  // Any ls-files at all: its short flags (-o -m -d -u) are too short to search for alone.
  'ls-files': /ls-files/g,
  whatchanged: /whatchanged/g,
  porcelain: /porcelain/g,
  // `status -s` / `--short`: the short format lists changed paths.
  'short status': /\bstatus['"`]?\s*,?\s*['"`]?(?:-[a-z]*s[a-z]*|--short)\b/g,
  // `stash show` prints a stat of the stash by default.
  'stash show': /stash['"`]?\s*,?\s*['"`]?show\b/g,
  // `diff --check` prints `path:line: ...` for each whitespace error.
  'diff --check': /diff['"`]?\s*,?\s*['"`]?--check\b/g,
  'rename detection': /find-renames|find-copies|--follow\b|diff\.renames|['"`]-M\d*%?['"`]/g,
  'patch headers': /\+\+\+|---\s?a\\?\/|\^---(?: |\\s)|diff --git|rename (?:from|to) /g,
};

/**
 * Files outside the helper that hold one of those words, each with how many times (exactly: one more is a new reader)
 * and why. src/: none of them lists the paths a change touches for a decision. scripts/: their own -z parsing.
 */
const OUTSIDE_THE_HELPER: Record<string, { words: Record<string, number>; why: string; must?: RegExp[] }> = {
  // src/: not a list of what a change touches.
  'src/checkout-sync.ts': { words: { porcelain: 1 }, why: '`status --porcelain`: is the checkout clean (empty or not); no path is read' },
  'src/coordinator/landing.ts': { words: { porcelain: 1 }, why: '`status --porcelain`: is the worktree clean; no path is read' },
  'src/worktree-pool.ts': { words: { porcelain: 2 }, why: '`status --porcelain`: is a pooled worktree clean; no path is read' },
  'src/coordinator.ts': {
    words: { 'name-only': 1, 'ls-files': 1, porcelain: 2 },
    why: '`ls-tree -r -z --name-only`: the files of a tree, not a change (combined-state imports); `ls-files`: every tracked file, for the file index; `status --porcelain` twice: is the worktree clean',
  },
  'src/config/load.ts': { words: { 'name-only': 1 }, why: '`ls-tree --name-only`: the role files of a tree, not a change' },
  'src/harness-evals/replay.ts': { words: { 'name-only': 1 }, why: '`ls-tree -r -z --name-only`: the files of a tree, not a change' },
  'src/starter-ci.ts': { words: { 'name-only': 1, 'ls-files': 2 }, why: '`ls-tree -r --name-only`, or `ls-files` (and a comment naming it): the files of a tree, not a change' },
  'src/testrun/select.ts': { words: { 'name-only': 1 }, why: '`ls-tree -r -z --name-only`: the files of a tree, not a change' },
  'src/claims.ts': { words: { porcelain: 1 }, why: '`push --porcelain`: the push result, no diff' },
  'src/worktrees.ts': { words: { 'ls-files': 1, porcelain: 1 }, why: '`ls-files -- <path>`: is one path tracked; `worktree list --porcelain`: the worktrees, no diff' },
  'src/auto-config.ts': { words: { 'ls-files': 1 }, why: '`ls-files`: the tracked files, to detect the project; not a change' },
  'src/dashboard.ts': { words: { 'ls-files': 1 }, why: "`ls-files`: the tracked files that look like tests, for the first-task form's picker; not a change" },
  'src/skill-lint.ts': { words: { 'ls-files': 1 }, why: '`ls-files -z -- *SKILL.md`: every tracked skill file; not a change' },
  'src/testrun/affected.ts': { words: { 'ls-files': 3 }, why: 'two comments and a regex that recognises `ls-files` in a test command; runs no git' },
  'src/coordinator/loop-control.ts': { words: { stat: 1 }, why: 'prompt text naming `git diff --stat`; the text comes from diffStatText' },
  'src/experiments/proposal.ts': { words: { raw: 2 }, why: 'parseRawDiff, in comments: it parses what rawChanges returns' },
  'src/run-record.ts': { words: { 'name-only': 1, 'name-status': 1, numstat: 1, stat: 2 }, why: "a regex that recognises these flags in an agent's own commands; runs no git" },
  'src/instance-rename.ts': { words: { 'patch headers': 1 }, why: 'a commit message ("rename from <name>"), no diff' },
  'src/line-diff.ts': { words: { 'patch headers': 1 }, why: 'writes a diff header for display; reads none' },
  'src/run-feed.ts': { words: { 'patch headers': 2 }, why: 'writes a diff header (`--- a/`, `+++ b/`) for display; reads none' },
  // src/: readers that stay outside the helper, each with why.
  'src/comment-policy.ts': {
    words: { 'ls-files': 1, 'rename detection': 1, 'patch headers': 3 },
    why: "`ls-files --error-unmatch`: is one file tracked. The comment lint over added lines wants renames paired (a moved file's lines aren't new); it is in the agents' tool guard's import tree, which can't take a new import while #691 lists that tree",
  },
  'src/push-check.ts': {
    words: { 'name-only': 1, numstat: 1 },
    why: '`log --name-only --no-renames` (refuse_paths, workflows, the SKILL.md lint) still splits on newlines: a follow-up moves it here (-z); `--numstat` only sums line counts, no path is read',
  },
  // scripts/: their own -z parsing, in their own language.
  'scripts/ci/slow-jobs.sh': { words: { 'name-only': 1 }, why: 'CI slow-job selection', must: [/--name-only --no-renames -z/] },
  'scripts/pin-engine.mjs': { words: { 'name-only': 1 }, why: 'the release commit "changes only dist/" check', must: [/'--name-only', '--no-renames', '-z'/, /split\('\\0'\)/] },
  'scripts/machine/worklane-update.cjs': { words: { 'name-only': 1 }, why: 'the updater\'s "changes only dist/" check', must: [/'--name-only', '--no-renames', '-z'/, /split\('\\0'\)/] },
  'scripts/ci/affected.mjs': {
    words: { 'name-only': 2, 'worktree changes': 2, 'ls-files': 2 },
    why: 'CI test selection (and `ls-files -z --cached --others`: every file of the checkout)',
    must: [/'--name-only', '--no-renames', '-z'/, /'--name-only', '--no-renames', '--diff-filter=A', '-z'/, /'ls-files', '-z', '--cached', '--others'/],
  },
  'scripts/push-gate.mjs': { words: { 'name-only': 1, 'patch headers': 2 }, why: '`ls-tree --name-only`: a tree; `show --no-renames` added lines: the denylist scan of what is pushed (a follow-up: its `+++ ` header parse)' },
  'scripts/ci/testrun-real-systemd.mjs': { words: { 'name-only': 1, porcelain: 1 }, why: 'shell lines a slow CI job runs in its VM (`ls-tree`, `status --porcelain`: is it clean)' },
  'scripts/release.mjs': { words: { porcelain: 1 }, why: '`status --porcelain`: is the tree clean before a release' },
  'scripts/check-denylist.mjs': { words: { 'ls-files': 1 }, why: '`ls-files -co`: every file of the checkout, to scan; not a change' },
  'scripts/rename.mjs': { words: { 'ls-files': 1 }, why: '`ls-files -co`: every file of the checkout, to rename the product in; not a change' },
};

test('one helper is the only way src/ lists changed names or counts; scripts/ only on this keyed list', () => {
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
  const seen = new Set<string>();
  for (const f of files) {
    const rel = relative(repoRoot, f).split('\\').join('/');
    if (rel === HELPER) continue;
    const text = readFileSync(f, 'utf8');
    const words = Object.fromEntries(Object.entries(READER_WORDS).map(([w, re]) => [w, text.match(re)?.length ?? 0]).filter(([, n]) => n));
    if (!Object.keys(words).length) continue;
    seen.add(rel);
    const allowed = OUTSIDE_THE_HELPER[rel];
    if (!allowed) bad.push(`${rel}: ${JSON.stringify(words)} (not on the list)`);
    else if (!isDeepStrictEqual(words, allowed.words)) bad.push(`${rel}: ${JSON.stringify(words)}, listed ${JSON.stringify(allowed.words)}`);
    else for (const re of allowed.must ?? []) if (!re.test(text)) bad.push(`${rel}: no ${re}`);
  }
  for (const rel of Object.keys(OUTSIDE_THE_HELPER)) if (!seen.has(rel)) bad.push(`${rel}: listed, but holds none of the words any more (take it off the list)`);
  assert.deepEqual(bad, [], `list changed names or counts through ${HELPER} (changedNames, changedStatuses, changeFiles, ...)`);
});

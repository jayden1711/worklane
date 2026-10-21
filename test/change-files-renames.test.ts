// lint-test
// A renamed file is judged on its old and its new path (#683). With git's rename detection on, `git diff --numstat`
// prints one combined path for a rename with an edit (`test/{review.test.ts => review2.test.ts}`), which matches no
// glob: renaming a locked file and weakening it in the same change came out L0, and the content checks saw nothing.
// The same class: a path git C-quotes (a non-ASCII byte, a tab, a quote, a backslash) or one with a newline in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { DEFAULT_GENERATED, ReviewConfig } from '../src/config/schema.js';
import { DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';
import { Coordinator } from '../src/coordinator.js';
import * as changeFilesModule from '../src/coordinator/change-files.js';
import { loosenedProblems } from '../src/delegation.js';
import { isProtectedPath } from '../src/guardrails/engine.js';
import { globToRegExp } from '../src/guardrails/glob.js';
// A namespace import, so the file still loads against a merge-base.ts without the stray check's helpers (fail-without).
import * as mergeBase from '../src/merge-base.js';
// A namespace import, so the file still loads against a conflicts.ts without the comment builder (fail-without).
import * as conflicts from '../src/conflicts.js';
import { instructionEvalReasons, mergeDecision, waitCategoriesOf, whyHighRisk } from '../src/merge-policy.js';
import { checkDraft } from '../src/checks-from-feedback.js';
import { crossFamilySkip } from '../src/cross-eval.js';
import { revertFirstReasons } from '../src/fix-forward.js';
import { reviewPacket } from '../src/coordinator/review-packet.js';
import type { EventPayload } from '../src/events/types.js';
import { lightCheckPlan } from '../src/light-check.js';
import { riskClassOf, sizeFiles, sizeVerdict } from '../src/pr-rules.js';
import { computeLevel, escapedPath, hidesDiff, isGitattributesPath, isGitmodulesPath, selfModificationPart, shownPath, unhidLine, type ChangeFile, type LevelInput } from '../src/review.js';
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

/** A string as a reason shows an odd path: JSON-quoted, every character outside printable ASCII as \uXXXX. */
const esc = (s: string) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

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
  // The tab, a control character, shows escaped (round 5); the others as themselves.
  assert.deepEqual(got, odd.map((p) => `changes protected harness files: ${p.includes('\t') ? esc(p) : p}`));
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
  assert.match(r.stdout, /^run= testrun-real-systemd add-project-real-systemd auth-probe-real-users egress-real-systemd wizard-e2e-real-systemd $/m);
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
  assert.deepEqual(v, { ok: true, base: git(dir, 'rev-parse', 'v1.0.1~1'), object: git(dir, 'rev-parse', 'v1.0.1'), commit: git(dir, 'rev-parse', 'v1.0.1^{commit}') });
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
      // Escaped: JSON.stringify alone left DEL and a C1 control (NEL) raw (round 5).
      reason: `path with a control character: ${esc(p)}`,
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
  assert.deepEqual(await inspect(dir, base, head), { rejected: 'changes protected harness files: ".claude/skills/a\\nb/SKILL.md"' });
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

// ---- A name that can read as another always waits (the owner's call); an ordinary odd name gets normal review

/**
 * Review.yaml files that would let a change through if anything could: the engine's own, one with no L3 category,
 * and one that empties the look-alike categories and calls every path docs.
 */
const lenientReviews = () => [
  ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8'))),
  ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } }),
  ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } }, categories: { 'invisible-character-path': [], 'non-ascii-top-level-path': [], docs: ['**'] } }),
];

/** What a scratch repo starts with: a top-level directory of each kind the cases below touch. */
const START = { 'README.md': '# x\n', 'docs/guide.md': '# guide\n\nSome text.\n', 'web/app.ts': 'export const app = 1;\n', 'lib/a.ts': 'export const a = 1;\n', 'src/app.ts': 'export const s = 1;\n' };

/**
 * base..head as merge-flow's mergeDecisionFor reads and judges it, under each review.yaml above, with an approving
 * verdict: the paths, the level, the odd-name reason, the risk class, whether it merges itself, and its high-risk
 * reasons.
 */
function judgeRange(dir: string, base: string, head: string) {
  const files = changeFiles(dir, base, head);
  const paths = files.map((f) => f.path);
  // merge-flow's new-top-level reading (a design hold): a top-level directory the base doesn't have.
  const newTopLevel = [...new Set(paths.map((p) => p.split('/')).filter((s) => s.length > 1).map((s) => s[0]!))].filter((d) => spawnSync('git', ['cat-file', '-e', `${base}:${d}`], { cwd: dir }).status !== 0).map((d) => `${d}/`);
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  return lenientReviews().map((c) => {
    const lvl = level(files, c);
    const waitCategories = waitCategoriesOf(c);
    const lines = files.reduce((n, f) => n + f.added + f.removed, 0);
    const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level: lvl, waitCategories, limits: { max_lines: 800, max_files: 20 }, lines, files: files.length, verdict, newTopLevel, ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
    const reason = lvl.reasons.find((r) => r.startsWith('path with an invisible') || r.startsWith('top-level name'));
    return { paths, level: lvl.level, reason, cls: riskClassOf({ paths, level: lvl, waitCategories }).cls, auto: merge.auto, highRisk: merge.reasons.filter((r) => r.startsWith('high-risk: ')) };
  });
}

/** A scratch repo holding START and `base`, then one commit adding `add`, judged (judgeRange). */
function judgeAdd(add: Record<string, string>, base: Record<string, string> = {}) {
  const r = repo({ ...START, ...base });
  write(r.dir, add);
  return judgeRange(r.dir, r.base, commit(r.dir, 'add'));
}

/** Each review.yaml above on a change the floor holds: L3 for `reason`, protected, waits, high-risk on `category`. */
const held = (paths: string[], reason: string, category: string, shown: string) =>
  Array(3).fill({ paths, level: 'L3', reason, cls: 'protected', auto: false, highRisk: [`high-risk: ${category} (${shown})`] });
/** [level, risk class, merges itself] under each review.yaml above. */
const brief = (r: ReturnType<typeof judgeRange>) => r.map((x) => [x.level, x.cls, x.auto]);

test('a name with a bidi override or isolate is L3 "path with an invisible or format character" and never merges itself; its plain twin is as before', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE: docs/read<U+202E>dm.txt shows as docs/readtxt.md.
  assert.deepEqual(judgeAdd({ 'docs/read\u202edm.txt': 'notes\n' }), held(['docs/read\u202edm.txt'], 'path with an invisible or format character: "docs/read\\u202edm.txt"', 'invisible-character-path', '"docs/read\\u202edm.txt"'));
  // U+2067 RIGHT-TO-LEFT ISOLATE.
  assert.deepEqual(judgeAdd({ 'web/a\u2067b.ts': 'export {};\n' }), held(['web/a\u2067b.ts'], 'path with an invisible or format character: "web/a\\u2067b.ts"', 'invisible-character-path', '"web/a\\u2067b.ts"'));
  // The plain twins: as on main (docs: L0, merges itself; web: L1, merges itself after the evaluator).
  assert.deepEqual(brief(judgeAdd({ 'docs/readdm.txt': 'notes\n' })), Array(3).fill(['L0', 'docs-only', true]));
  assert.deepEqual(brief(judgeAdd({ 'docs/ok.md': '# ok\n' })), Array(3).fill(['L0', 'docs-only', true]));
  assert.deepEqual(brief(judgeAdd({ 'web/ab.ts': 'export {};\n' })), [['L1', 'logic', true], ['L1', 'logic', true], ['L0', 'logic', true]]);
});

test('a name with a zero-width space is L3 "path with an invisible or format character" and never merges itself; its plain twin is as before', () => {
  // U+200B ZERO WIDTH SPACE: web/in<U+200B>dex.ts shows as web/index.ts.
  assert.deepEqual(judgeAdd({ 'web/in\u200bdex.ts': 'export {};\n' }), held(['web/in\u200bdex.ts'], 'path with an invisible or format character: "web/in\\u200bdex.ts"', 'invisible-character-path', '"web/in\\u200bdex.ts"'));
  assert.deepEqual(brief(judgeAdd({ 'web/index.ts': 'export {};\n' })), [['L1', 'logic', true], ['L1', 'logic', true], ['L0', 'logic', true]]);
});

test('a name with another format character (Cf) or a default-ignorable code point is L3 and never merges itself; the test is the Unicode properties, not a hand list', () => {
  // U+2062 INVISIBLE TIMES (Cf, outside the bidi and zero-width ranges).
  assert.deepEqual(judgeAdd({ 'lib/a\u2062b.ts': 'export {};\n' }), held(['lib/a\u2062b.ts'], 'path with an invisible or format character: "lib/a\\u2062b.ts"', 'invisible-character-path', '"lib/a\\u2062b.ts"'));
  assert.deepEqual(brief(judgeAdd({ 'lib/ab.ts': 'export {};\n' })), [['L1', 'logic', true], ['L1', 'logic', true], ['L0', 'logic', true]]);
  // Every character the owner named, and default-ignorables outside Cf (U+034F, U+3164 Hangul filler, U+FE0F): each
  // makes a docs path L3. Accented and Cyrillic letters below the top level don't.
  const named = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x0600, 0x2062, 0xe0001, 0x034f, 0x3164, 0xfe0f];
  const lvl = (p: string) => level([{ path: p, added: 1, removed: 0 }]).level;
  assert.deepEqual(named.map((c) => [c.toString(16), lvl(`docs/a${String.fromCodePoint(c)}b.md`)]), named.map((c) => [c.toString(16), 'L3']));
  assert.deepEqual(['docs/caf\u00e9.md', 'docs/\u0455rc.md', 'docs/ab.md'].map(lvl), ['L0', 'L0', 'L0']);
});

test('a top-level directory whose name isn\'t ASCII (Cyrillic \u0455rc/) is L3 "top-level name that isn\'t ASCII" and never merges itself; the Latin twin is as before', () => {
  const want = held(['\u0455rc/x.ts'], 'top-level name that isn\'t ASCII: "\\u0455rc/x.ts"', 'non-ascii-top-level-path', '"\\u0455rc/x.ts"');
  assert.deepEqual(judgeAdd({ '\u0455rc/x.ts': 'export {};\n' }), want);
  // Already at base, so no "new top-level module" design hold: the floor alone holds it.
  assert.deepEqual(judgeAdd({ '\u0455rc/x.ts': 'export {};\n' }, { '\u0455rc/old.ts': 'export {};\n' }), want);
  // The Latin twin: as on main (the engine's own src/ waits as engine code; elsewhere src/ is app code).
  assert.deepEqual(brief(judgeAdd({ 'src/x.ts': 'export {};\n' })), [['L3', 'protected', false], ['L1', 'logic', true], ['L0', 'logic', true]]);
  // And review.yaml can loosen neither look-alike category.
  assert.deepEqual(loosenedProblems({ levels: { L3_human: { when: [] } }, merge: { loosened: ['invisible-character-path', 'non-ascii-top-level-path'] } }), [
    'merge.loosened: invisible-character-path is high-risk or a safety floor and can never be loosened',
    'merge.loosened: non-ascii-top-level-path is high-risk or a safety floor and can never be loosened',
  ]);
});

test('a move into a top-level directory whose name isn\'t ASCII is L3 and never merges itself; the same move into a Latin-named one is as before', () => {
  const move = (to: string) => {
    const { dir, base } = repo(START);
    return judgeRange(dir, base, renameWithEdit(dir, 'docs/guide.md', to, (t) => t));
  };
  // U+0501 CYRILLIC SMALL LETTER KOMI DE: \u0501ocs/ shows as docs/.
  assert.deepEqual(move('\u0501ocs/guide.md'), held(['docs/guide.md', '\u0501ocs/guide.md'], 'top-level name that isn\'t ASCII: "\\u0501ocs/guide.md"', 'non-ascii-top-level-path', '"\\u0501ocs/guide.md"'));
  assert.deepEqual(brief(move('docs-old/guide.md')), Array(3).fill(['L0', 'docs-only', false]), 'a new top-level module: the design hold, as on main');
});

test('ordinary odd names get normal review: an accent below the top level, a quote, a backslash, a move between top-level directories that exist', { skip: process.platform === 'win32' && 'a quote or backslash in a file name' }, () => {
  // On main each of these waited by accident: git C-quoted the name (or wrote the move as {docs => web}/x.md), and
  // merge-flow took the quoted first segment for a new top-level module. The owner accepted these as normal.
  const each = (r: ReturnType<typeof judgeRange>) => r.map((x) => ({ reason: x.reason, highRisk: x.highRisk, auto: x.auto }));
  const normal = Array(3).fill({ reason: undefined, highRisk: [], auto: true });
  for (const name of ['docs/na\u00efve.md', 'docs/caf\u00e9.md', 'web/say"hi".ts', 'lib/back\\slash.ts']) assert.deepEqual(each(judgeAdd({ [name]: 'x\n' })), normal, name);
  const { dir, base } = repo(START);
  const head = renameWithEdit(dir, 'docs/guide.md', 'web/guide.md', (t) => t);
  assert.deepEqual(each(judgeRange(dir, base, head)), normal);
  assert.deepEqual(brief(judgeRange(dir, base, head)), Array(3).fill(['L0', 'docs-only', true]));
});

// ---- A changed path in text: every reason, event, question and comment shows it escaped, never raw (round 5)

/** What no reason, event, question or comment may carry raw: a control (Cc), format (Cf) or default-ignorable character. */
const RAW = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/**
 * The round-4 probe's characters: the bidi overrides and isolates, the zero-width ones, U+2060, U+FEFF, U+00AD and the
 * rest of its Cf and default-ignorable list; and control characters: a raw newline, a tab, a CR, U+0001, an escape,
 * DEL and two C1 controls (NEL, CSI), which JSON.stringify leaves raw.
 */
const ODD_CHARS = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x061c, 0x2060, 0x2061, 0x2064, 0xfeff, 0x00ad, 0x034f, 0x115f, 0x1160,
  0x3164, 0xffa0, 0x17b4, 0x180b, 0x180e, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0xe0001, 0xe0041, 0x1d173, 0xfff9, 0x0600,
  0x0a, 0x09, 0x0d, 0x01, 0x1b, 0x7f, 0x85, 0x9b,
].map((c) => String.fromCodePoint(c));
/**
 * Each character in paths that land in different reasons: docs, app code, the engine's own src/ (and the review
 * levels), CI workflows (several categories at once), a dependency manifest (L2), a migration, a role (an
 * instructions target), and a top-level name.
 */
const oddPaths = (c: string) => [`docs/a${c}b.md`, `web/a${c}b.ts`, `src/re${c}view.ts`, `.github/workflows/c${c}i.yml`, `lib/a${c}b/package.json`, `db/migrations/0${c}1.sql`, `${BRAND.configDir}/roles/a${c}b.md`, `${c}src/x.ts`];

/** Which strings from `source` carry a raw character, shown escaped so a failure reads. */
function rawIn(found: Record<string, string[]>, source: string, texts: string[]) {
  const bad = texts.filter((t) => RAW.test(t)).map(esc);
  if (bad.length) (found[source] ??= []).push(...bad.slice(0, 2));
}

test('no reason (computeLevel, mergeDecision, whyHighRisk, riskClassOf) or conflict-fix text carries a raw control, format or invisible character from a changed path', () => {
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  // A review.yaml whose L1 list names docs, so a docs path gets the per-category L1 reason too.
  const docsL1 = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L1_evaluator: { ...LEVELS.L1_evaluator, when: ['app-non-money', 'docs'] } } });
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  const found: Record<string, string[]> = {};
  const levels: string[] = [];
  for (const c of ODD_CHARS) {
    const all = oddPaths(c);
    // Each path on its own, and all of them in one change (so a reason lists several).
    for (const paths of [...all.map((p) => [p]), all]) {
      const files = paths.map((path) => ({ path, added: 1, removed: 0, addedLines: ['x'] }));
      // merge-flow's new-top-level reading: the first segment of a path in a directory.
      const newTopLevel = [...new Set(paths.map((p) => p.split('/')).filter((s) => s.length > 1).map((s) => `${s[0]}/`))];
      for (const cf of [engine, cfg, docsL1]) {
        const lvl = level(files, cf);
        levels.push(lvl.level);
        const waitCategories = waitCategoriesOf(cf);
        rawIn(found, 'computeLevel', lvl.reasons);
        const d = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level: lvl, waitCategories, limits: { max_lines: 800, max_files: 20 }, lines: files.length, files: files.length, verdict: { ...verdict, unread: paths }, newTopLevel, ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
        rawIn(found, 'mergeDecision', [...d.reasons, ...d.why.map((w) => w.text)]);
        rawIn(found, 'whyHighRisk', whyHighRisk({ level: lvl, waitCategories: [] }).map((w) => w.text));
        rawIn(found, 'riskClassOf', riskClassOf({ paths, level: lvl, waitCategories }).why);
        // The conflict fix: what it changed outside the hunks, and why it waits (a level's reasons as it passes them).
        const marked = 'a\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\nb\n';
        const outside = conflicts.outsideHunks(Object.fromEntries(paths.map((p, i) => [p, marked + (i % 2 ? 'z\n' : '')])), Object.fromEntries(paths.map((p, i) => [p, i % 3 === 0 ? null : i % 3 === 1 ? marked : 'a\nq\nb\n'])), paths);
        rawIn(found, 'outsideHunks', outside);
        rawIn(found, 'conflictWaitReasons', conflicts.conflictWaitReasons({ outside, riskCategories: lvl.reasons, evaluator: { approved: true, confidence: 'high', bothSidesKept: true } }));
      }
    }
  }
  assert.deepEqual(found, {});
  // The levels are as before: every one of these paths is L3 (its odd character), alone or together.
  assert.deepEqual([...new Set(levels)], ['L3']);
  // An escaped path still names its file, and an ordinary name is shown as itself.
  const reasons = (p: string) => level([{ path: p, added: 1, removed: 0 }], engine).reasons;
  assert.ok(reasons('src/re\u202eview.ts').includes('engine: "src/re\\u202eview.ts"'), reasons('src/re\u202eview.ts').join(' | '));
  assert.ok(reasons('src/a\nb.ts').includes('engine: "src/a\\nb.ts"'), reasons('src/a\nb.ts').join(' | '));
  assert.ok(reasons('src/review.ts').includes('engine: src/review.ts'), reasons('src/review.ts').join(' | '));
  assert.ok(reasons('src/naïve.ts').includes('engine: src/naïve.ts'), reasons('src/naïve.ts').join(' | '));
});

test('the conflict fix\'s PR comment shows each conflicted file escaped, and its hold reasons with them', () => {
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  const comment = (conflicts as unknown as { conflictFixComment?: (o: { cli: string; baseRef: string; baseSha: string; files: string[]; attempt: number; head: string; summary: string; reasons: string[] }) => string }).conflictFixComment;
  assert.equal(typeof comment, 'function', 'conflicts.conflictFixComment builds the comment');
  const found: Record<string, string[]> = {};
  for (const c of ODD_CHARS) {
    const files = oddPaths(c);
    const lvl = level(files.map((path) => ({ path, added: 1, removed: 0 })), engine);
    const outside = conflicts.outsideHunks({}, {}, files);
    const reasons = conflicts.conflictWaitReasons({ outside, riskCategories: lvl.reasons, evaluator: { approved: true, confidence: 'high', bothSidesKept: true } });
    const text = comment!({ cli: BRAND.cli, baseRef: 'main', baseSha: 'a'.repeat(40), files, attempt: 1, head: 'b'.repeat(40), summary: 'kept both sides', reasons });
    // Its one line break is its own, between the summary and the hold reasons.
    const parts = text.split('\n\nThis one waits for a human: ');
    assert.equal(parts.length, 2, text);
    rawIn(found, 'conflict-fix comment', parts);
  }
  assert.deepEqual(found, {});
  // An ordinary name as itself.
  assert.equal(comment!({ cli: 'x', baseRef: 'main', baseSha: 'a'.repeat(40), files: ['lib/naïve.ts'], attempt: 2, head: 'b'.repeat(40), summary: 's', reasons: [] }), `[x] Conflicted with main (\`aaaaaaaa\`) in lib/naïve.ts. Conflict fix 2 merged it in and pushed \`bbbbbbbb\`: s`);
});

test('inspect\'s "changes protected harness files" shows each odd name escaped', { skip: process.platform !== 'linux' && 'control characters in file names: Linux only' }, async () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, Object.fromEntries(ODD_CHARS.map((c) => [`.claude/agents/a${c}b.md`, 'Be careful.\n'])));
  const head = commit(dir, 'add agents');
  const got = await inspect(dir, base, head).then((r) => r.rejected ?? JSON.stringify(r), (e: Error) => e.message);
  assert.ok(got.startsWith('changes protected harness files: '), got);
  const found: Record<string, string[]> = {};
  rawIn(found, 'inspect', [got]);
  assert.deepEqual(found, {});
  // Every one of them is named (escaped), none dropped.
  assert.equal(got.split(', ').length, ODD_CHARS.length, got);
});

test('the other reasons that name a changed path show it escaped: instruction evals, the review packet\'s eval lines, the cross-family skip, fix-forward\'s revert-first, a check draft, the combined-state plan', () => {
  const found: Record<string, string[]> = {};
  const head = 'a'.repeat(40);
  const evalOf = (target: string, o: Partial<EventPayload<'instructions.eval'>> = {}): EventPayload<'instructions.eval'> => ({ issue: 7, head, target, base: { passed: 3, total: 3 }, result: { passed: 2, total: 3 }, dropped: true, incomplete: false, changes: [], cost_usd: 0.1, ...o });
  for (const c of ODD_CHARS) {
    const p = `src/a${c}b.ts`;
    rawIn(found, 'instructionEvalReasons', instructionEvalReasons([`role a${c}b`, `skill a${c}b`], []));
    // The review packet: its "Evals" line on top and its "Instruction evals" lines in Full details, scored and not
    // evaluated. Its own line breaks are its own; each line is checked.
    const evals = [evalOf(`role a${c}b`, { held_out: null }), evalOf(`skill s${c}k`, { error: 'the CLI failed' })];
    rawIn(found, 'reviewPacket', reviewPacket({ owner: 'example-owner', ask: 'waits for you to review and merge', head, reasons: [], risk: null, evals, receipts: null }).split('\n'));
    rawIn(found, 'crossFamilySkip', [crossFamilySkip({ paths: [`evals/held-out/a${c}b.json`], categories: {} }) ?? '', crossFamilySkip({ paths: [p], categories: { secrets: [p] } }) ?? '']);
    rawIn(found, 'revertFirstReasons', revertFirstReasons({ files: [p], globs: ['src/**'], categories: { migration: [p], secrets: [p], auth: [p], 'money-path': [p] } }));
    const draft = (files: { path: string; status: string }[]) => checkDraft({ kind: 'test' }, files.map((f) => ({ ...f, content: 'x' })));
    rawIn(found, 'checkDraft', [draft([{ path: p, status: 'D' }]), draft([{ path: p, status: 'A' }])].map((r) => (r.ok ? '' : r.why)));
    rawIn(found, 'lightCheckPlan', [lightCheckPlan({ enabled: true, mainChanged: [p], prFiles: [p], imports: {} }).why]);
  }
  assert.deepEqual(found, {});
  // The packet names the target escaped, on top and in Full details; an ordinary one as itself.
  const packet = reviewPacket({ owner: 'example-owner', ask: 'waits', head, reasons: [], risk: null, evals: [evalOf('role a\u202eb'), evalOf('role worker')], receipts: null });
  assert.match(packet, /^\*\*Evals:\*\* `"role a\\u202eb"` 3\/3 → 2\/3 LOWER; `role worker` 3\/3 → 2\/3 LOWER$/m, packet);
  assert.match(packet, /^- `"role a\\u202eb"`: visible 3\/3 → 2\/3, \*\*lower\*\*/m, packet);
});

test('shownPath: two different paths never show as the same text, so a name starting with a quote (a directory named "src) is escaped too', () => {
  // The round-5 collisions: an odd path, and an ordinary ASCII one that is the odd one's escaped text.
  const pairs: [string, string][] = [
    ['src/re\u202eview.ts', '"src/re\\u202eview.ts"'],
    ['src/a\nb.ts', '"src/a\\nb.ts"'],
    ['\u0455rc/x.ts', '"\\u0455rc/x.ts"'],
    ['docs/a\u007fb.md', '"docs/a\\u007fb.md"'],
  ];
  for (const [odd, plain] of pairs) {
    assert.notEqual(shownPath(odd), shownPath(plain), `${esc(odd)} and ${plain} show as ${esc(shownPath(odd))}`);
    assert.equal(JSON.parse(shownPath(plain)), plain);
    assert.equal(JSON.parse(shownPath(odd)), odd);
  }
  // A directory literally named "src: escaped, and reads back as itself. A quote further in is an ordinary name.
  assert.equal(shownPath('"src/x.ts'), '"\\"src/x.ts"');
  assert.equal(JSON.parse(shownPath('"src/x.ts')), '"src/x.ts');
  assert.equal(shownPath('web/say"hi".ts'), 'web/say"hi".ts');
  assert.equal(shownPath('docs/x.md'), 'docs/x.md');
  // Every odd path from the probes, the escaped and the JSON text of each as an ordinary name, names that aren't
  // valid UTF-8, and ordinary names: no two show the same, none shown raw, and each quoted one reads back as itself.
  const odd = ODD_CHARS.flatMap(oddPaths);
  const fffd = ['src/a\ufffdb.ts', '\ufffd/x.ts', '"src/a\ufffdb.ts'];
  const ordinary = ['docs/x.md', '"docs/x.md"', 'src/na\u00efve.ts', 'lib/back\\slash.ts', '"src', '""', '"'];
  const all = [...new Set([...odd, ...fffd, ...ordinary, ...[...odd, ...fffd, ...ordinary].flatMap((p) => [escapedPath(p), JSON.stringify(p)])])];
  const seen = new Map<string, string>();
  for (const p of all) {
    const s = shownPath(p);
    assert.ok(!seen.has(s), `${esc(p)} and ${esc(seen.get(s) ?? '')} both show as ${esc(s)}`);
    seen.set(s, p);
    assert.ok(!RAW.test(s), esc(s));
    if (s !== p) assert.equal(JSON.parse(s), p, esc(p));
  }
});

test('the odd-name tests and how text shows a path (src/path-text.ts) are locked with the review levels', () => {
  assert.equal(selfModificationPart('src/path-text.ts'), 'the review levels');
  // A review.yaml with no L3 category for it: the lock alone makes it L3.
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  assert.equal(level([{ path: 'src/path-text.ts', added: 1, removed: 0 }], plain).level, 'L3');
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
// check-table: never-shrink
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
// check-table: never-grow
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
  'scripts/bench/hidden.ts': {
    words: { 'patch headers': 2 },
    why: 'the bench: finds a task\'s hidden test-patch lines in what an agent sends, skipping a file\'s `+++ ` name line (only right after its `--- ` line, outside a hunk); lists no changed files and reads no path',
    // One pin per allowed line (#797): rewording one of them can't free its count for a new header reader.
    must: [
      /^ \* INVARIANT: a `\+\+\+ ` line is a file name only right after its file's `--- ` line, outside any hunk \(#797\)\.$/m,
      /^ {4}const plusName = l\.trimEnd\(\)\.startsWith\('\+\+\+ '\);$/m,
    ],
  },
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

// ---- A .gitattributes mark can't hide a change's lines or content (#693)
// A file marked `-diff` or `binary` shows as `-` in --numstat and "Binary files differ" in a patch: the old reader
// counted it as no lines and saw no content, so a file holding DROP TABLE and 900 added lines came out L1.

/** `n` lines of a job file; line 3 is `special` when given. */
const jobLines = (n: number, special?: string) => `${Array.from({ length: n }, (_, i) => (i === 2 && special !== undefined ? special : `step ${i};`)).join('\n')}\n`;
const engineReview = () => ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
const counts = (files: ChangeFile[]) => files.map((f) => [f.path, f.added, f.removed]);
/** The reason a diff-hiding-attributes change is L3 for, before the paths. */
const HIDING_REASON = '.gitattributes or .gitmodules can hide what a review sees (-diff, binary, linguist-generated, a filter, an encoding, a diff driver, a macro, a submodule ignore)';

for (const mark of ['-diff', 'binary']) {
  test(`a file marked ${mark} in .gitattributes that holds DROP TABLE comes out L3 deletes-data, under the engine's review.yaml too`, () => {
    // The mark is already on main, so the reader alone decides (a change that adds the mark is flagged, below).
    const { dir, base } = repo({ '.gitattributes': `*.job ${mark}\n`, 'README.md': '# x\n' });
    write(dir, { 'src/jobs/purge.job': jobLines(20, 'DROP TABLE users;') });
    const head = commit(dir, 'add a job');
    // What git prints for it: no counts, and no lines in the patch.
    assert.equal(git(dir, 'diff', '--numstat', `${base}..${head}`), '-\t-\tsrc/jobs/purge.job');
    assert.match(git(dir, 'diff', `${base}..${head}`), /Binary files \/dev\/null and b\/src\/jobs\/purge\.job differ/);
    const files = changeFiles(dir, base, head);
    assert.deepEqual(counts(files), [['src/jobs/purge.job', 20, 0]]);
    assert.ok(files[0]!.addedLines?.includes('DROP TABLE users;'), JSON.stringify(files));
    const lvl = level(files);
    assert.equal(lvl.level, 'L3', lvl.reasons.join('; '));
    assert.deepEqual(lvl.categories['deletes-data'], ['src/jobs/purge.job']);
    assert.ok(lvl.reasons.includes('deletes-data: src/jobs/purge.job'), lvl.reasons.join('; '));
    const engine = engineReview();
    const atEngine = level(files, engine);
    assert.equal(atEngine.level, 'L3');
    assert.deepEqual(atEngine.categories['deletes-data'], ['src/jobs/purge.job']);
    assert.ok(whyHighRisk({ level: atEngine, waitCategories: engine.levels.L3_human.when }).some((w) => w.text === 'deletes data: src/jobs/purge.job'));
  });
}

test('a replace ref (refs/replace/*, which every worktree of a repo shares) can\'t swap the blob the levels and the size limit read', () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { 'src/jobs/purge.job': jobLines(20, 'DROP TABLE users;') });
  const head = commit(dir, 'add a job');
  const decoy = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: jobLines(20), encoding: 'utf8' }).trim();
  git(dir, 'replace', git(dir, 'rev-parse', `${head}:src/jobs/purge.job`), decoy);
  // git itself now reads the decoy.
  assert.doesNotMatch(git(dir, 'diff', `${base}..${head}`), /DROP TABLE/);
  const files = changeFiles(dir, base, head);
  assert.ok(files[0]!.addedLines?.includes('DROP TABLE users;'), JSON.stringify(files));
  assert.deepEqual(level(files).categories['deletes-data'], ['src/jobs/purge.job']);
  assert.ok(sizeFiles(dir, base, head)[0]!.added.includes('DROP TABLE users;'));
});

test('a file marked -diff or binary counts its lines toward the size limits: the level\'s over_lines, max_pr_lines and the push limit', () => {
  for (const mark of ['-diff', 'binary']) {
    // linguist-generated too: GitHub's mark is not the size limit's generated exemption (review.yaml's globs are).
    const { dir, base } = repo({ '.gitattributes': `*.job ${mark} linguist-generated\n`, 'README.md': '# x\n', 'src/jobs/old.job': jobLines(50) });
    write(dir, { 'src/jobs/big.job': jobLines(900), 'src/jobs/old.job': jobLines(50).replace('step 7;', 'step seven;') });
    const head = commit(dir, 'add a big job');
    assert.equal(git(dir, 'diff', '--numstat', `${base}..${head}`), '-\t-\tsrc/jobs/big.job\n-\t-\tsrc/jobs/old.job');
    const files = changeFiles(dir, base, head);
    assert.deepEqual(counts(files), [['src/jobs/big.job', 900, 0], ['src/jobs/old.job', 1, 1]], mark);
    const lvl = level(files);
    assert.equal(lvl.level, 'L3', mark);
    assert.ok(lvl.reasons.includes('902 lines (> 800)'), lvl.reasons.join('; '));
    const size = sizeVerdict(sizeFiles(dir, base, head), { maxLines: 600, generated: DEFAULT_GENERATED });
    assert.deepEqual([size.ok, size.lines], [false, 902], size.why);
    const push = pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 600 });
    assert.deepEqual(push.filter((p) => p.startsWith('changes ')), ['changes 902 lines, over the 600-line limit (push.max_changed_lines); split it into smaller changes'], mark);
  }
});

test('a file git calls binary for a NUL byte counts its lines, not 0', () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { 'src/data/table.bin': `\0${'row\n'.repeat(700)}` });
  const head = commit(dir, 'add a table');
  assert.equal(git(dir, 'diff', '--numstat', `${base}..${head}`), '-\t-\tsrc/data/table.bin');
  assert.deepEqual(counts(changeFiles(dir, base, head)), [['src/data/table.bin', 700, 0]]);
  assert.equal(sizeVerdict(sizeFiles(dir, base, head), { maxLines: 600, generated: DEFAULT_GENERATED }).lines, 700);
  assert.equal(pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 600 }).filter((p) => p.startsWith('changes 700 lines')).length, 1);
});

test('a -diff file whose name isn\'t valid UTF-8 counts its lines from its blobs', () => {
  const { dir, base } = repo({ '.gitattributes': '*.job -diff\n', 'README.md': '# x\n' });
  stageBytes(dir, ff('src/jobs/bad', '.job'), jobLines(30));
  git(dir, 'commit', '-q', '-m', 'add');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.deepEqual(counts(changeFiles(dir, base, head)), [['src/jobs/bad�.job', 30, 0]]);
  stageBytes(dir, ff('src/jobs/bad', '.job'), jobLines(12));
  git(dir, 'commit', '-q', '-m', 'shorten');
  // Every line of the old blob removed, every line of the new one added: never fewer than changed.
  assert.deepEqual(counts(changeFiles(dir, head, git(dir, 'rev-parse', 'HEAD'))), [['src/jobs/bad�.job', 12, 30]]);
});

test('the push limit still counts a file whose name git quotes (a tab), and a pure rename still counts 0', { skip: process.platform === 'win32' && 'a tab in a file name' }, () => {
  const { dir, base } = repo({ 'README.md': '# x\n', 'src/long.ts': testFile(40) });
  write(dir, { 'a\tb.ts': jobLines(5) });
  renameSync(join(dir, 'src/long.ts'), join(dir, 'src/longer.ts'));
  const head = commit(dir, 'add and move');
  assert.deepEqual(pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 5 }), []);
  assert.deepEqual(pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 4 }), ['changes 5 lines, over the 4-line limit (push.max_changed_lines); split it into smaller changes']);
});

// ---- The push limits read each changed name as itself (#724). Without -z, `git log --name-only` C-quoted a name with a
// non-ASCII byte, a newline, a quote or a backslash (`"secrets/na\303\257ve.pem"`), and the quoted string matched no
// refuse_paths glob: such a file was pushed (0 problems, measured by #688's reviewers).

test('push limits: a refused path whose name has a non-ASCII byte is refused; so are a workflow and a failing skill named so', () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { 'secrets/naïve.pem': 'k\n', '.github/workflows/ci-é.yml': 'on: push\n', '.claude/skills/naïve/SKILL.md': '## When to use\nx\n' });
  const head = commit(dir, 'add');
  const p = pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['secrets/**'] });
  assert.equal(p.length, 3, p.join('\n'));
  assert.match(p.join('\n'), /changes CI workflows \(\.github\/workflows\/ci-é\.yml\)/);
  assert.match(p.join('\n'), /touches paths that are never pushed \(secrets\/naïve\.pem\)/);
  assert.match(p.join('\n'), /skills that fail the skill lint: \.claude\/skills\/naïve\/SKILL\.md/);
});

test('push limits: a refused path with a newline in its name is refused, and shown escaped', { skip: process.platform === 'win32' && 'a newline in a file name' }, () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { 'data/a\nb.bin': 'x\n' });
  const head = commit(dir, 'add');
  const p = pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['data/**'] });
  assert.equal(p.length, 1, p.join('\n'));
  assert.ok(p[0]!.includes('(' + JSON.stringify('data/a\nb.bin') + ')'), p[0]);
  assert.ok(!p[0]!.includes('a\nb'), 'no raw newline in the text');
});

test('push limits: a name that reads like git\'s quoted form (logs/"\\303\\251".txt) is matched as its own bytes', { skip: process.platform === 'win32' && 'a quote or backslash in a file name' }, () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  const name = 'logs/"\\303\\251".txt';
  write(dir, { [name]: 'x\n' });
  const head = commit(dir, 'add');
  // git itself prints it quoted, with every quote and backslash escaped.
  assert.equal(git(dir, 'log', '--format=', '--name-only', `${base}..${head}`), '"logs/\\"\\\\303\\\\251\\".txt"');
  const p = pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['logs/**'] });
  assert.equal(p.length, 1, p.join('\n'));
  assert.ok(p[0]!.includes(`(${name})`), p[0]);
  // Its quoted form names no file: a glob written for the quoted text matches nothing.
  assert.deepEqual(pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['"logs/**'] }), []);
});

test('a change that marks a path -diff, binary or linguist-generated in a .gitattributes is L3 and never merges itself, whatever review.yaml lists', () => {
  // A review.yaml with no L3 category a .gitattributes falls in: only the mark can make it L3.
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const verdict = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  /** A change that writes `after` to `at` (which holds `before` on main), as the levels and the merge gate judge it. */
  const judge = (after: string, before?: string, at = '.gitattributes') => {
    const { dir, base } = repo({ 'README.md': '# x\n', ...(before === undefined ? {} : { [at]: before }) });
    write(dir, { [at]: after });
    const lvl = level(changeFiles(dir, base, commit(dir, 'attributes')), plain);
    const merge = mergeDecision({ branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null, level: lvl, waitCategories: [], limits: { max_lines: 800, max_files: 20 }, lines: 1, files: 1, verdict, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false });
    return { level: lvl.level, hiding: lvl.categories['diff-hiding-attributes'] ?? [], reason: lvl.reasons.find((r) => r.startsWith('.gitattributes or .gitmodules')) ?? null, cls: riskClassOf({ paths: [at], level: lvl, waitCategories: [] }).cls, auto: merge.auto };
  };
  const flagged = (at: string) => ({ level: 'L3', hiding: [at], reason: `${HIDING_REASON}: ${at}`, cls: 'protected', auto: false });
  const hiding = [
    '*.sql -diff', '*.sql binary', '*.sql -binary', 'gen/** linguist-generated', 'gen/** linguist-generated=true', '*.sql text -diff', '*.sql\t-diff', '"db dumps/*.sql" -diff', '  *.sql -diff  ',
    // A macro definition (even one of harmless names: what uses it is judged as the name it looks like), a name a
    // macro may stand for (its definition may be on main already), and a name git doesn't know.
    '[attr]quiet -diff', '[attr]plain text eol=lf', '*.sql quiet', '*.sql made-up',
    // A quoted macro definition (git C-unquotes the pattern first, then skips blanks after `[attr]`), even of harmless
    // names, and quoting git can't read (no closing quote, an unknown escape): fails closed (R7, round 3).
    '"[attr]eol" -diff', '"[attr] eol" -diff', '"[attr]eol" text', '"[attr] eol" text', '"\\[attr]eol" -diff', '"*.sql -diff', '"[attr]\\x" text',
    // A filter (git-lfs: a review reads a pointer, a checkout gets the content), a diff driver git doesn't ship.
    '*.sql filter=lfs diff=lfs merge=lfs -text', '*.sql filter=strip', '*.sql diff=sql',
    // An encoding the checkout converts from: the blob a review reads is the file re-encoded (R1, round 2).
    '*.job working-tree-encoding=IBM037', '*.job working-tree-encoding=UTF-16LE',
    // `!diff` can take away an earlier forced `diff`, and a file with a NUL byte goes back to binary (R16, round 5;
    // listed as harmless through d62685c3).
    '*.sql !diff',
  ];
  for (const line of hiding) assert.deepEqual(judge(`${line}\n`), flagged('.gitattributes'), JSON.stringify(line));
  // In any directory, in any case (a case-insensitive file system opens .GitAttributes as the real one), and added to a
  // .gitattributes main already has.
  assert.deepEqual(judge('*.sql -diff\n', undefined, 'db/.gitattributes'), flagged('db/.gitattributes'));
  for (const at of ['.GitAttributes', 'db/.GITATTRIBUTES', '.gitAttributes']) assert.deepEqual(judge('*.sql -diff\n', undefined, at), flagged(at), at);
  assert.deepEqual(judge('* text=auto eol=lf\n*.sql -diff\n', '* text=auto eol=lf\n'), flagged('.gitattributes'));
  // Taking away a line that turned a filter off, or forced text, turns it back on.
  assert.deepEqual(judge('* filter=lfs\n', '* filter=lfs\n*.sql -filter\n'), flagged('.gitattributes'));
  assert.deepEqual(judge('*.sql binary\n', '*.sql binary\n*.sql diff\n'), flagged('.gitattributes'));
  // Taking away a macro definition: the lines that use it now mean something else. Quoted, with a blank, or quoting git
  // can't read, the same (R7, round 3).
  assert.deepEqual(judge('*.sql keep\n', '[attr]keep -filter\n*.sql keep\n'), flagged('.gitattributes'));
  for (const def of ['"[attr]keep" -filter', '"[attr] keep" text', '"\\[attr]keep" text', '"*.sql text']) assert.deepEqual(judge('*.sql keep\n', `${def}\n*.sql keep\n`), flagged('.gitattributes'), def);
  // Lines that hide nothing get the review they had: a comment, a path named "binary", line endings, a diff driver git
  // ships, forcing text, GitHub's language marks, turning a fold or a filter off, the engine's own .gitattributes, and
  // taking a mark away.
  const plainReview = { level: 'L1', hiding: [], reason: null };
  const harmless = [
    '# *.sql -diff', 'binary/** text', '* text=auto eol=lf', '/dist/** -text', '*.py diff=python', '*.sql diff', 'vendor/** linguist-vendored',
    'gen/** -linguist-generated', 'gen/** linguist-generated=false', '*.sql -filter', readFileSync(join(repoRoot, '.gitattributes'), 'utf8'),
  ];
  for (const text of harmless) assert.deepEqual((({ level, hiding, reason }) => ({ level, hiding, reason }))(judge(`${text}\n`)), plainReview, JSON.stringify(text));
  assert.deepEqual((({ level, hiding, reason }) => ({ level, hiding, reason }))(judge('* text=auto\n', '* text=auto\n*.sql -diff\n')), plainReview);
  // And review.yaml can't loosen it.
  assert.deepEqual(loosenedProblems({ levels: { L3_human: { when: [] } }, merge: { loosened: ['diff-hiding-attributes'] } }), ['merge.loosened: diff-hiding-attributes is high-risk or a safety floor and can never be loosened']);
});

test('a working-tree-encoding mark (IBM037) on a file holding DROP TABLE: the blob is noise, a checkout runs the SQL, so the change is L3 diff-hiding-attributes', () => {
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { '.gitattributes': '*.job working-tree-encoding=IBM037\n', 'src/jobs/purge.job': jobLines(30, 'DROP TABLE users;') });
  const head = commit(dir, 'add a job');
  // What git stored: the ASCII file read as EBCDIC, so no DROP TABLE in any line a review reads.
  const files = changeFiles(dir, base, head);
  assert.ok(!files.some((f) => f.addedLines?.some((l) => /DROP TABLE/.test(l))), JSON.stringify(counts(files)));
  // What a checkout gets back: the SQL.
  const clone = mkdtempSync(join(tmpdir(), 'wte-clone-'));
  git(clone, 'clone', '-q', dir, 'c');
  assert.equal(readFileSync(join(clone, 'c', 'src/jobs/purge.job'), 'latin1').split('\n')[2], 'DROP TABLE users;');
  const lvl = level(files, ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } }));
  assert.equal(lvl.level, 'L3', lvl.reasons.join('; '));
  assert.deepEqual(lvl.categories['diff-hiding-attributes'], ['.gitattributes']);
  assert.ok(lvl.reasons.includes(`${HIDING_REASON}: .gitattributes`), lvl.reasons.join('; '));
});

test('a name a macro on main stands for (`[attr]eol -diff`, then `*.job eol`) is judged as the macro, in the same .gitattributes or another', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  // git itself hides the file through the shadowing macro.
  const same = repo({ 'README.md': '# x\n', '.gitattributes': '[attr]eol -diff\n' });
  write(same.dir, { '.gitattributes': '[attr]eol -diff\n*.job eol\n', 'src/jobs/purge.job': jobLines(30, 'DROP TABLE users;') });
  const sameHead = commit(same.dir, 'use the macro');
  assert.match(git(same.dir, 'diff', '--numstat', `${same.base}..${sameHead}`), /^-\t-\tsrc\/jobs\/purge\.job$/m);
  const sameFiles = changeFiles(same.dir, same.base, sameHead);
  assert.deepEqual(sameFiles.find((f) => f.path === '.gitattributes')?.attributeMacros, ['eol']);
  assert.deepEqual(level(sameFiles, plain).categories['diff-hiding-attributes'], ['.gitattributes']);
  // The macro in the top-level file on main, its use in a nested one the change adds.
  const other = repo({ 'README.md': '# x\n', '.gitattributes': '[attr]eol -diff\n' });
  write(other.dir, { 'db/.gitattributes': '*.job eol\n' });
  assert.deepEqual(level(changeFiles(other.dir, other.base, commit(other.dir, 'nested')), plain).categories['diff-hiding-attributes'], ['db/.gitattributes']);
  // A quoted definition on main (`"[attr]eol" -diff`, `"[attr] eol" -diff`) is a macro to git too, and one git can't
  // unquote may be: the use is flagged, in the same file or a nested one (R7, round 3).
  for (const def of ['"[attr]eol" -diff', '"[attr] eol" -diff', '"\\[attr]eol" -diff']) {
    const q = repo({ 'README.md': '# x\n', '.gitattributes': `${def}\n` });
    write(q.dir, { 'db/.gitattributes': '*.job eol\n', 'db/purge.job': jobLines(30, 'DROP TABLE users;') });
    const qHead = commit(q.dir, 'use it');
    if (!def.includes('\\')) assert.match(git(q.dir, 'diff', '--numstat', `${q.base}..${qHead}`), /^-\t-\tdb\/purge\.job$/m, `git hides it: ${def}`);
    assert.deepEqual(level(changeFiles(q.dir, q.base, qHead), plain).categories['diff-hiding-attributes'], ['db/.gitattributes'], def);
  }
  // With no macro of that name anywhere, `eol` is git's own: the review it had.
  const none = repo({ 'README.md': '# x\n' });
  write(none.dir, { '.gitattributes': '*.job eol=lf\n' });
  const noneFiles = changeFiles(none.dir, none.base, commit(none.dir, 'eol'));
  assert.deepEqual([noneFiles[0]!.attributeMacros, level(noneFiles, plain).level, level(noneFiles, plain).categories['diff-hiding-attributes']], [[], 'L1', undefined]);
});

test('a .gitmodules line that hides a submodule\'s changes (ignore = anything but none) is L3 diff-hiding-attributes; ignore = none is not', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const judge = (text: string, at = '.gitmodules') => {
    const { dir, base } = repo({ 'README.md': '# x\n' });
    write(dir, { [at]: text });
    const lvl = level(changeFiles(dir, base, commit(dir, 'modules')), plain);
    return [lvl.level, lvl.categories['diff-hiding-attributes'] ?? []];
  };
  const section = (line: string) => `[submodule "m"]\n\tpath = vendor/m\n\turl = ./m\n${line}\n`;
  for (const line of ['\tignore = all', '\tignore = dirty', '\tignore=untracked', '\tIgnore = ALL', '\tignore = "all"', '\tignore = all ; why', '\tignore', '\tignore = \\']) assert.deepEqual(judge(section(line)), ['L3', ['.gitmodules']], JSON.stringify(line));
  assert.deepEqual(judge('[submodule "m"] ignore = all\n'), ['L3', ['.gitmodules']], 'after a header on the same line');
  assert.deepEqual(judge(section('\tignore = all'), 'lib/.GitModules'), ['L3', ['lib/.GitModules']]);
  for (const line of ['\tignore = none', '\tignore = "none" # always', '\t# ignore = all', '\tbranch = main']) assert.deepEqual(judge(section(line)), ['L1', []], JSON.stringify(line));
  // Read by git's own config parser, so the header forms it accepts count (R8, round 3): a subsection holding `]`, two
  // headers on one line.
  for (const text of ['[submodule "x]y"] ignore = all\n', '[core] [submodule "m"] ignore = all\n']) {
    assert.match(git(writeRepo(text), 'config', '-f', '.gitmodules', '--list'), /\.ignore=all$/m, `git reads it: ${text}`);
    assert.deepEqual(judge(text), ['L3', ['.gitmodules']], text);
  }
  // A file git can't parse is flagged (fails closed).
  for (const text of ['[submodule "m"\n\tignore = none\n', '[submodule "m"]\n\t= all\n']) assert.deepEqual(judge(text), ['L3', ['.gitmodules']], text);
});

/** A scratch repo holding `.gitmodules` with `text` (uncommitted): for asking git how it reads it. */
function writeRepo(text: string): string {
  const { dir } = repo({ 'README.md': '# x\n' });
  write(dir, { '.gitmodules': text });
  return dir;
}

test('an ignore = all already on main, moved onto a new link by editing its path, is flagged (R9, round 3)', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const before = (path: string) => `[submodule "docs"]\n\tpath = ${path}\n\turl = ./x\n\tignore = all\n`;
  const { dir, base } = repo({ 'README.md': '# x\n', '.gitmodules': before('docs/ext') });
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${submoduleCommit(3)},lib/ext`);
  write(dir, { '.gitmodules': before('lib/ext') });
  // Not `add -A`: the link has no directory in the worktree, and `add -A` would take it out of the index.
  git(dir, 'add', '.gitmodules');
  git(dir, 'commit', '-q', '-m', 'move the ignored submodule onto a new link');
  const head = git(dir, 'rev-parse', 'HEAD');
  // git itself leaves the new link out.
  assert.equal(git(dir, 'diff', '--name-only', `${base}..${head}`), '.gitmodules');
  const files = changeFiles(dir, base, head);
  assert.deepEqual(files.map((f) => f.path).sort(), ['.gitmodules', 'lib/ext']);
  assert.deepEqual(files.find((f) => f.path === '.gitmodules')?.submoduleIgnores, ['all', 'all']);
  const lvl = level(files, plain);
  assert.deepEqual([lvl.level, lvl.categories['diff-hiding-attributes']], ['L3', ['.gitmodules']]);
});

test('a .gitattributes or .gitmodules under another spelling a file system opens as one (trailing dot or space, an NTFS stream, an 8.3 short name) is judged as one', { skip: process.platform === 'win32' && 'names Windows refuses' }, () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  for (const [at, text] of [
    ['.gitattributes.', '*.sql -diff\n'], ['.gitattributes ', '*.sql -diff\n'], ['.gitattributes::$DATA', '*.sql -diff\n'], ['GITATT~1', '*.sql -diff\n'], ['db/gi7d29~2', '*.sql -diff\n'],
    ['.gitmodules.', '[submodule "m"]\n\tignore = all\n'], ['GITMOD~1', '[submodule "m"]\n\tignore = all\n'], ['gi7eba~3', '[submodule "m"]\n\tignore = all\n'],
    // NTFS's shorter fall-back names: fewer hash characters, more digits (R14, round 4). `g~100000` is both.
    ['gi7eb~10', '[submodule "m"]\n\tignore = all\n'], ['gi7e~123', '[submodule "m"]\n\tignore = all\n'], ['g~123456', '[submodule "m"]\n\tignore = all\n'],
    ['gi7d2~10', '*.sql -diff\n'], ['g~100000', '*.sql -diff\n'],
  ] as const) {
    const { dir, base } = repo({ 'README.md': '# x\n' });
    write(dir, { [at]: text });
    const lvl = level(changeFiles(dir, base, commit(dir, 'spelling')), plain);
    // A name that is both files is flagged once for each.
    assert.deepEqual([lvl.level, [...new Set(lvl.categories['diff-hiding-attributes'])]], ['L3', [at]], at);
  }
  // Names that aren't one: their review as before.
  for (const at of ['gitattributes', '.gitattributes-old', 'GITATT~5', 'docs/.gitattributes.md', 'gi7eba~12', 'gi7eb~1', 'x~123456']) {
    const { dir, base } = repo({ 'README.md': '# x\n' });
    write(dir, { [at]: '*.sql -diff\n' });
    assert.equal(level(changeFiles(dir, base, commit(dir, 'name')), plain).categories['diff-hiding-attributes'], undefined, at);
  }
});

test('a .gitattributes or .gitmodules that didn\'t come through changeFiles (no macro list, no parsed ignores) is flagged: fails closed', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  assert.equal(level([{ path: '.gitattributes', added: 1, removed: 0, addedLines: ['*.sql text'], removedLines: [] }], plain).level, 'L3');
  // A macro list but no outcome: git didn't judge it, so it counts as git not judging (R18, round 5; L1 through d62685c3).
  assert.equal(level([{ path: '.gitattributes', added: 1, removed: 0, addedLines: ['*.sql text'], removedLines: [], attributeMacros: [] }], plain).level, 'L3');
  for (const line of ['# a comment', '*.sql\vlinguist-generated']) assert.equal(level([{ path: '.gitattributes', added: 1, removed: 0, addedLines: [line], removedLines: [] }], plain).level, 'L3', line);
  assert.equal(level([{ path: '.gitmodules', added: 1, removed: 0, addedLines: ['\tbranch = main'], removedLines: [] }], plain).level, 'L3');
  assert.equal(level([{ path: '.gitmodules', added: 1, removed: 0, addedLines: ['\tbranch = main'], removedLines: [], submoduleIgnores: [] }], plain).level, 'L1');
  assert.equal(level([{ path: '.gitmodules', added: 1, removed: 0, addedLines: ['\tbranch = main'], removedLines: [], submoduleIgnores: null }], plain).level, 'L3');
  // The outcome git judged: a path it now hides, or no judgement at all (null), flags even harmless-looking lines.
  const lines = { path: '.gitattributes', added: 1, removed: 0, addedLines: ['*.sql text'], removedLines: [], attributeMacros: [] };
  assert.equal(level([{ ...lines, attributeOutcome: ['a.sql: diff unspecified -> unset'] } as ChangeFile], plain).level, 'L3');
  assert.equal(level([{ ...lines, attributeOutcome: null } as ChangeFile], plain).level, 'L3');
  assert.equal(level([{ ...lines, attributeOutcome: [] } as ChangeFile], plain).level, 'L1');
});

test('the name check agrees with git\'s own (git fsck --strict on a symlink of each name)', { skip: process.platform === 'win32' && 'names Windows refuses' }, (t) => {
  const names = [
    '.gitmodules', '.GITMODULES', '.gitmodules.', '.gitmodules ', '.gitmodules::$DATA', 'GITMOD~1', 'gitmod~4', 'gi7eba~1', 'gi7eba~9', 'gi7eb~10', 'gi7e~123', 'g~123456', '~1234567',
    '.gitattributes', '.GitAttributes', 'GITATT~2', 'gi7d29~3', 'gi7d2~10', 'g~100000',
    'gitmod~5', 'gi7eba~12', 'gi7eb~1', 'x~123456', '.gitmodulesx', 'gi7eba~0', '.gitattributes-old', 'gié7eba~1',
  ];
  const disagree: string[] = [];
  for (const name of names) {
    const { dir } = repo({ 'README.md': '# x\n' });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'target', encoding: 'utf8' }).trim();
    // mktree, not update-index: the index refuses a symlink under some of these names, and fsck should judge them all.
    const tree = execFileSync('git', ['mktree', '-z'], { cwd: dir, input: `120000 blob ${blob}\t${name}\0`, encoding: 'utf8' }).trim();
    git(dir, 'update-ref', 'refs/heads/main', execFileSync('git', ['commit-tree', '-m', 'link', tree], { cwd: dir, encoding: 'utf8' }).trim());
    const fsck = spawnSync('git', ['fsck', '--strict'], { cwd: dir, encoding: 'utf8' });
    const out = `${fsck.stdout}${fsck.stderr}`;
    const git_ = { modules: /gitmodulesSymlink/.test(out), attributes: /gitattributesSymlink/.test(out) };
    const ours = { modules: isGitmodulesPath(name), attributes: isGitattributesPath(name) };
    if (git_.modules !== ours.modules || git_.attributes !== ours.attributes) disagree.push(`${JSON.stringify(name)}: git ${JSON.stringify(git_)}, ours ${JSON.stringify(ours)}`);
  }
  t.diagnostic(execFileSync('git', ['--version'], { encoding: 'utf8' }).trim());
  assert.deepEqual(disagree, []);
});

// ---- The outcome check: git itself judges what a .gitattributes change does (round 4)

test('the outcome check: git, reading the base and head trees, flags a path a .gitattributes change hides, whatever the line looks like (R12, R13)', (t) => {
  t.diagnostic(`outcome check on ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}`);
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  /** A change that writes `files`; what git hides, what the outcome check lists, and the flag. */
  const judge = (before: Record<string, string>, after: Record<string, string>, hidden: string) => {
    const { dir, base } = repo({ 'README.md': '# x\n', ...before });
    write(dir, after);
    const head = commit(dir, 'change');
    const files = changeFiles(dir, base, head);
    // -z: names as they are (a plain --numstat C-quotes an NBSP).
    const gitHides = execFileSync('git', ['diff', '--numstat', '-z', `${base}..${head}`], { cwd: dir, encoding: 'utf8' }).split('\0').includes(`-\t-\t${hidden}`);
    const ga = files.find((f) => isGitattributesPath(f.path));
    return { gitHides, outcome: ga?.attributeOutcome, flagged: level(files, plain).categories['diff-hiding-attributes'] ?? [] };
  };
  // R12: leading whitespace that is JavaScript's but not git's is part of the pattern, so these hide a file.
  for (const [what, line, file] of [
    ['a leading NBSP before #', ' #* -diff', 'db/ #purge.ts'],
    ['a leading U+3000 before #', '　#* -diff', 'db/　#purge.ts'],
    ['a leading NBSP before a quote', ' "x -diff a=" text', 'db/ "x'],
    ['a leading BOM on line 2', '*.md text\n﻿#* -diff', 'db/﻿#purge.ts'],
    ['a leading vertical tab', '\v#* -diff', 'db/\v#purge.ts'],
  ] as const) {
    const r = judge({}, { 'db/.gitattributes': `${line}\n`, [file]: jobLines(30, 'DROP TABLE users;') }, file);
    assert.equal(r.gitHides, true, `git hides it: ${what}`);
    assert.ok(r.outcome?.includes(`${file}: diff unspecified -> unset`), `${what}: ${JSON.stringify(r.outcome)}`);
    assert.ok(r.flagged.includes('db/.gitattributes'), what);
    // The line layer agrees on its own (lines added, and the same line taken away).
    assert.equal(line.split('\n').some((l) => hidesDiff(l, [])), true, `line layer: ${what}`);
  }
  // R12 on the removal side: taking away `<NBSP>#* diff` (a pattern to git) can let an earlier -diff hide a file.
  assert.equal(unhidLine(' #* diff', []), true);
  assert.equal(unhidLine('﻿#* -filter', []), true);
  assert.equal(unhidLine('#* diff', []), false, 'a real comment is still a comment');
  // R13: taking away a line that uses a macro (`*.ts showme`, showme = `diff`) lets the -diff before it hide the file.
  const r13 = judge({ '.gitattributes': '[attr]showme diff\n*.ts -diff\n*.ts showme\n', 'src/a.ts': jobLines(30) }, { '.gitattributes': '[attr]showme diff\n*.ts -diff\n', 'src/a.ts': jobLines(30).replace('step 0;', 'DROP TABLE users;') }, 'src/a.ts');
  assert.equal(r13.gitHides, true);
  assert.deepEqual(r13.outcome, ['src/a.ts: diff set -> unset']);
  assert.deepEqual(r13.flagged, ['.gitattributes']);
  assert.equal(unhidLine('*.ts showme', ['showme']), true, 'line layer: a removed macro use');
  assert.equal(unhidLine('*.ts showme', ['*']), true, 'a macro list that couldn\'t be read: fails closed');
  assert.equal(unhidLine('*.ts showme', []), false, 'a name no tree defines as a macro does nothing to a diff');
  // A macro defined only in the root .gitattributes and used in a nested one.
  const nested = judge({ '.gitattributes': '[attr]quiet -diff\n' }, { 'db/.gitattributes': '*.job quiet\n', 'db/p.job': jobLines(5) }, 'db/p.job');
  assert.equal(nested.gitHides, true);
  assert.deepEqual(nested.outcome, ['db/p.job: diff unspecified -> unset']);
  // A change that hides nothing: no outcome, and its lines are harmless: the review it had.
  const none = judge({ 'a.ts': 'x\n' }, { '.gitattributes': '* text=auto eol=lf\n*.py diff=python\n' }, 'zz');
  assert.deepEqual([none.outcome, none.flagged], [[], []]);
});

test('the outcome check: a rename while its attributes change, and a path on one side only', () => {
  const { dir, base } = repo({ 'README.md': '# x\n', 'src/a.sql': jobLines(5), 'src/gone.sql': jobLines(5) });
  renameSync(join(dir, 'src/a.sql'), join(dir, 'src/b.sql'));
  write(dir, { '.gitattributes': 'src/b.sql -diff\nsrc/gone.sql -diff\nsrc/new.sql binary\n', 'src/new.sql': jobLines(3) });
  git(dir, 'rm', '-q', 'src/gone.sql');
  const head = commit(dir, 'rename, delete, add');
  // Each path of either tree is asked of both: the renamed file's new name, the deleted one, the added one.
  assert.deepEqual(changeFilesModule.attributeOutcome(dir, base, head)?.slice().sort(), [
    'src/b.sql: diff unspecified -> unset',
    'src/gone.sql: diff unspecified -> unset',
    'src/new.sql: binary unspecified -> set',
    'src/new.sql: diff unspecified -> unset',
    'src/new.sql: text unspecified -> unset',
  ]);
});

test('the outcome check judges change, not just end state: leaving a forced `diff` (for a driver git ships, or `!diff`) on a file with a NUL byte is flagged (R16, round 5)', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const nul = `\0${jobLines(30)}`;
  for (const [line, state] of [['*.dat diff=python', 'python'], ['*.dat !diff', 'unspecified'], ['cfg/*.dat diff=golang', 'golang']] as const) {
    const { dir, base } = repo({ 'README.md': '# x\n', '.gitattributes': '*.dat diff\n', 'cfg/x.dat': nul });
    write(dir, { '.gitattributes': `*.dat diff\n${line}\n`, 'cfg/x.dat': `${nul}DROP TABLE users;\n` });
    const head = commit(dir, 'override');
    // git: text under main's forced diff, binary after the override.
    assert.equal(execFileSync('git', ['diff', '--numstat', '-z', `${base}..${head}`], { cwd: dir, encoding: 'utf8' }).split('\0').includes('-\t-\tcfg/x.dat'), true, `git hides it: ${line}`);
    assert.equal(git(dir, '-c', 'core.attributesFile=/dev/null', `--attr-source=${base}`, 'diff', '--numstat', `${base}..${head}`).split('\n').find((l) => l.endsWith('cfg/x.dat')), '1\t0\tcfg/x.dat', `text under main's attributes: ${line}`);
    const files = changeFiles(dir, base, head);
    assert.deepEqual(files.find((f) => f.path === '.gitattributes')?.attributeOutcome, [`cfg/x.dat: diff set -> ${state}`], line);
    assert.deepEqual(level(files, plain).categories['diff-hiding-attributes'], ['.gitattributes'], line);
  }
  // The line layer flags an added `!diff` on its own.
  assert.equal(hidesDiff('*.dat !diff', []), true);
  // The control: a driver git ships where no `diff` was forced is the review it had.
  const { dir, base } = repo({ 'README.md': '# x\n', 'cfg/x.dat': 'x\n' });
  write(dir, { '.gitattributes': '*.dat diff=python\n' });
  const head = commit(dir, 'driver');
  assert.deepEqual(changeFilesModule.attributeOutcome(dir, base, head), []);
  assert.equal(level(changeFiles(dir, base, head), plain).level, 'L1');
});

test('`diff` going from unset to a driver git doesn\'t ship is flagged: its config may show nothing where the base showed "Binary files differ" (R21, round 6)', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const forms = [
    // U1: main has `*.sql diff=custom` then `*.sql -diff`; the change removes the `-diff`.
    { what: 'removing a later -diff', before: { '.gitattributes': '*.sql diff=custom\n*.sql -diff\n' }, after: { '.gitattributes': '*.sql diff=custom\n' }, gone: [] as string[] },
    // U2: the `-diff` is in db/.gitattributes; the change deletes that file.
    { what: 'deleting the db/.gitattributes that holds the -diff', before: { '.gitattributes': '*.sql diff=custom\n', 'db/.gitattributes': '*.sql -diff\n' }, after: {}, gone: ['db/.gitattributes'] },
  ];
  for (const { what, before, after, gone } of forms) {
    const { dir, base } = repo({ 'README.md': '# x\n', 'db/x.sql': 'select 1;\n', ...before });
    write(dir, { ...after, 'db/x.sql': 'select 1;\nDROP TABLE users;\n' });
    for (const p of gone) git(dir, 'rm', '-q', p);
    const head = commit(dir, what);
    // Why it fails closed: with a textconv for that driver, the head's diff of the file is empty, where the base's
    // attributes showed "Binary files differ".
    const view = (rev: string) => git(dir, '-c', 'core.attributesFile=/dev/null', '-c', 'diff.custom.textconv=grep -v DROP', `--attr-source=${rev}`, 'diff', `${base}..${head}`, '--', 'db/x.sql');
    assert.match(view(base), /Binary files .* differ/, what);
    assert.equal(view(head), '', what);
    const files = changeFiles(dir, base, head);
    const ga = files.find((f) => isGitattributesPath(f.path));
    assert.ok(ga?.attributeOutcome?.includes('db/x.sql: diff unset -> custom'), `${what}: ${JSON.stringify(ga?.attributeOutcome)}`);
    assert.ok(level(files, plain).categories['diff-hiding-attributes']?.length, what);
  }
});

test('the line layer reads each line both git\'s way and any-whitespace\'s way, and flags it if either does (R17, round 5: 32840f0e\'s breadth)', () => {
  const seps = ['\v', '\f', ' ', '　', '﻿', ' '];
  const added = ['-diff', 'binary', 'linguist-generated', 'filter=lfs', 'working-tree-encoding=IBM037', 'diff=custom', '!diff', 'quiet'];
  const removed = ['diff', '-filter', '-linguist-generated', 'linguist-generated=false', '!diff'];
  const missed: string[] = [];
  for (const sep of seps) {
    for (const a of added) {
      // Between the pattern and the attribute, before the pattern, and before a macro definition.
      for (const line of [`*.sql${sep}${a}`, `*.sql ${sep}${a}`, `${sep}*.sql ${a}`]) if (!hidesDiff(line, ['quiet'])) missed.push(`added ${JSON.stringify(line)}`);
    }
    for (const r of removed) for (const line of [`*.sql${sep}${r}`, `${sep}*.sql ${r}`]) if (!unhidLine(line, [])) missed.push(`removed ${JSON.stringify(line)}`);
    for (const line of [`${sep}[attr]eol -diff`, `${sep}[attr]eol text`]) {
      if (!hidesDiff(line, [])) missed.push(`added ${JSON.stringify(line)}`);
      if (!unhidLine(line, [])) missed.push(`removed ${JSON.stringify(line)}`);
    }
  }
  assert.deepEqual(missed, []);
  // A real comment, and harmless attributes behind any separator, stay unflagged.
  for (const sep of seps) for (const line of [`#*.sql${sep}-diff`, `*.sql${sep}text`, `*.sql${sep}eol=lf`]) assert.equal(hidesDiff(line, []), false, JSON.stringify(line));
});

test('the outcome check judges the whole tree from a subdirectory too (ls-tree --full-tree, check-attr from the top)', () => {
  const { dir, base } = repo({ 'README.md': '# x\n', 'sub/a.txt': 'x\n', 'x.sql': jobLines(3) });
  write(dir, { '.gitattributes': '*.sql -diff\n' });
  const head = commit(dir, 'mark');
  assert.deepEqual(changeFilesModule.attributeOutcome(join(dir, 'sub'), base, head), ['x.sql: diff unspecified -> unset']);
  assert.deepEqual(changeFilesModule.attributeOutcome(dir, base, head), ['x.sql: diff unspecified -> unset']);
});

test('a .gitattributes name with an HFS-ignorable character is L3 through invisible-character-path (R19, round 5)', () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  for (const at of ['.gitattributes‌', '.git‌attributes', '.gitmodules‌']) {
    assert.equal(isGitattributesPath(at) || isGitmodulesPath(at), false, `not matched by name: ${JSON.stringify(at)}`);
    const lvl = level([{ path: at, added: 1, removed: 0, addedLines: ['*.sql -diff'], removedLines: [] }], plain);
    assert.deepEqual([lvl.level, lvl.categories['invisible-character-path']], ['L3', [at]], JSON.stringify(at));
  }
});

test('the outcome check fails closed: a git older than 2.40 (no check-attr --source), or a rule in $GIT_DIR/info/attributes that would mask the trees', { skip: process.platform === 'win32' && 'a shell stand-in for git' }, () => {
  const plain = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: [], over_lines: 800 } } });
  const { dir, base } = repo({ 'README.md': '# x\n' });
  write(dir, { '.gitattributes': '* text=auto\n' });
  const head = commit(dir, 'harmless');
  assert.deepEqual(changeFilesModule.attributeOutcome(dir, base, head), []);
  assert.equal(level(changeFiles(dir, base, head), plain).level, 'L1');
  // A stand-in git that says it is 2.39 and passes everything else to the real one.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(join(tmpdir(), 'old-git-'));
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do last="$a"; done\nif [ "$last" = version ]; then echo "git version 2.39.5"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    assert.equal(changeFilesModule.attributeOutcome(dir, base, head), null);
    assert.equal(level(changeFiles(dir, base, head), plain).level, 'L3');
  } finally {
    process.env.PATH = path;
  }
  // info/attributes with a rule: git reads it over every tree, so the trees can't be judged.
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '# a comment only\n');
  assert.deepEqual(changeFilesModule.attributeOutcome(dir, base, head), [], 'comments only: judged');
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '* diff\n');
  assert.equal(changeFilesModule.attributeOutcome(dir, base, head), null);
  assert.equal(level(changeFiles(dir, base, head), plain).level, 'L3');
});

/** A commit's id in a scratch repo of its own: the commit a submodule link points at (`n` makes each one different). */
function submoduleCommit(n: number): string {
  const { dir } = repo({ 'a.txt': `${n}\n` });
  return git(dir, 'rev-parse', 'HEAD');
}

test('a submodule link is seen whatever .gitmodules says (ignore = all committed in the change) or the config says (diff.ignoreSubmodules=all)', () => {
  const migration = ReviewConfig.parse({ version: 1, levels: { ...LEVELS, L3_human: { when: ['migration'], over_lines: 800 } } });
  // .gitmodules with ignore = all, committed in the same change as the link.
  const a = repo({ 'README.md': '# x\n' });
  git(a.dir, 'update-index', '--add', '--cacheinfo', `160000,${submoduleCommit(1)},db/migrations/0042`);
  write(a.dir, { '.gitmodules': '[submodule "m"]\n\tpath = db/migrations/0042\n\turl = ./m\n\tignore = all\n' });
  git(a.dir, 'add', '.gitmodules');
  git(a.dir, 'commit', '-q', '-m', 'add a migration as a submodule');
  const aHead = git(a.dir, 'rev-parse', 'HEAD');
  // git itself hides the link.
  assert.equal(git(a.dir, 'diff', '--name-only', `${a.base}..${aHead}`), '.gitmodules');
  const aFiles = changeFiles(a.dir, a.base, aHead);
  assert.deepEqual(aFiles.map((f) => f.path).sort(), ['.gitmodules', 'db/migrations/0042']);
  assert.deepEqual(changeFilesModule.changedNames(a.dir, [`${a.base}..${aHead}`]).sort(), ['.gitmodules', 'db/migrations/0042']);
  assert.deepEqual(changeFilesModule.changedNames(a.dir, ['-r', a.base, aHead], { tree: true }).sort(), ['.gitmodules', 'db/migrations/0042']);
  const aLevel = level(aFiles, migration);
  assert.equal(aLevel.level, 'L3');
  assert.deepEqual(aLevel.categories.migration, ['db/migrations/0042']);
  assert.deepEqual(aLevel.categories['diff-hiding-attributes'], ['.gitmodules']);
  // diff.ignoreSubmodules=all in the repo's config, and a bump of a link already on main.
  const b = repo({ 'README.md': '# x\n' });
  git(b.dir, 'update-index', '--add', '--cacheinfo', `160000,${submoduleCommit(1)},db/migrations/0042`);
  git(b.dir, 'commit', '-q', '-m', 'link');
  const bBase = git(b.dir, 'rev-parse', 'HEAD');
  git(b.dir, 'update-index', '--cacheinfo', `160000,${submoduleCommit(2)},db/migrations/0042`);
  git(b.dir, 'commit', '-q', '-m', 'bump');
  const bHead = git(b.dir, 'rev-parse', 'HEAD');
  git(b.dir, 'config', 'diff.ignoreSubmodules', 'all');
  assert.equal(git(b.dir, 'diff', '--name-only', `${bBase}..${bHead}`), '');
  assert.deepEqual(changeFiles(b.dir, bBase, bHead).map((f) => [f.path, f.added, f.removed]), [['db/migrations/0042', 1, 1]]);
  assert.deepEqual(changeFilesModule.changedNames(b.dir, [`${bBase}..${bHead}`]), ['db/migrations/0042']);
  assert.deepEqual(changeFilesModule.changedStatuses(b.dir, [bBase, bHead]), [{ status: 'M', path: 'db/migrations/0042' }]);
  assert.deepEqual(sizeFiles(b.dir, bBase, bHead).map((f) => [f.path, f.added.length, f.removed.length]), [['db/migrations/0042', 1, 1]]);
  assert.deepEqual(pushProblems(b.dir, bBase, bHead, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 1 }), ['changes 2 lines, over the 1-line limit (push.max_changed_lines); split it into smaller changes']);
  assert.equal(level(changeFiles(b.dir, bBase, bHead), migration).level, 'L3');
});

test('the push limit pairs renames only as the config says: under diff.renames=false a pure rename of 40 lines counts 80, as the plain count it replaced did', () => {
  const { dir, base } = repo({ 'README.md': '# x\n', 'src/long.ts': jobLines(40) });
  renameSync(join(dir, 'src/long.ts'), join(dir, 'src/longer.ts'));
  const head = commit(dir, 'move');
  // Paired by default: 0.
  assert.deepEqual(pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 0 }), []);
  git(dir, 'config', 'diff.renames', 'false');
  // What the old reader counted under that config.
  assert.equal(git(dir, 'diff', '--numstat', `${base}..${head}`), '0\t40\tsrc/long.ts\n40\t0\tsrc/longer.ts');
  assert.deepEqual(pushProblems(dir, base, head, { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 79 }), ['changes 80 lines, over the 79-line limit (push.max_changed_lines); split it into smaller changes']);
  // The size limit (review.yaml max_pr_lines) pairs renames whatever the config says, as before.
  assert.equal(sizeVerdict(sizeFiles(dir, base, head), { maxLines: 600, generated: DEFAULT_GENERATED }).lines, 0);
});

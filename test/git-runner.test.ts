// One git runner for every git call the engine makes (#807). refs/replace/* and $GIT_DIR/info/grafts are in the
// repository, which every worktree of it shares, so an agent can write either; every git the engine runs there then
// reads the agent's stand-in. A `git replace` of the pushed commit hid a refused file and a big one from the push
// limits (2 problems became 0), and a graft that makes the base reach the head emptied the range (2 became 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { devNull, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ReviewConfig } from '../src/config/schema.js';
import { DEFAULT_PUSH_LIMITS, pushProblems, type PushLimits } from '../src/push-check.js';
import { computeLevel, SELF_MODIFICATION, selfModificationPart } from '../src/review.js';
import { findTool } from '../src/tool-path.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const limits = (over: Partial<PushLimits> = {}): PushLimits => ({ ...DEFAULT_PUSH_LIMITS, ...over });

/** A repo with one commit (base) and a change on it (head) that adds a refused file and a big one. */
function repo() {
  const work = mkdtempSync(join(tmpdir(), 'git-runner-'));
  git(work, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false']]) git(work, 'config', k!, v!);
  writeFileSync(join(work, 'README.md'), 'hello\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-q', '-m', 'init');
  const base = git(work, 'rev-parse', 'HEAD');
  mkdirSync(join(work, 'keys'));
  writeFileSync(join(work, 'keys', 'secret.pem'), 'not a real key\n');
  writeFileSync(join(work, 'weights.bin'), 'x'.repeat(4096));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'add a key and a big file');
  return { work, base, head: git(work, 'rev-parse', 'HEAD') };
}

const RULES = limits({ refuse_paths: ['**/*.pem'], max_file_mb: 0.002 });

test('a replace ref on the pushed commit doesn\'t hide a refused file or a big one from the push limits', () => {
  const r = repo();
  const before = pushProblems(r.work, r.base, r.head, RULES);
  assert.equal(before.length, 2, before.join('\n'));
  // The decoy: the same parent, base's tree (no key, no big file).
  const decoy = git(r.work, 'commit-tree', `${r.base}^{tree}`, '-p', r.base, '-m', 'docs');
  git(r.work, 'replace', r.head, decoy);
  // git itself now reads the decoy.
  assert.equal(git(r.work, 'log', '--format=', '--name-only', `${r.base}..${r.head}`), '');
  const after = pushProblems(r.work, r.base, r.head, RULES);
  assert.equal(after.length, 2, after.join('\n'));
  assert.match(after.join('\n'), /keys\/secret\.pem/);
  assert.match(after.join('\n'), /weights\.bin/);
});

test('a graft that makes the base reach the head doesn\'t empty the range the push limits read', () => {
  const r = repo();
  // $GIT_DIR/info/grafts: the base commit now has the head as a parent, so base..head is empty to git.
  const grafts = join(r.work, '.git', 'info', 'grafts');
  writeFileSync(grafts, `${r.base} ${r.head}\n`);
  assert.equal(execFileSync('git', ['rev-list', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), '');
  const after = pushProblems(r.work, r.base, r.head, RULES);
  assert.equal(after.length, 2, after.join('\n'));
  assert.match(after.join('\n'), /keys\/secret\.pem/);
  assert.match(after.join('\n'), /weights\.bin/);
});

test('gitleaks, which runs git itself, gets the settings: a replace ref on the leaky commit doesn\'t hide its secret from the change scan', { skip: !findTool('gitleaks') && 'gitleaks not installed' }, async () => {
  const { scanRange } = await import('../src/scan/secrets.js');
  const r = repo();
  writeFileSync(join(r.work, 'c.js'), `export const token = '${'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}';\n`);
  git(r.work, 'add', 'c.js');
  git(r.work, 'commit', '-q', '-m', 'leaky change');
  const leaky = git(r.work, 'rev-parse', 'HEAD');
  assert.equal((await scanRange(r.work, `${r.head}..${leaky}`)).status, 'leaks');
  const decoy = git(r.work, 'commit-tree', `${r.head}^{tree}`, '-p', r.head, '-m', 'docs');
  git(r.work, 'replace', leaky, decoy);
  assert.equal((await scanRange(r.work, `${r.head}..${leaky}`)).status, 'leaks');
});

test('the push gate script (scripts/push-gate.mjs), which runs alone, scans the real commits under a replace ref', { skip: !findTool('gitleaks') && 'gitleaks not installed' }, () => {
  const r = repo();
  const hash = (t: string) => createHash('sha256').update(t).digest('hex');
  const real = JSON.parse(readFileSync(join(repoRoot, '.denylist.json'), 'utf8')) as { patterns: string[] };
  writeFileSync(join(r.work, '.denylist.json'), JSON.stringify({ hashed: [hash('secretproject')], patterns: real.patterns }));
  git(r.work, 'add', '.denylist.json');
  git(r.work, 'commit', '-q', '-m', 'rules');
  const base = git(r.work, 'rev-parse', 'HEAD');
  writeFileSync(join(r.work, 'notes.md'), 'deployed by secretproject\n');
  git(r.work, 'add', 'notes.md');
  git(r.work, 'commit', '-q', '-m', 'add notes');
  const head = git(r.work, 'rev-parse', 'HEAD');
  const gate = () => spawnSync(process.execPath, [join(repoRoot, 'scripts', 'push-gate.mjs'), '--range', `${base}..${head}`], { cwd: r.work, encoding: 'utf8' });
  const before = gate();
  assert.notEqual(before.status, 0, 'refused before the replace');
  assert.match(before.stderr, /notes\.md/);
  const decoy = git(r.work, 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'add notes');
  git(r.work, 'replace', head, decoy);
  const after = gate();
  assert.notEqual(after.status, 0, after.stderr);
  assert.match(after.stderr, /REFUSED[\s\S]*notes\.md/);
});

// ---- The runner itself.

test('the runner\'s settings go on last: a caller\'s environment can\'t turn replace refs or grafts back on', async () => {
  const { GIT_FIXED_ENV, gitEnv, gitExecFileSync, gitSpawnSync } = await import('../src/os/git.js');
  const r = repo();
  // A graft file of the caller's choosing (the base reaches the head): the runner's GIT_GRAFT_FILE wins.
  const grafts = join(r.work, 'grafts');
  writeFileSync(grafts, `${r.base} ${r.head}\n`);
  const env = { ...process.env, GIT_GRAFT_FILE: grafts };
  assert.equal(execFileSync('git', ['rev-list', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }), '');
  const names = (out: string) => out.split('\n').filter(Boolean).sort();
  const want = ['keys/secret.pem', 'weights.bin'];
  assert.deepEqual(names(gitExecFileSync(['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', env })), want);
  assert.deepEqual(names(gitSpawnSync(['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', env }).stdout), want);
  const graphOff = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'false' };
  assert.deepEqual({ ...gitEnv({ GIT_GRAFT_FILE: grafts, GIT_NO_REPLACE_OBJECTS: '0' }) }, { ...GIT_FIXED_ENV, ...graphOff });
  // A caller's own config pairs stay; the fixed pair goes after them (a later pair wins).
  assert.deepEqual({ ...gitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' }) }, { ...GIT_FIXED_ENV, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'core.commitGraph', GIT_CONFIG_VALUE_1: 'false' });
  // A count on Object.prototype is never read (#846): the fixed pair is pair 0, and nothing else is counted.
  const proto = Object.prototype as Record<string, unknown>;
  proto.GIT_CONFIG_COUNT = '1';
  try {
    assert.deepEqual({ ...gitEnv({}) }, { ...GIT_FIXED_ENV, ...graphOff });
  } finally {
    delete proto.GIT_CONFIG_COUNT;
  }
  // Replace refs: `--no-replace-objects` is in the argument list, which no environment takes back.
  const decoy = git(r.work, 'commit-tree', `${r.base}^{tree}`, '-p', r.base, '-m', 'docs');
  git(r.work, 'replace', r.head, decoy);
  assert.deepEqual(names(gitExecFileSync(['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', env: {} })), want);
});

test('a runner that takes any command (a probe\'s run) gives git the settings, by name or path, and leaves others as they are', { skip: process.platform === 'win32' && 'sh' }, async () => {
  const { commandSpawnSync, isGitCommand } = await import('../src/os/git.js');
  const r = repo();
  const decoy = git(r.work, 'commit-tree', `${r.base}^{tree}`, '-p', r.base, '-m', 'docs');
  git(r.work, 'replace', r.head, decoy);
  const gitPath = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  for (const cmd of ['git', gitPath]) {
    const out = commandSpawnSync(cmd, ['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8' }).stdout;
    assert.match(out, /keys\/secret\.pem/, cmd);
  }
  assert.ok(isGitCommand('git') && isGitCommand('/usr/bin/git') && isGitCommand('C:\\Git\\cmd\\git.exe') && isGitCommand('GIT'));
  assert.ok(!isGitCommand('gitleaks') && !isGitCommand('/usr/bin/legit') && !isGitCommand('gh'));
  const argv = commandSpawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(argv.stdout), ['a']);
});

test('scripts/lib/git.cjs (scripts run without a build) has the engine runner\'s settings, and applies them last', async () => {
  const engine = await import('../src/os/git.js');
  const scripts = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'lib', 'git.cjs')) as typeof engine;
  assert.deepEqual([...scripts.GIT_FIXED_ARGS], [...engine.GIT_FIXED_ARGS]);
  assert.deepEqual({ ...scripts.GIT_FIXED_ENV }, { ...engine.GIT_FIXED_ENV });
  // What the files that run on their own write out (ITS_OWN, below) is these values.
  assert.deepEqual(scripts.GIT_FIXED_CONFIG.map((p) => [...p]), engine.GIT_FIXED_CONFIG.map((p) => [...p]));
  assert.deepEqual({ ...scripts.gitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }) }, { ...engine.gitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }) });
  assert.deepEqual([...engine.GIT_FIXED_ARGS], ['--no-replace-objects', '-c', 'core.commitGraph=false']);
  assert.deepEqual({ ...engine.GIT_FIXED_ENV }, { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: join(devNull, 'no-grafts') });
  const r = repo();
  const decoy = git(r.work, 'commit-tree', `${r.base}^{tree}`, '-p', r.base, '-m', 'docs');
  git(r.work, 'replace', r.head, decoy);
  writeFileSync(join(r.work, '.git', 'info', 'grafts'), `${r.base} ${r.head}\n`);
  const env = { ...process.env, GIT_GRAFT_FILE: join(r.work, '.git', 'info', 'grafts') };
  assert.match(scripts.gitExecFileSync(['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', env }), /keys\/secret\.pem/);
  assert.match(scripts.gitSpawnSync(['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8', env }).stdout, /keys\/secret\.pem/);
  assert.match(scripts.commandSpawnSync('git', ['log', '--format=', '--name-only', `${r.base}..${r.head}`], { cwd: r.work, encoding: 'utf8' }).stdout, /keys\/secret\.pem/);
});

// ---- No git call in src/ or scripts/ bypasses the runner.

/**
 * Where a source text starts git itself: `git` (or a path to it, or git.exe) as a quoted string in an argument or array
 * position or assigned to a name (`spawnSync('git', …)`, `run('git', …)`, `['git', 'fetch']`, `const bin = 'git'`), or
 * a shell line that starts with git (`exec('git log')`, `['-c', 'git log']`). A comparison (`=== 'git'`) or an object
 * key's value (`type: 'git'`) isn't one. A backstop next to the runner, not a proof. Measured misses (#927's final
 * check): a name built at run time (`'gi' + 't'`, `${'git'}`, String.raw`git`), a ternary or a default (`x ? 'git' :`,
 * `?? 'git'`, `|| 'git'`), a command from config, env or an object property, git in the middle of a shell string
 * (`bash -lc 'cd x && git log'`, `execSync('cd x && git log')`, `spawnSync('git log', { shell: true })`), and the
 * `.sh` files under scripts/ (16 run git; not scanned).
 */
function gitStarts(text: string): number {
  const patterns = [
    /(?:[([,]|(?<![=!<>])=)\s*(['"`])(?:[^'"`\s]*[\\/])?git(?:\.exe)?\1/gi,
    /\b(?:exec|execSync)\s*\(\s*(['"`])\s*git\s/g,
    /(['"`])-c\1\s*,\s*(['"`])\s*git\s/g,
  ];
  return patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

const RUNNERS = new Set(['src/os/git.ts', 'scripts/lib/git.cjs']);

/**
 * A file that runs on its own (copied alone, or fetched alone from origin) can't import a runner: it holds the
 * settings itself, written out exactly so, and the test below ties them to the runner's values.
 */
const ITS_OWN = [/const GIT_FIXED_ARGS = (?:Object\.freeze\()?\['--no-replace-objects', '-c', 'core\.commitGraph=false'\]/, /GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: join\(devNull, 'no-grafts'\)/];
/** A runner that takes any command (`run(cmd, args)`), and so gives git the settings by its name. */
const BY_NAME = (fn: string, call: string) => [new RegExp(`${fn}\\(${call}`)];

/**
 * Files that start git outside the runners, each with how many times (exactly: one more is a new call) and why. Each
 * is a call through a runner that takes any command and gives git the settings by its name (commandSpawnSync), a
 * file that runs on its own and holds the settings itself, or text that names git without starting it.
 */
const OUTSIDE_THE_RUNNER: Record<string, { n: number; why: string; must?: RegExp[] }> = {
  // Through a runner that takes any command: its real one spawns through commandSpawnSync (src/os/git.ts).
  'src/init.ts': { n: 6, why: "`c.io.run('git', ...)` and `io.run('git', ...)`: systemIo().run, here, spawns through commandSpawnSync; and `manual.includes('git')`, a hint's text", must: BY_NAME('commandSpawnSync', 'cmd, args, ') },
  'src/setup-steps.ts': { n: 7, why: "`k.p.run('git', ...)`: systemProbe().run, here, spawns through commandSpawnSync; and REQUIRED_TOOLS, two lists of tool names", must: BY_NAME('commandSpawnSync', 'cmd, args, ') },
  'src/setup-mode.ts': { n: 3, why: "originPlan's two commands and `base.run('git', ...)`: each run by an InitIo's run, systemIo() in src/init.ts (commandSpawnSync)" },
  'src/setup-actions.ts': { n: 3, why: "defaultBranchCommands' two commands, run here through commandSpawnSync; and `manual.includes('git')`, a hint's text", must: BY_NAME('commandSpawnSync', 'cmd\\[0\\]!, cmd\\.slice\\(1\\), ') },
  'src/starter-ci.ts': { n: 3, why: "`run('git', ...)`: realRun, here, spawns through commandSpawnSync", must: BY_NAME('commandSpawnSync', 'cmd, args, ') },
  'src/testrun/host.ts': { n: 1, why: "`run('git', gitArgs(...), { env: gitEnv(...) })`: the async runner, given the settings by hand", must: [/run\('git', gitArgs\(\[/, /env: gitEnv\(\{ PATH/] },
  // Text that names git without starting it.
  'src/scan/secrets.ts': { n: 2, why: "gitleaks' `git` subcommand; gitleaks runs git itself, so it gets gitEnv()", must: [/'--exit-code', String\(LEAKS_EXIT\), '\.'\], \{ cwd, encoding: 'utf8', timeout: 120_000, env: gitEnv\(\) \}/, /stdio: \['ignore', 'ignore', 'pipe'\], env: gitEnv\(env\) \}/] },
  'src/review.ts': { n: 2, why: "`'git'`: the name of a way to read a .gitattributes line" },
  'src/plugins/approval.ts': { n: 1, why: "`z.literal('git')`: a plugin source's type" },
  'src/updater-setup.ts': { n: 1, why: 'a comment quoting an allowed-signers line (namespaces="git")' },
  'src/os/index.ts': { n: 2, why: "`which('git')` and the `Git` folder: where Git for Windows' bash is, never run as git" },
  'scripts/verify-release-tag.mjs': { n: 2, why: "ssh-keygen's `-n git`: the signature namespace" },
  // Runs on its own, with the settings written out.
  'scripts/push-gate-hook.mjs': { n: 1, why: 'runGit: setup-hooks copies this file alone into the hooks dir; it hands the gate the settings in its environment too', must: [...ITS_OWN, /\{ \.\.\.process\.env, GIT_DIR: gitDir, \.\.\.GIT_FIXED_ENV \}/] },
  'scripts/push-gate.mjs': { n: 2, why: "runGit, and gitleaks' `git` subcommand (with GIT_ENV): the hook runs this file alone, fetched from origin (GATE_CODE)", must: [...ITS_OWN, /\{ encoding: 'utf8', env: GIT_ENV \}/, /const GIT_ENV = graphOff\(\{ \.\.\.process\.env, /, /\[`GIT_CONFIG_KEY_\$\{n\}`\]: 'core\.commitGraph', \[`GIT_CONFIG_VALUE_\$\{n\}`\]: 'false'/] },
  'scripts/ci/new-deps.mjs': { n: 1, why: "runGit: CI runs the base's copy of this file alone, from a temp dir (new-deps.yml)", must: ITS_OWN },
  'scripts/ci/testrun-real-systemd.mjs': { n: 1, why: 'its git: the job copies this file alone into the VM (ci-slow.yml)', must: [/const GIT_FIXED_ARGS = \['--no-replace-objects', '-c', 'core\.commitGraph=false'\]/, /GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: join\(devNull, 'no-grafts'\)/, /execFileSync\('git', \[\.\.\.GIT_FIXED_ARGS, /] },
  'scripts/machine/worklane-update.cjs': {
    n: 7,
    why: "the root updater, installed alone in /usr/local/libexec: its reads of the verification clone carry VERIFY_GIT_ARGS (replace refs off); that clone is root's own, which no agent can write a graft into; the three ls-remote calls read no object",
    must: [/^const VERIFY_GIT_ARGS = \['--no-replace-objects'\];$/m],
  },
  // CI and dev scripts, through a runner that takes any command: commandSpawnSync / commandExecFileSync / commandSpawn (scripts/lib/git.cjs).
  'scripts/ci/updater-setup-root.mjs': { n: 1, why: "`sh('git', ...)`: sh, here, runs through commandExecFileSync", must: BY_NAME('commandExecFileSync', 'file, args, ') },
  'scripts/ci/wizard-e2e.mjs': { n: 5, why: "`sh('git', ...)`: sh, here, runs through commandSpawnSync", must: BY_NAME('commandSpawnSync', 'cmd, args, ') },
  'scripts/dev/compare-screenshots.mjs': { n: 4, why: "`run('git', ...)`: run, here, spawns through commandSpawn", must: BY_NAME('commandSpawn', 'cmd, args, ') },
};

function sources(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  walk(join(repoRoot, 'src'));
  walk(join(repoRoot, 'scripts'));
  return files;
}

test('every git call in src/ and scripts/ goes through the runner (src/os/git.ts, scripts/lib/git.cjs)', () => {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const f of sources()) {
    const rel = relative(repoRoot, f).split('\\').join('/');
    if (RUNNERS.has(rel)) continue;
    const text = readFileSync(f, 'utf8');
    const n = gitStarts(text);
    if (!n) continue;
    seen.add(rel);
    const allowed = OUTSIDE_THE_RUNNER[rel];
    if (!allowed) bad.push(`${rel}: starts git ${n} time(s) (not on the list)`);
    else if (allowed.n !== n) bad.push(`${rel}: starts git ${n} time(s), listed ${allowed.n}`);
    else for (const re of allowed.must ?? []) if (!re.test(text)) bad.push(`${rel}: no ${re}`);
  }
  for (const rel of Object.keys(OUTSIDE_THE_RUNNER)) if (!seen.has(rel)) bad.push(`${rel}: listed, but starts git no more (take it off the list)`);
  assert.deepEqual(bad, [], 'run git through src/os/git.ts (gitSpawnSync, gitExecFileSync, gitSpawn, gitExecFile, commandSpawnSync) or scripts/lib/git.cjs');
});

test('the scan catches each way of starting git, and not text that only names it', () => {
  const caught = [
    "spawnSync('git', ['log'])",
    'execFileSync("git", ["show", x])',
    'spawn(`git`, args, {})',
    "execFile('git', a, o, cb)",
    "run('/usr/bin/git', ['fetch'])",
    "spawnSync('C:\\\\Git\\\\cmd\\\\git.exe', [])",
    "spawnSync('GIT', [])",
    "const commands = [['git', 'fetch', '-q']];",
    "const bin = 'git';",
    "exec('git log -1', cb)",
    'execSync(`git status`)',
    "spawnSync('sh', ['-c', 'git log'])",
    "spawnSync(\n  'git',\n  ['log'],\n)",
  ];
  for (const c of caught) assert.equal(gitStarts(c), 1, c);
  const named = ["if (bin === 'git') return;", "basename(a[0]) !== 'git'", "{ type: 'git', url }", "// run git log", "'gitleaks'", "spawnSync('legit', [])", "'git log' + x", "the git"];
  for (const c of named) assert.equal(gitStarts(c), 0, c);
});

test('the runners and these tests are locked: a change to any of them alone is self-modification, L3, never L0', () => {
  const cfg = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  for (const [path, part] of [['test/git-runner.test.ts', 'the tests of the harness controls'], ['src/os/git.ts', 'the git runner'], ['scripts/lib/git.cjs', 'the git runner']] as const) {
    const r = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, cfg);
    assert.deepEqual([r.level, r.categories[SELF_MODIFICATION], selfModificationPart(path)], ['L3', [path], part], path);
  }
});

test('the runners the scan skips are the two runner files, and each starts git itself', () => {
  assert.deepEqual([...RUNNERS].sort(), ['scripts/lib/git.cjs', 'src/os/git.ts']);
  for (const rel of RUNNERS) assert.ok(gitStarts(readFileSync(join(repoRoot, rel), 'utf8')) > 0, rel);
});

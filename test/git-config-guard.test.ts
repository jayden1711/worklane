// #926: an instance's checkout is agent-writable, so its git config is too. A coordinator's git (worktree add,
// cherry-pick, fetch) must never run a command, or reach a host, that a config file names: a filter driver, an
// include, a signing program, a URL rewrite. These tests plant each one the way an agent could (in the checkout's
// .git/config, or a file it includes) in stand-in layouts (a bare "origin", the coordinator's clone, an attacker's
// remote), mark the process as an instance's coordinator is marked (service.ts instanceEnv), and run the engine's own
// code: createWorktree, startConfig's fetch, landing's cherry-pick and a whole coordinator landing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startConfig } from '../src/config/live.js';
import { gitExecFile, gitExecFileSync, gitSpawn, gitSpawnSync, commandSpawnSync, gitEnv, configRefusal } from '../src/os/git.js';
import { lockGitDir } from '../src/os/git-dir-lock.js';
import { instanceEnv } from '../src/service.js';
import type { Instance } from '../src/instance.js';
import { createWorktree } from '../src/worktrees.js';
import { FileBacklog } from '../src/backlog/file.js';
import { EventLog } from '../src/events/log.js';
import { Coordinator } from '../src/coordinator.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

/** What instanceEnv sets on an instance coordinator's process (and auto-config on its own). */
const MARK = `${BRAND.envPrefix}_GIT_GUARD`;

/** The test's own git, never the engine's runner: no config but the repo's, so a fixture is what it says. */
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, [MARK]: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const commit = (cwd: string, msg: string) => git(cwd, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);

/**
 * Runs `f` as an instance's coordinator: with the mark in this process's environment (instanceEnv sets it to the
 * instance's checkout, `repo`), taken off after.
 */
async function asCoordinator<T>(f: () => T | Promise<T>, repo?: string): Promise<T> {
  const before = process.env[MARK];
  process.env[MARK] = repo ?? '1';
  try {
    return await f();
  } finally {
    if (before === undefined) delete process.env[MARK];
    else process.env[MARK] = before;
  }
}

/**
 * origin (bare), with a .gitattributes that names filter `x` for *.txt and a `topic` branch one commit ahead; the
 * coordinator's clone; an attacker's remote with another main; and a program that records each time it runs.
 */
function layout() {
  const base = mkdtempSync(join(tmpdir(), 'git-guard-'));
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitattributes'), '*.txt filter=x\n');
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  commit(seed, 'init');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(seed, 'b.txt'), 'b\n');
  git(seed, 'add', '-A');
  commit(seed, 'topic');
  git(seed, 'push', '-q', 'origin', 'topic');
  const repo = join(base, 'checkout');
  git(base, 'clone', '-q', origin, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  git(repo, 'fetch', '-q', 'origin', 'topic:refs/remotes/origin/topic');
  const attacker = join(base, 'attacker.git');
  const other = join(base, 'other');
  git(base, 'init', '-q', '-b', 'main', other);
  writeFileSync(join(other, 'evil.txt'), 'evil\n');
  git(other, 'add', '-A');
  commit(other, 'attacker main');
  git(base, 'clone', '-q', '--bare', other, attacker);
  // One program per plant (git runs a signing program by its path, with no shell): each records that it ran, then
  // passes its input through (a filter) or fails (a signing program).
  const evil = (kind: string) => {
    const p = join(base, `evil-${kind}.sh`);
    writeFileSync(p, `#!/bin/sh\ntouch "${base}/RAN-${kind}"\n${kind === 'gpg' ? 'exit 1' : 'cat'}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  return { base, origin, seed, repo, attacker, evil, ran: (kind: string) => existsSync(join(base, `RAN-${kind}`)) };
}
type Layout = ReturnType<typeof layout>;

/** Each way an agent's write to .git/config could make the coordinator's git run its program or reach its host. */
const PLANTS: Record<string, (l: Layout) => void> = {
  smudge: (l) => git(l.repo, 'config', 'filter.x.smudge', l.evil('smudge')),
  include: (l) => {
    writeFileSync(join(l.base, 'included.cfg'), `[filter "x"]\n\tsmudge = ${l.evil('include')}\n`);
    git(l.repo, 'config', 'include.path', join(l.base, 'included.cfg'));
  },
  insteadOf: (l) => git(l.repo, 'config', `url.${l.attacker}.insteadOf`, l.origin),
  gpg: (l) => {
    git(l.repo, 'config', 'gpg.program', l.evil('gpg'));
    git(l.repo, 'config', 'commit.gpgSign', 'true');
  },
};

/** Whether origin/main in the checkout is the attacker's main: a fetch the rewrite sent elsewhere. */
const redirected = (l: Layout) => git(l.repo, 'rev-parse', 'refs/remotes/origin/main') === git(l.attacker, 'rev-parse', 'refs/heads/main');

for (const [kind, plant] of Object.entries(PLANTS)) {
  // gpg.program is set over (command scope), not refused: the operations that never sign succeed as before.
  const refusedOutright = kind !== 'gpg';

  test(`#926 worktree add (createWorktree): a planted ${kind} never runs${refusedOutright ? ', and git is refused' : ''}`, async () => {
    const l = layout();
    plant(l);
    const wt = { repo: l.repo, root: '../wt', stateDir: join(l.base, 'state'), setup: [] };
    const made = await asCoordinator(() => {
      try {
        createWorktree(wt, 'w1', `${BRAND.cli}/w1`, 'origin/main');
        return { ok: true, why: '' };
      } catch (e) {
        return { ok: false, why: String((e as { stderr?: unknown }).stderr ?? (e as Error).message) };
      }
    }, l.repo);
    assert.equal(l.ran(kind), false, `the planted ${kind} ran during worktree add`);
    if (refusedOutright) {
      assert.equal(made.ok, false, `worktree add went ahead with ${kind} in the config`);
      assert.match(made.why, /refusing to run git/);
    } else assert.equal(made.ok, true, made.why);
  });

  test(`#926 cherry-pick (landing's call, in a worktree createWorktree made): a planted ${kind} never runs, and the pick doesn't go through`, async () => {
    const l = layout();
    const wt = { repo: l.repo, root: '../wt', stateDir: join(l.base, 'state'), setup: [] };
    // The land worktree is made first (before the plant), as landBatch makes it, at origin/main.
    const { path } = createWorktree(wt, 'land-b1', `${BRAND.cli}/land-b1`, 'origin/main');
    plant(l);
    const base = git(l.repo, 'rev-parse', 'origin/main');
    const head = git(l.repo, 'rev-parse', 'origin/topic');
    const pick = await asCoordinator(() => gitSpawnSync(['cherry-pick', `${base}..${head}`], { cwd: path, encoding: 'utf8' }), l.repo);
    assert.equal(l.ran(kind), false, `the planted ${kind} ran during cherry-pick`);
    assert.notEqual(pick.status, 0, `the cherry-pick went through with ${kind} in the config`);
    if (refusedOutright) assert.match(pick.stderr, /refusing to run git/);
  });

  test(`#926 fetch (startConfig's): a planted ${kind} never runs${refusedOutright ? ', and the fetch is refused' : ''}`, async () => {
    const l = layout();
    const cfg = loadConfig(l.repo);
    // A new commit on origin's main: a fetch that runs moves origin/main.
    git(l.seed, 'checkout', '-q', 'main');
    writeFileSync(join(l.seed, 'c.txt'), 'c\n');
    git(l.seed, 'add', '-A');
    commit(l.seed, 'later');
    git(l.seed, 'push', '-q', 'origin', 'main');
    const before = git(l.repo, 'rev-parse', 'refs/remotes/origin/main');
    plant(l);
    await asCoordinator(() => startConfig({ repo: l.repo, remote: 'origin', fallback: cfg }), l.repo);
    assert.equal(l.ran(kind), false, `the planted ${kind} ran during fetch`);
    assert.equal(redirected(l), false, 'the fetch went to the host the rewrite named');
    const after = git(l.repo, 'rev-parse', 'refs/remotes/origin/main');
    if (refusedOutright) assert.equal(after, before, `the fetch ran with ${kind} in the config`);
    else assert.equal(after, git(l.origin, 'rev-parse', 'refs/heads/main'), 'a signing program set over never stops a fetch');
  });
}

test('#926 every entry point of the runner is guarded: each refuses git with an include in the config, and its program never runs', async () => {
  const l = layout();
  PLANTS.include!(l);
  const opts = { cwd: l.repo, encoding: 'utf8' as const };
  const outcomes = await asCoordinator(async () => {
    const out: Record<string, string> = {};
    out.gitSpawnSync = gitSpawnSync(['checkout', '-q', '-f', 'origin/topic', '--', 'b.txt'], opts).stderr;
    try {
      gitExecFileSync(['checkout', '-q', '-f', 'origin/topic', '--', 'b.txt'], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
      out.gitExecFileSync = 'ran';
    } catch (e) {
      out.gitExecFileSync = String((e as { stderr?: unknown }).stderr);
    }
    out.commandSpawnSync = commandSpawnSync('git', ['checkout', '-q', '-f', 'origin/topic', '--', 'b.txt'], opts).stderr;
    out.gitSpawn = await new Promise<string>((done) => {
      const child = gitSpawn(['checkout', '-q', '-f', 'origin/topic', '--', 'b.txt'], { cwd: l.repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('close', () => done(err));
    });
    out.gitExecFile = await new Promise<string>((done) => void gitExecFile(['checkout', '-q', '-f', 'origin/topic', '--', 'b.txt'], opts, (_e, _o, err) => done(err)));
    return out;
  }, l.repo);
  for (const [entry, stderr] of Object.entries(outcomes)) assert.match(stderr, /refusing to run git.*include\.path/, `${entry}: ${stderr}`);
  assert.equal(l.ran('include'), false);
  assert.equal(existsSync(join(l.repo, 'b.txt')), false, 'no checkout happened');
});

test('#926 a caller that hands git its own environment is still guarded: the mark is the process\'s, and the settings go on last', async () => {
  const env = await asCoordinator(() => ({ ...gitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/tmp/mine', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/mine/hooks' }) }));
  // System config is root's and read (#926 round 2: it routes github.com on a machine, and in CI); global isn't.
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env[MARK], '1', 'the mark goes on to every git the guarded git starts');
  const pairs: [string, string][] = [];
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) pairs.push([env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!]);
  // The caller's own pairs come after the guard's: its hooks dir (the coordinator's own) and its credential helper win.
  // (#927's fixed config, the commit-graph off, comes last of all.)
  assert.deepEqual(pairs.at(-2), ['core.hooksPath', '/mine/hooks']);
  assert.deepEqual(pairs.at(-1), ['core.commitGraph', 'false']);
  assert.deepEqual(pairs[0], ['credential.helper', '']);
  // Off: a process that isn't an instance's coordinator keeps its git as it was (local mode, the owner's own config).
  const plain = { ...gitEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/tmp/mine' }) };
  assert.equal(plain.GIT_CONFIG_GLOBAL, '/tmp/mine');
  assert.equal(plain.GIT_CONFIG_NOSYSTEM, undefined);
});

test("#926 an instance's coordinator environment carries the mark, and git authenticates through its own helper only", () => {
  const home = mkdtempSync(join(tmpdir(), 'git-guard-home-'));
  const pairsOf = (env: NodeJS.ProcessEnv) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]);
  for (const github of [{ kind: 'gh-config-dir', path: join(home, 'gh') }, { kind: 'app', app_id: 1, installation_id: 2, key_path: join(home, 'key.pem') }]) {
    const env = instanceEnv({ name: 'shop', home, stateDir: join(home, 'state'), repo: { path: '/srv/x/shop', repo: 'example/shop' }, credentials: { github } } as unknown as Instance, {});
    assert.equal(env[MARK], '/srv/x/shop', `${github.kind}: the mark names the checkout`);
    const helpers = pairsOf(env).filter(([k]) => k === 'credential.helper');
    // A reset, then the instance's own helper: what a config file named is cleared, global config isn't read.
    assert.equal(helpers.length, 2, github.kind);
    assert.deepEqual(helpers[0], ['credential.helper', '']);
    assert.match(helpers[1]![1]!, github.kind === 'app' ? /git-credential$/ : /^!gh auth git-credential$/);
  }
});

test('#926 the guard reads the listing git prints: each refused key, from a file or an include, and only from a file', () => {
  const row = (scope: string, key: string, value = 'v') => `${scope}\0file:.git/config\0${key}\n${value}\0`;
  const refused = ['include.path', 'includeIf.gitdir:/x/.path', 'filter.lfs.smudge', 'filter.X Y.process', 'diff.d.textconv', 'diff.d.command', 'merge.m.driver', 'mergetool.t.cmd', 'url./tmp/evil.insteadOf', 'url.x.pushInsteadOf', 'remote.origin.uploadpack', 'remote.origin.receivepack', 'remote.origin.proxy', 'remote.origin.vcs', 'http.proxy', 'http.https://github.com/.proxy', 'http.sslCAInfo', 'http.sslVerify', 'http.extraHeader', 'http.https://github.com/.extraheader', 'http.cookieFile', 'core.worktree', 'core.gitProxy', 'core.hooksPath', 'submodule.s.update'];
  const fine = ['core.bare', 'core.sharedrepository', 'credential.helper', 'credential.https://github.com.helper', 'remote.origin.url', 'remote.origin.fetch', 'branch.main.remote', 'http.postBuffer', 'filter.x.required', 'diff.d.binary', 'user.name', 'gpg.program', 'core.sshCommand', 'core.fsmonitor', 'commit.gpgSign'];
  for (const k of refused) assert.match(configRefusal(row('local', k)) ?? '', /^the git config \.git\/config sets /, k);
  for (const k of fine) assert.equal(configRefusal(row('local', k)), null, k);
  // Set by the engine itself (command scope, -c or GIT_CONFIG_COUNT): never refused.
  assert.equal(configRefusal(row('command', 'include.path')), null);
  // core.hooksPath in a file is set over when the engine sets its own (the coordinator's hooks dir).
  assert.equal(configRefusal(row('local', 'core.hookspath') + row('command', 'core.hookspath')), null);
  // checkout.sh's own check (run as the coordinator before its pull) is this one, through the CLI: no second parser
  // or key list in shell (round 3: a shell parser read a listing with control bytes differently).
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'checkout.sh'), 'utf8');
  assert.match(sh, /^ {2}worklane git-config-check "\$2"$/m);
  assert.doesNotMatch(sh, /refused=|--show-scope/);
});

test('#926 checkout.sh locks .git/ but what agents write, and refuses a symlink in it', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'checkout.sh'), 'utf8');
  const fn = /^lock_git_dir\(\) \{\n[\s\S]*?\n\}$/m.exec(sh)?.[0];
  assert.ok(fn, 'checkout.sh defines lock_git_dir');
  const l = layout();
  const dest = l.repo;
  // As checkout.sh leaves a checkout before the lock: all of it group-writable.
  execFileSync('chmod', ['-R', 'g+rwX', dest]);
  const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  const run = () => execFileSync('bash', ['-c', `set -euo pipefail\ndest="$1" coord="$2"\n${fn}\nlock_git_dir`, '_', dest, me], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run();
  const w = (p: string) => (statSync(join(dest, '.git', p)).mode & 0o022) !== 0;
  for (const p of ['', 'config', 'hooks', 'info', 'HEAD', 'packed-refs']) if (existsSync(join(dest, '.git', p))) assert.equal(w(p), false, `.git/${p} is still group-writable`);
  for (const p of ['objects', 'refs', 'logs']) assert.equal(w(p), true, `.git/${p} is still the agents'`);
  assert.equal((statSync(join(dest, 'a.txt')).mode & 0o020) !== 0, true, 'the working tree stays group-writable');
  // A symlink at the top of .git/: refused, never followed.
  symlinkSync(join(l.base, 'elsewhere'), join(dest, '.git', 'planted'));
  assert.throws(run, /holds a symlink/);
});

test('#926 a coordinator start locks its checkout .git/ the same way (lockGitDir), and refuses a symlink', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const l = layout();
  execFileSync('chmod', ['-R', 'g+rwX', l.repo]);
  assert.deepEqual(lockGitDir(l.repo), []);
  const w = (p: string) => (statSync(join(l.repo, '.git', p)).mode & 0o022) !== 0;
  for (const p of ['', 'config', 'hooks', 'info', 'HEAD']) assert.equal(w(p), false, `.git/${p} is still group-writable`);
  for (const p of ['objects', 'refs', 'logs']) assert.equal(w(p), true, `.git/${p} is still the agents'`);
  assert.deepEqual(lockGitDir(l.repo), [], 'again: nothing to do');
  symlinkSync(join(l.base, 'elsewhere'), join(l.repo, '.git', 'planted'));
  assert.match(lockGitDir(l.repo).join('\n'), /planted is a symlink/);
});

// ---- A whole landing, as an instance's coordinator runs it ----

const skipLand = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const BUG = 'Orders with a zero or negative quantity are counted in totals.\n\n```done_when\n- test: test/price.test.js\n- repro: true\n```\n';
const REPRO = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('ignores non-positive quantities', () => { assert.equal(totalCents([{ cents: 100, qty: -2 }, { cents: 5, qty: 1 }]), 5); });\n`;

function landFixture() {
  const l = layout();
  const cfg = loadConfig(l.repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const backlog = new FileBacklog(join(l.base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(l.base, 'events.db'));
  const slotsDir = join(l.base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const machine = { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) };
  const agentCommit = (cwd: string, msg: string) => {
    git(cwd, 'add', '-A');
    git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
  };
  const runner = new FakeRunner((req) => {
    if (req.role === 'plan-reviewer') return { structured: { contradictions: [], summary: 'contradicts nothing recorded' } };
    if (req.role === 'evaluator-repro') {
      writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'), REPRO);
      agentCommit(req.cwd, 'repro');
      return { structured: { test_path: 'test/repro-qty.test.js', explanation: 'negative qty subtracts' } };
    }
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      agentCommit(req.cwd, 'Ignore non-positive quantities in totals');
      return { structured: { summary: 'fixed' } };
    }
    const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
    const files = base ? git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean) : [];
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: files } };
  });
  backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg, log, backlog, runner, repo: l.repo, instance: 'alice', stateDir: join(l.base, 'state'), slotsDir, machine });
  return { ...l, c, log };
}
const landed = (log: EventLog) => (log.read(0, ['land.result']).at(-1)?.payload as { outcome: string } | undefined)?.outcome;

test('#926 a whole landing as an instance\'s coordinator: with nothing planted it lands as before', { skip: skipLand }, async () => {
  const f = landFixture();
  await asCoordinator(async () => {
    await f.c.tick();
    await f.c.idle();
    await f.c.tick();
  }, f.repo);
  assert.equal(landed(f.log), 'landed');
});

test('#926 a whole landing as an instance\'s coordinator: a signing program planted before the land never runs, and nothing lands unsigned past it', { skip: skipLand }, async () => {
  const f = landFixture();
  await asCoordinator(async () => {
    await f.c.tick();
    await f.c.idle();
    // The change is queued to land: an agent's write to .git/config now names its program for signing.
    PLANTS.gpg!(f);
    await f.c.tick();
  }, f.repo);
  assert.equal(f.ran('gpg'), false, 'the planted gpg.program ran during the landing');
  assert.notEqual(landed(f.log), 'landed');
});

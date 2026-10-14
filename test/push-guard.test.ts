// The git layer of the default-branch guard (src/push-guard.ts): the pre-push hook in a checkout and in the
// coordinator's own hooks dir refuses any push to the default branch, records it, and lets task branches through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { EventLog } from '../src/events/log.js';
import { installCheckoutPrePush } from '../src/install.js';
import { coordinatorHooksDir, destinationRef, isDefaultBranchRef, PRE_PUSH_MARKER, writeCoordinatorHooks } from '../src/push-guard.js';
import { instanceEnv } from '../src/service.js';
import type { Instance } from '../src/instance.js';
import { engineCli } from './helpers.js';

const posix = process.platform !== 'win32';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare remote whose HEAD is main, and a clone of it with one commit to push. */
function checkout() {
  const base = mkdtempSync(join(tmpdir(), 'push-guard-'));
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', 'a.txt');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', remote, 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', 'b.txt');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'change');
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  return { base, remote, repo, stateDir, head: git(repo, 'rev-parse', 'HEAD'), main: () => git(remote, 'rev-parse', 'main') };
}

/** `git push` as a person or script would from the checkout, with this project's state dir for the event. */
const push = (c: ReturnType<typeof checkout>, refspec: string, extra: string[] = []) =>
  spawnSync('git', [...extra, 'push', 'origin', refspec], { cwd: c.repo, encoding: 'utf8', env: { ...process.env, [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: c.stateDir, [`${BRAND.envPrefix}_INSTANCE`]: '' } });

const blocked = (stateDir: string) => {
  if (!existsSync(join(stateDir, 'events.db'))) return [];
  const log = new EventLog(join(stateDir, 'events.db'));
  try {
    return log.read(0, ['push.blocked']).map((e) => e.payload);
  } finally {
    log.close();
  }
};

test('a push refspec names its destination ref; only refs/heads/<default> is the default branch', () => {
  assert.equal(destinationRef('main'), 'refs/heads/main');
  assert.equal(destinationRef('+HEAD:main'), 'refs/heads/main');
  assert.equal(destinationRef('abc:refs/heads/x'), 'refs/heads/x');
  assert.ok(isDefaultBranchRef('refs/heads/main', 'main'));
  for (const r of ['refs/heads/mainline', 'refs/heads/x/main', 'refs/tags/main', `refs/${BRAND.cli}/claims/issue-1`]) assert.ok(!isDefaultBranchRef(r, 'main'), r);
});

test("the checkout's pre-push hook refuses a push to the default branch, records it, and lets a task branch through", { skip: !posix && 'POSIX hooks' }, () => {
  const c = checkout();
  const before = c.main();
  // As checkout.sh installs it: the CLI's git-hooks step, in a repo with no config yet (the hook goes by origin/HEAD).
  const inst = spawnSync(process.execPath, [engineCli, 'install', '--root', c.repo, '--git-hooks-only'], { cwd: c.repo, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  const hook = join(c.repo, '.git', 'hooks', 'pre-push');
  assert.ok(readFileSync(hook, 'utf8').includes(PRE_PUSH_MARKER));
  for (const spec of ['HEAD:main', 'HEAD:refs/heads/main', '+HEAD:main']) {
    const r = push(c, spec);
    assert.notEqual(r.status, 0, `${spec} is refused`);
    assert.match(r.stderr, /refusing to push refs\/heads\/main, the default branch/);
  }
  assert.equal(c.main(), before, 'main never moved');
  const ev = blocked(c.stateDir);
  assert.equal(ev.length, 3, 'each refusal is a push.blocked event');
  assert.deepEqual(ev[0], { ref: 'refs/heads/main', head: c.head, via: 'hook' });
  const ok = push(c, `HEAD:refs/heads/${BRAND.cli}/issue-1`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(git(c.remote, 'rev-parse', `${BRAND.cli}/issue-1`), c.head);
});

test("the hook also refuses whatever origin/HEAD names, when the config's branch is unknown", { skip: !posix && 'POSIX hooks' }, () => {
  const c = checkout();
  installCheckoutPrePush(c.repo, [], engineCli);
  assert.notEqual(push(c, 'HEAD:main').status, 0);
  assert.equal(push(c, 'HEAD:refs/heads/feature').status, 0);
});

test("a hook that was there is kept and still runs after ours", { skip: !posix && 'POSIX hooks' }, () => {
  const c = checkout();
  const hooks = join(c.repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho "theirs ran: $(cat)" >&2\nexit 0\n', { mode: 0o755 });
  installCheckoutPrePush(c.repo, ['main'], engineCli);
  const r = push(c, 'HEAD:refs/heads/feature');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /theirs ran: HEAD [0-9a-f]{40} refs\/heads\/feature 0{40}/, 'with the same input');
});

test("the coordinator's own hooks dir refuses the default branch (pr mode), is its user's only, and is what its git runs", { skip: !posix && 'POSIX hooks' }, () => {
  const c = checkout();
  const home = join(c.base, 'home');
  mkdirSync(home);
  const dir = writeCoordinatorHooks(home, { defaultBranch: 'main', directLand: false, node: process.execPath, engine: engineCli });
  assert.equal(dir, coordinatorHooksDir(home));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'pre-push')).mode & 0o777, 0o700);
  const r = push(c, 'HEAD:main', ['-c', `core.hooksPath=${dir}`]);
  assert.notEqual(r.status, 0, 'refused');
  assert.equal(push(c, 'HEAD:refs/heads/task', ['-c', `core.hooksPath=${dir}`]).status, 0);
  // Its git environment points core.hooksPath at that dir, never the checkout's hooks.
  const env = instanceEnv({ name: 'shop', home, stateDir: join(home, 'state'), credentials: { github: { kind: 'gh-config-dir', path: join(home, 'gh') } } } as unknown as Instance, {});
  const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]);
  assert.deepEqual(keys.find(([k]) => k === 'core.hooksPath'), ['core.hooksPath', dir]);
  // land_mode direct lands by pushing main: no hook there.
  writeCoordinatorHooks(home, { defaultBranch: 'main', directLand: true });
  assert.ok(!existsSync(join(dir, 'pre-push')));
});

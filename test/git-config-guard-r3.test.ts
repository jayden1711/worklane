// #926 round 3.
// - checkout.sh's own config check is the engine's (one parser, configRefusal, through the CLI): its shell parser
//   (a336bf6b) lost a refused key after a value holding a 0x02 byte, and one whose subsection held 0x01 (measured by
//   the review). Both are refused now.
// - Auto-config's commit and push still run the checkout's own hooks (the gitleaks pre-commit, the pre-push refusal of
//   the default branch), also on a first install, when the coordinator's hooks dir doesn't exist yet: round 2 pointed
//   core.hooksPath there, so neither ran (a check lost without the owner's OK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { gitSpawnSync } from '../src/os/git.js';
import { createWorktree, worktreeOptions } from '../src/worktrees.js';
import { installGitHook } from '../src/install.js';
import { installPrePushHook } from '../src/push-guard.js';
import * as autoConfig from '../src/server-auto-config.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const MARK = `${BRAND.envPrefix}_GIT_GUARD`;
const plainEnv = () => {
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  delete e[MARK];
  return e;
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: plainEnv() }).trim();
const commit = (cwd: string, msg: string) => git(cwd, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg);

async function marked<T>(mark: string, f: () => T | Promise<T>): Promise<T> {
  const before = process.env[MARK];
  process.env[MARK] = mark;
  try {
    return await f();
  } finally {
    if (before === undefined) delete process.env[MARK];
    else process.env[MARK] = before;
  }
}

/** A bare origin and the instance's checkout cloned from it. */
function checkout() {
  const base = mkdtempSync(join(tmpdir(), 'git-guard-r3-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(base, 'checkout');
  git(base, 'clone', '-q', origin, repo);
  commit(repo, 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  return { base, origin, repo };
}

/** checkout.sh's first run_as section, run on an existing checkout, with the engine's CLI as `worklane` for its config check. */
function checkoutSection(dest: string) {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'checkout.sh'), 'utf8');
  const section = [...sh.matchAll(/run_as "\$coord" '\n([\s\S]*?)\n\s*' /g)].map((x) => x[1]!)[0]!;
  const cli = join(repoRoot, 'dist', 'src', 'cli.js');
  const stub = `worklane() { if [ "$1" = git-config-check ]; then "${process.execPath}" "${cli}" "$@"; fi; }\n`;
  // A proxy that answers nothing: no request leaves the machine.
  const env = { ...plainEnv(), GIT_TERMINAL_PROMPT: '0', https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  return () => execFileSync('bash', ['-c', `set -euo pipefail\n${stub}${section}`, '_', 'alpha', dest, 'example/alpha'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

const FIXTURES: Record<string, (repo: string) => void> = {
  // A value holding 0x02, then a filter: a parser that splits on 0x02 reads every later key as a scope.
  'a value holding 0x02 before a filter': (repo) => {
    git(repo, 'config', 'x.y', 'a\u0002b');
    git(repo, 'config', 'filter.c.smudge', 'planted-cmd');
  },
  // A subsection holding 0x01: a parser that splits on 0x01 never sees the key whole.
  'a filter whose subsection holds 0x01': (repo) => git(repo, 'config', 'filter.a\u0001b.smudge', 'planted-cmd'),
};

for (const [name, plant] of Object.entries(FIXTURES)) {
  test(`#926 round 3: checkout.sh refuses its pull on ${name} (the engine's own config check)`, { skip: process.platform === 'win32' && 'bash' }, () => {
    const c = checkout();
    const run = checkoutSection(c.repo);
    plant(c.repo);
    assert.throws(run, (e: Error & { stderr?: string }) => /refusing to run git in .*filter\..*\.smudge/s.test(String(e.stderr ?? e.message)), 'checkout.sh went on to its pull');
  });
}

test('#926 round 3: checkout.sh runs on a checkout whose config is clean (system and global config read as git does)', { skip: process.platform === 'win32' && 'bash' }, () => {
  const c = checkout();
  const out = checkoutSection(c.repo)();
  assert.match(out, /checkout at [0-9a-f]+ \(init\)/);
});

test('#926 round 3: the engine check reads the listing whole: a key after a value with control bytes, or with them in its name, is refused', () => {
  const c = checkout();
  const cli = join(repoRoot, 'dist', 'src', 'cli.js');
  for (const plant of Object.values(FIXTURES)) {
    const d = checkout();
    plant(d.repo);
    assert.throws(() => execFileSync(process.execPath, [cli, 'git-config-check', d.repo], { encoding: 'utf8', env: plainEnv(), stdio: ['ignore', 'pipe', 'pipe'] }), /filter\..*\.smudge/s);
  }
  assert.equal(execFileSync(process.execPath, [cli, 'git-config-check', c.repo], { encoding: 'utf8', env: plainEnv(), stdio: ['ignore', 'pipe', 'pipe'] }), '');
});

// ---- Auto-config's commit and push keep the checkout's own hooks, on a first install too ----

const skipLeaks = !which('gitleaks') && 'gitleaks not installed';

test("#926 round 3: on a first install (no coordinator hooks dir yet), auto-config's commit with a secret is refused by the checkout's gitleaks pre-commit, and its push to the default branch by the pre-push hook", { skip: skipLeaks }, async () => {
  const c = checkout();
  // As checkout.sh's `install --git-hooks-only` leaves the checkout: the gitleaks pre-commit and the pre-push refusal.
  installGitHook(c.repo);
  installPrePushHook(join(c.repo, '.git', 'hooks'), { branches: ['main'] });
  const home = join(c.base, 'home');
  mkdirSync(home);
  const fn = (autoConfig as Record<string, unknown>).autoConfigGitEnv as (name: string, repo: string, home: string) => Record<string, string>;
  const own = fn('alpha', c.repo, home);
  assert.equal(existsSync(join(home, 'git-hooks')), false, 'a first install: no coordinator hooks dir');
  const { path: wt } = createWorktree(worktreeOptions({ repo: c.repo, root: '../wt', stateDir: join(c.base, 'state'), setup: [], taskDir: null }), 'setup', `${BRAND.cli}/setup`, 'main');
  const token = 'ghp_' + [...randomBytes(36)].map((b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
  writeFileSync(join(wt, 'settings.js'), `export const token = '${token}';\n`);
  const env = { ...process.env, ...own };
  const r = await marked(own[MARK]!, () => {
    const add = gitSpawnSync(['add', '-A'], { cwd: wt, encoding: 'utf8', env });
    const cm = gitSpawnSync(['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '-m', 'setup'], { cwd: wt, encoding: 'utf8', env });
    gitSpawnSync(['reset', '-q'], { cwd: wt, encoding: 'utf8', env });
    const clean = gitSpawnSync(['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'clean'], { cwd: wt, encoding: 'utf8', env });
    const push = gitSpawnSync(['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: wt, encoding: 'utf8', env });
    return { add, cm, clean, push };
  });
  assert.equal(r.add.status, 0, r.add.stderr);
  assert.notEqual(r.cm.status, 0, "the secret went into auto-config's commit");
  assert.equal(r.clean.status, 0, r.clean.stderr);
  assert.notEqual(r.push.status, 0, "auto-config's push reached the default branch");
  assert.notEqual(git(c.origin, 'rev-parse', 'main'), git(wt, 'rev-parse', 'HEAD'), 'origin main is not the setup commit');
});

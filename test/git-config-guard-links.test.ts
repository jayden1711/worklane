// #926 round 2. Two routes the config read alone didn't close, and one thing it broke:
// - an agent rewrites its worktree's links (`.git/worktrees/<id>/commondir`, or the worktree's own `.git` file) to a
//   common dir it made, with its own config (remote.origin.url) and hooks: the guarded git pushed to the agent's
//   remote, and in auto-config ran the agent's pre-commit and pre-push (measured on fc552f5d by the review). A marked
//   git in a worktree is now pinned to the engine-known common dir, and refused when a link doesn't point there;
// - auto-config runs with the checkout's own hooks dir by its absolute path at command scope (round 3), never one a
//   rewritten link names;
// - a system-level url.insteadOf (how a machine, or CI, routes github.com) still routes the coordinator's clone and
//   its guarded fetch: system config is root's, not an agent's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { gitSpawnSync } from '../src/os/git.js';
import { createWorktree, worktreeOptions } from '../src/worktrees.js';
import { instanceEnv } from '../src/service.js';
import * as autoConfig from '../src/server-auto-config.js';
import type { Instance } from '../src/instance.js';
import { repoRoot } from './helpers.js';

const MARK = `${BRAND.envPrefix}_GIT_GUARD`;
const plainEnv = () => {
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  delete e[MARK];
  return e;
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: plainEnv() }).trim();
const commit = (cwd: string, msg: string) => git(cwd, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg);

/** Runs `f` with this process marked as `mark` (what instanceEnv sets), taken off after. */
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

/**
 * origin (bare); the instance's checkout; a worktree the engine made (createWorktree); an agent's bare repo; and an
 * agent-made common dir: the checkout's objects/refs/logs/worktrees linked in, but its own config (origin is the agent's
 * repo) and hooks that record running.
 */
function layout() {
  const base = mkdtempSync(join(tmpdir(), 'git-guard-links-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(base, 'checkout');
  git(base, 'clone', '-q', origin, repo);
  commit(repo, 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  const home = join(base, 'home');
  mkdirSync(home);
  const i = { name: 'shop', home, stateDir: join(home, 'state'), repo: { path: repo, repo: 'example/shop' }, credentials: { github: { kind: 'gh-config-dir', path: join(home, 'gh') } } } as unknown as Instance;
  const env = instanceEnv(i, { PATH: process.env.PATH });
  const { path: wt } = createWorktree(worktreeOptions({ repo, root: '../wt', stateDir: join(base, 'state'), setup: [], taskDir: null }), 'w1', `${BRAND.cli}/w1`, 'main');
  const id = readFileSync(join(wt, '.git'), 'utf8').trim().split('/').pop()!;
  const agentRepo = join(base, 'agent.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', agentRepo);
  const fake = join(base, 'fake-common');
  mkdirSync(join(fake, 'hooks'), { recursive: true });
  for (const d of ['objects', 'refs', 'logs', 'worktrees']) symlinkSync(join(repo, '.git', d), join(fake, d));
  writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(fake, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = ${agentRepo}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  for (const h of ['pre-commit', 'pre-push']) {
    writeFileSync(join(fake, 'hooks', h), `#!/bin/sh\ntouch "${base}/RAN-${h}"\nexit 0\n`);
    chmodSync(join(fake, 'hooks', h), 0o755);
  }
  const ran = (h: string) => existsSync(join(base, `RAN-${h}`));
  const reachedAgent = () => git(agentRepo, 'for-each-ref', '--format=%(refname)') !== '';
  return { base, origin, repo, wt, id, fake, agentRepo, env, mark: env[MARK]!, ran, reachedAgent, home };
}

/** The two links an agent can rewrite, each pointed at its own common dir. */
const ROUTES: Record<string, (l: ReturnType<typeof layout>) => void> = {
  commondir: (l) => writeFileSync(join(l.repo, '.git', 'worktrees', l.id, 'commondir'), `${l.fake}\n`),
  'worktree .git link': (l) => {
    const admin = join(l.base, 'fake-admin');
    execFileSync('cp', ['-r', join(l.repo, '.git', 'worktrees', l.id), admin]);
    writeFileSync(join(admin, 'commondir'), `${l.fake}\n`);
    writeFileSync(join(l.wt, '.git'), `gitdir: ${admin}\n`);
  },
};

for (const [route, plant] of Object.entries(ROUTES)) {
  test(`#926 round 2, coordinator: a rewritten ${route} never sends the coordinator's push to the agent's remote`, async () => {
    const l = layout();
    plant(l);
    const r = await marked(l.mark, () => gitSpawnSync(['push', '-q', 'origin', 'HEAD:refs/heads/landed'], { cwd: l.wt, encoding: 'utf8', env: l.env }));
    assert.equal(l.reachedAgent(), false, `the push went to the agent's repo through the ${route}`);
    assert.notEqual(r.status, 0, 'the push went ahead');
    assert.match(r.stderr, /refusing to run git/);
  });

  test(`#926 round 2, auto-config: a rewritten ${route} never runs the agent's hooks, nor pushes to its remote`, async () => {
    const l = layout();
    plant(l);
    // What serverAutoConfig sets for its run (on fc552f5d: the mark alone).
    const own = typeof (autoConfig as Record<string, unknown>).autoConfigGitEnv === 'function'
      ? (autoConfig as unknown as { autoConfigGitEnv: (name: string, repo: string, home: string) => Record<string, string> }).autoConfigGitEnv('shop', l.repo, l.home)
      : { [MARK]: '1' };
    const env = { ...process.env, ...own };
    const r = await marked(own[MARK]!, () => {
      const c = gitSpawnSync(['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'setup'], { cwd: l.wt, encoding: 'utf8', env });
      const p = gitSpawnSync(['push', '-q', 'origin', 'HEAD:refs/heads/setup'], { cwd: l.wt, encoding: 'utf8', env });
      return { c, p };
    });
    assert.equal(l.ran('pre-commit'), false, "the agent's pre-commit ran");
    assert.equal(l.ran('pre-push'), false, "the agent's pre-push ran");
    assert.equal(l.reachedAgent(), false, "the push went to the agent's repo");
    assert.match(r.c.stderr + r.p.stderr, /refusing to run git/);
  });
}

test("#926: auto-config runs git with the checkout's own hooks dir by its absolute path at command scope, never one a link names", () => {
  const fn = (autoConfig as Record<string, unknown>).autoConfigGitEnv as ((name: string, repo: string, home: string) => Record<string, string>) | undefined;
  assert.equal(typeof fn, 'function', 'serverAutoConfig names the git environment it runs with');
  const env = fn!('shop', '/srv/x/shop', '/var/lib/wl-shop');
  const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]);
  const hooks = pairs.filter(([k]) => k === 'core.hooksPath');
  assert.equal(hooks.length, 1);
  // Round 3: the checkout's own hooks (gitleaks pre-commit, the default-branch pre-push), as before #926.
  assert.equal(hooks[0]![1], join('/srv/x/shop', '.git', 'hooks'));
  assert.equal(env[MARK], '/srv/x/shop', 'the mark names the checkout the links are checked against');
});

test('#926 round 2: an engine-made worktree, unchanged, still works as the coordinator (commit and push to origin)', async () => {
  const l = layout();
  const r = await marked(l.mark, () => {
    const c = gitSpawnSync(['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: l.wt, encoding: 'utf8', env: l.env });
    const p = gitSpawnSync(['push', '-q', 'origin', 'HEAD:refs/heads/landed'], { cwd: l.wt, encoding: 'utf8', env: l.env });
    return { c, p };
  });
  assert.equal(r.c.status, 0, r.c.stderr);
  assert.equal(r.p.status, 0, r.p.stderr);
  assert.notEqual(git(l.origin, 'for-each-ref', 'refs/heads/landed'), '');
});

// ---- A system-level url.insteadOf (root's /etc/gitconfig, here GIT_CONFIG_SYSTEM) still routes github.com ----

/** `worklane` in checkout.sh's section: the built engine for its config check, nothing for the rest. */
const ENGINE_STUB = `worklane() { if [ "$1" = git-config-check ]; then "${process.execPath}" "${join(repoRoot, 'dist', 'src', 'cli.js')}" "$@"; fi; }\n`;

function mirror() {
  const base = mkdtempSync(join(tmpdir(), 'git-guard-mirror-'));
  const bare = join(base, 'gh', 'example', 'alpha.git');
  mkdirSync(join(base, 'gh', 'example'), { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'init');
  git(seed, 'push', '-q', bare, 'main');
  const system = join(base, 'gitconfig');
  writeFileSync(system, `[url "${join(base, 'gh', 'example', 'alpha')}"]\n\tinsteadOf = https://github.com/example/alpha\n`);
  // The system file named by GIT_CONFIG_SYSTEM, as /etc/gitconfig is read: no NOSYSTEM, no global of the runner's.
  // A proxy that answers nothing: a request the rewrite didn't route fails here, never reaching github.com.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(base, 'home'), GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' };
  delete env.GIT_CONFIG_NOSYSTEM;
  delete env[MARK];
  return { base, bare, env };
}

test("#926 round 2: checkout.sh's clone follows a system-level url.insteadOf (CI's fake GitHub, a machine's mirror)", { skip: process.platform === 'win32' && 'bash' }, () => {
  const m = mirror();
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'checkout.sh'), 'utf8');
  const sections = [...sh.matchAll(/run_as "\$coord" '\n([\s\S]*?)\n\s*' /g)].map((x) => x[1]!);
  const dest = join(m.base, 'srv', 'alpha');
  mkdirSync(join(m.base, 'srv'));
  const r = execFileSync('bash', ['-c', `set -euo pipefail\n${ENGINE_STUB}${sections[0]}`, '_', 'alpha', dest, 'example/alpha'], { encoding: 'utf8', env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(r, /checkout at [0-9a-f]+ \(init\)/);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), git(m.bare, 'rev-parse', 'main'));
});

test("#926 round 2: checkout.sh's own check refuses a planted key in the checkout's config, whatever its subsection holds", { skip: process.platform === 'win32' && 'bash' }, () => {
  const m = mirror();
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'checkout.sh'), 'utf8');
  const section = [...sh.matchAll(/run_as "\$coord" '\n([\s\S]*?)\n\s*' /g)].map((x) => x[1]!)[0]!;
  const dest = join(m.base, 'srv', 'alpha');
  mkdirSync(join(m.base, 'srv'));
  const run = () => execFileSync('bash', ['-c', `set -euo pipefail\n${ENGINE_STUB}${section}`, '_', 'alpha', dest, 'example/alpha'], { encoding: 'utf8', env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
  run();
  // A subsection with "=" and a space in it: the key is read whole, never cut at either.
  git(dest, 'config', 'url.https://evil.example/a=b c.insteadOf', 'https://github.com/example/alpha');
  assert.throws(run, /refusing to run git in .*url\.https:\/\/evil\.example\/a=b c\.insteadof/);
  git(dest, 'config', '--remove-section', 'url.https://evil.example/a=b c');
  git(dest, 'config', 'filter.x.smudge', 'touch planted');
  assert.throws(run, /refusing to run git in .*filter\.x\.smudge/);
});

test("#926 round 2: a guarded fetch follows a system-level url.insteadOf, and still refuses one in the checkout's own config", async () => {
  const m = mirror();
  const repo = join(m.base, 'checkout');
  execFileSync('git', ['clone', '-q', 'https://github.com/example/alpha', repo], { env: m.env });
  // The mark instanceEnv sets for an instance with this checkout.
  const home = join(m.base, 'home');
  const mark = instanceEnv({ name: 'alpha', home, stateDir: join(home, 'state'), repo: { path: repo, repo: 'example/alpha' }, credentials: { github: { kind: 'gh-config-dir', path: join(home, 'gh') } } } as unknown as Instance, {})[MARK]!;
  const ok = await marked(mark, () => gitSpawnSync(['fetch', '-q', 'origin'], { cwd: repo, encoding: 'utf8', env: m.env }));
  assert.equal(ok.status, 0, ok.stderr);
  git(repo, 'config', `url.${m.bare}.insteadOf`, 'https://github.com/example/other');
  const no = await marked(mark, () => gitSpawnSync(['fetch', '-q', 'origin'], { cwd: repo, encoding: 'utf8', env: m.env }));
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /refusing to run git.*insteadof/);
});

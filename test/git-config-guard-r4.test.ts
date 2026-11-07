// #926 round 4.
// - A git that makes a new repo (init, clone) is judged on the repo it makes, never the caller's cwd: in CI the test
//   process's cwd is actions/checkout's clone, whose config sets http.<url>.extraheader (a refused key), and #927's
//   gitSnapshot runs `git init` with no cwd, so every snapshot (and the scan, and the landing) was refused there.
// - checkout.sh says to update the engine when the installed one has no git-config-check.
// - A refusal shows a key's control bytes escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { configRefusal, gitExecFileSync, gitSnapshot, gitSpawnSync } from '../src/os/git.js';
import { repoRoot } from './helpers.js';

const MARK = `${BRAND.envPrefix}_GIT_GUARD`;
const plainEnv = () => {
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  delete e[MARK];
  return e;
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: plainEnv() }).trim();

/** Runs `f` marked as `mark`'s instance, with this process's cwd in `cwd`; both put back after. */
async function markedIn<T>(mark: string, cwd: string, f: () => T | Promise<T>): Promise<T> {
  const before = process.env[MARK];
  const was = process.cwd();
  process.env[MARK] = mark;
  process.chdir(cwd);
  try {
    return await f();
  } finally {
    process.chdir(was);
    if (before === undefined) delete process.env[MARK];
    else process.env[MARK] = before;
  }
}

test("#926 round 4: init, clone and a snapshot run as an instance's from a cwd whose repo config sets a refused key (CI's checkout)", async () => {
  const base = mkdtempSync(join(tmpdir(), 'git-guard-r4-'));
  // What actions/checkout leaves: a repo whose own config carries an http extraheader.
  const ci = join(base, 'ci');
  git(base, 'init', '-q', '-b', 'main', ci);
  git(ci, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic eA==');
  // The instance's checkout, elsewhere.
  const repo = join(base, 'checkout');
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  const out = await markedIn(repo, ci, () => {
    const r: Record<string, string> = {};
    try {
      const snap = gitSnapshot(repo);
      snap.dispose();
      r.snapshot = 'ok';
    } catch (e) {
      r.snapshot = String((e as Error).message);
    }
    try {
      gitExecFileSync(['init', '-q', '--bare', join(base, 'made.git')], { stdio: ['ignore', 'pipe', 'pipe'] });
      r.init = 'ok';
    } catch (e) {
      r.init = String((e as { stderr?: unknown }).stderr ?? (e as Error).message);
    }
    const c = gitSpawnSync(['clone', '-q', repo, join(base, 'cloned')], { encoding: 'utf8' });
    r.clone = c.status === 0 ? 'ok' : c.stderr;
    // The caller's own repo is still judged when the git runs in it.
    const own = gitSpawnSync(['status', '--porcelain'], { encoding: 'utf8' });
    r.own = own.status === 0 ? 'ran' : own.stderr;
    return r;
  });
  assert.equal(out.snapshot, 'ok');
  assert.equal(out.init, 'ok');
  assert.equal(out.clone, 'ok');
  assert.match(out.own!, /refusing to run git.*extraheader/, 'a git in the cwd repo itself is still refused for its config');
});

test('#926 round 4: checkout.sh tells the operator to update an engine that has no git-config-check', { skip: process.platform === 'win32' && 'bash' }, () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'checkout.sh'), 'utf8');
  const section = [...sh.matchAll(/run_as "\$coord" '\n([\s\S]*?)\n\s*' /g)].map((x) => x[1]!)[0]!;
  const base = mkdtempSync(join(tmpdir(), 'git-guard-r4-sh-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const dest = join(base, 'checkout');
  git(base, 'clone', '-q', origin, dest);
  // An engine from before #926: no such command.
  const stub = 'worklane() { echo "unknown command: $1" >&2; echo "usage..." >&2; return 2; }\n';
  const r = (() => {
    try {
      execFileSync('bash', ['-c', `set -euo pipefail\n${stub}${section}`, '_', 'alpha', dest, 'example/alpha'], { encoding: 'utf8', env: plainEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      return 'ran';
    } catch (e) {
      return String((e as { stderr?: unknown }).stderr);
    }
  })();
  assert.match(r, /update the engine/);
});

test('#926 round 4: a refusal shows control bytes in a key escaped, never raw', () => {
  const why = configRefusal(`local\0file:.git/config\0filter.a\u001b[2Kb.smudge\nx\0`) ?? '';
  assert.match(why, /filter\.a\\x1b\[2kb\.smudge/i);
  assert.doesNotMatch(why, /\u001b/);
});

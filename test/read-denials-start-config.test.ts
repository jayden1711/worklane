// #890 round 8, the coordinator's decision on a default branch with no config: a first hour (origin has no config
// folder yet, so the coordinator started with its checkout's) must not refuse every run. The secret_paths of the config
// the coordinator itself started with stand in, passed by the service like the branch, never re-read from a path an
// agent can write. Without them, or when the branch's config is there but invalid, the run doesn't start.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';

const skip = process.platform !== 'linux' && "sandbox-runtime's Linux read-deny rules, where CI runs";
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Does the sandbox these denyRead entries describe hide `target`? Resolved as sandbox-runtime resolves them (Linux). */
async function hides(entries: string[], target: string): Promise<boolean> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const mounts: string[] = [];
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) mounts.push(...(glob.expandReadDenyGlobLinux(e, [], new Set()) as string[]));
    else if (existsSync(stripped)) mounts.push(real(stripped));
  }
  return mounts.some((m) => utils.isAtOrUnder(real(target), m));
}

const git = (cwd: string, args: string[], input?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

/** The example project with its secrets untracked and its working-tree secret_paths emptied. */
function fixture() {
  const { dir } = exampleProject();
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  writeFileSync(join(dir, '.env.local'), 'TOKEN=local\n');
  const g = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace(/^secret_paths:\n(?: {2}- .*\n)+/m, 'secret_paths: []\n'));
  return dir;
}

const START = ['./.env', './.env.*', '!./.env.example'];

test('#890: origin\'s default branch has no config folder yet: the coordinator\'s start config stands in; without it the run is refused', { skip }, async () => {
  const dir = fixture();
  // origin/main is a commit with nothing in it: no config folder, as before a first PR lands.
  const empty = git(dir, ['mktree'], '');
  git(dir, ['update-ref', 'refs/remotes/origin/main', git(dir, ['commit-tree', empty, '-m', 'empty'])]);
  const r = runReadDenials({ cwd: dir, home: '/h', defaultBranch: 'main', startSecrets: START });
  assert.ok(!('error' in r), JSON.stringify(r));
  for (const t of [join(dir, '.env'), join(dir, '.env.local')]) assert.ok(await hides(r.paths, t), `${t} hidden: ${JSON.stringify(r.paths)}`);
  assert.equal(await hides(r.paths, join(dir, 'README.md')), false);
  // The coordinator started with the default branch's own config (no start secrets given): its going missing refuses.
  const refused = runReadDenials({ cwd: dir, home: '/h', defaultBranch: 'main' });
  assert.ok('error' in refused && /default branch/.test(refused.error), JSON.stringify(refused));
});

test('#890: the default branch\'s config is there but invalid: refused, start config or not', { skip }, () => {
  const dir = fixture();
  const side = join(dir, '.claude', 'worktrees', 'side');
  git(dir, ['worktree', 'add', '-q', '-b', 'side', side, 'HEAD']);
  writeFileSync(join(side, '.worklane', 'guardrails.yaml'), 'secret_paths: 7\n');
  git(side, ['commit', '-q', '-am', 'broken guardrails']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', git(side, ['rev-parse', 'HEAD'])]);
  for (const startSecrets of [START, undefined]) {
    const r = runReadDenials({ cwd: dir, home: '/h', defaultBranch: 'main', ...(startSecrets ? { startSecrets } : {}) });
    assert.ok('error' in r && /default branch/.test(r.error), JSON.stringify(r));
  }
});

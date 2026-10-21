// #890, second adversarial review round 6: an exception ("!…") in one source never subtracts from another. Each
// config's secret_paths are evaluated against that config's own exceptions only, then the results are unioned; the
// task's hidden paths take no exception from any config. So an agent that adds "!/**", "!./.env" or "!evals/**" to its
// worktree's guardrails (or a commit that brings one to the default branch) drops nothing the main checkout's config
// or the task denies. Each entry is checked with sandbox-runtime's own read-deny expansion.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';

const skip = process.platform !== 'linux' && "sandbox-runtime's Linux read-deny rules, where CI runs";
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

function task(hidden: string[]) {
  const f = join(mkdtempSync(join(tmpdir(), 'task-')), 't.json');
  writeFileSync(f, JSON.stringify({ id: 't', done_when: [{ manual: 'x' }], hidden }));
  return f;
}

const paths = (r: ReturnType<typeof runReadDenials>) => {
  if ('error' in r) assert.fail(r.error);
  return r.paths;
};

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

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Exceptions added at the top of `dir`'s secret_paths, as an uncommitted edit an agent could make. */
function addExceptions(dir: string, negs: string[]) {
  const f = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^secret_paths:\n/m, `secret_paths:\n${negs.map((n) => `  - ${JSON.stringify(n)}\n`).join('')}`));
}

/** The example project with its scorer committed and its secrets untracked in the main checkout. */
function fixture() {
  const { dir } = exampleProject();
  mkdirSync(join(dir, 'evals-secret'));
  writeFileSync(join(dir, 'evals-secret', 'score.py'), 'SECRET_SCORER = 1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'eval');
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  writeFileSync(join(dir, '.env.local'), 'TOKEN=local\n');
  return dir;
}

const HIDDEN = ['evals-secret/**'];

for (const negs of [['!/**'], ['!./.env', '!./.env.*'], ['!evals-secret/**']]) {
  test(`#890: exceptions ${JSON.stringify(negs)} in the worktree's own config drop nothing the main checkout's config or the task denies`, { skip }, async () => {
    const dir = fixture();
    const wt = join(dir, '.claude', 'worktrees', 'exp');
    git(dir, 'worktree', 'add', '-q', '-b', 'exp', wt, 'HEAD');
    addExceptions(wt, negs);
    const p = paths(runReadDenials({ cwd: wt, home: '/h', taskFile: task(HIDDEN) }));
    for (const t of [join(dir, '.env'), join(dir, '.env.local'), join(dir, 'evals-secret', 'score.py'), join(wt, 'evals-secret', 'score.py')]) {
      assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
    }
  });
}

test('#890: an exception that arrives through the default branch\'s committed config drops nothing either', { skip }, async () => {
  const dir = fixture();
  // A commit on another branch whose config excepts everything, made the default branch's remote ref.
  const side = join(dir, '.claude', 'worktrees', 'side');
  git(dir, 'worktree', 'add', '-q', '-b', 'side', side, 'HEAD');
  addExceptions(side, ['!/**']);
  git(side, 'commit', '-q', '-am', 'except everything');
  git(dir, 'update-ref', 'refs/remotes/origin/main', git(side, 'rev-parse', 'HEAD'));
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(HIDDEN) }));
  for (const t of [join(dir, '.env'), join(dir, '.env.local'), join(dir, 'evals-secret', 'score.py')]) {
    assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
  }
});

// #890, second adversarial review at 48d425fa: where the run's denials come from, and where hidden content survives.
// - The project root is found as the hook finds it (a symlinked config folder counts), and a guarded run with none
//   doesn't start: the hook would deny its every call.
// - secret_paths are the union of the run's own checkout's (which its agent can write), the main checkout's and the
//   default branch's committed config: emptying them in a worktree drops nothing.
// - A run that hides anything is denied its whole common git directory (rerere's preimages, rebase patches and the
//   like hold hidden text too), the real targets of links out of its stores, and a custom lfs.storage.
// - Overlapped patterns are listed at the start in every checkout under a worktree parent, a pruned one among them.
// Each entry is checked with sandbox-runtime's own read-deny expansion (the library Claude Code's sandbox is built on).
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** The example project's guardrails in `dir` with secret_paths emptied (an uncommitted edit, as an agent would make). */
function emptySecrets(dir: string) {
  const f = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^secret_paths:\n(?: {2}- .*\n)+/m, 'secret_paths: []\n'));
}

test('#890: a config folder that is a symlink is the project root, as the hook finds it', { skip }, async () => {
  const { dir } = exampleProject();
  const moved = join(dirname(dir), 'config-elsewhere');
  renameSync(join(dir, '.worklane'), moved);
  symlinkSync(moved, join(dir, '.worklane'));
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  const p = paths(runReadDenials({ cwd: dir, home: '/h' }));
  assert.ok(await hides(p, join(dir, '.env')), JSON.stringify(p));
});

test('#890: a guarded run with no project root doesn\'t start: the hook would deny its every call', { skip }, () => {
  const r = runReadDenials({ cwd: mkdtempSync(join(tmpdir(), 'bare-')), home: '/h' });
  assert.ok('error' in r && /no \S+ folder|project root/.test(r.error), JSON.stringify(r));
});

test('#890: a worktree whose secret_paths were emptied still denies them: the main checkout\'s and the default branch\'s config count too', { skip }, async () => {
  const { dir } = exampleProject();
  writeFileSync(join(dir, '.env'), 'TOKEN=main\n');
  const wt = join(dir, '.claude', 'worktrees', 'exp');
  git(dir, 'worktree', 'add', '-q', '-b', 'exp', wt, 'HEAD');
  writeFileSync(join(wt, '.env'), 'TOKEN=wt\n');
  emptySecrets(wt);
  const p = paths(runReadDenials({ cwd: wt, home: '/h' }));
  for (const t of [join(dir, '.env'), join(wt, '.env')]) assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
  // The main checkout's working tree emptied too: the default branch's committed config still counts.
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  emptySecrets(dir);
  const q = paths(runReadDenials({ cwd: wt, home: '/h' }));
  for (const t of [join(dir, '.env'), join(wt, '.env')]) assert.ok(await hides(q, t), `${t} hidden with only the default branch's config: ${JSON.stringify(q)}`);
});

test('#890: a run that hides anything is denied the whole common git directory: rerere\'s preimages hold hidden text', { skip }, async () => {
  const { dir } = exampleProject();
  const pre = join(dir, '.git', 'rr-cache', 'abc123');
  mkdirSync(pre, { recursive: true });
  writeFileSync(join(pre, 'preimage'), 'SECRET_SCORER = 1\n');
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  assert.ok(await hides(p, join(pre, 'preimage')), JSON.stringify(p));
});

test('#890: a store\'s pack directory linked out of the git directory: its real place is denied', { skip }, async () => {
  const { dir } = exampleProject();
  git(dir, 'gc', '-q');
  const away = join(dirname(dir), 'packs-on-another-disk');
  renameSync(join(dir, '.git', 'objects', 'pack'), away);
  symlinkSync(away, join(dir, '.git', 'objects', 'pack'));
  const pack = readdirSync(away).find((n) => n.endsWith('.pack'))!;
  assert.ok(pack, 'precondition: gc wrote a pack');
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  assert.ok(await hides(p, join(away, pack)), JSON.stringify(p));
});

test('#890: lfs.storage set outside the git directory is denied', { skip }, async () => {
  const { dir } = exampleProject();
  const lfs = join(dirname(dir), 'lfs-store');
  mkdirSync(join(lfs, 'objects', 'ab'), { recursive: true });
  writeFileSync(join(lfs, 'objects', 'ab', 'cd'), 'SECRET_SCORER = 1\n');
  git(dir, 'config', 'lfs.storage', lfs);
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  assert.ok(await hides(p, join(lfs, 'objects', 'ab', 'cd')), JSON.stringify(p));
});

test('#890: a checkout under the worktree root that git no longer lists still gets its overlapped matches denied', { skip }, async () => {
  const { dir } = exampleProject();
  const orphan = join(dir, '.claude', 'worktrees', 'orphan');
  mkdirSync(orphan, { recursive: true });
  for (const n of ['.env', '.env.local', '.env.example']) writeFileSync(join(orphan, n), 'x\n');
  const p = paths(runReadDenials({ cwd: dir, home: '/h' }));
  for (const n of ['.env', '.env.local']) assert.ok(await hides(p, join(orphan, n)), `${n} hidden: ${JSON.stringify(p)}`);
  assert.equal(await hides(p, join(orphan, '.env.example')), false, 'the exception stays readable');
});

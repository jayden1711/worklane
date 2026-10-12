// A test run's workspace: a git clone of its own, made fresh for each run from a bundle of the coordinator's
// objects (a copy, never shared alternates or the coordinator's .git, which the test user can't read), with the
// commit checked out and the default branch as `main`-style refs (refs/heads/<branch> and
// refs/remotes/origin/<branch>), so suites that call git (log, diff against main, lfs, merge-base) work as on CI.
// It has no remote URL, no credential helper, hooks off, and nothing of the coordinator's .git/config. It is
// wiped with everything else of the run.
import { execFileSync, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { BRAND } from '../brand.js';
import { safeProjectEnv } from '../project-env.js';
import type { RunDatabase, RunHost } from './host.js';

const git = (repo: string, ...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();

/** The default branch's name and commit in the coordinator's clone: origin/HEAD, else origin/main, else main. */
export function defaultBranch(repo: string): { name: string; sha: string } | null {
  try {
    const ref = git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD');
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    return { name, sha: git(repo, 'rev-parse', `${ref}^{commit}`) };
  } catch {
    // no origin/HEAD
  }
  for (const [name, ref] of [['main', 'refs/remotes/origin/main'], ['master', 'refs/remotes/origin/master'], ['main', 'refs/heads/main']] as const) {
    try {
      return { name, sha: git(repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`) };
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * A bundle of `sha` and the default branch, as a stream: every object they reach, copied. Under temporary refs
 * in the coordinator's clone, private to this run (removed once the bundle is written).
 */
export function treeBundle(repo: string, sha: string, id: string): { stream: Readable; branch: string; done: Promise<void> } {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  const full = git(repo, 'rev-parse', '--verify', `${sha}^{commit}`);
  const base = defaultBranch(repo) ?? { name: 'main', sha: full };
  const head = `refs/${BRAND.cli}/test-run/${id}/head`;
  const baseRef = `refs/${BRAND.cli}/test-run/${id}/base`;
  git(repo, 'update-ref', head, full);
  git(repo, 'update-ref', baseRef, base.sha);
  const child = spawn('git', ['-C', repo, 'bundle', 'create', '--quiet', '-', head, baseRef], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const cleanup = () => {
    for (const r of [head, baseRef]) {
      try {
        git(repo, 'update-ref', '-d', r);
      } catch {
        // already gone
      }
    }
  };
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => (cleanup(), reject(e)));
    child.on('close', (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`git bundle of ${sha} failed: ${err.trim().slice(0, 500)}`));
    });
  });
  return { stream: child.stdout, branch: base.name, done };
}

/**
 * The commands that turn a bundle at `bundle` into the clone at `work`, run as the test user (the sandbox helper
 * runs the same ones, checked by a test): $1 the bundle, $2 the workspace, $3 the default branch's name, $4 and $5
 * the bundle's refs for the commit and the default branch.
 */
export function cloneScript(): string {
  return [
    'set -euo pipefail',
    'bundle="$1" work="$2" branch="$3" head="$4" base="$5"',
    // No system or global config of anyone's: only what is set here.
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
    'git init -q -b "$branch" "$work"',
    'cd "$work"',
    'git config core.hooksPath /dev/null',
    'git config credential.helper ""',
    'git config user.name test-run',
    'git config user.email test-run@example.com',
    'git fetch -q --no-tags --no-write-fetch-head --update-head-ok "$bundle" "+$head:refs/test-run/head" "+$base:refs/heads/$branch"',
    'git update-ref "refs/remotes/origin/$branch" "refs/heads/$branch"',
    'git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$branch"',
    'git checkout -q --detach refs/test-run/head',
    'git update-ref -d refs/test-run/head',
    'rm -f "$bundle"',
  ].join('\n');
}

/** Make run `id`'s workspace at `sha`: a clone of its own with the default branch. */
export async function createWorkspace(host: RunHost, repo: string, sha: string, id: string): Promise<{ workdir: string }> {
  const b = treeBundle(repo, sha, id);
  const [ws] = await Promise.all([host.create(id, b.stream, { branch: b.branch, head: `refs/${BRAND.cli}/test-run/${id}/head`, base: `refs/${BRAND.cli}/test-run/${id}/base` }), b.done]);
  return ws;
}

/**
 * Everything a run's commands get, and nothing else: the project's own variables (the same rules as tests.yaml
 * env: no secret-like or harness names), the caches' directories, and the run's DATABASE_URL. Never this
 * process's environment, so no credential the coordinator holds can reach a run.
 */
export function runEnv(projectEnv: Record<string, string>, caches: Record<string, string>, db: RunDatabase | null): Record<string, string> {
  const env: Record<string, string> = { ...safeProjectEnv(projectEnv), ...safeProjectEnv(caches) };
  delete env.DATABASE_URL;
  if (db) env.DATABASE_URL = db.url;
  return env;
}

/** Wipe run `id`; a wipe that leaves anything behind throws, naming what is left. */
export async function wipeWorkspace(host: RunHost, id: string): Promise<void> {
  const r = await host.wipe(id);
  if (!r.ok) throw new Error(`run ${id} was not wiped: ${r.left.join(', ') || 'unknown'}`);
}

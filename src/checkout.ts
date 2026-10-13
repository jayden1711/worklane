// tests.yaml `checkout.sparse_exclude`: directories a project keeps out of the checkouts the harness makes for its
// work (each agent's worktree, each test run's workspace), e.g. design files, art and other binaries no agent or
// test reads. They stay in the repo and its history; they are just never written to those working trees, so making
// one is faster and smaller. The project's own checks run in the agent's worktree too: leave out only what they
// don't read. A test-run tier that needs them says `full_checkout: true` (test_run.tiers).
//
// Non-cone sparse checkout ("/*" then "!/<dir>/" per directory): everything, minus those directories.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/**
 * A directory left out, relative to the repo root: plain path characters only (no glob, no quote, no space), not
 * starting with "-", no "." or ".." or empty segment, so it goes into a sparse pattern and the test-run helper's
 * arguments as written. The sandbox helper checks each with the same rule (scripts/machine/<cli>-testrun.sh
 * valid_dir; a test keeps the two alike).
 */
export const SPARSE_DIR = /^[A-Za-z0-9._@+][A-Za-z0-9._@+/-]{0,199}$/;

/** The most directories a project may leave out (each is one argument to the helper, which takes at most this). */
export const SPARSE_MAX = 32;

/** `docs/design/` and `docs/design` are the same directory: no trailing slash. */
export const normalizeSparseDir = (p: string): string => p.replace(/\/+$/, '');

/** Why `p` can't be left out of a checkout; null when it can. */
export function sparseDirProblem(p: string): string | null {
  if (!SPARSE_DIR.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return 'a directory inside the repo: letters, digits and . _ @ + - / (no glob, no space, no . or .. segment, no leading / or -)';
  }
  if (p.split('/')[0] === '.git') return "not git's own directory";
  return null;
}

export const SparseExclude = z
  .array(
    z
      .string()
      .transform(normalizeSparseDir)
      .superRefine((p, ctx) => {
        const why = sparseDirProblem(p);
        if (why) ctx.addIssue({ code: 'custom', message: why });
      }),
  )
  .max(SPARSE_MAX)
  .default([])
  .superRefine((dirs, ctx) => {
    const seen = new Set<string>();
    dirs.forEach((d, i) => {
      if (seen.has(d)) ctx.addIssue({ code: 'custom', path: [i], message: `${d} is listed twice` });
      seen.add(d);
    });
  });

/** The sparse-checkout file for leaving `dirs` out: everything ("/*"), then "!/<dir>/" for each. */
export function sparsePatterns(dirs: readonly string[]): string {
  return ['/*', ...dirs.map((d) => `!/${normalizeSparseDir(d)}/`)].join('\n') + '\n';
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Make the linked worktree at `path` (added with --no-checkout) sparse, leaving `dirs` out, and check its HEAD out.
 * The setting is the worktree's own (extensions.worktreeConfig, its config.worktree): the checkout it was added
 * from and every other worktree stay as they are.
 */
export function checkoutSparse(repo: string, path: string, dirs: readonly string[]): void {
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  git(path, 'config', '--worktree', 'core.sparseCheckout', 'true');
  git(path, 'config', '--worktree', 'core.sparseCheckoutCone', 'false');
  const file = resolve(path, git(path, 'rev-parse', '--git-path', 'info/sparse-checkout'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sparsePatterns(dirs));
  // The index is empty after --no-checkout: read HEAD's tree into it and the working tree, skipping what is left out.
  git(path, 'read-tree', '-mu', 'HEAD');
}

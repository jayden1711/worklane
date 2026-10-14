// WHY: after the first-run page merges a config PR, the person's checkout should have that config without a
// `git pull` in a terminal. This brings the checkout's default branch up to origin's, as a fast-forward only: never a
// reset, a merge commit or a rebase, and never over the person's own work. Anything else is refused, saying why and
// what to run instead.
import { spawnSync } from 'node:child_process';
import { withToolPath } from './tool-path.js';

export interface GitRun {
  (args: string[]): { status: number | null; stdout: string; stderr: string };
}

export const systemGit = (root: string): GitRun => (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...withToolPath(), GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
};

export type FastForward = { ok: true; detail: string; from: string; to: string } | { ok: false; detail: string };

const first = (s: string) => s.trim().split('\n')[0] ?? '';

/**
 * Fetch origin's `branch` and fast-forward this checkout to it. Refused (nothing changed): the checkout isn't on
 * `branch`; it has uncommitted changes to tracked files; or it has commits origin doesn't (diverged).
 */
export function fastForwardCheckout(branch: string, git: GitRun): FastForward {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.startsWith('-')) return { ok: false, detail: `not a branch name: ${branch.slice(0, 60)}` };
  const pull = `git pull --ff-only origin ${branch}`;
  const on = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (on.status !== 0) return { ok: false, detail: `can't tell which branch this checkout is on (${first(on.stderr)})` };
  if (on.stdout.trim() !== branch) return { ok: false, detail: `this checkout is on ${on.stdout.trim()}, not ${branch}: switch to ${branch} and run \`${pull}\`` };
  const fetched = git(['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (fetched.status !== 0) return { ok: false, detail: `couldn't fetch origin's ${branch} (${first(fetched.stderr)})` };
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.status !== 0) return { ok: false, detail: `can't read this checkout's status (${first(dirty.stderr)})` };
  if (dirty.stdout.trim()) return { ok: false, detail: `this checkout has uncommitted changes (${dirty.stdout.trim().split('\n').length} file(s)); nothing was changed: commit or stash them, then run \`${pull}\`` };
  const from = git(['rev-parse', 'HEAD']).stdout.trim();
  const to = git(['rev-parse', `refs/remotes/origin/${branch}`]).stdout.trim();
  if (from === to) return { ok: true, detail: `${branch} is at origin's already (${to.slice(0, 7)})`, from, to };
  const behind = git(['merge-base', '--is-ancestor', 'HEAD', `refs/remotes/origin/${branch}`]);
  if (behind.status !== 0) return { ok: false, detail: `this checkout's ${branch} has commits origin's doesn't (it diverged); nothing was changed: reconcile it yourself (\`git log origin/${branch}..${branch}\` shows them)` };
  const ff = git(['merge', '--ff-only', '-q', `refs/remotes/origin/${branch}`]);
  if (ff.status !== 0) return { ok: false, detail: `${branch} couldn't fast-forward (${first(ff.stderr)}); run \`${pull}\`` };
  return { ok: true, detail: `fast-forwarded ${branch} from ${from.slice(0, 7)} to ${to.slice(0, 7)}`, from, to };
}

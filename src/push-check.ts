// Push limits. Every push of agent-written code goes through checkedPush,
// which first refuses a range that is too big, carries an oversized or
// refused file in any of its commits (one added and later deleted still
// counts: it stays in the history that's pushed), or changes CI workflows.
// The coordinator also runs pushProblems on each change before verifying it,
// so a doomed change is caught before a long test run.
import { execFileSync, spawnSync } from 'node:child_process';
import { globToRegExp } from './guardrails/glob.js';

export interface PushLimits {
  max_file_mb: number;
  max_changed_lines: number;
  refuse_paths: string[];
}

export const DEFAULT_PUSH_LIMITS: PushLimits = { max_file_mb: 10, max_changed_lines: 1500, refuse_paths: [] };

const WORKFLOWS = '.github/workflows/';
const MB = 1024 * 1024;

const git = (cwd: string, args: string[], input?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * MB, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });

const list = (paths: string[], n = 10) => `${paths.slice(0, n).join(', ')}${paths.length > n ? ` and ${paths.length - n} more` : ''}`;

/** Every reason the range base..head may not be pushed; empty means it may. */
export function pushProblems(cwd: string, base: string, head: string, limits: PushLimits): string[] {
  const range = `${base}..${head}`;
  const problems: string[] = [];
  // Paths touched by any commit in the range, not just the net diff.
  const touched = [...new Set(git(cwd, ['log', '--format=', '--name-only', '--no-renames', '--diff-merges=first-parent', range]).split('\n').filter(Boolean))];

  const workflows = touched.filter((p) => p.startsWith(WORKFLOWS));
  if (workflows.length) problems.push(`changes CI workflows (${list(workflows)}): the harness's GitHub credential has no Workflows permission, so GitHub refuses this push; a human makes workflow changes`);

  const refuseRes = limits.refuse_paths.map((g) => ({ g, re: globToRegExp(g) }));
  const refused = touched.filter((p) => refuseRes.some(({ re }) => re.test(p)));
  if (refused.length) problems.push(`touches paths that are never pushed (${list(refused)}), matching push.refuse_paths; remove them from every commit on the branch, not just the last one`);

  // Every blob new in the range, with its path: a file added and then deleted is still pushed.
  const paths = new Map<string, string>();
  for (const l of git(cwd, ['rev-list', '--objects', range]).split('\n')) {
    const [sha, ...p] = l.split(' ');
    if (sha && p.length) paths.set(sha, p.join(' '));
  }
  const objects = [...paths.keys()];
  if (objects.length) {
    const limit = limits.max_file_mb * MB;
    const big: string[] = [];
    for (const l of git(cwd, ['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize)'], `${objects.join('\n')}\n`).split('\n')) {
      const [type, sha, size] = l.split(' ');
      if (type === 'blob' && Number(size) > limit) big.push(`${paths.get(sha!) ?? sha} (${(Number(size) / MB).toFixed(1)} MB)`);
    }
    if (big.length) problems.push(`has files over the ${limits.max_file_mb} MB limit (${list(big)}) in its commits; remove them from every commit on the branch`);
  }

  const lines = git(cwd, ['diff', '--numstat', range])
    .split('\n')
    .filter(Boolean)
    .reduce((s, l) => {
      const [a, r] = l.split('\t');
      return s + (Number(a) || 0) + (Number(r) || 0);
    }, 0);
  if (lines > limits.max_changed_lines) problems.push(`changes ${lines} lines, over the ${limits.max_changed_lines}-line limit (push.max_changed_lines); split it into smaller changes`);
  return problems;
}

export type PushResult = { ok: true } | { ok: false; refused: string[] } | { ok: false; error: string };

/**
 * The only way the coordinator pushes code: the limits first, then the push.
 * `force` replaces the branch (a task branch the harness owns); without it the
 * push succeeds only if the remote hasn't moved (compare-and-swap).
 */
export function checkedPush(o: { cwd: string; remote: string; base: string; head: string; ref: string; limits: PushLimits; force?: boolean }): PushResult {
  const refused = pushProblems(o.cwd, o.base, o.head, o.limits);
  if (refused.length) return { ok: false, refused };
  const push = spawnSync('git', ['push', o.remote, `${o.force ? '+' : ''}${o.head}:${o.ref}`], { cwd: o.cwd, encoding: 'utf8' });
  if (push.status !== 0) return { ok: false, error: (push.stderr || '').trim() };
  return { ok: true };
}

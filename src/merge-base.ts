// Git work for conflicts and combined-state checks, in a worktree the
// coordinator owns: merge a base into the checked-out branch and report what
// conflicted. Merge commits only here (the default strategy); conflict
// markers use diff3 style so a resolver also sees the common ancestor.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });

export type MergeResult =
  | { clean: true; head: string }
  | { clean: false; conflicted: Record<string, string>; otherFiles: string[] }
  | { error: string };

/**
 * Merge `base` (a commit) into the worktree's current branch with a merge commit. Clean: the new head.
 * Conflicted: each conflicted file's text with markers, and the files the merge did change cleanly (left
 * staged; a resolver commits the result). A clean merge is committed as `identity`: every harness commit
 * carries the harness's identity, and the coordinator rejects any other.
 */
export function mergeBaseInto(worktree: string, base: string, message: string, identity: { name: string; email: string }): MergeResult {
  const r = git(worktree, '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', '-m', message, base);
  if (r.status === 0) return { clean: true, head: git(worktree, 'rev-parse', 'HEAD').stdout.trim() };
  const unmerged = git(worktree, 'diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
  if (!unmerged.length) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git merge exited ${r.status}` };
  const conflicted: Record<string, string> = {};
  for (const f of unmerged) {
    try {
      conflicted[f] = readFileSync(join(worktree, f), 'utf8');
    } catch {
      conflicted[f] = ''; // deleted on one side: the resolver decides
    }
  }
  const staged = git(worktree, 'diff', '--name-only', '--cached').stdout.split('\n').filter(Boolean);
  return { clean: false, conflicted, otherFiles: staged.filter((f) => !(f in conflicted)) };
}

/** Undo an unfinished merge (a conflict nobody will resolve here). */
export function abortMerge(worktree: string): void {
  git(worktree, 'merge', '--abort');
}

/** Files changed between two commits (a..b), for "did main touch what this PR touches". */
export function changedFiles(repo: string, from: string, to: string): string[] {
  const r = git(repo, 'diff', '--name-only', `${from}...${to}`);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

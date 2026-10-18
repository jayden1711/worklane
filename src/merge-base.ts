// Git work for conflicts and combined-state checks, in a worktree the
// coordinator owns: merge a base into the checked-out branch and report what
// conflicted. Merge commits only here (the default strategy); conflict
// markers use diff3 style so a resolver also sees the common ancestor.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedNames, changedNamesOrNull, presentNames } from './coordinator/change-files.js';
import { isNonUtf8Path } from './review.js';

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
/** A blob's id at `rev:path` (or the index's, `:path`), or null when there is none. */
const blob = (cwd: string, spec: string) => {
  const r = git(cwd, 'rev-parse', '--verify', '-q', spec);
  return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
};

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
  // A valid UTF-8 path as itself (-z, through changedNames): a quoted `"lib/na\303\257ve.ts"` names no file (#683).
  const unmerged = changedNamesOrNull(worktree, ['--diff-filter=U']) ?? [];
  if (!unmerged.length) return { error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git merge exited ${r.status}` };
  const conflicted: Record<string, string> = {};
  for (const f of unmerged) {
    try {
      conflicted[f] = readFileSync(join(worktree, f), 'utf8');
    } catch {
      conflicted[f] = ''; // deleted on one side: the resolver decides
    }
  }
  // A rename as both its paths, as the fix run's stray check lists the merge commit (#683).
  const staged = changedNamesOrNull(worktree, ['--cached']) ?? [];
  return { clean: false, conflicted, otherFiles: staged.filter((f) => !(f in conflicted)) };
}

/** A blob that couldn't be read although its file is there (see resolutionStrays). Never a blob id, never null. */
export const UNREADABLE = 'unreadable';

/**
 * A file's blob at `rev:path` (`:0:` for the index's), null when the file isn't there (deleted), or UNREADABLE when
 * it is there but its blob can't be asked for by name (`present`, from presentNames). The index is read at stage 0
 * by number, so a file named like a stage spec (`0:lib/x.ts`) is read as itself, not as stage 0 of lib/x.ts.
 */
const blobOf = (cwd: string, rev: string, path: string, present: Set<string>): string | null =>
  blob(cwd, `${rev}:${path}`) ?? (present.has(path) ? UNREADABLE : null);

/** What the merge itself made of each file it changed cleanly (its staged blob), before a resolver touches anything. */
export function stagedBlobs(worktree: string, otherFiles: string[]): Record<string, string | null> {
  const present = presentNames(worktree, null);
  return Object.fromEntries(otherFiles.map((f) => [f, blobOf(worktree, ':0', f, present)]));
}

/**
 * Where a committed resolution (HEAD, the merge commit) strays from the conflicted files: a file the merge changed
 * cleanly whose committed blob isn't the one the merge staged (`staged`, from stagedBlobs), and a file the merge
 * commit changes against the branch that the merge didn't touch at all (a rename as both its paths). A file whose
 * blob can't be read (UNREADABLE, staged or committed) is a stray too, never "unchanged": two lookups that both
 * fail would compare equal whatever the resolver did. A name that isn't valid UTF-8 (review.ts isNonUtf8Path) names
 * no blob, so it is always one.
 */
export function resolutionStrays(worktree: string, conflicted: string[], otherFiles: string[], staged: Record<string, string | null>): string[] {
  const expected = new Set([...conflicted, ...otherFiles]);
  const inHead = presentNames(worktree, 'HEAD');
  const strays = [
    ...otherFiles.filter((f) => {
      const committed = blobOf(worktree, 'HEAD', f, inHead);
      return isNonUtf8Path(f) || committed === UNREADABLE || staged[f] === UNREADABLE || committed !== staged[f];
    }),
    ...changedNames(worktree, ['HEAD^1', 'HEAD']).filter((f) => !expected.has(f) || isNonUtf8Path(f)),
    // A conflicted file's text and resolution are read by name too, so one that isn't valid UTF-8 can't be checked.
    ...conflicted.filter(isNonUtf8Path),
  ];
  return [...new Set(strays)];
}

/** Undo an unfinished merge (a conflict nobody will resolve here). */
export function abortMerge(worktree: string): void {
  git(worktree, 'merge', '--abort');
}

/** Files changed between two commits (a..b), for "did main touch what this PR touches"; a rename as both its paths. */
export function changedFiles(repo: string, from: string, to: string): string[] {
  return changedNamesOrNull(repo, [`${from}...${to}`]) ?? [];
}

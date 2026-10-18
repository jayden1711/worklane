// What a change touches, as the review levels, the merge decision and the content checks read it (#683).
//
// Rename detection is off: a renamed file is its old path deleted and its new path added, so a rule on either path
// sees it. With it on, git prints one combined path for a rename (`test/{a.ts => b.ts}`), which matches no glob, and
// a per-file diff of that string is empty: renaming a locked file and weakening it in the same change passed as L0.
// `--no-renames` also turns off copies, whatever diff.renames says. Paths come NUL-separated and unquoted (-z), so a
// name with a non-ASCII byte is itself and not `"src/\303\251.ts"`, and are passed back to git literally.
import { execFileSync } from 'node:child_process';
import type { ChangeFile } from '../review.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

/** The added and removed lines of a `git diff -U0` (hunk lines only: a `+++`/`---` before the first @@ is a header). */
export function hunkLines(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  let inHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) inHunk = false;
    else if (l.startsWith('@@')) inHunk = true;
    else if (inHunk && l.startsWith('+')) added.push(l.slice(1));
    else if (inHunk && l.startsWith('-')) removed.push(l.slice(1));
  }
  return { added, removed };
}

/** Each file the change base..head touches (a rename as its old and its new path), with its line counts and lines. */
export function changeFiles(cwd: string, base: string, head: string): ChangeFile[] {
  const range = `${base}..${head}`;
  // -z: "added TAB removed TAB path NUL" for each file (renames off, so never the two-path form).
  return git(cwd, ['diff', '--numstat', '--no-renames', '-z', range])
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const [a, r, ...p] = rec.split('\t');
      const path = p.join('\t');
      const { added, removed } = hunkLines(git(cwd, ['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', range, '--', path]));
      return { path, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added, removedLines: removed };
    });
}

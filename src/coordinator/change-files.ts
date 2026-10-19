// What a change touches, as the review levels, the merge decision, the guards and the content checks read it (#683).
//
// Every reader in src/ of which paths a change touches or how many lines it changes goes through this module, except
// two listed by name with why in test/change-files-renames.test.ts (src/comment-policy.ts and src/push-check.ts).
// That test is a word list, not a proof: it fails on a reader word (--name-only, --numstat, diff-tree, a `+++`
// header, ...) in a file of src/ or scripts/ it doesn't list, but a flag built by concatenation, or a header regex
// that never spells the header, gets past it.
//
// Rename detection is off: a renamed file is its old path deleted and its new path added, so a rule on either path
// sees it. With it on, git prints one combined path for a rename (`test/{a.ts => b.ts}`), which matches no glob, and
// a per-file diff of that string is empty: renaming a locked file and weakening it in the same change passed as L0.
// `--no-renames` also turns off copies, whatever diff.renames says. Paths come NUL-separated and unquoted (-z): git
// otherwise C-quotes a name with a non-ASCII byte, a tab, a quote, a backslash or a newline (`"src/\303\251.ts"`),
// and the quoted string matches no glob and names no file. They are passed back to git literally.
//
// Names are read as bytes. A valid UTF-8 name comes back as itself. One that isn't (a byte like 0xff) can't be: it
// comes back with U+FFFD for its bad bytes, git can't be handed it back (a process's arguments are UTF-8 here), and
// review.ts puts it in non-utf8-path, which is L3 and always waits for the owner.
//
// A change's lines are read whatever the repo's attributes say (#693). The change's own branch controls its
// .gitattributes, and a file marked `-diff` or `binary` there shows as `-` in --numstat and "Binary files differ" in
// a patch: no lines, no content. So every git call here ignores the user's attributes file (ATTRIBUTES_OFF), every
// patch is read as text with no textconv or external diff (AS_TEXT), and a file numstat calls binary is counted
// from those lines (or, for a name that can't be handed back to git, from its blobs). review.ts flags a change that
// adds such a mark, since GitHub still hides the file from the owner.
import { Buffer, isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import type { SizeFile } from '../pr-rules.js';
import type { ChangeFile } from '../review.js';

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Before every git call here: no pathspec magic, no replace refs (refs/replace/* is shared by every worktree of a
 * repo, so an agent's `git replace` would swap the blobs read here for others), and no attributes from the user's
 * core.attributesFile.
 */
const GIT = ['--literal-pathspecs', '--no-replace-objects', '-c', 'core.attributesFile=/dev/null'];
/** Every patch read here: as text whatever the attributes say (`-diff`, `binary`), with no command a config names. */
const AS_TEXT = ['--text', '--no-textconv', '--no-ext-diff'];

/** Run git; its stdout, untrimmed (a path may start or end with a space), or an Error saying why it failed. */
function run(cwd: string, args: string[], timeout?: number): string | Error {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, ...(timeout ? { timeout } : {}) });
  if (r.error) return r.error;
  if (r.status !== 0) return new Error(`git ${args.join(' ').slice(0, 200)} failed: ${(r.stderr || `exit ${r.status}`).trim().slice(0, 500)}`);
  return r.stdout;
}

/** run, with stdout as bytes: for output that holds paths. */
function runBytes(cwd: string, args: string[], timeout?: number): Buffer | Error {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER, ...(timeout ? { timeout } : {}) });
  if (r.error) return r.error;
  if (r.status !== 0) return new Error(`git ${args.join(' ').slice(0, 200)} failed: ${(r.stderr.toString('utf8') || `exit ${r.status}`).trim().slice(0, 500)}`);
  return r.stdout;
}

const must = <T>(out: T | Error): T => {
  if (out instanceof Error) throw out;
  return out;
};

/** The NUL-separated fields of `-z` output, as bytes (a trailing NUL ends the last one). */
function fields(out: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = out.indexOf(0); i !== -1; i = out.indexOf(0, start)) {
    parts.push(out.subarray(start, i));
    start = i + 1;
  }
  if (start < out.length) parts.push(out.subarray(start));
  return parts;
}

/**
 * A name as read: itself when it is valid UTF-8. Otherwise its bad bytes become U+FFFD (the decoder's replacement,
 * added here too if a decoder ever didn't), which review.ts isNonUtf8Path reads as a name that isn't valid UTF-8.
 */
function nameOf(bytes: Buffer): string {
  const s = bytes.toString('utf8');
  return isUtf8(bytes) || s.includes('�') ? s : `${s}�`;
}

/**
 * The options a caller may add to a name list: which side to compare (`--cached`), which kinds of change
 * (`--diff-filter=`), and diff-tree's walk of one commit. Anything else is refused, so a caller can't turn rename or
 * copy detection back on (`-M`, `--find-renames`, ...), change the output format, or write a file (`--output`).
 */
const NAME_OPTION = /^(?:--cached|--diff-filter=[ACDMRTUXB]+|-r|-m|--first-parent|--no-commit-id)$/;

function nameArgs(args: string[]): string[] {
  for (const a of args) if (a.startsWith('-') && !NAME_OPTION.test(a)) throw new Error(`changedNames: ${a} is not an option a name list takes`);
  return args;
}

/** The NUL-separated paths of `--name-only -z`, each read by nameOf. */
const names = (out: Buffer): string[] => fields(out).filter((b) => b.length).map(nameOf);

export interface NameListOptions {
  /** `git diff-tree` (one commit against its parent) instead of `git diff`. */
  tree?: boolean;
  /** Milliseconds before git is stopped. */
  timeout?: number;
}

const nameList = (cwd: string, args: string[], o: NameListOptions) =>
  runBytes(cwd, [o.tree ? 'diff-tree' : 'diff', '--name-only', '--no-renames', '-z', ...nameArgs(args)], o.timeout);

/**
 * The paths `git diff <args>` (or `git diff-tree <args>`) touches: a rename as both its paths, each read by nameOf.
 * `args` are revisions, a range, `--cached`, `--diff-filter=...` and diff-tree's `-r -m --first-parent --no-commit-id`.
 * Throws when git fails.
 */
export function changedNames(cwd: string, args: string[], o: NameListOptions = {}): string[] {
  return names(must(nameList(cwd, args, o)));
}

/** changedNames, or null when git fails (an unknown commit, no repo). */
export function changedNamesOrNull(cwd: string, args: string[], o: NameListOptions = {}): string[] | null {
  const out = nameList(cwd, args, o);
  return out instanceof Error ? null : names(out);
}

/** The untracked files of a worktree (`ls-files --others --exclude-standard -z`), each read by nameOf. */
export function untrackedNames(cwd: string): string[] {
  return names(must(runBytes(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])));
}

/**
 * Every file in the index (`ls-files --cached -z`, `rev` null) or in a commit's tree (`ls-tree -r -z --name-only`),
 * each read by nameOf: whether a file is there at all, apart from whether its blob can be asked for by name.
 */
export function presentNames(cwd: string, rev: string | null): Set<string> {
  return new Set(names(must(runBytes(cwd, rev === null ? ['ls-files', '--cached', '-z'] : ['ls-tree', '-r', '-z', '--name-only', rev, '--']))));
}

/** Each path `git diff <args>` touches with its status letter (A, M, D, T, ...): a rename as a delete and an add. */
export function changedStatuses(cwd: string, args: string[]): { status: string; path: string }[] {
  const parts = fields(must(runBytes(cwd, ['diff', '--name-status', '--no-renames', '-z', ...nameArgs(args)])));
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i]!.toString('utf8'), path: nameOf(parts[i + 1]!) });
  return out;
}

/** `git diff --raw -z --no-renames <args>`, as experiments/proposal.ts parseRawDiff reads it. */
export function rawChanges(cwd: string, args: string[]): string {
  return must(run(cwd, ['diff', '--raw', '-z', '--no-renames', ...nameArgs(args)]));
}

/** `git diff --stat` against `rev`, as text for a person or a prompt (a rename as both its paths). Never parsed. */
export function diffStatText(cwd: string, rev: string): string {
  return must(run(cwd, ['diff', '--stat', '--no-renames', '--no-color', ...nameArgs([rev])])).trim();
}

/** `git show --stat --patch` of one commit, as text for a person. Never parsed. */
export function commitText(cwd: string, commit: string): string {
  return must(run(cwd, ['show', '--stat', '--patch', '--no-color', '--no-ext-diff', '--format=commit %H', ...nameArgs([commit])]));
}

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

/** How many lines a blob holds (a last line with no newline counts); 0 for no blob (the all-zero id). */
function blobLines(cwd: string, sha: string): number {
  if (/^0+$/.test(sha)) return 0;
  const b = must(runBytes(cwd, ['cat-file', 'blob', sha]));
  let n = 0;
  for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) n++;
  return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
}

/**
 * The old and new blob of each path base..head touches, keyed by the name's bytes (`--raw -z --no-abbrev`):
 * ":mode mode old new status NUL path NUL".
 */
function blobsOf(cwd: string, range: string): Map<string, { old: string; new: string }> {
  const parts = fields(must(runBytes(cwd, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', range])));
  const out = new Map<string, { old: string; new: string }>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, , old = '', now = ''] = parts[i]!.toString('latin1').split(' ');
    out.set(parts[i + 1]!.toString('hex'), { old, new: now });
  }
  return out;
}

/** Each file the change base..head touches (a rename as its old and its new path), with its line counts and lines. */
export function changeFiles(cwd: string, base: string, head: string): ChangeFile[] {
  const range = `${base}..${head}`;
  let blobs: Map<string, { old: string; new: string }> | null = null;
  // -z: "added TAB removed TAB path NUL" for each file (renames off, so never the two-path form).
  return fields(must(runBytes(cwd, ['diff', '--numstat', '--no-renames', '-z', ...AS_TEXT, range])))
    .filter((rec) => rec.length)
    .map((rec) => {
      const t1 = rec.indexOf(9);
      const t2 = rec.indexOf(9, t1 + 1);
      const [a, r] = [rec.subarray(0, t1).toString('latin1'), rec.subarray(t1 + 1, t2).toString('latin1')];
      const bytes = rec.subarray(t2 + 1);
      const path = nameOf(bytes);
      // A name that isn't valid UTF-8 can't be handed back to git, so its lines aren't read: it is L3 and waits anyway.
      const { added, removed } = isUtf8(bytes) ? hunkLines(must(run(cwd, ['diff', '-U0', '--no-renames', '--no-color', ...AS_TEXT, range, '--', path]))) : { added: [], removed: [] };
      // numstat says `-` for a file it calls binary (a NUL byte, or a `-diff`/`binary` attribute; --text doesn't
      // change numstat): its lines are counted from the patch read as text, or, for a name git can't be handed, from
      // its blobs (every line of the old one removed, of the new one added). Never 0 or 1 for a file of many lines.
      if (a !== '-' && r !== '-') return { path, added: Number(a) || 0, removed: Number(r) || 0, addedLines: added, removedLines: removed };
      if (isUtf8(bytes)) return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
      const blob = (blobs ??= blobsOf(cwd, range)).get(bytes.toString('hex'));
      if (!blob) throw new Error(`changeFiles: no blobs for ${JSON.stringify(path)} in ${range}`);
      return { path, added: blobLines(cwd, blob.new), removed: blobLines(cwd, blob.old), addedLines: added, removedLines: removed };
    });
}

/**
 * The change base..head as the size limit reads it (pr-rules.ts sizeVerdict): one `git diff -M -U0`, each file under
 * its new path, a rename's old path in `from`. Rename detection is on here on purpose: a pure rename counts 0 lines.
 * Read as text (AS_TEXT): a file marked `-diff` or `binary`, or one with a NUL byte, counts its lines (#693).
 */
export function sizeFiles(cwd: string, base: string, head: string): SizeFile[] {
  const diff = must(run(cwd, ['-c', 'core.quotePath=false', 'diff', '-M', '-U0', '--no-color', ...AS_TEXT, '--src-prefix=a/', '--dst-prefix=b/', `${base}..${head}`]));
  const out: SizeFile[] = [];
  let cur: SizeFile | null = null;
  let inHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      // A name git still quotes (a tab, a newline, a quote) doesn't match: it is a file of its own all the same, under
      // its quoted name (no generated glob matches that, so its lines count), never lines added to the file before it.
      const header = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      cur = { path: header ? header[2]! : l.slice('diff --git '.length), added: [], removed: [] };
      out.push(cur);
      inHunk = false;
    } else if (!cur) continue;
    else if (l.startsWith('@@')) inHunk = true;
    else if (inHunk && l.startsWith('+')) cur.added.push(l.slice(1));
    else if (inHunk && l.startsWith('-')) cur.removed.push(l.slice(1));
    else if (!inHunk && l.startsWith('rename from ')) cur.from = l.slice('rename from '.length);
    else if (!inHunk && l.startsWith('rename to ')) cur.path = l.slice('rename to '.length);
    else if (!inHunk && l.startsWith('+++ b/')) cur.path = l.slice('+++ b/'.length);
  }
  return out;
}

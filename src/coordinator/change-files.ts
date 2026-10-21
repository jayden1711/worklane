// What a change touches, as the review levels, the merge decision, the guards and the content checks read it (#683).
//
// Every reader in src/ of which paths a change touches or how many lines it changes goes through this module, except
// one listed by name with why in test/change-files-renames.test.ts (src/comment-policy.ts). The push limits read
// theirs here too (rangeNames, #724).
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
// a patch: no lines, no content. So every git call here ignores the user's attributes file and replace refs (GIT),
// every diff sees every submodule link whatever .gitmodules or the config say (DIFF_COMMANDS), every patch is read as
// text with no textconv or external diff (AS_TEXT), and a file numstat calls binary is counted from those lines (or,
// for a name that can't be handed back to git, from its blobs). review.ts flags a change that adds such a mark, since
// GitHub and a checkout still honour it.
import { Buffer, isUtf8 } from 'node:buffer';
import { gitSpawnSync } from '../os/git.js';
import type { SizeFile } from '../pr-rules.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attributeTransitionHides, isGitattributesPath, isGitmodulesPath, macrosDefined, OUTCOME_ATTRIBUTES, type ChangeFile } from '../review.js';

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Before every git call here: no pathspec magic, no replace refs (refs/replace/* is shared by every worktree of a
 * repo, so an agent's `git replace` would swap the blobs read here for others), and no attributes from the user's
 * core.attributesFile.
 */
const GIT = ['--literal-pathspecs', '--no-replace-objects', '-c', 'core.attributesFile=/dev/null'];
/** Every patch read here: as text whatever the attributes say (`-diff`, `binary`), with no command a config names. */
const AS_TEXT = ['--text', '--no-textconv', '--no-ext-diff'];
/**
 * The commands that compare trees. Each gets `--ignore-submodules=none` right after it, in withGit, so no call here can
 * leave it out: a branch's .gitmodules (`ignore = all`) or the config (`diff.ignoreSubmodules`) would otherwise hide a
 * submodule link, its path and its commit from every list and count (#693).
 */
const DIFF_COMMANDS = new Set(['diff', 'diff-tree', 'show']);

/** GIT, then `args` with `--ignore-submodules=none` after the command when it compares trees (`-c k=v` pairs skipped). */
function withGit(args: string[]): string[] {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return DIFF_COMMANDS.has(args[i] ?? '') ? [...GIT, ...args.slice(0, i + 1), '--ignore-submodules=none', ...args.slice(i + 1)] : [...GIT, ...args];
}

/** Run git; its stdout, untrimmed (a path may start or end with a space), or an Error saying why it failed. */
function run(cwd: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv): string | Error {
  const r = gitSpawnSync(withGit(args), { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, ...(timeout ? { timeout } : {}), ...(env ? { env } : {}) });
  if (r.error) return r.error;
  if (r.status !== 0) return new Error(`git ${args.join(' ').slice(0, 200)} failed: ${(r.stderr || `exit ${r.status}`).trim().slice(0, 500)}`);
  return r.stdout;
}

/** run, with stdout as bytes: for output that holds paths. */
function runBytes(cwd: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv): Buffer | Error {
  const r = gitSpawnSync(withGit(args), { cwd, encoding: 'buffer', maxBuffer: MAX_BUFFER, ...(timeout ? { timeout } : {}), ...(env ? { env } : {}) });
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

/**
 * The paths any commit in `range` (base..head) touches, not just its net diff: a file added and removed again still
 * counts. A merge is read against its first parent; every submodule link is seen. Each path read by nameOf, once, so a
 * name git would C-quote (a non-ASCII byte, a newline, a quote) is itself (#724). Throws when git fails. `env`: a
 * gitSnapshot's, so the walk reads the push limits' one checked view of the history (#807).
 */
export function rangeNames(cwd: string, range: string, env?: NodeJS.ProcessEnv): string[] {
  if (range.startsWith('-')) throw new Error(`rangeNames: ${range} is not a range`);
  // Plumbing only (#724, round 4): `git log` is porcelain and reads log.* config. log.showSignature glued a signature
  // check's text to the first name ("No signature\nsecrets/k.key", so 1 problem became 0, measured) and
  // log.showRoot=false hid a root commit's files. rev-list and diff-tree read none of it: each commit of the range
  // against its first parent, a root against the empty tree.
  const commits = must(run(cwd, ['rev-list', range], undefined, env));
  if (!commits.trim()) return [];
  return [...new Set(names(must(plumbingBytes(cwd, ['diff-tree', '--stdin', '-r', '--root', '-m', '--first-parent', '--no-renames', '--name-only', '--no-commit-id', '-z'], commits, env))))];
}

/** runBytes with `input` on git's stdin. */
function plumbingBytes(cwd: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Buffer | Error {
  const r = gitSpawnSync(withGit(args), { cwd, input: Buffer.from(input, 'utf8'), encoding: 'buffer', maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) });
  if (r.error) return r.error;
  if (r.status !== 0) return new Error(`git ${args.join(' ').slice(0, 200)} failed: ${(r.stderr.toString('utf8') || `exit ${r.status}`).trim().slice(0, 500)}`);
  return r.stdout;
}

/** A tree entry as blobsByName reads it: a regular file's text, or why it wasn't read. */
export type TreeFile = { text: string } | { unread: string };

/** The tree modes of a regular file: anything else (a symlink, 120000; a submodule link, 160000) is never read as one. */
const REGULAR_FILE = new Set(['100644', '100755']);

/**
 * The entries of `rev`'s tree whose name, as nameOf reads it, is one of `names`: for each such name, every entry with
 * it, read by object id and never by name, so a name that isn't valid UTF-8 (which can't be handed back to git) is
 * still read (#724). Only a regular file of at most `maxBytes` is read; anything else says why it wasn't: a symlink
 * (its blob is its target's path, not the file a checkout opens), a submodule link, a blob over the size, or one git
 * can't give. A name with no entry at `rev` isn't in the map: that is the only "not there". Throws when the tree
 * can't be listed. `env`: a gitSnapshot's, as for rangeNames (`rev` must then be a commit id: a snapshot has no refs).
 */
export function blobsByName(cwd: string, rev: string, names: string[], maxBytes = Infinity, env?: NodeJS.ProcessEnv): Map<string, TreeFile[]> {
  const out = new Map<string, TreeFile[]>();
  const wanted = new Set(names);
  if (!wanted.size) return out;
  if (rev.startsWith('-')) throw new Error(`blobsByName: ${rev} is not a revision`);
  // -r -z -l: "mode SP type SP object SP+ size TAB path NUL" for every file of the tree.
  for (const rec of fields(must(runBytes(cwd, ['ls-tree', '-r', '-z', '-l', '--full-tree', rev], undefined, env)))) {
    const tab = rec.indexOf(9);
    if (tab === -1) continue;
    const name = nameOf(rec.subarray(tab + 1));
    if (!wanted.has(name)) continue;
    const [mode, type, sha, size] = rec.subarray(0, tab).toString('latin1').split(/ +/);
    const file = ((): TreeFile => {
      if (mode === '120000') return { unread: 'a symbolic link, not a file' };
      if (type !== 'blob' || !sha || !REGULAR_FILE.has(mode ?? '')) return { unread: `not a regular file (mode ${mode})` };
      if (!(Number(size) <= maxBytes)) return { unread: `${size} bytes, over the ${maxBytes}-byte limit for it` };
      const text = run(cwd, ['cat-file', 'blob', sha], undefined, env);
      return text instanceof Error ? { unread: 'git can\'t give its blob' } : { text };
    })();
    out.set(name, [...(out.get(name) ?? []), file]);
  }
  return out;
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

/**
 * `git diff <args>` as a patch, for a person, a prompt or a hash (#807): every file's lines whatever the attributes say
 * (a `-diff` or `binary` mark, a textconv or an external diff), and every submodule link. `args` as changedNames takes
 * them. Never parsed.
 */
export function patchText(cwd: string, args: string[]): string {
  return must(run(cwd, ['diff', '--no-color', ...AS_TEXT, ...nameArgs(args)]));
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
  const files = changeFileLines(cwd, base, head);
  // A .gitattributes line is judged with every macro the base or head tree defines (review.ts hidesDiff), so a
  // harmless-looking name a macro shadows (`[attr]eol -diff` on main, then `*.job eol`) is read as the macro.
  if (files.some((f) => isGitattributesPath(f.path))) {
    const macros = [...new Set([...attributeMacros(cwd, base), ...attributeMacros(cwd, head)])];
    // And git judges the outcome itself: every path's attributes on the base tree against the head tree.
    const outcome = attributeOutcome(cwd, base, head);
    for (const f of files) {
      if (!isGitattributesPath(f.path)) continue;
      f.attributeMacros = macros;
      f.attributeOutcome = outcome;
    }
  }
  // A .gitmodules is read by git's own config parser on both sides (review.ts hidesSubmodules): an `ignore` already on
  // main that the change moves onto a new link (by editing `path`) counts as much as one the change adds.
  for (const f of files) if (isGitmodulesPath(f.path)) f.submoduleIgnores = submoduleIgnores(cwd, [base, head], f.path);
  return files;
}

/** Every macro name (`[attr]name`) any .gitattributes (any directory, any case) of `rev`'s tree defines, as review.ts macroDefined reads it. */
function attributeMacros(cwd: string, rev: string): string[] {
  const out: string[] = [];
  // -z: "mode SP type SP object TAB path NUL" for each file of the tree.
  // --full-tree: the whole tree, whatever directory `cwd` is in.
  for (const rec of fields(must(runBytes(cwd, ['ls-tree', '-r', '-z', '--full-tree', rev, '--'])))) {
    const tab = rec.indexOf(9);
    const [, type, sha] = rec.subarray(0, tab).toString('latin1').split(' ');
    if (type !== 'blob' || !sha || !isGitattributesPath(rec.subarray(tab + 1).toString('latin1'))) continue;
    for (const line of must(runBytes(cwd, ['cat-file', 'blob', sha])).toString('utf8').split('\n')) out.push(...macrosDefined(line));
  }
  return out;
}

/**
 * `git check-attr --source=<tree>` came in git 2.40: an older git can't judge a tree's attributes, so the outcome
 * check fails closed. Not exported: this module exports functions only (a test holds it).
 */
const MIN_GIT_FOR_ATTRIBUTE_SOURCE: readonly [number, number] = [2, 40];

/** The running git's major and minor version (`git version 2.43.0`), or null when it can't be read. Asked each time: it's one spawn, only when a .gitattributes changes. */
function gitVersion(cwd: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(runStatus(cwd, ['version']).stdout);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Whether the repo's `$GIT_DIR/info/attributes` holds any rule. It outranks every tree's .gitattributes (measured:
 * `* diff` there turned a base tree's `-diff` into `set`), so with one, a tree's change can be masked and the outcome
 * check can't judge.
 */
function infoAttributesInUse(cwd: string): boolean {
  const r = runStatus(cwd, ['rev-parse', '--git-path', 'info/attributes']);
  if (r.status !== 0) return true;
  let text: string;
  try {
    text = readFileSync(resolve(cwd, r.stdout.trim()), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  return text.split('\n').some((l) => l.replace(/^[ \t\r\n]*/, '') !== '' && !l.replace(/^[ \t\r\n]*/, '').startsWith('#'));
}

/** Every path of `rev`'s tree, as bytes keyed by their latin1 reading (`ls-tree -r -z --name-only`). */
function treePaths(cwd: string, rev: string): Map<string, Buffer> {
  // --full-tree: every path from the top, whatever directory `cwd` is in (a subdirectory would list only its own).
  return new Map(fields(must(runBytes(cwd, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', rev, '--']))).filter((b) => b.length).map((b) => [b.toString('latin1'), b]));
}

/**
 * Each path's state of every OUTCOME_ATTRIBUTES attribute in `rev`'s tree, as git itself reads the tree's
 * .gitattributes (`check-attr --source=<rev> -z --stdin`): no user attributes file (GIT), no system one
 * (GIT_ATTR_NOSYSTEM), and the worktree's .gitattributes not read (measured). Keyed by the path's latin1 reading, then
 * the attribute; null when git fails.
 */
function attributeStates(cwd: string, rev: string, paths: Buffer[]): Map<string, Map<string, string>> | null {
  const input = Buffer.concat(paths.flatMap((p) => [p, Buffer.from([0])]));
  const r = gitSpawnSync(withGit(['check-attr', `--source=${rev}`, '-z', '--stdin', ...OUTCOME_ATTRIBUTES]), { cwd, input, encoding: 'buffer', maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_ATTR_NOSYSTEM: '1' } });
  if (r.error || r.status !== 0) return null;
  const out = new Map<string, Map<string, string>>();
  // -z: "path NUL attribute NUL state NUL" for each path and attribute.
  const parts = fields(r.stdout);
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const key = parts[i]!.toString('latin1');
    if (!out.has(key)) out.set(key, new Map());
    out.get(key)!.set(parts[i + 1]!.toString('latin1'), parts[i + 2]!.toString('utf8'));
  }
  return out;
}

/**
 * What a change does to attributes, as git itself judges it (the outcome check, #693): every path of either tree (a
 * deletion, an addition and both sides of a rename included) is asked of the base tree and of the head tree, and each
 * attribute whose change from base to head can make a review see less (review.ts attributeTransitionHides: a forced
 * `diff` left, for one) is listed (`path: diff unspecified -> unset`). git parses the .gitattributes, so no line format of ours can disagree with it: macros, quoting,
 * BOMs and whitespace are all git's. null when git can't judge (older than MIN_GIT_FOR_ATTRIBUTE_SOURCE, a rule in
 * `$GIT_DIR/info/attributes`, or a failure), which review.ts counts as hiding.
 */
export function attributeOutcome(at: string, base: string, head: string): string[] | null {
  // From the top of the work tree: check-attr reads its paths relative to the directory it runs in.
  const cdup = runStatus(at, ['rev-parse', '--show-cdup']);
  if (cdup.status !== 0) return null;
  const cwd = resolve(at, cdup.stdout.trim());
  const v = gitVersion(cwd);
  const [major, minor] = MIN_GIT_FOR_ATTRIBUTE_SOURCE;
  if (!v || v[0] < major || (v[0] === major && v[1] < minor)) return null;
  if (infoAttributesInUse(cwd)) return null;
  const all = new Map([...treePaths(cwd, base), ...treePaths(cwd, head)]);
  const paths = [...all.values()];
  const before = attributeStates(cwd, base, paths);
  const after = attributeStates(cwd, head, paths);
  if (!before || !after) return null;
  const out: string[] = [];
  let more = 0;
  for (const [key, bytes] of all) {
    for (const attr of OUTCOME_ATTRIBUTES) {
      const was = before.get(key)?.get(attr) ?? 'unspecified';
      const now = after.get(key)?.get(attr) ?? 'unspecified';
      if (!attributeTransitionHides(attr, was, now)) continue;
      // The first OUTCOME_SHOWN, then a count: a `*` mark on a big tree hides every path (100,000 measured).
      if (out.length < OUTCOME_SHOWN) out.push(`${nameOf(bytes)}: ${attr} ${was} -> ${now}`);
      else more++;
    }
  }
  if (more) out.push(`and ${more} more`);
  return out;
}

/** How many of the outcome check's findings are listed by name. */
const OUTCOME_SHOWN = 10;

/** git's exit status and stdout, for the calls whose status is an answer (`cat-file -e`, `config --get-regexp`). */
function runStatus(cwd: string, args: string[]): { status: number | null; stdout: string } {
  const r = gitSpawnSync(withGit(args), { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
}

/**
 * The value of every `ignore` key (any section: `submodule.<name>.ignore` and anything else git would read so) in the
 * .gitmodules at `path` on each side it exists, read by git's own config parser (`config --blob -z --list`; git gives
 * section and key names in lower case); null for a key with no value. null for the whole when git can't parse a side
 * or the name can't be handed to git. `--list`, not `--get-regexp`: the latter exits 1 both for "no such key" and for
 * a file it can't parse.
 */
function submoduleIgnores(cwd: string, revs: string[], path: string): (string | null)[] | null {
  if (path.includes('�')) return null;
  const out: (string | null)[] = [];
  for (const rev of revs) {
    const spec = `${rev}:${path}`;
    if (runStatus(cwd, ['cat-file', '-e', spec]).status !== 0) continue;
    const r = runStatus(cwd, ['config', '--blob', spec, '-z', '--list']);
    if (r.status !== 0) return null;
    // -z: "key NL value NUL", or "key NUL" for a key with no value.
    for (const entry of r.stdout.split('\0').filter(Boolean)) {
      const nl = entry.indexOf('\n');
      const key = nl === -1 ? entry : entry.slice(0, nl);
      if (/\.ignore$/.test(key)) out.push(nl === -1 ? null : entry.slice(nl + 1));
    }
  }
  return out;
}

/** changeFiles' lists and counts, before the .gitattributes macros. */
function changeFileLines(cwd: string, base: string, head: string): ChangeFile[] {
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
 * `renames: 'configured'` pairs renames only as the git config says (diff.renames: on by default, off, or copies too),
 * as the push limit's plain `git diff` count always did: under diff.renames=false a pure rename counts in full there.
 */
export function sizeFiles(cwd: string, base: string, head: string, o: { renames?: 'on' | 'configured' } = {}): SizeFile[] {
  const pairing = o.renames === 'configured' ? [] : ['-M'];
  const diff = must(run(cwd, ['-c', 'core.quotePath=false', 'diff', ...pairing, '-U0', '--no-color', ...AS_TEXT, '--src-prefix=a/', '--dst-prefix=b/', `${base}..${head}`]));
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

/**
 * The pure renames of base..head, old path to new: a deleted regular file (mode 100644 or 100755) whose exact blob
 * (same id, same mode) the change adds at a new path. A symlink (its text points elsewhere once moved) or a submodule
 * is never one. Content match by blob id, no similarity guess; a rename with any edit isn't one. Each added path pairs
 * with one deleted path at most. For the weakening check (src/merge-policy-weakening.ts): a test file only renamed
 * doesn't wait.
 */
export function exactMoves(cwd: string, base: string, head: string): Map<string, string> {
  // -z: ":mode mode old new status NUL path NUL" for each path (renames off: a move is a D and an A).
  const parts = fields(must(runBytes(cwd, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', `${base}..${head}`])));
  const gone = new Map<string, string[]>();
  const came: { key: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode = '', newMode = '', old = '', now = '', status = ''] = parts[i]!.toString('latin1').replace(/^:/, '').split(' ');
    const path = nameOf(parts[i + 1]!);
    const regular = (mode: string) => mode === '100644' || mode === '100755';
    if (status === 'D' && !regular(oldMode)) continue;
    if (status === 'A' && !regular(newMode)) continue;
    if (status === 'D') gone.set(`${oldMode} ${old}`, [...(gone.get(`${oldMode} ${old}`) ?? []), path]);
    else if (status === 'A') came.push({ key: `${newMode} ${now}`, path });
  }
  const out = new Map<string, string>();
  for (const { key, path } of came) {
    const from = gone.get(key)?.shift();
    if (from !== undefined) out.set(from, path);
  }
  return out;
}

/**
 * The text of each of `paths` that is a file in `rev`'s tree, keyed by path; a path that isn't there is left out. For
 * the merge decision's check for a weakened test, lint or guard (src/merge-policy-weakening.ts), which compares a
 * changed file before and after. Paths are from the top of the repo. A blob over `maxBytes` isn't read: its path is
 * in `tooBig` with its size. Throws when git fails.
 */
export function filesAt(cwd: string, rev: string, paths: string[], maxBytes = Infinity): { texts: Map<string, string>; tooBig: Map<string, number> } {
  const texts = new Map<string, string>();
  const tooBig = new Map<string, number>();
  if (!paths.length) return { texts, tooBig };
  // -z -l: "mode SP type SP object SP+ size TAB path NUL" for each path in the tree.
  for (const rec of fields(must(runBytes(cwd, ['ls-tree', '-z', '-l', '--full-tree', rev, '--', ...paths])))) {
    const tab = rec.indexOf(9);
    const [, type, sha, size] = rec.subarray(0, Math.max(tab, 0)).toString('latin1').split(/ +/);
    if (tab === -1 || type !== 'blob' || !sha) continue;
    const path = nameOf(rec.subarray(tab + 1));
    if (Number(size) > maxBytes) tooBig.set(path, Number(size));
    else texts.set(path, must(run(cwd, ['cat-file', 'blob', sha])));
  }
  return { texts, tooBig };
}

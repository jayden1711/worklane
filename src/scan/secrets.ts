// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawn, spawnSync } from '../os/child-process.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { ignoredNames, presentNames, rawChanges, untrackedNames } from '../coordinator/change-files.js';
import { notRootsProgram } from '../os/index.js';
import { findTool } from '../tool-path.js';

export interface Finding {
  rule: string;
  file: string;
  line: number;
}

export type ScanResult =
  | { status: 'clean' }
  | { status: 'leaks'; findings: Finding[] }
  | { status: 'unavailable'; error: string };

const LEAKS_EXIT = 3;

/** Scan a file or directory. Findings never include the secret itself. */
export function scanPath(path: string, binary = findTool('gitleaks')): ScanResult {
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const report = join(dir, 'report.json');
  try {
    const r = spawnSync(
      binary,
      ['dir', path, '--redact', '--no-banner', '--max-decode-depth', '2', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)],
      { encoding: 'utf8', timeout: 300_000 },
    );
    if (r.error) return { status: 'unavailable', error: r.error.message };
    if (r.status === 0) return { status: 'clean' };
    if (r.status === LEAKS_EXIT) {
      const raw = JSON.parse(readFileSync(report, 'utf8')) as { RuleID: string; File: string; StartLine: number }[];
      return { status: 'leaks', findings: raw.map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine })) };
    }
    return { status: 'unavailable', error: `gitleaks exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` };
  } catch (e) {
    return { status: 'unavailable', error: (e as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What a commit scan covers besides the staged changes (src/guard/commit.ts decides it from the command). */
export interface CommitScanScope {
  unstaged: boolean;
  untracked: boolean;
  head: boolean;
  /** The line shows changes as diffs before the commit, so programs that render a diff run. */
  diffReads?: boolean;
  /** The line shows commits before the commit (log or show). */
  logReads?: boolean;
  /** The line asks for commits' signatures to be shown. */
  signatureReads?: boolean;
  /** A git mv before the commit names an attributes file, so a file may become one after the scan has looked. */
  moves?: boolean;
}

/** One file of a comparison: its content after the commit, and before it (null: the file is new). */
interface Compared {
  path: string;
  now: Buffer;
  before: Buffer | null;
  /** `now` was read from the working tree, not from git. */
  disk?: boolean;
}

/**
 * Scan what a `git commit` is about to record, across the whole checkout whose top level is `top` (#971): its staged
 * changes, and as `scope` says, tracked files' unstaged changes, untracked files that aren't ignored, and the current
 * commit (an amend records it again).
 * INVARIANT (#971): the scan reads content, never a diff git renders: blobs by object id and files from disk, with the
 * changed paths from the change reader (src/coordinator/change-files.ts). Each changed file is scanned whole, after
 * and before; a secret counts when the file holds it more times after than before. So no placement of a change, and
 * nothing the checkout's own settings say about showing one, changes what is found.
 */
export function scanCommit(top: string, scope: CommitScanScope, binary = findTool('gitleaks')): ScanResult {
  return scanComparisons(top, binary, () => {
    checkReadPrograms(top, scope);
    const comparisons: [string, () => Compared[]][] = [['staged changes', () => stagedContent(top)]];
    if (scope.unstaged || scope.untracked) comparisons.push(['unstaged changes', () => worktreeContent(top)]);
    if (scope.untracked) comparisons.push(['untracked files', () => untrackedContent(top)]);
    if (scope.head) for (const [i, read] of headContent(top).entries()) comparisons.push([`the commit being amended (parent ${i + 1})`, read]);
    return comparisons;
  });
}

/**
 * Scan the index a commit is recording, against HEAD, from inside the commit: the engine's pre-commit hook (#983), the
 * second layer under scanCommit's model of the command line. INVARIANT (#983): it reads the index git names for the
 * commit (GIT_INDEX_FILE, which git sets for its hooks, so a commit of named paths is read in the index git builds for
 * it), by content as scanCommit does; whatever the command line was, and whatever ran before it in the commit.
 * The checkout's read programs aren't checked here: the index already holds what git stores, and nothing here renders
 * a change or reads the working tree.
 */
export function scanIndex(top: string, binary = findTool('gitleaks')): ScanResult {
  return scanComparisons(top, binary, () => [['the index being committed', () => stagedContent(top)]]);
}

function scanComparisons(top: string, binary: string | null | undefined, comparisonsOf: () => [string, () => Compared[]][]): ScanResult {
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const tmp = mkdtempSync(join(tmpdir(), 'scan-commit-'));
  try {
    const comparisons = comparisonsOf();
    // WHY: the checkout's own rules, as the scan of its diff read them before; never a rules file the content brings.
    const own = join(top, '.gitleaks.toml');
    const config = join(tmp, 'gitleaks.toml');
    writeFileSync(config, existsSync(own) ? readFileSync(own) : '[extend]\nuseDefault = true\n');
    // WHY (#971): never an ignore list: not one on disk, and not one the commit itself brings (see SCANNER_NAMES).
    const noIgnores = join(tmp, 'no-ignores');
    writeFileSync(noIgnores, '');
    // WHY: the report holds the secrets themselves (they are compared), so it lives in the scan's own temporary folder
    // and is deleted as soon as it is read; only rule names and paths leave this function.
    const scan = (root: string, scannerNamed: boolean): Map<string, string[]> => {
      const report = `${root}.json`;
      const r = spawnSync(binary, ['dir', '.', '--config', config, '--gitleaks-ignore-path', noIgnores, '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)], { cwd: root, encoding: 'utf8', timeout: 120_000 });
      if (r.error) throw r.error;
      const keys = new Map<string, string[]>();
      if (r.status === 0) return keys;
      if (r.status !== LEAKS_EXIT) throw new Error(`gitleaks exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}`);
      try {
        for (const f of JSON.parse(readFileSync(report, 'utf8')) as { RuleID: string; File: string; Secret: string }[]) {
          let file = f.File.replace(/^\.\//, '');
          if (scannerNamed) file = file.slice(SCANNER_DIR.length + 1);
          keys.set(file, [...(keys.get(file) ?? []), `${f.RuleID}\0${f.Secret}`]);
        }
      } finally {
        rmSync(report, { force: true });
      }
      return keys;
    };
    const findings: Finding[] = [];
    for (const [i, [what, read]] of comparisons.entries()) {
      const files = read();
      if (!files.length) continue;
      const side = (name: string, pick: (c: Compared) => Buffer | null) => {
        const keys = new Map<string, string[]>();
        for (const [k, scannerName] of [[0, false], [1, true]] as const) {
          const root = join(tmp, `c${i}-${name}-${k}`);
          let any = false;
          for (const c of files) {
            const content = pick(c);
            if (content === null || SCANNER_NAMES.has(c.path) !== scannerName) continue;
            const parts = c.path.split('/');
            if (!c.path || c.path.startsWith('/') || parts.some((p) => p === '..' || p === '')) throw new Error(`an unexpected path from git: ${JSON.stringify(c.path)}`);
            // WHY: a file the scanner would read as its own settings at its root goes, as content, a folder lower.
            const at = join(root, scannerName ? SCANNER_DIR : '', c.path);
            mkdirSync(dirname(at), { recursive: true });
            writeFileSync(at, Buffer.concat([TEXT_PREFIX, text(content)]));
            any = true;
          }
          if (any) for (const [file, found] of scan(root, scannerName)) keys.set(file, found);
        }
        return keys;
      };
      const after = side('after', (c) => c.now);
      const before = side('before', (c) => c.before);
      for (const [file, found] of after) {
        for (const key of introduced(before.get(file) ?? [], found)) findings.push({ rule: key.split('\0')[0]!, file: `${file} (${what})`, line: 0 });
      }
    }
    return findings.length ? { status: 'leaks', findings } : { status: 'clean' };
  } catch (e) {
    return { status: 'unavailable', error: (e as Error).message.split('\n')[0]!.slice(0, 400) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The keys (`rule\0secret`) `after` holds more times than `before`. WHY (#971): a secret counts as new by how often a
 * file holds it, never by where a diff would place the lines around it.
 */
export function introduced(before: string[], after: string[]): string[] {
  const had = new Map<string, number>();
  for (const k of before) had.set(k, (had.get(k) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const k of after) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen].filter(([k, n]) => n > (had.get(k) ?? 0)).map(([k]) => k);
}

const ZERO = /^0+$/;

/**
 * Written before every file the commit scan hands the scanner. WHY (#971): so nothing in the content can decide
 * whether the scanner reads the file.
 */
const TEXT_PREFIX = Buffer.alloc(65_536, 0x0a);
/** Names the scanner reads as its own settings at the root of what it scans; such a file of the commit goes lower. */
const SCANNER_NAMES = new Set(['.gitleaksignore', '.gitleaks.toml', '.gitleaksbaseline']);
const SCANNER_DIR = 'scanner-named';

/** The bytes the scanner reads for a file: NUL bytes dropped, so text spread across them is read as text. */
const text = (b: Buffer) => Buffer.from(b.toString('latin1').replace(/\0/g, ''), 'latin1');

/** git in the checkout, for an object or a revision (never a list of changes: those come from the change reader). */
function gitOut(top: string, args: string[], input?: string): Buffer {
  const r = spawnSync('git', ['--no-replace-objects', ...args], { cwd: top, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: 60_000, ...(input !== undefined ? { input: Buffer.from(input, 'utf8') } : {}) });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString('utf8').trim().split('\n').pop() ?? `exit ${r.status}`}`);
  return r.stdout;
}

/** The objects' contents, by id, read as stored (no text conversion or filter). */
function objects(top: string, ids: string[]): Buffer[] {
  if (!ids.length) return [];
  const out = gitOut(top, ['cat-file', '--batch'], `${ids.join('\n')}\n`);
  const got: Buffer[] = [];
  let at = 0;
  for (const id of ids) {
    const end = out.indexOf(10, at);
    const head = out.subarray(at, end < 0 ? out.length : end).toString('latin1').split(' ');
    if (end < 0 || head[1] !== 'blob') throw new Error(`object ${id} is not a blob git can give`);
    const size = Number(head[2]);
    got.push(out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return got;
}

interface RawEntry {
  path: string;
  mode: string;
  before: string | null;
  /** The new object id; null when the new side is the file on disk. */
  after: string | null;
}

const objectId = (id: string | undefined) => (!id || ZERO.test(id.replace(/\.+$/, '')) ? null : id.replace(/\.+$/, ''));

/** Every entry of a raw change list with content after it (no deletes or conflicts), submodule links included. */
function rawAll(raw: string): RawEntry[] {
  const parts = raw.split('\0');
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    if (!meta.startsWith(':')) throw new Error('an unexpected change list from git');
    const [, newMode, before, after, status] = meta.slice(1).split(' ');
    if (!status || status.startsWith('D') || status.startsWith('U') || newMode === '000000') continue;
    out.push({ path: parts[i + 1]!, mode: newMode ?? '', before: objectId(before), after: objectId(after) });
  }
  return out;
}

/** The changed files of a raw change list that have content after it: no deletes, conflicts or submodule links. */
const rawEntries = (raw: string) => rawAll(raw).filter((e) => e.mode !== '160000');

/** Each entry, both sides read as objects, or the new side from disk when it has no object id. */
function entryContent(top: string, entries: RawEntry[]): Compared[] {
  const before = objects(top, entries.filter((e) => e.before).map((e) => e.before!));
  const after = objects(top, entries.filter((e) => e.after).map((e) => e.after!));
  let b = 0;
  let a = 0;
  const out: Compared[] = [];
  for (const e of entries) {
    const old = e.before ? before[b++]! : null;
    const now = e.after ? after[a++]! : fromDisk(top, e.path);
    if (now !== null) out.push({ path: e.path, now, before: old, disk: !e.after });
  }
  return lfsContent(top, out);
}

/** A file's content on disk as git would store it: a link's target, a file's bytes; null for anything else. */
function fromDisk(top: string, path: string): Buffer | null {
  const full = join(top, path);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return Buffer.from(readlinkSync(full), 'utf8');
  return st.isFile() ? readFileSync(full) : null;
}

/** The empty tree's id in this checkout's object format. */
const emptyTree = (top: string) => gitOut(top, ['hash-object', '-t', 'tree', '--stdin'], '').toString('latin1').trim();

/** HEAD's commit id, or null on a branch with no commit yet. */
function headId(top: string): string | null {
  const r = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: top, encoding: 'utf8', timeout: 60_000 });
  if (r.error) throw r.error;
  return r.status === 0 ? r.stdout.trim() : null;
}

const stagedRaw = (top: string) => rawChanges(top, ['--cached', headId(top) ?? emptyTree(top)]);

function stagedContent(top: string): Compared[] {
  return entryContent(top, rawEntries(stagedRaw(top)));
}

function worktreeContent(top: string): Compared[] {
  const entries = rawEntries(rawChanges(top, []));
  storedAsOnDisk(top, entries.filter((e) => !e.after).map((e) => e.path));
  return entryContent(top, entries);
}

function untrackedContent(top: string): Compared[] {
  const paths = untrackedNames(top);
  storedAsOnDisk(top, paths);
  const out: Compared[] = [];
  for (const path of paths) {
    const now = fromDisk(top, path);
    if (now !== null) out.push({ path, now, before: null, disk: true });
  }
  return lfsContent(top, out);
}

/** Attributes under which git stores something other than a working-tree file's bytes. */
const CONVERTING = ['filter', 'working-tree-encoding', 'ident'];

/**
 * Throws unless git stores each of these working-tree files as the bytes on disk the scan reads. INVARIANT (#971): a
 * file with a filter, an encoding or an ident attribute, from any attributes source (the worktree's, the index's, the
 * repo's or the user's), refuses the commit; the scan never runs a filter itself.
 */
function storedAsOnDisk(top: string, paths: string[]) {
  if (!paths.length) return;
  if (paths.some((p) => p.includes('�'))) throw new Error('a file in this commit has a name that is not UTF-8, so its attributes can\'t be checked');
  let lfs: boolean | undefined;
  for (const where of [[], ['--cached']]) {
    const out = gitOut(top, ['check-attr', '-z', '--stdin', ...where, ...CONVERTING], `${paths.join('\0')}\0`).toString('utf8').split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) {
      if (out[i + 2] === 'unspecified' || out[i + 2] === 'unset') continue;
      // WHY (owner, 2026-10-21): the standard large-file filter stores the file's own bytes, read from disk here.
      if (out[i + 1] === 'filter' && out[i + 2] === 'lfs' && (lfs ??= lfsStandard(configOf(top)))) continue;
      throw new Error(`a file in this commit has a ${out[i + 1]} attribute, so git stores other bytes than the scan reads`);
    }
  }
}

/** Config that names a program git runs to show a change as a diff. */
const DIFF_PROGRAM_KEYS = [/^diff\.external$/, /^diff\..+\.(textconv|command)$/, /^interactive\.difffilter$/];
/** Config that names a program git runs to check a signature. */
const SIGNATURE_PROGRAM_KEY = /^gpg\.(.+\.)?program$/;
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/;

/**
 * A config key as git compares it: the section and the variable name without case, a subsection (a filter's or a
 * diff driver's name) exactly as written. WHY (#971): only the exact driver a file names is the driver git runs.
 */
function configKey(raw: string): string {
  const first = raw.indexOf('.');
  const last = raw.lastIndexOf('.');
  if (first < 0 || first === last) return raw.toLowerCase();
  return `${raw.slice(0, first).toLowerCase()}${raw.slice(first, last)}${raw.slice(last).toLowerCase()}`;
}

/** The effective config of the checkout at `top`: each key (as configKey gives it) with its values, in order. */
function configOf(top: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of gitOut(top, ['config', '--list', '-z']).toString('utf8').split('\0').filter(Boolean)) {
    const nl = e.indexOf('\n');
    const key = configKey(nl < 0 ? e : e.slice(0, nl));
    out.set(key, [...(out.get(key) ?? []), nl < 0 ? '' : e.slice(nl + 1)]);
  }
  return out;
}

/**
 * Throws when the effective config of the checkout at `top`, or of a submodule checked out in it, names a program
 * git may run while it reads changes: in the reads `scope` says the line runs before the commit, or in the scan's own
 * change listing. INVARIANT (#971): such a program could change what is committed after the scan has read it, so the
 * commit is refused (fail closed), never scanned around it.
 */
export function checkReadPrograms(top: string, scope: CommitScanScope, depth = 0) {
  if (depth > 8) throw new Error('submodules nested too deep to check');
  const config = configOf(top);
  const filters = new Set<string>();
  let signer = '';
  for (const key of config.keys()) {
    if (scope.diffReads && DIFF_PROGRAM_KEYS.some((re) => re.test(key))) throw new Error(`the checkout's config names a program git runs to show a diff (${key}), and the line shows changes before it commits`);
    // WHY: with a signature program set, any log or show may run it (config can ask for signatures in many ways).
    if (SIGNATURE_PROGRAM_KEY.test(key)) signer = key;
    const f = FILTER_KEY.exec(key);
    if (f) filters.add(f[1]!);
  }
  // WHY: git's own reading of the monitor setting: a boolean is git's own daemon; anything else is a program's path.
  if (config.has('core.fsmonitor')) {
    const r = spawnSync('git', ['config', '--type=bool', '--get', 'core.fsmonitor'], { cwd: top, encoding: 'utf8', timeout: 60_000 });
    if (r.error || r.status !== 0) throw new Error('the checkout\'s config names a file-system monitor program, which git runs while it reads changes');
  }
  if (scope.logReads && signer) throw new Error(`the checkout's config names a program git runs to check signatures (${signer}), and the line shows commits before it commits`);
  // WHY (owner, 2026-10-21): the standard large-file filter, exactly as its installer writes it, is allowed; it stores
  // the file's own bytes, which the scan reads (lfsContent). Any other value, or any other filter, still refuses.
  const lfs = filters.has('lfs') && lfsStandard(config);
  if (lfs) filters.delete('lfs');
  const tracked = filters.size ? [...new Set([...presentNames(top, null), ...untrackedNames(top)])] : [];
  if (tracked.some((p) => p.includes('�'))) throw new Error('a file in this checkout has a name that is not UTF-8, so its attributes can\'t be checked');
  if (tracked.length) {
    const out = gitOut(top, ['check-attr', '-z', '--stdin', 'filter'], `${tracked.join('\0')}\0`).toString('utf8').split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) {
      if (filters.has(out[i + 2]!)) {
        throw new Error(`this checkout's files use a filter its config names (${out[i + 2]}), a program git runs while it reads changes, so agent commits here are refused; a person commits here, or the owner removes the filter from this checkout's config`);
      }
    }
  }
  // WHY (#1011): git runs git-lfs as a filter only for a file under the filter, and a checkout where no attributes
  // source names it (the filter set up globally) has none, so the program isn't checked there. git-lfs's own hooks
  // (post-commit and the others `git lfs install` writes) still run the git-lfs PATH finds; this scan doesn't model
  // hooks (#1110). Every source counts whether or not a path matches it now, since staging in the line can change
  // which files match; so does a git mv that may make a file an attributes file.
  if (lfs) {
    if (scope.moves) lfsProgramRootsAlone(top, 'a git mv earlier in the line may make a file an attributes file after the scan has looked; run the git mv in a call of its own, then commit');
    else if (attributesNameLfs(top, config)) lfsProgramRootsAlone(top, 'an attributes source here names the large-file filter');
  }
  // WHY: a read and the scan's own listing reach into each checked-out submodule under that submodule's own config,
  // and a nested checkout the line stages becomes one.
  for (const sub of submodules(top, scope.untracked)) checkReadPrograms(sub, scope, depth + 1);
}

/** An attributes file's name in a checkout, as git reads it (any case: a case-insensitive file system matches it). */
export const ATTRIBUTES_FILE = /(^|\/)\.gitattributes\/*$/i;
const NAMES_LFS = /filter=lfs/;

/**
 * Whether any attributes source of the checkout at `top` names the large-file filter, whatever path it matches: an
 * attributes file in the working tree (tracked, untracked or ignored), the index or HEAD, the repository's own, the
 * user's and the system's. One that can't be read counts as naming it, and so does a tree the config or the
 * environment names as the attributes source (attr.tree, GIT_ATTR_SOURCE), which isn't read.
 */
function attributesNameLfs(top: string, config: Map<string, string[]>): boolean {
  if (config.has('attr.tree') || process.env.GIT_ATTR_SOURCE !== undefined) return true;
  const names = (b: Buffer) => NAMES_LFS.test(b.toString('latin1'));
  const file = (path: string | null): boolean => {
    if (!path) return false;
    try {
      return names(readFileSync(path));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR';
    }
  };
  for (const p of [...presentNames(top, null), ...untrackedNames(top), ...ignoredNames(top)]) if (ATTRIBUTES_FILE.test(p) && file(join(top, p))) return true;
  const ids: string[] = [];
  const head = headId(top);
  for (const [rev, prefix] of [[null, ':'], ...(head ? [[head, `${head}:`]] : [])] as [string | null, string][]) {
    for (const p of presentNames(top, rev)) {
      if (!ATTRIBUTES_FILE.test(p)) continue;
      // WHY: an object is asked for by name, one a line; a name that can't be written so counts as naming the filter.
      if (/[\n\r]/.test(p) || p.includes('�')) return true;
      ids.push(`${prefix}${p}`);
    }
  }
  if (objects(top, [...new Set(ids)]).some(names)) return true;
  const gitDir = resolvePath(top, gitOut(top, ['rev-parse', '--git-common-dir']).toString('utf8').trim());
  // WHY: git reads a relative attributes file name from the checkout's top level (measured, git 2.43).
  return [join(gitDir, 'info', 'attributes'), gitVar(top, 'GIT_ATTR_GLOBAL'), gitVar(top, 'GIT_ATTR_SYSTEM')].some((p) => file(p && resolvePath(top, p)));
}

/** `git var <name>`: the user's or the system's attributes file; null when git names none (GIT_ATTR_NOSYSTEM). */
function gitVar(top: string, name: string): string | null {
  const r = spawnSync('git', ['--no-replace-objects', 'var', name], { cwd: top, encoding: 'utf8', timeout: 60_000 });
  if (r.error) throw r.error;
  if (r.status === 0) return r.stdout.trim() || null;
  // WHY: a git that names no such file exits with nothing said (no home, GIT_ATTR_NOSYSTEM); a git older than 2.42
  // has no such variable and reads the files its defaults name; anything else is a failure, never "no file".
  if (!r.stderr.trim()) return null;
  if (!/unknown variable|usage: git var/i.test(r.stderr)) throw new Error(`git var ${name} failed, so the attributes file it names can't be checked`);
  if (name === 'GIT_ATTR_SYSTEM') return process.env.GIT_ATTR_NOSYSTEM ? null : '/etc/gitattributes';
  const set = spawnSync('git', ['config', '--path', '--get', 'core.attributesFile'], { cwd: top, encoding: 'utf8', timeout: 60_000 });
  if (set.status === 0 && set.stdout.trim()) return set.stdout.trim();
  const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, '.config') : '');
  return xdg ? join(xdg, 'git', 'attributes') : null;
}

/** The large-file filter's config exactly as its standard install writes it (#971, owner 2026-10-21). */
const LFS_STANDARD: Record<string, string> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
  'filter.lfs.required': 'true',
};

/**
 * The large-file program's own settings that change nothing it stores or runs: where it talks to and how it locks.
 * WHY (#971): any other `lfs.*` key (an extension program, another store, ...) can change the bytes stored or run a
 * program during the commit, so the standard filter's allowance doesn't hold with it.
 */
const LFS_SAFE_KEY = /^lfs\.(url|pushurl|locksverify|repositoryformatversion|fetchinclude|fetchexclude|fetchrecentalways|concurrenttransfers|activitytimeout|dialtimeout|tlstimeout|keepalive|skipdownloaderrors)$|^lfs\..+\.(access|locksverify)$/;

/**
 * Whether the effective config's large-file filter is exactly the standard one: the `lfs` driver (by its exact name)
 * with each of its four keys present and every value it has (from any config source) the standard string, no other
 * key for that driver, and no large-file setting outside LFS_SAFE_KEY.
 */
function lfsStandard(config: Map<string, string[]>): boolean {
  for (const key of config.keys()) {
    if (key.startsWith('filter.lfs.') && !(key in LFS_STANDARD)) return false;
    if (key.startsWith('lfs.') && !LFS_SAFE_KEY.test(key)) return false;
  }
  return Object.entries(LFS_STANDARD).every(([k, v]) => (config.get(k) ?? []).length > 0 && config.get(k)!.every((x) => x === v));
}

/**
 * Throws unless the `git-lfs` git would run is a program only root can change. git looks on its own exec path first,
 * then on PATH. INVARIANT (#1011): the scan can't verify the program, and it runs after the scan has read the files,
 * so one the agent's user could replace, one on a path that depends on the folder, or none found refuses the commit.
 */
function lfsProgramRootsAlone(top: string, why: string) {
  const execPath = gitOut(top, ['--exec-path']).toString('utf8').trim();
  for (const dir of [execPath, ...(process.env.PATH ?? '').split(delimiter)]) {
    if (!isAbsolute(dir)) throw new Error(`${why}, and the path git looks for git-lfs on has an entry that is not an absolute directory (${JSON.stringify(dir)}), so which git-lfs it runs depends on the folder`);
    const p = join(dir, 'git-lfs');
    if (!existsSync(p) && !isLink(p)) continue;
    const bad = notRootsProgram(p);
    if (bad) throw new Error(`${why}, and the git-lfs git would run (${p}) ${bad}, so it could change what is stored after the scan has read it`);
    return;
  }
  throw new Error(`${why}, and no git-lfs is on the path the scan can check, so it can't tell which program git would run`);
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Any of the version names the large-file program accepts in a pointer. */
const LFS_MARKER = /git-lfs|hawser|git-media/i;
/** A whole large-file pointer, and nothing else: its object's id and size. */
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]{0,15})\n$/;

/**
 * Each compared file whose large-file filter is the standard one, with any side that is exactly one large-file pointer
 * (stored, or on disk, which the filter passes through as it is) read as its own bytes and the object it names, from
 * the checkout's large-file store. INVARIANT (#971): the bytes git stores are always scanned, the object as well,
 * never instead; a pointer whose object isn't there, or doesn't match it, refuses the commit.
 */
function lfsContent(top: string, files: Compared[]): Compared[] {
  if (!files.length || !lfsStandard(configOf(top))) return files;
  const paths = files.map((f) => f.path);
  if (paths.some((p) => p.includes('�'))) throw new Error('a file in this commit has a name that is not UTF-8, so its attributes can\'t be checked');
  const tracked = new Set<string>();
  for (const where of [[], ['--cached']]) {
    const out = gitOut(top, ['check-attr', '-z', '--stdin', ...where, 'filter'], `${paths.join('\0')}\0`).toString('utf8').split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'lfs') tracked.add(out[i]!);
  }
  if (!tracked.size) return files;
  const store = join(resolvePath(top, gitOut(top, ['rev-parse', '--git-common-dir']).toString('utf8').trim()), 'lfs', 'objects');
  const read = (b: Buffer | null, now: boolean): Buffer | null => {
    if (b === null) return b;
    const m = b.length > 1024 ? null : LFS_POINTER.exec(b.toString('latin1'));
    // INVARIANT (#971, #1011): the large-file program reads more spellings as a pointer than the one form read here,
    // and reads a file of any size as one from its first 1024 bytes (the rest ignored); a file whose first 1024 bytes
    // name any pointer version and that isn't that exact form refuses the commit, never scanned as text alone. The
    // side before is only subtracted from what is found, so read as its bytes alone it can only find more.
    if (!m && now && LFS_MARKER.test(b.subarray(0, 1024).toString('latin1'))) throw new Error('a large file in this commit looks like a large-file pointer but is not in its exact form, so the object it may name can\'t be read');
    if (!m) return b;
    const oid = m[1]!;
    const at = join(store, oid.slice(0, 2), oid.slice(2, 4), oid);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      throw new Error('a large-file pointer in this commit names an object that is not in the checkout\'s large-file store');
    }
    if (!st.isFile()) throw new Error('a large-file pointer in this commit names an object that is not a regular file in the checkout\'s large-file store');
    const object = readFileSync(at);
    if (object.length !== Number(m[2]) || createHash('sha256').update(object).digest('hex') !== oid) throw new Error('a large-file pointer in this commit names an object whose content does not match it');
    return Buffer.concat([b, Buffer.from('\n'), object]);
  };
  return files.map((f) => (tracked.has(f.path) ? { ...f, now: read(f.now, true)!, before: read(f.before, false) } : f));
}

/**
 * The checked-out submodules of the checkout at `top`: links in HEAD's tree or staged, with a checkout there, and,
 * with `untracked`, the untracked nested checkouts staging could turn into links.
 */
function submodules(top: string, untracked = false): string[] {
  const paths = new Set<string>();
  const head = headId(top);
  if (head) {
    for (const rec of gitOut(top, ['ls-tree', '-r', '-z', '--full-tree', head]).toString('utf8').split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab > 0 && rec.startsWith('160000 ')) paths.add(rec.slice(tab + 1));
    }
  }
  for (const e of rawAll(stagedRaw(top))) if (e.mode === '160000') paths.add(e.path);
  if (untracked) for (const p of untrackedNames(top)) if (p.endsWith('/')) paths.add(p.slice(0, -1));
  return [...paths].map((p) => join(top, p)).filter((p) => existsSync(join(p, '.git')));
}

/** The current commit's changes against each of its parents (none: the empty tree), one comparison per parent. */
function headContent(top: string): (() => Compared[])[] {
  const head = headId(top);
  if (!head) throw new Error('there is no commit to amend');
  const parents = gitOut(top, ['rev-list', '--parents', '-n', '1', head]).toString('latin1').trim().split(/\s+/).slice(1);
  return (parents.length ? parents : [emptyTree(top)]).map((parent) => () => entryContent(top, rawEntries(rawChanges(top, [parent, head]))));
}

/**
 * Scan exactly what a change adds: the commits in `range` (e.g. base..head).
 * Async, so a long scan doesn't stall the coordinator's other runs. Scanning
 * the commits rather than the worktree keeps dependencies (node_modules and
 * their bundled test keys) out of it.
 */
export function scanRange(cwd: string, range: string, binary = findTool('gitleaks')): Promise<ScanResult> {
  if (!binary) return Promise.resolve({ status: 'unavailable', error: 'gitleaks not found on PATH' });
  return scanAsync(binary, (report) => ['git', '--redact', '--no-banner', '--log-opts', range, '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT), '.'], cwd);
}

/** Scan one file without blocking (a dashboard upload). Findings name the rule, never the secret (--redact). */
export function scanFile(path: string, binary = findTool('gitleaks')): Promise<ScanResult> {
  if (!binary) return Promise.resolve({ status: 'unavailable', error: 'gitleaks not found on PATH' });
  return scanAsync(binary, (report) => ['dir', path, '--redact', '--no-banner', '--max-decode-depth', '2', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)], undefined);
}

function scanAsync(binary: string, args: (report: string) => string[], cwd: string | undefined): Promise<ScanResult> {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const report = join(dir, 'report.json');
  return new Promise((resolve) => {
    const child = spawn(binary, args(report), { ...(cwd ? { cwd } : {}), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    const done = (r: ScanResult) => {
      rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    child.on('error', (e) => done({ status: 'unavailable', error: e.message }));
    child.on('close', (code) => {
      if (code === 0) return done({ status: 'clean' });
      if (code === LEAKS_EXIT) {
        try {
          const raw = JSON.parse(readFileSync(report, 'utf8')) as { RuleID: string; File: string; StartLine: number }[];
          return done({ status: 'leaks', findings: raw.map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine })) });
        } catch (e) {
          return done({ status: 'unavailable', error: `unreadable report: ${(e as Error).message}` });
        }
      }
      done({ status: 'unavailable', error: `gitleaks exited ${code}: ${err.trim().split('\n').pop() ?? ''}` });
    });
  });
}

// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawn, spawnSync } from '../os/child-process.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { presentNames, rawChanges, untrackedNames } from '../coordinator/change-files.js';
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
}

/** One file of a comparison: its content after the commit, and before it (null: the file is new). */
interface Compared {
  path: string;
  now: Buffer;
  before: Buffer | null;
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
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const tmp = mkdtempSync(join(tmpdir(), 'scan-commit-'));
  try {
    checkReadPrograms(top, scope);
    const comparisons: [string, () => Compared[]][] = [['staged changes', () => stagedContent(top)]];
    if (scope.unstaged || scope.untracked) comparisons.push(['unstaged changes', () => worktreeContent(top)]);
    if (scope.untracked) comparisons.push(['untracked files', () => untrackedContent(top)]);
    if (scope.head) for (const [i, read] of headContent(top).entries()) comparisons.push([`the commit being amended (parent ${i + 1})`, read]);
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
    if (now !== null) out.push({ path: e.path, now, before: old });
  }
  return out;
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
    if (now !== null) out.push({ path, now, before: null });
  }
  return out;
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
  for (const where of [[], ['--cached']]) {
    const out = gitOut(top, ['check-attr', '-z', '--stdin', ...where, ...CONVERTING], `${paths.join('\0')}\0`).toString('utf8').split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) {
      if (out[i + 2] !== 'unspecified' && out[i + 2] !== 'unset') throw new Error(`a file in this commit has a ${out[i + 1]} attribute, so git stores other bytes than the scan reads`);
    }
  }
}

/** Config that names a program git runs to show a change as a diff. */
const DIFF_PROGRAM_KEYS = [/^diff\.external$/, /^diff\..+\.(textconv|command)$/];
/** Config that names a program git runs to check a signature. */
const SIGNATURE_PROGRAM_KEY = /^gpg\.(.+\.)?program$/;
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/;
const OFF = new Set(['false', 'no', 'off', '0']);
const ON = new Set(['', 'true', 'yes', 'on', '1']);

/**
 * Throws when the effective config of the checkout at `top`, or of a submodule checked out in it, names a program
 * git may run while it reads changes: in the reads `scope` says the line runs before the commit, or in the scan's own
 * change listing. INVARIANT (#971): such a program could change what is committed after the scan has read it, so the
 * commit is refused (fail closed), never scanned around it.
 */
export function checkReadPrograms(top: string, scope: CommitScanScope, depth = 0) {
  if (depth > 8) throw new Error('submodules nested too deep to check');
  const entries = gitOut(top, ['config', '--list', '-z']).toString('utf8').split('\0').filter(Boolean);
  const filters = new Set<string>();
  let showSignature = false;
  let signer = '';
  for (const e of entries) {
    const nl = e.indexOf('\n');
    const key = (nl < 0 ? e : e.slice(0, nl)).toLowerCase();
    const value = (nl < 0 ? '' : e.slice(nl + 1)).trim().toLowerCase();
    // WHY: a boolean monitor is git's own daemon; any other value is the path of a program git runs.
    if (key === 'core.fsmonitor' && !OFF.has(value) && !ON.has(value)) throw new Error('the checkout\'s config names a file-system monitor program, which git runs while it reads changes');
    if (scope.diffReads && DIFF_PROGRAM_KEYS.some((re) => re.test(key))) throw new Error(`the checkout's config names a program git runs to show a diff (${key}), and the line shows one before it commits`);
    if (key === 'log.showsignature') showSignature = ON.has(value);
    if (SIGNATURE_PROGRAM_KEY.test(key)) signer = key;
    const f = FILTER_KEY.exec(key);
    if (f) filters.add(f[1]!);
  }
  if (scope.logReads && (scope.signatureReads || showSignature) && signer) throw new Error(`the checkout's config names a program git runs to check signatures (${signer}), and the line shows signatures before it commits`);
  const tracked = filters.size ? [...new Set([...presentNames(top, null), ...untrackedNames(top)])] : [];
  if (tracked.some((p) => p.includes('�'))) throw new Error('a file in this checkout has a name that is not UTF-8, so its attributes can\'t be checked');
  if (tracked.length) {
    const out = gitOut(top, ['check-attr', '-z', '--stdin', 'filter'], `${tracked.join('\0')}\0`).toString('utf8').split('\0');
    for (let i = 0; i + 2 < out.length; i += 3) {
      if (filters.has(out[i + 2]!.toLowerCase())) {
        throw new Error(`this checkout's files use a filter its config names (${out[i + 2]}), a program git runs while it reads changes, so agent commits here are refused; a person commits here, or the owner removes the filter from this checkout's config`);
      }
    }
  }
  // WHY: a read and the scan's own listing reach into each checked-out submodule under that submodule's own config.
  for (const sub of submodules(top)) checkReadPrograms(sub, scope, depth + 1);
}

/** The checked-out submodules of the checkout at `top`: links in HEAD's tree or staged, with a checkout there. */
function submodules(top: string): string[] {
  const paths = new Set<string>();
  const head = headId(top);
  if (head) {
    for (const rec of gitOut(top, ['ls-tree', '-r', '-z', '--full-tree', head]).toString('utf8').split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab > 0 && rec.startsWith('160000 ')) paths.add(rec.slice(tab + 1));
    }
  }
  for (const e of rawAll(stagedRaw(top))) if (e.mode === '160000') paths.add(e.path);
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

// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawn, spawnSync } from '../os/child-process.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rawChanges, untrackedNames } from '../coordinator/change-files.js';
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
}

/**
 * Scan what a `git commit` is about to record, across the whole checkout whose top level is `top` (#971): its staged
 * changes, and as `scope` says, tracked files' unstaged changes, untracked files that aren't ignored, and the current
 * commit (an amend records it again).
 * INVARIANT (#971): the scan reads content, never a diff git renders: blobs by object id and files from disk, with the
 * changed paths from the change reader (src/coordinator/change-files.ts). So nothing the checkout's own settings say
 * about showing a change changes what is scanned. Of each changed file, the lines its earlier version didn't have are
 * scanned, as a diff's added lines were.
 */
export function scanCommit(top: string, scope: CommitScanScope, binary = findTool('gitleaks')): ScanResult {
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const tmp = mkdtempSync(join(tmpdir(), 'scan-commit-'));
  try {
    const routes: [string, () => Map<string, string>][] = [['staged changes', () => stagedContent(top)]];
    if (scope.unstaged || scope.untracked) routes.push(['unstaged changes', () => worktreeContent(top)]);
    if (scope.untracked) routes.push(['untracked files', () => untrackedContent(top)]);
    if (scope.head) routes.push(['the commit being amended', () => headContent(top)]);
    // WHY: the checkout's own rules, as the scan of its diff read them before; never a rules file the content brings.
    const own = join(top, '.gitleaks.toml');
    const config = join(tmp, 'gitleaks.toml');
    writeFileSync(config, existsSync(own) ? readFileSync(own) : '[extend]\nuseDefault = true\n');
    // WHY (#971): never an ignore list: not one on disk, and not one the commit itself brings (see below).
    const noIgnores = join(tmp, 'no-ignores');
    writeFileSync(noIgnores, '');
    const findings: Finding[] = [];
    for (const [i, [what, read]] of routes.entries()) {
      const files = read();
      if (!files.size) continue;
      const dir = join(tmp, `route-${i}`);
      for (const [path, text] of files) {
        const parts = path.split('/');
        if (!path || path.startsWith('/') || parts.some((p) => p === '..' || p === '')) throw new Error(`an unexpected path from git: ${JSON.stringify(path)}`);
        // WHY: the commit's own files are content to scan, never the scanner's settings.
        const at = path === '.gitleaksignore' ? '.gitleaksignore.content' : path;
        mkdirSync(dirname(join(dir, at)), { recursive: true });
        writeFileSync(join(dir, at), Buffer.concat([TEXT_PREFIX, Buffer.from(text, 'latin1')]));
      }
      const report = join(tmp, `report-${i}.json`);
      const r = spawnSync(binary, ['dir', '.', '--config', config, '--gitleaks-ignore-path', noIgnores, '--redact', '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
      if (r.error) return { status: 'unavailable', error: r.error.message };
      if (r.status === LEAKS_EXIT) {
        const raw = JSON.parse(readFileSync(report, 'utf8')) as { RuleID: string; File: string }[];
        findings.push(...raw.map((f) => ({ rule: f.RuleID, file: `${f.File} (${what})`, line: 0 })));
      } else if (r.status !== 0) return { status: 'unavailable', error: `gitleaks exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` };
    }
    return findings.length ? { status: 'leaks', findings } : { status: 'clean' };
  } catch (e) {
    return { status: 'unavailable', error: (e as Error).message.split('\n')[0]!.slice(0, 300) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const ZERO = /^0+$/;

/**
 * Written before every file the commit scan hands the scanner. WHY (#971): so nothing in the content can decide
 * whether the scanner reads the file.
 */
const TEXT_PREFIX = Buffer.alloc(65_536, 0x0a);

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

/**
 * The lines `now` adds to `before`, placed as a line diff's hunks place them: each run of added lines whole, a blank
 * line between runs; NUL bytes dropped. WHY (#971): computed here, so no config or attribute of the checkout can
 * change which lines count as added; a line seen elsewhere in the earlier version still counts where it is added.
 */
function newLines(before: Buffer | null, now: Buffer): string {
  const text = (b: Buffer) => b.toString('latin1').replace(/\0/g, '');
  const lines = text(now).split('\n');
  if (!before) return lines.join('\n');
  const added = addedLines(text(before).split('\n'), lines);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (added[i]) out.push(l);
    else if (out.length && out.at(-1) !== '') out.push('');
  });
  return out.join('\n');
}

/** The most work the line diff does (edit steps times the diagonals it keeps) before it counts every line as added. */
const DIFF_BUDGET = 10_000_000;

/**
 * Which lines of `b` a shortest edit script from `a` inserts (Myers' algorithm). Over DIFF_BUDGET it marks every line
 * of `b` as added: more is scanned, never less.
 */
export function addedLines(a: string[], b: string[]): boolean[] {
  const added = new Array<boolean>(b.length).fill(false);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const all = () => {
    for (let i = 0; i < m; i++) added[pre + i] = true;
    return added;
  };
  if (!m) return added;
  if (!n) return all();
  const max = n + m;
  const off = max + 1;
  let v: Int32Array = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if ((d + 1) * v.length > DIFF_BUDGET) return all();
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) added[pre + prevY] = true;
    x = prevX;
    y = prevY;
  }
  return added;
}

interface RawEntry {
  path: string;
  before: string | null;
  /** The new object id; null when the new side is the file on disk. */
  after: string | null;
}

/** The changed files of a raw change list that have content after it: no deletes, conflicts or submodule links. */
function rawEntries(raw: string): RawEntry[] {
  const parts = raw.split('\0');
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    if (!meta.startsWith(':')) throw new Error('an unexpected change list from git');
    const [, newMode, before, after, status] = meta.slice(1).split(' ');
    if (!status || status.startsWith('D') || status.startsWith('U') || newMode === '160000' || newMode === '000000') continue;
    out.push({ path: parts[i + 1]!, before: !before || ZERO.test(before.replace(/\.+$/, '')) ? null : before.replace(/\.+$/, ''), after: !after || ZERO.test(after.replace(/\.+$/, '')) ? null : after.replace(/\.+$/, '') });
  }
  return out;
}

/** Each entry's new lines: both sides read as objects, or the new side from disk when it has no object id. */
function entryContent(top: string, entries: RawEntry[], into = new Map<string, string>()): Map<string, string> {
  const before = objects(top, entries.filter((e) => e.before).map((e) => e.before!));
  const after = objects(top, entries.filter((e) => e.after).map((e) => e.after!));
  let b = 0;
  let a = 0;
  for (const e of entries) {
    const old = e.before ? before[b++]! : null;
    const now = e.after ? after[a++]! : fromDisk(top, e.path);
    if (now === null) continue;
    const text = newLines(old, now);
    into.set(e.path, into.has(e.path) ? `${into.get(e.path)}\n\n${text}` : text);
  }
  return into;
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

function stagedContent(top: string): Map<string, string> {
  return entryContent(top, rawEntries(rawChanges(top, ['--cached', headId(top) ?? emptyTree(top)])));
}

function worktreeContent(top: string): Map<string, string> {
  const entries = rawEntries(rawChanges(top, []));
  storedAsOnDisk(top, entries.filter((e) => !e.after).map((e) => e.path));
  return entryContent(top, entries);
}

function untrackedContent(top: string): Map<string, string> {
  const paths = untrackedNames(top);
  storedAsOnDisk(top, paths);
  const out = new Map<string, string>();
  for (const path of paths) {
    const now = fromDisk(top, path);
    if (now !== null) out.set(path, newLines(null, now));
  }
  return out;
}

/** Attributes under which git stores something other than a working-tree file's bytes. */
const CONVERTING = ['filter', 'working-tree-encoding'];

/**
 * Throws unless git stores each of these working-tree files as the bytes on disk the scan reads. INVARIANT (#971): a
 * file with a filter or an encoding attribute, from any attributes source (the worktree's, the index's, the repo's or
 * the user's), refuses the commit; the scan never runs a filter itself.
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

/** The current commit's changes against each of its parents (none: the empty tree). */
function headContent(top: string): Map<string, string> {
  const head = headId(top);
  if (!head) throw new Error('there is no commit to amend');
  const parents = gitOut(top, ['rev-list', '--parents', '-n', '1', head]).toString('latin1').trim().split(/\s+/).slice(1);
  const out = new Map<string, string>();
  for (const parent of parents.length ? parents : [emptyTree(top)]) entryContent(top, rawEntries(rawChanges(top, [parent, head])), out);
  return out;
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

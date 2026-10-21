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
    const findings: Finding[] = [];
    for (const [i, [what, read]] of routes.entries()) {
      const files = read();
      if (!files.size) continue;
      const dir = join(tmp, `route-${i}`);
      for (const [path, text] of files) {
        const parts = path.split('/');
        if (!path || path.startsWith('/') || parts.some((p) => p === '..' || p === '')) throw new Error(`an unexpected path from git: ${JSON.stringify(path)}`);
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text, 'latin1');
      }
      const report = join(tmp, `report-${i}.json`);
      const r = spawnSync(binary, ['dir', '.', '--config', config, '--gitleaks-ignore-path', tmp, '--redact', '--no-banner', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
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

/** The lines of `now` that `before` doesn't have, in order, a blank line between runs; NUL bytes dropped. */
function newLines(before: Buffer | null, now: Buffer): string {
  const text = (b: Buffer) => b.toString('latin1').replace(/\0/g, '');
  const lines = text(now).split('\n');
  if (!before) return lines.join('\n');
  const had = new Set(text(before).split('\n'));
  const out: string[] = [];
  for (const l of lines) {
    if (!had.has(l)) out.push(l);
    else if (out.length && out.at(-1) !== '') out.push('');
  }
  return out.join('\n');
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
  return entryContent(top, rawEntries(rawChanges(top, [])));
}

function untrackedContent(top: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of untrackedNames(top)) {
    const now = fromDisk(top, path);
    if (now !== null) out.set(path, newLines(null, now));
  }
  return out;
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

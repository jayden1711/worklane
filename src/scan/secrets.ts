// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawn, spawnSync } from '../os/child-process.js';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 */
export function scanCommit(top: string, scope: CommitScanScope, binary = findTool('gitleaks')): ScanResult {
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const findings: Finding[] = [];
  let tmp: string | null = null;
  try {
    const runs: { args: string[]; env?: NodeJS.ProcessEnv; what: string }[] = [{ args: ['--pre-commit', '--staged'], what: '(staged changes)' }];
    if (scope.untracked) {
      // WHY: untracked files show in git's diff only once in the index; a copy of the index gets them as
      // intent-to-add entries, so the checkout's own index is never changed.
      tmp = mkdtempSync(join(tmpdir(), 'scan-index-'));
      const index = untrackedIndex(top, join(tmp, 'index'));
      if ('error' in index) return { status: 'unavailable', error: index.error };
      runs.push({ args: ['--pre-commit'], env: { ...process.env, GIT_INDEX_FILE: index.path }, what: '(working tree)' });
    } else if (scope.unstaged) runs.push({ args: ['--pre-commit'], what: '(unstaged changes)' });
    if (scope.head) runs.push({ args: ['--log-opts=-n1 -m HEAD'], what: '(the commit being amended)' });
    for (const run of runs) {
      const r = spawnSync(binary, ['git', ...run.args, '--redact', '--no-banner', '--exit-code', String(LEAKS_EXIT), '.'], { cwd: top, encoding: 'utf8', timeout: 120_000, ...(run.env ? { env: run.env } : {}) });
      if (r.error) return { status: 'unavailable', error: r.error.message };
      if (r.status === LEAKS_EXIT) findings.push({ rule: 'see gitleaks output', file: run.what, line: 0 });
      else if (r.status !== 0) return { status: 'unavailable', error: `gitleaks exited ${r.status}` };
    }
    return findings.length ? { status: 'leaks', findings } : { status: 'clean' };
  } catch (e) {
    return { status: 'unavailable', error: (e as Error).message };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** A copy of the checkout's index at `path` with every untracked, not ignored file added as intent-to-add. */
function untrackedIndex(top: string, path: string): { path: string } | { error: string } {
  const git = (args: string[], env?: NodeJS.ProcessEnv, input?: string) => spawnSync('git', args, { cwd: top, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}), ...(input !== undefined ? { input } : {}) });
  const where = git(['rev-parse', '--git-path', 'index']);
  if (where.error || where.status !== 0) return { error: `git rev-parse failed: ${(where.stderr || '').trim().split('\n').pop()}` };
  const real = resolve(top, where.stdout.trim());
  if (existsSync(real)) copyFileSync(real, path);
  const list = git(['ls-files', '-z', '--others', '--exclude-standard']);
  if (list.error || list.status !== 0) return { error: `git ls-files failed: ${(list.stderr || '').trim().split('\n').pop()}` };
  if (list.stdout) {
    const add = git(['--literal-pathspecs', 'add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...process.env, GIT_INDEX_FILE: path }, list.stdout);
    if (add.error || add.status !== 0) return { error: `git add -N failed: ${(add.stderr || '').trim().split('\n').pop()}` };
  }
  return { path };
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

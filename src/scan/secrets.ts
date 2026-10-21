// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawn, spawnSync } from '../os/child-process.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv, gitExecFileSync, gitSnapshot, type GitSnapshot } from '../os/git.js';
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

/** Scan what a `git commit` is about to record: staged changes, plus unstaged ones for `commit -a`. */
export function scanCommit(cwd: string, includeUnstaged: boolean, binary = findTool('gitleaks')): ScanResult {
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const findings: Finding[] = [];
  for (const args of includeUnstaged ? [['--staged'], []] : [['--staged']]) {
    const r = spawnSync(binary, ['git', '--pre-commit', ...args, '--redact', '--no-banner', '--exit-code', String(LEAKS_EXIT), '.'], { cwd, encoding: 'utf8', timeout: 120_000, env: gitEnv() });
    if (r.error) return { status: 'unavailable', error: r.error.message };
    if (r.status === LEAKS_EXIT) findings.push({ rule: 'see gitleaks output', file: '(staged changes)', line: 0 });
    else if (r.status !== 0) return { status: 'unavailable', error: `gitleaks exited ${r.status}` };
  }
  return findings.length ? { status: 'leaks', findings } : { status: 'clean' };
}

/**
 * Scan exactly what a change adds: the commits in `range` (e.g. base..head).
 * Async, so a long scan doesn't stall the coordinator's other runs. Scanning
 * the commits rather than the worktree keeps dependencies (node_modules and
 * their bundled test keys) out of it.
 */
export function scanRange(cwd: string, range: string, binary = findTool('gitleaks')): Promise<ScanResult> {
  if (!binary) return Promise.resolve({ status: 'unavailable', error: 'gitleaks not found on PATH' });
  // gitleaks walks the range with git: through one gitSnapshot whose shallow file was checked, so a cut written or
  // removed while it runs changes nothing, and a cut inside the range is never "clean" (#927). Commit ids only there.
  let snap: GitSnapshot;
  let ids: string;
  try {
    const m = /^([^.].*?)\.\.([^.].*)$/.exec(range);
    if (!m) throw new Error(`${range} is not a base..head range`);
    const id = (r: string) => gitExecFileSync(['rev-parse', '--verify', '--end-of-options', `${r}^{commit}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const [base, head] = [id(m[1]!), id(m[2]!)];
    snap = gitSnapshot(cwd);
    const cut = (() => {
      try {
        return snap.cutInRange(base, head);
      } catch (e) {
        snap.dispose();
        throw e;
      }
    })();
    if (cut.length) {
      snap.dispose();
      return Promise.resolve({ status: 'unavailable', error: `the repo's history is cut inside ${range} (a shallow boundary at ${cut[0]!.slice(0, 12)}): it can't be scanned whole` });
    }
    ids = `${base}..${head}`;
  } catch (e) {
    return Promise.resolve({ status: 'unavailable', error: `can't read ${range} whole: ${String((e as Error).message).split('\n')[0]}` });
  }
  return scanAsync(binary, (report) => ['git', '--redact', '--no-banner', '--log-opts', ids, '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT), '.'], cwd, snap.env).finally(() => snap.dispose());
}

/** Scan one file without blocking (a dashboard upload). Findings name the rule, never the secret (--redact). */
export function scanFile(path: string, binary = findTool('gitleaks')): Promise<ScanResult> {
  if (!binary) return Promise.resolve({ status: 'unavailable', error: 'gitleaks not found on PATH' });
  return scanAsync(binary, (report) => ['dir', path, '--redact', '--no-banner', '--max-decode-depth', '2', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)], undefined);
}

function scanAsync(binary: string, args: (report: string) => string[], cwd: string | undefined, env?: NodeJS.ProcessEnv): Promise<ScanResult> {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const report = join(dir, 'report.json');
  return new Promise((resolve) => {
    // gitleaks runs git itself (`git log -p`): with the git runner's settings, so a replace ref or a graft can't swap
    // the commits it reads (#807).
    const child = spawn(binary, args(report), { ...(cwd ? { cwd } : {}), stdio: ['ignore', 'ignore', 'pipe'], env: gitEnv(env) });
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

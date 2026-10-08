// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which } from '../os/index.js';

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
export function scanPath(path: string, binary = which('gitleaks')): ScanResult {
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
export function scanCommit(cwd: string, includeUnstaged: boolean, binary = which('gitleaks')): ScanResult {
  if (!binary) return { status: 'unavailable', error: 'gitleaks not found on PATH' };
  const findings: Finding[] = [];
  for (const args of includeUnstaged ? [['--staged'], []] : [['--staged']]) {
    const r = spawnSync(binary, ['git', '--pre-commit', ...args, '--redact', '--no-banner', '--exit-code', String(LEAKS_EXIT), '.'], { cwd, encoding: 'utf8', timeout: 120_000 });
    if (r.error) return { status: 'unavailable', error: r.error.message };
    if (r.status === LEAKS_EXIT) findings.push({ rule: 'see gitleaks output', file: '(staged changes)', line: 0 });
    else if (r.status !== 0) return { status: 'unavailable', error: `gitleaks exited ${r.status}` };
  }
  return findings.length ? { status: 'leaks', findings } : { status: 'clean' };
}

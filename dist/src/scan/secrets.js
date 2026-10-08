// Secret scanning behind an adapter (gitleaks today; betterleaks later).
// A scanner that can't run is reported as unavailable, never as "clean".
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which } from '../os/index.js';
const LEAKS_EXIT = 3;
/** Scan a file or directory. Findings never include the secret itself. */
export function scanPath(path, binary = which('gitleaks')) {
    if (!binary)
        return { status: 'unavailable', error: 'gitleaks not found on PATH' };
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    const report = join(dir, 'report.json');
    try {
        const r = spawnSync(binary, ['dir', path, '--redact', '--no-banner', '--max-decode-depth', '2', '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT)], { encoding: 'utf8', timeout: 300_000 });
        if (r.error)
            return { status: 'unavailable', error: r.error.message };
        if (r.status === 0)
            return { status: 'clean' };
        if (r.status === LEAKS_EXIT) {
            const raw = JSON.parse(readFileSync(report, 'utf8'));
            return { status: 'leaks', findings: raw.map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine })) };
        }
        return { status: 'unavailable', error: `gitleaks exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` };
    }
    catch (e) {
        return { status: 'unavailable', error: e.message };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
/** Scan what a `git commit` is about to record: staged changes, plus unstaged ones for `commit -a`. */
export function scanCommit(cwd, includeUnstaged, binary = which('gitleaks')) {
    if (!binary)
        return { status: 'unavailable', error: 'gitleaks not found on PATH' };
    const findings = [];
    for (const args of includeUnstaged ? [['--staged'], []] : [['--staged']]) {
        const r = spawnSync(binary, ['git', '--pre-commit', ...args, '--redact', '--no-banner', '--exit-code', String(LEAKS_EXIT), '.'], { cwd, encoding: 'utf8', timeout: 120_000 });
        if (r.error)
            return { status: 'unavailable', error: r.error.message };
        if (r.status === LEAKS_EXIT)
            findings.push({ rule: 'see gitleaks output', file: '(staged changes)', line: 0 });
        else if (r.status !== 0)
            return { status: 'unavailable', error: `gitleaks exited ${r.status}` };
    }
    return findings.length ? { status: 'leaks', findings } : { status: 'clean' };
}
/**
 * Scan exactly what a change adds: the commits in `range` (e.g. base..head).
 * Async, so a long scan doesn't stall the coordinator's other runs. Scanning
 * the commits rather than the worktree keeps dependencies (node_modules and
 * their bundled test keys) out of it.
 */
export function scanRange(cwd, range, binary = which('gitleaks')) {
    if (!binary)
        return Promise.resolve({ status: 'unavailable', error: 'gitleaks not found on PATH' });
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    const report = join(dir, 'report.json');
    return new Promise((resolve) => {
        const child = spawn(binary, ['git', '--redact', '--no-banner', '--log-opts', range, '--report-format', 'json', '--report-path', report, '--exit-code', String(LEAKS_EXIT), '.'], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-2000)));
        const done = (r) => {
            rmSync(dir, { recursive: true, force: true });
            resolve(r);
        };
        child.on('error', (e) => done({ status: 'unavailable', error: e.message }));
        child.on('close', (code) => {
            if (code === 0)
                return done({ status: 'clean' });
            if (code === LEAKS_EXIT) {
                try {
                    const raw = JSON.parse(readFileSync(report, 'utf8'));
                    return done({ status: 'leaks', findings: raw.map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine })) });
                }
                catch (e) {
                    return done({ status: 'unavailable', error: `unreadable report: ${e.message}` });
                }
            }
            done({ status: 'unavailable', error: `gitleaks exited ${code}: ${err.trim().split('\n').pop() ?? ''}` });
        });
    });
}
//# sourceMappingURL=secrets.js.map
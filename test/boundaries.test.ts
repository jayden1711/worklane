import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPath } from '../src/scan/secrets.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

test('OS-specific code lives only in src/os/', () => {
  const offenders = sources(join(repoRoot, 'src')).filter((f) => !f.includes(`${join('src', 'os')}`) && /process\.platform|\bos\.platform\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('a secret scanner that cannot run is reported as unavailable, never clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  writeFileSync(join(dir, 'a.txt'), 'hello');
  assert.equal(scanPath(dir, null).status, 'unavailable');
  assert.equal(scanPath(dir, join(dir, 'no-such-binary')).status, 'unavailable');
});

test('transcript scan finds a leaked key without echoing it', { skip: !which('gitleaks') && 'gitleaks not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  // A syntactically valid but fake GitHub token, as it would appear in a transcript line.
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ role: 'tool', content: `export GITHUB_TOKEN=${token}` }) + '\n');
  const r = scanPath(join(dir, 'session.jsonl'));
  assert.equal(r.status, 'leaks');
  assert.ok(r.status === 'leaks' && r.findings.length >= 1);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(token));
  assert.equal(scanPath(mkdtempSync(join(tmpdir(), 'clean-'))).status, 'clean');
});

test('change scans cover the change only: a committed secret is caught, untracked dependency files are not scanned', { skip: !which('gitleaks') && 'gitleaks not installed' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const { scanRange } = await import('../src/scan/secrets.js');
  const dir = mkdtempSync(join(tmpdir(), 'range-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  git('add', '-A');
  git('-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'fixture.js'), `const k = '${'ghp_' + 'z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2'}';\n`);
  writeFileSync(join(dir, 'b.js'), 'export const b = 2;\n');
  git('add', '-A');
  git('-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'clean change');
  assert.equal((await scanRange(dir, `${base}..HEAD`)).status, 'clean', 'untracked node_modules is not part of the change');
  writeFileSync(join(dir, 'c.js'), `export const token = '${'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}';\n`);
  git('add', '-A');
  git('-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'leaky change');
  assert.equal((await scanRange(dir, `${base}..HEAD`)).status, 'leaks');
  assert.equal((await scanRange(dir, `${base}..HEAD`, null)).status, 'unavailable', 'no scanner is never clean');
});

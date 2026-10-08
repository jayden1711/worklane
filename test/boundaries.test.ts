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

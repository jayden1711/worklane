import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/check-denylist.mjs', import.meta.url));
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function repo(files: Record<string, string>, allow = '') {
  const dir = mkdtempSync(join(tmpdir(), 'deny-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(
    join(dir, '.denylist.json'),
    JSON.stringify({
      hashed: [sha('acmecorp'), sha('acme-api')],
      patterns: ['\\bD[0-9]{2,4}\\b', '(?<![:/A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?!example\\.com\\b)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'],
    }),
  );
  if (allow) writeFileSync(join(dir, '.denylist-allow'), allow);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return spawnSync('node', [script, dir], { encoding: 'utf8' });
}

test('passes a clean repo', () => {
  assert.equal(repo({ 'a.md': 'a project whose staging and prod share a DB host' }).status, 0);
});

test('catches a hashed term in any case and inside compound words', () => {
  for (const text of ['AcmeCorp ships', 'see https://acmecorp.io/x', 'service acme-api.internal', 'git@acmecorp:x']) {
    const r = repo({ 'a.md': text });
    assert.equal(r.status, 1, text);
    assert.match(r.stderr, /a\.md:1/);
  }
});

test('catches pattern matches: decision ids and non-example emails', () => {
  assert.equal(repo({ 'a.md': 'per D792' }).status, 1);
  assert.equal(repo({ 'a.md': 'mail bob@corp.dev' }).status, 1);
  assert.equal(repo({ 'a.md': 'mail ada@example.com' }).status, 0);
  assert.equal(repo({ 'a.md': 'postgres://app:pw@db.internal:5432/app' }).status, 0, 'credentials in a URL are not an email');
});

test('allowlist permits a term only in the listed path', () => {
  const allow = 'README.md acmecorp\n';
  assert.equal(repo({ 'README.md': 'acmecorp' }, allow).status, 0);
  assert.equal(repo({ 'README.md': 'acmecorp', 'b.md': 'acmecorp' }, allow).status, 1);
});

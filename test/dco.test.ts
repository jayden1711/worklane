import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/check-dco.mjs', import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'dco-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Ada');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a'), '1');
  git('add', 'a');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

const run = (dir: string) => spawnSync('node', [script, 'HEAD~1'], { cwd: dir, encoding: 'utf8' });

test('passes when the commit is signed off by its author', () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, 'a'), '2');
  git('commit', '-q', '-a', '-s', '-m', 'change');
  assert.equal(run(dir).status, 0);
});

test('fails when the sign-off is missing', () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, 'a'), '2');
  git('commit', '-q', '-a', '-m', 'change');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Ada <ada@example.com>/);
});

test('fails when the sign-off names someone other than the author', () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, 'a'), '2');
  git('commit', '-q', '-a', '-m', 'change\n\nSigned-off-by: Bob <bob@example.com>');
  assert.equal(run(dir).status, 1);
});

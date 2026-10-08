import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../src/os/index.js';

const script = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url));
// The script runs `npm` directly, which Windows only provides as npm.cmd; releases are cut on macOS/Linux.
const skip = process.platform === 'win32' && 'releases are cut on macOS or Linux';

/** A repo whose build writes a stub dist/ and whose tests pass, so only the script's git steps are exercised. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git('config', k!, v!);
  const mk = (d: string) => `node -e "require('fs').mkdirSync('dist/${d}',{recursive:true});require('fs').writeFileSync('dist/${d}/x.js','')"`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r', version: '1.2.3', scripts: { build: mk('src'), 'build:web': mk('web'), test: 'node -e ""' } }));
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

const run = (dir: string) => spawnSync('node', [script, '1.2.3'], { cwd: dir, encoding: 'utf8', env: childEnv() });

test('release tags a commit holding dist/ and returns to the branch it started on', { skip }, () => {
  const { dir, git } = repo();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.match(git('ls-tree', '-r', '--name-only', 'v1.2.3'), /dist\/src\/x\.js/);
  assert.equal(git('rev-parse', 'v1.2.3^{commit}^'), git('rev-parse', 'HEAD'));
});

test('regression: a release from a worktree created detached (no previous checkout) returns to that commit', { skip }, () => {
  const { dir, git } = repo();
  const start = git('rev-parse', 'HEAD');
  const wt = join(mkdtempSync(join(tmpdir(), 'release-wt-')), 'wt');
  git('worktree', 'add', '-q', '--detach', wt, 'HEAD');
  const wgit = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8' }).trim();
  const r = run(wt);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(wgit('rev-parse', 'HEAD'), start);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: wt }).status, 1, 'still detached, as it started');
  assert.equal(git('rev-parse', 'v1.2.3^{commit}^'), start);
});

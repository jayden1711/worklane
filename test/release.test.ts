import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../src/os/index.js';

const script = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url));
// The script runs `npm` directly, which Windows only provides as npm.cmd; releases are cut on macOS/Linux.
const skip = process.platform === 'win32' && 'releases are cut on macOS or Linux';

/**
 * A repo whose build writes a stub dist/ and whose tests pass, so only the script's git steps are exercised. Signed
 * with a throwaway SSH key made here for the test (`signed: false`: no signing key at all), with a changelog section.
 */
function repo(o: { signed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...childEnv(), GIT_CONFIG_GLOBAL: join(dir, '.no-global'), GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  if (o.signed !== false) {
    const key = join(mkdtempSync(join(tmpdir(), 'release-key-')), 'key');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ada', '-f', key]);
    const signers = `${key}.allowed`;
    writeFileSync(signers, `ada@example.com namespaces="git" ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`);
    for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key], ['gpg.ssh.allowedSignersFile', signers]]) git('config', k!, v!);
  }
  const mk = (d: string) => `node -e "require('fs').mkdirSync('dist/${d}',{recursive:true});require('fs').writeFileSync('dist/${d}/x.js','')"`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r', version: '1.2.3', scripts: { build: mk('src'), 'build:web': mk('web'), test: 'node -e ""' } }));
  writeFileSync(join(dir, '.gitignore'), 'dist/\n.no-global\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## v1.2.3 (2026-10-12)\n\n### Fixes\n\n- Round totals (#7)\n\n### Guardrail changes\n\n- none in this release\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

const run = (dir: string, ...args: string[]) => spawnSync('node', [script, ...(args.length ? args : ['1.2.3'])], { cwd: dir, encoding: 'utf8', env: { ...childEnv(), GIT_CONFIG_GLOBAL: join(dir, '.no-global'), GIT_CONFIG_NOSYSTEM: '1' } });

test('release signs the tag, on a commit holding dist/, and returns to the branch it started on; the notes are the changelog section', { skip }, () => {
  const { dir, git } = repo();
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.match(git('ls-tree', '-r', '--name-only', 'v1.2.3'), /dist\/src\/x\.js/);
  assert.equal(git('rev-parse', 'v1.2.3^{commit}^'), git('rev-parse', 'HEAD'));
  assert.equal(git('cat-file', '-t', 'v1.2.3'), 'tag');
  assert.match(git('cat-file', '-p', 'v1.2.3'), /-----BEGIN SSH SIGNATURE-----/, 'signed');
  git('tag', '-v', 'v1.2.3'); // throws unless the signature verifies
  const notes = /--notes-file (\S+)/.exec(r.stdout)![1]!;
  assert.match(readFileSync(notes, 'utf8'), /^## v1\.2\.3 \(2026-10-12\)[\s\S]*Round totals \(#7\)/);
  assert.match(r.stdout, /gh release create v1\.2\.3 --verify-tag/);
  // The push it suggests runs only behind the verify; npm gets a staged version the owner approves.
  assert.match(r.stdout, /^push with \(only behind the verify, as its own step\): git tag -v v1\.2\.3 && git push origin v1\.2\.3$/m);
  assert.match(r.stdout, /^CI then stages it on npm; approve it on npmjs\.com with 2FA \(docs\/releasing\.md\)$/m);
});

test('without a signing key the release is refused before anything is built or tagged, with the exact setup commands', { skip }, () => {
  const { dir, git } = repo({ signed: false });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to tag v1\.2\.3: no signing key configured/);
  assert.match(r.stderr, /git config --global gpg\.format ssh\n\s+git config --global user\.signingkey ~\/\.ssh\/id_ed25519\.pub/);
  assert.match(r.stderr, /git config --global user\.signingkey <your key id>/);
  assert.equal(git('tag', '-l'), '');
  assert.equal(existsSync(join(dir, 'dist')), false, 'nothing built');
});

test('a release without its changelog section is refused', { skip }, () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
  git('commit', '-q', '-am', 'drop the section');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHANGELOG\.md at HEAD has no v1\.2\.3 section: run `node scripts\/release\.mjs changelog 1\.2\.3`/);
  assert.equal(git('tag', '-l'), '');
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

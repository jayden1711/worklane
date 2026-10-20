import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
 * `signers`: where the tag is verified from: the configured allowed-signers file (default), only the repo's own
 * .github/release-signers (`repo`), the repo's file listing another key (`other`), or nowhere (`none`).
 */
function repo(o: { signed?: boolean; signers?: 'config' | 'repo' | 'other' | 'none' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...childEnv(), GIT_CONFIG_GLOBAL: join(dir, '.no-global'), GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  if (o.signed !== false) {
    const key = join(mkdtempSync(join(tmpdir(), 'release-key-')), 'key');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ada', '-f', key]);
    const signers = `${key}.allowed`;
    const line = (pub: string) => `release-signer namespaces="git" ${readFileSync(pub, 'utf8').trim()}\n`;
    writeFileSync(signers, line(`${key}.pub`));
    for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key]]) git('config', k!, v!);
    const where = o.signers ?? 'config';
    if (where === 'config' || where === 'other') git('config', 'gpg.ssh.allowedSignersFile', signers);
    if (where === 'repo' || where === 'other') {
      let pub = `${key}.pub`;
      if (where === 'other') {
        const another = join(mkdtempSync(join(tmpdir(), 'release-key-')), 'key');
        spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'eve', '-f', another]);
        pub = `${another}.pub`;
      }
      mkdirSync(join(dir, '.github'));
      writeFileSync(join(dir, '.github', 'release-signers'), line(pub));
    }
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
  // Only after `git tag -v` passed, and last.
  assert.match(r.stdout.trim().split('\n').at(-1)!, /^v1\.2\.3: signed and verified \(git tag -v passed\) at [0-9a-f]{40} \(on top of [0-9a-f]{7}\)\. Nothing is pushed yet\.$/);
});

/** A stand-in for ssh-keygen as git's gpg.ssh.program: `body` handles some calls; the rest go to the real one. */
function signer(dir: string, git: (...a: string[]) => string, body: string) {
  const bin = join(dir, '.signer');
  writeFileSync(bin, `#!/bin/sh\n${body}\nexec ssh-keygen "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, '.gitignore'), 'dist/\n.no-global\n.signer\n');
  git('commit', '-q', '-am', 'ignore the stand-in');
  git('config', 'gpg.ssh.program', bin);
}

/** Every way the tag must be gone after a failed run: no tag, non-zero, no push or success line, back where it started. */
function noTagLeft(r: ReturnType<typeof run>, git: (...a: string[]) => string) {
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(git('tag', '-l'), '', 'no tag left behind');
  assert.doesNotMatch(r.stdout, /push with|git push|gh release create|signed and verified/);
  assert.match(r.stderr, /v1\.2\.3: not verified, so the tag is deleted \(nothing to push\)/);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
}

test('regression (#457): a signer that exits 0 without a real signature: the verify fails and the tag is deleted', { skip: skip || (process.platform === 'win32' && 'POSIX stand-in') }, () => {
  const { dir, git } = repo();
  signer(dir, git, `if [ "$1 $2" = "-Y sign" ]; then for f; do :; done; printf -- '-----BEGIN SSH SIGNATURE-----\\nU1NIU0lH\\n-----END SSH SIGNATURE-----\\n' > "$f.sig"; exit 0; fi`);
  noTagLeft(run(dir), git);
});

test('regression (#457): a tag signed by a key the repo\'s .github/release-signers doesn\'t list (what CI checks) is deleted', { skip }, () => {
  const { dir, git } = repo({ signers: 'other' });
  noTagLeft(run(dir), git);
});

test('regression (#457): Ctrl-C during the verify: node isn\'t killed mid-step, the tag is deleted', { skip: skip || (process.platform === 'win32' && 'POSIX stand-in') }, () => {
  const { dir, git } = repo();
  // As a terminal's Ctrl-C: SIGINT to node (git's parent) and the step's own child fails.
  signer(dir, git, 'case "$2" in find-principals|verify|check-novalidate) kill -INT "$(ps -o ppid= -p "$PPID" | tr -d " ")"; sleep 1; exit 1 ;; esac');
  noTagLeft(run(dir), git);
});

test('the repo\'s own .github/release-signers is enough to verify (no allowed-signers file configured)', { skip }, () => {
  const { dir, git } = repo({ signers: 'repo' });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /v1\.2\.3: signed and verified/);
  assert.equal(git('cat-file', '-t', 'v1.2.3'), 'tag');
});

test('regression (#457): nothing to verify against: refused before anything is built or tagged, with the setup commands', { skip }, () => {
  const { dir, git } = repo({ signers: 'none' });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to tag v1\.2\.3: no allowed-signers file to verify the tag against\. A release tag is verified before it's reported/);
  assert.match(r.stderr, /git config --global gpg\.ssh\.allowedSignersFile ~\/\.ssh\/allowed_signers/);
  assert.equal(git('tag', '-l'), '');
  assert.equal(existsSync(join(dir, 'dist')), false, 'nothing built');
});

test('a tag that already exists is refused before anything is built, and left as it was', { skip }, () => {
  const { dir, git } = repo();
  git('tag', 'v1.2.3');
  const before = git('rev-parse', 'v1.2.3');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to tag v1\.2\.3: it already exists here\. If a failed run left it, check it isn't pushed, then: git tag -d v1\.2\.3/);
  assert.equal(git('rev-parse', 'v1.2.3'), before);
  assert.equal(existsSync(join(dir, 'dist')), false, 'nothing built');
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

test('regression (#712): a release whose changelog section is (unreleased) is refused before anything is built or tagged', { skip }, () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## v1.2.3 (unreleased)\n\n### Fixes\n\n- Round totals (#7)\n\n### Guardrail changes\n\n- none in this release\n');
  git('commit', '-q', '-am', 'an undated section');
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to tag v1\.2\.3: CHANGELOG\.md at HEAD has "## v1\.2\.3 \(unreleased\)", not the dated heading/);
  assert.equal(git('tag', '-l'), '');
  assert.equal(existsSync(join(dir, 'dist')), false, 'nothing built');
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

test('regression (#458): a release commit that isn\'t the built dist/ byte for byte (git converted its line endings) is refused before tagging', { skip }, () => {
  const { dir, git } = repo();
  // As v0.5.0: `* text=auto eol=lf`, and a build output with CRLF in it (tslib's license in licenses.txt).
  writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.scripts['build:web'] = `node -e "require('fs').mkdirSync('dist/web',{recursive:true});require('fs').writeFileSync('dist/web/licenses.txt','MIT\\r\\nline two\\r\\n')"`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  git('add', '.gitattributes', 'package.json');
  git('commit', '-q', '-m', 'a CRLF build');
  const r = run(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /refusing to tag v1\.2\.3: the release commit isn't the built dist\/ byte for byte \(a rebuild of the tag wouldn't match it\):\n {2}differs from the signed tree: dist\/web\/licenses\.txt/);
  assert.equal(git('tag', '-l'), '', 'no tag');
  assert.doesNotMatch(r.stdout, /push with|signed and verified/);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
});

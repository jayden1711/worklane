// scripts/verify-release-tag.mjs: release.yml stages a version on npm only for a tag signed by a key in main's
// .github/release-signers that points at the commit the run builds. Real git, real SSH keys, a throwaway repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = (process.platform === 'win32' || !which('ssh-keygen')) && 'needs ssh-keygen and a POSIX shell';

/** A clone whose origin/main carries .github/release-signers listing the owner's key; release commits sit on top. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-release-tag-'));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const repo = join(dir, 'repo');
  const sh = (cmd: string, args: string[], input?: string) => {
    const r = spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8', input });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const key = (name: string) => {
    const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return join(dir, name);
  };
  const owner = key('owner');
  const stranger = key('stranger');
  const pub = (k: string) => readFileSync(`${k}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
  // As the committed file: a comment, then the principal with the git namespace.
  const signersFor = (k: string) => `# release signers\nrelease-signer namespaces="git" ${pub(k)}\n`;
  const signersFile = join(repo, '.github', 'release-signers');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { env }).status, 0, 'git init');
  mkdirSync(join(repo, '.github'));
  writeFileSync(signersFile, signersFor(owner));
  sh('git', ['add', '.github/release-signers']);
  sh('git', ['commit', '-q', '-m', 'main']);
  sh('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  let n = 0;
  /** A release commit on top of main, as release.mjs makes one; `signers` rewrites the file in its own tree. */
  const commit = (signers?: string) => {
    sh('git', ['checkout', '-q', '--detach', 'main']);
    writeFileSync(join(repo, 'f'), String(++n));
    sh('git', ['add', 'f']);
    if (signers !== undefined) {
      writeFileSync(signersFile, signers);
      sh('git', ['add', '.github/release-signers']);
    }
    sh('git', ['commit', '-q', '-m', `release ${n}`]);
    return sh('git', ['rev-parse', 'HEAD']);
  };
  const tag = (name: string, signWith?: string, how: 'signed' | 'annotated' | 'lightweight' = signWith ? 'signed' : 'annotated') => {
    if (how === 'signed') sh('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signWith}`, 'tag', '-s', name, '-m', name]);
    else if (how === 'annotated') sh('git', ['tag', '-a', name, '-m', name]);
    else sh('git', ['tag', name]);
  };
  const verify = (tagName: string, sha: string, ...extra: string[]) => {
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-release-tag.mjs'), tagName, '--commit', sha, ...extra], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { dir, repo, owner, stranger, signersFor, sh, commit, tag, verify };
}

const refused = (r: { code: number | null; out: string }, why: RegExp) => {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /verify-release-tag: refused: /);
  assert.match(r.out, why);
};

test('verify-release-tag: a tag signed by a key main lists, at the commit the run builds, verifies', { skip }, () => {
  const f = fixture();
  const sha = f.commit();
  f.tag('v1.0.0', f.owner);
  const r = f.verify('v1.0.0', sha);
  assert.equal(r.code, 0, r.out);
  const fp = spawnSync('ssh-keygen', ['-lf', `${f.owner}.pub`], { encoding: 'utf8' }).stdout.split(' ')[1];
  const main = f.sh('git', ['rev-parse', 'refs/remotes/origin/main']);
  assert.equal(r.out.trim(), `verified v1.0.0 ${sha} ${fp} (signers: refs/remotes/origin/main:.github/release-signers at ${main})`);
});

test("verify-release-tag reads the signers from main, never the tag's own tree: a tag can't bring its own signer", { skip }, () => {
  const f = fixture();
  // The tagged commit's tree lists the stranger (and drops the owner), and the stranger signs: refused.
  const own = f.commit(f.signersFor(f.stranger));
  f.tag('v2.0.0', f.stranger);
  refused(f.verify('v2.0.0', own), /v2\.0\.0 is signed by a key refs\/remotes\/origin\/main:\.github\/release-signers doesn't list for release-signer/);
  // Even with that file sitting in the working tree, as a checkout of the tag leaves it: main's is the one read.
  f.sh('git', ['checkout', '-q', '--detach', 'v2.0.0']);
  refused(f.verify('v2.0.0', own), /doesn't list for release-signer/);
  // Main's file is the one used: the owner's tag verifies though its own tree no longer lists the owner.
  const dropped = f.commit('# no one\n');
  f.tag('v2.0.1', f.owner);
  assert.equal(f.verify('v2.0.1', dropped).code, 0, 'verified against main');
  // A ref named explicitly is read the same way, and one without the file is refused.
  refused(f.verify('v2.0.1', dropped, '--signers-ref', 'v2.0.1'), /v2\.0\.1:\.github\/release-signers lists no key for release-signer/);
  // No main to read: refused, never a fallback to the working tree.
  f.sh('git', ['update-ref', '-d', 'refs/remotes/origin/main']);
  refused(f.verify('v2.0.1', dropped), /no refs\/remotes\/origin\/main here to read \.github\/release-signers from/);
  rmSync(f.dir, { recursive: true, force: true });
});

test('verify-release-tag refuses, naming why: unsigned, lightweight, another key, moved, tampered, missing', { skip }, () => {
  const f = fixture();
  const a = f.commit();
  f.tag('v1.0.1');
  refused(f.verify('v1.0.1', a), /v1\.0\.1 is not signed/);
  f.tag('v1.0.2', undefined, 'lightweight');
  refused(f.verify('v1.0.2', a), /v1\.0\.2 is a lightweight tag/);
  f.tag('v1.0.3', f.stranger);
  refused(f.verify('v1.0.3', a), /v1\.0\.3 is signed by a key .* doesn't list for release-signer \(SHA256:/);
  // The run was triggered for a, then the tag was moved (deleted and signed again) onto a newer commit.
  f.tag('v1.0.4', f.owner);
  const b = f.commit();
  f.sh('git', ['tag', '-d', 'v1.0.4']);
  f.tag('v1.0.4', f.owner);
  refused(f.verify('v1.0.4', a), new RegExp(`v1\\.0\\.4 points at ${b}, but this run builds ${a}: the tag moved`));
  // A good signature carried over to a tag object it wasn't made for.
  f.tag('v1.0.5', f.owner);
  const forged = f.sh('git', ['cat-file', 'tag', 'v1.0.5']).replace('tag v1.0.5', 'tag v1.0.6') + '\n';
  f.sh('git', ['update-ref', 'refs/tags/v1.0.6', f.sh('git', ['mktag'], forged)]);
  refused(f.verify('v1.0.6', b), /v1\.0\.6's signature doesn't verify/);
  // A tag object filed under another tag's name.
  f.sh('git', ['update-ref', 'refs/tags/v1.0.7', f.sh('git', ['rev-parse', 'refs/tags/v1.0.5'])]);
  refused(f.verify('v1.0.7', b), /refs\/tags\/v1\.0\.7 holds a tag object named v1\.0\.5/);
  refused(f.verify('v9.9.9', b), /no tag v9\.9\.9 here/);
  // The listed key under a different principal than the one asked for.
  refused(f.verify('v1.0.5', b, '--principal', 'someone-else'), /lists no key for someone-else/);
  refused(f.verify('v1.0.5', 'abc123'), /--commit must be a full commit id/);
  // And the one that is right still passes, so each refusal above is about its own fault.
  assert.equal(f.verify('v1.0.5', b).code, 0);
  rmSync(f.dir, { recursive: true, force: true });
});

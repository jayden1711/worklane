// scripts/pin-engine.mjs: bootstrap.sh's ENGINE_TAG/ENGINE_COMMIT are written only for a tag whose signature
// verifies and whose commit is a release commit. Real git, a real SSH signing key, a throwaway repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const p = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'engine-pin.mjs')).href)) as {
  readPin(text: string): { tag: string; commit: string };
  writePin(text: string, tag: string, commit: string): string;
  releaseProblem(version: string, facts: { parents: number; changed: string[]; hasCli: boolean; version: string | null; parentOnMain: boolean }): string | null;
};
const skip = (process.platform === 'win32' || !which('ssh-keygen')) && 'needs ssh-keygen and a POSIX shell';
const SHA = 'a'.repeat(40);
const BOOT = '#!/usr/bin/env bash\nCLAUDE_VERSION=1\nENGINE_TAG=v0.5.0\nENGINE_COMMIT= # NOT FILLED IN\nPREFIX=x\n';

test('the pin: read from the two lines (a trailing comment is no value), written only as a release tag and a full commit', () => {
  assert.deepEqual(p.readPin(BOOT), { tag: 'v0.5.0', commit: '' });
  const pinned = p.writePin(BOOT, 'v0.5.0', SHA);
  assert.equal(pinned, BOOT.replace('ENGINE_COMMIT= # NOT FILLED IN', `ENGINE_COMMIT=${SHA}`), 'only that line changes');
  assert.deepEqual(p.readPin(pinned), { tag: 'v0.5.0', commit: SHA });
  assert.throws(() => p.writePin(BOOT, 'v0.5.0', 'abc1234'), /not a full commit id/);
  assert.throws(() => p.writePin(BOOT, 'main', SHA), /not a release tag/);
  assert.throws(() => p.readPin('ENGINE_TAG=v1.0.0\n'), /exactly one/);
  assert.throws(() => p.readPin(`${BOOT}ENGINE_COMMIT=${SHA}\n`), /exactly one/);
});

test('a release commit: one parent on main, dist/ only, dist/src/cli.js in it, at the version', () => {
  const good = { parents: 1, changed: ['dist/src/cli.js', 'dist/web/index.html'], hasCli: true, version: '0.5.0', parentOnMain: true };
  assert.equal(p.releaseProblem('0.5.0', good), null);
  assert.match(p.releaseProblem('0.5.0', { ...good, hasCli: false })!, /carries no built dist\/src\/cli\.js/);
  assert.match(p.releaseProblem('0.5.0', { ...good, changed: ['dist/src/cli.js', 'src/cli.ts'] })!, /more than dist\/.*src\/cli\.ts/);
  assert.match(p.releaseProblem('0.5.0', { ...good, version: '0.4.1' })!, /package\.json is 0\.4\.1, not 0\.5\.0/);
  assert.match(p.releaseProblem('0.5.0', { ...good, parentOnMain: false })!, /isn't a commit on origin\/main/);
  assert.match(p.releaseProblem('0.5.0', { ...good, parents: 2 })!, /has 2 parents/);
});

/** A clone with origin/main, a release commit on top carrying dist/, and an SSH key with its allowed signers file. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pin-engine-'));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const repo = join(dir, 'repo');
  const sh = (cmd: string, args: string[], cwd = repo) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const key = (name: string) => {
    sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)], dir);
    return join(dir, name);
  };
  const owner = key('owner');
  const stranger = key('stranger');
  const signers = join(dir, 'allowed_signers');
  writeFileSync(signers, `owner@example.com ${readFileSync(`${owner}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  sh('git', ['init', '-q', '-b', 'main', repo], dir);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  writeFileSync(join(repo, 'scripts', 'bootstrap.sh'), BOOT);
  sh('git', ['add', '.']);
  sh('git', ['commit', '-q', '-m', 'main']);
  sh('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  // As release.mjs does it: main at the version (origin/main follows), then one commit on it adding dist/.
  const release = (files: Record<string, string>, tag: string, signWith?: string) => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: tag.slice(1) }));
    sh('git', ['commit', '-q', '-m', `version ${tag}`, 'package.json']);
    sh('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    sh('git', ['checkout', '-q', '--detach', 'main']);
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), body);
      sh('git', ['add', '-f', f]);
    }
    sh('git', ['commit', '-q', '-m', `Release ${tag}`]);
    if (signWith) sh('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signWith}`, 'tag', '-s', tag, '-m', tag]);
    else sh('git', ['tag', '-a', tag, '-m', tag]);
    const commit = sh('git', ['rev-parse', 'HEAD']);
    sh('git', ['checkout', '-q', 'main']);
    return commit;
  };
  const pin = (...args: string[]) => {
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'pin-engine.mjs'), ...args], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, boot: readFileSync(join(repo, 'scripts', 'bootstrap.sh'), 'utf8') };
  };
  const config = (key: string, value: string) => sh('git', ['config', key, value]);
  return { owner, stranger, signers, release, pin, config, bootPath: join(repo, 'scripts', 'bootstrap.sh') };
}

test('pin-engine: a signed release tag is pinned at its commit; nothing else in bootstrap.sh changes', { skip }, () => {
  const f = fixture();
  const commit = f.release({ 'dist/src/cli.js': '#!/usr/bin/env node\n' }, 'v0.5.0', f.owner);
  const r = f.pin('v0.5.0', '--allowed-signers', f.signers);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.boot, BOOT.replace('ENGINE_COMMIT= # NOT FILLED IN', `ENGINE_COMMIT=${commit}`));
  assert.match(r.out, /signature verified/);
});

test('pin-engine refuses, writing nothing: unsigned, signed by a key not listed, no way to verify, no dist/, more than dist/, a missing tag', { skip }, () => {
  const f = fixture();
  const refused = (r: { code: number | null; out: string; boot: string }, why: RegExp, what = String(why)) => {
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, why, what);
    assert.equal(r.boot, BOOT, 'bootstrap.sh unchanged');
  };
  f.release({ 'dist/src/cli.js': 'x' }, 'v0.5.0', undefined);
  refused(f.pin('v0.5.0', '--allowed-signers', f.signers), /v0\.5\.0's signature doesn't verify/);
  f.release({ 'dist/src/cli.js': 'x' }, 'v0.5.1', f.stranger);
  refused(f.pin('v0.5.1', '--allowed-signers', f.signers), /v0\.5\.1's signature doesn't verify/);
  f.release({ 'dist/src/cli.js': 'x' }, 'v0.5.2', f.owner);
  refused(f.pin('v0.5.2'), /v0\.5\.2's signature doesn't verify: .*allowedSignersFile/, 'no signers given, no git config to verify an SSH signature with');
  f.config('gpg.format', 'ssh');
  refused(f.pin('v0.5.2'), /can't check v0\.5\.2's signature here: pass --allowed-signers/);
  f.config('gpg.ssh.allowedSignersFile', f.signers);
  const viaConfig = f.pin('v0.5.2');
  assert.equal(viaConfig.code, 0, `the clone's own git config verifies it: ${viaConfig.out}`);
  assert.match(viaConfig.boot, /^ENGINE_TAG=v0\.5\.2\nENGINE_COMMIT=[0-9a-f]{40}$/m, 'the tag pinned is the one checked');
  writeFileSync(f.bootPath, BOOT);
  f.release({ 'dist/web/index.html': 'x' }, 'v0.5.3', f.owner);
  refused(f.pin('v0.5.3', '--allowed-signers', f.signers), /carries no built dist\/src\/cli\.js: not a release commit/);
  f.release({ 'dist/src/cli.js': 'x', 'src/cli.ts': 'x' }, 'v0.5.4', f.owner);
  refused(f.pin('v0.5.4', '--allowed-signers', f.signers), /changes more than dist\/ .*src\/cli\.ts/);
  refused(f.pin('v0.9.9', '--allowed-signers', f.signers), /no tag v0\.9\.9 here/);
});

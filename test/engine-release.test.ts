// scripts/setup/engine.sh (#832): the hardened install builds a release as root only after its tag is checked, at
// install time, by the engine updater's own verifyRelease (scripts/setup/engine-release.cjs): refs/tags/<tag> resolved
// once to one tag object, its SSH signature verified against the .github/release-signers of the checkout engine.sh
// runs from (never origin's), the object naming itself <tag>, its commit the pinned one; then exactly that commit is
// checked out, never the name again. Real git, real SSH keys, throwaway repos in a temp dir. Nothing runs as root:
// `id` says 0, and `npm` (the first step of the build) records the commit it was asked to build and stops the run,
// so nothing after it (install into /opt, links) is ever reached; those commands are tripwires anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = (process.platform === 'win32' || !which('ssh-keygen')) && 'needs ssh-keygen and a POSIX shell';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'engine-release-'));
  const tmp = join(dir, 'tmp');
  const bin = join(dir, 'bin');
  mkdirSync(tmp);
  mkdirSync(bin);
  const npmLog = join(dir, 'npm.log');
  const trips = join(dir, 'tripwires.log');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // A stand-in root: `id -u` says 0, so engine.sh's as_root never reaches sudo (a tripwire too).
  stub('id', 'case "$1" in -u) echo 0 ;; *) exit 1 ;; esac');
  // The build's first command: record which commit it was asked to build, then stop the run there.
  stub('npm', `echo "npm $1 at $(git rev-parse HEAD)" >> "${npmLog}"; exit 1`);
  for (const t of ['sudo', 'install', 'ln', 'chown', 'chmod', 'mv']) stub(t, `echo "${t} $*" >> "${trips}"; exit 99`);
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    TMPDIR: tmp,
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const sh = (cwd: string, cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const key = (name: string) => {
    sh(dir, 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)]);
    return join(dir, name);
  };
  const owner = key('owner');
  const stranger = key('stranger');
  const signersFor = (k: string) => `# release signers\nrelease-signer namespaces="git" ${readFileSync(`${k}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`;

  // The public repo (origin): main, and release commits cut from it that add only dist/.
  const origin = join(dir, 'origin');
  const put = (repo: string, files: Record<string, string>) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), body);
      sh(repo, 'git', ['add', '-f', f]);
    }
  };
  sh(dir, 'git', ['init', '-q', '-b', 'main', origin]);
  put(origin, { 'README': 'engine\n', 'package.json': '{"name":"engine"}\n', '.github/release-signers': signersFor(owner) });
  sh(origin, 'git', ['commit', '-q', '-m', 'main']);
  let n = 0;
  /** A commit cut from main (dist/ only unless `files` says more); main itself stays where it is. */
  const cut = (files: Record<string, string> = {}) => {
    sh(origin, 'git', ['checkout', '-q', '--detach', 'main']);
    put(origin, { 'dist/src/cli.js': `// build ${++n}\n`, ...files });
    sh(origin, 'git', ['commit', '-q', '-m', `release ${n}`]);
    const c = sh(origin, 'git', ['rev-parse', 'HEAD']);
    sh(origin, 'git', ['checkout', '-q', 'main']);
    return c;
  };
  /** Tag `commit` in origin as `name`: signed by `signWith`, or annotated and unsigned, or lightweight. `-f` moves it. */
  const tag = (name: string, commit: string, how: { signWith?: string; lightweight?: boolean } = {}) => {
    if (how.lightweight) sh(origin, 'git', ['tag', '-f', name, commit]);
    else if (how.signWith) sh(origin, 'git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${how.signWith}`, 'tag', '-f', '-s', name, '-m', name, commit]);
    else sh(origin, 'git', ['tag', '-f', '-a', name, '-m', name, commit]);
  };
  /** A commit on main (moves main), e.g. someone with push access changing origin's own files. */
  const onMain = (files: Record<string, string>) => {
    put(origin, files);
    sh(origin, 'git', ['commit', '-q', '-m', 'on main']);
    return sh(origin, 'git', ['rev-parse', 'HEAD']);
  };

  // The checkout engine.sh runs from (a clone of origin, as an operator has it), with this tree's setup scripts and the
  // updater beside them, and its own .github/release-signers: the trusted list.
  const checkout = join(dir, 'checkout');
  sh(dir, 'git', ['clone', '-q', origin, checkout]);
  for (const f of ['scripts/setup/engine.sh', 'scripts/setup/lib.sh', 'scripts/setup/engine-release.cjs', 'scripts/machine/worklane-update.cjs', 'scripts/lib/git.cjs']) {
    if (!existsSync(join(repoRoot, f))) continue;
    mkdirSync(join(checkout, f, '..'), { recursive: true });
    copyFileSync(join(repoRoot, f), join(checkout, f));
  }
  const engineSh = join(checkout, 'scripts', 'setup', 'engine.sh');
  const signersFile = join(checkout, '.github', 'release-signers');
  const run = (...args: string[]) => {
    rmSync(npmLog, { force: true });
    const r = spawnSync('bash', [engineSh, ...args], { cwd: dir, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr, built: existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n') : [] };
  };
  const tripped = () => (existsSync(trips) ? readFileSync(trips, 'utf8') : '');
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { owner, stranger, signersFor, sh, origin, cut, tag, onMain, checkout, signersFile, run, tripped, done };
}

/** engine.sh refused before any build: non-zero, npm never ran, and the reason given. */
const refused = (r: { code: number | null; out: string; built: string[] }, why: RegExp) => {
  assert.notEqual(r.code, 0, r.out);
  assert.deepEqual(r.built, [], `nothing was built: ${r.out}`);
  assert.match(r.out, why);
};

test('engine.sh --release builds exactly the pinned commit, once its signed tag names itself and points at it', { skip }, () => {
  const f = fixture();
  const c1 = f.cut();
  f.tag('v1.0.0', c1, { signWith: f.owner });
  const r = f.run('--release', 'v1.0.0', c1);
  assert.deepEqual(r.built, [`npm ci at ${c1}`], r.out);
  assert.match(r.out, /verified v1\.0\.0: tag object [0-9a-f]{40}, commit [0-9a-f]{40}/);
  assert.equal(f.tripped(), '', 'nothing past the build ran');
  f.done();
});

test("engine.sh: the hardened bootstrap's old by-name call, and a moved tag, never build what origin's tag now names", { skip }, () => {
  const f = fixture();
  const c1 = f.cut();
  f.tag('v1.0.0', c1, { signWith: f.owner });
  // Someone with push access but no signing key moves v1.0.0 to a commit of their own.
  const evil = f.cut({ 'dist/src/cli.js': '// not the release\n' });
  f.tag('v1.0.0', evil, { lightweight: true });
  // The step as bootstrap.sh passed it before #832: the tag by name.
  refused(f.run('v1.0.0'), /a tag is a name origin can move: install a release as engine\.sh --release <vX\.Y\.Z> <its commit>/);
  refused(f.run('--release', 'v1.0.0', c1), /v1\.0\.0 is a lightweight tag: it can't carry a signature/);
  f.tag('v1.0.0', evil);
  refused(f.run('--release', 'v1.0.0', c1), /v1\.0\.0's signature doesn't verify against \S+release-signers/);
  // Re-signed by a real signer, but at another release than the pin: refused for the pin.
  const c3 = f.cut();
  f.tag('v1.0.0', c3, { signWith: f.owner });
  refused(f.run('--release', 'v1.0.0', c1), new RegExp(`v1\\.0\\.0 is signed and names itself, but points at ${c3}, not the pinned ${c1}`));
  // A branch by name, likewise.
  refused(f.run('main'), /a tag is a name origin can move/);
  assert.equal(f.tripped(), '');
  f.done();
});

test('engine.sh --release fails closed: another key, origin adding its own signer, a replayed tag, another version, a malformed tag, no signers, not a release commit', { skip }, () => {
  const f = fixture();
  const c1 = f.cut();
  f.tag('v1.0.0', c1, { signWith: f.stranger });
  refused(f.run('--release', 'v1.0.0', c1), /v1\.0\.0's signature doesn't verify against/);
  // Origin's own .github/release-signers gains the stranger: the checkout's file is the one read.
  f.onMain({ '.github/release-signers': f.signersFor(f.stranger) });
  refused(f.run('--release', 'v1.0.0', c1), /v1\.0\.0's signature doesn't verify against/);
  // An older release's signed tag object, put under the newer name.
  const c09 = f.cut();
  f.tag('v0.9.0', c09, { signWith: f.owner });
  f.sh(f.origin, 'git', ['update-ref', 'refs/tags/v1.0.0', f.sh(f.origin, 'git', ['rev-parse', 'refs/tags/v0.9.0'])]);
  refused(f.run('--release', 'v1.0.0', c09), /v1\.0\.0's signed tag object names itself v0\.9\.0: a signed tag counts only under its own name/);
  // A pin naming another version's commit under this tag name.
  f.tag('v1.0.0', c1, { signWith: f.owner });
  refused(f.run('--release', 'v1.0.0', c09), new RegExp(`points at ${c1}, not the pinned ${c09}`));
  // Tag and commit as bootstrap.sh would never write them.
  for (const bad of ['v1.0.0#x', 'v1.0.0 ', 'latest', '-c']) refused(f.run('--release', bad, c1), /isn't a release tag vX\.Y\.Z/);
  for (const bad of ['', c1.slice(0, 12), `${c1}#x`]) refused(f.run('--release', 'v1.0.0', bad), /isn't a full commit id/);
  // A signed tag whose commit changes more than dist/: not a release commit.
  const odd = f.cut({ 'scripts/setup/engine.sh': 'echo planted\n' });
  f.tag('v1.1.0', odd, { signWith: f.owner });
  refused(f.run('--release', 'v1.1.0', odd), /v1\.1\.0's release commit changes more than dist\/: scripts\/setup\/engine\.sh/);
  // No signers file beside the scripts: nothing to verify against.
  rmSync(f.signersFile);
  refused(f.run('--release', 'v1.0.0', c1), /no allowed signers file at \S+release-signers/);
  assert.equal(f.tripped(), '');
  f.done();
});

test('engine.sh <commit id>: by commit, as before (no tag involved)', { skip }, () => {
  const f = fixture();
  const c1 = f.cut();
  const r = f.run(c1);
  assert.deepEqual(r.built, [`npm ci at ${c1}`], r.out);
  assert.doesNotMatch(r.out, /verified/);
  f.done();
});

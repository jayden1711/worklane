#!/usr/bin/env node
// Before CI stages a release on npm (release.yml): the tag is the one the owner signed, and the run builds its commit.
//
//   git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main' '+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z'
//   node scripts/verify-release-tag.mjs vX.Y.Z --commit <sha the run builds> [--signers-ref refs/remotes/origin/main]
//
// The allowed signers are .github/release-signers as committed on main (--signers-ref, read with `git show`), never
// the tagged commit's own tree or a file on disk: a tag can't bring its own signer. It fails closed, naming why,
// unless all of these hold:
//   - refs/tags/vX.Y.Z is an annotated tag object named vX.Y.Z (a lightweight tag can't carry a signature);
//   - it points at --commit (a tag moved after the run was triggered is refused);
//   - it carries an SSH signature (unsigned, or a GPG one, is refused);
//   - that signature verifies, in the "git" namespace, against a key main's release-signers lists for the principal
//     (default release-signer): `ssh-keygen -Y verify` on the tag's payload, as git itself checks it. Not
//     `git verify-tag`, which matches the signer to the tagger's email.
// On success it prints `verified <tag> <commit> <key fingerprint>` and exits 0.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIGNERS_PATH = '.github/release-signers';
const args = process.argv.slice(2);
const tag = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`verify-release-tag: refused: ${msg}`);
  process.exit(1);
};
const usage = 'usage: verify-release-tag.mjs vX.Y.Z --commit <sha> [--signers-ref <ref>] [--principal <name>]';
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) fail(usage);
const commit = opt('commit');
const signersRef = opt('signers-ref') ?? 'refs/remotes/origin/main';
const principal = opt('principal') ?? 'release-signer';
if (!commit) fail(usage);
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`--commit must be a full commit id, not "${commit}"`);
if (!/^[\w.@-]+$/.test(principal)) fail(`a principal of letters, digits, ".", "@", "_" or "-", not "${principal}"`);

const git = (...a) => execFileSync('git', a, { stdio: ['ignore', 'pipe', 'pipe'] });
const gitText = (...a) => {
  try {
    return git(...a).toString('utf8').trim();
  } catch {
    return null;
  }
};

// The signers: main's committed file.
const signersCommit = gitText('rev-parse', '-q', '--verify', `${signersRef}^{commit}`);
if (!signersCommit) fail(`no ${signersRef} here to read ${SIGNERS_PATH} from: git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'`);
const signersName = `${signersRef}:${SIGNERS_PATH}`;
const signersText = gitText('show', `${signersCommit}:${SIGNERS_PATH}`);
if (signersText === null) fail(`${signersRef} (${signersCommit}) has no ${SIGNERS_PATH}`);
if (!signersText.split('\n').some((l) => l.trim().split(/\s+/)[0]?.split(',').includes(principal))) fail(`${signersName} lists no key for ${principal}`);

if (gitText('rev-parse', '-q', '--verify', `refs/tags/${tag}`) === null) fail(`no tag ${tag} here: git fetch --no-tags origin '+refs/tags/${tag}:refs/tags/${tag}'`);
if (gitText('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') fail(`${tag} is a lightweight tag: it can't carry a signature`);
const target = gitText('rev-parse', `refs/tags/${tag}^{commit}`);
if (target !== commit) fail(`${tag} points at ${target}, but this run builds ${commit}: the tag moved after the run started`);

// The tag object as git signed it: the payload is everything before the last signature block (git's own split).
const raw = git('cat-file', 'tag', `refs/tags/${tag}`);
const name = /^tag (.+)$/m.exec(raw.toString('utf8'))?.[1];
if (name !== tag) fail(`refs/tags/${tag} holds a tag object named ${name ?? '(none)'}`);
const at = raw.lastIndexOf('\n-----BEGIN SSH SIGNATURE-----\n');
if (at < 0) {
  if (raw.includes('\n-----BEGIN PGP SIGNATURE-----\n')) fail(`${tag} is signed with GPG: only an SSH signature by a key in ${signersName} is accepted`);
  fail(`${tag} is not signed`);
}
const payload = raw.subarray(0, at + 1);
const signature = raw.subarray(at + 1);

const dir = mkdtempSync(join(tmpdir(), 'verify-release-tag-'));
try {
  const sig = join(dir, 'tag.sig');
  const signers = join(dir, 'release-signers');
  writeFileSync(sig, signature);
  writeFileSync(signers, `${signersText}\n`);
  const run = (...a) => spawnSync('ssh-keygen', a, { input: payload, encoding: 'utf8' });
  const r = run('-Y', 'verify', '-f', signers, '-I', principal, '-n', 'git', '-s', sig);
  if (r.error) fail(`can't run ssh-keygen: ${r.error.message}`);
  if (r.status !== 0) {
    // Why: a sound signature by a key main's file doesn't list, or one that doesn't match the tag at all.
    const c = run('-Y', 'check-novalidate', '-n', 'git', '-s', sig);
    const key = /(SHA256:\S+)/.exec(c.stdout + c.stderr)?.[1];
    if (c.status === 0) fail(`${tag} is signed by a key ${signersName} doesn't list for ${principal}${key ? ` (${key})` : ''}`);
    fail(`${tag}'s signature doesn't verify: ${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] || 'bad signature'}`);
  }
  const key = /(SHA256:\S+)/.exec(r.stdout + r.stderr)?.[1] ?? '';
  console.log(`verified ${tag} ${commit} ${key} (signers: ${signersName} at ${signersCommit})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

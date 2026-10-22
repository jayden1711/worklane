#!/usr/bin/env node
// Pin scripts/bootstrap.sh to a release, after its signed tag exists. Run from a clone of this repo:
//
//   git fetch origin main 'refs/tags/vX.Y.Z:refs/tags/vX.Y.Z'
//   node scripts/pin-engine.mjs vX.Y.Z [--allowed-signers <file>]
//
// It refuses, changing nothing, unless all of these hold:
//   - vX.Y.Z is an annotated tag whose signature verifies: against --allowed-signers (SSH, as the release-channel
//     updater checks it), or else with this clone's git config, which must be able to verify (scripts/lib/signing.mjs);
//   - its commit is a release commit: one commit on top of a commit on origin/main, changing only dist/, carrying
//     dist/src/cli.js, with package.json at X.Y.Z (the shape scripts/release.mjs makes);
// then writes ENGINE_TAG=vX.Y.Z and ENGINE_COMMIT=<that commit> into scripts/bootstrap.sh, and nothing else.
import { gitExecFileSync } from './lib/git.cjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { readPin, releaseProblem, writePin } from './lib/engine-pin.mjs';
import { canVerify } from './lib/signing.mjs';

const args = process.argv.slice(2);
const tag = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`pin-engine: ${msg}`);
  process.exit(1);
};
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) fail('usage: pin-engine.mjs vX.Y.Z [--allowed-signers <file>] [--bootstrap <path>]');
const file = opt('bootstrap') ?? 'scripts/bootstrap.sh';
const signers = opt('allowed-signers');
const git = (...a) => gitExecFileSync(a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (...a) => {
  try {
    git(...a);
    return true;
  } catch {
    return false;
  }
};
const gitConfig = (key) => {
  try {
    return git('config', '--get', key);
  } catch {
    return '';
  }
};

const text = readFileSync(file, 'utf8');
readPin(text);
if (!ok('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) fail(`no tag ${tag} here: git fetch origin 'refs/tags/${tag}:refs/tags/${tag}'`);
if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') fail(`${tag} is a lightweight tag: it can't carry a signature`);

// The signature, never skipped: with the signers file given, as the updater checks it; else with this git config.
try {
  if (signers) git('-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-tag', tag);
  else {
    const cfg = { 'gpg.format': gitConfig('gpg.format'), 'gpg.ssh.allowedsignersfile': gitConfig('gpg.ssh.allowedSignersFile') };
    if (!canVerify(cfg)) fail(`can't check ${tag}'s signature here: pass --allowed-signers <file> (the machine's /etc/<cli>/allowed_signers), or set gpg.ssh.allowedSignersFile`);
    git('tag', '-v', tag);
  }
} catch (e) {
  const said = String(e?.stderr || e?.message || e).split('\n').filter(Boolean).slice(-1)[0];
  fail(`${tag}'s signature doesn't verify${signers ? ` against ${signers}` : ''}: ${said || 'no signature'}`);
}

const commit = git('rev-parse', `${tag}^{commit}`);
const parents = git('rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const facts = {
  parents: parents.length,
  // --no-renames: a file moved into dist/ still names the path it left. -z, untrimmed: a valid UTF-8 name as itself;
  // any other has its bad bytes read as U+FFFD, so it starts with `dist/` only if its bytes do (#683).
  changed: parents.length === 1 ? gitExecFileSync(['diff', '--name-only', '--no-renames', '-z', parents[0], commit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean) : [],
  hasCli: ok('cat-file', '-e', `${commit}:dist/src/cli.js`),
  version: (() => {
    try {
      return JSON.parse(git('show', `${commit}:package.json`)).version;
    } catch {
      return null;
    }
  })(),
  parentOnMain: parents.length === 1 && ok('merge-base', '--is-ancestor', parents[0], 'refs/remotes/origin/main'),
};
const problem = releaseProblem(tag.slice(1), facts);
if (problem) fail(`${tag} (${commit}): ${problem}`);

writeFileSync(file, writePin(text, tag, commit));
console.log(`${file}: ENGINE_TAG=${tag} ENGINE_COMMIT=${commit} (signature verified; one commit on ${parents[0].slice(0, 12)} on origin/main, adding dist/ only)`);

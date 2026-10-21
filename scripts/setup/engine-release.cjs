#!/usr/bin/env node
// engine.sh --release (#832): a release tag checked at install time, before anything is built as root, then exactly
// its commit checked out. Run by scripts/setup/engine.sh, as root, from the checkout engine.sh itself runs from:
//
//   node engine-release.cjs <origin url> <vX.Y.Z> <commit> <allowed signers file> <work dir>
//
// The rules are the engine updater's own (verifyRelease in scripts/machine/worklane-update.cjs, the release channel's
// check), not a copy: origin's refs/tags/<tag> and main fetched into <work dir>/verify.git, the ref resolved once to
// one tag object, its SSH signature verified against <allowed signers file>, the object naming itself <tag>, its
// commit a release commit cut from main (dist/ only), and the ref still that object at the end. Then, here, that
// commit must be <commit> (the pin in scripts/bootstrap.sh), and <work dir>/src is a clone of the verified repo
// (never origin again), with origin's URL as its remote, checked out at <commit> by id.
// It prints `verified <tag>: tag object <id>, commit <id>` and exits 0, or names why and exits 1 with no checkout.
'use strict';
const path = require('node:path');
const { commandExecFileSync, gitExecFileSync } = require('../lib/git.cjs');
const { verifyRelease } = require('../machine/worklane-update.cjs');

const fail = (msg) => {
  process.stderr.write(`engine-release: refused: ${msg}\n`);
  process.exit(1);
};
const [url, tag, commit, signers, work] = process.argv.slice(2);
if (!url || !signers || !work) fail('usage: engine-release.cjs <origin url> <vX.Y.Z> <commit> <allowed signers file> <work dir>');
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag || '')) fail(`"${tag}" isn't a release tag vX.Y.Z`);
if (!/^[0-9a-f]{40}$/.test(commit || '')) fail(`"${commit}" isn't a full commit id: a release is installed only at the commit scripts/bootstrap.sh pins`);
if (!path.isAbsolute(signers)) fail(`the allowed signers file must be an absolute path, not ${signers}`);

// git (the updater's verifyRelease runs it through exec) through the git runner (#807).
const exec = (file, args) => commandExecFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
const gitDir = path.join(work, 'verify.git');
const v = verifyRelease(url, tag, signers, exec, gitDir);
if (!v.ok) fail(v.reason);
if (v.commit !== commit) fail(`${tag} is signed and names itself, but points at ${v.commit}, not the pinned ${commit}`);

// The source to build: the verified objects only, at the pinned commit by id.
const src = path.join(work, 'src');
const git = (...a) => gitExecFileSync(a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
try {
  git('clone', '-q', '--no-checkout', gitDir, src);
  git('-C', src, 'remote', 'set-url', 'origin', url);
  git('-C', src, 'checkout', '-q', '--detach', commit);
} catch (e) {
  fail(`can't check out ${tag} at ${commit}: ${String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0]}`);
}
const head = git('-C', src, 'rev-parse', 'HEAD');
if (head !== commit) fail(`checked out ${head}, not ${commit}`);
process.stdout.write(`verified ${tag}: tag object ${v.object}, commit ${v.commit}\n`);

#!/usr/bin/env node
// Releases. A release tag is SIGNED with the owner's own key (SSH or GPG, see scripts/lib/signing.mjs; nothing
// is generated or stored here) and points at a release commit holding the built dist/, so projects can install
// `github:<owner>/<repo>#vX.Y.Z` without running install scripts (npm 11 blocks them by default). main itself
// never holds build output: the tag's commit sits on top of the main commit it was cut from.
//
//   node scripts/release.mjs changelog X.Y.Z [--repo owner/repo]
//     Write CHANGELOG.md's section for X.Y.Z from the PRs merged since the previous release (one GitHub
//     listing through `gh`). Commit it with the version bump in a normal PR. Safe to rerun: the lists are
//     rewritten, and whatever is written by hand above them in that section (highlights, upgrade notes) is kept.
//   node scripts/release.mjs X.Y.Z
//     On that merged commit: build, test, tag vX.Y.Z signed (`git tag -s`), verify the signature, and write
//     the GitHub release notes (the changelog's section). Refuses without a signing key or a way to verify the
//     signature (.github/release-signers, else gpg.ssh.allowedSignersFile), saying how to set one. The tag exists
//     afterwards only if `git tag -v` passed: on any failure after it's made, it's deleted (#457).
//
// The step-by-step checklist for a release, from a green main to the approved npm version: docs/releasing.md.
// Pushing the tag runs .github/workflows/release.yml, which only STAGES the version on npm (after checking the tag's
// signature against main's .github/release-signers); it goes live when the owner approves it on npmjs.com with 2FA.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogSection, prNumbers, scrubTitle, sectionFor, withSection } from './lib/changelog.mjs';
import { loadRules, scanText } from './lib/denylist.mjs';
import { treeDifferences } from './lib/release-tree.mjs';
import { releaseSigners, signingProblem } from './lib/signing.mjs';

const args = process.argv.slice(2);
const changelogOnly = args[0] === 'changelog';
const version = changelogOnly ? args[1] : args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('usage: release.mjs X.Y.Z | release.mjs changelog X.Y.Z [--repo owner/repo]');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitConfig = (key) => {
  try {
    return git('config', '--get', key);
  } catch {
    return '';
  }
};
const semver = (v) => v.split('.').map(Number);
const older = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

if (changelogOnly) {
  // The previous release: the newest vX.Y.Z tag older than this one; its range starts where it left main.
  const prev = git('tag', '-l', 'v*').split('\n').map((t) => t.slice(1)).filter((t) => /^\d+\.\d+\.\d+$/.test(t) && older(t, version)).sort((a, b) => (older(a, b) ? -1 : 1)).at(-1);
  const from = prev ? git('merge-base', `v${prev}`, 'HEAD') : null;
  const subjects = git('log', '--first-parent', '--reverse', '--format=%s', ...(from ? [`${from}..HEAD`] : ['HEAD'])).split('\n').filter(Boolean);
  const numbers = prNumbers(subjects);
  const repo = opt('repo') ?? /github\.com[:/](.+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'))?.[1];
  if (!repo) fail('which GitHub repo? pass --repo owner/repo');
  // --state all: a PR a batch merged is closed, not merged, on GitHub; its number came from main's history.
  const listed = numbers.length ? JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,title,labels,files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) : [];
  const byNumber = new Map(listed.map((p) => [p.number, { number: p.number, title: p.title, labels: (p.labels ?? []).map((l) => l.name), files: (p.files ?? []).map((f) => f.path) }]));
  // A title with a word the denylist refuses (an internal ticket key, say) is listed without it, and named here.
  const rules = loadRules('.');
  const denied = (text) => scanText(rules, 'CHANGELOG.md', text).length > 0;
  const prs = numbers
    .map((n) => byNumber.get(n) ?? { number: n, title: `#${n}`, labels: [], files: [] })
    .map((pr) => {
      const title = scrubTitle(pr.title, denied);
      if (title !== pr.title) console.log(`#${pr.number}: listed without a word the denylist refuses`);
      return { ...pr, title };
    });
  const section = changelogSection(version, new Date().toISOString().slice(0, 10), prs);
  const changelog = withSection(existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '', version, section);
  writeFileSync('CHANGELOG.md', changelog);
  const left = scanText(rules, 'CHANGELOG.md', sectionFor(changelog, version) ?? '');
  if (left.length) fail(`CHANGELOG.md's v${version} section still fails the denylist (the hand-written top?):\n  ${left.join('\n  ')}`);
  console.log(`CHANGELOG.md: v${version}, ${prs.length} PR(s) since ${prev ? `v${prev}` : 'the first commit'}. Review it, then commit it with the version bump in a PR.`);
  process.exit(0);
}

if (git('status', '--porcelain')) fail('working tree not clean');
const pkg = JSON.parse(git('show', 'HEAD:package.json'));
if (pkg.version !== version) fail(`package.json is ${pkg.version}, not ${version}`);
const cfg = { 'gpg.format': gitConfig('gpg.format'), 'user.signingkey': gitConfig('user.signingkey'), 'gpg.ssh.allowedsignersfile': gitConfig('gpg.ssh.allowedSignersFile') };
const problem = signingProblem(cfg);
if (problem) fail(`refusing to tag v${version}: ${problem}`);
const tag = `v${version}`;
// INVARIANT: never touch a tag this run didn't make (a deleted earlier one is gone for good).
if (git('tag', '-l', tag)) fail(`refusing to tag ${tag}: it already exists here. If a failed run left it, check it isn't pushed, then: git tag -d ${tag}`);
// The signers to verify against, copied out of HEAD before anything is checked out: what CI will check (#457).
let repoSigners = null;
try {
  const text = git('show', 'HEAD:.github/release-signers');
  repoSigners = join(mkdtempSync(join(tmpdir(), 'release-signers-')), 'allowed_signers');
  writeFileSync(repoSigners, `${text}\n`);
} catch {
  // no .github/release-signers at HEAD
}
const signers = releaseSigners(cfg, repoSigners);
if (signers.problem) fail(`refusing to tag ${tag}: ${signers.problem}`);
let notes = null;
try {
  notes = sectionFor(git('show', 'HEAD:CHANGELOG.md'), version);
} catch {
  // no CHANGELOG.md at HEAD
}
if (!notes) fail(`CHANGELOG.md at HEAD has no v${version} section: run \`node scripts/release.mjs changelog ${version}\` and merge it first`);
const head = git('rev-parse', 'HEAD');
// Where to come back to: the branch if on one, else the exact commit (a detached start has no `-`).
let back = head;
try {
  back = git('symbolic-ref', '-q', '--short', 'HEAD');
} catch {
  // detached
}
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'build:web'], { stdio: 'inherit' });
execFileSync('npm', ['test'], { stdio: 'inherit' });
// WHY: by default a signal (Ctrl-C at the passphrase prompt) kills node mid-step, and the finally below never runs.
// Listening keeps node alive: the step's own child gets the signal and fails, and the cleanup runs (#457).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {});
git('checkout', '-q', '--detach');
let verified = false;
let release = '';
try {
  git('add', '-f', 'dist/src', 'dist/web');
  git('commit', '-q', '-s', '-m', `Release ${tag} (with built dist/)`);
  release = git('rev-parse', 'HEAD');
  // INVARIANT: the release commit is the built tree byte for byte, so a rebuild of the tag reproduces it (#458).
  const differs = treeDifferences({ dir: '.', commit: release, prefixes: ['dist/src', 'dist/web'] });
  if (differs.length) throw new Error(`refusing to tag ${tag}: the release commit isn't the built dist/ byte for byte (a rebuild of the tag wouldn't match it):\n  ${differs.join('\n  ')}`);
  // WHY: `git tag -s` can leave an unsigned tag and still exit 0 (#457: a passphrase prompt answered with Enter).
  git('tag', '-s', tag, '-m', `${tag}\n\n${notes}`);
  git(...(signers.file ? ['-c', `gpg.ssh.allowedSignersFile=${signers.file}`] : []), 'tag', '-v', tag);
  verified = true;
} finally {
  // INVARIANT: the tag exists after this run only if `git tag -v` passed. Deleted first, before anything else can throw.
  if (!verified && git('tag', '-l', tag)) {
    git('tag', '-d', tag);
    console.error(`${tag}: not verified, so the tag is deleted (nothing to push). Fix the signing, then run this again.`);
  }
  git('checkout', '-q', back);
  // Leaving the release commit deletes its tracked dist/ from the working tree.
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' });
  execFileSync('npm', ['run', 'build:web'], { stdio: 'ignore' });
}
const notesFile = join(tmpdir(), `release-notes-${tag}.md`);
writeFileSync(notesFile, `${notes}\n`);
console.log(`push with (only behind the verify, as its own step): git tag -v ${tag} && git push origin ${tag}`);
console.log('CI then stages it on npm; approve it on npmjs.com with 2FA (docs/releasing.md)');
console.log(`then the GitHub release: gh release create ${tag} --verify-tag --title ${tag} --notes-file ${notesFile}`);
console.log(`${tag}: signed and verified (git tag -v passed) at ${release} (on top of ${head.slice(0, 7)}). Nothing is pushed yet.`);

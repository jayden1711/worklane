#!/usr/bin/env node
// Push gate for this repo: nothing private leaves the machine. Runs as the
// pre-push hook (npm run setup:hooks) and in CI. It fails closed: any error,
// a missing scanner or an unresolvable range refuses the push.
//
//   pre-push hook:  node scripts/push-gate.mjs <remote> [<url>]   (refs on stdin)
//   by hand / CI:   node scripts/push-gate.mjs --range <base>..<tip>
//
// For the commits being pushed it scans the added lines and the message with
// the denylist rules (personal names, internal hosts and addresses, home
// paths, emails, ntfy topics; scripts/lib/denylist.mjs), the whole tree at
// each pushed tip, and runs gitleaks over the commits. One allowance: in the
// subject of a GitHub merge commit ("Merge pull request #<n> from <owner>/<branch>")
// the repo's own owner (from GITHUB_REPOSITORY or the origin URL) is not a leak.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadRules, scanText, SKIP } from './lib/denylist.mjs';

const ZERO = /^0+$/;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function fail(why) {
  console.error(`push gate: REFUSED. ${why}`);
  process.exit(1);
}

/** Commits to scan and tips to check, from the hook's stdin or --range. */
function targets(argv) {
  if (argv[0] === '--range') {
    const [base, tip] = (argv[1] ?? '').split('..');
    if (!base || !tip) fail('usage: --range <base>..<tip>');
    return [{ tip: git('rev-parse', '--verify', `${tip}^{commit}`).trim(), commits: git('rev-list', `${base}..${tip}`).split('\n').filter(Boolean) }];
  }
  const remote = argv[0];
  if (!remote) fail('run as a pre-push hook (remote name expected) or with --range');
  const out = [];
  for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [, localSha] = line.split(' ');
    if (!localSha || ZERO.test(localSha)) continue; // deleting a ref pushes no content
    // Everything the remote doesn't have yet, whatever the remote ref was.
    out.push({ tip: localSha, commits: git('rev-list', localSha, '--not', `--remotes=${remote}`).split('\n').filter(Boolean) });
  }
  return out;
}

function addedLines(sha) {
  const byFile = new Map();
  let file = null;
  for (const l of git('show', '--format=', '-U0', '--no-color', '--no-ext-diff', '--no-renames', sha).split('\n')) {
    if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6);
    else if (file && l.startsWith('+') && !SKIP.has(file)) byFile.set(file, `${byFile.get(file) ?? ''}${l.slice(1)}\n`);
  }
  return byFile;
}

/**
 * The repo's own GitHub owner, from GITHUB_REPOSITORY (CI) or the origin remote's URL; null if neither names one.
 * Derived at runtime so no handle is written into the gate.
 */
function repoOwner() {
  const fromEnv = /^([A-Za-z0-9-]+)\/[^/\s]+$/.exec(process.env.GITHUB_REPOSITORY ?? '');
  if (fromEnv) return fromEnv[1].toLowerCase();
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null; // no origin: no allowance
  }
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/[^/\s]+$/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// GitHub's own merge-button subject. For a same-repo PR its head owner is the repo's owner.
const GITHUB_MERGE_SUBJECT = /^(Merge pull request #\d+ from )([A-Za-z0-9-]+)(\/\S+)$/;

/**
 * Drop the repo owner's handle from a GitHub merge commit's subject, and only there: the commit must be a merge,
 * its subject exactly `Merge pull request #<n> from <owner>/<branch>`, and <owner> the repo's own owner.
 * The branch, the rest of the message and any other owner's handle are still scanned.
 */
function withoutOwnMergeSubject(msg, owner, isMerge) {
  if (!owner || !isMerge) return msg;
  const nl = msg.indexOf('\n');
  const subject = nl === -1 ? msg : msg.slice(0, nl);
  const m = GITHUB_MERGE_SUBJECT.exec(subject);
  if (!m || m[2].toLowerCase() !== owner) return msg;
  return `${m[1]}${m[3]}${nl === -1 ? '' : msg.slice(nl)}`;
}

function scanCommit(rules, sha, owner) {
  const short = sha.slice(0, 8);
  const hits = [];
  for (const [file, text] of addedLines(sha)) if (!text.includes('\0')) hits.push(...scanText(rules, file, text).map((h) => `${short} ${h}`));
  // A commit's own author and committer identity (and its sign-off) are inherent to it; anything else in the message is scanned.
  const [an, ae, cn, ce] = git('log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', sha).trim().split('\0');
  const isMerge = git('log', '-1', '--format=%P', sha).trim().split(' ').length > 1;
  let msg = withoutOwnMergeSubject(git('log', '-1', '--format=%B', sha), owner, isMerge);
  for (const id of [ae, ce, an, cn].filter(Boolean)) msg = msg.split(id).join('');
  hits.push(...scanText(rules, 'COMMIT_MSG', msg).map((h) => `${short} ${h}`));
  return hits;
}

function scanTree(rules, tip) {
  const hits = [];
  for (const path of git('ls-tree', '-r', '--name-only', tip).split('\n').filter((p) => p && !SKIP.has(p))) {
    const text = git('show', `${tip}:${path}`);
    if (!text.includes('\0')) hits.push(...scanText(rules, path, text).map((h) => `${tip.slice(0, 8)} ${h}`));
  }
  return hits;
}

function gitleaks(commits) {
  if (!commits.length) return;
  const r = spawnSync('gitleaks', ['git', '--no-banner', '--redact', '--exit-code', '1', '--log-opts', `--no-walk ${commits.join(' ')}`, '.'], { encoding: 'utf8' });
  if (r.error) fail(`gitleaks could not run (${r.error.code ?? r.error.message}); install it, the gate never skips the secret scan`);
  if (r.status === 1) fail(`gitleaks found a secret:\n${(r.stdout + r.stderr).trim().slice(-3000)}`);
  if (r.status !== 0) fail(`gitleaks exited ${r.status}:\n${r.stderr.trim().slice(-1000)}`);
}

try {
  const rules = loadRules('.');
  const all = targets(process.argv.slice(2));
  const hits = [];
  const commits = [...new Set(all.flatMap((t) => t.commits))];
  const owner = repoOwner();
  for (const sha of commits) hits.push(...scanCommit(rules, sha, owner));
  for (const t of all) hits.push(...scanTree(rules, t.tip));
  if (hits.length) fail(`private details in what would be pushed:\n${[...new Set(hits)].map((h) => `  ${h}`).join('\n')}\nReword generically, or add an intentional mention to .denylist-allow.`);
  gitleaks(commits);
  console.log(`push gate: ${commits.length} commit(s) and ${all.length} tip(s) clean`);
} catch (e) {
  fail(`the gate itself failed, so nothing is pushed: ${e.message}`);
}

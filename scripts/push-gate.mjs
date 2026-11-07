#!/usr/bin/env node
// Push gate for this repo: nothing private leaves the machine. Runs as the
// pre-push hook (npm run setup:hooks) and in CI. It fails closed: any error,
// a missing scanner or an unresolvable range refuses the push.
//
//   pre-push hook:  node scripts/push-gate.mjs <remote> [<url>]   (refs on stdin)
//   by hand / CI:   node scripts/push-gate.mjs --range <base>..<tip>
//   a PR's body:    node scripts/push-gate.mjs --pr-body   (CI; the body from $GITHUB_EVENT_PATH)
//
// It refuses vendor attribution in a commit message or PR body (a Co-Authored-By trailer, a coding tool's
// "Generated with" line): this repo's attribution is the DCO sign-off only (#576).
// For the commits being pushed it scans the added lines and the message with
// the denylist rules (personal names, internal hosts and addresses, home
// paths, emails, ntfy topics; scripts/lib/denylist.mjs), the whole tree at
// each pushed tip (a file holding a NUL byte for the hashed terms only), and
// runs gitleaks over the commits. One allowance: in the
// subject of a GitHub merge commit ("Merge pull request #<n> from <owner>/<branch>")
// the repo's own owner (from GITHUB_REPOSITORY or the origin URL) is not a leak.
// And a Signed-off-by line whose email is the commit's own author or committer
// email (a squash merge's DCO trailers) is dropped whole, name included.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadRules, scanBinary, scanText, SKIP } from './lib/denylist.mjs';

const ZERO = /^0+$/;
const READ_MAX = 256 * 1024 * 1024;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: READ_MAX });

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

/** git's output, or a refusal naming `what` when it is over READ_MAX: it can't be scanned, so it is never skipped (#1057). */
function readForScan(what, ...args) {
  try {
    return git(...args);
  } catch (e) {
    if (e.code === 'ENOBUFS') fail(`${what} is over the gate's ${READ_MAX / 1048576} MiB read limit, so it can't be scanned. Keep files that large out of the repo.`);
    throw e;
  }
}

function addedLines(sha) {
  const byFile = new Map();
  let file = null;
  let inHunk = false;
  // WHY: read as text whatever the attributes say: a `-diff` or `binary` mark in the pushed .gitattributes printed
  // "Binary files differ", so a file added and deleted again within the push was never scanned (#693).
  const diff = readForScan(`commit ${sha.slice(0, 8)}'s diff`, '-c', 'core.attributesFile=/dev/null', 'show', '--format=', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--no-renames', sha);
  // A file's header runs from its `diff ` line to its first `@@` line. Inside a hunk every line carries a prefix, so
  // a line there that reads as a new-name header is an added line starting `++` (#1057).
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff ')) [file, inHunk] = [null, false];
    else if (l.startsWith('@@')) inHunk = true;
    else if (!inHunk && l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6);
    else if (inHunk && file && l.startsWith('+') && !SKIP.has(file)) byFile.set(file, `${byFile.get(file) ?? ''}${l.slice(1)}\n`);
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

/**
 * Blank every `Signed-off-by: <name> <email>` line whose email is the commit's own author or committer email.
 * A DCO sign-off by the commit's own identity is inherent to it, name included: a squash merge's author is the
 * owner's display name while the squashed commits' sign-offs carry their handle. A sign-off with any other email,
 * and the name anywhere else, are still scanned. Lines are blanked, not removed, so hit line numbers stay true.
 */
function withoutOwnSignOffs(msg, emails) {
  const own = new Set(emails.filter(Boolean).map((e) => e.toLowerCase()));
  return msg
    .split('\n')
    .map((line) => {
      const m = /^\s*Signed-off-by:[^<>\n]*<([^<>\s]+)>\s*$/i.exec(line);
      return m && own.has(m[1].toLowerCase()) ? '' : line;
    })
    .join('\n');
}

// Commit message shape (#603). The longest well-formed subject in the last 300 commits on main was 176 characters
// (11 were over 150), so 180 refuses none of them and still refuses a paragraph.
const SUBJECT_MAX = 180;

/**
 * Why a commit's message is malformed, or nothing: line 2 must be blank (otherwise git reads the whole first
 * paragraph as the subject) and line 1 at most SUBJECT_MAX characters. A one-line message passes; so does GitHub's
 * merge commit, whose title follows a blank line. Only the pushed commits are judged, never what's already on main.
 */
function messageShape(sha) {
  const lines = git('log', '-1', '--format=%B', sha).split(/\r?\n/);
  const why = [];
  if (lines.length > 1 && lines[1].trim() !== '') why.push('line 2 is not blank, so git reads the whole first paragraph as the subject');
  if (lines[0].length > SUBJECT_MAX) why.push(`the subject is ${lines[0].length} characters, over ${SUBJECT_MAX}`);
  return why.length ? [`${sha.slice(0, 8)}: ${why.join('; and ')}\n    line 1: ${lines[0]}`] : [];
}

// A blob holding a NUL byte is still scanned for the hashed terms, never skipped (#989).
const scanBlob = (rules, path, text) => (text.includes('\0') ? scanBinary(rules, path, text) : scanText(rules, path, text));

function scanCommit(rules, sha, owner) {
  const short = sha.slice(0, 8);
  const hits = [];
  for (const [file, text] of addedLines(sha)) hits.push(...scanBlob(rules, file, text).map((h) => `${short} ${h}`));
  // A commit's own author and committer identity (and its sign-off) are inherent to it; anything else in the message is scanned.
  const [an, ae, cn, ce] = git('log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce', sha).trim().split('\0');
  const isMerge = git('log', '-1', '--format=%P', sha).trim().split(' ').length > 1;
  let msg = withoutOwnSignOffs(withoutOwnMergeSubject(git('log', '-1', '--format=%B', sha), owner, isMerge), [ae, ce]);
  for (const id of [ae, ce, an, cn].filter(Boolean)) msg = msg.split(id).join('');
  hits.push(...scanText(rules, 'COMMIT_MSG', msg).map((h) => `${short} ${h}`));
  return hits;
}

// Vendor attribution (#576): this repo's attribution is the DCO sign-off only. A Co-Authored-By trailer with any
// address (or none: the commit's own email is dropped from the scan above, so this is its own check), a coding tool's
// "Generated with" line, or its session trailer. Whole lines only: naming them in prose is fine.
// check-table: never-shrink
const ATTRIBUTION = [
  /^\s*Co-Authored-By\s*:/i,
  /^[^\p{L}\p{N}]*Generated (?:with|by) \[?(?:Claude|Codex|Copilot|Cursor|Gemini|Aider)\b/iu,
  /^\s*Claude-Session\s*:/i,
];
const ATTRIBUTION_FIX = "This repo's attribution is the DCO sign-off (git commit -s) only: remove those lines.";

/** `<where>:<line>: vendor attribution (<line text>)` for each attribution line in `text`. */
function attributionLines(where, text) {
  return text.split(/\r?\n/).flatMap((line, i) => (ATTRIBUTION.some((re) => re.test(line)) ? [`${where}:${i + 1}: vendor attribution (${line.trim().slice(0, 120)})`] : []));
}

/**
 * CI's check of a pull request's body (.github/workflows/new-deps.yml): the body comes from the event payload at
 * $GITHUB_EVENT_PATH, a file, so it never passes through a shell line. Exits.
 */
function prBodyGate() {
  const file = process.env.GITHUB_EVENT_PATH || fail('--pr-body reads the event payload at GITHUB_EVENT_PATH, which is not set');
  const body = JSON.parse(readFileSync(file, 'utf8')).pull_request?.body ?? '';
  const hits = attributionLines('PR_BODY', String(body));
  if (hits.length) fail(`vendor attribution in the pull request body:\n${hits.map((h) => `  ${h}`).join('\n')}\n${ATTRIBUTION_FIX}`);
  console.log('push gate: the pull request body carries no vendor attribution');
  process.exit(0);
}

function scanTree(rules, tip) {
  const hits = [];
  for (const path of git('ls-tree', '-r', '--name-only', tip).split('\n').filter((p) => p && !SKIP.has(p))) {
    hits.push(...scanBlob(rules, path, readForScan(`${tip.slice(0, 8)} ${path}`, 'show', `${tip}:${path}`)).map((h) => `${tip.slice(0, 8)} ${h}`));
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

if (process.argv[2] === '--pr-body') {
  try {
    prBodyGate();
  } catch (e) {
    fail(`the PR body check itself failed: ${e.message}`);
  }
}

try {
  const rules = loadRules('.');
  const all = targets(process.argv.slice(2));
  const hits = [];
  const commits = [...new Set(all.flatMap((t) => t.commits))];
  const shape = commits.flatMap(messageShape);
  if (shape.length) fail(`a commit message's subject is not one short line:\n${shape.map((s) => `  ${s}`).join('\n')}\nPut the subject alone on line 1 (at most ${SUBJECT_MAX} characters), then a blank line, then the body. Reword it before pushing (git commit --amend for the last commit, a rebase's reword for an older one); once pushed, a reword needs the owner's OK to force-push.`);
  const owner = repoOwner();
  const attribution = commits.flatMap((sha) => attributionLines(`${sha.slice(0, 8)} COMMIT_MSG`, git('log', '-1', '--format=%B', sha)));
  if (attribution.length) fail(`vendor attribution in a commit message:\n${attribution.map((h) => `  ${h}`).join('\n')}\n${ATTRIBUTION_FIX}`);
  for (const sha of commits) hits.push(...scanCommit(rules, sha, owner));
  for (const t of all) hits.push(...scanTree(rules, t.tip));
  if (hits.length) fail(`private details in what would be pushed:\n${[...new Set(hits)].map((h) => `  ${h}`).join('\n')}\nReword generically, or add an intentional mention to .denylist-allow.`);
  gitleaks(commits);
  console.log(`push gate: ${commits.length} commit(s) and ${all.length} tip(s) clean`);
} catch (e) {
  fail(`the gate itself failed, so nothing is pushed: ${e.message}`);
}

#!/usr/bin/env node
// Push gate for this repo: nothing private leaves the machine. Runs as the
// pre-push hook (npm run setup:hooks) and in CI. It fails closed: any error,
// a missing scanner or an unresolvable range refuses the push.
//
//   pre-push hook:  node scripts/push-gate.mjs <remote> [<url>]   (refs on stdin)
//   by hand / CI:   node scripts/push-gate.mjs --range <base>..<tip>
//   a PR's body:    node scripts/push-gate.mjs --pr-body   (CI; the body from $GITHUB_EVENT_PATH)
//   commit-msg hook: node push-gate.mjs --commit-msg <message file>   (the message rule alone: #1259)
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
import { devNull } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, scanBinary, scanText, SKIP } from './lib/denylist.mjs';

const ZERO = /^0+$/;
const READ_MAX = 256 * 1024 * 1024;
// The git runner's settings (#807; src/os/git.ts, scripts/lib/git.cjs): replace refs off and no graft file, so a
// `git replace` or a graft in the repo can't swap the commits, trees or blobs scanned here. Written out here because
// the hook runs this file alone, fetched from origin (scripts/push-gate-hook.mjs GATE_CODE), so it imports nothing
// new; test/git-runner.test.ts checks they are the runner's.
// The commit-graph is off too (a forged one can skip a commit), in the arguments and, for gitleaks' own gits, in the
// environment: a config pair after the caller's GIT_CONFIG_COUNT pairs, and at the end of GIT_CONFIG_PARAMETERS
// (what `git -c` hands the gits it runs), which git reads last. A count that isn't a plain decimal 0 to 9999 is
// replaced with one git refuses, so the git fails closed (as src/os/git.ts gitEnv).
const GIT_FIXED_ARGS = ['--no-replace-objects', '-c', 'core.commitGraph=false'];
const graphOff = (e) => {
  const raw = Object.hasOwn(e, 'GIT_CONFIG_COUNT') ? e.GIT_CONFIG_COUNT : undefined;
  const params = Object.hasOwn(e, 'GIT_CONFIG_PARAMETERS') ? e.GIT_CONFIG_PARAMETERS : undefined;
  const last = { GIT_CONFIG_PARAMETERS: params ? `${params} 'core.commitGraph=false'` : "'core.commitGraph=false'" };
  if (raw !== undefined && !/^(?:0|[1-9][0-9]{0,3})$/.test(raw)) return { ...e, GIT_CONFIG_COUNT: 'refused', ...last };
  const n = raw === undefined ? 0 : Number(raw);
  return { ...e, [`GIT_CONFIG_KEY_${n}`]: 'core.commitGraph', [`GIT_CONFIG_VALUE_${n}`]: 'false', GIT_CONFIG_COUNT: String(n + 1), ...last };
};
const GIT_ENV = graphOff({ ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: join(devNull, 'no-grafts') });
const runGit = (args, opts) => execFileSync('git', [...GIT_FIXED_ARGS, ...args], { ...opts, env: GIT_ENV });
const git = (...a) => runGit(a, { encoding: 'utf8', maxBuffer: READ_MAX });

function fail(why) {
  console.error(`push gate: REFUSED. ${why}`);
  process.exit(1);
}

/** Commits to scan and tips to check, from the hook's stdin or --range. */
function targets(argv) {
  // R1260f F1: the launcher passes `-- <remote> <url>`, so a remote's name is never read as an option.
  if (argv[0] === '--') return pushed(argv[1]);
  if (argv[0] === '--range') {
    const [base, tip] = (argv[1] ?? '').split('..');
    if (!base || !tip) fail('usage: --range <base>..<tip>');
    return [{ tip: git('rev-parse', '--verify', `${tip}^{commit}`).trim(), commits: git('rev-list', `${base}..${tip}`).split('\n').filter(Boolean) }];
  }
  return pushed(argv[0]);
}

/** A pre-push hook's refs (on stdin), with what `remote` doesn't have yet. */
function pushed(remote) {
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
    url = runGit(['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
 * Why a commit message is malformed (empty: it isn't): line 2 must be blank (otherwise git reads the whole first
 * paragraph as the subject) and line 1 at most SUBJECT_MAX characters. A one-line message passes; so does GitHub's
 * merge commit, whose title follows a blank line. The one rule for both a pushed commit (messageShape) and, through
 * --commit-msg, the commit-msg hook before a commit is made (#1259), so the two can't drift.
 */
function messageShapeProblems(message) {
  const lines = message.split(/\r?\n/);
  const why = [];
  if (lines.length > 1 && lines[1].trim() !== '') why.push('line 2 is not blank, so git reads the whole first paragraph as the subject');
  if (lines[0].length > SUBJECT_MAX) why.push(`the subject is ${lines[0].length} characters, over ${SUBJECT_MAX}`);
  return why;
}

/** A pushed commit's message shape. Only the pushed commits are judged, never what's already on main. */
function messageShape(sha) {
  const message = git('log', '-1', '--format=%B', sha);
  const why = messageShapeProblems(message);
  return why.length ? [`${sha.slice(0, 8)}: ${why.join('; and ')}\n    line 1: ${message.split(/\r?\n/)[0]}`] : [];
}

/** A git config value in the repo the hook runs in, or null when it isn't set. */
function gitConfig(key) {
  try {
    return runGit(['config', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * The cleanup git applies after the commit-msg hook, as far as a hook can tell (R1260a/b D1): `commit.cleanup` when
 * set (`default` as unset); otherwise `strip` when the message is edited and `whitespace` when it isn't (-m, -F, -C),
 * which git tells the hook by running it with GIT_EDITOR=':'. `scissors` cuts only an edited message, as `whitespace`
 * otherwise. A `--cleanup=` given on the command line isn't visible to a hook: the hook then judges by this mode.
 */
function cleanupMode(env = process.env) {
  const edited = env.GIT_EDITOR !== ':';
  const set = gitConfig('commit.cleanup');
  if (set && set !== 'default') return set === 'scissors' && !edited ? 'whitespace' : set;
  return edited ? 'strip' : 'whitespace';
}

/**
 * The comment setting git reads (R1260c D2): from 2.45, core.commentChar and core.commentString, whichever is set last;
 * before, core.commentChar alone (git ignored core.commentString). `#` when neither is set; `auto` as it is.
 */
function commentSetting() {
  let newer = false;
  try {
    const m = /(\d+)\.(\d+)/.exec(runGit(['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    newer = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 45));
  } catch {
    // no git: the default below
  }
  let set = [];
  try {
    set = runGit(['config', '--get-regexp', '^core\\.comment(char|string)$'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf(' ') === -1 ? l.length : l.indexOf(' ')).toLowerCase(), l.indexOf(' ') === -1 ? '' : l.slice(l.indexOf(' ') + 1)]);
  } catch {
    // none set
  }
  return set.filter(([k]) => newer || k === 'core.commentchar').at(-1)?.[1] || '#';
}

/** The characters git's `core.commentChar=auto` picks from, in order: the first that starts no line of the message. */
const AUTO_COMMENT = '#;@!$%^&|:';
const scissors = (c) => `${c} ------------------------ >8 ------------------------`;
const BLANK = /^[ \t\n\v\f\r]*$/;

/**
 * git's help block in an edited message, and its character (R1260e D1, R1260f F2): the lines after the last blank line,
 * 3 or more, every one starting with one candidate and one of them that character alone (git writes `#` on its own line
 * above "On branch"), below a message. A message's own trailing `#1259` lines have no bare line. With `-v` the block
 * sits above git's scissors line, the diff below it: so it is looked for at the end, then above each scissors line.
 */
function helpBlockChar(lines) {
  const at = (end) => {
    let last = end - 1;
    while (last >= 0 && BLANK.test(lines[last])) last--;
    let b = last;
    while (b >= 0 && !BLANK.test(lines[b])) b--;
    const run = lines.slice(b + 1, last + 1);
    const c = run[0]?.[0];
    const ok = c && AUTO_COMMENT.includes(c) && run.length >= 3 && run.every((l) => l.startsWith(c)) && run.includes(c) && lines.slice(0, b + 1).some((l) => !BLANK.test(l));
    return ok ? c : null;
  };
  const ends = [lines.length, ...[...lines.keys()].filter((i) => [...AUTO_COMMENT].some((c) => lines[i] === scissors(c)))];
  for (const e of ends) {
    const c = at(e);
    if (c) return c;
  }
  return null;
}

/**
 * The comment prefixes to judge an edited message by (R1260c D1, R1260d D2). A set prefix, as it is. For `auto`, git
 * picks a character (by a rule that differs between versions: 2.48 skips one a line of the message starts with, 2.56
 * didn't for `-e -m`, measured in CI) and writes its help block with it, so the hook reads git's choice there; git
 * then strips every line that character starts, the message's own included. With no help block (commit.status=false,
 * or `--no-status`, which a hook can't see) both readings, `#` stripped and nothing stripped: the hook refuses when
 * either fails, never passing what git might commit differently.
 */
function commentPrefixes(text, setting, statusOn = true) {
  if (setting !== 'auto') return [setting];
  const c = statusOn ? helpBlockChar(text.split('\n')) : null;
  return c ? [c] : ['#', null];
}

/** Whether git writes its help block into an edited message (commit.status, as git reads a boolean). */
const statusOn = () => !/^(false|no|off|0)$/i.test(gitConfig('commit.status') ?? '');

/**
 * Whether to judge the message cut at its scissors line (R1260f F3): git cuts only under `--cleanup=scissors` (or
 * commit.cleanup=scissors, edited) or with `-v`, which a hook can't see, so in `strip` mode both readings.
 */
const cutReadings = (mode) => (mode === 'scissors' ? [true] : mode === 'strip' ? [true, false] : [false]);

/**
 * The message as git will commit it, from the file the commit-msg hook is given, by git's cleanup `mode`: verbatim
 * changes nothing; with `cutAtScissors` (scissors mode, or a `-v` commit) it is cut at the scissors line; strip leaves
 * out comment lines (git's own scissors line among them, when it doesn't cut); all but verbatim then
 * take trailing whitespace off each line, fold runs of blank lines to one, and drop blank lines at the start and the
 * end. Blank and whitespace are ASCII, as git's isspace (a BOM or NBSP line is not blank: R1260b). A null `comment`
 * strips and cuts nothing (one of `auto`'s two readings).
 */
function asCommitted(text, mode = 'strip', comment = '#', cutAtScissors = mode === 'scissors') {
  if (mode === 'verbatim') return text;
  let lines = text.split('\n');
  if (cutAtScissors) {
    const cut = comment === null ? -1 : lines.indexOf(scissors(comment));
    if (cut !== -1) lines = lines.slice(0, cut);
  }
  if (mode === 'strip' && comment !== null) lines = lines.filter((l) => !l.startsWith(comment));
  const out = [];
  for (const l of lines.map((x) => x.replace(/[ \t\n\v\f\r]+$/, ''))) {
    if (l !== '') out.push(l);
    else if (out.length && out.at(-1) !== '') out.push('');
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
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
  // gitleaks runs git itself: with the same settings, in its environment.
  const r = spawnSync('gitleaks', ['git', '--no-banner', '--redact', '--exit-code', '1', '--log-opts', `--no-walk ${commits.join(' ')}`, '.'], { encoding: 'utf8', env: GIT_ENV });
  if (r.error) fail(`gitleaks could not run (${r.error.code ?? r.error.message}); install it, the gate never skips the secret scan`);
  if (r.status === 1) fail(`gitleaks found a secret:\n${(r.stdout + r.stderr).trim().slice(-3000)}`);
  if (r.status !== 0) fail(`gitleaks exited ${r.status}:\n${r.stderr.trim().slice(-1000)}`);
}

// The commit-msg hook (#1259; installed by setup-hooks): the message rule alone, before the commit is made, so none is
// made that the gate would refuse and that would then have to be rewritten. No rules or git are read.
// R1260a D2, R1260d D1: only when the installed stub runs it: from its own copy in the hooks dir (commit-msg-gate/;
// the pre-push launcher runs the gate from a fresh temp dir, never there), and with the message file named in
// PUSH_GATE_COMMIT_MSG too. A pre-push hook's first argument is the remote's name and its second the remote's URL,
// and its environment is the pusher's: a push that supplies all three is still judged below.
const installedCopy = basename(dirname(dirname(fileURLToPath(import.meta.url)))) === 'commit-msg-gate';
if (process.argv[2] === '--commit-msg' && installedCopy && process.argv.length === 4 && process.env.PUSH_GATE_COMMIT_MSG === process.argv[3]) {
  try {
    const text = readFileSync(process.argv[3], 'utf8');
    const mode = cleanupMode();
    const readings = commentPrefixes(text, commentSetting(), statusOn()).flatMap((c) => cutReadings(mode).map((cut) => asCommitted(text, mode, c, cut)));
    const why = [...new Set(readings.flatMap(messageShapeProblems))];
    if (why.length) {
      console.error(`commit refused, by the push gate's message-shape rule: ${why.join('; and ')}`);
      console.error(`Nothing was committed; the message is kept in ${process.argv[3]}. Put the subject alone on line 1 (at most ${SUBJECT_MAX} characters), then a blank line, then the body, and commit again.`);
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error(`commit refused: the commit-msg hook could not read the message: ${e.message}`);
    process.exit(1);
  }
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

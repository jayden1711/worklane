// Push limits. Every push of agent-written code goes through checkedPush,
// which first refuses a range that is too big, carries an oversized or
// refused file in any of its commits (one added and later deleted still
// counts: it stays in the history that's pushed), changes CI workflows, or
// leaves a SKILL.md that fails the skill lint.
// The coordinator also runs pushProblems on each change before verifying it,
// so a doomed change is caught before a long test run.
import { execFileSync, spawnSync } from './os/child-process.js';
import { blobsByName, rangeNames, sizeFiles } from './coordinator/change-files.js';
import { globRegExp } from './guardrails/glob.js';
import { shownPath } from './path-text.js';
import { lintSkill, SKILL_SECTIONS } from './skill-lint.js';
import { defaultBranchRefusal, type PushGuard } from './push-guard.js';

export interface PushLimits {
  max_file_mb: number;
  max_changed_lines: number;
  refuse_paths: string[];
}

export const DEFAULT_PUSH_LIMITS: PushLimits = { max_file_mb: 10, max_changed_lines: 1500, refuse_paths: [] };

const WORKFLOWS = '.github/workflows/';
const MB = 1024 * 1024;

// Replace refs off (#928, round 4): a `git replace` of a 3 MB blob with a small one got past the size limit (measured).
// #927 moves this onto its git runner, which sets the same and more.
const git = (cwd: string, args: string[], input?: string) => execFileSync('git', ['--no-replace-objects', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * MB, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });

const list = (paths: string[], n = 10) => `${paths.slice(0, n).join(', ')}${paths.length > n ? ` and ${paths.length - n} more` : ''}`;
/** Changed paths in a problem's text, each as shownPath shows it (#683): `rev-list --objects` prints a name as it is. */
const listPaths = (paths: string[], n = 10) => list(paths.map(shownPath), n);

/** git's own complaint in a failed call's error, on one line: its `fatal:` or `error:` line when there is one. */
function whyFailed(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown };
  const text = typeof err.stderr === 'string' && err.stderr.trim() ? err.stderr : String(err.message ?? e);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const said = lines.map((l) => /\b(?:fatal|error): .*/.exec(l)?.[0]).find(Boolean) ?? lines[0] ?? 'no reason given';
  return said.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
}

/** The refusal when a read of the range fails (#981): nothing half-read is judged clean. */
const unreadRefusal = (e: unknown) =>
  `the push limits couldn't read the range (${whyFailed(e)}): nothing is judged clean, so nothing is pushed. If something changed the repository while they ran, the next try reads it again`;

declare const COMMIT: unique symbol;
/** A commit's id as commitIds read it: judge takes only these, never a name or a tree's id (#966). */
type CommitId = string & { readonly [COMMIT]: true };

/**
 * The range's ends as commit ids, read once (#981): every later call reads these, never the names, so a branch moved
 * or deleted between the check's git calls, or before the push, changes nothing. Throws as git does on a bad name,
 * and on an end that is no commit (a tree, a blob, a tag of either), whose range would list no names (#966).
 */
const commitIds = (cwd: string, base: string, head: string): [CommitId, CommitId] =>
  [base, head].map((r) => git(cwd, ['rev-parse', '--verify', '--end-of-options', `${r}^{commit}`]).trim()) as [CommitId, CommitId];

/**
 * A name's spellings as Unicode can write it: as it is, NFC and NFD (#966). On Linux `café` written either way is two
 * different files, so a refused path in one form is matched against a glob in the other.
 */
const spellings = (s: string): string[] => [...new Set([s, s.normalize('NFC'), s.normalize('NFD')])];

/** A test of a path against globs, true when any spelling of the path matches any spelling of a glob. */
function matcher(globs: string[]): (path: string) => boolean {
  const res = globs.flatMap((g) => spellings(g).map((s) => globRegExp(s, 'deny')));
  return (path) => spellings(path).some((p) => res.some((re) => re.test(p)));
}

/**
 * The range's problems and the head commit they were judged at. Never throws (#981): a git call that fails, as one
 * does when the repo changes under it, is the one refusal, so a caller's tick goes on and nothing is pushed.
 */
function checkRange(cwd: string, base: string, head: string, limits: PushLimits): { problems: string[]; head: string | null } {
  try {
    const [b, h] = commitIds(cwd, base, head);
    return { problems: judge(cwd, b, h, limits), head: h };
  } catch (e) {
    return { problems: [unreadRefusal(e)], head: null };
  }
}

/** Every reason the range base..head may not be pushed; empty means it may. Never throws: a failed read is a reason. */
export function pushProblems(cwd: string, base: string, head: string, limits: PushLimits): string[] {
  return checkRange(cwd, base, head, limits).problems;
}

function judge(cwd: string, base: CommitId, head: CommitId, limits: PushLimits): string[] {
  const range = `${base}..${head}`;
  const problems: string[] = [];
  // Paths touched by any commit in the range, not just the net diff, each as itself (#724): a name git would quote
  // (a non-ASCII byte, a newline, a quote) is matched by its own bytes, not its quoted text.
  const touched = rangeNames(cwd, range);

  const workflows = touched.filter((p) => p.startsWith(WORKFLOWS));
  if (workflows.length) problems.push(`changes CI workflows (${listPaths(workflows)}): the harness's GitHub credential has no Workflows permission, so GitHub refuses this push; a human makes workflow changes`);

  const refusedPath = matcher(limits.refuse_paths);
  const refused = touched.filter(refusedPath);
  if (refused.length) problems.push(`touches paths that are never pushed (${listPaths(refused)}), matching push.refuse_paths; remove them from every commit on the branch, not just the last one`);

  // A name no checkout would write: a crafted tree can hold an empty, ".", ".." or ".git" segment, and
  // `./secrets/x.pem` matched no `secrets/**` glob (measured, #928's round-4 check). Fails closed.
  const unwritable = touched.filter((p) => p.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git'));
  if (unwritable.length) problems.push(`has paths no checkout would write (${listPaths(unwritable)}): an empty, ".", ".." or ".git" part; a tree like that is crafted, not committed by git`);

  // Every blob new in the range, with its path: a file added and then deleted is still pushed.
  const paths = new Map<string, string>();
  for (const l of git(cwd, ['rev-list', '--objects', range]).split('\n')) {
    const [sha, ...p] = l.split(' ');
    if (sha && p.length) paths.set(sha, p.join(' '));
  }
  const objects = [...paths.keys()];
  if (objects.length) {
    const limit = limits.max_file_mb * MB;
    const big: string[] = [];
    for (const l of git(cwd, ['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize)'], `${objects.join('\n')}\n`).split('\n')) {
      const [type, sha, size] = l.split(' ');
      if (type === 'blob' && Number(size) > limit) big.push(`${shownPath(paths.get(sha!) ?? sha!)} (${(Number(size) / MB).toFixed(1)} MB)`);
    }
    if (big.length) problems.push(`has files over the ${limits.max_file_mb} MB limit (${list(big)}) in its commits; remove them from every commit on the branch`);
  }

  // Through the one changed-files reader (#693): a file a `-diff` or `binary` attribute marks counts its lines. It pairs
  // renames only as the git config says, like the plain `git diff` count it replaces: a pure rename counts 0 by
  // default and in full where the config turns pairing off, never fewer lines than before.
  const lines = sizeFiles(cwd, base, head, { renames: 'configured' }).reduce((s, f) => s + f.added.length + f.removed.length, 0);
  if (lines > limits.max_changed_lines) problems.push(`changes ${lines} lines, over the ${limits.max_changed_lines}-line limit (push.max_changed_lines); split it into smaller changes`);

  // Skills the change adds or edits must pass the skill lint as they stand at head. Each is read from head's tree by
  // its bytes (#724): a name with no entry there was deleted by the change; one that isn't a regular file of at most
  // SKILL_MAX_BYTES (a symlink, a submodule link, a huge blob) is a problem, never linted as something else or skipped.
  const badSkills: string[] = [];
  // A skill is prose: a bigger SKILL.md is refused, never read whole.
  const SKILL_MAX_BYTES = MB;
  const skills = touched.filter((t) => t === 'SKILL.md' || t.endsWith('/SKILL.md'));
  const atHead = blobsByName(cwd, head, skills, SKILL_MAX_BYTES);
  for (const p of skills) {
    for (const file of atHead.get(p) ?? []) {
      const lint = 'text' in file ? lintSkill(file.text) : [`can't be read at the head: ${file.unread}`];
      if (lint.length) badSkills.push(`${shownPath(p)} (${lint.join('; ')})`);
    }
  }
  if (badSkills.length) problems.push(`has skills that fail the skill lint: ${list(badSkills, 5)}. Every SKILL.md needs these sections, none empty: ${SKILL_SECTIONS.join(', ')}`);
  return problems;
}

export type PushResult = { ok: true } | { ok: false; refused: string[] } | { ok: false; error: string };

/**
 * The only way the coordinator pushes code: the limits first, then the push.
 * `force` replaces the branch (a task branch the harness owns); `expect` updates
 * it only if the remote is still exactly at that commit (never over someone
 * else's push); with neither, the push succeeds only as a fast-forward.
 * `guard`: the default branch is never pushed (push-guard.ts), except as the direct land (land_mode direct); a push
 * to it is refused before anything else and recorded through the guard.
 * What is pushed is the head commit the limits judged, by id (#981).
 */
export function checkedPush(o: { cwd: string; remote: string; base: string; head: string; ref: string; limits: PushLimits; guard: PushGuard; force?: boolean; expect?: string }): PushResult {
  const main = defaultBranchRefusal(o.guard, o.ref, o.head);
  if (main) return { ok: false, refused: [main] };
  const checked = checkRange(o.cwd, o.base, o.head, o.limits);
  if (checked.problems.length || !checked.head) return { ok: false, refused: checked.problems };
  const lease = o.expect ? [`--force-with-lease=${o.ref}:${o.expect}`] : [];
  // The commit the limits judged, by id: never o.head's name, which may point elsewhere by now.
  const push = spawnSync('git', ['push', ...lease, o.remote, `${o.force ? '+' : ''}${checked.head}:${o.ref}`], { cwd: o.cwd, encoding: 'utf8' });
  if (push.status !== 0) return { ok: false, error: (push.stderr || '').trim() };
  return { ok: true };
}

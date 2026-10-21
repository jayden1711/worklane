// Push limits. Every push of agent-written code goes through checkedPush,
// which first refuses a range that is too big, carries an oversized or
// refused file in any of its commits (one added and later deleted still
// counts: it stays in the history that's pushed), changes CI workflows, or
// leaves a SKILL.md that fails the skill lint.
// The coordinator also runs pushProblems on each change before verifying it,
// so a doomed change is caught before a long test run.
import { blobsByName, rangeNames, sizeFiles } from './coordinator/change-files.js';
import { globToRegExp } from './guardrails/glob.js';
import { gitExecFileSync, gitSnapshot, gitSpawnSync, type GitSnapshot } from './os/git.js';
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

// Through the git runner (#807): replace refs and grafts off, the commit-graph off. #928's round 4 measured a
// `git replace` of a 3 MB blob with a small one getting past the size limit; the runner turns replace refs off.
const git = (cwd: string, args: string[], input?: string) => gitExecFileSync(args, { cwd, encoding: 'utf8', maxBuffer: 256 * MB, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });

const list = (paths: string[], n = 10) => `${paths.slice(0, n).join(', ')}${paths.length > n ? ` and ${paths.length - n} more` : ''}`;
/** Changed paths in a problem's text, each as shownPath shows it (#683): `rev-list --objects` prints a name as it is. */
const listPaths = (paths: string[], n = 10) => list(paths.map(shownPath), n);

/** The refusal for a range the push limits can't read whole (#807). */
const cutRefusal = (why: string) =>
  `this repo's history is cut inside the range (${why}): the push limits can't read it whole, so nothing is pushed. A shallow clone pushes only changes above its cut; fetch the rest (git fetch --unshallow), or remove a .git/shallow file nobody meant to write`;

/** base and head as commit ids, read in the repo (the snapshot has no refs). Throws as git does on a bad name. */
const commitIds = (cwd: string, base: string, head: string): [string, string] =>
  [base, head].map((r) => git(cwd, ['rev-parse', '--verify', '--end-of-options', `${r}^{commit}`]).trim()) as [string, string];

/**
 * Why base..head can't be read whole in `snap`, or null (#807). A shallow repo's `shallow` file lists commits whose
 * parents git treats as missing, and any agent can write it into the shared repo: a commit listed inside the range cut
 * the walks short (a refused file in an earlier commit read as 0 problems, measured). A cut outside the range (a
 * depth-limited clone's base, the harness-eval replay's clone) leaves the range whole and is fine.
 */
function cutIn(snap: GitSnapshot, base: string, head: string): string | null {
  const inRange = snap.cutInRange(base, head);
  return inRange.length ? cutRefusal(`a shallow boundary at ${inRange.slice(0, 3).map((c) => c.slice(0, 12)).join(', ')}`) : null;
}

/** A gitSnapshot of `cwd`, or the refusal when one can't be taken (a shallow file it can't read the way git might). */
function snapshotOf(cwd: string): GitSnapshot | string {
  try {
    return gitSnapshot(cwd);
  } catch (e) {
    return cutRefusal(String((e as Error).message).split('\n')[0]!);
  }
}

/**
 * Why `cwd`'s history is cut inside base..head right now, or null: the check checkedPush makes once more right before
 * the push. Fails closed.
 */
export function shallowCut(cwd: string, base: string, head: string): string | null {
  const snap = snapshotOf(cwd);
  if (typeof snap === 'string') return snap;
  try {
    const [b, h] = commitIds(cwd, base, head);
    return cutIn(snap, b, h);
  } finally {
    snap.dispose();
  }
}

/**
 * Every reason the range base..head may not be pushed; empty means it may. Every walk of the range reads one
 * gitSnapshot, the one whose shallow file was checked, so a cut written or removed while they run changes nothing
 * (#927: toggling it every ~3 ms beat the old before-and-after checks in 23 of 150 runs, measured).
 */
export function pushProblems(cwd: string, base: string, head: string, limits: PushLimits): string[] {
  const snap = snapshotOf(cwd);
  if (typeof snap === 'string') return [snap];
  try {
    return judge(cwd, snap, ...commitIds(cwd, base, head), limits);
  } finally {
    snap.dispose();
  }
}

function judge(cwd: string, snap: GitSnapshot, base: string, head: string, limits: PushLimits): string[] {
  const cut = cutIn(snap, base, head);
  if (cut) return [cut];
  const range = `${base}..${head}`;
  // The range's walks, through the snapshot.
  const walk = (args: string[], input?: string) => gitExecFileSync(args, { env: snap.env, encoding: 'utf8', maxBuffer: 256 * MB, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });
  const problems: string[] = [];
  // Paths touched by any commit in the range, not just the net diff, each as itself (#724): a name git would quote
  // (a non-ASCII byte, a newline, a quote) is matched by its own bytes, not its quoted text. Through the snapshot.
  const touched = rangeNames(cwd, range, snap.env);

  const workflows = touched.filter((p) => p.startsWith(WORKFLOWS));
  if (workflows.length) problems.push(`changes CI workflows (${listPaths(workflows)}): the harness's GitHub credential has no Workflows permission, so GitHub refuses this push; a human makes workflow changes`);

  const refuseRes = limits.refuse_paths.map((g) => ({ g, re: globToRegExp(g) }));
  const refused = touched.filter((p) => refuseRes.some(({ re }) => re.test(p)));
  if (refused.length) problems.push(`touches paths that are never pushed (${listPaths(refused)}), matching push.refuse_paths; remove them from every commit on the branch, not just the last one`);

  // A name no checkout would write: a crafted tree can hold an empty, ".", ".." or ".git" segment, and
  // `./secrets/x.pem` matched no `secrets/**` glob (measured, #928's round-4 check). Fails closed.
  const unwritable = touched.filter((p) => p.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git'));
  if (unwritable.length) problems.push(`has paths no checkout would write (${listPaths(unwritable)}): an empty, ".", ".." or ".git" part; a tree like that is crafted, not committed by git`);

  // Every blob new in the range, with its path: a file added and then deleted is still pushed.
  const paths = new Map<string, string>();
  for (const l of walk(['rev-list', '--objects', range]).split('\n')) {
    const [sha, ...p] = l.split(' ');
    if (sha && p.length) paths.set(sha, p.join(' '));
  }
  const objects = [...paths.keys()];
  if (objects.length) {
    const limit = limits.max_file_mb * MB;
    const big: string[] = [];
    for (const l of walk(['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize)'], `${objects.join('\n')}\n`).split('\n')) {
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
  const atHead = blobsByName(cwd, head, skills, SKILL_MAX_BYTES, snap.env);
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
 */
export function checkedPush(o: { cwd: string; remote: string; base: string; head: string; ref: string; limits: PushLimits; guard: PushGuard; force?: boolean; expect?: string }): PushResult {
  const main = defaultBranchRefusal(o.guard, o.ref, o.head);
  if (main) return { ok: false, refused: [main] };
  const refused = pushProblems(o.cwd, o.base, o.head, o.limits);
  if (refused.length) return { ok: false, refused };
  // Once more right before the push, in this process: a cut written since the limits ran (#807).
  const late = shallowCut(o.cwd, o.base, o.head);
  if (late) return { ok: false, refused: [late] };
  const lease = o.expect ? [`--force-with-lease=${o.ref}:${o.expect}`] : [];
  const push = gitSpawnSync(['push',...lease, o.remote, `${o.force ? '+' : ''}${o.head}:${o.ref}`], { cwd: o.cwd, encoding: 'utf8' });
  if (push.status !== 0) return { ok: false, error: (push.stderr || '').trim() };
  return { ok: true };
}

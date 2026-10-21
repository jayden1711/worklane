// Push limits. Every push of agent-written code goes through checkedPush,
// which first refuses a range that is too big, carries an oversized or
// refused file in any of its commits (one added and later deleted still
// counts: it stays in the history that's pushed), changes CI workflows, or
// leaves a SKILL.md that fails the skill lint.
// The coordinator also runs pushProblems on each change before verifying it,
// so a doomed change is caught before a long test run.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sizeFiles } from './coordinator/change-files.js';
import { globToRegExp } from './guardrails/glob.js';
import { gitExecFileSync, gitSpawnSync } from './os/git.js';
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

const git = (cwd: string, args: string[], input?: string) => gitExecFileSync(args, { cwd, encoding: 'utf8', maxBuffer: 256 * MB, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}) });

const list = (paths: string[], n = 10) => `${paths.slice(0, n).join(', ')}${paths.length > n ? ` and ${paths.length - n} more` : ''}`;
/** Changed paths in a problem's text, each as shownPath shows it (#683): `rev-list --objects` prints a name as it is. */
const listPaths = (paths: string[], n = 10) => list(paths.map(shownPath), n);

/**
 * Why the range can't be read whole, or null (#807). A shallow repo's `shallow` file lists commits whose parents git
 * then treats as missing, and any agent can write it into the shared repo: a commit listed inside the range cuts the
 * walks below short (a refused file in an earlier commit read as 0 problems, measured). A cut outside the range (a
 * depth-limited clone's base, the harness-eval replay's clone) leaves the range whole and is fine. Fails closed: a
 * shallow file or range it can't read is a refusal too. WHY not `--shallow-file`: it is git's internal option.
 */
export function shallowCut(cwd: string, range: string): string | null {
  const refuse = (why: string) =>
    `this repo's history is cut inside the range (${why}): the push limits can't read it whole, so nothing is pushed. A shallow clone pushes only changes above its cut; fetch the rest (git fetch --unshallow), or remove a .git/shallow file nobody meant to write`;
  try {
    const file = resolve(cwd, gitExecFileSync(['rev-parse', '--git-path', 'shallow'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    if (!existsSync(file)) return null;
    const cut = new Set(readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
    if (!cut.size) return null;
    const inRange = git(cwd, ['rev-list', range]).split('\n').filter((c) => cut.has(c));
    return inRange.length ? refuse(`a shallow boundary at ${inRange.slice(0, 3).map((c) => c.slice(0, 12)).join(', ')}`) : null;
  } catch (e) {
    return refuse(`can't read its shallow file: ${String((e as Error).message).split('\n')[0]}`);
  }
}

/** Every reason the range base..head may not be pushed; empty means it may. */
export function pushProblems(cwd: string, base: string, head: string, limits: PushLimits): string[] {
  const range = `${base}..${head}`;
  // Before the walks (a cut already there) and again after them (one written while they ran): a cut range is judged
  // by nothing else.
  const before = shallowCut(cwd, range);
  if (before) return [before];
  const problems: string[] = [];
  // Paths touched by any commit in the range, not just the net diff.
  const touched = [...new Set(git(cwd, ['log', '--format=', '--name-only', '--no-renames', '--diff-merges=first-parent', range]).split('\n').filter(Boolean))];

  const workflows = touched.filter((p) => p.startsWith(WORKFLOWS));
  if (workflows.length) problems.push(`changes CI workflows (${listPaths(workflows)}): the harness's GitHub credential has no Workflows permission, so GitHub refuses this push; a human makes workflow changes`);

  const refuseRes = limits.refuse_paths.map((g) => ({ g, re: globToRegExp(g) }));
  const refused = touched.filter((p) => refuseRes.some(({ re }) => re.test(p)));
  if (refused.length) problems.push(`touches paths that are never pushed (${listPaths(refused)}), matching push.refuse_paths; remove them from every commit on the branch, not just the last one`);

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

  // Skills the change adds or edits must pass the skill lint as they stand at head.
  const badSkills: string[] = [];
  for (const p of touched.filter((t) => t === 'SKILL.md' || t.endsWith('/SKILL.md'))) {
    const r = gitSpawnSync(['show',`${head}:${p}`], { cwd, encoding: 'utf8', maxBuffer: 16 * MB });
    if (r.status !== 0) continue; // deleted by the change
    const lint = lintSkill(r.stdout);
    if (lint.length) badSkills.push(`${shownPath(p)} (${lint.join('; ')})`);
  }
  if (badSkills.length) problems.push(`has skills that fail the skill lint: ${list(badSkills, 5)}. Every SKILL.md needs these sections, none empty: ${SKILL_SECTIONS.join(', ')}`);
  const after = shallowCut(cwd, range);
  return after ? [after] : problems;
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
  const late = shallowCut(o.cwd, `${o.base}..${o.head}`);
  if (late) return { ok: false, refused: [late] };
  const lease = o.expect ? [`--force-with-lease=${o.ref}:${o.expect}`] : [];
  const push = gitSpawnSync(['push',...lease, o.remote, `${o.force ? '+' : ''}${o.head}:${o.ref}`], { cwd: o.cwd, encoding: 'utf8' });
  if (push.status !== 0) return { ok: false, error: (push.stderr || '').trim() };
  return { ok: true };
}

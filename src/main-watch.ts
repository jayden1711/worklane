// Main watch: the harness's own guard for a default branch GitHub doesn't protect (a private repo on GitHub Free, where
// branch protection and rulesets return 403). On by default when the protection API says there is none (403 or 404).
// On the coordinator's timer, making at most one GitHub API call a minute, it checks every new commit on the default
// branch, oldest first along the first-parent line. A commit is accounted for when it is either
//   (a) a merge the harness itself did (merge.done), of a head whose required_checks were green when it merged, or
//   (b) a merge of a PR by a mapped admin or writer (their role from their repo permission, as the dashboard reads
//       it), with required_checks green on the PR's head at merge time.
// Anything else is unaccounted: a direct push, a PR merged with failing, missing or pending checks, an unknown actor
// or a bot, a rewritten history. The coordinator then stops auto-merge (the stop file), alerts, and opens a revert PR
// for a human (coordinator/merge-flow.ts), within its caps: per trip (one pass's unaccounted commits with one reason)
// and per day; a capped commit still stops and alerts. A rebase-merged PR's commit is reverted with the PR's later
// commits, in one revert; when there is no revert PR, the alert says why. A required check with no run for days is warned of once,
// saying when the Actions workflow that would post it is disabled (one read of the workflows, where the token may).
// A commit that landed without a PR at all (GitHub's commit-to-PR link has
// no merged PR for it, or a force-push rewrote the branch) is also posted to the ops channel at once, mentioning the
// Discord owners (src/direct-push-alert.ts; config.yaml main_watch.direct_push_alert, on by default). The last checked commit is kept in a state file, so a restart neither
// checks a commit twice nor skips one; so is the time of the last call, so the limit holds across restarts too.
//
// Which PR a commit belongs to is GitHub's answer, never git's: the commit-to-PR link (GET /commits/{sha}/pulls),
// asked again for up to LINK_LAG_MS while it is still empty (GitHub links a merge a few seconds after it lands); the
// PR's merge_commit_sha; and for a commit inside a rebase merge, compare (GET /compare/{sha}...{merge commit}) against
// the PR's commit count. Git only reads the branch itself: its tip, whether it was rewritten, its first-parent line,
// a commit's parents and the config committed at a commit.
//
// A bootstrap merge: while a project's required check can't run yet, an admin's hand merge is unaccounted. An admin
// may accept such a commit on the dashboard before the watch judges it (acceptMerge): by its sha, once it is on the
// branch and not judged yet, or in advance by PR number, pinned to the PR's head as it is then. The watch then judges
// it accounted (how 'accepted'): no stop, no alert, no revert PR. A rewrite, a commit not on the branch and one
// already judged can't be accepted, and accepting never clears a stop.
//
// The required_checks a commit is judged by are the ones in force when it landed: config.yaml as committed at its
// first parent, read with git. Not the config loaded at startup: the clone's working tree isn't updated as the default
// branch moves, so a check dropped since would still be required of every later merge, and never report.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import { ProjectConfig } from './config/schema.js';
import { fromPinnedSource, pinOf, type CheckPin, type GithubCheckApps, type WorkflowSource } from './check-source.js';
import { writeGroupOnly } from './os/index.js';
import type { Role } from './dashboard-auth.js';

/** At most one GitHub API call per this long. */
export const MAIN_WATCH_CALL_MS = 60_000;
/**
 * How long an empty commit-to-PR link is asked again before it counts as "no PR": GitHub links a merge commit to its
 * PR a few seconds after the merge (main 09f60340 was judged 6 s after #307 landed, with the link still empty).
 */
export const LINK_LAG_MS = 120_000;
/** How often whether GitHub protects the branch is asked again. */
export const PROTECTION_RECHECK_MS = 6 * 3600_000;

/** github: GitHub enforces the branch's protection; main_watch: it doesn't, and this watch guards it; off: neither. */
export type ProtectionMode = 'github' | 'main_watch' | 'off';

export interface CheckRunAt {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Its id and page, the GitHub App that posted it, and its check suite (#727: what its source is judged by). */
  id?: number;
  url?: string;
  app?: number;
  suite?: number;
}
export interface StatusAt {
  context: string;
  state: string;
  createdAt: string;
}
export interface MergedPull {
  number: number;
  url: string;
  mergedAt: string | null;
  mergeCommit: string | null;
  mergedBy: string | null;
  mergedByBot: boolean;
  head: string;
  base: string;
  /** How many commits the PR has (GET /pulls/{n} only; the commit-to-PR list leaves it out). */
  commits?: number;
}

/** GitHub's compare of two commits (GET /compare/{base}...{head}): how far `head` is ahead of and behind `base`. */
export interface Compared {
  status: string;
  aheadBy: number;
  behindBy: number;
}

/**
 * A GitHub Actions workflow as the workflows API lists it (GET /repos/{o}/{r}/actions/workflows): its name, its file
 * and its `state` (GitHub's REST description: active, deleted, disabled_fork, disabled_inactivity, disabled_manually).
 */
export interface WorkflowAt {
  name: string;
  path: string;
  state: string;
}

/** The calls the watch makes: one REST request each (github/main-watch-api.ts). */
export interface MainWatchApi {
  protection(branch: string): Promise<'enforced' | 'none'>;
  commitPulls(sha: string): Promise<MergedPull[]>;
  pull(n: number): Promise<MergedPull>;
  checkRuns(sha: string): Promise<CheckRunAt[]>;
  statuses(sha: string): Promise<StatusAt[]>;
  role(login: string): Promise<Role | null>;
  compare(base: string, head: string): Promise<Compared>;
  /**
   * Who pushed `sha` to `branch`: the GitHub login of the push that made it the branch's tip (the repo's activity),
   * else the commit's own GitHub author (`from: 'commit'`); null when neither is known. A login only, never an email.
   */
  pusher?(branch: string, sha: string): Promise<{ login: string; from: 'activity' | 'commit' } | null>;
  /** The repo's Actions workflows; null when the token may not read them (403) or there are none to read (404). */
  workflows?(): Promise<WorkflowAt[] | null>;
  /** #727: the Actions workflow run behind each check suite on `sha`, by suite id; null when Actions can't be read. */
  runSources?(sha: string): Promise<Record<string, WorkflowSource> | null>;
}

/** What is known about the commit being checked; each field is one API call's answer (harness: the log's). */
export interface Facts {
  harness: { number: number; head: string; at: string } | null;
  pulls?: MergedPull[];
  /** When the pulls call was first and last answered (ms): an empty link is asked again until an answer LINK_LAG_MS after the first. */
  pullsAt?: number;
  pullsLastAt?: number;
  /** A merge commit's own subject names this PR ("Merge #N: …", "Merge pull request #N …"): asked directly when the pulls link is empty. */
  subjectPr?: number | null;
  pr?: MergedPull;
  /** compare(base, head): whether `base` (the commit) is inside the rebase merge ending at `head` (the PR's merge commit). */
  compare?: Compared & { base: string; head: string };
  role?: Role | null;
  runs?: CheckRunAt[];
  statuses?: StatusAt[];
  /** runSources(head): each check suite's workflow run, for a workflow-pinned check (#727). */
  sources?: Record<string, WorkflowSource> | null;
}

export type Need = { call: 'pulls' } | { call: 'pull'; number: number } | { call: 'compare'; base: string; head: string } | { call: 'role'; login: string } | { call: 'runs'; sha: string } | { call: 'statuses'; sha: string } | { call: 'sources'; sha: string } | { call: 'rules' };

/** Required checks pinned to their source (#727, src/check-source.ts): config.yaml's at the commit, GitHub's, the repo. */
export interface WatchPins {
  configured: Record<string, CheckPin>;
  github: GithubCheckApps;
  repo: string;
}
export type Verdict =
  | { done: true; accounted: true; how: 'harness' | 'person'; number: number }
  | { done: true; accounted: true; how: 'accepted'; number: number | null; acceptance: Acceptance }
  | { done: true; accounted: false; reason: string; number: number | null; direct?: true }
  | { done: false; need: Need };

/**
 * A commit an admin accepted as a bootstrap merge before the watch judged it: by `sha` (a commit already on the
 * branch), or by `pr` with `head` its head when accepted (the merge of that PR at that head counts, however it was
 * merged: merge commit, squash or rebase). `base` is the last commit checked when it was accepted: what it accepts
 * must descend from it, so a rewrite of the branch voids it.
 */
export interface Acceptance {
  id: string;
  sha: string | null;
  pr: number | null;
  head: string | null;
  base: string;
  by: string;
  reason: string;
  at: string;
}

export type Outcome = 'pass' | 'fail' | 'pending' | 'missing' | 'unknown';

/**
 * Each required check's outcome on a commit at time `at` (a merge): the check run that had started by then, latest
 * first, passed only if it had completed with success by then; else the commit status set by then. `unknown`: no
 * check run of that name, and the statuses aren't read yet.
 */
export function outcomesAt(required: string[], runs: CheckRunAt[], statuses: StatusAt[] | null, at: string): { name: string; outcome: Outcome }[] {
  const t = Date.parse(at);
  return required.map((name) => {
    const run = runs
      .filter((r) => r.name === name)
      .map((r) => ({ r, start: Date.parse(r.startedAt ?? r.completedAt ?? '') }))
      .filter((x) => Number.isFinite(x.start) && x.start <= t)
      .sort((a, b) => b.start - a.start)[0]?.r;
    if (run) {
      const done = Date.parse(run.completedAt ?? '');
      if (run.status !== 'completed' || !Number.isFinite(done) || done > t) return { name, outcome: 'pending' as const };
      return { name, outcome: run.conclusion === 'success' ? ('pass' as const) : ('fail' as const) };
    }
    if (!statuses) return { name, outcome: 'unknown' as const };
    const st = statuses
      .filter((s) => s.context === name && Date.parse(s.createdAt) <= t)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!st) return { name, outcome: 'missing' as const };
    return { name, outcome: st.state === 'success' ? ('pass' as const) : st.state === 'pending' ? ('pending' as const) : ('fail' as const) };
  });
}

/**
 * #727: a pinned check's outcome at merge time `at` (the owner's rule, 2026-10-19):
 * - `own`, its pinned source's runs: only the latest started by then counts, by the runs' own order (the later
 *   workflow run, then the later check run, as a re-run attempt is; never the list's order), so a later run of that
 *   source supersedes its earlier or cancelled ones; none: missing;
 * - when that one passed, any run of the name from another source (`other`: another App, another workflow, a run for
 *   another head) that isn't a pass then, or the name's latest commit status that isn't success, blocks it.
 */
export function pinnedAt(own: CheckRunAt[], other: CheckRunAt[], statuses: StatusAt[], at: string, workflowOf: (r: CheckRunAt) => { run: number } | null | undefined = () => undefined): Outcome {
  const t = Date.parse(at);
  const started = (r: CheckRunAt) => {
    const s = Date.parse(r.startedAt ?? r.completedAt ?? '');
    return Number.isFinite(s) && s <= t;
  };
  const state = (r: CheckRunAt): Outcome => {
    const done = Date.parse(r.completedAt ?? '');
    if (r.status !== 'completed' || !Number.isFinite(done) || done > t) return 'pending';
    return r.conclusion === 'success' ? 'pass' : 'fail';
  };
  const key = (r: CheckRunAt): [number, number, number] => [workflowOf(r)?.run ?? -1, r.id ?? -1, Date.parse(r.startedAt ?? r.completedAt ?? '')];
  const latest = own.filter(started).sort((a, b) => key(b)[0] - key(a)[0] || key(b)[1] - key(a)[1] || key(b)[2] - key(a)[2])[0];
  if (!latest) return 'missing';
  const mine = state(latest);
  if (mine !== 'pass') return mine;
  for (const r of other.filter(started)) {
    const s = state(r);
    if (s !== 'pass') return s;
  }
  const st = statuses.filter((s) => Date.parse(s.createdAt) <= t).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (st && st.state !== 'success') return st.state === 'pending' ? 'pending' : 'fail';
  return 'pass';
}

/**
 * Is commit `sha` accounted for, given what is known? Or which one call would tell. Pure: the watch and the tests
 * share it. An empty commit-to-PR link is asked again until an answer LINK_LAG_MS after its first one (pullsAt).
 */
export function judge(sha: string, f: Facts, o: { branch: string; required: string[]; accepted?: Acceptance[]; pins?: WatchPins; rulesUnknown?: boolean }): Verdict {
  const short = sha.slice(0, 8);
  const bySha = o.accepted?.find((a) => a.sha === sha);
  if (bySha) return { done: true, accounted: true, how: 'accepted', number: null, acceptance: bySha };
  const byPr = (n: number, h: string): Verdict | null => {
    const a = o.accepted?.find((x) => x.pr === n && x.head === h);
    return a ? { done: true, accounted: true, how: 'accepted', number: n, acceptance: a } : null;
  };
  let head: string;
  let at: string;
  let number: number;
  let who: string;
  if (f.harness) {
    ({ head, at, number } = f.harness);
    who = `the harness merged #${number}`;
    const ok = byPr(number, head);
    if (ok) return ok;
  } else {
    if (!f.pulls) return { done: false, need: { call: 'pulls' } };
    const merged = f.pulls.filter((p) => p.mergedAt && p.base === o.branch);
    let cand = merged.find((p) => p.mergeCommit === sha);
    let notIn = '';
    // A rebase merge puts the PR's commits on the branch one by one, and its merge_commit_sha is the last of them. This
    // commit is one of them when that merge commit is ahead of it by fewer commits than the PR has: GitHub's compare,
    // not git ancestry (every earlier commit on the branch, a direct push too, is an ancestor of a later merge).
    const rebased = cand ? undefined : merged.find((p) => p.mergeCommit);
    if (rebased) {
      if (!f.pr || f.pr.number !== rebased.number) return { done: false, need: { call: 'pull', number: rebased.number } };
      const m = f.pr.mergeCommit;
      if (m && m !== sha && f.pr.mergedAt && f.pr.base === o.branch) {
        if (!f.compare || f.compare.base !== sha || f.compare.head !== m) return { done: false, need: { call: 'compare', base: sha, head: m } };
        const c = f.compare;
        if (c.status === 'ahead' && c.behindBy === 0 && typeof f.pr.commits === 'number' && c.aheadBy < f.pr.commits) cand = f.pr;
        else notIn = ` (#${f.pr.number}'s merge ${m.slice(0, 8)} doesn't include it: ${c.aheadBy} commit(s) ahead of it, and the PR has ${f.pr.commits ?? 'an unknown number of'} commit(s))`;
      }
    }
    // GitHub links a merge commit to its PR a few seconds after the merge, so the pulls call can be empty for a normal
    // merge (main 09f60340, judged 6 s after #307 landed). A merge commit whose subject names a PR: ask that PR, and
    // take it only when its own merge commit is this one (a made-up subject still counts as a direct push).
    if (!cand && !merged.length && f.subjectPr) {
      if (!f.pr || f.pr.number !== f.subjectPr) return { done: false, need: { call: 'pull', number: f.subjectPr } };
      if (f.pr.mergedAt && f.pr.base === o.branch && f.pr.mergeCommit === sha) cand = f.pr;
    }
    if (!cand) {
      // The link is still empty: a squash or rebase merge (no merge subject to go by), or a merge whose subject was
      // edited, may just not be linked yet. Asked again, within the call budget, until an answer LINK_LAG_MS after the first.
      if (!merged.length && f.pullsAt !== undefined && (f.pullsLastAt ?? f.pullsAt) - f.pullsAt < LINK_LAG_MS) return { done: false, need: { call: 'pulls' } };
      const other = f.pulls.find((p) => !p.mergedAt);
      // GitHub's own commit-to-PR link (the pulls call) says no merged PR has it: a direct push.
      return { done: true, accounted: false, number: null, direct: true, reason: `${short} was pushed to ${o.branch} directly: no merged PR has it${notIn}${other ? ` (#${other.number} has it, unmerged)` : ''}` };
    }
    if (!f.pr || f.pr.number !== cand.number) return { done: false, need: { call: 'pull', number: cand.number } };
    number = f.pr.number;
    const ok = byPr(number, f.pr.head);
    if (ok) return ok;
    if (!f.pr.mergedBy) return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by an unknown actor` };
    if (f.pr.mergedByBot) return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by a bot, not a mapped admin or writer` };
    if (f.role === undefined) return { done: false, need: { call: 'role', login: f.pr.mergedBy } };
    if (f.role !== 'owner' && f.role !== 'writer') return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by someone who isn't a mapped admin or writer on the repo` };
    head = f.pr.head;
    at = f.pr.mergedAt ?? '';
    who = `#${number} was merged`;
  }
  if (!o.required.length) return { done: true, accounted: false, number, reason: `${who}, but no required_checks are configured to judge it by` };
  // #727: GitHub's rules have never answered, so which checks they pin is unknown: wait here, at the checks, never
  // judging them by name meanwhile. Everything above (a direct push, an unknown actor, a bot) is judged as before.
  if (o.rulesUnknown) return { done: false, need: { call: 'rules' } };
  if (!f.runs) return { done: false, need: { call: 'runs', sha: head } };
  let out = outcomesAt(o.required, f.runs, f.statuses ?? null, at);
  if (out.some((c) => c.outcome === 'unknown')) {
    if (!f.statuses) return { done: false, need: { call: 'statuses', sha: head } };
    out = outcomesAt(o.required, f.runs, f.statuses, at);
  }
  const pins = o.pins;
  if (pins) {
    // #727 (src/check-source.ts): a pinned check is the latest run of its pinned source started by merge time (a status
    // never is), and it passes only when that run passed and no check of its name from any other source, nor its
    // latest status, is a non-pass then (pinnedAt). An unpinned one is judged by name, as before.
    const pinned = (n: string) => pinOf(n, pins.configured, pins.github);
    if (f.sources === undefined && o.required.some((n) => 'workflow' in (pinned(n) ?? {}))) return { done: false, need: { call: 'sources', sha: head } };
    if (!f.statuses && o.required.some((n) => pinned(n) !== null)) return { done: false, need: { call: 'statuses', sha: head } };
    const workflowOf = (r: CheckRunAt) => (r.suite === undefined ? undefined : (f.sources?.[String(r.suite)] ?? null));
    const isOwn = (r: CheckRunAt, pin: CheckPin) => {
      const workflow = workflowOf(r);
      const c = { source: 'check_run' as const, ...(r.app !== undefined ? { app: r.app } : {}), ...(workflow !== undefined ? { workflow } : {}), ...(r.id !== undefined ? { id: r.id } : {}), ...(r.url !== undefined ? { url: r.url } : {}) };
      return fromPinnedSource(c, pin, { repo: pins.repo, sha: head });
    };
    out = out.map((byName) => {
      const pin = pinned(byName.name);
      if (pin === null) return byName;
      const mine = f.runs!.filter((r) => r.name === byName.name);
      const own = mine.filter((r) => isOwn(r, pin));
      return { name: byName.name, outcome: pinnedAt(own, mine.filter((r) => !own.includes(r)), (f.statuses ?? []).filter((s) => s.context === byName.name), at, workflowOf) };
    });
  }
  const bad = out.filter((c) => c.outcome !== 'pass');
  if (bad.length) return { done: true, accounted: false, number, reason: `${who} into ${o.branch} with required checks not green on ${head.slice(0, 8)} at merge time: ${bad.map((c) => `${c.name} ${c.outcome}`).join(', ')}` };
  return { done: true, accounted: true, how: f.harness ? 'harness' : 'person', number };
}

/** What the watch keeps between ticks and restarts. */
export interface WatchState {
  version: 1;
  mode: ProtectionMode | null;
  detail: string;
  /** When protection was last asked (ms). */
  protectionAt: number;
  /** The last commit checked: everything up to it (first parents) is done. Null: not started (the next tip is the baseline). */
  last: string | null;
  lastAt: string | null;
  /** When the last API call was made (ms): the next waits MAIN_WATCH_CALL_MS. */
  lastCallAt: number;
  /** The commit being checked, and what is known about it so far. */
  pending: { sha: string; facts: Facts } | null;
  /**
   * The pass the pending commit belongs to: the commits after `from` up to `tip`, the tip at one fetch. Unaccounted
   * commits of one pass with the same reason are one trip (tripOf), which opens at most so many revert PRs.
   */
  pass?: { from: string; tip: string } | null;
  /**
   * Required checks with no run or status on the head of any commit judged since `since` (dead checks): `warned`
   * once one has stayed so for main_watch.dead_check_days. Dropped when one appears, or the check isn't required.
   * `workflowAt`: when the Actions workflows were last read for it (ms; read before it is raised, then once per
   * dead window); `workflow`: the disabled workflow that would post it, from that read (disabledWorkflowFor).
   */
  dead?: Record<string, { since: string; warned: boolean; workflowAt?: number; workflow?: WorkflowAt }>;
  /**
   * The required_checks the last judged commit was judged by (requiredAt: as committed before it): what dead checks
   * are raised and dropped against, never the config loaded at startup. Null until a commit is judged.
   */
  deadFor?: string[] | null;
}

const EMPTY: WatchState = { version: 1, mode: null, detail: '', protectionAt: 0, last: null, lastAt: null, lastCallAt: 0, pending: null, pass: null, dead: {} };

/** What caps the revert PRs of a trip, read as committed before its pass (revertCapsAt), so no commit in it changes its own. */
export interface Trip {
  /** The same for every unaccounted commit of one pass with the same reason. */
  id: string;
  perTrip: number;
  perDay: number;
}

/** A trip's id: its pass and its reason. A direct push's reason names its own commit, so it is a trip of its own. */
export function tripOf(pass: { from: string; tip: string }, reason: string): string {
  return createHash('sha256').update(`${pass.from}..${pass.tip}\n${reason}`).digest('hex').slice(0, 16);
}

export function readWatchState(file: string): WatchState {
  if (!existsSync(file)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<WatchState>) };
  } catch {
    return { ...EMPTY };
  }
}

function writeWatchState(file: string, s: WatchState) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeGroupOnly(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

/** Where the admins' acceptances are kept, next to the watch's state file: the dashboard writes it, the watch reads it. */
export function acceptedFileFor(stateFile: string): string {
  return join(dirname(stateFile), 'main-watch-accepted.json');
}

export function readAccepted(file: string): Acceptance[] {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(j) ? (j as Acceptance[]) : [];
  } catch {
    return [];
  }
}

/** The default branch's commits, read with git (no API call). */
export interface WatchGit {
  /** Fetch the default branch and return its tip, or null. */
  tip(): string | null;
  isAncestor(a: string, b: string): boolean;
  /** The first-parent commits after `from` up to `to`, oldest first. */
  firstParents(from: string, to: string): string[];
  /** The content of `path` (from the repo root) as committed at `rev`, or null when git can't read it. */
  show(rev: string, path: string): string | null;
  /** For a merge commit (two parents), the PR number its subject names, or null. */
  mergeSubjectPr?(sha: string): number | null;
}

/** The config file whose required_checks judge a commit, from the repo root. */
export const CONFIG_PATH = `${BRAND.configDir}/config.yaml`;

/**
 * The required_checks in force when commit `sha` landed: config.yaml as committed at its first parent (the default
 * branch just before it). An error when that can't be read or isn't valid; the caller falls back, and says so.
 */
export function requiredAt(git: WatchGit, sha: string): { required: string[]; sources: Record<string, CheckPin> } | { error: string } {
  const at = `${sha.slice(0, 8)}^1`;
  const text = git.show(`${sha}^1`, CONFIG_PATH);
  if (text === null) return { error: `${CONFIG_PATH} could not be read at ${at}` };
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { error: `${CONFIG_PATH} at ${at} is not valid YAML` };
  const raw: unknown = doc.toJS();
  const r = ProjectConfig.shape.required_checks.safeParse(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).required_checks : undefined);
  if (!r.success) return { error: `${CONFIG_PATH} at ${at} has an invalid required_checks` };
  // #727: the sources they are pinned to, as committed with them.
  const s = ProjectConfig.shape.required_check_sources.safeParse(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).required_check_sources : undefined);
  if (!s.success) return { error: `${CONFIG_PATH} at ${at} has an invalid required_check_sources` };
  return { required: r.data, sources: s.data };
}

/**
 * Whether a commit that landed without a PR is posted to the ops channel (config.yaml main_watch.direct_push_alert),
 * as committed at `rev`: the config in force before the push, so a push can't turn off its own alert. On unless it
 * says false; on too when the config can't be read (the alert fails open).
 */
export function directPushAlertAt(git: WatchGit, rev: string): boolean {
  const text = git.show(rev, CONFIG_PATH);
  if (text === null) return true;
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return true;
  const raw: unknown = doc.toJS();
  const mw = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).main_watch : undefined;
  return !(mw && typeof mw === 'object' && (mw as Record<string, unknown>).direct_push_alert === false);
}

/**
 * The revert PR caps (config.yaml main_watch.revert_prs_per_trip and revert_prs_per_day) as committed at `rev`: the
 * defaults when the config can't be read or isn't valid. A cap is at least 1, so no config turns revert PRs off.
 */
export function revertCapsAt(git: WatchGit, rev: string): { perTrip: number; perDay: number } {
  const schema = ProjectConfig.shape.main_watch;
  const text = git.show(rev, CONFIG_PATH);
  const doc = text === null ? null : parseDocument(text, { uniqueKeys: true });
  const raw: unknown = doc && !doc.errors.length ? doc.toJS() : null;
  const r = schema.safeParse(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).main_watch : undefined);
  const mw = r.success ? r.data : schema.parse(undefined);
  return { perTrip: mw.revert_prs_per_trip, perDay: mw.revert_prs_per_day };
}

/** A workflow file larger than this (characters) isn't parsed for its jobs: nothing is said of it. */
export const WORKFLOW_FILE_MAX = 256 * 1024;

/**
 * Whether `check` is `parts` with at least one character in place of each gap between them: GitHub's expansion of a
 * job name whose `${{ … }}` were cut out. Literal parts found leftmost, in order (indexOf): linear in the check's
 * length, never a backtracking pattern.
 */
function globMatch(parts: string[], check: string): boolean {
  const first = parts[0] ?? '';
  const last = parts.at(-1) ?? '';
  if (!check.startsWith(first)) return false;
  let at = first.length;
  for (const p of parts.slice(1, -1)) {
    const i = check.indexOf(p, at + 1);
    if (i < 0) return false;
    at = i + p.length;
  }
  return check.length - last.length >= at + 1 && check.endsWith(last);
}

/**
 * The check names a workflow file's jobs post, as matchers: a job's `name` (or its id when it has none), or that name
 * followed by GitHub's matrix suffix " (…)" or a called workflow's " / …"; a name with `${{ … }}` in it matches any
 * text in each of their places, and one with no literal text besides them matches nothing (it could be any check).
 * None when the file can't be read, is over WORKFLOW_FILE_MAX, or doesn't parse.
 */
function jobChecks(text: string | null): ((check: string) => boolean)[] {
  if (text === null || text.length > WORKFLOW_FILE_MAX) return [];
  try {
    const doc = parseDocument(text);
    const raw: unknown = doc.errors.length ? null : doc.toJS();
    const jobs = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).jobs : null;
    if (!jobs || typeof jobs !== 'object') return [];
    return Object.entries(jobs as Record<string, unknown>).map(([id, job]) => {
      const n = job && typeof job === 'object' && typeof (job as Record<string, unknown>).name === 'string' ? ((job as Record<string, unknown>).name as string) : id;
      const parts = n.split(/\$\{\{.*?\}\}/);
      if (parts.length === 1) return (c: string) => c === n || c.startsWith(`${n} (`) || c.startsWith(`${n} / `);
      if (!parts.join('').trim()) return () => false;
      return (c: string) => globMatch(parts, c);
    });
  } catch {
    return [];
  }
}

/** A workflow's name or path as the dashboard shows it: no control, C1 or bidi characters, at most 200 characters. */
const clipText = (x: string) => x.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]+/g, ' ').slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');

/**
 * For one read of the Actions workflows' list: the disabled workflow (state disabled_*) that would post a check, when
 * no active one would. A workflow posts a check when it is named as the check, its file is named so, or its file
 * (read with `show`, as committed) has a job that posts it. Null says nothing: none found, or an active workflow posts
 * the check too (it may only not have run). Each file is read and parsed at most once per read, and only once a
 * disabled workflow is listed. The fields are clipped for the dashboard (clipText).
 */
export function disabledWorkflowsOf(list: WorkflowAt[], show: (path: string) => string | null): (check: string) => WorkflowAt | null {
  const parsed = new Map<string, ((check: string) => boolean)[]>();
  const posts = (w: WorkflowAt, check: string) => {
    const file = (w.path.split('/').pop() ?? '').replace(/\.ya?ml$/, '');
    if (w.name === check || file === check) return true;
    let jobs = parsed.get(w.path);
    if (!jobs) parsed.set(w.path, (jobs = jobChecks(show(w.path))));
    return jobs.some((m) => m(check));
  };
  const disabled = list.filter((w) => /^disabled_[a-z_]{1,40}$/.test(w.state));
  const active = list.filter((w) => w.state === 'active');
  return (check) => {
    const w = disabled.find((x) => posts(x, check));
    if (!w || active.some((x) => posts(x, check))) return null;
    return { name: clipText(w.name), path: clipText(w.path), state: w.state };
  };
}

/** disabledWorkflowsOf for one check. */
export function disabledWorkflowFor(check: string, list: WorkflowAt[], show: (path: string) => string | null): WorkflowAt | null {
  return disabledWorkflowsOf(list, show)(check);
}

/** WatchGit over a clone: fetches `branch` from `remote` for the tip. */
/** The PR number a merge subject names: "Merge #N: …" (this repo's merges) or GitHub's "Merge pull request #N from …". */
export function subjectPrNumber(subject: string): number | null {
  const m = /^Merge (?:pull request )?#(\d{1,7})\b/.exec(subject);
  return m ? Number(m[1]) : null;
}

export function repoGit(repo: string, remote: string, branch: string): WatchGit {
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  return {
    tip: () => {
      git('fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
      const r = git('rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`);
      return r.status === 0 ? r.stdout.trim() || null : null;
    },
    isAncestor: (a, b) => git('merge-base', '--is-ancestor', a, b).status === 0,
    firstParents: (from, to) => git('rev-list', '--first-parent', '--reverse', `${from}..${to}`).stdout.split('\n').filter(Boolean),
    show: (rev, path) => {
      const r = git('show', `${rev}:${path}`);
      return r.status === 0 ? r.stdout : null;
    },
    mergeSubjectPr: (sha) => {
      const r = git('log', '-1', '--format=%P%n%s', sha);
      if (r.status !== 0) return null;
      const [parents = '', subject = ''] = r.stdout.split('\n');
      return parents.trim().split(' ').length === 2 ? subjectPrNumber(subject) : null;
    },
  };
}

export interface MainWatchDeps {
  stateFile: string;
  branch: string;
  /** The loaded config's required_checks: whether to watch at all, and the fallback when a commit's own can't be read. */
  required: () => string[];
  /**
   * #727: where checks come from GitHub, each must come from its pinned source: the loaded config's pins (the fallback,
   * as for `required`), the Apps GitHub's protection or ruleset requires, and the repo. Absent: no GitHub, names match.
   */
  pins?: { sources: () => Record<string, CheckPin>; github: () => Promise<GithubCheckApps | null>; repo: string };
  /** Why there is nothing to judge commits by, when the config says (No CI, src/ci-none.ts); null: the plain reason. */
  offWhy?: () => string | null;
  api: MainWatchApi;
  git: WatchGit;
  /** The harness's own merge whose merge commit is `sha` (merge.done), or null. */
  harnessMerge(sha: string): { number: number; head: string; at: string } | null;
  now?: () => number;
  /** The mode changed (or its detail): recorded as main_watch.mode. */
  mode(mode: ProtectionMode, detail: string): void;
  checked(sha: string, how: 'harness' | 'person', number: number): void;
  /** An admin accepted it as a bootstrap merge (acceptMerge): accounted, recorded as main_watch.accepted. */
  accepted(sha: string, number: number | null, a: Acceptance): void;
  /**
   * Stop auto-merge, alert, open the revert PR (`revert`: whether one can be made: not for a rewritten history).
   * `push`: it landed without a PR, pushed directly (GitHub confirms no merged PR has it) or by a rewrite (a
   * force-push), with `alert` whether that is posted to the ops channel (directPushAlertAt); null otherwise.
   * `trip`: the trip it belongs to and its caps on revert PRs (null for a rewrite, which has no revert PR).
   * `through`: a commit of a rebase-merged PR, the PR's last commit (GitHub's merge_commit_sha) and its number of
   * commits: its revert PR reverts the PR's commits from it through that one (never more than `commits`), so the PR's
   * later commits to the same files can't make it conflict.
   */
  unaccounted(o: { sha: string; reason: string; number: number | null; revert: boolean; push: { kind: 'direct' | 'rewrite'; alert: boolean } | null; trip: Trip | null; through?: { sha: string; commits: number } | null }): Promise<void>;
  /** How long a required check may have no run before it is a dead check (config.yaml main_watch.dead_check_days). */
  deadCheckMs?: () => number;
  /**
   * A dead check is raised (once per check, until it clears), or cleared: a run of it appeared, or it isn't required
   * now. `workflow`, on a raise: the workflow that would post it is disabled (disabledWorkflowFor).
   */
  deadCheck?(o: { check: string; since: string; state: 'raised' | 'cleared'; workflow?: WorkflowAt }): void;
}

/** The default for main_watch.dead_check_days, in ms. */
export const DEAD_CHECK_MS = 7 * 24 * 3600_000;

export class MainWatch {
  private listedAt = -Infinity;
  /** The required_checks the pending commit is judged by: read with git once per commit. */
  private judgedBy: { sha: string; required: string[]; sources: Record<string, CheckPin>; note: string } | null = null;
  constructor(private readonly d: MainWatchDeps) {}

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  state(): WatchState {
    return readWatchState(this.d.stateFile);
  }

  private setMode(s: WatchState, mode: ProtectionMode, detail: string) {
    if (s.mode === mode && s.detail === detail) return;
    // Guarding from now on (first start, or the protection went away): the tip now is the baseline.
    if (mode === 'main_watch' && s.mode !== 'main_watch') {
      s.last = null;
      s.pending = null;
      s.pass = null;
    }
    s.mode = mode;
    s.detail = detail;
    this.d.mode(mode, detail);
  }

  /** Not watching (land_mode direct, or turned off): recorded, with no API call. */
  off(detail: string) {
    const s = this.state();
    if (s.mode === 'off' && s.detail === detail) return;
    this.setMode(s, 'off', detail);
    writeWatchState(this.d.stateFile, s);
  }

  /** May an API call be made now? If so, it is recorded as made before it is (a crash after it still counts). */
  private take(s: WatchState): boolean {
    if (this.now - s.lastCallAt < MAIN_WATCH_CALL_MS) return false;
    s.lastCallAt = this.now;
    writeWatchState(this.d.stateFile, s);
    return true;
  }

  /**
   * Which required checks a judged commit's head had no run or status of at all (whenever it came): such a check is
   * dead from then (`since`) until one appears. Read from what judging asked anyway, so it costs no API call.
   */
  private seenChecks(s: WatchState, required: string[], f: Facts) {
    if (!f.runs) return;
    const dead = (s.dead ??= {});
    for (const name of required) {
      const seen = f.runs.some((r) => r.name === name) || !!f.statuses?.some((x) => x.context === name);
      const was = dead[name];
      if (seen) {
        if (was?.warned) this.d.deadCheck?.({ check: name, since: was.since, state: 'cleared' });
        delete dead[name];
      } else if (f.statuses && !was) dead[name] = { since: new Date(this.now).toISOString(), warned: false };
    }
  }

  /**
   * Raise each dead check once it has stayed dead long enough; drop one the last judged commit's required_checks
   * (s.deadFor) no longer list. Whether anything changed.
   */
  private deadChecks(s: WatchState): boolean {
    const dead = (s.dead ??= {});
    const after = this.d.deadCheckMs?.() ?? DEAD_CHECK_MS;
    let changed = false;
    for (const [name, d] of Object.entries(dead)) {
      if (s.deadFor && !s.deadFor.includes(name)) {
        if (d.warned) this.d.deadCheck?.({ check: name, since: d.since, state: 'cleared' });
        delete dead[name];
        changed = true;
      } else if (!d.warned && this.now - Date.parse(d.since) >= after && (!this.d.api.workflows || d.workflowAt !== undefined)) {
        // Raised once its workflows were read (workflowRead), so the one warning can say a disabled one.
        d.warned = true;
        this.d.deadCheck?.({ check: name, since: d.since, state: 'raised', ...(d.workflow ? { workflow: d.workflow } : {}) });
        changed = true;
      }
    }
    return changed;
  }

  /**
   * One read of the repo's Actions workflows (api.workflows) for the dead checks due to be raised, so a warning can say
   * when the workflow that would post its check is disabled; read again only once a dead window has passed since (the
   * dashboard's note), while the check stays dead. Never more than that: it is a call like any other, under the limit
   * of one a minute. A 403, a 404 or any error reads as no disabled workflow: the warning goes out as it would without
   * this, at most a call later, and judging and the stop never wait on it. Whether a call was made.
   */
  private async workflowRead(s: WatchState): Promise<boolean> {
    if (!this.d.api.workflows) return false;
    const after = this.d.deadCheckMs?.() ?? DEAD_CHECK_MS;
    const due = Object.entries(s.dead ?? {}).filter(([name, d]) => (!s.deadFor || s.deadFor.includes(name)) && this.now - Date.parse(d.since) >= after && (d.workflowAt === undefined || this.now - d.workflowAt >= after));
    if (!due.length || !this.take(s)) return false;
    let list: WorkflowAt[] | null = null;
    try {
      list = await this.d.api.workflows();
    } catch {
      list = null;
    }
    const last = s.last;
    // One matcher for every check due: each workflow file read and parsed once.
    const of = Array.isArray(list) ? disabledWorkflowsOf(list, (path) => (last ? this.d.git.show(last, path) : null)) : null;
    for (const [name, d] of due) {
      d.workflowAt = this.now;
      const w = of ? of(name) : null;
      if (w) d.workflow = w;
      else delete d.workflow;
    }
    writeWatchState(this.d.stateFile, s);
    return true;
  }

  /** One pass: at most one API call. */
  async step(): Promise<void> {
    const s = this.state();
    const required = this.d.required();
    if (!required.length) {
      this.setMode(s, 'off', this.d.offWhy?.() ?? 'no required_checks in config.yaml to judge commits by');
      return writeWatchState(this.d.stateFile, s);
    }
    // A dead check due to be raised waits on its workflows' read, so that goes first: the protection's recheck (every
    // few hours) can wait the minute.
    if (s.mode === 'main_watch' && (await this.workflowRead(s)) && this.deadChecks(s)) writeWatchState(this.d.stateFile, s);
    if (s.mode === null || s.mode === 'off' || this.now - s.protectionAt >= PROTECTION_RECHECK_MS) {
      if (!this.take(s)) return;
      const p = await this.d.api.protection(this.d.branch);
      s.protectionAt = this.now;
      if (p === 'enforced') this.setMode(s, 'github', `GitHub enforces ${this.d.branch}'s protection`);
      else this.setMode(s, 'main_watch', `GitHub doesn't protect ${this.d.branch} (its protection API says none)`);
      return writeWatchState(this.d.stateFile, s);
    }
    if (s.mode !== 'main_watch') return;
    if (this.deadChecks(s)) writeWatchState(this.d.stateFile, s);
    if (!s.pending) {
      // A fetch (git, not the API) at most as often as a call, too.
      if (this.now - this.listedAt < MAIN_WATCH_CALL_MS) return;
      this.listedAt = this.now;
      const tip = this.d.git.tip();
      if (!tip || tip === s.last) return;
      if (!s.last) {
        s.last = tip;
        s.lastAt = new Date(this.now).toISOString();
        return writeWatchState(this.d.stateFile, s);
      }
      if (!this.d.git.isAncestor(s.last, tip)) {
        const was = s.last;
        await this.d.unaccounted({ sha: tip, reason: `${this.d.branch} was rewritten: ${was.slice(0, 8)}, checked before, is no longer in its history (a force-push)`, number: null, revert: false, push: { kind: 'rewrite', alert: directPushAlertAt(this.d.git, was) }, trip: null });
        s.last = tip;
        s.lastAt = new Date(this.now).toISOString();
        s.pass = null;
        return writeWatchState(this.d.stateFile, s);
      }
      const next = this.d.git.firstParents(s.last, tip)[0];
      if (!next) return;
      // One pass: the commits up to the tip at this fetch. A commit past its tip starts the next pass.
      if (!s.pass || !this.d.git.isAncestor(next, s.pass.tip)) s.pass = { from: s.last, tip };
      s.pending = { sha: next, facts: { harness: this.d.harnessMerge(next), subjectPr: this.d.git.mergeSubjectPr?.(next) ?? null } };
      writeWatchState(this.d.stateFile, s);
    }
    const p = s.pending;
    if (this.judgedBy?.sha !== p.sha) {
      const at = requiredAt(this.d.git, p.sha);
      this.judgedBy = 'required' in at ? { sha: p.sha, required: at.required, sources: at.sources, note: '' } : { sha: p.sha, required, sources: this.d.pins?.sources() ?? {}, note: ` (judged by the required_checks loaded at startup: ${at.error})` };
    }
    const { required: judgedBy, sources, note } = this.judgedBy;
    // What admins accepted, as long as it descends from the commit checked when they did (a rewrite voids it).
    const accepted = readAccepted(acceptedFileFor(this.d.stateFile)).filter((a) => a.base !== p.sha && this.d.git.isAncestor(a.base, p.sha));
    const github = this.d.pins ? await this.d.pins.github() : null;
    // #727: GitHub's rules never answered: judge waits at the checks (need 'rules', no call to make), and everything
    // before them is judged as before.
    const pins = this.d.pins && github ? { pins: { configured: sources, github, repo: this.d.pins.repo } } : {};
    const ctx = { branch: this.d.branch, required: judgedBy, accepted, ...pins, ...(this.d.pins && github === null ? { rulesUnknown: true } : {}) };
    let v = judge(p.sha, p.facts, ctx);
    if (!v.done) {
      if (v.need.call === 'rules') return;
      if (!this.take(s)) return;
      const n = v.need;
      if (n.call === 'pulls') {
        p.facts.pulls = await this.d.api.commitPulls(p.sha);
        p.facts.pullsAt ??= this.now;
        p.facts.pullsLastAt = this.now;
      } else if (n.call === 'compare') p.facts.compare = { ...(await this.d.api.compare(n.base, n.head)), base: n.base, head: n.head };
      else if (n.call === 'pull') p.facts.pr = await this.d.api.pull(n.number);
      else if (n.call === 'role') p.facts.role = await this.d.api.role(n.login);
      else if (n.call === 'runs') p.facts.runs = await this.d.api.checkRuns(n.sha);
      else if (n.call === 'sources') p.facts.sources = (await this.d.api.runSources?.(n.sha)) ?? null;
      else if (n.call === 'statuses') p.facts.statuses = await this.d.api.statuses(n.sha);
      writeWatchState(this.d.stateFile, s);
      v = judge(p.sha, p.facts, ctx);
      if (!v.done) return;
    }
    if (v.accounted && v.how === 'accepted') this.d.accepted(p.sha, v.number, v.acceptance);
    else if (v.accounted) this.d.checked(p.sha, v.how, v.number);
    else {
      // Every unaccounted commit trips (stop, alert); its trip only caps how many revert PRs open.
      const pass = s.pass ?? { from: s.last ?? p.sha, tip: p.sha };
      const trip = { id: tripOf(pass, v.reason + note), ...revertCapsAt(this.d.git, pass.from) };
      // One of a rebase-merged PR's commits (judged by its PR, whose merge commit is a later one): revert through it.
      const pr = v.number !== null && p.facts.pr?.number === v.number ? p.facts.pr : null;
      const m = pr?.mergeCommit ?? null;
      const through = pr && m && m !== p.sha && typeof pr.commits === 'number' && this.d.git.isAncestor(p.sha, m) ? { sha: m, commits: pr.commits } : null;
      await this.d.unaccounted({ sha: p.sha, reason: v.reason + note, number: v.number, revert: true, push: v.direct ? { kind: 'direct', alert: directPushAlertAt(this.d.git, `${p.sha}^1`) } : null, trip, through });
    }
    // Dead checks follow what this commit was judged by: the required_checks committed before it.
    s.deadFor = judgedBy;
    this.seenChecks(s, judgedBy, p.facts);
    this.deadChecks(s);
    this.judgedBy = null;
    s.last = p.sha;
    s.lastAt = new Date(this.now).toISOString();
    s.pending = null;
    writeWatchState(this.d.stateFile, s);
  }
}

/** The protection as the dashboard shows it, from the watch's state file: the mode, and the last commit checked. */
export function protectionView(file: string, repo: string) {
  const s = readWatchState(file);
  return {
    mode: s.mode ?? ('unknown' as const),
    detail: s.detail,
    lastChecked: s.last ? { sha: s.last, url: `https://github.com/${repo}/commit/${s.last}`, at: s.lastAt } : null,
    accepted: readAccepted(acceptedFileFor(file)),
    /**
     * Required checks raised as dead (no run on any commit judged since `since`): merges keep tripping until one posts.
     * `workflow`: the workflow that would post it is disabled, as last read.
     */
    deadChecks: Object.entries(s.dead ?? {})
      .filter(([, d]) => d.warned)
      .map(([check, d]) => ({ check, since: d.since, ...(d.workflow ? { workflow: d.workflow } : {}) })),
  };
}

/** What acceptMerge reads with git: the watch's own, a commit's full sha, and an open PR's head on the remote. */
export interface AcceptGit extends WatchGit {
  /** The full sha of commit `ref` in the clone, or null. */
  resolve(ref: string): string | null;
  /** PR `n`'s head on the remote (refs/pull/n/head), or null. */
  prHead(n: number): string | null;
}

/** AcceptGit over a clone (the instance's repo): the tip is fetched as the watch fetches it. */
export function acceptGit(repo: string, remote: string, branch: string): AcceptGit {
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  return {
    ...repoGit(repo, remote, branch),
    resolve: (ref) => {
      const r = git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
      return r.status === 0 ? r.stdout.trim() || null : null;
    },
    prHead: (n) => {
      const r = git('ls-remote', remote, `refs/pull/${n}/head`);
      const sha = r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? '') : '';
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
  };
}

export type AcceptTarget = { sha: string } | { pr: number };
export type AcceptResult = { ok: true; acceptance: Acceptance } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * An admin accepts a commit as a bootstrap merge, before the watch judges it (the caller checks they are an admin
 * and audits it). By sha: a commit on the branch's first-parent line after the last one checked, or the one being
 * checked. By PR number: the PR's merge to come (or not judged yet), pinned to its head now, so a push to the PR
 * after it needs accepting again. Refused: a branch rewritten since the last check, a commit not on the branch, one
 * already judged (`judgedPrs`: the PRs the watch has judged already), one accepted already. A stop stays.
 */
export function acceptMerge(o: { stateFile: string; git: AcceptGit; branch: string; target: AcceptTarget; reason: string; by: string; judgedPrs: number[]; now?: () => number }): AcceptResult {
  const reason = String(o.reason ?? '').trim();
  if (!reason) return { ok: false, status: 400, error: 'a reason is required' };
  if (reason.length > 500) return { ok: false, status: 400, error: 'the reason is too long (at most 500 characters)' };
  const s = readWatchState(o.stateFile);
  if (s.mode !== 'main_watch') return { ok: false, status: 409, error: `the main watch isn't guarding ${o.branch} (${s.mode ?? 'not started'}): there is nothing to accept` };
  if (!s.last) return { ok: false, status: 409, error: `the main watch has no starting commit yet: the next tip of ${o.branch} is the baseline, and is not judged` };
  const tip = o.git.tip();
  if (!tip) return { ok: false, status: 409, error: `${o.branch} can't be read from the remote` };
  if (!o.git.isAncestor(s.last, tip)) return { ok: false, status: 409, error: `${o.branch} was rewritten since the last commit checked (${s.last.slice(0, 8)}): a force-push can't be accepted` };
  const file = acceptedFileFor(o.stateFile);
  const list = readAccepted(file);
  const base = { id: randomBytes(6).toString('hex'), base: s.last, by: o.by, reason, at: new Date(o.now?.() ?? Date.now()).toISOString() };
  let a: Acceptance;
  if ('sha' in o.target) {
    const given = String(o.target.sha).trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(given)) return { ok: false, status: 400, error: 'a commit sha is 7 to 40 hex characters' };
    const sha = o.git.resolve(given);
    if (!sha) return { ok: false, status: 404, error: `${given.slice(0, 12)} is not a commit on ${o.branch}` };
    if (sha === s.last || o.git.isAncestor(sha, s.last)) return { ok: false, status: 409, error: `${sha.slice(0, 8)} was judged already (the last commit checked is ${s.last.slice(0, 8)})` };
    if (sha !== s.pending?.sha) {
      if (!o.git.isAncestor(sha, tip)) return { ok: false, status: 404, error: `${sha.slice(0, 8)} is not a commit on ${o.branch}` };
      if (!o.git.firstParents(s.last, tip).includes(sha)) return { ok: false, status: 409, error: `${sha.slice(0, 8)} is on ${o.branch}, but not on its first-parent line: the watch judges the merge commit that brought it in; accept that, or the PR` };
    }
    if (list.some((x) => x.sha === sha)) return { ok: false, status: 409, error: `${sha.slice(0, 8)} is accepted already` };
    a = { ...base, sha, pr: null, head: null };
  } else {
    const n = Number(o.target.pr);
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, status: 400, error: 'a PR number is a positive whole number' };
    if (o.judgedPrs.includes(n)) return { ok: false, status: 409, error: `#${n}'s merge was judged already` };
    const head = o.git.prHead(n);
    if (!head) return { ok: false, status: 404, error: `no PR #${n} on the remote` };
    if (o.git.resolve(head) && (head === s.last || o.git.isAncestor(head, s.last))) return { ok: false, status: 409, error: `#${n}'s head ${head.slice(0, 8)} is on ${o.branch} already, at or before the last commit checked: judged already` };
    if (list.some((x) => x.pr === n && x.head === head)) return { ok: false, status: 409, error: `#${n} at ${head.slice(0, 8)} is accepted already` };
    a = { ...base, sha: null, pr: n, head };
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeGroupOnly(tmp, JSON.stringify([...list, a], null, 2));
  renameSync(tmp, file);
  return { ok: true, acceptance: a };
}

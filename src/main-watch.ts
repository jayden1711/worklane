// Main watch: the harness's own guard for a default branch GitHub doesn't protect (a private repo on GitHub Free, where
// branch protection and rulesets return 403). On by default when the protection API says there is none (403 or 404).
// On the coordinator's timer, making at most one GitHub API call a minute, it checks every new commit on the default
// branch, oldest first along the first-parent line. A commit is accounted for when it is either
//   (a) a merge the harness itself did (merge.done), of a head whose required_checks were green when it merged, or
//   (b) a merge of a PR by a mapped admin or writer (their role from their repo permission, as the dashboard reads
//       it), with required_checks green on the PR's head at merge time.
// Anything else is unaccounted: a direct push, a PR merged with failing, missing or pending checks, an unknown actor
// or a bot, a rewritten history. The coordinator then stops auto-merge (the stop file), alerts, and opens a revert PR
// for a human (coordinator/merge-flow.ts). The last checked commit is kept in a state file, so a restart neither
// checks a commit twice nor skips one; so is the time of the last call, so the limit holds across restarts too.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeGroupOnly } from './os/index.js';
import type { Role } from './dashboard-auth.js';

/** At most one GitHub API call per this long. */
export const MAIN_WATCH_CALL_MS = 60_000;
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
}

/** The calls the watch makes: one REST request each (github/main-watch-api.ts). */
export interface MainWatchApi {
  protection(branch: string): Promise<'enforced' | 'none'>;
  commitPulls(sha: string): Promise<MergedPull[]>;
  pull(n: number): Promise<MergedPull>;
  checkRuns(sha: string): Promise<CheckRunAt[]>;
  statuses(sha: string): Promise<StatusAt[]>;
  role(login: string): Promise<Role | null>;
}

/** What is known about the commit being checked; each field is one API call's answer (harness: the log's). */
export interface Facts {
  harness: { number: number; head: string; at: string } | null;
  pulls?: MergedPull[];
  pr?: MergedPull;
  role?: Role | null;
  runs?: CheckRunAt[];
  statuses?: StatusAt[];
}

export type Need = { call: 'pulls' } | { call: 'pull'; number: number } | { call: 'role'; login: string } | { call: 'runs'; sha: string } | { call: 'statuses'; sha: string };
export type Verdict = { done: true; accounted: true; how: 'harness' | 'person'; number: number } | { done: true; accounted: false; reason: string; number: number | null } | { done: false; need: Need };

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
 * Is commit `sha` accounted for, given what is known? Or which one call would tell. Pure: the watch and the tests
 * share it. `inMerge(mergeCommit)`: whether `sha` is one of the commits a rebase merge ending at `mergeCommit` put
 * on the branch (git, no API call).
 */
export function judge(sha: string, f: Facts, o: { branch: string; required: string[]; inMerge?: (mergeCommit: string) => boolean }): Verdict {
  const short = sha.slice(0, 8);
  let head: string;
  let at: string;
  let number: number;
  let who: string;
  if (f.harness) {
    ({ head, at, number } = f.harness);
    who = `the harness merged #${number}`;
  } else {
    if (!f.pulls) return { done: false, need: { call: 'pulls' } };
    const merged = f.pulls.filter((p) => p.mergedAt && p.base === o.branch);
    const cand = merged.find((p) => p.mergeCommit === sha) ?? merged.find((p) => p.mergeCommit && o.inMerge?.(p.mergeCommit));
    if (!cand) {
      const other = f.pulls.find((p) => !p.mergedAt);
      return { done: true, accounted: false, number: null, reason: `${short} was pushed to ${o.branch} directly: no merged PR has it${other ? ` (#${other.number} has it, unmerged)` : ''}` };
    }
    if (!f.pr || f.pr.number !== cand.number) return { done: false, need: { call: 'pull', number: cand.number } };
    number = f.pr.number;
    if (!f.pr.mergedBy) return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by an unknown actor` };
    if (f.pr.mergedByBot) return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by a bot, not a mapped admin or writer` };
    if (f.role === undefined) return { done: false, need: { call: 'role', login: f.pr.mergedBy } };
    if (f.role !== 'owner' && f.role !== 'writer') return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by someone who isn't a mapped admin or writer on the repo` };
    head = f.pr.head;
    at = f.pr.mergedAt ?? '';
    who = `#${number} was merged`;
  }
  if (!o.required.length) return { done: true, accounted: false, number, reason: `${who}, but no required_checks are configured to judge it by` };
  if (!f.runs) return { done: false, need: { call: 'runs', sha: head } };
  let out = outcomesAt(o.required, f.runs, f.statuses ?? null, at);
  if (out.some((c) => c.outcome === 'unknown')) {
    if (!f.statuses) return { done: false, need: { call: 'statuses', sha: head } };
    out = outcomesAt(o.required, f.runs, f.statuses, at);
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
}

const EMPTY: WatchState = { version: 1, mode: null, detail: '', protectionAt: 0, last: null, lastAt: null, lastCallAt: 0, pending: null };

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

/** The default branch's commits, read with git (no API call). */
export interface WatchGit {
  /** Fetch the default branch and return its tip, or null. */
  tip(): string | null;
  isAncestor(a: string, b: string): boolean;
  /** The first-parent commits after `from` up to `to`, oldest first. */
  firstParents(from: string, to: string): string[];
}

/** WatchGit over a clone: fetches `branch` from `remote` for the tip. */
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
  };
}

export interface MainWatchDeps {
  stateFile: string;
  branch: string;
  required: () => string[];
  api: MainWatchApi;
  git: WatchGit;
  /** The harness's own merge whose merge commit is `sha` (merge.done), or null. */
  harnessMerge(sha: string): { number: number; head: string; at: string } | null;
  now?: () => number;
  /** The mode changed (or its detail): recorded as main_watch.mode. */
  mode(mode: ProtectionMode, detail: string): void;
  checked(sha: string, how: 'harness' | 'person', number: number): void;
  /** Stop auto-merge, alert, open the revert PR (`revert`: whether one can be made: not for a rewritten history). */
  unaccounted(o: { sha: string; reason: string; number: number | null; revert: boolean }): Promise<void>;
}

export class MainWatch {
  private listedAt = -Infinity;
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

  /** One pass: at most one API call. */
  async step(): Promise<void> {
    const s = this.state();
    const required = this.d.required();
    if (!required.length) {
      this.setMode(s, 'off', 'no required_checks in config.yaml to judge commits by');
      return writeWatchState(this.d.stateFile, s);
    }
    if (s.mode === null || s.mode === 'off' || this.now - s.protectionAt >= PROTECTION_RECHECK_MS) {
      if (!this.take(s)) return;
      const p = await this.d.api.protection(this.d.branch);
      s.protectionAt = this.now;
      if (p === 'enforced') this.setMode(s, 'github', `GitHub enforces ${this.d.branch}'s protection`);
      else this.setMode(s, 'main_watch', `GitHub doesn't protect ${this.d.branch} (its protection API says none)`);
      return writeWatchState(this.d.stateFile, s);
    }
    if (s.mode !== 'main_watch') return;
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
        await this.d.unaccounted({ sha: tip, reason: `${this.d.branch} was rewritten: ${was.slice(0, 8)}, checked before, is no longer in its history (a force-push)`, number: null, revert: false });
        s.last = tip;
        s.lastAt = new Date(this.now).toISOString();
        return writeWatchState(this.d.stateFile, s);
      }
      const next = this.d.git.firstParents(s.last, tip)[0];
      if (!next) return;
      s.pending = { sha: next, facts: { harness: this.d.harnessMerge(next) } };
      writeWatchState(this.d.stateFile, s);
    }
    const p = s.pending;
    const ctx = { branch: this.d.branch, required, inMerge: (m: string) => m !== p.sha && this.d.git.isAncestor(p.sha, m) };
    let v = judge(p.sha, p.facts, ctx);
    if (!v.done) {
      if (!this.take(s)) return;
      const n = v.need;
      if (n.call === 'pulls') p.facts.pulls = await this.d.api.commitPulls(p.sha);
      else if (n.call === 'pull') p.facts.pr = await this.d.api.pull(n.number);
      else if (n.call === 'role') p.facts.role = await this.d.api.role(n.login);
      else if (n.call === 'runs') p.facts.runs = await this.d.api.checkRuns(n.sha);
      else p.facts.statuses = await this.d.api.statuses(n.sha);
      writeWatchState(this.d.stateFile, s);
      v = judge(p.sha, p.facts, ctx);
      if (!v.done) return;
    }
    if (v.accounted) this.d.checked(p.sha, v.how, v.number);
    else await this.d.unaccounted({ sha: p.sha, reason: v.reason, number: v.number, revert: true });
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
  };
}

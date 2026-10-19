// Required checks pinned to their source (#727). A check matched by name alone turns green for anything that can post
// a check run or a commit status under that name: another GitHub App installed on the repo, a workflow a PR adds (or
// one posting a check run onto another commit through the API), a commit status. So wherever the engine judges a
// check from GitHub (PR readiness, the check of main after a merge, fix-forward, the main watch), a pinned check counts
// only when it came from its name's pinned source:
//   1. config.yaml required_check_sources: { <name>: { app_id: N } } (the GitHub App that posts it) or
//      { <name>: { workflow: .github/workflows/<file> } } (the Actions workflow file that runs it, in this repo, in a
//      workflow run for the very commit judged, as one of that run's own jobs);
//   2. else the App GitHub's own branch protection (app_id) or ruleset (integration_id) requires for that name;
//   3. else none: the check is judged by name, exactly as before pins (the owner's choice, 2026-10-19: an existing
//      install keeps working), and doctor names it (checkSourceDoctor).
// A commit status never satisfies a pin: statuses carry no App. The owner's rule, 2026-10-19, with its round-5
// tightening: a pinned check's own source is grouped by workflow file (one group for an App that isn't Actions), and in
// each group both its latest run (by workflow run, then check run) and its newest check run must pass, so a later run of
// that file supersedes its earlier failed or cancelled runs, but one file never supersedes another, and a re-run that
// failed after a newer run passed still blocks. Every check of its name from any OTHER source must pass too (another
// App, another workflow, a run for another head, a commit status). The one way this is looser than judging by name:
// a pinned file's later run on the head supersedes its own earlier failed or cancelled runs (the owner's decision).
// Gating PRs nobody here wrote is governance mode's job (#704): it refuses to turn on while any required check is
// unpinned (governanceRefusal). An existing install is protected once its owner pins its checks in config.yaml.
// Without GitHub (a file backlog: Backlog.checkApps absent) nobody else can post a check, and names match as before.
// INVARIANT: every judgement (pr-watch.ts readiness and requiredOutcomes, ci-none.ts headChecks, pr-batch.ts mayMerge,
// fix-forward's checks) takes JudgedChecks, and readiness, requiredOutcomes and withTestRuns check at run time that
// their input was made here (assertJudged: a module-private WeakSet, the array and its checks frozen), so a cast, an
// `any` or a mutated array throws. The two makers are PinnedChecks.of and withTestRuns; test/raw-check-reads.ts flags
// any src/ caller of either outside merge-flow.ts and ci-none.ts, and every cast or raw read around them (a lint).
import type { Backlog, CommitCheck } from './backlog/types.js';

declare const JUDGED: unique symbol;
/** GitHub's checks on a commit as the engine judges them (pinned): only PinnedChecks.of and withTestRuns make one. */
export type JudgedChecks = readonly CommitCheck[] & { readonly [JUDGED]: true };
/** Every JudgedChecks this module made: a cast can't add to it. */
const made = new WeakSet<object>();
/** A frozen copy of `c`, each check frozen too, recorded as made here. */
const judged = (c: readonly CommitCheck[]): JudgedChecks => {
  const copy = Object.freeze(
    c.map((x) => {
      const o: CommitCheck = { ...x };
      if (x.workflow) o.workflow = Object.freeze({ ...x.workflow });
      return Object.freeze(o);
    }),
  );
  made.add(copy);
  return copy as unknown as JudgedChecks;
};

/** Throws unless `checks` is a JudgedChecks this module made (never a cast, an `any` or a copy of one). */
export function assertJudged(checks: unknown): asserts checks is JudgedChecks {
  if (typeof checks !== 'object' || checks === null || !made.has(checks) || !Object.isFrozen(checks)) {
    throw new Error('checks to judge must come from PinnedChecks.of (src/check-source.ts): this array was not made there');
  }
}

/**
 * No CI (src/ci-none.ts): the judged checks with every one named like a test-run check taken out, and the event log's
 * test-run checks (this instance's own runs, never GitHub's) in their place.
 */
export function withTestRuns(github: JudgedChecks, names: ReadonlySet<string>, local: CommitCheck[]): JudgedChecks {
  assertJudged(github);
  return judged([...github.filter((c) => !names.has(c.name)), ...local]);
}

/** Where a required check must come from: the App that posts it, or the Actions workflow file that runs it. */
export type CheckPin = { app_id: number } | { workflow: string };
/** Each required check's App as GitHub's branch protection or ruleset requires it (a name absent: any source). */
export type GithubCheckApps = Record<string, number>;
/** The Actions workflow run behind a check run's suite: its id and page, its file, its repo and the commit it ran for. */
export interface WorkflowSource {
  run: number;
  /** The run's own page (html_url): each of its jobs' pages is this plus /job/<id>. */
  url: string;
  path: string;
  repo: string;
  sha: string;
}

/** The pin for `name`: config.yaml's, else the App GitHub requires, else null (judged by name). Own keys only. */
export function pinOf(name: string, configured: Record<string, CheckPin>, github: GithubCheckApps): CheckPin | null {
  if (Object.hasOwn(configured, name)) return configured[name]!;
  return Object.hasOwn(github, name) ? { app_id: github[name]! } : null;
}

/**
 * Is `url` (a check run's html_url) the page of job `id` in workflow run `w`: the run's own page plus /job/<id>, on
 * the same host? A job of an Actions run has exactly that page (measured: .../actions/runs/39197227793/job/117883963166
 * for check run 117883963166). A check run made through the API into an Actions suite has some other page (guess:
 * /<repo>/runs/<id>; not measured).
 */
export function isJobOfRun(url: string | undefined, id: number | undefined, w: Pick<WorkflowSource, 'run' | 'url'>): boolean {
  if (!url || id === undefined) return false;
  try {
    const page = new URL(url);
    const run = new URL(w.url);
    return page.protocol === 'https:' && page.host === run.host && page.pathname.toLowerCase() === `${run.pathname.replace(/\/+$/, '')}/job/${id}`.toLowerCase() && run.pathname.endsWith(`/actions/runs/${w.run}`);
  } catch {
    return false;
  }
}

/**
 * Did this check come from `pin`? A status never does. A workflow pin needs the suite's workflow run in `repo`, for
 * `sha`, from that file, and the check run to be one of that run's own jobs (isJobOfRun).
 */
export function fromPinnedSource(c: Pick<CommitCheck, 'source' | 'app' | 'workflow' | 'id' | 'url'>, pin: CheckPin, o: { repo: string; sha: string }): boolean {
  if (c.source !== 'check_run') return false;
  if ('app_id' in pin) return c.app === pin.app_id;
  const w = c.workflow;
  return !!w && w.path === pin.workflow && w.repo.toLowerCase() === o.repo.toLowerCase() && w.sha === o.sha && isJobOfRun(c.url, c.id, w);
}

const passed = (c: CommitCheck) => c.status === 'completed' && c.conclusion === 'success';

/**
 * The latest of a pinned source's own check runs on a commit, by the runs' own order, never the list's: the later
 * workflow run, then the later check run (a re-run attempt of a job is a newer check run in the same workflow run).
 */
export function latestOwn<C extends Pick<CommitCheck, 'id' | 'workflow'>>(own: readonly C[]): C | undefined {
  const key = (c: C): [number, number] => [c.workflow?.run ?? -1, c.id ?? -1];
  return [...own].sort((a, b) => key(b)[0] - key(a)[0] || key(b)[1] - key(a)[1])[0];
}

/**
 * What decides a pinned source on a commit, failing closed: its runs grouped by workflow file (an Actions run whose
 * workflow can't be read is a group of its own; an App that isn't Actions is one group), and in every group both the
 * latest run (latestOwn) and the newest check run (the highest id: a re-run of an older workflow run is newer) must
 * pass. One file never supersedes another, and a later re-run that failed blocks. Returns the run that decides: the
 * first group's run that isn't a pass, else the latest of all; undefined when there is none.
 */
export function ownVerdict<C extends Pick<CommitCheck, 'id' | 'workflow' | 'status' | 'conclusion'>>(own: readonly C[]): C | undefined {
  const groups = new Map<string, C[]>();
  own.forEach((c, i) => {
    const key = c.workflow ? `file ${c.workflow.path}` : c.workflow === null ? `unread ${c.id ?? `#${i}`}` : 'app';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  });
  const ok = (c: C) => c.status === 'completed' && c.conclusion === 'success';
  for (const g of groups.values()) {
    const latest = latestOwn(g)!;
    const newest = [...g].sort((a, b) => (b.id ?? -1) - (a.id ?? -1))[0]!;
    if (!ok(latest)) return latest;
    if (!ok(newest)) return newest;
  }
  return latestOwn(own);
}

/**
 * The checks on commit `sha` as judged. An unpinned name's checks stay as they are: judged by name, as before pins.
 * A pinned name has its pinned source's deciding run (ownVerdict: per workflow file, the latest and the newest must
 * pass), or none (missing). When that passes but any check of that name from any other source doesn't (another App,
 * another workflow, a run for another head, a commit status), the first such check's state stands instead, without its
 * id or link (it isn't the pinned run): the owner's rule, 2026-10-19.
 */
export function pinnedChecks(checks: readonly CommitCheck[], o: { configured: Record<string, CheckPin>; github: GithubCheckApps | null; repo: string; sha: string }): CommitCheck[] {
  const out: CommitCheck[] = [];
  for (const name of new Set(checks.map((c) => c.name))) {
    const pin = pinOf(name, o.configured, o.github ?? {});
    if (!pin) {
      // GitHub's rules unknown (never answered): the name may be pinned there, so it is missing, never by name.
      if (o.github !== null) out.push(...checks.filter((c) => c.name === name));
      continue;
    }
    const own = checks.filter((c) => c.name === name && fromPinnedSource(c, pin, o));
    const fromPin = ownVerdict(own);
    if (!fromPin) continue;
    const bad = passed(fromPin) ? checks.find((c) => c.name === name && !own.includes(c) && !passed(c)) : undefined;
    out.push(bad ? { name, source: bad.source, status: bad.status, conclusion: bad.conclusion } : fromPin);
  }
  return out;
}

/** The App each required check needs, from GitHub's "get a branch" (classic protection) and "rules for a branch" answers. */
export function githubCheckApps(branch: unknown, rules: unknown): GithubCheckApps {
  const named: [string, unknown][] = [];
  const classic = (branch as { protection?: { required_status_checks?: { checks?: unknown } } } | null)?.protection?.required_status_checks?.checks;
  if (Array.isArray(classic)) for (const c of classic) named.push([c?.context, c?.app_id]);
  for (const r of Array.isArray(rules) ? rules : []) {
    const list = r?.type === 'required_status_checks' ? r.parameters?.required_status_checks : null;
    if (Array.isArray(list)) for (const c of list) named.push([c?.context, c?.integration_id]);
  }
  // WHY: no prototype, so a check GitHub's rules pin under the name "__proto__" keeps its pin (a {} would drop it).
  const out: GithubCheckApps = Object.create(null) as GithubCheckApps;
  const conflicting = new Set<string>();
  for (const [name, id] of named) {
    // -1 or none: GitHub takes any source, so it names no App.
    if (typeof name !== 'string' || typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue;
    if (Object.hasOwn(out, name) && out[name] !== id) conflicting.add(name);
    out[name] = id;
  }
  // WHY: two rules naming different Apps for one check: no single source passes both, so GitHub names none here.
  for (const name of conflicting) delete out[name];
  return out;
}

/** The required checks with no source recorded in config.yaml: judged by name unless GitHub's rules name an App. */
export function unrecorded(required: string[], configured: Record<string, CheckPin>): string[] {
  return required.filter((n) => !Object.hasOwn(configured, n));
}

/**
 * Governance mode (#704) judges PRs nobody here wrote: a workflow such a PR adds, or a check run it posts through the
 * API, could pass a check judged by name. So it can't be on while any required check has no config.yaml pin (an App
 * GitHub's rules name for it doesn't count: for Actions that App is every workflow's). #704 must call this.
 */
export function governanceRefusal(required: string[], configured: Record<string, CheckPin>): string | null {
  const bare = unrecorded(required, configured);
  return bare.length ? `governance mode needs every required check pinned to its source in config.yaml required_check_sources; not pinned: ${bare.join(', ')}` : null;
}

/** doctor's line: each required check with no pin in config.yaml (judged by name), and how to pin it. */
export function checkSourceDoctor(p: { land_mode: string; ci?: string | undefined; required_checks: string[]; required_check_sources: Record<string, CheckPin> }): { level: 'ok' | 'warn'; detail: string } {
  if (p.land_mode !== 'pr' || p.ci === 'none' || !p.required_checks.length) return { level: 'ok', detail: 'no required GitHub checks to pin' };
  const bare = unrecorded(p.required_checks, p.required_check_sources);
  if (!bare.length) return { level: 'ok', detail: `every required check is pinned to its source: ${p.required_checks.join(', ')}` };
  return {
    level: 'warn',
    detail: `no source recorded for ${bare.join(', ')}: each is judged by name (any App or workflow posting that name counts) unless GitHub's branch protection or ruleset names its App. Pin each in config.yaml required_check_sources, e.g. ${JSON.stringify(bare[0])}: { workflow: .github/workflows/<file>.yml } or { app_id: <the App's id> }`,
  };
}

/** How long GitHub's answer on which App each check needs is kept before it is asked again. */
export const CHECK_APPS_TTL_MS = 10 * 60_000;

/**
 * The checks on a commit as the engine judges them (pinnedChecks). One instance per coordinator, so GitHub's
 * protection and rules are read at most once per CHECK_APPS_TTL_MS.
 */
export class PinnedChecks {
  private apps: { at: number; apps: GithubCheckApps } | null = null;
  constructor(private readonly d: { backlog: Pick<Backlog, 'checks' | 'checkApps'>; branch: () => string; repo: () => string; configured: () => Record<string, CheckPin>; now?: () => number }) {}

  /** Whether checks come from GitHub, so pins apply. */
  get enforced(): boolean {
    return typeof this.d.backlog.checkApps === 'function';
  }

  async of(sha: string): Promise<JudgedChecks> {
    const all = await this.d.backlog.checks(sha);
    if (!this.enforced) return judged(all);
    return judged(pinnedChecks(all, { configured: this.d.configured(), github: await this.githubApps(), repo: this.d.repo(), sha }));
  }

  /**
   * GitHub's App per required check; on an error the last answer. Null while GitHub has never answered: then a check
   * config.yaml doesn't pin is unknown, not unpinned, and counts as missing until it does (fail closed).
   */
  async githubApps(): Promise<GithubCheckApps | null> {
    if (!this.d.backlog.checkApps) return {};
    const now = (this.d.now ?? Date.now)();
    if (!this.apps || now - this.apps.at >= CHECK_APPS_TTL_MS) {
      try {
        this.apps = { at: now, apps: await this.d.backlog.checkApps(this.d.branch()) };
      } catch {
        // kept: the last answer, asked again next time
      }
    }
    return this.apps?.apps ?? null;
  }
}

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
//      install keeps working), and doctor prints a paste-ready pin block for it (src/check-pin-block.ts).
// A commit status never satisfies a pin: statuses carry no App. The owner's rule, 2026-10-19, with its round-5 and
// round-6 tightenings (ownVerdict): a pinned check's own runs are grouped by workflow file (an Actions run, by its
// workflow run's file; one whose workflow run wasn't read is a group of its own), and in each file's group both its
// latest run (by workflow run, then check run) and its newest check run must pass, so a later run of that file
// supersedes its earlier failed or cancelled runs, but one file never supersedes another, and a re-run that failed
// after a newer run passed still blocks. A pin to an App that isn't Actions can't be split by file: that App's latest
// check run of the name on the head (the highest id) decides, in whatever check suite, so a later pipeline or re-run of
// that App supersedes its earlier ones (the owner's decision, round 8; round 6 had a failure in another suite block).
// Every check of its name from any OTHER source must pass too (another App, another workflow, a run for another head,
// a commit status). The ways this is looser than judging by name, both the owner's decisions: a pinned workflow
// file's later run on the head supersedes its own earlier failed or cancelled runs, and a pinned non-Actions App's
// later run supersedes its earlier ones. With a check being judged pinned, a commit-status read GitHub refuses at all
// (a 403 or 404 on page 1 too) waits; with none of them pinned, statuses are read as on main, whatever else is pinned
// (the owner's decision, round 8; scoped to the judged names in round 10). Readiness and the main watch judge a pinned name through one function, pinnedVerdict, over the same
// facts (GitHub's latest check run per check suite and name, the workflow run behind each Actions suite, and the
// latest status per context); the watch takes them as they stood at merge time.
// Gating PRs nobody here wrote is governance mode's job (#704): it refuses to turn on while any required check is
// unpinned (governanceRefusal). An existing install is protected once its owner pastes doctor's block.
// Without GitHub (a file backlog: Backlog.checkApps absent) nobody else can post a check, and names match as before.
// INVARIANT: every judgement (pr-watch.ts readiness and requiredOutcomes, pr-batch.ts mayMerge, fix-forward's checks)
// takes JudgedChecks, and readiness and requiredOutcomes check at run time that their input was made here
// (assertJudged: a module-private WeakSet, the array and its checks frozen), so a cast, an `any` or a mutated array
// throws. The one maker is PinnedChecks: it reads its facts itself, from the backlog and (under No CI) the event log it
// is built over, and takes no checks, runs or events from a caller. test/raw-check-reads.ts (makerUses) flags the
// src/ routes to it outside merge-flow.ts that it lists (a name through any alias or barrel, export *, namespace and
// dynamic imports, require(), a createRequire named as such), and every cast or raw read around it. A lint, with named
// gaps: a PinnedChecks over a stand-in backlog (e7) reached by createRequire through a computed key, by
// process.getBuiltinModule, by an import inside new Function, or by `this.pinned.constructor` in a subclass (m11-m14).
import type { Backlog, CommitCheck } from './backlog/types.js';
import { ciIsNone, localRunChecks, testRunCheckNames } from './ci-none.js';
import type { ProjectConfig, TestsConfig } from './config/schema.js';
import type { EventType, StoredEvent } from './events/types.js';

/** GitHub Actions' App id (its check runs' app.id): its runs are judged per workflow file. */
export const ACTIONS_APP_ID = 15368;

declare const JUDGED: unique symbol;
/** GitHub's checks on a commit as the engine judges them (pinned): only PinnedChecks.of makes one. */
export type JudgedChecks = readonly CommitCheck[] & { readonly [JUDGED]: true };
/** Every JudgedChecks this module made: a cast can't add to it. */
const made = new WeakSet<object>();
/** A frozen plain-array copy of `c` (never the caller's own array type), each check frozen too, recorded as made here. */
const judged = (c: readonly CommitCheck[]): JudgedChecks => {
  const copy = Object.freeze(
    Array.from(c, (x) => {
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
 * Of checks that aren't passes, the one to report, the same whatever their order: a finished one (it can't turn
 * green by waiting) before one still running, then the highest id.
 */
function worst<C extends Pick<CommitCheck, 'id' | 'status' | 'conclusion'>>(bad: readonly C[]): C | undefined {
  return [...bad].sort((a, b) => Number(b.status === 'completed') - Number(a.status === 'completed') || (b.id ?? -1) - (a.id ?? -1))[0];
}

/**
 * What decides a pinned source on a commit, failing closed. Its runs are grouped: an Actions run by its workflow file
 * (one whose workflow run can't be read is a group of its own); every run of an App that isn't Actions in one group.
 * - A file's group: both the latest run (latestOwn) and the newest check run (the highest id: a re-run of an older
 *   workflow run is newer) must pass. One file never supersedes another, and a later re-run that failed blocks.
 * - The App group: its latest check run of the name on the head (the highest id) decides, in whatever check suite: a
 *   later pipeline or re-run of that App supersedes its earlier ones (the owner's decision, round 8).
 * - An Actions run whose workflow runs weren't read at all (`workflow` absent: a read made as for a bare name) can't
 *   be put in a file's group, and never in the App group (round 9: that would let `evil.yml` supersede `ci.yml`): the
 *   verdict waits on it (reported as still running), never a pass.
 * Returns the run that decides: a run that isn't a pass (worst), else the latest of all; undefined when there is none.
 */
export function ownVerdict<C extends Pick<CommitCheck, 'id' | 'workflow' | 'status' | 'conclusion' | 'app'>>(own: readonly C[]): C | undefined {
  const groups = new Map<string, C[]>();
  const bad: C[] = [];
  own.forEach((c, i) => {
    if (c.app === ACTIONS_APP_ID && c.workflow === undefined) {
      bad.push({ ...c, status: 'in_progress', conclusion: null });
      return;
    }
    // Only a run of an App that isn't Actions is in the App group.
    const key = c.workflow ? `file ${c.workflow.path}` : c.app === ACTIONS_APP_ID || c.workflow === null ? `unread ${c.id ?? `#${i}`}` : 'app';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  });
  const ok = (c: C) => c.status === 'completed' && c.conclusion === 'success';
  for (const [key, g] of groups) {
    const newest = [...g].sort((a, b) => (b.id ?? -1) - (a.id ?? -1))[0]!;
    const decide = key === 'app' ? [newest] : [latestOwn(g)!, newest];
    bad.push(...decide.filter((c) => !ok(c)));
  }
  return worst(bad) ?? latestOwn(own);
}

/**
 * The one judgement of a pinned name (readiness through pinnedChecks, and the main watch at merge time): from that
 * name's checks on `sha` (GitHub's latest check run per check suite, with each Actions run's workflow run, and the
 * latest status per context), the check that decides it, or undefined (missing). Its pinned source's deciding run
 * (ownVerdict); when that passes but any check of the name from any other source doesn't (another App, another
 * workflow, a run for another head, a commit status), the worst such check's state, without its id or link (it isn't
 * the pinned run): the owner's rule, 2026-10-19.
 */
export function pinnedVerdict(checks: readonly CommitCheck[], pin: CheckPin, o: { repo: string; sha: string }): CommitCheck | undefined {
  const own = checks.filter((c) => fromPinnedSource(c, pin, o));
  const fromPin = ownVerdict(own);
  if (!fromPin) return undefined;
  const bad = passed(fromPin) ? worst(checks.filter((c) => !own.includes(c) && !passed(c))) : undefined;
  return bad ? { name: fromPin.name, source: bad.source, status: bad.status, conclusion: bad.conclusion } : fromPin;
}

/**
 * The checks on commit `sha` as judged. An unpinned name's checks stay as they are: judged by name, exactly as before
 * pins (so never a status beyond the first page main read: `extra`). A pinned name: pinnedVerdict over all of its
 * checks, or none (missing).
 */
export function pinnedChecks(checks: readonly CommitCheck[], o: { configured: Record<string, CheckPin>; github: GithubCheckApps | null; repo: string; sha: string }): CommitCheck[] {
  const out: CommitCheck[] = [];
  for (const name of new Set(checks.map((c) => c.name))) {
    const pin = pinOf(name, o.configured, o.github ?? {});
    if (!pin) {
      // GitHub's rules unknown (never answered): the name may be pinned there, so it is missing, never by name.
      if (o.github !== null) out.push(...checks.filter((c) => c.name === name && !c.extra));
      continue;
    }
    const v = pinnedVerdict(
      checks.filter((c) => c.name === name),
      pin,
      o,
    );
    if (v) out.push(v);
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

/** How long GitHub's answer on which App each check needs is kept before it is asked again. */
export const CHECK_APPS_TTL_MS = 10 * 60_000;

/**
 * Backlog.checkApps when GitHub refused the branch read for permission or answered 404: `rules` is what the rules name.
 * Not an answer for a judgement with a pinned name (that stays unknown, fail closed); for one with none, no App named
 * by classic protection (the owner's decision (a), 2026-10-19). A rate limit or a 5xx is a plain error: it waits.
 */
export class BranchDenied extends Error {
  constructor(readonly rules: GithubCheckApps) {
    super('the branch read was refused (a 403 for permission, or a 404)');
  }
}

/**
 * The checks on a commit as the engine judges them (pinnedChecks), and the one maker of JudgedChecks. It reads its
 * facts itself: GitHub's checks from the backlog it is built over, and under No CI (src/ci-none.ts) this instance's
 * own test runs from its event log, which take the place of any check of their names (never GitHub's). It takes no
 * checks, runs or events from a caller. One instance per coordinator, so GitHub's protection and rules are read at
 * most once per CHECK_APPS_TTL_MS.
 */
export class PinnedChecks {
  private apps: { at: number; apps: GithubCheckApps } | null = null;
  /** The branch read refused for permission or 404 while GitHub has never answered (BranchDenied): what the rules name. */
  private denied: { at: number; rules: GithubCheckApps } | null = null;
  constructor(
    private readonly d: {
      backlog: Pick<Backlog, 'checks' | 'checkApps'>;
      branch: () => string;
      repo: () => string;
      configured: () => Record<string, CheckPin>;
      now?: () => number;
      /**
       * The required checks judged now. When none is pinned (and GitHub's rules have answered), the backlog reads exactly
       * as before pins. Absent: read as for a pinned check (tests' stand-ins).
       */
      required?: () => string[];
      /** No CI: the live config and the event log the test runs are recorded in. Absent: GitHub's checks only. */
      local?: { project: () => Pick<ProjectConfig, 'ci'>; tests: () => Pick<TestsConfig, 'test_run'>; log: { read(from: number, types: EventType[]): StoredEvent[] } };
    },
  ) {}

  /** Whether checks come from GitHub, so pins apply. */
  get enforced(): boolean {
    return typeof this.d.backlog.checkApps === 'function';
  }

  /**
   * The checks on `sha` as judged. `judging`: the names the caller will judge (fix-forward's episode names, the batch's
   * fast checks); absent, the `required` dep's. The reads a pinned check needs (more pages, failing closed) are made only
   * when a name being judged is pinned, or may be (GitHub's rules not read yet): with every judged name bare, exactly
   * main's reads, so main's verdict, whatever else is pinned (round 10).
   */
  async of(sha: string, opts: { judging?: readonly string[] } = {}): Promise<JudgedChecks> {
    if (!this.enforced) return this.withLocal(await this.d.backlog.checks(sha), sha);
    const configured = this.d.configured();
    const judging = opts.judging ?? this.d.required?.();
    const apps = judging ? await this.githubAppsFor(judging, configured) : await this.githubApps();
    const pinned = !judging || apps === null || judging.some((n) => pinOf(n, configured, apps) !== null);
    const all = await this.d.backlog.checks(sha, { pinned });
    return this.withLocal(pinnedChecks(all, { configured, github: apps, repo: this.d.repo(), sha }), sha);
  }

  /** The judged checks, under No CI with this instance's own test runs in place of any check of their names. */
  private withLocal(github: CommitCheck[], sha: string): JudgedChecks {
    const l = this.d.local;
    if (!l || !ciIsNone(l.project())) return judged(github);
    // No CI: the event log's test-run checks, in place of any check of their names (src/ci-none.ts INVARIANT).
    const names = new Set(testRunCheckNames(l.tests()));
    return judged([...github.filter((c) => !names.has(c.name)), ...localRunChecks(l.log.read(0, ['testrun.queued', 'testrun.finished']), sha, l.tests())]);
  }

  /**
   * GitHub's App per required check; on an error the last answer. Null while GitHub has never answered: then a check
   * config.yaml doesn't pin is unknown, not unpinned, and counts as missing until it does (fail closed).
   */
  async githubApps(): Promise<GithubCheckApps | null> {
    if (!this.d.backlog.checkApps) return {};
    const now = (this.d.now ?? Date.now)();
    const fresh = (x: { at: number } | null) => !!x && now - x.at < CHECK_APPS_TTL_MS;
    if (!fresh(this.apps) && !(this.apps === null && fresh(this.denied))) {
      try {
        this.apps = { at: now, apps: await this.d.backlog.checkApps(this.d.branch()) };
        this.denied = null;
      } catch (e) {
        // The branch read refused for permission or 404 (BranchDenied): kept apart, for githubAppsFor. Anything else:
        // the last answer is kept, and asked again next time.
        if (e instanceof BranchDenied) this.denied = { at: now, rules: e.rules };
      }
    }
    return this.apps?.apps ?? null;
  }

  /**
   * GitHub's App per check for a judgement of `judging`: githubApps(), or, when GitHub has never answered because the
   * branch read was refused for permission or 404 (BranchDenied), what the rules name (no App named by classic
   * protection), but only when no judged name is pinned by config.yaml or those rules: the owner's decision (a),
   * 2026-10-19, so a bare-names install gets main's verdict. With a judged name pinned, null as before (fail closed).
   */
  async githubAppsFor(judging: readonly string[], configured: Record<string, CheckPin> = this.d.configured()): Promise<GithubCheckApps | null> {
    const apps = await this.githubApps();
    if (apps !== null || !this.denied) return apps;
    return judging.some((n) => pinOf(n, configured, this.denied!.rules) !== null) ? null : this.denied.rules;
  }
}

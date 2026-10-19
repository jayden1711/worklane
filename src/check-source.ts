// Required checks pinned to their source (#727). A check matched by name alone turns green for anything that can post
// a check run or a commit status under that name: another GitHub App installed on the repo, a workflow a PR adds (or
// one posting a check run onto another commit through the API), a commit status. So wherever the engine judges a
// check from GitHub (PR readiness, the check of main after a merge, fix-forward, the main watch), it keeps a check only
// when it came from its name's pinned source:
//   1. config.yaml required_check_sources: { <name>: { app_id: N } } (the GitHub App that posts it) or
//      { <name>: { workflow: .github/workflows/<file> } } (the Actions workflow file that runs it, in this repo, in a
//      workflow run for the very commit judged);
//   2. else the App GitHub's own branch protection (app_id) or ruleset (integration_id) requires for that name;
//   3. else none: the check is refused, so it counts as missing, and doctor names it (checkSourceDoctor).
// A commit status never satisfies a pin: statuses carry no App. Pinning only ever turns a match into missing.
// Without GitHub (a file backlog: Backlog.checkApps absent) nobody else can post a check, and names match as before.
import type { Backlog, CommitCheck } from './backlog/types.js';

/** Where a required check must come from: the App that posts it, or the Actions workflow file that runs it. */
export type CheckPin = { app_id: number } | { workflow: string };
/** Each required check's App as GitHub's branch protection or ruleset requires it (a name absent: any source). */
export type GithubCheckApps = Record<string, number>;
/** The Actions workflow run behind a check run's suite: its file, its repo and the commit it ran for. */
export interface WorkflowSource {
  path: string;
  repo: string;
  sha: string;
}

/** The pin for `name`: config.yaml's, else the App GitHub requires, else null (refused). Own keys only. */
export function pinOf(name: string, configured: Record<string, CheckPin>, github: GithubCheckApps): CheckPin | null {
  if (Object.hasOwn(configured, name)) return configured[name]!;
  return Object.hasOwn(github, name) ? { app_id: github[name]! } : null;
}

/** Did this check come from `pin`? A status never does; a workflow pin needs the run in `repo` and for `sha`. */
export function fromPinnedSource(c: Pick<CommitCheck, 'source' | 'app' | 'workflow'>, pin: CheckPin, o: { repo: string; sha: string }): boolean {
  if (c.source !== 'check_run') return false;
  if ('app_id' in pin) return c.app === pin.app_id;
  const w = c.workflow;
  return !!w && w.path === pin.workflow && w.repo.toLowerCase() === o.repo.toLowerCase() && w.sha === o.sha;
}

/** Only the checks on commit `sha` that came from their name's pinned source; an unpinned name's are all dropped. */
export function pinnedChecks<C extends Pick<CommitCheck, 'name' | 'source' | 'app' | 'workflow'>>(checks: C[], o: { configured: Record<string, CheckPin>; github: GithubCheckApps; repo: string; sha: string }): C[] {
  return checks.filter((c) => {
    const pin = pinOf(c.name, o.configured, o.github);
    return pin !== null && fromPinnedSource(c, pin, o);
  });
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
  const out: GithubCheckApps = {};
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

/** The required checks with no source recorded in config.yaml: what GitHub must name, or the engine refuses. */
export function unrecorded(required: string[], configured: Record<string, CheckPin>): string[] {
  return required.filter((n) => !Object.hasOwn(configured, n));
}

/** Governance mode (#704) judges PRs nobody here wrote, so it can't be on while any required check is a bare name. */
export function governanceRefusal(required: string[], configured: Record<string, CheckPin>): string | null {
  const bare = unrecorded(required, configured);
  return bare.length ? `governance mode needs every required check pinned to its source in config.yaml required_check_sources; not pinned: ${bare.join(', ')}` : null;
}

/** doctor's line: each required check with no recorded source, and how to pin it. */
export function checkSourceDoctor(p: { land_mode: string; ci?: string | undefined; required_checks: string[]; required_check_sources: Record<string, CheckPin> }): { level: 'ok' | 'warn'; detail: string } {
  if (p.land_mode !== 'pr' || p.ci === 'none' || !p.required_checks.length) return { level: 'ok', detail: 'no required GitHub checks to pin' };
  const bare = unrecorded(p.required_checks, p.required_check_sources);
  if (!bare.length) return { level: 'ok', detail: `every required check is pinned to its source: ${p.required_checks.join(', ')}` };
  return {
    level: 'warn',
    detail: `no source recorded for ${bare.join(', ')}: each is accepted only from the App GitHub's branch protection or ruleset requires for it, and refused (missing: no PR is ready) when neither names one. Pin each in config.yaml required_check_sources, e.g. ${JSON.stringify(bare[0])}: { workflow: .github/workflows/<file>.yml } or { app_id: <the App's id> }`,
  };
}

/** How long GitHub's answer on which App each check needs is kept before it is asked again. */
export const CHECK_APPS_TTL_MS = 10 * 60_000;

/**
 * The checks on a commit as the engine judges them: from GitHub, only those from their pinned source. One instance
 * per coordinator, so GitHub's protection and rules are read at most once per CHECK_APPS_TTL_MS.
 */
export class PinnedChecks {
  private apps: { at: number; apps: GithubCheckApps } | null = null;
  constructor(private readonly d: { backlog: Pick<Backlog, 'checks' | 'checkApps'>; branch: () => string; repo: () => string; configured: () => Record<string, CheckPin>; now?: () => number }) {}

  /** Whether checks come from GitHub, so pins apply. */
  get enforced(): boolean {
    return typeof this.d.backlog.checkApps === 'function';
  }

  async of(sha: string): Promise<CommitCheck[]> {
    const all = await this.d.backlog.checks(sha);
    if (!this.enforced) return all;
    return pinnedChecks(all, { configured: this.d.configured(), github: await this.githubApps(), repo: this.d.repo(), sha });
  }

  /** GitHub's App per required check; on an error the last answer, or none (then only config.yaml's pins count). */
  async githubApps(): Promise<GithubCheckApps> {
    const now = (this.d.now ?? Date.now)();
    if (this.d.backlog.checkApps && (!this.apps || now - this.apps.at >= CHECK_APPS_TTL_MS)) {
      try {
        this.apps = { at: now, apps: await this.d.backlog.checkApps(this.d.branch()) };
      } catch {
        // kept: the last answer, asked again next time
      }
    }
    return this.apps?.apps ?? {};
  }
}

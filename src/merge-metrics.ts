// What the conflict machinery costs the flywheel, from the event log alone:
// conflict fixes (how many, minutes from conflict to merged, how many needed
// the owner), light combined-state checks (how many, minutes added) and
// hotspot holds (how many, minutes tasks waited). Each is also shown per
// merged PR, and flagged with a suggested tuning when it adds more than a few
// minutes per merged PR on average. Pure: the health panel, the PRs page and
// the weekly report all call `mergeMetrics`.
//
// And the trust numbers (`trustMetrics`, DORA-style): change failure rate, escaped bugs, time to restore, the
// review revise/reject rate, the flaky-check rate, cost per merged PR and verification time per tier, per risk
// area (money path, auth, other) over 7 and 30 days. Measurement only: nothing here, nor in src/trust.ts that
// reads it, changes slots, caps or merges (docs/design.md, the stage-3 waiver of 2026-10-13).
//
// And the delivery metrics (`deliveryMetrics`, the Metrics panel and its weekly digest): merges per day, the default
// branch's red times and time to green, fix-forward versus revert, PR CI wall-clock, agent startup, the flake rate,
// and the slowest tests. A source with nothing recorded yet is "not measured yet", never 0.

/**
 * The events these read (their shapes, as recorded):
 *   conflict_fix.detected  { issue, number, head, base_sha }
 *   conflict_fix.started   { issue, number, head, base_sha, strategy, attempt, lease }
 *   conflict_fix.finished  { issue, number, base_sha, strategy, outcome: 'pushed'|'no_push'|'gave_up'|'interrupted', head, files, waits_owner, reasons, detail }
 *   light_check.finished   { issue, number, head, main_sha, overlap, outcome: 'merge'|'conflict'|'hold', wait_ms }
 *   hotspot.held           { issue, by, files }
 *   hotspot.released       { issue, waited_ms, files }
 *   pr.closed              { issue, number, merged }      (existing: a PR merged, by anyone)
 */
export interface MetricEvent {
  ts: string;
  type: string;
  payload: unknown;
}

export interface MergeMetrics {
  since: string;
  mergedPrs: number;
  conflicts: { count: number; needOwner: number; minutesToMerged: number[]; medianMinutes: number | null; perMergedPr: number };
  lightChecks: { count: number; minutesAdded: number; perMergedPr: number; outcomes: Record<string, number> };
  holds: { count: number; minutesWaited: number; perMergedPr: number; byFile: { file: string; minutes: number; count: number }[] };
  /** One line per measure that costs more than `thresholdMinutes` per merged PR, with a suggested tuning. */
  flags: string[];
}

/** "A few minutes": above this many added minutes per merged PR, a measure is flagged. */
export const FLAG_MINUTES = 3;

const p = <T>(e: MetricEvent) => e.payload as T;
const minutes = (ms: number) => ms / 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function mergeMetrics(events: MetricEvent[], o: { since: Date; thresholdMinutes?: number }): MergeMetrics {
  const t0 = o.since.getTime();
  const inWindow = events.filter((e) => Date.parse(e.ts) >= t0);
  const threshold = o.thresholdMinutes ?? FLAG_MINUTES;
  const merged = inWindow.filter((e) => e.type === 'pr.closed' && p<{ merged: boolean }>(e).merged);
  const mergedAt = new Map<number, number>();
  for (const e of merged) mergedAt.set(p<{ number: number }>(e).number, Date.parse(e.ts));
  const n = merged.length;
  const per = (total: number) => (n ? round1(total / n) : 0);

  // Conflict fixes: from the first time a PR was seen conflicting (per base) to its merge.
  const detected = inWindow.filter((e) => e.type === 'conflict_fix.detected');
  const firstConflict = new Map<number, number>();
  for (const e of detected) {
    const pr = p<{ number: number }>(e).number;
    if (!firstConflict.has(pr)) firstConflict.set(pr, Date.parse(e.ts));
  }
  const toMerged: number[] = [];
  for (const [pr, at] of firstConflict) {
    const m = mergedAt.get(pr);
    if (m !== undefined && m >= at) toMerged.push(round1(minutes(m - at)));
  }
  const finished = inWindow.filter((e) => e.type === 'conflict_fix.finished');
  const needOwner = new Set(finished.filter((e) => p<{ waits_owner: boolean; outcome: string }>(e).waits_owner || p<{ outcome: string }>(e).outcome === 'gave_up').map((e) => p<{ number: number }>(e).number)).size;
  const conflictMinutes = toMerged.reduce((a, b) => a + b, 0);

  // Light checks: the time each one added before its merge.
  const lights = inWindow.filter((e) => e.type === 'light_check.finished');
  const lightMinutes = round1(lights.reduce((a, e) => a + minutes(p<{ wait_ms: number }>(e).wait_ms), 0));
  const outcomes: Record<string, number> = {};
  for (const e of lights) outcomes[p<{ outcome: string }>(e).outcome] = (outcomes[p<{ outcome: string }>(e).outcome] ?? 0) + 1;

  // Hotspot holds: how long tasks waited, and on which files.
  const held = inWindow.filter((e) => e.type === 'hotspot.held');
  const released = inWindow.filter((e) => e.type === 'hotspot.released');
  const holdMinutes = round1(released.reduce((a, e) => a + minutes(p<{ waited_ms: number }>(e).waited_ms), 0));
  const files = new Map<string, { minutes: number; count: number }>();
  for (const e of released) {
    const r = p<{ waited_ms: number; files?: string[] }>(e);
    for (const f of r.files ?? []) {
      const x = files.get(f) ?? { minutes: 0, count: 0 };
      x.minutes = round1(x.minutes + minutes(r.waited_ms));
      x.count++;
      files.set(f, x);
    }
  }
  const byFile = [...files].map(([file, x]) => ({ file, ...x })).sort((a, b) => b.minutes - a.minutes);

  const out: MergeMetrics = {
    since: o.since.toISOString(),
    mergedPrs: n,
    conflicts: { count: firstConflict.size, needOwner, minutesToMerged: toMerged, medianMinutes: median(toMerged), perMergedPr: per(conflictMinutes) },
    lightChecks: { count: lights.length, minutesAdded: lightMinutes, perMergedPr: per(lightMinutes), outcomes },
    holds: { count: held.length, minutesWaited: holdMinutes, perMergedPr: per(holdMinutes), byFile },
    flags: [],
  };

  const conflictFiles = new Map<string, number>();
  for (const e of finished) for (const f of p<{ files?: string[] }>(e).files ?? []) conflictFiles.set(f, (conflictFiles.get(f) ?? 0) + 1);
  const topConflict = [...conflictFiles].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
  if (out.conflicts.perMergedPr > threshold)
    out.flags.push(`Conflict fixes add ${out.conflicts.perMergedPr} min per merged PR: consider listing ${topConflict.length ? topConflict.join(', ') : 'the files they conflict on'} as hotspots so those tasks don't run at once`);
  if (out.lightChecks.perMergedPr > threshold)
    out.flags.push(`Combined-state checks add ${out.lightChecks.perMergedPr} min per merged PR: consider a faster tests.yaml runner.changed, or turning the check off for this repo if main rarely breaks after a merge`);
  if (out.holds.perMergedPr > threshold)
    out.flags.push(`Hotspot holds add ${out.holds.perMergedPr} min per merged PR${byFile[0] ? `, most on ${byFile[0].file}` : ''}: consider removing it from the repo's hotspots if those tasks rarely conflict, or splitting the file`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Trust metrics.

/** The risk areas the trust numbers are broken down by, riskiest first. */
export const RISK_AREAS = ['money', 'auth', 'other'] as const;
export type RiskArea = (typeof RISK_AREAS)[number];
/** The windows the trust numbers cover, in days. */
export const TRUST_WINDOWS = [7, 30] as const;
/** A fix PR, a revert or a red default branch up to this many days after a merge counts against that merge. */
export const FAILURE_WINDOW_DAYS = 7;
/** A production report is traced to the latest harness merge, up to this many days before it, that touched its fix's files. */
export const ESCAPE_TRACE_DAYS = 30;

/** Why a merge counts as a change failure. */
export type FailureKind = 'reverted' | 'main_red' | 'fix_followed' | 'escaped';

export interface TierTime {
  tier: string;
  runs: number;
  medianMinutes: number;
  totalMinutes: number;
}

/** One area's (or the whole instance's) trust numbers over one window. Rates are 0..1, null when there is nothing to divide by. */
export interface AreaTrust {
  /** Merged PRs (and direct lands) in the window. */
  merges: number;
  /** Of those, how many failed later: reverted, broke the default branch, or were followed by a fix PR or a production bug on the same files. */
  failures: number;
  changeFailureRate: number | null;
  /** Production reports (intake-filed issues) in the window traced to a harness merge. */
  escapedBugs: number;
  /** Hours from each failure being seen to its fix, its revert or a green default branch. */
  restoreHours: number[];
  medianRestoreHours: number | null;
  /** Issues a person reviewed in the window (a plan decided, a correction recorded, or a merge), and how many they sent back. */
  reviewed: number;
  revisedOrRejected: number;
  reviseRejectRate: number | null;
  /** Check runs (a check or a test tier on one commit) that passed or failed, and how many did both on the same commit. */
  checks: number;
  flakyChecks: number;
  flakyRate: number | null;
  /** The runs' own cost estimates (not billed money) and tokens, in all and per merged PR. */
  cost: { usd: number; tokens: number; perMergedPrUsd: number | null; perMergedPrTokens: number | null };
  /** How long verification took, per tier: each test-run tier, the coordinator's verify checks, the evaluator's runs. */
  verification: TierTime[];
}

export interface TrustFailure {
  issue: number;
  number: number | null;
  area: RiskArea;
  kind: FailureKind;
  /** The fix or revert PR that showed it, when there is one. */
  by: number | null;
}

export interface TrustWindow {
  days: number;
  since: string;
  total: AreaTrust;
  byArea: Record<RiskArea, AreaTrust>;
  /** The failures of the merges in this window, newest issue first. */
  failures: TrustFailure[];
  /** Escaped money-path bugs (also in `byArea.money.escapedBugs`), named for the recommendation. */
  escapedMoney: number;
}

export interface TrustMetrics {
  until: string;
  windows: TrustWindow[];
}

interface Merge {
  issue: number;
  number: number | null;
  at: number;
  sha: string | null;
  title: string | null;
}

interface Failure {
  kind: FailureKind;
  seen: number;
  restored: number | null;
  by: number | null;
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const rate = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : null);
const riskier = (a: RiskArea, b: RiskArea) => (RISK_AREAS.indexOf(a) <= RISK_AREAS.indexOf(b) ? a : b);
const isFixTitle = (t: string | null | undefined) => !!t && /^(fix|hotfix)\b/i.test(t.trim());
const blankArea = (): AreaTrust => ({
  merges: 0,
  failures: 0,
  changeFailureRate: null,
  escapedBugs: 0,
  restoreHours: [],
  medianRestoreHours: null,
  reviewed: 0,
  revisedOrRejected: 0,
  reviseRejectRate: null,
  checks: 0,
  flakyChecks: 0,
  flakyRate: null,
  cost: { usd: 0, tokens: 0, perMergedPrUsd: null, perMergedPrTokens: null },
  verification: [],
});

/**
 * An issue's risk area: money when its review level's reasons name a money path (or it has the money-path label),
 * auth when they name auth or secrets (or it has the auth label), else other.
 */
export function riskAreaOf(reasons: readonly string[], labels: readonly string[] = []): RiskArea {
  if (labels.includes('money-path') || reasons.some((r) => /^money-path:/.test(r))) return 'money';
  if (labels.includes('auth') || reasons.some((r) => /^(auth|secrets):/.test(r))) return 'auth';
  return 'other';
}

/**
 * The trust numbers over each of TRUST_WINDOWS up to `now`, for the whole instance and per risk area. Pure: the
 * event log in, numbers out. The definitions are the panel's (docs/dashboard.md, "Trust"):
 * - a merge failed when, within FAILURE_WINDOW_DAYS, the default branch went red on it or auto-merge stopped on it,
 *   a revert PR named it, or a fix PR (a bug, or a title starting "fix") changed the same files; or when a production
 *   report (an intake-filed issue) was traced to it: the latest merge, up to ESCAPE_TRACE_DAYS before the report,
 *   that changed a file the report's fix changed. Each merge fails at most once, by what showed first.
 */
export function trustMetrics(events: MetricEvent[], o: { now?: Date } = {}): TrustMetrics {
  const now = (o.now ?? new Date()).getTime();
  const evs = events.filter((e) => Date.parse(e.ts) <= now);
  const P = (e: MetricEvent) => e.payload as Record<string, unknown>;

  // What is known of each issue: its labels and title, its review reasons, its files, when it was first seen.
  const labels = new Map<number, string[]>();
  const titles = new Map<number, string>();
  const reasons = new Map<number, string[]>();
  const files = new Map<number, string[]>();
  const firstSeen = new Map<number, number>();
  const prIssue = new Map<number, number>();
  const intakeFiled = new Map<number, number>();
  for (const e of evs) {
    const p = P(e);
    const t = Date.parse(e.ts);
    const issue = typeof p.issue === 'number' ? p.issue : null;
    if (issue === null) continue;
    if (e.type === 'issue.seen') {
      labels.set(issue, (p.labels as string[]) ?? []);
      titles.set(issue, String(p.title ?? ''));
      if (!firstSeen.has(issue)) firstSeen.set(issue, t);
    } else if (e.type === 'review.level_set') reasons.set(issue, (p.reasons as string[]) ?? []);
    else if (e.type === 'change.proposed') files.set(issue, (p.files as string[]) ?? []);
    else if ((e.type === 'pr.opened' || e.type === 'merge.done' || e.type === 'pr.closed') && typeof p.number === 'number') prIssue.set(p.number, issue);
    else if (e.type === 'intake.filed' && !intakeFiled.has(issue)) intakeFiled.set(issue, t);
  }
  const areaOf = (issue: number | null | undefined): RiskArea => (issue == null ? 'other' : riskAreaOf(reasons.get(issue) ?? [], labels.get(issue) ?? []));
  const areaOfPrs = (prs: number[]): RiskArea => prs.map((n) => areaOf(prIssue.get(n))).reduce<RiskArea>(riskier, 'other');

  // Merges: the first per issue, by a merged PR or a direct land.
  const merges = new Map<number, Merge>();
  for (const e of evs) {
    const p = P(e);
    if (typeof p.issue !== 'number') continue;
    const t = Date.parse(e.ts);
    const m = merges.get(p.issue);
    if (e.type === 'merge.done') {
      if (!m) merges.set(p.issue, { issue: p.issue, number: Number(p.number), at: t, sha: String(p.sha), title: String(p.title) });
      else if (m.number === Number(p.number)) Object.assign(m, { sha: String(p.sha), title: String(p.title) });
    } else if (e.type === 'pr.closed' && p.merged === true && !m) merges.set(p.issue, { issue: p.issue, number: Number(p.number), at: t, sha: null, title: null });
    else if (e.type === 'land.result' && p.outcome === 'landed' && !m) merges.set(p.issue, { issue: p.issue, number: null, at: t, sha: typeof p.landed === 'string' ? p.landed : null, title: null });
  }
  const all = [...merges.values()].sort((a, b) => a.at - b.at);
  const byNumber = new Map(all.filter((m) => m.number !== null).map((m) => [m.number!, m]));
  const overlap = (a: number, b: number) => {
    const fa = new Set(files.get(a) ?? []);
    return (files.get(b) ?? []).some((f) => fa.has(f));
  };
  // The default branch back to normal after `from`: green again, or auto-merge resumed.
  const backAt = (from: number) => {
    let first: number | null = null;
    for (const e of evs) {
      const t = Date.parse(e.ts);
      if (t > from && (first === null || t < first) && (e.type === 'merge.resumed' || (e.type === 'merge.main_result' && P(e).outcome === 'green'))) first = t;
    }
    return first;
  };

  // Each merge's failure: the first that shows.
  const failure = new Map<number, Failure>();
  const fail = (issue: number, f: Failure) => {
    const had = failure.get(issue);
    if (!had || f.seen < had.seen) failure.set(issue, f);
  };
  const within = (m: Merge, t: number, days: number) => t >= m.at && t - m.at <= days * DAY_MS;
  for (const e of evs) {
    const p = P(e);
    if (!((e.type === 'merge.main_result' && p.outcome === 'red') || e.type === 'merge.stopped')) continue;
    const t = Date.parse(e.ts);
    const m = typeof p.number === 'number' ? byNumber.get(p.number) : undefined;
    if (m && within(m, t, FAILURE_WINDOW_DAYS)) fail(m.issue, { kind: e.type === 'merge.stopped' && p.revert ? 'reverted' : 'main_red', seen: t, restored: backAt(t), by: null });
  }
  const escaped: { culprit: Merge; filedAt: number }[] = [];
  for (const fix of all) {
    // A revert names what it reverts: its commit, its PR number, or its title in quotes.
    if (fix.title && /^revert\b/i.test(fix.title)) {
      for (const m of all) {
        if (m === fix || !within(m, fix.at, FAILURE_WINDOW_DAYS)) continue;
        const named = (m.sha && fix.title.includes(m.sha.slice(0, 7))) || (m.number !== null && new RegExp(`#${m.number}\\b`).test(fix.title)) || (m.title && fix.title.includes(`"${m.title}"`));
        if (named) fail(m.issue, { kind: 'reverted', seen: fix.at, restored: fix.at, by: fix.number });
      }
      continue;
    }
    const filed = intakeFiled.get(fix.issue);
    if (!(filed !== undefined || (labels.get(fix.issue) ?? []).includes('bug') || isFixTitle(titles.get(fix.issue)) || isFixTitle(fix.title))) continue;
    // When the problem was seen: the report filed, else the fix's issue first seen; never after the fix merged.
    const seen = Math.min(filed ?? firstSeen.get(fix.issue) ?? fix.at, fix.at);
    const reach = filed !== undefined ? ESCAPE_TRACE_DAYS : FAILURE_WINDOW_DAYS;
    const culprit = [...all].reverse().find((m) => m !== fix && m.at <= seen && within(m, seen, reach) && overlap(m.issue, fix.issue));
    if (!culprit) continue;
    fail(culprit.issue, { kind: filed !== undefined ? 'escaped' : 'fix_followed', seen, restored: fix.at, by: fix.number });
    if (filed !== undefined) escaped.push({ culprit, filedAt: filed });
  }

  const testrun = new Map<string, { sha: string; prs: number[] }>();
  for (const e of evs) if (e.type === 'testrun.queued') testrun.set(String(P(e).id), { sha: String(P(e).sha), prs: (P(e).prs as number[]) ?? [] });

  const windows = TRUST_WINDOWS.map((days): TrustWindow => {
    const since = now - days * DAY_MS;
    const inW = (t: number) => t > since && t <= now;
    const total = blankArea();
    const byArea = Object.fromEntries(RISK_AREAS.map((a) => [a, blankArea()])) as Record<RiskArea, AreaTrust>;
    const both = (area: RiskArea, f: (x: AreaTrust) => void) => {
      f(total);
      f(byArea[area]);
    };

    // Merges and their failures (by when they merged), restores (by when the failure showed), escapes (by when filed).
    const failures: TrustFailure[] = [];
    for (const m of all.filter((x) => inW(x.at))) {
      const area = areaOf(m.issue);
      const f = failure.get(m.issue);
      both(area, (x) => {
        x.merges++;
        if (f) x.failures++;
      });
      if (f) failures.push({ issue: m.issue, number: m.number, area, kind: f.kind, by: f.by });
    }
    for (const [issue, f] of failure) if (f.restored !== null && inW(f.seen)) both(areaOf(issue), (x) => x.restoreHours.push(round2(Math.max(0, f.restored! - f.seen) / 3_600_000)));
    for (const x of escaped) if (inW(x.filedAt)) both(areaOf(x.culprit.issue), (a) => a.escapedBugs++);

    // Review: each issue a person decided on in the window, and whether they sent it back.
    const reviewed = new Map<number, boolean>();
    const note = (issue: number, back: boolean) => reviewed.set(issue, (reviewed.get(issue) ?? false) || back);
    const outcomes = new Map<string, { area: RiskArea; seen: Set<string> }>();
    const outcome = (key: string, area: RiskArea, status: string) => {
      const x = outcomes.get(key) ?? { area, seen: new Set<string>() };
      x.area = riskier(x.area, area);
      x.seen.add(status);
      outcomes.set(key, x);
    };
    const times = new Map<string, Map<string, number[]>>();
    const time = (area: RiskArea, tier: string, ms: number) => {
      for (const k of [area, 'all']) {
        const by = times.get(k) ?? new Map<string, number[]>();
        by.set(tier, [...(by.get(tier) ?? []), ms]);
        times.set(k, by);
      }
    };
    for (const e of evs) {
      if (!inW(Date.parse(e.ts))) continue;
      const p = P(e);
      const issue = typeof p.issue === 'number' ? p.issue : null;
      if (e.type === 'plan.decided' && issue !== null) note(issue, p.answer === 'revise' || p.answer === 'reject');
      else if (e.type === 'correction.recorded' && p.kind !== 'chat') {
        const of = issue ?? (typeof p.pr === 'number' ? prIssue.get(p.pr) : undefined);
        if (of !== undefined) note(of, true);
      } else if (e.type === 'check.result') {
        // Flaky: a check that both passed and failed on one commit. Its time: the verify stage's checks, summed.
        let ms = 0;
        for (const c of (p.checks as { check: string; status: string; duration_ms?: number }[]) ?? []) {
          if (c.status === 'pass' || c.status === 'fail') outcome(`check\0${c.check}\0${String(p.head)}`, areaOf(issue), c.status);
          ms += c.duration_ms ?? 0;
        }
        if (p.stage === 'verify' && ms > 0) time(areaOf(issue), 'verify checks', ms);
      } else if (e.type === 'testrun.tier') {
        const run = testrun.get(String(p.id));
        const area = areaOfPrs(run?.prs ?? []);
        outcome(`tier\0${String(p.tier)}\0${run?.sha ?? String(p.id)}`, area, p.ok ? 'pass' : 'fail');
        time(area, `test tier: ${String(p.tier)}`, Number(p.duration_ms) || 0);
      } else if (e.type === 'run.cost') {
        const usd = Number(p.usd) || 0;
        const tokens = (Number(p.tokens_in) || 0) + (Number(p.tokens_out) || 0);
        // A run on no issue (chat, the gardener) counts in the instance's total only.
        total.cost.usd += usd;
        total.cost.tokens += tokens;
        if (issue !== null) {
          byArea[areaOf(issue)].cost.usd += usd;
          byArea[areaOf(issue)].cost.tokens += tokens;
        }
        const role = String(p.role);
        if ((role.startsWith('evaluator') || role === 'investigator') && Number(p.secs) > 0) time(areaOf(issue), 'evaluator', Number(p.secs) * 1000);
      }
    }
    for (const m of all) if (inW(m.at)) note(m.issue, false);
    for (const [issue, back] of reviewed)
      both(areaOf(issue), (x) => {
        x.reviewed++;
        if (back) x.revisedOrRejected++;
      });
    for (const [, x] of outcomes)
      both(x.area, (a) => {
        a.checks++;
        if (x.seen.size === 2) a.flakyChecks++;
      });

    const tiers = (by: Map<string, number[]> | undefined): TierTime[] =>
      [...(by ?? new Map<string, number[]>())]
        .map(([tier, ms]) => ({ tier, runs: ms.length, medianMinutes: round2(median(ms)! / 60_000), totalMinutes: round2(ms.reduce((s, n) => s + n, 0) / 60_000) }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes || a.tier.localeCompare(b.tier));
    for (const [key, x] of [['all', total] as const, ...RISK_AREAS.map((a) => [a, byArea[a]] as const)]) {
      x.changeFailureRate = rate(x.failures, x.merges);
      x.medianRestoreHours = median(x.restoreHours);
      x.reviseRejectRate = rate(x.revisedOrRejected, x.reviewed);
      x.flakyRate = rate(x.flakyChecks, x.checks);
      x.cost.usd = round2(x.cost.usd);
      x.cost.perMergedPrUsd = x.merges ? round2(x.cost.usd / x.merges) : null;
      x.cost.perMergedPrTokens = x.merges ? Math.round(x.cost.tokens / x.merges) : null;
      x.verification = tiers(times.get(key));
    }
    failures.sort((a, b) => b.issue - a.issue);
    return { days, since: new Date(since).toISOString(), total, byArea, failures, escapedMoney: byArea.money.escapedBugs };
  });
  return { until: new Date(now).toISOString(), windows };
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery metrics: how fast and how safely changes reach the default branch, for the Metrics panel and the weekly
// digest (src/trust.ts metricsDigest). Each figure names its source; a source with nothing recorded yet is "not
// measured yet" (`measured: false` and why), never a 0.

/**
 * Fix-forward (a red default branch fixed by a fix PR rather than reverted) isn't built yet. Its runs will record
 * this event, `{ outcome: 'fixed' | 'reverted' | 'gave_up' }` at least, one per red default branch it took on; until
 * one exists, the fix-forward figure says it is not measured yet.
 */
export const FIX_FORWARD_EVENT = 'fix_forward.finished';
/** The windows the delivery metrics cover, in days. */
export const DELIVERY_WINDOWS = [7, 30] as const;
/** The slow tests are over this many days. */
export const SLOW_TEST_DAYS = 7;
/** How many of the slowest tests are listed. */
export const SLOWEST = 20;
/** At most this many over-budget tests are listed (and how many there are in all). */
export const OVER_BUDGET_LISTED = 50;
/** The merges-per-day series: this many days, today last. */
export const PER_DAY_DAYS = 14;

export type Measure<T> = ({ measured: true } & T) | { measured: false; why: string };

export interface DeliveryWindow {
  days: number;
  since: string;
  /** Merges to the default branch the log records: merged PRs and direct lands. */
  merges: Measure<{ total: number; perDay: number }>;
  /** Times the default branch went red after a merge (a red after a green, or the first; red again while red is the same time). */
  mainRed: Measure<{ count: number; stillRed: boolean }>;
  /** Minutes from the default branch going red to its next green, for each red time that went green. */
  timeToGreen: Measure<{ minutes: number[]; medianMinutes: number | null }>;
  /** Revert PRs opened (after a red default branch, or for a commit the main watch couldn't account for) and merged. */
  reverts: Measure<{ opened: number; onRed: number; merged: number; redTimes: number; rate: number | null }>;
  /** Fix-forward's outcomes, once it exists (FIX_FORWARD_EVENT). */
  fixForward: Measure<{ attempts: number; fixed: number; reverted: number; successRate: number | null }>;
  /** Merged PRs' CI wall-clock (ci.pr_timing). */
  prCi: Measure<{ prs: number; medianMinutes: number | null; p90Minutes: number | null; slowest: { number: number; minutes: number }[] }>;
  /** Seconds from a task being claimed to its agent's process starting (issue.claimed to run.started). */
  startup: Measure<{ runs: number; medianSeconds: number | null; p90Seconds: number | null }>;
  /** Re-runs of a red default branch's failing checks that found a flaky one, over all such re-runs (flaky.rerun_result). */
  flake: Measure<{ reruns: number; flaky: number; rate: number | null; quarantined: number }>;
}

export interface SlowTest {
  name: string;
  medianMs: number;
  maxMs: number;
  runs: number;
}

export interface SlowTests {
  days: number;
  budgetS: number;
  /** Runs (test-run tiers and CI jobs) in the window that printed durations this reads. */
  runs: number;
  slowest: SlowTest[];
  overBudget: SlowTest[];
  overBudgetTotal: number;
}

export interface DeliveryMetrics {
  until: string;
  windows: DeliveryWindow[];
  /** Merges per day, the last PER_DAY_DAYS days (UTC), today last. Null when merges aren't measured yet. */
  perDay: { day: string; merged: number }[] | null;
  slowTests: Measure<SlowTests>;
}

const pctile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
const prOfUrl = (u: unknown) => {
  const m = typeof u === 'string' ? u.match(/\/pull\/(\d+)\b/) : null;
  return m ? Number(m[1]) : null;
};
const MAIN_UNSEEN = "the default branch's checks after a merge (merge.main_result) haven't been recorded yet";

/**
 * The delivery metrics over each of DELIVERY_WINDOWS up to `now`, and the slow tests over SLOW_TEST_DAYS. Pure: the
 * event log in, numbers out. `budgetS`: config.yaml metrics.slow_test_budget_s.
 */
export function deliveryMetrics(events: MetricEvent[], o: { now?: Date; budgetS: number }): DeliveryMetrics {
  const now = (o.now ?? new Date()).getTime();
  const T = (e: MetricEvent) => Date.parse(e.ts);
  const evs = events.filter((e) => T(e) <= now).sort((a, b) => T(a) - T(b));
  const P = (e: MetricEvent) => e.payload as Record<string, unknown>;
  const has = (...types: string[]) => evs.some((e) => types.includes(e.type));

  // Merges: one per PR (merge.done and pr.closed both record the harness's), and each direct land.
  const merges = new Map<string, number>();
  for (const e of evs) {
    const p = P(e);
    if ((e.type === 'merge.done' || (e.type === 'pr.closed' && p.merged === true)) && typeof p.number === 'number') {
      if (!merges.has(`pr:${p.number}`)) merges.set(`pr:${p.number}`, T(e));
    } else if (e.type === 'land.result' && p.outcome === 'landed') merges.set(`land:${String(p.issue)}:${String(p.landed)}`, T(e));
  }
  const mergesSeen = merges.size > 0;

  // The default branch's red times: from a red result (after a green, or the first) to the next green.
  const red: { at: number; green: number | null }[] = [];
  let open: { at: number; green: number | null } | null = null;
  for (const e of evs) {
    if (e.type !== 'merge.main_result') continue;
    const outcome = P(e).outcome;
    if (outcome === 'red' && !open) red.push((open = { at: T(e), green: null }));
    else if (outcome === 'green' && open) {
      open.green = T(e);
      open = null;
    }
  }
  const mainSeen = has('merge.main_result');

  // Revert PRs: opened on a red default branch (merge.stopped) or for an unaccounted commit (main_watch.unaccounted).
  const reverts = new Map<string, { at: number; onRed: boolean; number: number | null }>();
  for (const e of evs) {
    const p = P(e);
    if ((e.type === 'merge.stopped' || e.type === 'main_watch.unaccounted') && typeof p.revert === 'string' && p.revert && !reverts.has(p.revert))
      reverts.set(p.revert, { at: T(e), onRed: e.type === 'merge.stopped', number: prOfUrl(p.revert) });
  }
  const revertNumbers = new Set([...reverts.values()].map((r) => r.number).filter((n): n is number => n !== null));
  const revertMerged = new Map<number, number>();
  for (const e of evs) {
    const p = P(e);
    if (typeof p.number !== 'number' || revertMerged.has(p.number)) continue;
    const merged = e.type === 'merge.done' || (e.type === 'pr.closed' && p.merged === true);
    if (merged && (revertNumbers.has(p.number) || (e.type === 'merge.done' && /^revert\b/i.test(String(p.title ?? ''))))) revertMerged.set(p.number, T(e));
  }
  const revertsSeen = mainSeen || has('main_watch.mode', 'main_watch.checked', 'main_watch.unaccounted', 'merge.stopped');

  // Agent startup: each claim to the first agent process started on that issue after it (before it is claimed again).
  const startups: { at: number; secs: number }[] = [];
  const claimed = new Map<number, number>();
  for (const e of evs) {
    const p = P(e);
    if (typeof p.issue !== 'number') continue;
    if (e.type === 'issue.claimed') claimed.set(p.issue, T(e));
    else if (e.type === 'run.started' && claimed.has(p.issue)) {
      startups.push({ at: claimed.get(p.issue)!, secs: Math.max(0, (T(e) - claimed.get(p.issue)!) / 1000) });
      claimed.delete(p.issue);
    }
  }

  const fixForward = evs.filter((e) => e.type === FIX_FORWARD_EVENT);
  const prCi = evs.filter((e) => e.type === 'ci.pr_timing' && typeof P(e).wall_ms === 'number');
  const reruns = evs.filter((e) => e.type === 'flaky.rerun_result');

  const windows = DELIVERY_WINDOWS.map((days): DeliveryWindow => {
    const since = now - days * DAY_MS;
    const inW = (t: number) => t > since && t <= now;
    const evW = (e: MetricEvent) => inW(T(e));
    const mergeCount = [...merges.values()].filter(inW).length;
    const reds = red.filter((r) => inW(r.at));
    const toGreen = reds.filter((r) => r.green !== null).map((r) => round1(minutes(r.green! - r.at)));
    const rv = [...reverts.values()].filter((r) => inW(r.at));
    const onRed = rv.filter((r) => r.onRed).length;
    const ff = fixForward.filter(evW).map((e) => String(P(e).outcome));
    const ci = prCi.filter(evW).map((e) => ({ number: Number(P(e).number), minutes: round1(minutes(Number(P(e).wall_ms))) }));
    const st = startups.filter((s) => inW(s.at)).map((s) => round1(s.secs));
    const rr = reruns.filter(evW);
    const flaky = rr.filter((e) => ((P(e).flaky as unknown[]) ?? []).length > 0).length;
    return {
      days,
      since: new Date(since).toISOString(),
      merges: mergesSeen ? { measured: true, total: mergeCount, perDay: round1(mergeCount / days) } : { measured: false, why: 'no merge recorded yet' },
      mainRed: mainSeen ? { measured: true, count: reds.length, stillRed: open !== null } : { measured: false, why: MAIN_UNSEEN },
      timeToGreen: mainSeen ? { measured: true, minutes: toGreen, medianMinutes: median(toGreen) } : { measured: false, why: MAIN_UNSEEN },
      reverts: revertsSeen
        ? { measured: true, opened: rv.length, onRed, merged: [...revertMerged.values()].filter(inW).length, redTimes: reds.length, rate: rate(onRed, reds.length) }
        : { measured: false, why: 'neither the check of the default branch after a merge nor the main watch has run yet' },
      fixForward: fixForward.length
        ? { measured: true, attempts: ff.length, fixed: ff.filter((x) => x === 'fixed').length, reverted: ff.filter((x) => x === 'reverted').length, successRate: rate(ff.filter((x) => x === 'fixed').length, ff.length) }
        : { measured: false, why: `fix-forward isn't built yet; this fills from its ${FIX_FORWARD_EVENT} events once it is` },
      prCi: prCi.length
        ? { measured: true, prs: ci.length, medianMinutes: median(ci.map((c) => c.minutes)), p90Minutes: pctile(ci.map((c) => c.minutes), 0.9), slowest: [...ci].sort((a, b) => b.minutes - a.minutes).slice(0, 3) }
        : { measured: false, why: "no merged PR's check runs have been read from GitHub yet" },
      startup: startups.length ? { measured: true, runs: st.length, medianSeconds: median(st), p90Seconds: pctile(st, 0.9) } : { measured: false, why: 'no task has been claimed and its agent started yet' },
      flake: reruns.length
        ? { measured: true, reruns: rr.length, flaky, rate: rate(flaky, rr.length), quarantined: evs.filter((e) => e.type === 'flaky.quarantined' && evW(e)).length }
        : { measured: false, why: "no re-run of a red default branch's failing checks recorded yet (flaky.rerun_result)" },
    };
  });

  // Merges per day: the last PER_DAY_DAYS UTC days.
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const perDay = mergesSeen
    ? Array.from({ length: PER_DAY_DAYS }, (_, i) => {
        const d = day(now - (PER_DAY_DAYS - 1 - i) * DAY_MS);
        return { day: d, merged: [...merges.values()].filter((t) => day(t) === d).length };
      })
    : null;

  // Slow tests: every run's durations over SLOW_TEST_DAYS, by test name; a test's figure is the median of its runs.
  const sinceSlow = now - SLOW_TEST_DAYS * DAY_MS;
  const runs = evs.filter((e) => (e.type === 'testrun.durations' || e.type === 'ci.test_durations') && T(e) > sinceSlow);
  const read = runs.filter((e) => Number(P(e).parsed) > 0);
  const by = new Map<string, number[]>();
  for (const e of read) for (const t of (P(e).tests as { name: string; ms: number }[]) ?? []) by.set(t.name, [...(by.get(t.name) ?? []), t.ms]);
  const tests: SlowTest[] = [...by]
    .map(([name, ms]) => ({ name, medianMs: round1(median(ms)!), maxMs: Math.max(...ms), runs: ms.length }))
    .sort((a, b) => b.medianMs - a.medianMs || a.name.localeCompare(b.name));
  const over = tests.filter((t) => t.medianMs > o.budgetS * 1000);
  const slowTests: Measure<SlowTests> = read.length
    ? { measured: true, days: SLOW_TEST_DAYS, budgetS: o.budgetS, runs: read.length, slowest: tests.slice(0, SLOWEST), overBudget: over.slice(0, OVER_BUDGET_LISTED), overBudgetTotal: over.length }
    : {
        measured: false,
        why: runs.length && runs.every((e) => typeof P(e).error === 'string')
          ? `the CI logs couldn't be read (${String(P(runs.at(-1)!).error)})`
          : runs.length
          ? `the last ${SLOW_TEST_DAYS} days' test output printed no per-test durations this reads (node:test, pytest --durations, go test -v, jest or vitest verbose)`
          : `no test run or CI log with per-test durations in the last ${SLOW_TEST_DAYS} days`,
      };
  return { until: new Date(now).toISOString(), windows, perDay, slowTests };
}

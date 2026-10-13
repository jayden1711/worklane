// Trust, measured: the trust numbers of src/merge-metrics.ts (trustMetrics) as the dashboard's Trust panel and the
// weekly digest show them, with two recommendations in plain words: how many agents this instance could run
// ("keep 2 agents" or "ready to raise to 3"), and per risk area whether verification could be heavier or lighter.
//
// Read-only measurement (docs/design.md, the stage-3 waiver of 2026-10-13): this module only reads the event log
// it is given and returns numbers and text. Nothing here changes slots, caps or merges; raising the agent count
// stays a machine owner's action. test/trust.test.ts holds it to that: neither this module nor anything it
// imports may write, run a command or reach the network.
import { RISK_AREAS, trustMetrics, type AreaTrust, type DeliveryMetrics, type DeliveryWindow, type Measure, type MetricEvent, type RiskArea, type TrustFailure, type TrustWindow } from './merge-metrics.js';

/** The recommendation's rules. Fixed here, never a model's. */
export const TRUST_RULES = {
  /** Ready to raise the agent count: over the last `days`, at least `minMerges` merges, a change failure rate under `maxChangeFailureRate`, and no escaped money-path bug. */
  raise: { days: 30, minMerges: 30, maxChangeFailureRate: 0.05 },
  /**
   * Verification per area, over 30 days: heavier at a change failure rate of `heavierAt` or more, or any escaped
   * bug; lighter (other areas only: money path and auth stay heavy) below `lighterBelow` over at least
   * `lighterMinMerges` merges; under `minMerges` there is too little to judge.
   */
  verification: { days: 30, minMerges: 10, heavierAt: 0.1, lighterBelow: 0.02, lighterMinMerges: 20 },
} as const;

export const AREA_LABEL: Record<RiskArea, string> = { money: 'money path', auth: 'auth', other: 'other' };

/** A figure a viewer may not see is null (src/trust.ts, trustForViewer); the owner and writers see every one. */
export type Shown<T> = { [K in keyof T]: T[K] | null };

export interface AgentAdvice {
  action: 'keep' | 'raise';
  /** The instance's agents (workers) now, and what the advice is for. */
  now: number;
  to: number;
  text: string;
  /** Each rule, met or not, in words. */
  why: { rule: string; met: boolean }[];
}

export interface VerificationAdvice {
  area: RiskArea;
  advice: 'heavier' | 'lighter' | 'keep' | 'too_few';
  text: string;
}

export interface TrustWindowView {
  days: number;
  since: string;
  total: Shown<AreaTrust>;
  byArea: Record<RiskArea, Shown<AreaTrust>> | null;
  failures: TrustFailure[] | null;
  escapedMoney: number | null;
}

export interface TrustView {
  until: string;
  windows: TrustWindowView[];
  agents: AgentAdvice | null;
  verification: VerificationAdvice[] | null;
  /** What each number means, as the panel's footnotes. */
  definitions: string[];
  /** Says plainly that this is a recommendation and changes nothing. */
  note: string;
  /** The figures left out for this reader (a viewer), by name; empty for the owner and writers. */
  hidden: string[];
}

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 1000) / 10}%`);

/** "Keep 2 agents" or "Ready to raise to 3 agents", by TRUST_RULES.raise, from the 30-day window. */
export function agentAdvice(w: Pick<TrustWindow, 'days' | 'total' | 'escapedMoney'>, now: number): AgentAdvice {
  const r = TRUST_RULES.raise;
  const cfr = w.total.changeFailureRate;
  const why = [
    { rule: `at least ${r.minMerges} merges in ${r.days} days (${w.total.merges})`, met: w.total.merges >= r.minMerges },
    { rule: `a change failure rate under ${pct(r.maxChangeFailureRate)} (${pct(cfr)})`, met: cfr !== null && cfr < r.maxChangeFailureRate },
    { rule: `no escaped money-path bug (${w.escapedMoney})`, met: w.escapedMoney === 0 },
  ];
  const raise = why.every((x) => x.met);
  const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
  const text = raise
    ? `Ready to raise to ${agents(now + 1)}: ${why.map((x) => x.rule).join(', ')}. Raising it stays a machine owner's action.`
    : `Keep ${agents(now)}: ${why
        .filter((x) => !x.met)
        .map((x) => `not yet ${x.rule}`)
        .join('; ')}.`;
  return { action: raise ? 'raise' : 'keep', now, to: raise ? now + 1 : now, text, why };
}

/** Per area: heavier, lighter or as it is, by TRUST_RULES.verification, from the 30-day window. */
export function verificationAdvice(byArea: Record<RiskArea, Pick<AreaTrust, 'merges' | 'changeFailureRate' | 'escapedBugs'>>): VerificationAdvice[] {
  const v = TRUST_RULES.verification;
  return RISK_AREAS.map((area) => {
    const a = byArea[area];
    const label = AREA_LABEL[area];
    const cfr = a.changeFailureRate;
    const escaped = a.escapedBugs ? `, ${a.escapedBugs} escaped bug${a.escapedBugs === 1 ? '' : 's'}` : '';
    if (a.escapedBugs > 0 || (a.merges >= v.minMerges && cfr !== null && cfr >= v.heavierAt))
      return { area, advice: 'heavier', text: `Verify ${label} changes more heavily (a change failure rate of ${pct(cfr)} over ${a.merges} merges${escaped}): for example the full test tier and the escalated evaluator on every one.` };
    if (a.merges < v.minMerges) return { area, advice: 'too_few', text: `Too few ${label} merges to judge (${a.merges} of ${v.minMerges}).` };
    if (area === 'other' && a.merges >= v.lighterMinMerges && cfr !== null && cfr < v.lighterBelow)
      return { area, advice: 'lighter', text: `Verification of other changes could be lighter (a change failure rate of ${pct(cfr)} over ${a.merges} merges): for example the fast test tier and the cheaper evaluator check.` };
    if (area !== 'other') return { area, advice: 'keep', text: `Keep ${label} verification as heavy as it is (a change failure rate of ${pct(cfr)} over ${a.merges} merges): money path and auth stay heavily verified however low it is.` };
    return { area, advice: 'keep', text: `Keep verification of other changes as it is (a change failure rate of ${pct(cfr)} over ${a.merges} merges).` };
  });
}

export const TRUST_DEFINITIONS = [
  'Change failure rate: of the merges in the window, how many failed: within 7 days the default branch went red on it or auto-merge stopped on it, a revert named it, or a fix PR (a bug, or a title starting "fix") changed the same files; or a production report was traced to it.',
  'Escaped bugs: production reports (issues filed by intake) traced to a harness merge: the latest merge, up to 30 days before the report, that changed a file the report\'s fix changed.',
  'Time to restore: the median hours from a failure showing to its fix or revert merging, or the default branch going green again.',
  'Revise/reject rate: of the issues a person reviewed (a plan decided, a correction recorded, or merged), how many they sent back.',
  'Flaky-check rate: of the checks and test tiers run on a commit, how many both passed and failed on that same commit.',
  "Cost per merged PR: the runs' own cost estimates (not billed money) and tokens, over the merges; runs on no issue count in the instance's total only.",
  'Verification time: per tier, the test-run tiers, the coordinator\'s verify checks and the evaluator\'s runs.',
  'Risk area: money path when the review level names a money path (or the issue has the money-path label), auth when it names auth or secrets, else other.',
];

export const TRUST_NOTE = "A recommendation only: nothing here changes the agent count, the slots, the caps or any merge. Raising the agent count stays a machine owner's action.";

/** The Trust panel's view for the owner and writers: every figure. `agents`: the instance's agents (workers) now. */
export function trustView(events: MetricEvent[], o: { agents: number; now?: Date }): TrustView {
  const m = trustMetrics(events, o.now ? { now: o.now } : {});
  const w30 = m.windows.find((w) => w.days === TRUST_RULES.raise.days)!;
  return {
    until: m.until,
    windows: m.windows,
    agents: agentAdvice(w30, o.agents),
    verification: verificationAdvice(w30.byArea),
    definitions: TRUST_DEFINITIONS,
    note: TRUST_NOTE,
    hidden: [],
  };
}

// --- What a viewer sees -----------------------------------------------------------------------------------------

type Fields = Readonly<Record<string, readonly string[]>>;
const MERGES: Fields = { 'merge.done': ['issue', 'number'], 'pr.closed': ['issue', 'number', 'merged'], 'land.result': ['issue', 'outcome'] };
const AREA: Fields = { 'review.level_set': ['issue', 'reasons'], 'issue.seen': ['issue', 'labels'] };
const FAILURES: Fields = {
  ...MERGES,
  'merge.done': ['issue', 'number', 'sha', 'title'],
  'merge.main_result': ['number', 'outcome'],
  'merge.stopped': ['number', 'revert'],
  'merge.resumed': [],
  'change.proposed': ['issue', 'files'],
  'issue.seen': ['issue', 'labels', 'title'],
  'intake.filed': ['issue'],
};

/**
 * Each figure and the event fields it is made of. A viewer sees a figure only when the viewer-events allowlist
 * (src/viewer-events.ts) shows them every one of those fields; anything made of more stays hidden, the way a new
 * event type does. Cost is never a viewer's (costs are the owners' and writers', like /api/throughput).
 */
export const TRUST_SOURCES: Readonly<Record<string, Fields>> = {
  merges: MERGES,
  area: AREA,
  failures: FAILURES,
  restore: FAILURES,
  review: { ...MERGES, 'plan.decided': ['issue', 'answer'], 'correction.recorded': ['issue', 'pr', 'kind'] },
  flaky: { 'check.result': ['issue', 'head', 'checks'], 'testrun.tier': ['id', 'tier', 'ok'], 'testrun.queued': ['id', 'sha', 'prs'] },
  verification: { 'check.result': ['issue', 'stage', 'checks'], 'testrun.tier': ['id', 'tier', 'duration_ms'], 'testrun.queued': ['id', 'prs'], 'run.cost': ['issue', 'role', 'secs'] },
};

/** The AreaTrust fields each figure fills. */
const FIGURE_FIELDS: Record<string, (keyof AreaTrust)[]> = {
  merges: ['merges'],
  failures: ['failures', 'changeFailureRate', 'escapedBugs'],
  restore: ['restoreHours', 'medianRestoreHours'],
  review: ['reviewed', 'revisedOrRejected', 'reviseRejectRate'],
  flaky: ['checks', 'flakyChecks', 'flakyRate'],
  verification: ['verification'],
};

/** Whether `allow` (event type -> the payload fields shown) shows every field a figure is made of. */
export function allowlistShows(sources: Fields, allow: Fields): boolean {
  return Object.entries(sources).every(([type, fields]) => Object.hasOwn(allow, type) && fields.every((f) => allow[type]!.includes(f)));
}

/**
 * The view as a viewer may have it: only the figures the viewer-events allowlist `allow` permits (TRUST_SOURCES),
 * never cost; the area breakdown and the recommendations only when what they are made of is permitted too.
 */
export function trustForViewer(v: TrustView, allow: Fields): TrustView {
  const shows = (k: string) => allowlistShows(TRUST_SOURCES[k]!, allow);
  const hidden = [...Object.keys(FIGURE_FIELDS).filter((k) => !shows(k)), 'cost'];
  const cut = (a: Shown<AreaTrust>): Shown<AreaTrust> => {
    const out = { ...a, cost: null };
    for (const k of hidden) for (const f of FIGURE_FIELDS[k] ?? []) (out as Record<string, unknown>)[f] = null;
    return out;
  };
  const area = shows('area');
  if (!area) hidden.push('area');
  const failures = shows('failures');
  return {
    ...v,
    windows: v.windows.map((w) => ({
      ...w,
      total: cut(w.total),
      byArea: area && w.byArea ? (Object.fromEntries(RISK_AREAS.map((a) => [a, cut(w.byArea![a])])) as Record<RiskArea, Shown<AreaTrust>>) : null,
      failures: failures ? w.failures : null,
      escapedMoney: failures && area ? w.escapedMoney : null,
    })),
    agents: failures && area && shows('merges') ? v.agents : null,
    verification: failures && area ? v.verification : null,
    hidden,
  };
}

// --- The weekly digest ------------------------------------------------------------------------------------------

const money = (n: number | null) => (n === null ? '–' : `~$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`);
const tokens = (n: number | null) => (n === null ? '–' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const hours = (n: number | null) => (n === null ? '–' : `${n} h`);
const minsPerMerge = (a: Shown<AreaTrust>) => {
  const total = (a.verification ?? []).reduce((s, t) => s + t.totalMinutes, 0);
  return a.merges ? `${Math.round(total / a.merges)} min` : '–';
};

/** The Monday (UTC) of a time's week, YYYY-MM-DD: the digest is posted once per week. */
export function trustWeek(t: Date): string {
  const back = (t.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** The weekly digest for the Discord ops channel: the 7- and 30-day numbers, by area, and both recommendations. Under 2000 characters. */
export function trustDigest(v: TrustView, o: { instance: string; dashboardUrl?: string | null }): string {
  const [w7, w30] = [v.windows.find((w) => w.days === 7)!, v.windows.find((w) => w.days === 30)!];
  const both = (f: (a: Shown<AreaTrust>) => string) => `${f(w7.total)} / ${f(w30.total)}`;
  const lines = [
    `**Trust, week of ${trustWeek(new Date(v.until))}: ${o.instance}** (last 7 / 30 days)`,
    `- Merged: ${both((a) => String(a.merges))}`,
    `- Change failure rate: ${both((a) => pct(a.changeFailureRate))}`,
    `- Escaped bugs: ${both((a) => String(a.escapedBugs ?? '–'))} (money path, 30 days: ${w30.escapedMoney ?? '–'})`,
    `- Time to restore (median): ${both((a) => hours(a.medianRestoreHours))}`,
    `- Revise/reject rate: ${both((a) => pct(a.reviseRejectRate))}`,
    `- Flaky-check rate: ${both((a) => pct(a.flakyRate))}`,
    `- Cost per merged PR (estimates): ${both((a) => `${money(a.cost?.perMergedPrUsd ?? null)}, ${tokens(a.cost?.perMergedPrTokens ?? null)} tokens`)}`,
  ];
  if (w30.byArea) {
    lines.push('By area, 30 days:');
    for (const area of RISK_AREAS) {
      const a = w30.byArea[area];
      lines.push(`- ${AREA_LABEL[area]}: ${a.merges} merged, failure rate ${pct(a.changeFailureRate)}, ${money(a.cost?.perMergedPrUsd ?? null)}/PR, verification ${minsPerMerge(a)}/PR`);
    }
  }
  if (v.agents) lines.push(`Agents: ${v.agents.text}`);
  for (const x of v.verification ?? []) if (x.advice === 'heavier' || x.advice === 'lighter') lines.push(`Verification: ${x.text}`);
  lines.push(`_${TRUST_NOTE}_`);
  if (o.dashboardUrl) lines.push(`${o.dashboardUrl.replace(/\/+$/, '')}/reports`);
  const text = lines.join('\n');
  return text.length <= 1990 ? text : `${text.slice(0, 1985)}…`;
}

// --- Delivery metrics: the Metrics panel and its weekly digest ----------------------------------------------------

/** What each delivery figure means, as the Metrics panel's footnotes. */
export const METRICS_DEFINITIONS = [
  'Merges per day: merged PRs and direct lands the event log records, over the window\'s days.',
  'Main red: times the default branch went red in the check after a merge (red again while still red is the same time).',
  'Time to green: the median minutes from the default branch going red to its next green check.',
  'Reverts: revert PRs opened after a red default branch or for a commit the main watch could not account for, and how many merged; the revert rate is reverts opened on a red default branch over the times it went red.',
  "Fix-forward: a red default branch fixed by a fix PR instead of a revert. Not built yet: its figure fills from fix-forward's own events once it is.",
  'PR CI wall-clock: on a merged PR\'s head, from the first check run starting to the last required check (config.yaml required_checks; every check when none) completing, read from GitHub once per PR.',
  'Agent startup: seconds from a task being claimed to its agent\'s process starting.',
  'Flake rate: of the re-runs of a red default branch\'s failing checks, how many found a flaky check (passed on the re-run).',
  'Slow tests: per-test durations printed by test runs and by the default branch\'s CI jobs over 7 days (node:test, pytest --durations, go test -v, jest or vitest verbose); each test\'s figure is the median of its runs. Over budget: over config.yaml metrics.slow_test_budget_s.',
];

export const NOT_MEASURED = 'not measured yet';

const ms = (n: number) => (n >= 60_000 ? `${Math.round(n / 6000) / 10} min` : n >= 1000 ? `${Math.round(n / 100) / 10} s` : `${Math.round(n)} ms`);
const mins = (n: number | null) => (n === null ? '–' : n < 1 ? `${Math.round(n * 60)} s` : `${n} min`);
const secs = (n: number | null) => (n === null ? '–' : n >= 120 ? `${Math.round(n / 6) / 10} min` : `${n} s`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One delivery figure over the 7 and 30 days, in words: "not measured yet" when its source has nothing yet. */
export function deliveryLines(m: DeliveryMetrics): string[] {
  const [w7, w30] = [m.windows.find((w) => w.days === 7)!, m.windows.find((w) => w.days === 30)!];
  const both = <K extends keyof DeliveryWindow>(k: K, f: (x: Extract<DeliveryWindow[K], { measured: true }>) => string) => {
    const a = w7[k] as Measure<object>;
    const b = w30[k] as Measure<object>;
    if (!a.measured || !b.measured) return `${NOT_MEASURED} (${((a.measured ? b : a) as { why: string }).why})`;
    return `${f(a as Extract<DeliveryWindow[K], { measured: true }>)} / ${f(b as Extract<DeliveryWindow[K], { measured: true }>)}`;
  };
  return [
    `- Merges per day: ${both('merges', (x) => `${x.perDay} (${x.total})`)}`,
    `- Main red: ${both('mainRed', (x) => String(x.count))}${w7.mainRed.measured && w7.mainRed.stillRed ? ' (red now)' : ''}`,
    `- Time to green (median): ${both('timeToGreen', (x) => mins(x.medianMinutes))}`,
    `- Reverts opened, merged: ${both('reverts', (x) => `${x.opened}, ${x.merged}`)}; revert rate ${both('reverts', (x) => pct(x.rate))}`,
    `- Fix-forward success: ${both('fixForward', (x) => `${pct(x.successRate)} of ${x.attempts}`)}`,
    `- PR CI wall-clock (median, p90): ${both('prCi', (x) => `${mins(x.medianMinutes)}, ${mins(x.p90Minutes)}`)}`,
    `- Agent startup (median, p90): ${both('startup', (x) => `${secs(x.medianSeconds)}, ${secs(x.p90Seconds)}`)}`,
    `- Flake rate: ${both('flake', (x) => `${pct(x.rate)} of ${x.reruns}`)}`,
  ];
}

/**
 * The weekly metrics digest for the Discord ops channel, beside the trust digest: the delivery figures, then the 20
 * slowest tests and every test over the time budget (what the weekly optimization pass can target). Each message
 * is under 2000 characters; a long list continues in the next.
 */
export function metricsDigest(m: DeliveryMetrics, o: { instance: string; dashboardUrl?: string | null }): string[] {
  const head = [`**Metrics, week of ${trustWeek(new Date(m.until))}: ${o.instance}** (last 7 / 30 days)`, ...deliveryLines(m)];
  if (o.dashboardUrl) head.push(`${o.dashboardUrl.replace(/\/+$/, '')}/reports`);
  const out = [head.join('\n')];
  const s = m.slowTests;
  const tests: string[] = [];
  if (!s.measured) tests.push(`**Slow tests:** ${NOT_MEASURED} (${s.why}).`);
  else {
    tests.push(`**The ${s.slowest.length} slowest tests**, last ${s.days} days (median of ${s.runs} run${s.runs === 1 ? '' : 's'}; budget ${s.budgetS} s):`);
    s.slowest.forEach((t, i) => tests.push(`${i + 1}. ${ms(t.medianMs)} \`${cut(t.name, 70).replace(/`/g, "'")}\``));
    if (!s.overBudgetTotal) tests.push(`Over the ${s.budgetS} s budget: none.`);
    else {
      tests.push(`**Over the ${s.budgetS} s budget: ${s.overBudgetTotal}**`);
      for (const t of s.overBudget) tests.push(`- ${ms(t.medianMs)} \`${cut(t.name, 70).replace(/`/g, "'")}\``);
      if (s.overBudgetTotal > s.overBudget.length) tests.push(`- and ${s.overBudgetTotal - s.overBudget.length} more`);
    }
  }
  // Split into messages under 2000 characters, at line breaks.
  let cur = '';
  for (const line of tests) {
    if (cur && cur.length + line.length + 1 > 1990) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, 1990);
  }
  if (cur) out.push(cur);
  return out;
}

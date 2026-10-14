// Throughput: what got merged, what each merged PR cost and where that went, where PRs waited for the
// owner and why, and the biggest costs with a tuning to try for each. Read from the event log alone (the
// dashboard's panel and the weekly report); every cost figure is the CLI's own estimate, not billed money.
// The tunings come from fixed rules here, never from a model.
import { tierOf } from './model-routing.js';

interface Ev {
  type: string;
  ts: string;
  payload: unknown;
}

/** Where a run's cost goes. Gardener has no runs yet; it shows as zero rather than missing. */
export const STAGES = ['worker', 'evaluator', 'plan', 'research', 'intake', 'gardener', 'chat', 'retries', 'other'] as const;
export type Stage = (typeof STAGES)[number];

/** A run.cost role's stage. A worker's later attempts, and fix runs after a failed check or a conflict, are retries. */
export function stageOf(role: string, attempt = 1): Stage {
  if (role === 'worker') return attempt > 1 ? 'retries' : 'worker';
  if (role === 'evaluator-verdict' || role === 'evaluator-repro' || role === 'investigator') return 'evaluator';
  if (role === 'evaluator-escalated') return 'evaluator';
  if (role === 'instruction-eval' || role === 'eval-case-writer') return 'evaluator';
  if (role === 'planner' || role === 'plan-reviewer' || role === 'goal-planner') return 'plan';
  if (role === 'researcher') return 'research';
  if (role === 'research-on-demand') return 'research';
  if (role === 'intake') return 'intake';
  if (role === 'gardener') return 'gardener';
  if (role === 'chat') return 'chat';
  if (role === 'ci-fix' || role === 'conflict-fix') return 'retries';
  return 'other';
}

export interface Wait {
  kind: string;
  label: string;
  /** Whether the owner's action ends the wait (a hotspot hold ends on its own). */
  owner: boolean;
  count: number;
  /** Still waiting now. */
  open: number;
  medianHours: number | null;
  totalHours: number;
  /** The commonest reasons or questions, most first. */
  reasons: { reason: string; count: number }[];
}

export interface Throughput {
  since: string;
  until: string;
  merged: { total: number; perDay: { day: string; merged: number }[]; perWeek: { week: string; merged: number }[] };
  cost: {
    totalUsd: number;
    perMergedPrUsd: number | null;
    byStage: { stage: Stage; usd: number; perMergedPrUsd: number | null; share: number }[];
    /**
     * The same spend by model, most first: haiku, sonnet or opus; an open-model provider by name (`local`,
     * `hosted:<name>`, whose cost is its own price, $0 for local); or the id of a model of no known tier. With the
     * tokens and run time behind it, where claude reported them.
     */
    byModel: { model: string; usd: number; perMergedPrUsd: number | null; share: number; tokensIn: number; tokensOut: number; secs: number; perMergedPrTokens: number | null }[];
    /** Evaluator spend on PRs whose review level was L0. */
    evaluatorOnL0Usd: number;
  };
  waits: Wait[];
  top: { stage: Stage; usd: number; share: number; suggestion: string }[];
}

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** The Monday (UTC) of a timestamp's week, as YYYY-MM-DD. */
const weekOf = (t: number) => {
  const d = new Date(t);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
};

const DECISION_LABEL: Record<string, string> = {
  land: 'approving a change to land',
  question: "answering an agent's question",
  domain: 'allowing an unknown domain',
  plan: 'approving a high-risk or design-level plan',
  intake: "approving a report's draft",
};

/** When each issue first merged: an auto-merge, a merged PR, or a direct land. */
function mergesByIssue(events: Ev[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const merged = e.type === 'merge.done' || (e.type === 'pr.closed' && p.merged === true) || (e.type === 'land.result' && p.outcome === 'landed');
    if (merged && typeof p.issue === 'number' && !out.has(p.issue)) out.set(p.issue, Date.parse(e.ts));
  }
  return out;
}

/** The suggested tuning for a stage's cost: fixed rules, with this week's numbers in them. */
export function suggestionFor(stage: Stage, t: Pick<Throughput, 'cost'> & { merged: { total: number } }): string {
  const s = t.cost.byStage.find((x) => x.stage === stage)!;
  const per = s.perMergedPrUsd !== null ? `${money(s.perMergedPrUsd)} per merged PR` : money(s.usd);
  switch (stage) {
    case 'retries':
      return s.share >= 0.2
        ? `Retries are ${pct(s.share)} of the spend: look at why first attempts fail (the weekly failure modes) before raising run or fix caps.`
        : `Retries cost ${money(s.usd)}: check the failure modes for a cause seen three or more times.`;
    case 'evaluator': {
      const l0 = s.usd > 0 ? t.cost.evaluatorOnL0Usd / s.usd : 0;
      return l0 >= 0.3
        ? `${pct(l0)} of evaluator spend is on L0 PRs: tiered evaluation (a cheaper check for L0) would cut most of it.`
        : `Evaluation costs ${per}: tier it by review level, so low-risk PRs get the cheaper check.`;
    }
    case 'worker':
      return `Worker runs cost ${per}: split size:L issues, or have them planned first (plan mode).`;
    case 'plan':
      return `Planning costs ${per}: keep plan mode to size:M/L issues, or plan with a cheaper model.`;
    case 'research':
      return `Research cost ${money(s.usd)}: lower the research caps, or research only when an issue asks for it.`;
    case 'intake':
      return `Intake drafts cost ${money(s.usd)}: lower intake.drafts_per_day or the intake spend cap.`;
    case 'chat':
      return `Chat cost ${money(s.usd)}: answer from a summary of earlier turns instead of the whole history.`;
    case 'gardener':
      return `Gardening cost ${money(s.usd)}: run it less often.`;
    case 'other':
      return `Other runs (skill and instruction evals) cost ${money(s.usd)}: run them less often.`;
  }
}

/** Throughput over `days` (7) up to `now`, with merges per day over the last 14 days and per week over the last 8. */
export function throughput(events: Ev[], o: { now?: Date; days?: number } = {}): Throughput {
  const now = (o.now ?? new Date()).getTime();
  const since = now - (o.days ?? 7) * DAY;
  const inWindow = (t: number) => t > since && t <= now;

  // Merged PRs.
  const merges = [...mergesByIssue(events).values()].filter((t) => t <= now);
  const perDay = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * DAY).toISOString().slice(0, 10)).map((day) => ({ day, merged: merges.filter((t) => new Date(t).toISOString().slice(0, 10) === day).length }));
  const thisWeek = weekOf(now);
  const perWeek = Array.from({ length: 8 }, (_, i) => new Date(Date.parse(thisWeek) - (7 - i) * 7 * DAY).toISOString().slice(0, 10)).map((week) => ({ week, merged: merges.filter((t) => weekOf(t) === week).length }));
  const mergedCount = merges.filter(inWindow).length;

  // Cost by stage, and evaluator spend on L0 PRs.
  const attempt = new Map<string, number>();
  const level = new Map<number, string>();
  const usd = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  const byModel = new Map<string, { usd: number; tokensIn: number; tokensOut: number; secs: number }>();
  let evaluatorOnL0Usd = 0;
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'run.started') attempt.set(`${p.issue}:${p.role}`, Number(p.attempt) || 1);
    else if (e.type === 'review.level_set' && typeof p.issue === 'number') level.set(p.issue, String(p.level));
    else if (e.type === 'run.cost' && inWindow(Date.parse(e.ts))) {
      const stage = stageOf(String(p.role), p.issue === null ? 1 : (attempt.get(`${p.issue}:${p.role}`) ?? 1));
      const cost = Number(p.usd) || 0;
      usd[stage] += cost;
      const model = typeof p.provider === 'string' && p.provider ? p.provider : typeof p.model === 'string' && p.model ? (tierOf(p.model) ?? p.model) : 'unknown';
      const m = byModel.get(model) ?? { usd: 0, tokensIn: 0, tokensOut: 0, secs: 0 };
      byModel.set(model, { usd: m.usd + cost, tokensIn: m.tokensIn + (Number(p.tokens_in) || 0), tokensOut: m.tokensOut + (Number(p.tokens_out) || 0), secs: m.secs + (Number(p.secs) || 0) });
      if (stage === 'evaluator' && typeof p.issue === 'number' && level.get(p.issue) === 'L0') evaluatorOnL0Usd += cost;
    }
  }
  const totalUsd = STAGES.reduce((s, x) => s + usd[x], 0);
  const per = (n: number) => (mergedCount ? round2(n / mergedCount) : null);
  const cost: Throughput['cost'] = {
    totalUsd: round2(totalUsd),
    perMergedPrUsd: per(totalUsd),
    byStage: STAGES.map((stage) => ({ stage, usd: round2(usd[stage]), perMergedPrUsd: per(usd[stage]), share: totalUsd ? usd[stage] / totalUsd : 0 })),
    byModel: [...byModel.entries()]
      .sort((a, b) => b[1].usd - a[1].usd || b[1].tokensIn + b[1].tokensOut - (a[1].tokensIn + a[1].tokensOut))
      .map(([model, u]) => ({ model, usd: round2(u.usd), perMergedPrUsd: per(u.usd), share: totalUsd ? u.usd / totalUsd : 0, tokensIn: u.tokensIn, tokensOut: u.tokensOut, secs: Math.round(u.secs), perMergedPrTokens: mergedCount ? Math.round((u.tokensIn + u.tokensOut) / mergedCount) : null })),
    evaluatorOnL0Usd: round2(evaluatorOnL0Usd),
  };

  // Where PRs waited, and why: decisions the owner was asked, merges left to the owner, hotspot holds.
  const answered = new Map<string, number>();
  const mergedPr = new Map<number, number>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'decision.answered') answered.set(String(p.id), Date.parse(e.ts));
    if ((e.type === 'merge.done' || (e.type === 'pr.closed' && p.merged === true)) && typeof p.number === 'number' && !mergedPr.has(p.number)) mergedPr.set(p.number, Date.parse(e.ts));
  }
  const groups = new Map<string, { label: string; owner: boolean; hours: number[]; open: number; reasons: Map<string, number> }>();
  const note = (kind: string, label: string, owner: boolean, from: number, to: number | undefined, reasons: string[]) => {
    const end = to !== undefined && to <= now ? to : undefined;
    // Counted when it started in the window, or is still waiting.
    if (!(inWindow(from) || end === undefined)) return;
    const g = groups.get(kind) ?? { label, owner, hours: [] as number[], open: 0, reasons: new Map<string, number>() };
    g.hours.push(Math.max(0, ((end ?? now) - from) / 3_600_000));
    if (end === undefined) g.open++;
    for (const r of reasons) g.reasons.set(r, (g.reasons.get(r) ?? 0) + 1);
    groups.set(kind, g);
  };
  const holds = new Map<number, number>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const at = Date.parse(e.ts);
    if (at > now) continue;
    if (e.type === 'decision.asked') {
      const kind = String(p.kind);
      note(`decision:${kind}`, DECISION_LABEL[kind] ?? `a ${kind} decision`, true, at, answered.get(String(p.id)), kind === 'question' ? [String(p.question).slice(0, 120)] : []);
    } else if (e.type === 'merge.decided' && p.auto === false) {
      note('merge', 'merging a PR the harness left to you', true, at, mergedPr.get(Number(p.number)), (p.reasons as string[]) ?? []);
    } else if (e.type === 'hotspot.held' && typeof p.issue === 'number') holds.set(p.issue, at);
    else if (e.type === 'hotspot.released' && typeof p.issue === 'number' && holds.has(p.issue)) {
      note('hotspot', 'held behind another task changing the same files (ends on its own)', false, holds.get(p.issue)!, at, (p.files as string[]) ?? []);
      holds.delete(p.issue);
    }
  }
  for (const [, from] of holds) note('hotspot', 'held behind another task changing the same files (ends on its own)', false, from, undefined, []);
  const waits: Wait[] = [...groups].map(([kind, g]) => ({
    kind,
    label: g.label,
    owner: g.owner,
    count: g.hours.length,
    open: g.open,
    medianHours: median(g.hours) === null ? null : Math.round(median(g.hours)! * 10) / 10,
    totalHours: Math.round(g.hours.reduce((s, h) => s + h, 0) * 10) / 10,
    reasons: [...g.reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3),
  }));
  // The owner's waits first, longest in total first.
  waits.sort((a, b) => Number(b.owner) - Number(a.owner) || b.totalHours - a.totalHours);

  const base = { cost, merged: { total: mergedCount } };
  const top = [...cost.byStage]
    .filter((s) => s.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 3)
    .map((s) => ({ stage: s.stage, usd: s.usd, share: s.share, suggestion: suggestionFor(s.stage, base) }));

  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), merged: { total: mergedCount, perDay, perWeek }, cost, waits, top };
}

/** The weekly report's throughput section. */
export function throughputMarkdown(t: Throughput): string[] {
  const out = [`**Throughput, last 7 days** (estimated cost: the CLI's own estimate, not billed money)`];
  out.push(`- Merged PRs: ${t.merged.total}; by week: ${t.merged.perWeek.slice(-4).map((w) => `${w.week.slice(5)} ${w.merged}`).join(', ')}.`);
  out.push(`- Cost per merged PR: ${t.cost.perMergedPrUsd !== null ? `~${money(t.cost.perMergedPrUsd)}` : 'no PR merged'} (~${money(t.cost.totalUsd)} in all).`);
  const stages = t.cost.byStage.filter((s) => s.usd > 0);
  if (stages.length) out.push(`- By stage: ${stages.map((s) => `${s.stage} ~${money(s.perMergedPrUsd ?? s.usd)}${s.perMergedPrUsd !== null ? '/PR' : ''}`).join(', ')}.`);
  const models = t.cost.byModel.filter((m) => m.usd > 0 || m.tokensIn + m.tokensOut > 0);
  const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (models.length) out.push(`- By model: ${models.map((m) => `${m.model} ~${money(m.perMergedPrUsd ?? m.usd)}${m.perMergedPrUsd !== null ? '/PR' : ''}${m.tokensIn + m.tokensOut ? ` (${tokens(m.tokensIn + m.tokensOut)} tokens, ${Math.round(m.secs / 60)} min)` : ''}`).join(', ')}.`);
  const mine = t.waits.filter((w) => w.owner);
  out.push(mine.length ? `- Waited for you: ${mine.map((w) => `${w.label} ${w.count}× (median ${w.medianHours} h${w.open ? `, ${w.open} still waiting` : ''})`).join('; ')}.` : '- Nothing waited for you.');
  for (const [i, x] of t.top.entries()) out.push(`- Cost ${i + 1}: ${x.stage}, ~${money(x.usd)} (${pct(x.share)}). ${x.suggestion}`);
  return out;
}

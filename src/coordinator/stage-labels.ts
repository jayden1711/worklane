// Earliest-failed-stage labels for the weekly report: before the weekly section is built, each failed worker run of
// the week that has a run record and no label yet is labelled once (stage-label.ts). Code sets the labels it can
// from the run's events, trace and record; the rest get one judge call each, while the day's budget and the
// per-report cap allow. A planner run whose plan the plan gate turned down, and a worker run whose proposed change
// the evaluator passed and then failed (or rejected and then merged green), are labelled too, from their trace
// only. Every label is a run.stage_labeled event and every judge call a run.cost; nothing else changes, and a run
// labelled once is never labelled again.
import type { EventPayload, StoredEvent } from '../events/types.js';
import { classifyRuns, type ClassifiedRun } from '../failure-modes.js';
import type { RunRecord } from '../run-record.js';
import type { AgentRunner, RunRequest } from '../runner.js';
import { labelFailedRun, traceStage, type FailedRun, type RunTrace, type TraceEvent } from '../stage-label.js';

/** Judge calls per report at most, whatever the budget left: the weekly section needs a sample, not every run. */
export const STAGE_JUDGE_MAX = 20;
/** What one judge call may cost (its maxBudgetUsd): the daily budget must still have this much left to start one. */
export const STAGE_JUDGE_USD = 0.5;
/** Events this long after a run ended still belong to it (a startup failure is recorded just after). */
const AFTER_MS = 2 * 60_000;

const MAX_STEPS_TEXT = 12_000;

/**
 * The week's failed worker runs that have a record and no label yet, oldest first; with them, the planner runs and
 * proposed worker runs whose trace alone gives a label (traceStage).
 */
export function unlabelledFailures(events: StoredEvent[], records: RunRecord[], since: Date, until: Date): { run: ClassifiedRun; record: RunRecord }[] {
  const labelled = new Set(events.filter((e) => e.type === 'run.stage_labeled').map((e) => (e.payload as EventPayload<'run.stage_labeled'>).run));
  const byId = new Map(records.map((r) => [r.id, r]));
  const failed = (c: ClassifiedRun) => c.role === 'worker' && c.outcome !== 'succeeded' && c.outcome !== 'proposed' && c.outcome !== 'canceled';
  const traced = (c: ClassifiedRun) => ((c.role === 'planner' && c.outcome === 'succeeded') || (c.role === 'worker' && c.outcome === 'proposed')) && traceStage(asFailedRun(c, byId.get(c.runId!)!, events, [])) !== null;
  return classifyRuns(events, since, until, records)
    .filter((c) => c.runId && !labelled.has(c.runId) && byId.has(c.runId) && (failed(c) || traced(c)))
    .map((c) => ({ run: c, record: byId.get(c.runId!)! }));
}

/**
 * The issue's events around a run, in log order: before its start, and from its start up to the next run of the
 * same role on the issue.
 */
export function runTrace(c: ClassifiedRun, events: StoredEvent[]): RunTrace {
  const from = Date.parse(c.startedAt);
  const before: TraceEvent[] = [];
  const during: TraceEvent[] = [];
  for (const e of events) {
    const p = e.payload as { issue?: unknown; role?: unknown };
    if (p.issue !== c.issue) continue;
    const t = { type: e.type as string, payload: e.payload as Record<string, unknown> };
    if (Date.parse(e.ts) < from) before.push(t);
    else if (e.type === 'run.started' && p.role === c.role && Date.parse(e.ts) > from) break;
    else during.push(t);
  }
  return { before, during };
}

/** What the labeller sees of one run: its outcome, the events recorded for it, its commands and steps, its done_when, its trace. */
export function asFailedRun(c: ClassifiedRun, rec: RunRecord, events: StoredEvent[], doneWhen: string[], doneWhenTests: string[] = []): FailedRun {
  const from = Date.parse(c.startedAt);
  const to = Date.parse(c.endedAt) + AFTER_MS;
  const types = events.filter((e) => (e.payload as { issue?: unknown }).issue === c.issue && Date.parse(e.ts) >= from && Date.parse(e.ts) <= to).map((e) => e.type as string);
  const steps = rec.steps.map((s) => `${s.kind === 'command' ? `$ ${s.what}` : `wrote ${s.what}`}: ${s.status}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}${s.output ? `\n${s.output}` : ''}`).join('\n');
  return {
    run: rec.id,
    issue: c.issue,
    role: c.role,
    ended: c.outcome,
    why: [c.cause, c.blocked ? `then: ${c.blocked.split('\n')[0]}` : ''].filter(Boolean).join('; '),
    events: [...new Set(types)],
    doneWhen,
    commands: rec.steps.filter((s) => s.kind === 'command').map((s) => s.what),
    steps: steps.slice(0, MAX_STEPS_TEXT) + (rec.files.length ? `\nfiles written: ${rec.files.join(', ')}` : ''),
    final: rec.final,
    doneWhenTests,
    trace: runTrace(c, events),
  };
}

export interface StageLabelDeps {
  events: StoredEvent[];
  records: RunRecord[];
  since: Date;
  until: Date;
  instance: string;
  runner: AgentRunner;
  cwd: string;
  model?: string;
  /** The judge's route, for a model that names an open-model provider (src/providers.ts). */
  route?: RunRequest['route'];
  /** The issue's done_when command lines ([] when it has none or can't be read), and with them its test files. */
  doneWhenOf: (issue: number) => Promise<string[] | { commands: string[]; tests: string[] }>;
  spentToday: () => number;
  dailyBudgetUsd: number;
  emit: <T extends 'run.stage_labeled' | 'run.cost'>(type: T, payload: EventPayload<T>) => void;
}

/** Label the week's unlabelled failed runs; how many were labelled. */
export async function labelWeek(d: StageLabelDeps): Promise<number> {
  let calls = 0;
  let n = 0;
  const allowed = () => calls < STAGE_JUDGE_MAX && d.spentToday() + STAGE_JUDGE_USD <= d.dailyBudgetUsd;
  for (const { run, record } of unlabelledFailures(d.events, d.records, d.since, d.until)) {
    const dw = await d.doneWhenOf(run.issue);
    const f = Array.isArray(dw) ? asFailedRun(run, record, d.events, dw) : asFailedRun(run, record, d.events, dw.commands, dw.tests);
    const l = await labelFailedRun(f, {
      runner: d.runner,
      cwd: d.cwd,
      ...(d.model ? { model: d.model } : {}),
      ...(d.route ? { route: d.route } : {}),
      allowed: () => {
        if (!allowed()) return false;
        calls++;
        return true;
      },
      onCost: (usd) => d.emit('run.cost', { issue: run.issue, role: 'stage-judge', model: d.model ?? 'sonnet', usd, turns: 0 }),
    });
    if (!l) continue;
    d.emit('run.stage_labeled', { run: l.run, issue: run.issue, role: run.role, instance: d.instance, stage: l.stage, reason: l.reason, by: l.by });
    n++;
  }
  return n;
}

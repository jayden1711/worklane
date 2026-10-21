// The earliest failed stage of a failed or rejected run, for the weekly failure-mode report (grouped by stage and
// instance); a label never changes anything by itself. Two labels are facts the harness already has, so code sets
// them and no model is asked: environment/harness when the run has a startup-failure, transient-retry, stuck or
// console-stop event, and verification when the run never ran any of its done_when commands. The judge can neither
// set nor clear those. Two more are set by code only, from the run's trace (the issue's events), never by the judge
// and never guessed: plan (the planner or the plan gate) and review (the evaluator); traceStage lists the evidence
// each needs, and anything short of it leaves the label as it would have been. Every other failed run gets one cheap
// judge call; it may still say verification for a run that ran its checks but misread or ignored the results. The
// judge reads only the run's redacted record, never the repo or the web, and every call counts against the day's cap.
import type { DoneWhenList } from './backlog/types.js';
import type { AgentRunner, RunRequest } from './runner.js';
import type { Stage } from './stage-names.js';

export { STAGES, type Stage } from './stage-names.js';

/** The labels the judge picks from. environment/harness, plan and review are code's alone; verification is the judge's only for a run that ran its checks. */
export const JUDGE_STAGES = ['wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification'] as const satisfies readonly Stage[];

export const STAGE_HINTS: Record<Stage, string> = {
  plan: 'the plan was wrong: the plan gate turned it down, or it left out a requirement whose check then failed',
  'wrong files': 'it changed files that are not where the problem is',
  'right files, wrong place': 'the right files, but the change is in the wrong function or lines',
  'wrong or incomplete change': 'the right place, but the change is wrong or only part of what was needed',
  verification: 'it ran the checks but misread or ignored what they said',
  review: 'the evaluator passed a change whose checks then failed on that same head, or rejected one that then merged green',
  'environment/harness': 'the machine, a tool, a login, the sandbox or the harness itself failed, not the change',
};

/** Events that mean the harness or the machine, not the change, ended the run. */
export const HARNESS_EVENTS = ['run.startup_failed', 'run.transient_retry', 'run.stuck', 'console.run_stopped'] as const;

export const STAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stage', 'reason'],
  properties: { stage: { enum: [...JUDGE_STAGES] }, reason: { type: 'string', maxLength: 300 } },
} as const;

export interface StageLabel {
  run: string;
  stage: Stage;
  reason: string;
  /** Who set it: code (from events and the run record) or the judge. */
  by: 'code' | 'judge';
  costUsd: number;
}

/** What the labeller sees: the run's redacted record, already summarized by the caller. */
export interface FailedRun {
  run: string;
  issue: number | null;
  role: string;
  /** The run's outcome as failure-modes classified it. */
  ended: string;
  /** Why the coordinator called it a failure: rejected change, failing checks, evaluator verdict, the block reason. */
  why: string;
  /** The event types recorded for this run. */
  events: string[];
  /** The issue's done_when commands; empty when it has none (then nothing is inferred from them). */
  doneWhen: string[];
  /** The shell commands in the run record, as run. */
  commands: string[];
  /** The run's steps as recorded (commands with status, files written), redacted and capped. */
  steps: string;
  final: string;
  /** The issue's done_when test files (a subset of doneWhen's lines); absent or empty: none. */
  doneWhenTests?: string[];
  /** The run's trace, from the event log; absent (an eval fixture, an older caller): no plan or review label. */
  trace?: RunTrace;
}

/** One of the issue's events, as recorded. */
export interface TraceEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** The issue's events around one run, oldest first. */
export interface RunTrace {
  /** Before the run started: the plan it was built from is here. */
  before: TraceEvent[];
  /** From the run's start up to the next run of the same role on the issue (what happened to this run's work). */
  during: TraceEvent[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The command lines that run an issue's done_when checks, as a run would type them: its commands, its test files (any command naming one), the project's suite. */
export function doneWhenCommands(list: DoneWhenList, runner: { changed: string; full: string }): string[] {
  return list.flatMap((d) => ('command' in d ? [d.command] : 'test' in d ? [d.test] : 'suite' in d ? [d.suite === 'full' ? runner.full : runner.changed] : []));
}

/** Whether any line of any done_when command appears in a command the run ran. */
export function ranDoneWhen(doneWhen: string[], commands: string[]): boolean {
  const ran = commands.map(norm);
  return doneWhen.some((c) => c.split('\n').map(norm).filter(Boolean).some((line) => ran.some((r) => r.includes(line))));
}

/** environment/harness when the run's events or outcome say the harness or the machine ended it; else null. */
function harnessStage(f: FailedRun): { stage: 'environment/harness'; reason: string } | null {
  const harness = f.events.find((e) => (HARNESS_EVENTS as readonly string[]).includes(e));
  if (harness) return { stage: 'environment/harness', reason: `the run has a ${harness} event` };
  if (f.ended === 'startup failure') return { stage: 'environment/harness', reason: 'the run never got to work (startup failure)' };
  return null;
}

/** The label code sets without a judge call, or null when the judge has to decide. */
export function codeStage(f: FailedRun): { stage: Exclude<Stage, 'plan' | 'review'>; reason: string } | null {
  const harness = harnessStage(f);
  if (harness) return harness;
  if (f.doneWhen.length && !ranDoneWhen(f.doneWhen, f.commands)) return { stage: 'verification', reason: "the run didn't run any of the issue's done_when commands" };
  return null;
}

/** Outcomes of runs that didn't fail by themselves: only a trace label labels them. */
const TRACE_ONLY_OUTCOMES = new Set(['succeeded', 'proposed']);

const line = (v: unknown) => String(v ?? '').split('\n')[0]!.trim().slice(0, 160);
const short = (h: unknown) => String(h ?? '').slice(0, 8);
const pay = <T>(e: TraceEvent) => e.payload as T;

/**
 * A planner run's plan the plan gate turned down, from the events after the run and before the next planner run:
 * the contract check or plan review sent it back; or it was posted, and the owner rejected it or asked for a
 * revision (the decision on that posting), or a writer objected to it once it was being built.
 */
function plannerEvidence(t: RunTrace): string | null {
  const end = t.during.findIndex((e) => e.type === 'run.finished' && pay<{ role: string }>(e).role === 'planner');
  if (end < 0) return null;
  const rest = t.during.slice(end + 1);
  const first = rest.findIndex((e) => e.type === 'plan.sent_back' || e.type === 'plan.posted');
  if (first < 0) return null;
  const e = rest[first]!;
  if (e.type === 'plan.sent_back') {
    const p = pay<{ by: string; why: string }>(e);
    return `${p.by === 'contract' ? 'the plan contract check' : 'plan review'} sent the plan back: ${line(p.why)}`;
  }
  const posted = pay<{ held: boolean; decision: string | null }>(e);
  const after = rest.slice(first + 1);
  if (posted.held) {
    const d = after.find((x) => x.type === 'plan.decided' && pay<{ decision: string }>(x).decision === posted.decision);
    if (!d) return null;
    const p = pay<{ answer: string; by: string; note: string }>(d);
    if (p.answer === 'reject') return `@${p.by} rejected the plan at the plan gate`;
    if (p.answer === 'revise') return `@${p.by} sent the plan back at the plan gate for a revision${p.note ? `: ${line(p.note)}` : ''}`;
  }
  const o = after.find((x) => x.type === 'plan.objected');
  if (!o) return null;
  const p = pay<{ by: string; why: string }>(o);
  return `@${p.by} objected to the plan while it was built: ${line(p.why)}`;
}

/** The plan a worker run was built from: the latest posted before it, if it was built at once or approved; else null. */
function builtPlan(before: TraceEvent[]): Record<string, unknown> | null {
  const i = before.findLastIndex((e) => e.type === 'plan.posted');
  if (i < 0) return null;
  const p = pay<{ plan: Record<string, unknown>; held: boolean; decision: string | null }>(before[i]!);
  const approved = before.slice(i + 1).some((e) => e.type === 'plan.decided' && pay<{ decision: string; answer: string }>(e).decision === p.decision && pay<{ answer: string }>(e).answer === 'approve');
  return p.held && !approved ? null : p.plan;
}

/** Whether the plan names a test file anywhere: its path, its file name, or its name before the first dot. */
function mentions(plan: Record<string, unknown>, test: string): boolean {
  const text = JSON.stringify(plan).toLowerCase();
  const base = test.split('/').at(-1)!.toLowerCase();
  return [test.toLowerCase(), base, base.split('.')[0]!].some((n) => n !== '' && text.includes(n));
}

/**
 * A worker run whose checks failed, where every failing check is one of the issue's done_when test files that the
 * plan it was built from never names (its approach, steps, acceptance, files or risks). A check that couldn't run,
 * a failing check that isn't a done_when test, or a plan that names the test: not this.
 */
function omittedTest(f: FailedRun, t: RunTrace): string | null {
  const tests = (f.doneWhenTests ?? []).map((x) => x.trim()).filter(Boolean);
  if (f.ended !== 'checks failed' || !tests.length) return null;
  const plan = builtPlan(t.before);
  if (!plan) return null;
  const result = t.during.find((e) => e.type === 'check.result' && pay<{ stage: string }>(e).stage === 'verify');
  const failing = (result ? pay<{ checks: { check: string; status: string }[] }>(result).checks : []).filter((c) => c.status !== 'pass' && c.status !== 'skipped');
  if (!failing.length || failing.some((c) => c.status !== 'fail')) return null;
  const omitted: string[] = [];
  for (const c of failing) {
    const test = tests.find((x) => c.check.includes(x));
    if (!test || mentions(plan, test)) return null;
    if (!omitted.includes(test)) omitted.push(test);
  }
  return `the plan never names ${omitted.join(', ')}, the done_when test${omitted.length > 1 ? 's' : ''} that failed`;
}

/**
 * The evaluator's last verdict in the run's trace, against what happened to that same head afterwards. Passed, and
 * the PR's checks then failed on that head (a check that also passed on that head is flaky, not evidence); or
 * rejected, and that head then merged and the default branch's checks on the merge stayed green.
 */
function reviewEvidence(t: RunTrace): string | null {
  const i = t.during.findLastIndex((e) => e.type === 'eval.verdict');
  if (i < 0) return null;
  const v = pay<{ head: string; patch_correct: boolean; confidence: string }>(t.during[i]!);
  const after = t.during.slice(i + 1);
  if (v.patch_correct) {
    const statuses = after.filter((e) => e.type === 'pr.status' && pay<{ head: string }>(e).head === v.head).map((e) => pay<{ checks: { name: string; outcome: string }[] }>(e).checks);
    const failed = new Set(statuses.flatMap((cs) => cs.filter((c) => c.outcome === 'fail').map((c) => c.name)));
    for (const cs of statuses) for (const c of cs) if (c.outcome === 'pass') failed.delete(c.name);
    if (!failed.size) return null;
    return `the evaluator passed ${short(v.head)} (confidence ${v.confidence}); the PR's checks then failed on that same head: ${[...failed].join(', ').slice(0, 160)}`;
  }
  const merged = after.find((e) => e.type === 'merge.done' && pay<{ head: string }>(e).head === v.head);
  if (!merged) return null;
  const number = pay<{ number: number }>(merged).number;
  const main = after.find((e) => e.type === 'merge.main_result' && pay<{ number: number }>(e).number === number);
  if (!main || pay<{ outcome: string }>(main).outcome !== 'green') return null;
  return `the evaluator rejected ${short(v.head)}; that same head merged as #${number} and the default branch's checks stayed green`;
}

/**
 * plan or review, set by code from the run's trace, or null when the trace doesn't show it (then the label is
 * whatever it would have been). plan: a planner run whose plan the plan gate turned down (plannerEvidence), or a
 * worker run whose failing checks are all done_when tests its plan never names (omittedTest). review: a worker run
 * whose evaluator passed a head that then failed the PR's checks, or rejected a head that then merged green
 * (reviewEvidence). Evidence for both is ambiguous: null.
 */
export function traceStage(f: FailedRun): { stage: 'plan' | 'review'; reason: string } | null {
  const t = f.trace;
  if (!t) return null;
  const plan = f.role === 'planner' ? plannerEvidence(t) : f.role === 'worker' ? omittedTest(f, t) : null;
  const review = f.role === 'worker' ? reviewEvidence(t) : null;
  if (plan && review) return null;
  if (plan) return { stage: 'plan', reason: plan };
  if (review) return { stage: 'review', reason: review };
  return null;
}

/** A run only a trace label can label (a planner run, or a worker run whose change was proposed): never the judge's. */
export function traceOnly(f: Pick<FailedRun, 'role' | 'ended'>): boolean {
  return f.role !== 'worker' || TRACE_ONLY_OUTCOMES.has(f.ended);
}

const MAX_INPUT = 12_000;

export function stagePrompt(f: FailedRun): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);
  return [
    'Label the EARLIEST stage at which this agent run went wrong. Pick exactly one stage:',
    ...JUDGE_STAGES.map((s) => `- ${s}: ${STAGE_HINTS[s]}`),
    'Give a one-line reason that names the evidence (a step, a file, a check). Judge only from what is below;',
    'if the record does not show it, say so in the reason rather than guess.',
    '',
    `Run ${f.run} (${f.role}${f.issue !== null ? `, issue #${f.issue}` : ''}), ended: ${f.ended}`,
    `Why it was a failure: ${clip(f.why, 1500)}`,
    '',
    'Steps:',
    clip(f.steps, MAX_INPUT),
    '',
    `Final message: ${clip(f.final, 1500)}`,
  ].join('\n');
}

export interface LabelOptions {
  runner: AgentRunner;
  model?: string;
  route?: RunRequest['route'];
  cwd: string;
  /** Called before each judge call: false means the day's cap is reached and no call is made. */
  allowed: () => boolean;
  /** Each call's estimated cost, to count against the cap. */
  onCost?: (usd: number) => void;
}

/** A code label when the facts give one; otherwise one judge call. Null when the cap stops it or the answer isn't a valid label. */
export async function labelFailedRun(f: FailedRun, o: LabelOptions): Promise<StageLabel | null> {
  const traced = traceStage(f);
  // A planner run or a proposed change: labelled only from its trace, and not at all if the harness also failed it.
  if (traceOnly(f)) return traced && !harnessStage(f) ? { run: f.run, ...traced, by: 'code', costUsd: 0 } : null;
  // The existing code labels come first and are never replaced; then the trace's; then the judge.
  const known = codeStage(f) ?? traced;
  if (known) return { run: f.run, ...known, by: 'code', costUsd: 0 };
  if (!o.allowed()) return null;
  const req: RunRequest = {
    role: 'stage-judge',
    prompt: stagePrompt(f),
    cwd: o.cwd,
    model: o.model ?? 'sonnet',
    ...(o.route ? { route: o.route } : {}),
    allowedTools: [],
    disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep', 'Task'],
    maxTurns: 2,
    maxBudgetUsd: 0.5,
    jsonSchema: STAGE_SCHEMA,
    stallMs: 5 * 60_000,
    timeoutMs: 10 * 60_000,
  };
  const r = await o.runner.run(req);
  o.onCost?.(r.costUsd);
  const s = r.structured as { stage?: unknown; reason?: unknown } | undefined;
  if (r.reason !== 'succeeded' || !s || !(JUDGE_STAGES as readonly unknown[]).includes(s.stage)) return null;
  return { run: f.run, stage: s.stage as Stage, reason: String(s.reason ?? '').slice(0, 300), by: 'judge', costUsd: r.costUsd };
}

/** Label a batch, oldest first. Once the cap is reached, runs that need the judge are left unlabelled; code labels still apply. */
export async function labelFailedRuns(runs: FailedRun[], o: LabelOptions): Promise<StageLabel[]> {
  const out: StageLabel[] = [];
  for (const f of runs) {
    const l = await labelFailedRun(f, o);
    if (l) out.push(l);
  }
  return out;
}

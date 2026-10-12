// The earliest failed stage of a failed or rejected run, for the weekly failure-mode report (grouped by stage and
// instance); a label never changes anything by itself. Two labels are facts the harness already has, so code sets
// them and no model is asked: environment/harness when the run has a startup-failure, transient-retry, stuck or
// console-stop event, and verification when the run never ran any of its done_when commands. The judge can neither
// set nor clear those. Every other failed run gets one cheap judge call; it may still say verification for a run
// that ran its checks but misread or ignored the results. The judge reads only the run's redacted record, never the
// repo or the web, and every call counts against the day's cap.
import type { DoneWhenList } from './backlog/types.js';
import type { AgentRunner, RunRequest } from './runner.js';

export const STAGES = ['wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification', 'environment/harness'] as const;
export type Stage = (typeof STAGES)[number];

/** The labels the judge picks from. environment/harness is code's alone; verification is the judge's only for a run that ran its checks. */
export const JUDGE_STAGES = ['wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification'] as const satisfies readonly Stage[];

export const STAGE_HINTS: Record<Stage, string> = {
  'wrong files': 'it changed files that are not where the problem is',
  'right files, wrong place': 'the right files, but the change is in the wrong function or lines',
  'wrong or incomplete change': 'the right place, but the change is wrong or only part of what was needed',
  verification: 'it ran the checks but misread or ignored what they said',
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

/** The label code sets without a judge call, or null when the judge has to decide. */
export function codeStage(f: FailedRun): { stage: Stage; reason: string } | null {
  const harness = f.events.find((e) => (HARNESS_EVENTS as readonly string[]).includes(e));
  if (harness) return { stage: 'environment/harness', reason: `the run has a ${harness} event` };
  if (f.ended === 'startup failure') return { stage: 'environment/harness', reason: 'the run never got to work (startup failure)' };
  if (f.doneWhen.length && !ranDoneWhen(f.doneWhen, f.commands)) return { stage: 'verification', reason: "the run didn't run any of the issue's done_when commands" };
  return null;
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
  const known = codeStage(f);
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

// Tiered evaluation, wired: which model judges a change, the one escalation to the stronger model, and the
// files the judging run actually read (from its run record, never from its own list). The decisions are pure
// (src/eval-routing.ts, src/unread.ts); this runs them around the evaluator's run.
import { evaluatorModel, routingLevel, shouldEscalate, type EvalRouting, type Verdict } from '../eval-routing.js';
import { computeLevel, type ChangeFile, type Level, type LockScope } from '../review.js';
import type { ReviewConfig } from '../config/schema.js';
import { readRun } from '../run-record.js';
import type { RunResult } from '../runner.js';
import { unreadFiles } from '../unread.js';

/** run.cost roles: the evaluator's first run, and its escalation to the stronger model. */
export const EVAL_COST_ROLE = 'evaluator-verdict';
export const ESCALATED_COST_ROLE = 'evaluator-escalated';

/**
 * The level a change routes at, before any verdict: its review level from the files and labels (a comment-only
 * change routes as L0), raised to L2 by a tamper flag. A level that can't be computed routes to the strong model.
 */
export function evalLevel(o: { files: ChangeFile[]; labels: string[]; moneyPaths: () => RegExp[]; review: ReviewConfig; tampered: string[]; scope: LockScope | undefined }): Level {
  let level: Level;
  try {
    level = computeLevel({ files: o.files, labels: o.labels, moneyPaths: o.moneyPaths(), scope: o.scope }, o.review).level;
  } catch {
    return 'L3';
  }
  level = routingLevel(level, o.files.map((f) => ({ path: f.path, addedLines: f.addedLines ?? [], removedLines: f.removedLines ?? [] })));
  return o.tampered.length && (level === 'L0' || level === 'L1') ? 'L2' : level;
}

export interface JudgeRun {
  r: RunResult;
  /** Its run record's id (null when nothing was recorded). */
  runId: string | null;
}

export interface Judged extends JudgeRun {
  model: string;
  /** The cheap model whose verdict went to the stronger one, if it did. */
  escalatedFrom: string | null;
  /** Changed files the deciding run never read, from its record. */
  unread: string[];
}

/** Changed files a run never read, from its record; a run with no record read nothing. */
export function unreadByRun(stateDir: string, runId: string | null, changed: string[]): string[] {
  return unreadFiles(changed, runId ? readRun(stateDir, runId) : null);
}

/**
 * Judge a change: the model for its level first; a verdict from the cheap model that isn't a confident,
 * fully read pass goes once to the stronger model, whose verdict is final. `run` starts one evaluator run
 * with a model and the run.cost role to book it under.
 */
export async function judge(o: {
  level: Level;
  strongModel: string;
  routing: EvalRouting;
  changed: string[];
  stateDir: string;
  run: (model: string, costRole: string) => Promise<JudgeRun>;
  verdictOf: (r: RunResult) => Verdict | null;
}): Promise<Judged> {
  const first = evaluatorModel(o.level, o.strongModel, o.routing);
  const a = await o.run(first, EVAL_COST_ROLE);
  const unread = unreadByRun(o.stateDir, a.runId, o.changed);
  const v = o.verdictOf(a.r);
  // A pass that left a changed file unread is not a confident pass.
  const verdict = v && unread.length ? { ...v, confidence: 'low' as const } : v;
  if (!shouldEscalate({ usedModel: first, strongModel: o.strongModel, verdict, escalated: false, routing: o.routing })) return { ...a, model: first, escalatedFrom: null, unread };
  const b = await o.run(o.strongModel, ESCALATED_COST_ROLE);
  return { ...b, model: o.strongModel, escalatedFrom: first, unread: unreadByRun(o.stateDir, b.runId, o.changed) };
}

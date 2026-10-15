// The coordinator's side of "Hey Siri, ask" (src/siri/ask.ts): take each spoken question the dashboard left, answer
// it with a tool-less run in the research lane from a viewer's view of the instance, and write the spoken answer.
// Within Siri's own daily cap (intake.yaml siri.ask_max_usd_per_day) and the instance's daily budget. One at a time.
// Nothing here files, answers, changes or starts anything else: the run's one string is all that is read from it.
import { join } from 'node:path';
import { writeBundle } from '../bundle.js';
import type { EventLog } from '../events/log.js';
import type { IntakeConfig } from '../intake/report.js';
import { RESEARCH_DIR } from '../research.js';
import type { AgentRunner, RunResult } from '../runner.js';
import { pruneSiriAnswers, SIRI_ROLE, siriAskRun, takeSiriRequests, viewerState, writeSiriAnswer, type SiriRequest } from '../siri/ask.js';

export const SIRI_OFF = 'Siri is off for this instance.';
export const SIRI_CAPPED = "I've reached today's limit for questions. Try again tomorrow.";
export const SIRI_BUDGET = "Today's budget is spent, so I can't answer now.";
export const SIRI_FAILED = "I couldn't answer that just now.";
export const SIRI_PAUSED = "The agents are paused right now, so I can't answer.";

export interface SiriDeps {
  stateDir: string;
  instance: string;
  log: EventLog;
  runner: AgentRunner;
  intake: () => IntakeConfig | null;
  /** The instance root, beside the checkout (where the research lane's bundles go), and the agents' group. */
  instanceRoot: string;
  gid: number;
  /** What's left of today's budget. */
  budgetLeft: () => number;
  /** Why no run may start now (stopped, usage limit, sign-in held, disk), or null. */
  held: () => string | null;
  /** Record the run's cost (run.cost, role siri). */
  cost: (r: RunResult) => void;
  now?: () => Date;
}

/** USD spent today (UTC) on Siri answers, from the log. */
export function siriSpentToday(log: EventLog, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return log
    .read(0, ['run.cost'])
    .filter((e) => e.ts.startsWith(day) && (e.payload as { role: string }).role === SIRI_ROLE)
    .reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
}

export async function answerSiri(d: SiriDeps, q: SiriRequest): Promise<void> {
  const refuse = (text: string) => writeSiriAnswer(d.stateDir, q, { refused: text });
  const cfg = d.intake();
  if (!cfg?.siri.enabled) return refuse(SIRI_OFF);
  const held = d.held();
  if (held) return refuse(SIRI_PAUSED);
  const cap = cfg.siri.ask_max_usd_per_day;
  const capLeft = cap - siriSpentToday(d.log, d.now?.() ?? new Date());
  if (capLeft <= 0) return refuse(SIRI_CAPPED);
  const left = d.budgetLeft();
  if (left <= 0) return refuse(SIRI_BUDGET);
  // An empty working directory in the research lane: the run has nothing to read, and no tool to read with.
  const bundleDir = writeBundle(join(d.instanceRoot, RESEARCH_DIR), `siri-${q.id}`, d.gid, { 'README.md': 'Nothing here: everything this run knows is in its prompt.\n' });
  const spec = siriAskRun({ bundleDir, model: cfg.siri.ask_model, state: viewerState(d.log.read(), d.instance), question: q.question, maxBudgetUsd: Math.max(0.01, Math.min(0.25, capLeft, left)) });
  let r: RunResult;
  try {
    r = await d.runner.run({ ...spec, stateDir: d.stateDir, route: { kind: 'other', fallback: cfg.siri.ask_model } });
  } catch {
    return refuse(SIRI_FAILED);
  }
  d.cost(r);
  const answer = (r.structured as { answer?: unknown } | undefined)?.answer;
  if (r.reason !== 'succeeded' || typeof answer !== 'string' || !answer.trim()) return refuse(SIRI_FAILED);
  writeSiriAnswer(d.stateDir, q, { answer });
}

/** Every question waiting, one at a time (the returned promise is the queue's end). */
export function siriPass(d: SiriDeps, queue: Promise<void>): Promise<void> {
  let q = queue;
  for (const r of takeSiriRequests(d.stateDir)) q = q.then(() => answerSiri(d, r)).catch(() => refuseQuietly(d, r));
  pruneSiriAnswers(d.stateDir);
  return q;
}

function refuseQuietly(d: SiriDeps, r: SiriRequest) {
  try {
    writeSiriAnswer(d.stateDir, r, { refused: SIRI_FAILED });
  } catch {
    // the answer stays pending; the Shortcut gives up on its own
  }
}

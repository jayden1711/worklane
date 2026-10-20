// Issue #739, a server's first hour after the coordinator runs, read from the instance's own event log (read-only):
// - the first task: a writer's issue with the ready label and a done_when block, as the coordinator itself judged it;
// - the first PR: until the instance opened one (or landed a change directly), a step marked `after: 'first-pr'` (the
//   engine updater) is listed and counted, but doesn't block the way to the first task.
// It only reads: it never writes the log, the updater's files or anything else.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from './events/read-only.js';
import type { Detected, SetupStep, StepView } from './setup-steps.js';

/** The coordinator's event log in an instance's (or checkout's) state directory. */
export const eventsFile = (stateDir: string) => join(stateDir, 'events.db');

/**
 * WHY: the coordinator's `why` for a writer's issue (src/backlog/types.ts actionable()). Every other way it takes an
 * issue (the App's canary, a goal's child, an automation's or an optimization pass's issue, the fix-forward task) says
 * something else, so none of those counts as a first task. test/server-first-hour.test.ts holds the two together.
 */
const WRITERS_ISSUE = /^(?:opened by writer|ready added by writer) \S/;

type LogRead<T> = { kind: 'none' } | { kind: 'read'; value: T } | { kind: 'error'; why: string };

/**
 * Run one read against the log. No log at all (ENOENT): the coordinator hasn't run yet. Any other failure (a state
 * directory this user can't look into, a file that isn't a database): an error, never read as "no log".
 */
function readLog<T>(stateDir: string, read: (q: (sql: string) => unknown[]) => T): LogRead<T> {
  const file = eventsFile(stateDir);
  try {
    statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'error', why: (e as Error).message.split('\n')[0] ?? 'unreadable' };
  }
  try {
    const db = openReadOnly(file);
    try {
      return { kind: 'read', value: read((sql) => db.prepare(sql).all()) };
    } finally {
      db.close();
    }
  } catch (e) {
    return { kind: 'error', why: (e as Error).message.split('\n')[0] ?? 'unreadable' };
  }
}

/** The server's first-task step: done once the coordinator saw a writer's ready issue with a done_when block. */
export function detectWriterTask(stateDir: string): Detected {
  const r = readLog(stateDir, (q) => {
    for (const row of q("SELECT payload FROM events WHERE type = 'issue.seen' ORDER BY id") as { payload: string }[]) {
      const p = JSON.parse(row.payload) as { issue?: unknown; labels?: unknown; actionable?: unknown; why?: unknown };
      // `actionable` is the coordinator's verdict with its contract check (a parsed done_when block) folded in.
      if (p.actionable === true && Array.isArray(p.labels) && p.labels.includes('ready') && typeof p.why === 'string' && WRITERS_ISSUE.test(p.why)) return { issue: p.issue, why: p.why };
    }
    return null;
  });
  if (r.kind === 'none') return { done: false, detail: "the coordinator hasn't written its event log yet: it sees issues once it runs" };
  if (r.kind === 'error') return { done: false, detail: `couldn't read the coordinator's event log (${eventsFile(stateDir)}): ${r.why}` };
  if (!r.value) return { done: false, detail: "no writer's issue with the ready label and a done_when block yet, as the coordinator sees them (an issue the App opened doesn't count)" };
  return { done: true, detail: `#${String(r.value.issue)}: ${r.value.why}; the coordinator takes it` };
}

/** Whether the instance has opened its first PR (or landed a change directly); an error when the log can't tell. */
export function firstPr(stateDir: string): { shipped: boolean } | { error: string } {
  const r = readLog(stateDir, (q) => q("SELECT 1 FROM events WHERE type = 'pr.opened' OR (type = 'land.result' AND json_extract(payload, '$.outcome') IN ('landed', 'pr_opened')) LIMIT 1").length > 0);
  if (r.kind === 'none') return { shipped: false };
  if (r.kind === 'error') return { error: r.why };
  return { shipped: r.value };
}

/**
 * Before the first PR, a step the registry marks `after: 'first-pr'` blocks nothing: it is shown as optional, its
 * detail saying why. Once a PR exists, or when the log can't tell (fail closed), it stays required, as before. A step
 * that is done or skipped is left as it is, and the log is read only when one needs it.
 */
export function deferUntilFirstPr(steps: StepView[], registry: readonly Pick<SetupStep, 'id' | 'after'>[], stateDir: string): void {
  const later = new Set(registry.filter((s) => s.after === 'first-pr').map((s) => s.id));
  const pending = steps.filter((s) => later.has(s.id) && !s.optional && !s.done && !s.skipped);
  if (!pending.length) return;
  const pr = firstPr(stateDir);
  for (const s of pending) {
    if ('error' in pr) s.detail = `${s.detail} (couldn't tell whether the first PR exists, so it counts as required: ${pr.error})`;
    else if (!pr.shipped) {
      s.optional = true;
      s.detail = `after your first PR: ${s.detail}. Not needed for the first task; set it up before this machine runs unattended for long`;
    }
  }
}

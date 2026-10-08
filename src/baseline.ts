// The baseline gate: main is allowed to be red, but a change may not add red.
// main's failing set is recorded from a run at a known commit; a run then
// passes the gate if every failure it shows was already failing on main.
// A run that fails without a parsable failure list never passes: unknown red
// is red.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { EventLog } from './events/log.js';

export interface FailureFormat {
  /** Regex for the line that starts the failure list. */
  section: string;
  /** Regex with one capture group: a failing test or suite name. */
  item: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Failing names in a run's output, or null when the output has no failure section. */
export function parseFailures(output: string, fmt: FailureFormat): string[] | null {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const section = new RegExp(fmt.section);
  const item = new RegExp(fmt.item);
  const start = lines.findIndex((l) => section.test(l));
  if (start < 0) return null;
  const names = new Set<string>();
  for (const l of lines.slice(start + 1)) {
    const m = l.match(item);
    if (m?.[1]) names.add(m[1].trim());
  }
  return [...names].sort();
}

export interface Baseline {
  sha: string;
  failing: string[];
  recordedAt: string;
}

export function latestBaseline(log: EventLog): Baseline | null {
  const e = log.read(0, ['baseline.recorded']).at(-1);
  if (!e) return null;
  const p = e.payload as { sha: string; failing: string[] };
  return { sha: p.sha, failing: p.failing, recordedAt: e.ts };
}

export type GateVerdict =
  | { outcome: 'pass'; preexisting: string[]; note: string }
  | { outcome: 'fail'; newFailures: string[]; note: string };

export function baselineGate(exitCode: number | null, output: string, fmt: FailureFormat | undefined, baseline: Baseline | null): GateVerdict {
  if (exitCode === 0) return { outcome: 'pass', preexisting: [], note: 'all green' };
  if (exitCode === null) return { outcome: 'fail', newFailures: [], note: 'the test run did not finish (timeout or could not start)' };
  if (!fmt) return { outcome: 'fail', newFailures: [], note: `exit ${exitCode}; tests.yaml has no failures format, so failures can't be compared with the baseline` };
  const failing = parseFailures(output, fmt);
  if (!failing?.length) return { outcome: 'fail', newFailures: [], note: `exit ${exitCode} with no parsable failure list; unknown red is red` };
  if (!baseline) return { outcome: 'fail', newFailures: failing, note: `no baseline recorded; ${failing.length} failure(s) can't be compared` };
  const known = new Set(baseline.failing);
  const fresh = failing.filter((f) => !known.has(f));
  if (fresh.length) return { outcome: 'fail', newFailures: fresh, note: `${fresh.length} new failure(s) not in main's baseline (${baseline.sha.slice(0, 8)})` };
  return { outcome: 'pass', preexisting: failing, note: `no new failures; ${failing.length} already failing on main (${baseline.sha.slice(0, 8)})` };
}

export function recordBaseline(log: EventLog, actor: string, sha: string, exitCode: number | null, output: string, fmt: FailureFormat | undefined): { ok: true; failing: string[] } | { ok: false; why: string } {
  if (exitCode === null) return { ok: false, why: 'the run did not finish' };
  let failing: string[] = [];
  if (exitCode !== 0) {
    if (!fmt) return { ok: false, why: 'tests.yaml has no failures format' };
    const parsed = parseFailures(output, fmt);
    if (!parsed?.length) return { ok: false, why: `exit ${exitCode} with no parsable failure list; not recording an unknown baseline` };
    failing = parsed;
  }
  log.append('baseline.recorded', { sha, failing }, actor);
  return { ok: true, failing };
}

/** The latest baseline straight from an events database, read-only (for hooks; never creates the file). */
export function readBaseline(dbPath: string): Baseline | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const r = db.prepare("SELECT ts, payload FROM events WHERE type = 'baseline.recorded' ORDER BY id DESC LIMIT 1").get() as { ts: string; payload: string } | undefined;
    if (!r) return null;
    const p = JSON.parse(r.payload) as { sha: string; failing: string[] };
    return { sha: p.sha, failing: p.failing, recordedAt: r.ts };
  } finally {
    db.close();
  }
}

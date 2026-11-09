// Shadow runs (docs/shadow-runs.md): a candidate engine runs the same tasks as the current one, with no side effects,
// and the two runs' decisions are compared.
//   - The runs are harness-eval replays (src/harness-evals/replay.ts): each task goes through the real coordinator in
//     a scratch instance, on a scratch clone pushed to a local bare remote, with a file backlog: nothing reaches
//     GitHub, no real branch is pushed and nothing is merged. `harness-eval run --keep-logs <dir>` keeps each replay's
//     event log as <dir>/<task>-<sample>.db (a held-out task under a hash, never its id).
//   - `shadow diff --current <dir> --candidate <dir>` reads both directories read-only and compares, per log, the
//     decision trace: what the coordinator decided, in order, with ids, times, hashes, paths and numbers taken out, so
//     only a change in a decision shows.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import type { StoredEvent } from './events/types.js';
import { readEvents } from './events/read-only.js';

/** A reason with what differs run to run taken out: paths in parentheses, hex hashes, numbers. */
export const normalizeReason = (s: string): string =>
  s
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\b[0-9a-f]{7,64}\b/g, '<sha>')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();

/** One event as a decision, or null when it decides nothing. */
export function decisionOf(e: StoredEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  const reasons = (xs: unknown) => (Array.isArray(xs) ? [...new Set(xs.map((x) => normalizeReason(String(x))))].sort().join('; ') : '');
  switch (e.type as string) {
    case 'issue.claimed':
      return 'claimed';
    case 'decision.asked':
      return `asked the owner: ${String(p.kind)}`;
    case 'review.level_set':
      return `review level ${String(p.level)}`;
    case 'eval.verdict':
      return `evaluator: patch ${p.patch_correct ? 'correct' : 'not correct'}, test ${p.test_correct ? 'correct' : 'not correct'}, confidence ${String(p.confidence)}`;
    case 'merge.decided':
      return p.auto ? 'merge: auto' : `merge: waits (${reasons(p.reasons)})`;
    case 'merge.stopped':
      return `auto-merge stopped${p.by ? ` (${String(p.by)})` : ''}`;
    case 'land.queued':
      return `land queued at ${String(p.level)}`;
    case 'land.result':
      return `land: ${String(p.outcome)}`;
    case 'issue.blocked':
      return `blocked: ${normalizeReason(String(p.why))}`;
    case 'guardrail.decision':
      return `guardrail ${String(p.decision)}: ${String(p.rule)}`;
    case 'run.finished':
      return `${String(p.role)} run: ${String(p.reason)}`;
    case 'testrun.fault':
      return `machine fault: ${String(p.fault)}`;
    default:
      return null;
  }
}

export const decisionTrace = (events: readonly StoredEvent[]): string[] => events.map(decisionOf).filter((d): d is string => d !== null);

/** The two traces' difference, as unified-diff-like lines (`  ` same, `- ` only current, `+ ` only candidate); [] when equal. */
export function diffTraces(current: readonly string[], candidate: readonly string[]): string[] {
  // Longest common subsequence: short traces (tens of decisions), so the table is small.
  const n = current.length;
  const m = candidate.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = current[i] === candidate[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && current[i] === candidate[j]) {
      out.push(`  ${current[i]}`);
      i++;
      j++;
    } else if (j < m && (i === n || t[i]![j + 1]! >= t[i + 1]![j]!)) out.push(`+ ${candidate[j++]}`);
    else out.push(`- ${current[i++]}`);
  }
  return out.some((l) => !l.startsWith('  ')) ? out : [];
}

export interface ShadowReport {
  same: string[];
  differ: { log: string; diff: string[] }[];
  /** Logs in one directory and not the other. */
  onlyCurrent: string[];
  onlyCandidate: string[];
}

const logsIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.db')).sort();

export function shadowDiff(o: { current: string; candidate: string; read?: (db: string) => StoredEvent[] }): ShadowReport {
  const read = o.read ?? readEvents;
  const a = logsIn(o.current);
  const b = logsIn(o.candidate);
  const r: ShadowReport = { same: [], differ: [], onlyCurrent: a.filter((f) => !b.includes(f)), onlyCandidate: b.filter((f) => !a.includes(f)) };
  for (const f of a.filter((x) => b.includes(x))) {
    const diff = diffTraces(decisionTrace(read(join(o.current, f))), decisionTrace(read(join(o.candidate, f))));
    if (diff.length) r.differ.push({ log: f, diff });
    else r.same.push(f);
  }
  return r;
}

const USAGE = `usage: ${BRAND.cli} shadow diff --current <dir> --candidate <dir>`;

/** exit 0: every log's decisions are the same; 3: some differ (printed); 1: a directory or log can't be read; 2: usage. */
export function shadowCommand(sub: string | undefined, args: readonly string[], out: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 || args.lastIndexOf(name) !== i ? null : (args[i + 1] ?? null);
  };
  const current = opt('--current');
  const candidate = opt('--candidate');
  if (sub !== 'diff' || !current || !candidate || args.length !== 4) {
    err(USAGE);
    return 2;
  }
  let r: ShadowReport;
  try {
    r = shadowDiff({ current, candidate });
  } catch (e) {
    err(`can't compare: ${(e as Error).message.split('\n')[0]}`);
    return 1;
  }
  for (const d of r.differ) {
    out(`DIFFERS: ${d.log}`);
    for (const l of d.diff) out(`  ${l}`);
  }
  for (const f of r.onlyCurrent) out(`ONLY IN CURRENT: ${f}`);
  for (const f of r.onlyCandidate) out(`ONLY IN CANDIDATE: ${f}`);
  out(`${r.same.length} log(s) decided the same, ${r.differ.length} differ, ${r.onlyCurrent.length + r.onlyCandidate.length} unmatched`);
  return r.differ.length || r.onlyCurrent.length || r.onlyCandidate.length ? 3 : 0;
}

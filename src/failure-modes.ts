// How agent runs ended over a window (a week, in the reports), from the event
// log and, when given, the run records: each run is put in one outcome by what
// it and the coordinator recorded, failures are grouped by their cause (the
// error text with ids, numbers and paths taken out, so the same failure groups
// together), and a cause seen often enough gets a proposed hard fix for the
// owner to decide on. Pure: no I/O; nothing changes without the owner's answer.
import type { StoredEvent } from './events/types.js';
import type { MergeMetrics } from './merge-metrics.js';
import type { RunRecord } from './run-record.js';

export type Outcome =
  | 'startup failure'
  | 'no change'
  | 'change rejected'
  | 'checks failed'
  | 'evaluator rejected'
  | 'push refused'
  | 'timed out'
  | 'rate limited'
  | 'budget reached'
  | 'auth problem'
  | 'canceled'
  | 'failed'
  | 'proposed'
  | 'succeeded';

/** Outcomes that are not failures: they aren't counted as causes or proposed fixes. */
const OK: ReadonlySet<Outcome> = new Set(['proposed', 'succeeded']);

/** A failed run under this long that committed nothing never got to work (matches the coordinator's rule). */
export const STARTUP_SECS = 90;
/** A cause seen this many times in the window gets a proposed fix. */
export const REPEATED = 3;

export interface ClassifiedRun {
  issue: number;
  role: string;
  attempt: number | null;
  startedAt: string;
  endedAt: string;
  seconds: number;
  outcome: Outcome;
  /** Normalized: the same failure gives the same cause. */
  cause: string;
  /** The run record's id, when one matched (dashboard: /runs/<id>). */
  runId: string | null;
  /** What the coordinator did about the issue afterwards, when it gave up (the block reason). */
  blocked: string | null;
}

export interface CauseCount {
  outcome: Outcome;
  cause: string;
  count: number;
  issues: number[];
  examples: ClassifiedRun[];
}

/** A decision's options are answered by name (buttons, `decide <id> <option>`), so they're short; what each does is in the receipts. */
export const FIX_OPTIONS = ['make it impossible', 'test or lint', 'written rule', 'leave it'] as const;

export interface FailureProposal {
  /** Stable for a cause, so the same proposal isn't asked twice. */
  key: string;
  question: string;
  /** Ranked by the repo's rule: make the wrong thing impossible > a test or lint > a written rule; then leave it. */
  options: string[];
  recommendation: string;
  /** What each option would do, then the evidence: counts, example runs, what the coordinator reported. */
  receipts: string[];
}

export interface FailureModes {
  since: string;
  until: string;
  runs: ClassifiedRun[];
  byOutcome: { outcome: Outcome; count: number }[];
  top: CauseCount[];
  proposals: FailureProposal[];
}

/** Error text to a cause: ids, hashes, numbers, paths, quotes and durations out, whitespace folded. */
export function normalizeCause(text: string): string {
  const s = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~+-]+){2,}[\\/]?/g, '<path>')
    .replace(/(["'`])(?:(?!\1).){1,200}\1/g, '<…>')
    .replace(/\b\d+(?:\.\d+)?\s*(ms|s|m|h|min|sec|seconds?)\b/g, '<time>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  // An error kind with nothing after it ("error_during_execution: ") says so.
  return (s ? (s.endsWith(':') ? `${s} (no error text)` : s) : '(no error text)').slice(0, 160);
}

const at = (e: StoredEvent) => Date.parse(e.ts);
const p = <T>(e: StoredEvent) => e.payload as T;

/** The run record that belongs to a run: same issue and role, started within a minute of the run.started event. */
function matchRecord(records: RunRecord[], issue: number, role: string, startedMs: number): RunRecord | null {
  let best: RunRecord | null = null;
  let gap = 60_000;
  for (const r of records) {
    if (r.issue !== issue || r.role !== role) continue;
    const d = Math.abs(Date.parse(r.startedAt) - startedMs);
    if (d <= gap) {
      best = r;
      gap = d;
    }
  }
  return best;
}

/** Every run that ended in [since, until), in one outcome each. */
export function classifyRuns(events: StoredEvent[], since: Date, until: Date, records: RunRecord[] = []): ClassifiedRun[] {
  const out: ClassifiedRun[] = [];
  const byIssue = new Map<number, StoredEvent[]>();
  for (const e of events) {
    const n = (e.payload as { issue?: unknown }).issue;
    if (typeof n !== 'number') continue;
    (byIssue.get(n) ?? byIssue.set(n, []).get(n)!).push(e);
  }
  for (const [issue, evs] of byIssue) {
    for (let i = 0; i < evs.length; i++) {
      const fin = evs[i]!;
      if (fin.type !== 'run.finished') continue;
      const end = at(fin);
      if (end < since.getTime() || end >= until.getTime()) continue;
      const { role, reason, detail } = p<{ role: string; reason: string; detail: string }>(fin);
      // Its start: the latest run.started for the same role before it.
      let start: StoredEvent | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (evs[j]!.type === 'run.started' && p<{ role: string }>(evs[j]!).role === role) {
          start = evs[j];
          break;
        }
      }
      const startedMs = start ? at(start) : end;
      const seconds = Math.max(0, Math.round((end - startedMs) / 1000));
      // What happened to this attempt: the events after it, up to the next run of the same role.
      const after: StoredEvent[] = [];
      for (let j = i + 1; j < evs.length; j++) {
        const e = evs[j]!;
        if (e.type === 'run.started' && p<{ role: string }>(e).role === role) break;
        after.push(e);
      }
      const turns = [...evs.slice(start ? evs.indexOf(start) : i, i + 1)].reverse().find((e) => e.type === 'run.cost' && p<{ role: string }>(e).role === role);
      const nTurns = turns ? p<{ turns: number }>(turns).turns : null;
      const committed = after.some((e) => e.type === 'change.proposed' || e.type === 'push.refused');
      const nothing = after.find((e) => e.type === 'change.rejected' && /no changes committed/i.test(p<{ why: string }>(e).why));
      const startupEvent = evs.slice(start ? evs.indexOf(start) : i, i + 1 + after.length).some((e) => e.type === ('run.startup_failed' as StoredEvent['type']));
      let outcome: Outcome;
      let cause: string;
      const firstOf = <T>(type: string, ok: (x: T) => boolean = () => true) => after.find((e) => e.type === type && ok(p<T>(e)));
      if (reason === 'rate_limited') [outcome, cause] = ['rate limited', 'usage or rate limit reached'];
      else if (reason === 'timed_out') [outcome, cause] = ['timed out', 'the run hit its time limit'];
      else if (reason === 'stalled') [outcome, cause] = ['timed out', 'no output from the agent for the stall limit (stalled)'];
      else if (reason === 'budget_exhausted') [outcome, cause] = ['budget reached', 'per-run budget reached'];
      else if (reason === 'auth_mismatch') [outcome, cause] = ['auth problem', normalizeCause(detail)];
      else if (reason === 'canceled_by_reconciliation') [outcome, cause] = ['canceled', 'stopped by the coordinator'];
      else if (reason === 'failed' && !committed && (startupEvent || seconds < STARTUP_SECS)) [outcome, cause] = ['startup failure', normalizeCause(detail)];
      // Reported as a success but ended at once with nothing done: the same failure, seen from the other side.
      else if (reason === 'succeeded' && role === 'worker' && !committed && nothing && seconds < STARTUP_SECS && (nTurns ?? 0) <= 1) [outcome, cause] = ['startup failure', `ended after ${nTurns ?? 0} turn(s) with nothing done: ${normalizeCause(detail)}`];
      else if (reason === 'failed') [outcome, cause] = ['failed', normalizeCause(detail)];
      else if (role !== 'worker') [outcome, cause] = ['succeeded', ''];
      else {
        const refused = firstOf<{ reasons: string[] }>('push.refused');
        const rejected = firstOf<{ why: string }>('change.rejected');
        const checks = firstOf<{ stage: string; checks: { check: string; status: string }[] }>('check.result', (x) => x.stage === 'verify' && x.checks.some((c) => c.status !== 'pass' && c.status !== 'skipped'));
        const verdict = firstOf<{ patch_correct: boolean; confidence: string }>('eval.verdict', (x) => !x.patch_correct);
        if (refused) [outcome, cause] = ['push refused', normalizeCause(p<{ reasons: string[] }>(refused).reasons.join('; '))];
        else if (nothing || firstOf('issue.no_change')) [outcome, cause] = ['no change', nothing ? 'nothing committed' : 'the worker found no change needed'];
        else if (rejected) [outcome, cause] = ['change rejected', normalizeCause(p<{ why: string }>(rejected).why)];
        else if (checks) {
          const failing = p<{ checks: { check: string; status: string }[] }>(checks).checks.filter((c) => c.status !== 'pass' && c.status !== 'skipped');
          [outcome, cause] = ['checks failed', failing.map((c) => `${c.check}: ${c.status}`).join('; ').slice(0, 160)];
        } else if (verdict) [outcome, cause] = ['evaluator rejected', `the evaluator rejected the change (confidence ${p<{ confidence: string }>(verdict).confidence})`];
        else [outcome, cause] = ['proposed', ''];
      }
      const blockedEv = after.find((e) => e.type === 'issue.blocked');
      const rec = matchRecord(records, issue, role, startedMs);
      out.push({
        issue,
        role,
        attempt: start ? p<{ attempt: number }>(start).attempt : null,
        startedAt: new Date(startedMs).toISOString(),
        endedAt: fin.ts,
        seconds,
        outcome,
        cause,
        runId: rec?.id ?? null,
        blocked: blockedEv ? p<{ why: string }>(blockedEv).why : null,
      });
    }
  }
  return out.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
}

/** Fixes for a repeated cause, strongest first (the repo's rule: impossible > test or lint > written rule). */
function fixesFor(c: CauseCount): string[] {
  const leave = 'leave it: no change';
  switch (c.outcome) {
    case 'startup failure':
      return [
        'make it impossible: before claiming, start claude once with the exact flags a run uses (settings, schema, system prompt, worktree) and refuse to dispatch while it fails, with its error on the issue',
        'test: a regression test that starts a run with this configuration and fails on this error',
        'written rule: document the cause and its fix in the instance runbook',
        leave,
      ];
    case 'no change':
      return [
        'make it impossible: refuse issues whose done_when already passes on the base before a worker starts',
        'lint: flag issues whose done_when has no check the coordinator can run',
        'written rule: say in the issue template what a change must produce',
        leave,
      ];
    case 'checks failed':
      return [
        'make it impossible: run this check inside the worker loop (as the fast tier) so an attempt can\'t end while it fails',
        'test: give the worker a cheaper check that fails the same way, named in its brief',
        'written rule: describe the check and how to run it in the project\'s agent instructions',
        leave,
      ];
    case 'push refused':
      return [
        'make it impossible: deny writes to these paths in the worker\'s guardrails, so the change can\'t be made at all',
        'lint: a pre-commit check in the worktree that reports the limit as the agent commits',
        'written rule: list the limit in the worker\'s brief',
        leave,
      ];
    case 'timed out':
    case 'budget reached':
      return [
        'make it impossible: split issues of this kind before dispatch (size labels and slices)',
        'test: a check that flags issues likely too large before a worker starts',
        'written rule: a size guideline in the issue template',
        leave,
      ];
    case 'rate limited':
      return [
        'make it impossible: hold dispatch while the usage limit is close (governor)',
        'test: a governor test for this usage pattern',
        'written rule: lower the worker cap in the instance policy',
        leave,
      ];
    default:
      return [
        'make it impossible: change the harness so this failure can\'t happen (describe the change in the answer)',
        'test or lint: a check that catches it before a run is spent',
        'written rule: an instruction in the project\'s agent docs',
        leave,
      ];
  }
}

const label = (r: ClassifiedRun) => `#${r.issue} ${r.role}${r.attempt !== null ? ` attempt ${r.attempt}` : ''} (${r.seconds}s)`;
const link = (r: ClassifiedRun) => (r.runId ? `[${label(r)}](/runs/${r.runId})` : label(r));

export function failureModes(events: StoredEvent[], opts: { since: Date; until: Date; records?: RunRecord[] }): FailureModes {
  const runs = classifyRuns(events, opts.since, opts.until, opts.records ?? []);
  const counts = new Map<Outcome, number>();
  for (const r of runs) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const byOutcome = [...counts].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome));
  const causes = new Map<string, CauseCount>();
  for (const r of runs) {
    if (OK.has(r.outcome)) continue;
    const key = `${r.outcome}\u0000${r.cause}`;
    const c = causes.get(key) ?? causes.set(key, { outcome: r.outcome, cause: r.cause, count: 0, issues: [], examples: [] }).get(key)!;
    c.count++;
    if (!c.issues.includes(r.issue)) c.issues.push(r.issue);
    if (c.examples.length < 3) c.examples.push(r);
  }
  const ranked = [...causes.values()].sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
  const proposals = ranked
    .filter((c) => c.count >= REPEATED)
    .map((c): FailureProposal => {
      const fixes = fixesFor(c);
      const blocked = c.examples.map((r) => r.blocked).find(Boolean);
      return {
        key: `failure-mode:${c.outcome}:${c.cause}`,
        question: `Repeated failure (${c.count} runs this week, ${c.outcome}): ${c.cause}. Which fix?`,
        options: [...FIX_OPTIONS],
        recommendation: FIX_OPTIONS[0],
        receipts: [
          ...FIX_OPTIONS.map((o, i) => `${o}: ${fixes[i]!.replace(/^(make it impossible|test or lint|test|lint|written rule|leave it): /, '')}`),
          `${c.count} run(s) on issue(s) ${c.issues.map((n) => `#${n}`).join(', ')}`,
          ...c.examples.map((r) => `${label(r)}${r.runId ? `: /runs/${r.runId}` : ''}`),
          ...(blocked ? [`the coordinator then reported: ${blocked.split('\n')[0]!.slice(0, 200)}`] : []),
        ],
      };
    });
  return { since: opts.since.toISOString(), until: opts.until.toISOString(), runs, byOutcome, top: ranked.slice(0, 3), proposals };
}

/** What a cause most likely means, for the report: a sentence where the outcome alone says little. */
function explain(c: CauseCount): string | null {
  if (c.outcome === 'startup failure') {
    const secs = c.examples.map((r) => r.seconds);
    const blocked = c.examples.map((r) => r.blocked).find(Boolean);
    return `these runs ended within ${Math.max(...secs)}s with nothing committed: claude never got to work, so another attempt fails the same way${blocked ? `; the issue was then reported as "${blocked.split('\n')[0]!.slice(0, 120)}", which hides this cause` : ''}`;
  }
  if (c.outcome === 'no change') return 'the worker ended without committing anything';
  return null;
}

/** The report section: how runs ended, the most common causes with example runs, and fixes waiting for a decision. */
export function failureModesMarkdown(f: FailureModes): string[] {
  const lines: string[] = [`**How runs ended, last 7 days** (${f.runs.length} run(s))`];
  if (!f.runs.length) return [...lines, '- no runs'];
  lines.push(`- ${f.byOutcome.map((o) => `${o.outcome}: ${o.count}`).join(', ')}`);
  if (f.top.length) {
    lines.push('', '**Most common causes**');
    f.top.forEach((c, i) => {
      const why = explain(c);
      lines.push(`${i + 1}. ${c.outcome}, ${c.count}×: ${c.cause}${why ? `. ${why}` : ''}. Examples: ${c.examples.map(link).join(', ')}`);
    });
  }
  if (f.proposals.length) {
    lines.push('', `**Fixes proposed** (${f.proposals.length}, waiting for your decision; nothing changes until you answer)`);
    for (const pr of f.proposals) lines.push(`- ${pr.question.replace(/\. Which fix\?$/, '')}: recommended ${pr.receipts.find((r) => r.startsWith(`${pr.recommendation}: `)) ?? pr.recommendation}`);
  }
  return lines;
}

const mins = (n: number) => `${Math.round(n * 10) / 10} min`;

/** What conflict fixes, combined-state checks and hotspot holds cost this week, with tuning suggestions (never applied). */
export function mergeCostMarkdown(m: MergeMetrics): string[] {
  const lines: string[] = [`**Conflicts and merge waits, last 7 days** (${m.mergedPrs} merged PR(s))`];
  const { conflicts: c, lightChecks: l, holds: h } = m;
  if (!c.count && !l.count && !h.count) return [...lines, '- no conflict fixes, combined-state checks or hotspot holds'];
  lines.push(`- Conflict fixes: ${c.count} PR(s)${c.medianMinutes !== null ? `, median ${mins(c.medianMinutes)} from conflict to merged` : ''}, ${c.needOwner} needed you; ~${mins(c.perMergedPr)} per merged PR`);
  const outcomes = Object.entries(l.outcomes).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`- Combined-state checks: ${l.count}, ${mins(l.minutesAdded)} added${outcomes ? ` (${outcomes})` : ''}; ~${mins(l.perMergedPr)} per merged PR`);
  const top = h.byFile.slice(0, 3).map((f) => `${f.file} ${mins(f.minutes)}`).join(', ');
  lines.push(`- Hotspot holds: ${h.count}, ${mins(h.minutesWaited)} waited${top ? ` (most on ${top})` : ''}; ~${mins(h.perMergedPr)} per merged PR`);
  if (m.flags.length) {
    lines.push('', '**Tuning suggestions** (nothing changes unless you change the config)');
    for (const f of m.flags) lines.push(`- ${f}`);
  }
  return lines;
}

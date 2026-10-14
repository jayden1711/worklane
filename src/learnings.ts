// WHY: item 33. Notes are facts code already has (stage from codeStage, cause from normalizeCause); no agent
// writes one and no model is asked, unlike the lessons loop removed at stage 3 (docs/design.md, top note), and
// nothing reaches AGENTS.md without an owner's promote and the owner's merge.
import { fingerprint } from './corrections.js';
import { asFailedRun } from './coordinator/stage-labels.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { classifyRuns, normalizeCause, type Outcome } from './failure-modes.js';
import { MIN_SIGHTINGS } from './gardener.js';
import type { RunRecord } from './run-record.js';
import { codeStage, type Stage } from './stage-label.js';

export { MIN_SIGHTINGS };

const NOT_FAILED: ReadonlySet<Outcome> = new Set(['succeeded', 'proposed', 'canceled']);
export const AGENTS_MD = 'AGENTS.md';
export const LEARNINGS_HEADING = '## Learnings';
export const MAX_LINE = 300;

type Note = EventPayload<'learning.noted'>;

const notesIn = (events: StoredEvent[]) => events.filter((e) => e.type === 'learning.noted').map((e) => ({ at: e.ts, ...(e.payload as Note) }));

/** INVARIANT: one note per failed run (keyed by issue, role and end time), so noting a task twice adds nothing. */
export function taskNotes(events: StoredEvent[], issue: number, records: RunRecord[] = [], doneWhen: string[] = []): Note[] {
  const prior = notesIn(events);
  const noted = new Set(prior.map((n) => n.key));
  const roots = new Map<string, string>();
  for (const n of prior) if (!roots.has(n.fingerprint)) roots.set(n.fingerprint, n.same_as ?? n.key);
  const byId = new Map(records.map((r) => [r.id, r]));
  const out: Note[] = [];
  for (const c of classifyRuns(events, new Date(0), new Date(8.64e15), records)) {
    if (c.issue !== issue || NOT_FAILED.has(c.outcome)) continue;
    const key = `${issue}:${c.role}:${c.endedAt}`;
    if (noted.has(key)) continue;
    const rec = c.runId ? byId.get(c.runId) : undefined;
    const bare: RunRecord = { v: 1, id: c.runId ?? key, issue, role: c.role, model: '', startedAt: c.startedAt, endedAt: c.endedAt, reason: null, costUsd: null, turns: null, steps: [], files: [], otherTools: 0, final: '', truncated: false };
    const stage = codeStage(asFailedRun(c, rec ?? bare, events, rec ? doneWhen : []))?.stage ?? null;
    const cause = normalizeCause(c.cause || c.outcome);
    const fp = fingerprint({ text: `${c.outcome} ${cause}` });
    const root = roots.get(fp) ?? null;
    if (!root) roots.set(fp, key);
    out.push({ key, issue, role: c.role, attempt: c.attempt, run: c.runId, outcome: c.outcome, stage, cause, fingerprint: fp, same_as: root });
  }
  return out;
}

export interface LearningGroup {
  fingerprint: string;
  root: string;
  outcome: string;
  cause: string;
  count: number;
  issues: number[];
  /** WHY: code's stage when the note was made, else the weekly judge's later label for that run. */
  stages: { stage: Stage | 'unlabelled'; count: number }[];
  first: string;
  last: string;
  ready: boolean;
  line: string;
  promotion: { state: 'requested' | 'filed' | 'failed'; by: string; line: string; pr: string | null; detail: string } | null;
}

export interface LearningsView {
  minSightings: number;
  groups: LearningGroup[];
}

export function suggestedLine(g: Pick<LearningGroup, 'outcome' | 'cause' | 'count'>): string {
  return `- Seen ${g.count} times (${g.outcome}): ${g.cause}`.slice(0, MAX_LINE);
}

export function learningsView(events: StoredEvent[]): LearningsView {
  const judged = new Map<string, Stage>();
  for (const e of events) if (e.type === 'run.stage_labeled') judged.set((e.payload as EventPayload<'run.stage_labeled'>).run, (e.payload as EventPayload<'run.stage_labeled'>).stage);
  const groups = new Map<string, LearningGroup & { stageCounts: Map<string, number> }>();
  for (const n of notesIn(events)) {
    const g =
      groups.get(n.fingerprint) ??
      groups.set(n.fingerprint, { fingerprint: n.fingerprint, root: n.same_as ?? n.key, outcome: n.outcome, cause: n.cause, count: 0, issues: [], stages: [], first: n.at, last: n.at, ready: false, line: '', promotion: null, stageCounts: new Map() }).get(n.fingerprint)!;
    g.count++;
    if (!g.issues.includes(n.issue)) g.issues.push(n.issue);
    g.last = n.at;
    const stage = n.stage ?? (n.run ? judged.get(n.run) : undefined) ?? 'unlabelled';
    g.stageCounts.set(stage, (g.stageCounts.get(stage) ?? 0) + 1);
  }
  for (const e of events) {
    if (e.type !== 'learning.promote_requested' && e.type !== 'learning.promoted') continue;
    const p = e.payload as EventPayload<'learning.promote_requested'> & Partial<EventPayload<'learning.promoted'>>;
    const g = groups.get(p.fingerprint);
    if (!g) continue;
    g.promotion = e.type === 'learning.promote_requested' ? { state: 'requested', by: p.by, line: p.line, pr: null, detail: '' } : { state: p.pr ? 'filed' : 'failed', by: p.by, line: p.line, pr: p.pr ?? null, detail: p.detail ?? '' };
  }
  const out = [...groups.values()].map(({ stageCounts, ...g }) => ({
    ...g,
    stages: [...stageCounts].map(([stage, count]) => ({ stage: stage as Stage | 'unlabelled', count })).sort((a, b) => b.count - a.count),
    ready: g.count >= MIN_SIGHTINGS,
    line: suggestedLine(g),
  }));
  return { minSightings: MIN_SIGHTINGS, groups: out.sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)) };
}

/** INVARIANT: a promote names a group seen MIN_SIGHTINGS+ times, not promoted already, with one short line. */
export function promoteRefusal(view: LearningsView, fp: unknown, line: unknown): { status: 400 | 404 | 409; error: string } | null {
  if (typeof fp !== 'string' || typeof line !== 'string') return { status: 400, error: 'send the fingerprint and the line' };
  const g = view.groups.find((x) => x.fingerprint === fp);
  if (!g) return { status: 404, error: `no learning ${fp}` };
  if (!g.ready) return { status: 409, error: `seen ${g.count} time(s); a learning is promoted from ${MIN_SIGHTINGS}` };
  if (g.promotion && g.promotion.state !== 'failed') return { status: 409, error: `already promoted by @${g.promotion.by}` };
  const l = line.trim();
  if (!l || /[\r\n]/.test(l) || l.length > MAX_LINE) return { status: 400, error: `the line must be one line of 1 to ${MAX_LINE} characters` };
  return null;
}

/** INVARIANT: null when the line is in AGENTS.md already, so a retried promote never adds it twice. */
export function withLearning(md: string | null, line: string): string | null {
  const l = line.trim();
  const text = md ?? '';
  if (text.split(/\r?\n/).some((x) => x.trim() === l)) return null;
  const lines = text.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((x) => x.trim() === LEARNINGS_HEADING);
  if (at === -1) return `${text.trim() ? `${text.replace(/\s+$/, '')}\n\n` : ''}${LEARNINGS_HEADING}\n\n${l}\n`;
  let end = at + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  while (end > at + 1 && !lines[end - 1]!.trim()) end--;
  lines.splice(end, 0, ...(end === at + 1 ? [''] : []), l);
  return `${lines.join('\n')}\n`;
}

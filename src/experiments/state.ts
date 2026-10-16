// A study's state and research log, folded from its events (src/events/types.ts `experiment.*`): nothing else keeps
// any. One entry in flight at a time, one proposal per session (the first counts; a second for the same session, or
// one for a session that isn't the current one, changes nothing), and a new entry only while the study is idle.
import { best, type Decision, type Entry, type EntryKind, type Stage2 } from './keep.js';

/** An event as the fold reads it (a StoredEvent fits). */
export interface StudyEvent {
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

/** One research log entry: the fixed template's fields. */
export interface LogEntry extends Entry {
  ts: string;
  session: string;
  job: string | null;
  hypothesis: string;
  variable: string;
  motivation: string;
  expected_effect: string;
  config: Record<string, string | number>;
  commit: string | null;
  files: string[];
  approval: string[];
  gpu_minutes: number | null;
  waited_s: number | null;
  step: string | null;
  tail: string;
  why: string;
  timings: { train_ms: number; predict_ms: number; score_ms: number } | null;
}

export type Phase = 'idle' | 'session' | 'awaiting_approval' | 'queued' | 'running';

export interface StudyState {
  version: string;
  entries: LogEntry[];
  phase: Phase;
  current: number | null;
  paused: boolean;
  archived: boolean;
  /** Three jobs in a row crashed, were refused or stopped: no new entry until someone resumes the study. */
  broken: boolean;
  best: { n: number; value: number } | null;
}

export const BREAKER = 3;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function foldStudy(events: readonly StudyEvent[], study: string, version: string): StudyState {
  const entries: LogEntry[] = [];
  const byN = new Map<number, LogEntry>();
  let current: number | null = null;
  let phase: Phase = 'idle';
  let paused = false;
  let archived = false;
  let resumedAt = 0;
  for (const e of events) {
    const p = e.payload;
    if (p.study !== study) continue;
    if (e.type === 'experiment.changed') {
      const a = p.action;
      if (a === 'pause' || a === 'stop_job') paused = true;
      else if (a === 'resume' || a === 'start') {
        paused = false;
        archived = false;
        resumedAt = entries.length;
      } else if (a === 'archive') archived = true;
      continue;
    }
    if (e.type === 'experiment.verdict') {
      const x = byN.get(p.n as number);
      if (!x || x.decision !== 'held') continue;
      if (p.answer === 'accept') x.decision = x.after ?? 'keep';
      else {
        x.decision = 'discard';
        x.why = `rejected on review by ${str(p.by)}`;
      }
      continue;
    }
    if (p.version !== undefined && p.version !== version) continue;
    const n = p.n as number;
    if (e.type === 'experiment.session') {
      if (phase !== 'idle' || byN.has(n)) continue;
      const kind = p.kind as EntryKind;
      const entry: LogEntry = {
        n,
        kind,
        parent: (p.parent as number | null) ?? null,
        ...(p.of !== undefined ? { of: p.of as number } : {}),
        ...(p.arm !== undefined ? { arm: p.arm as 'candidate' | 'best' } : {}),
        ...(p.combines !== undefined ? { combines: p.combines as number } : {}),
        size: (p.size as number) ?? 0,
        seed: (p.seed as number) ?? 1,
        result: null,
        decision: 'running',
        ts: e.ts,
        session: str(p.session),
        job: null,
        hypothesis: '',
        variable: '',
        motivation: '',
        expected_effect: '',
        config: {},
        commit: null,
        files: [],
        approval: [],
        gpu_minutes: null,
        waited_s: null,
        step: null,
        tail: '',
        why: '',
        timings: null,
      };
      entries.push(entry);
      byN.set(n, entry);
      current = n;
      phase = 'session';
    } else if (e.type === 'experiment.proposed' || e.type === 'experiment.refused') {
      const entry = byN.get(n);
      if (!entry || current !== n || phase !== 'session' || entry.session !== str(p.session)) continue;
      if (e.type === 'experiment.refused') {
        entry.decision = 'refused';
        entry.why = str(p.why);
        current = null;
        phase = 'idle';
        continue;
      }
      Object.assign(entry, { job: str(p.job), hypothesis: str(p.hypothesis), variable: str(p.variable), motivation: str(p.motivation), expected_effect: str(p.expected_effect), config: (p.config as Record<string, string | number>) ?? {}, commit: str(p.commit), files: (p.files as string[]) ?? [], approval: (p.approval as string[]) ?? [] });
      phase = entry.approval.length ? 'awaiting_approval' : 'queued';
    } else if (e.type === 'experiment.approval') {
      const entry = entries.find((x) => x.job === p.job);
      if (!entry || entry.n !== current || phase !== 'awaiting_approval') continue;
      if (p.answer === 'approve') phase = 'queued';
      else {
        entry.decision = 'refused';
        entry.why = `declined by ${str(p.by)}`;
        current = null;
        phase = 'idle';
      }
    } else if (e.type === 'experiment.job_started') {
      if (current === n && phase === 'queued') phase = 'running';
    } else if (e.type === 'experiment.recorded') {
      const entry = byN.get(n);
      if (!entry || current !== n || (phase !== 'running' && phase !== 'queued')) continue;
      Object.assign(entry, { result: (p.score as number | null) ?? null, value: (p.value as number | null) ?? null, decision: p.decision as Decision, why: str(p.why), gpu_minutes: p.gpu_minutes as number, minutes: p.gpu_minutes as number, waited_s: p.waited_s as number, step: (p.step as string | null) ?? null, tail: str(p.tail), timings: (p.timings as LogEntry['timings']) ?? null });
      if (p.vs !== undefined) entry.vs = p.vs as number;
      current = null;
      phase = 'idle';
    } else if (e.type === 'experiment.judged') {
      const entry = byN.get(n);
      if (!entry) continue;
      entry.stage2 = [...(entry.stage2 ?? []), p.stage2 as Stage2];
      entry.decision = p.decision as Decision;
      entry.why = str(p.why);
      if (p.value !== undefined) entry.value = p.value as number | null;
      if (p.after !== undefined) entry.after = p.after as 'keep' | 'winner';
    }
  }
  const since = entries.slice(resumedAt).filter((x) => x.decision !== 'running');
  const tail = since.slice(-BREAKER);
  const broken = tail.length === BREAKER && tail.every((x) => x.decision === 'crash' || x.decision === 'refused' || x.decision === 'stopped');
  return { version, entries, phase, current, paused, archived, broken, best: best(entries) };
}

/** Why no new entry may start now, or null. */
export function sessionHold(s: StudyState): string | null {
  if (s.archived) return 'archived';
  if (s.paused) return 'paused';
  if (s.broken) return `${BREAKER} jobs in a row crashed, were refused or stopped: resume it to go on`;
  if (s.phase !== 'idle') return `entry #${s.current} is ${s.phase.replace('_', ' ')}`;
  const held = s.entries.find((e) => e.decision === 'held');
  if (held) return `#${held.n} waits for an owner's review`;
  return null;
}

/** The next entry's number: counted over every version of the study, so a job's id is never used twice. */
export function nextN(events: readonly StudyEvent[], study: string): number {
  let n = 0;
  for (const e of events) if (e.type === 'experiment.session' && e.payload.study === study) n = Math.max(n, e.payload.n as number);
  return n + 1;
}

/** A job's id: the study and the entry's number. */
export const jobId = (study: string, n: number) => `${study}-${n}`;

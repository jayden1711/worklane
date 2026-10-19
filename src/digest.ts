// "Waiting on you": every state that holds work until the owner acts, how long each has waited, and the
// issue or PR it's on. Read from the event log alone, as it stands now; nothing here times a hold out (a
// hold waits for the owner, and this makes sure none waits unseen). The dashboard shows the list; the
// daily digest is its Markdown, posted as a GitHub comment (`#n` and commit SHAs link themselves there).
//
// The log is folded one event at a time (waitStep), and the list is read off the fold (#633): the dashboard's event
// cache keeps the fold and steps it through only what was appended, so a read costs the new events, not the whole log.
// waitingOnYou is the same fold over the whole log, so the two can't answer differently.

import { project, type Task } from './projection.js';
import { heldUpdate, RELEASE_HOLD, updateLog, type UpdateEntry } from './updates.js';
import { batchSummaries, type BatchSummary } from './coordinator/pr-batch.js';
import type { EventSnapshot, Snapshots } from './events/cache.js';
import type { StoredEvent } from './events/types.js';
import { localDay } from './local-day.js';

interface Ev {
  type: string;
  ts: string;
  payload: unknown;
}

/** The owner-held states, in the order the digest lists them. */
export const WAIT_KINDS = [
  'emergency_halt',
  'merge_stopped',
  'main_checks_timed_out',
  'awaiting_decision',
  'plan_held',
  'needs_owner',
  'ci_fix_gave_up',
  'blocked',
  'landing_failed',
  'deploy_failed',
  'check_held',
  'hotspot_held',
  'update_held',
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export const WAIT_LABEL: Record<WaitKind, string> = {
  emergency_halt: 'Emergency stop in force',
  merge_stopped: 'Auto-merge stopped',
  main_checks_timed_out: 'Auto-merges whose checks on the default branch never reported',
  awaiting_decision: 'Decisions waiting for you',
  plan_held: 'Plans held for you',
  needs_owner: 'PRs waiting for you to review and merge',
  ci_fix_gave_up: 'CI fixes that gave up',
  blocked: 'Blocked',
  landing_failed: 'Landing failed',
  deploy_failed: 'Deploys that failed',
  check_held: 'PRs held back by a required check',
  hotspot_held: 'Tasks held behind another task (the same files, or a "Depends on")',
  update_held: 'Engine updates rolled back and held',
};

export interface WaitItem {
  kind: WaitKind;
  /** When the wait began (ISO). */
  since: string;
  issue: number | null;
  pr: number | null;
  title: string | null;
  /** Why it waits, in a line. */
  detail: string;
  /** For a PR the merge policy left to the owner: each of its reasons whole (merge.decided), one per chip on the Board. */
  reasons?: string[];
  /** For a failed deploy: the commit. */
  sha?: string;
  /** For a PR left to the owner as high-risk: each category it touches, plainly, with its first file (merge-policy.ts whyHighRisk). */
  why?: { category: string; text: string }[];
  /** For a decision or a held plan: the decision's id, so the dashboard opens its detail (/decisions/<id>). */
  decision?: string;
}

/** A PR the harness merged on its own, for the owner's morning sampling. */
export interface MergedItem {
  pr: number;
  issue: number;
  title: string;
  url: string;
  at: string;
  /** The review level of the merged head (review.level_set), or null if none was recorded. */
  level: string | null;
  /** The evaluator's confidence in its verdict on the merged head (eval.verdict), or null. */
  confidence: string | null;
}

export interface Digest {
  at: string;
  items: WaitItem[];
  /** Since when `merged` reaches: the last digest, or 24 hours back. */
  mergedSince: string;
  merged: MergedItem[];
  /** PR batches (PR mode with batching) running now or active since `mergedSince`, oldest first. */
  batches: Pick<BatchSummary, 'id' | 'status' | 'prs' | 'detail' | 'at' | 'last'>[];
}

/** The PR batches running at `now` or with a step after `since`. */
export function batchesSince(events: Ev[], since: Date, now: Date): Digest['batches'] {
  const stored = events.filter((e) => e.type === 'pr_batch.queued' || e.type === 'pr_batch.step' || e.type === 'pr.closed').map((e, i) => ({ ...e, id: i + 1 }) as unknown as StoredEvent);
  return batchSummaries(stored)
    .filter((b) => b.prs.length && Date.parse(b.at) <= now.getTime() && (b.open || Date.parse(b.last) > since.getTime()))
    .map((b) => ({ id: b.id, status: b.status, prs: b.prs, detail: b.detail, at: b.at, last: b.last }));
}

/** What mergedSince reads of the log: each issue's review levels and verdicts by head, and the auto-merges, in order. */
interface MergedFold {
  level: Map<number, { head: string; level: string }[]>;
  verdict: Map<number, { head: string; confidence: string }[]>;
  done: Ev[];
}

const mergedFold = (): MergedFold => ({ level: new Map(), verdict: new Map(), done: [] });

const append = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

function mergedStep(m: MergedFold, e: Ev) {
  const p = e.payload as Record<string, unknown>;
  if (e.type === 'review.level_set') append(m.level, Number(p.issue), { head: String(p.head), level: String(p.level) });
  if (e.type === 'eval.verdict') append(m.verdict, Number(p.issue), { head: String(p.head), confidence: String(p.confidence) });
  if (e.type === 'merge.done') m.done.push(e);
}

function mergedOf(m: MergedFold, since: Date, now: Date): MergedItem[] {
  const at = <T extends { head: string }>(xs: T[] | undefined, head: string) => (xs ? (xs.filter((x) => x.head === head).at(-1) ?? xs.at(-1)) : undefined);
  const out: MergedItem[] = [];
  for (const e of m.done) {
    const t = Date.parse(e.ts);
    if (t <= since.getTime() || t > now.getTime()) continue;
    const p = e.payload as { issue: number; number: number; head: string; title: string; url: string };
    out.push({ pr: p.number, issue: p.issue, title: p.title, url: p.url, at: e.ts, level: at(m.level.get(p.issue), p.head)?.level ?? null, confidence: at(m.verdict.get(p.issue), p.head)?.confidence ?? null });
  }
  return out;
}

/**
 * The PRs auto-merged after `since` (merge.done is the auto-merge path's), each with the review level and the
 * evaluator's confidence for the head it merged (or the issue's latest, where none matches the head).
 */
export function mergedSince(events: Ev[], since: Date, now: Date): MergedItem[] {
  const m = mergedFold();
  for (const e of events) mergedStep(m, e);
  return mergedOf(m, since, now);
}

/**
 * Every hold the log has opened and not yet ended, as of the last event folded in (waitStep), and what the list and
 * the digest read beside them. Only waitStep changes it; the list is read off it (itemsOf), never written to it.
 */
export interface WaitFold {
  /** The latest event time folded in (ms, stampOf: an unreadable one counts as passed). */
  latest: number;
  title: Map<number, string>;
  prIssue: Map<number, number>;
  closed: Set<number>;
  /** Issues closed by hand on GitHub (issue.closed), and when: a hold on one that began before then ended with it. */
  issueClosedAt: Map<number, string>;
  /** The last of emergency stop and resume, and of auto-merge stop and resume. */
  halt: Ev | null;
  stop: Ev | null;
  mainTimedOut: Map<string, { ts: string; issue: number; number: number; missing: string[] }>;
  answered: Set<string>;
  /** Decisions asked and not (yet) answered, in the order asked; a plan's is listed as its held plan. */
  asked: { ts: string; p: { id: string; issue: number | null; owner: string; question: string } }[];
  planHeld: Map<number, { ts: string; reasons: string[]; decision: string | null }>;
  needsOwner: Map<number, { ts: string; issue: number; detail: string; reasons?: string[]; why?: { category: string; text: string }[] }>;
  ciGaveUp: Map<number, { ts: string; issue: number; reason: string }>;
  blockedAt: Map<number, { ts: string; landing: boolean }>;
  deploys: Map<string, { ts: string; sha: string; why: string } | null>;
  checkHeld: Map<number, { ts: string; since: string; issue: number; head: string; held: string[] }>;
  holds: Map<number, { ts: string; by: number; files: string[] }>;
  deps: Map<number, { since: string; reason: string }>;
  merged: MergedFold;
  /** The PR batch events (and PR closes), in order, for batchesSince. */
  batch: Ev[];
}

export function waitFold(): WaitFold {
  return {
    latest: -Infinity,
    title: new Map(),
    prIssue: new Map(),
    closed: new Set(),
    issueClosedAt: new Map(),
    halt: null,
    stop: null,
    mainTimedOut: new Map(),
    answered: new Set(),
    asked: [],
    planHeld: new Map(),
    needsOwner: new Map(),
    ciGaveUp: new Map(),
    blockedAt: new Map(),
    deploys: new Map(),
    checkHeld: new Map(),
    holds: new Map(),
    deps: new Map(),
    merged: mergedFold(),
    batch: [],
  };
}

/**
 * An event's time as Waiting on you reads it (ms). WHY: an unreadable time is never after any `now`, so it counts as
 * passed: the event is read (as the projection, which reads every event, already has it), and it can't hold the cached
 * read back for the life of the process.
 */
function stampOf(e: Ev): number {
  const t = Date.parse(e.ts);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Fold one event in, after every event before it (the log's order). */
export function waitStep(f: WaitFold, e: Ev): void {
  f.latest = Math.max(f.latest, stampOf(e));
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'issue.seen':
      f.title.set(Number(p.issue), String(p.title));
      break;
    case 'issue.closed':
      f.issueClosedAt.set(Number(p.issue), e.ts);
      break;
    case 'pr.opened':
      f.prIssue.set(Number(p.number), Number(p.issue));
      break;
    case 'emergency.stop':
    case 'emergency.resume':
      f.halt = e;
      break;
    case 'merge.stopped':
    case 'merge.resumed':
      f.stop = e;
      break;
    case 'merge.main_result': {
      // An auto-merge whose required checks on the merge commit never reported: whether the default branch is green is
      // unknown until a later result for that commit (green; a red one is listed as auto-merge stopped).
      const q = p as { issue: number; number: number; sha: string; outcome: string; failed: string[] };
      if (q.outcome === 'timed_out') f.mainTimedOut.set(q.sha, { ts: e.ts, issue: q.issue, number: q.number, missing: q.failed });
      else f.mainTimedOut.delete(q.sha);
      break;
    }
    case 'decision.answered': {
      const id = String(p.id);
      f.answered.add(id);
      f.asked = f.asked.filter((a) => a.p.id !== id);
      break;
    }
    case 'decision.asked': {
      // An answer ends the decision, even one recorded before a repeat of the question.
      const q = p as { id: string; kind: string; issue: number | null; owner: string; question: string };
      if (!f.answered.has(q.id) && q.kind !== 'plan') f.asked.push({ ts: e.ts, p: q });
      break;
    }
    case 'plan.posted': {
      const q = p as { issue: number; held?: boolean; reasons?: string[]; decision?: string | null };
      if (q.held) f.planHeld.set(q.issue, { ts: e.ts, reasons: q.reasons ?? [], decision: q.decision ?? null });
      else f.planHeld.delete(q.issue);
      break;
    }
    case 'plan.decided':
      f.planHeld.delete((p as { issue: number }).issue);
      break;
    case 'merge.decided': {
      const n = Number(p.number);
      if (p.auto === false && !f.needsOwner.has(n)) f.needsOwner.set(n, { ts: e.ts, issue: Number(p.issue), detail: (p.reasons as string[]).join('; ') || 'left to you', ...((p.reasons as string[]).length ? { reasons: [...(p.reasons as string[])] } : {}), ...(Array.isArray(p.why) && p.why.length ? { why: p.why as { category: string; text: string }[] } : {}) });
      break;
    }
    case 'conflict_fix.finished': {
      const n = Number(p.number);
      if (p.outcome === 'gave_up' && p.waits_owner === true && !f.needsOwner.has(n)) f.needsOwner.set(n, { ts: e.ts, issue: Number(p.issue), detail: `conflicts with its base; no conflict fix: ${String(p.detail).split('\n')[0]!.slice(0, 160)}` });
      break;
    }
    case 'ci_fix.gave_up':
      f.ciGaveUp.set(Number(p.number), { ts: e.ts, issue: Number(p.issue), reason: String(p.reason) });
      break;
    case 'ci_fix.started':
      f.ciGaveUp.delete(Number(p.number));
      break;
    case 'pr.ready':
      f.ciGaveUp.delete(Number(p.number));
      f.checkHeld.delete((p as { number: number }).number);
      break;
    case 'issue.blocked':
      f.blockedAt.set(Number(p.issue), { ts: e.ts, landing: false });
      break;
    case 'land.result':
      if (!['landed', 'deferred', 'pr_opened'].includes(String(p.outcome))) f.blockedAt.set(Number(p.issue), { ts: e.ts, landing: true });
      break;
    case 'deploy.failed': {
      const q = p as { env: string; sha: string; why?: string };
      f.deploys.set(q.env, { ts: e.ts, sha: q.sha, why: String(q.why) });
      break;
    }
    case 'deploy.verified':
      f.deploys.set((p as { env: string }).env, null);
      break;
    case 'pr.status': {
      // A PR held back by a required check that is missing, pending or skipped, at its latest status.
      const q = p as { issue: number; number: number; head: string; ready: boolean; checks: { name: string; outcome: string }[] };
      const held = q.ready ? [] : q.checks.filter((c) => c.outcome === 'missing' || c.outcome === 'pending' || c.outcome === 'skipped').map((c) => `${c.name} ${c.outcome}`);
      const prev = f.checkHeld.get(q.number);
      if (!held.length) f.checkHeld.delete(q.number);
      // Held since the first status at this head that held it back.
      else f.checkHeld.set(q.number, { ts: e.ts, since: prev && prev.head === q.head ? prev.since : e.ts, issue: q.issue, head: q.head, held });
      break;
    }
    case 'hotspot.held': {
      const q = p as { issue: number; by?: number; files?: string[] };
      f.holds.set(q.issue, { ts: e.ts, by: Number(q.by), files: q.files ?? [] });
      break;
    }
    case 'hotspot.released':
      f.holds.delete((p as { issue: number }).issue);
      break;
    case 'dependency.held': {
      const q = p as { issue: number; reason?: string };
      f.deps.set(q.issue, { since: f.deps.get(q.issue)?.since ?? e.ts, reason: String(q.reason) });
      break;
    }
    case 'dependency.unblocked':
      f.deps.delete((p as { issue: number }).issue);
      break;
  }
  // Read by more than one view: a PR's close ends its holds and is a batch's event too; a merge is both.
  if ((e.type === 'pr.closed' || e.type === 'merge.done') && typeof p.number === 'number') f.closed.add(p.number);
  if (e.type === 'pr_batch.queued' || e.type === 'pr_batch.step' || e.type === 'pr.closed') f.batch.push(e);
  mergedStep(f.merged, e);
}

/** The list off the fold: every hold open at `now`, by kind, then the longest-waiting first. Reads `f`, never changes it. */
function itemsOf(f: WaitFold, tasks: readonly Pick<Task, 'issue' | 'status' | 'lastActivity' | 'blockedReason'>[], now: Date, updates: UpdateEntry[] | undefined): WaitItem[] {
  const t = now.getTime();
  const items: WaitItem[] = [];
  const add = (kind: WaitKind, since: string, issue: number | null, pr: number | null, detail: string, extra: Partial<WaitItem> = {}) => {
    // An issue's own hold (no PR of its own) ends when the issue is closed; one that began after it (reopened) stands.
    const closedAt = issue !== null && pr === null ? f.issueClosedAt.get(issue) : undefined;
    if (closedAt !== undefined && Date.parse(since) <= Date.parse(closedAt)) return;
    items.push({ kind, since, issue, pr, title: issue !== null ? (f.title.get(issue) ?? null) : null, detail, ...extra });
  };

  // Emergency stop and auto-merge stop: the last of stop/resume says which.
  if (f.halt?.type === 'emergency.stop') {
    const p = f.halt.payload as { by: string; reason: string };
    add('emergency_halt', f.halt.ts, null, null, `by @${p.by}: ${p.reason}`);
  }
  if (f.stop?.type === 'merge.stopped') {
    const p = f.stop.payload as { reason: string; number: number | null };
    add('merge_stopped', f.stop.ts, p.number !== null ? (f.prIssue.get(p.number) ?? null) : null, p.number, p.reason);
  }
  for (const [s, w] of f.mainTimedOut) add('main_checks_timed_out', w.ts, w.issue, w.number, `${w.missing.length ? w.missing.join(', ') : 'the required checks'} never reported on the merge commit ${s.slice(0, 12)}; check them yourself`, { sha: s });

  // Decisions not yet answered (a plan's decision is listed as the held plan, once).
  for (const { ts, p } of f.asked) add('awaiting_decision', ts, p.issue, null, `@${p.owner}: ${p.question.split('\n')[0]!.slice(0, 160)}`, { decision: p.id });
  // Plans held for the owner, until decided.
  for (const [issue, h] of f.planHeld) add('plan_held', h.ts, issue, null, h.reasons.length ? h.reasons.join('; ') : 'held for your approval', h.decision ? { decision: h.decision } : {});

  // PRs left for the owner to review and merge: not merged automatically, or a conflict fix gave up.
  for (const [n, w] of f.needsOwner) if (!f.closed.has(n)) add('needs_owner', w.ts, w.issue, n, w.detail, { ...(w.why ? { why: w.why } : {}), ...(w.reasons ? { reasons: [...w.reasons] } : {}) });
  for (const [n, w] of f.ciGaveUp) if (!f.closed.has(n)) add('ci_fix_gave_up', w.ts, w.issue, n, w.reason);

  // Blocked tasks, of either kind: blocked on someone (issue.blocked), or a landing that failed.
  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    const b = f.blockedAt.get(task.issue);
    add(b?.landing ? 'landing_failed' : 'blocked', b?.ts ?? task.lastActivity, task.issue, null, (task.blockedReason ?? '').split('\n')[0]!.slice(0, 200) || 'blocked');
  }

  // Deploys that failed, until that environment verifies a deploy again.
  for (const [env, d] of f.deploys) if (d) add('deploy_failed', d.ts, null, null, `${env}: ${d.why.split('\n')[0]!.slice(0, 160)}`, { sha: d.sha });
  for (const [n, s] of f.checkHeld) if (!f.closed.has(n)) add('check_held', s.since, s.issue, n, s.held.join(', '));

  // Tasks held behind another on a hotspot file, until released.
  for (const [issue, h] of f.holds) add('hotspot_held', h.ts, issue, null, `behind #${h.by}, on ${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ` and ${h.files.length - 3} more` : ''}`);
  // WHY: a "Depends on" hold shows beside the file holds, with its reason (src/task-graph.ts), since the first hold of that wait.
  for (const [issue, h] of f.deps) add('hotspot_held', h.since, issue, null, h.reason);

  // An engine update the machine rolled back and holds (a failed migration, or services that didn't come up):
  // the owner's, until a later install succeeds. From the machine's update log, not this instance's events.
  const held = heldUpdate((updates ?? updateLog()).filter((u) => Date.parse(u.at) <= t));
  if (held) add('update_held', held.at, null, null, `${held.reason.split('\n')[0]!.slice(0, 240)}; the commit is held until a newer one, or until an admin releases it at a root shell: ${RELEASE_HOLD}`, held.sha ? { sha: held.sha } : {});

  // By kind, then the longest-waiting first.
  items.sort((a, b) => WAIT_KINDS.indexOf(a.kind) - WAIT_KINDS.indexOf(b.kind) || a.since.localeCompare(b.since));
  return items;
}

type DigestOptions = { since?: Date; /** The machine's engine update log (updates.ts); read from its file when not given. */ updates?: UpdateEntry[] };

function digestOf(f: WaitFold, tasks: readonly Pick<Task, 'issue' | 'status' | 'lastActivity' | 'blockedReason'>[], now: Date, o: DigestOptions): Digest {
  const items = itemsOf(f, tasks, now, o.updates);
  const since = o.since ?? new Date(now.getTime() - 86_400_000);
  return { at: now.toISOString(), items, mergedSince: since.toISOString(), merged: mergedOf(f.merged, since, now), batches: batchesSince(f.batch, since, now) };
}

/**
 * Every owner-held state open at `now`. Each one starts at the event that opened it and stays until the event
 * that ends it: an answer, a merge or close, a resume, a later verified deploy, a release, a new head.
 * And the PRs merged on their own since the last digest (`since`; 24 hours back by default), for sampling.
 */
export function waitingOnYou(events: Ev[], now = new Date(), o: DigestOptions = {}): Digest {
  const k = readAt(events, events.map(stampOf), now.getTime(), localDay(now));
  return digestOf(k.f, k.tasks, now, o);
}

/**
 * The fold and the projection's tasks that a read at `t` reads: of the events whose time (`stamps`, stampOf of each,
 * in the same order) is not after it.
 */
function readAt(events: Ev[], stamps: readonly number[], t: number, day: string): { f: WaitFold; tasks: readonly Task[] } {
  const evs = events.filter((_, i) => stamps[i]! <= t);
  const f = waitFold();
  for (const e of evs) waitStep(f, e);
  return { f, tasks: project(evs as Parameters<typeof project>[0], day).tasks };
}

/**
 * What a read at `now` reads of one snapshot of the log, from what the dashboard's event cache keeps of it: the fold,
 * stepped through only what was appended since the last read, and the projection's tasks, the same fold its state
 * keeps under this key (src/dashboard.ts). Both are of the one snapshot, so an event appended meanwhile is in both or
 * in neither.
 */
function folded(s: EventSnapshot, now: Date): { f: WaitFold; tasks: readonly Task[] } {
  const t = now.getTime();
  const day = localDay(now);
  const f = s.fold('waitingOnYou', waitFold, waitStep);
  if (f.latest <= t) return { f, tasks: s.memo(`project ${day}`, (ev) => project(ev, day)).tasks };
  // WHY: some event is stamped after `now` (another clock ahead of this one), and a read at `now` leaves it out, so the
  // fold of every event can't stand for it. What it leaves out is the k latest-stamped events, so k names that read: it
  // is folded once per snapshot and k and kept, and a read costs a pass over the log only when the log changes or the
  // clock passes (or steps back over) one of those stamps, not on every read. Each event's time is read once, as it is
  // appended (a fold of its own).
  const stamps = s.fold('waitingOnYou stamps', () => [] as number[], (a, e) => void a.push(stampOf(e)));
  let k = 0;
  for (const x of stamps) if (x > t) k++;
  return s.memo(`waitingOnYou ${day} ${k}`, (ev) => readAt(ev, stamps, t, day));
}

/**
 * waitingOnYou for the log an event cache holds, from what it keeps (#633): the same answer, without reading the whole
 * log on each read. Of one snapshot: the one handed in, or the cache's as it is now.
 */
export function waitingCached(src: Snapshots, now = new Date(), o: DigestOptions = {}): Digest {
  const k = folded(src.snapshot(), now);
  return digestOf(k.f, k.tasks, now, o);
}

/** What the dashboard's state carries of Waiting on you (#633): how many things wait, and what the Needs you queue keys each by. */
export interface WaitingCount {
  count: number;
  keys: Pick<WaitItem, 'kind' | 'issue' | 'decision'>[];
}

/** waitingCached's list as the state carries it (without the merged PRs and batches the digest reads beside it). */
export function waitingCount(src: Snapshots, now = new Date(), o: Pick<DigestOptions, 'updates'> = {}): WaitingCount {
  const k = folded(src.snapshot(), now);
  const items = itemsOf(k.f, k.tasks, now, o.updates);
  return { count: items.length, keys: items.map((i) => ({ kind: i.kind, issue: i.issue, ...(i.decision !== undefined ? { decision: i.decision } : {}) })) };
}

/** How long, in words: minutes, hours, or days. */
export function waited(since: string, now: Date): string {
  const m = Math.max(0, (now.getTime() - Date.parse(since)) / 60_000);
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

/**
 * The digest as Markdown for a GitHub issue comment: a heading with the count, a section per kind, a line per
 * wait with how long it has waited and its issue or PR (`#n`, which GitHub links). Pure: same input, same text.
 */
export function digestMarkdown(d: Digest, o: { project?: string } = {}): string {
  const now = new Date(d.at);
  const head = `## Waiting on you${o.project ? `: ${o.project}` : ''}, ${d.at.slice(0, 10)} (${d.items.length})`;
  const out = [head, ''];
  out.push(d.items.length ? 'Nothing here times out: each waits until you act on it.' : 'Nothing is waiting on you.');
  for (const kind of WAIT_KINDS) {
    const these = d.items.filter((i) => i.kind === kind);
    if (!these.length) continue;
    out.push('', `**${WAIT_LABEL[kind]}** (${these.length})`);
    for (const i of these) {
      // A PR names its issue too ("#41 for #12 Title"); an issue alone, its title; a deploy, its commit.
      const issue = i.issue !== null ? `#${i.issue}${i.title ? ` ${i.title}` : ''}` : '';
      const subject = i.pr !== null ? `#${i.pr}${issue ? ` for ${issue}` : ''}` : issue || (i.sha ? i.sha.slice(0, 12) : ''); // a plain SHA, which GitHub links (in backticks it wouldn't)
      out.push(`- ${subject ? `${subject}: ` : ''}${i.detail} (waiting ${waited(i.since, now)})`);
    }
  }
  // The PRs merged on their own since the last digest, to sample: each with its review level and the evaluator's confidence.
  out.push('', `**Merged since yesterday** (${d.merged.length})`);
  if (!d.merged.length) out.push('- nothing merged on its own');
  for (const m of d.merged) out.push(`- #${m.pr} for #${m.issue} ${m.title}: ${m.level ?? 'level not recorded'}, evaluator confidence ${m.confidence ?? 'not recorded'}`);
  // PR batches (only when batching ran): each with its status, its PRs, and what came of them.
  const batches = d.batches ?? [];
  if (batches.length) {
    out.push('', `**PR batches since yesterday** (${batches.length})`);
    for (const b of batches) out.push(`- ${b.id} ${b.status}: ${b.prs.map((x) => `#${x.number}`).join(', ')}${b.detail ? `; ${b.detail}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

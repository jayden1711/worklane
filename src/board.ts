// The dashboard's Board: every task in flight on one instance, in one column per stage (Planning, Building,
// Verifying, Waiting on you, Landing), each card with what the owner looks at first. A read model like
// projection.ts: a fold over the event log, plus the coordinator's list of live runs and what each run's
// processes use now. Nothing here asks GitHub: the PR's size and comment count are what the watch recorded
// (pr.stats), the checks what it and the coordinator recorded. The actions on a card are worked out here for
// the asker's role, and each one is refused again by the endpoint it calls (decide, the console).
import type { StoredEvent } from './events/types.js';
import { checkResults, prsView, project, type PrView, type Task, type TaskStatus } from './projection.js';
import { waitingOnYou, WAIT_LABEL, type WaitKind } from './digest.js';
import { isOwner, isWriter, mayAnswerKind, type Role } from './dashboard-auth.js';
import type { LiveRun } from './console.js';
import type { ProcessGroupUsage } from './os/stats.js';
import { batchSummaries, prBatchStatus, type BatchStatus } from './coordinator/pr-batch.js';

export const BOARD_COLUMNS = ['planning', 'building', 'verifying', 'waiting', 'landing'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const COLUMN_LABEL: Record<BoardColumn, string> = {
  planning: 'Planning',
  building: 'Building',
  verifying: 'Verifying',
  waiting: 'Waiting on you',
  landing: 'Landing',
};

/**
 * The digest's holds that only the owner ends, which put a card in Waiting on you. A PR held by a pending required
 * check, or a task behind another on the same files, moves on by itself: it stays in its stage's column.
 */
const ONLY_THE_OWNER: ReadonlySet<WaitKind> = new Set<WaitKind>(['merge_stopped', 'main_checks_timed_out', 'awaiting_decision', 'plan_held', 'needs_owner', 'ci_fix_gave_up', 'blocked', 'landing_failed']);

/** Run roles that plan or research before anything is built: their task is still being planned. */
const PLANNING_ROLES = new Set(['planner', 'plan-reviewer', 'researcher']);

export type CheckState = 'failing' | 'pending' | 'passing' | 'none';

export interface BoardCard {
  instance: string;
  issue: number;
  title: string;
  column: BoardColumn;
  status: TaskStatus;
  /** The PR the harness opened for it (the open one, else the latest), with GitHub's link. */
  pr: { number: number; url: string; phase: PrView['phase'] } | null;
  /** Lines added and removed: the PR's as GitHub last reported them, else the last change the coordinator proposed. */
  diff: { added: number | null; removed: number | null; lines: number; files: number; source: 'pr' | 'change' } | null;
  /** Comments and review comments on the PR, as the watch last recorded them; null before a PR (or before it was recorded). */
  comments: number | null;
  /** When work on it began (its claim; for a task not started, when it was first seen), and since when it is in this column's state. */
  startedAt: string;
  since: string;
  /** failing, pending or passing: the PR's required checks at its head, else the coordinator's last check run on it. */
  checks: { state: CheckState; source: 'pr' | 'coordinator' | null; items: { name: string; outcome: string }[] };
  /** The agent running on it now: which, since when, its last heartbeat, its live run (for Watch and Steer) and what its processes use. */
  run: {
    role: string;
    model: string;
    startedAt: string;
    lastHeartbeat: string | null;
    note: string | null;
    live: string | null;
    usage: ProcessGroupUsage | null;
  } | null;
  /** Why it waits on the owner (the digest's), when it does; `detail` only for those who may read the digest. */
  waiting: { kind: WaitKind; label: string; detail: string | null; since: string } | null;
  /** The open decision on it. */
  decision: { id: string; kind: string; question: string; options: string[]; recommendation: string } | null;
  level: string | null;
  /** Its PR's head with the PR batches (PR mode with batching): queued, being tested, passed or returned; null when not in them. */
  batch: { status: 'queued' | 'testing' | 'passed' | 'returned'; id: string | null } | null;
  /** A high-risk change that waits for the owner: an L3 review level, or a landing decision (direct mode). */
  highRisk: boolean;
  /**
   * What this asker may do from the card. watch: the run's live feed (the owner and writers, the runs gate).
   * steer: a console message to the run (the owner and writers, the console's rule). answer: the open decision,
   * where the decision rules let this role answer it (plans and landings are the owner's). approve: a high-risk
   * change waiting for the owner, the owner's alone: its landing decision, or the PR to merge on GitHub.
   */
  actions: {
    watch: 'feed' | null;
    steer: boolean;
    answer: boolean;
    approve: { decision: string; options: string[] } | { merge: string } | null;
  };
}

export interface BoardView {
  instance: string;
  role: Role;
  at: string;
  columns: { id: BoardColumn; label: string }[];
  cards: BoardCard[];
  /** The machine's agent slots (every instance and harness on it). */
  slots: { cap: number; running: number };
  /** The Landing column's PR batches: those running, then the last few, newest first; `detail` not for viewers. */
  batches: BoardBatch[];
}

export interface BoardBatch {
  id: string;
  status: BatchStatus;
  prs: number[];
  issues: number[];
  at: string;
  detail: string;
}

/** How many finished PR batches the Landing column shows beside those running. */
const RECENT_BATCHES = 5;

export interface BoardInput {
  events: StoredEvent[];
  instance: string;
  role: Role;
  /** Whether this role may read what waits on the owner (the digest): the wait's detail is shown only then. */
  canReadDigest: boolean;
  /** The coordinator's live runs (console/live.json). */
  live: LiveRun[];
  slots: { cap: number; running: number };
  /** What each process group uses now (os/stats processGroupUsage); nothing measured when unset. */
  usage?: (pgids: number[]) => Map<number, ProcessGroupUsage>;
  now?: Date;
}

/** The overall state of a set of check outcomes: any failure fails it, then anything not finished is pending. */
export function checkState(outcomes: string[]): CheckState {
  if (!outcomes.length) return 'none';
  if (outcomes.some((o) => o === 'fail' || o === 'cancelled')) return 'failing';
  if (outcomes.some((o) => o === 'pending' || o === 'missing')) return 'pending';
  return 'passing';
}

/** Which column a task is in: waiting on the owner first, else by its status (and, in review, its PR's phase). Null: not on the board. */
export function columnOf(t: Pick<Task, 'status'>, o: { waits: boolean; pr: Pick<PrView, 'phase' | 'state'> | null; runRole: string | null }): BoardColumn | null {
  if (['done', 'released', 'triage'].includes(t.status)) return null;
  if (o.waits || t.status === 'awaiting_decision' || t.status === 'blocked') return 'waiting';
  if (o.runRole && PLANNING_ROLES.has(o.runRole)) return 'planning';
  switch (t.status) {
    case 'ready':
    case 'claimed':
      return 'planning';
    case 'reproducing':
    case 'building':
      return 'building';
    case 'verifying':
    case 'evaluating':
      return 'verifying';
    case 'queued':
    case 'landed':
      return 'landing';
    case 'in_review':
      if (!o.pr || o.pr.state !== 'open') return null;
      if (o.pr.phase === 'waiting' || o.pr.phase === 'gave_up') return 'waiting';
      return o.pr.phase === 'ready' ? 'landing' : 'verifying';
    default:
      return null;
  }
}

/** The Board for one instance, as this role sees it. */
export function boardView(i: BoardInput): BoardView {
  const now = i.now ?? new Date();
  const p = project(i.events, now.toISOString().slice(0, 10));
  const prs = prsView(i.events).prs;
  const digest = waitingOnYou(i.events, now);
  const owner = isOwner(i.role);

  // What the board reads beside the projection: claims, the last proposed change and PR stats, each run's process group.
  const claimedAt = new Map<number, string>();
  const change = new Map<number, { added: number | null; removed: number | null; lines: number; files: number }>();
  const stats = new Map<number, { head: string; additions: number; deletions: number; files: number; comments: number }>();
  const pgid = new Map<string, number>();
  for (const e of i.events) {
    const q = e.payload as Record<string, unknown>;
    if (e.type === 'issue.claimed') claimedAt.set(Number(q.issue), e.ts);
    else if (e.type === 'change.proposed') change.set(Number(q.issue), { added: typeof q.added === 'number' ? q.added : null, removed: typeof q.removed === 'number' ? q.removed : null, lines: Number(q.lines), files: (q.files as string[]).length });
    else if (e.type === 'pr.stats') stats.set(Number(q.number), { head: String(q.head), additions: Number(q.additions), deletions: Number(q.deletions), files: Number(q.files), comments: Number(q.comments) });
    else if (e.type === 'run.started' && typeof q.pgid === 'number') pgid.set(`${q.issue}:${q.role}`, q.pgid);
  }

  const running = new Map(p.runs.active.map((r) => [r.issue, r]));
  const groups = [...running.values()].map((r) => pgid.get(`${r.issue}:${r.role}`)).filter((g): g is number => typeof g === 'number');
  const usage = i.usage && groups.length ? i.usage(groups) : new Map<number, ProcessGroupUsage>();

  const cards: BoardCard[] = [];
  for (const t of p.tasks) {
    const mine = prs.filter((x) => x.issue === t.issue);
    const pr = mine.find((x) => x.state === 'open') ?? mine[0] ?? null;
    const wait = digest.items.find((w) => ONLY_THE_OWNER.has(w.kind) && (w.issue === t.issue || (pr !== null && w.pr === pr.number))) ?? null;
    const r = running.get(t.issue) ?? null;
    const column = columnOf(t, { waits: !!wait, pr, runRole: r?.role ?? null });
    if (!column) continue;

    const s = pr ? stats.get(pr.number) : undefined;
    const c = change.get(t.issue);
    const diff: BoardCard['diff'] = s ? { added: s.additions, removed: s.deletions, lines: s.additions + s.deletions, files: s.files, source: 'pr' } : c ? { ...c, source: 'change' } : null;

    let checks: BoardCard['checks'] = { state: 'none', source: null, items: [] };
    if (pr?.status && pr.state === 'open') checks = { state: checkState(pr.status.checks.map((x) => x.outcome)), source: 'pr', items: pr.status.checks };
    else {
      const last = checkResults(i.events, t.issue)[0];
      if (last) {
        const items = last.checks.map((x) => ({ name: x.check, outcome: x.status }));
        checks = { state: checkState(items.filter((x) => x.outcome === 'pass' || x.outcome === 'fail').map((x) => x.outcome)), source: 'coordinator', items };
      }
    }

    const live = r ? (i.live.find((l) => l.issue === r.issue && l.role === r.role)?.run ?? null) : null;
    const group = r ? pgid.get(`${r.issue}:${r.role}`) : undefined;
    const d = t.openDecision ? (p.decisions.find((x) => x.id === t.openDecision && !x.answer) ?? null) : null;
    const highRisk = t.level === 'L3' || d?.kind === 'land';
    const batch = pr && pr.state === 'open' ? prBatchStatus(i.events, pr.number, pr.head) : null;
    const startedAt = claimedAt.get(t.issue) ?? t.firstSeen;

    // Approve/Merge: the owner's, on a high-risk change that waits for them. A landing decision is answered through
    // decide (which refuses anyone else); a PR left to the owner is merged on GitHub, where its own rules apply.
    let approve: BoardCard['actions']['approve'] = null;
    if (owner && highRisk && column === 'waiting') {
      if (d?.kind === 'land') approve = { decision: d.id, options: d.options };
      else if (pr && pr.state === 'open' && pr.phase === 'waiting') approve = { merge: pr.url };
    }

    cards.push({
      instance: i.instance,
      issue: t.issue,
      title: t.title,
      column,
      status: t.status,
      pr: pr ? { number: pr.number, url: pr.url, phase: pr.phase } : null,
      diff,
      comments: s ? s.comments : null,
      startedAt,
      since: wait?.since ?? startedAt,
      checks,
      run: r ? { role: r.role, model: r.model, startedAt: r.startedAt, lastHeartbeat: r.lastHeartbeat, note: r.note, live, usage: group !== undefined ? (usage.get(group) ?? null) : null } : null,
      waiting: wait ? { kind: wait.kind, label: WAIT_LABEL[wait.kind], detail: i.canReadDigest ? wait.detail : null, since: wait.since } : null,
      decision: d ? { id: d.id, kind: d.kind, question: d.question, options: d.options, recommendation: d.recommendation } : null,
      level: t.level,
      batch: batch ? { status: batch.status, id: batch.batch } : null,
      highRisk,
      actions: {
        watch: live && isWriter(i.role) ? 'feed' : null,
        steer: !!live && isWriter(i.role),
        // A landing decision is the Approve action, not an answer.
        answer: !!d && d.kind !== 'land' && mayAnswerKind(d.kind, i.role),
        approve,
      },
    });
  }
  // Oldest first in each column: what has waited longest is on top.
  cards.sort((a, b) => BOARD_COLUMNS.indexOf(a.column) - BOARD_COLUMNS.indexOf(b.column) || a.since.localeCompare(b.since) || a.issue - b.issue);
  const summaries = batchSummaries(i.events).filter((b) => b.prs.length);
  const batches = [...summaries.filter((b) => b.open).reverse(), ...summaries.filter((b) => !b.open).slice(-RECENT_BATCHES).reverse()].map((b) => ({ id: b.id, status: b.status, prs: b.prs.map((x) => x.number), issues: b.prs.map((x) => x.issue), at: b.at, detail: b.detail }));
  return { instance: i.instance, role: i.role, at: now.toISOString(), columns: BOARD_COLUMNS.map((id) => ({ id, label: COLUMN_LABEL[id] })), cards, slots: i.slots, batches };
}

/**
 * A card as a viewer (read on the repo) may have it: an allowlist of its fields, as src/viewer-events.ts allows a
 * viewer only some events and fields. A viewer sees the task's progress, its PR, its decision and why it waits
 * (not the digest's reason): never the agent running on it (its live run, what it uses), the change's size or the
 * checks' outcomes, which come from events viewers don't get; and they may do nothing from it. A field added to
 * cards later stays hidden from viewers until it is put here.
 */
export const VIEWER_CARD_FIELDS: readonly string[] = Object.freeze(['instance', 'issue', 'title', 'column', 'status', 'pr', 'startedAt', 'since', 'waiting', 'decision', 'level', 'batch', 'highRisk']);
const VIEWER_PR_FIELDS: readonly string[] = Object.freeze(['number', 'url']);
const VIEWER_WAIT_FIELDS: readonly string[] = Object.freeze(['kind', 'label', 'since']);
const VIEWER_DECISION_FIELDS: readonly string[] = Object.freeze(['id', 'kind', 'question', 'options', 'recommendation']);
export const VIEWER_BOARD_KEYS: readonly string[] = Object.freeze(['instance', 'role', 'at', 'columns', 'cards', 'slots', 'batches']);
/** A PR batch as a viewer sees it: its status (src/viewer-events.ts), not what happened in it. */
const VIEWER_BOARD_BATCH_FIELDS: readonly string[] = Object.freeze(['id', 'status', 'prs', 'issues', 'at']);
const VIEWER_CARD_BATCH_FIELDS: readonly string[] = Object.freeze(['status', 'id']);

const pick = (o: unknown, keys: readonly string[]) => (o && typeof o === 'object' ? Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, (o as Record<string, unknown>)[k]])) : null);

/** The board as a viewer may have it: only the allowlisted keys, each card only its allowlisted fields, and no actions. */
export function boardForViewer(b: BoardView): Record<string, unknown> {
  const out = pick(b, VIEWER_BOARD_KEYS)!;
  out.cards = b.cards.map((c) => {
    const v = pick(c, VIEWER_CARD_FIELDS)!;
    if (v.pr) v.pr = pick(v.pr, VIEWER_PR_FIELDS);
    if (v.waiting) v.waiting = { ...pick(v.waiting, VIEWER_WAIT_FIELDS), detail: null };
    if (v.decision) v.decision = pick(v.decision, VIEWER_DECISION_FIELDS);
    if (v.batch) v.batch = pick(v.batch, VIEWER_CARD_BATCH_FIELDS);
    return { ...v, actions: { watch: null, steer: false, answer: false, approve: null } };
  });
  out.batches = (b.batches ?? []).map((x) => pick(x, VIEWER_BOARD_BATCH_FIELDS));
  return out;
}

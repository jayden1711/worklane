// Read model for the dashboard (and reports): a pure fold over the event log.
// Nothing here is stored; delete it and replay the log and you get the same.
import type { StoredEvent } from './events/types.js';

export type TaskStatus =
  | 'triage'
  | 'ready'
  | 'claimed'
  | 'reproducing'
  | 'building'
  | 'verifying'
  | 'evaluating'
  | 'awaiting_decision'
  | 'queued'
  | 'landed'
  | 'done'
  | 'blocked'
  | 'released';

export const STATUS_ORDER: TaskStatus[] = ['triage', 'ready', 'claimed', 'reproducing', 'building', 'verifying', 'evaluating', 'awaiting_decision', 'queued', 'landed', 'done', 'blocked', 'released'];

export interface Verdict {
  patch_correct: boolean;
  test_correct: boolean;
  confidence: string;
  advice: string;
}

export interface Task {
  issue: number;
  title: string;
  labels: string[];
  author: string;
  owner: string | null;
  delegate: { instance: string; role: string } | null;
  status: TaskStatus;
  actionable: boolean;
  why: string;
  level: string | null;
  levelReasons: string[];
  doneWhen: Record<string, unknown>[];
  verdict: Verdict | null;
  costUsd: number;
  attempts: number;
  head: string | null;
  landed: string | null;
  deployed: string | null;
  repro: string | null;
  openDecision: string | null;
  blockedReason: string | null;
  lastActivity: string;
  firstSeen: string;
  eventIds: number[];
}

export interface Decision {
  id: string;
  kind: string;
  issue: number | null;
  owner: string;
  question: string;
  options: string[];
  recommendation: string;
  receipts: string[];
  askedAt: string;
  answer: { by: string; answer: string; at: string } | null;
}

export interface Projection {
  lastId: number;
  tasks: Task[];
  decisions: Decision[];
  /** Estimated (Claude Code's per-run cost estimate, not billed money), today only. */
  spendToday: number;
  /** Same estimate, today only, split by role. */
  spendByRole: Record<string, number>;
  landedToday: number;
  baseline: { sha: string; failing: string[]; at: string } | null;
  deploys: { env: string; sha: string; status: 'requested' | 'verified' | 'failed'; why?: string; at: string }[];
  coordinator: { instance: string; startedAt: string; lastTick: string | null } | null;
  errors: { at: string; where: string; message: string }[];
  activity: { id: number; ts: string; type: string; actor: string; issue: number | null; summary: string }[];
  /** Agent runs in flight (started, not finished), and the most recent finished ones. */
  runs: { active: Run[]; recent: Run[] };
  /** Changes waiting to land, oldest first, and recent landing batches. */
  landQueue: { issue: number; title: string; head: string; level: string; queuedAt: string; deferred: string | null }[];
  batches: { id: string; issues: number[]; tip: string; outcome: string; detail: string; at: string }[];
  governor: { held: boolean; reason: string | null; load: number | null; freeDiskPct: number | null; at: string } | null;
  reports: { day: string; slot: string; issue: number | null; at: string }[];
}

export interface Run {
  issue: number;
  role: string;
  model: string;
  pid: number;
  attempt: number;
  startedAt: string;
  lastHeartbeat: string | null;
  note: string | null;
  finishedAt: string | null;
  reason: string | null;
  costUsd: number;
}

const RUN_STATUS: Record<string, TaskStatus> = {
  'evaluator-repro': 'reproducing',
  worker: 'building',
  investigator: 'building',
  'evaluator-verdict': 'evaluating',
};

export function summarize(e: StoredEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'issue.claimed':
      return `claimed by ${p.instance} for @${p.owner}`;
    case 'run.started':
      return `${p.role} started (${p.model})`;
    case 'run.finished':
      return `${p.role} ${p.reason}`;
    case 'run.cost':
      return `${p.role} cost $${Number(p.usd).toFixed(2)}`;
    case 'repro.frozen':
      return `reproduction test frozen: ${p.path}`;
    case 'repro.unavailable':
      return `no reproduction: ${p.why}`;
    case 'change.proposed':
      return `change proposed: ${(p.files as string[]).length} files, ${p.lines} lines`;
    case 'change.rejected':
      return `change rejected: ${p.why}`;
    case 'check.result':
      return `${p.stage} checks: ${(p.checks as { status: string }[]).every((c) => c.status === 'pass') ? 'pass' : 'fail'}`;
    case 'eval.verdict':
      return `evaluator: ${p.patch_correct ? 'approves' : 'rejects'} (${p.confidence})`;
    case 'review.level_set':
      return `review level ${p.level}`;
    case 'decision.asked':
      return `decision for @${p.owner}: ${p.question}`;
    case 'decision.answered':
      return `@${p.by} answered ${p.answer}`;
    case 'land.queued':
      return `queued for landing (${p.level})`;
    case 'land.result':
      return `landing ${p.outcome}${p.landed ? ` at ${String(p.landed).slice(0, 8)}` : ''}`;
    case 'deploy.verified':
      return `${p.env} serving ${String(p.sha).slice(0, 8)}`;
    case 'deploy.failed':
      return `${p.env} deploy failed: ${p.why}`;
    case 'issue.released':
      return `released: ${p.why}`;
    case 'issue.blocked':
      return `blocked: ${p.why}`;
    case 'baseline.recorded':
      return `baseline: ${(p.failing as string[]).length} failing at ${String(p.sha).slice(0, 8)}`;
    case 'issue.seen':
      return p.actionable ? 'seen: actionable' : `seen: ${p.why}`;
    case 'contract.missing':
      return `no contract: ${p.why}`;
    case 'land.batch':
      return `batch ${p.outcome}: ${(p.issues as number[]).map((x) => `#${x}`).join(' ')}`;
    case 'governor.hold':
      return `dispatch held: ${p.reason}`;
    case 'governor.release':
      return 'dispatch resumed';
    case 'report.posted':
      return `report posted (${p.slot})`;
    case 'nightly.queued':
      return 'nightly runs queued';
    default:
      return e.type;
  }
}

export function project(events: StoredEvent[], today = new Date().toISOString().slice(0, 10)): Projection {
  const tasks = new Map<number, Task>();
  const decisions = new Map<string, Decision>();
  const deploys: Projection['deploys'] = [];
  const spendByRole: Record<string, number> = {};
  let spendToday = 0;
  let landedToday = 0;
  let baseline: Projection['baseline'] = null;
  let coordinator: Projection['coordinator'] = null;
  const errors: Projection['errors'] = [];
  const active = new Map<string, Run>();
  const recent: Run[] = [];
  const queue = new Map<number, Projection['landQueue'][number]>();
  const batches = new Map<string, Projection['batches'][number]>();
  let governor: Projection['governor'] = null;
  const reports: Projection['reports'] = [];

  const task = (n: number, ts: string): Task => {
    let t = tasks.get(n);
    if (!t) {
      t = { issue: n, title: `#${n}`, labels: [], author: '', owner: null, delegate: null, status: 'triage', actionable: false, why: '', level: null, levelReasons: [], doneWhen: [], verdict: null, costUsd: 0, attempts: 0, head: null, landed: null, deployed: null, repro: null, openDecision: null, blockedReason: null, lastActivity: ts, firstSeen: ts, eventIds: [] };
      tasks.set(n, t);
    }
    return t;
  };

  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const n = typeof p.issue === 'number' ? p.issue : null;
    const t = n !== null ? task(n, e.ts) : null;
    if (t) {
      t.lastActivity = e.ts;
      t.eventIds.push(e.id);
    }
    switch (e.type) {
      case 'issue.seen':
        t!.title = String(p.title);
        t!.labels = p.labels as string[];
        t!.author = String(p.author);
        t!.actionable = Boolean(p.actionable);
        t!.why = String(p.why);
        // The assigned owner, until a claim names the routed one.
        if (!t!.owner && typeof p.owner === 'string') t!.owner = p.owner;
        if (['triage', 'ready', 'released'].includes(t!.status)) t!.status = p.actionable ? 'ready' : 'triage';
        break;
      case 'contract.agreed':
        t!.doneWhen = p.done_when as Record<string, unknown>[];
        break;
      case 'contract.missing':
        t!.why = String(p.why);
        t!.status = 'triage';
        break;
      case 'issue.claimed':
        t!.owner = String(p.owner);
        t!.delegate = { instance: String(p.instance), role: 'worker' };
        t!.status = 'claimed';
        t!.blockedReason = null;
        t!.verdict = null;
        t!.level = null;
        t!.landed = null;
        t!.openDecision = null;
        break;
      case 'run.started':
        t!.status = RUN_STATUS[String(p.role)] ?? 'building';
        if (t!.delegate) t!.delegate.role = String(p.role);
        if (p.role === 'worker' || p.role === 'investigator') t!.attempts = Math.max(t!.attempts, Number(p.attempt));
        break;
      case 'repro.frozen':
        t!.repro = String(p.path);
        break;
      case 'change.proposed':
        t!.head = String(p.head);
        t!.status = 'verifying';
        break;
      case 'eval.verdict':
        t!.verdict = { patch_correct: Boolean(p.patch_correct), test_correct: Boolean(p.test_correct), confidence: String(p.confidence), advice: String(p.advice) };
        break;
      case 'review.level_set':
        t!.level = String(p.level);
        t!.levelReasons = p.reasons as string[];
        break;
      case 'run.cost': {
        const usd = Number(p.usd);
        if (t) t.costUsd += usd;
        if (e.ts.startsWith(today)) {
          spendToday += usd;
          spendByRole[String(p.role)] = (spendByRole[String(p.role)] ?? 0) + usd;
        }
        break;
      }
      case 'decision.asked': {
        const d: Decision = { id: String(p.id), kind: String(p.kind ?? 'question'), issue: n, owner: String(p.owner), question: String(p.question), options: p.options as string[], recommendation: String(p.recommendation), receipts: p.receipts as string[], askedAt: e.ts, answer: null };
        decisions.set(d.id, d);
        if (t) {
          t.openDecision = d.id;
          t.status = 'awaiting_decision';
        }
        break;
      }
      case 'decision.answered': {
        const d = decisions.get(String(p.id));
        if (d) {
          d.answer = { by: String(p.by), answer: String(p.answer), at: e.ts };
          if (d.issue !== null) {
            const dt = task(d.issue, e.ts);
            if (dt.openDecision === d.id) dt.openDecision = null;
          }
        }
        break;
      }
      case 'land.queued':
        t!.status = 'queued';
        break;
      case 'land.result':
        if (p.outcome === 'deferred') {
          t!.status = 'queued';
          t!.blockedReason = null;
        } else if (p.outcome === 'landed') {
          t!.landed = String(p.landed);
          t!.status = 'landed';
          if (e.ts.startsWith(today)) landedToday++;
        } else {
          t!.status = 'blocked';
          t!.blockedReason = `landing ${p.outcome}: ${String(p.detail).split('\n')[0]}`;
        }
        break;
      case 'issue.blocked':
        t!.status = 'blocked';
        t!.blockedReason = String(p.why);
        // A block can come before any claim (e.g. an investigation); it names who must unblock it.
        t!.owner = String(p.owner);
        break;
      case 'issue.released':
        if (t!.status === 'landed' || p.why === 'landed') t!.status = 'done';
        else if (t!.status !== 'blocked') t!.status = 'released';
        t!.delegate = null;
        break;
      case 'run.finished':
        if (!['succeeded'].includes(String(p.reason))) {
          t!.blockedReason = `${p.role} ${p.reason}: ${String(p.detail).slice(0, 200)}`;
        }
        break;
      case 'baseline.recorded':
        baseline = { sha: String(p.sha), failing: p.failing as string[], at: e.ts };
        break;
      case 'deploy.requested':
        deploys.push({ env: String(p.env), sha: String(p.sha), status: 'requested', at: e.ts });
        break;
      case 'deploy.verified':
      case 'deploy.failed': {
        const d = [...deploys].reverse().find((x) => x.env === p.env && x.sha === p.sha);
        const status = e.type === 'deploy.verified' ? 'verified' : 'failed';
        if (d) Object.assign(d, { status, at: e.ts, ...(p.why ? { why: String(p.why) } : {}) });
        else deploys.push({ env: String(p.env), sha: String(p.sha), status, at: e.ts, ...(p.why ? { why: String(p.why) } : {}) });
        for (const tk of tasks.values()) if (tk.landed === p.sha && status === 'verified') tk.deployed = String(p.env);
        break;
      }
      case 'coordinator.started':
        coordinator = { instance: String(p.instance), startedAt: e.ts, lastTick: null };
        break;
      case 'coordinator.tick':
        if (coordinator) coordinator.lastTick = e.ts;
        break;
      case 'coordinator.error':
        errors.push({ at: e.ts, where: String(p.where), message: String(p.message) });
        break;
    }
    // Read models that sit beside the per-task fold.
    switch (e.type) {
      case 'run.started':
        active.set(`${n}:${p.role}`, { issue: n!, role: String(p.role), model: String(p.model), pid: Number(p.pid), attempt: Number(p.attempt), startedAt: e.ts, lastHeartbeat: null, note: null, finishedAt: null, reason: null, costUsd: 0 });
        break;
      case 'run.heartbeat': {
        const r = active.get(`${n}:${p.role}`);
        if (r) {
          r.lastHeartbeat = e.ts;
          r.note = String(p.note).slice(0, 200);
        }
        break;
      }
      case 'run.finished': {
        const r = active.get(`${n}:${p.role}`);
        if (r) {
          active.delete(`${n}:${p.role}`);
          r.finishedAt = e.ts;
          r.reason = String(p.reason);
          recent.push(r);
        }
        break;
      }
      case 'run.cost': {
        const r = [...recent].reverse().find((x) => x.issue === n && x.role === p.role && x.costUsd === 0) ?? active.get(`${n}:${p.role}`);
        if (r) r.costUsd = Number(p.usd);
        break;
      }
      case 'land.queued':
        queue.set(n!, { issue: n!, title: t?.title ?? `#${n}`, head: String(p.head), level: String(p.level), queuedAt: e.ts, deferred: null });
        break;
      case 'land.result': {
        const q = queue.get(n!);
        if (q && p.outcome === 'deferred') q.deferred = String(p.detail).split('\n')[0]!.slice(0, 200);
        else queue.delete(n!);
        break;
      }
      case 'land.batch': {
        const b = batches.get(String(p.id));
        batches.set(String(p.id), { id: String(p.id), issues: p.issues as number[], tip: String(p.tip), outcome: String(p.outcome), detail: String(p.detail).slice(0, 300), at: b?.at ?? e.ts });
        break;
      }
      case 'governor.hold':
        governor = { held: true, reason: String(p.reason), load: (p.load as number | null) ?? null, freeDiskPct: (p.free_disk_pct as number | null) ?? null, at: e.ts };
        break;
      case 'governor.release':
        governor = { held: false, reason: null, load: (p.load as number | null) ?? null, freeDiskPct: (p.free_disk_pct as number | null) ?? null, at: e.ts };
        break;
      case 'report.posted':
        reports.push({ day: String(p.day), slot: String(p.slot), issue: (p.issue as number | null) ?? null, at: e.ts });
        break;
    }
  }

  const activity = events
    .filter((e) => !['coordinator.tick', 'run.heartbeat'].includes(e.type))
    .slice(-200)
    .reverse()
    .map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, issue: typeof (e.payload as { issue?: unknown }).issue === 'number' ? ((e.payload as { issue: number }).issue) : null, summary: summarize(e) }));

  return {
    lastId: events.at(-1)?.id ?? 0,
    tasks: [...tasks.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    decisions: [...decisions.values()].sort((a, b) => b.askedAt.localeCompare(a.askedAt)),
    spendToday,
    spendByRole,
    landedToday,
    baseline,
    deploys: deploys.slice(-50).reverse(),
    coordinator,
    errors: errors.slice(-20).reverse(),
    activity,
    runs: { active: [...active.values()], recent: recent.slice(-50).reverse() },
    landQueue: [...queue.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
    batches: [...batches.values()].slice(-30).reverse(),
    governor,
    reports: reports.slice(-30).reverse(),
  };
}

/** What needs this person: their open decisions, their blocked tasks, and recent L2 landings to look over. */
export function inbox(p: Projection, user: string) {
  const u = user.toLowerCase();
  const mine = (o: string | null) => (o ?? '').toLowerCase() === u;
  return {
    decisions: p.decisions.filter((d) => !d.answer && mine(d.owner)),
    blocked: p.tasks.filter((t) => t.status === 'blocked' && mine(t.owner)),
    notify: p.tasks.filter((t) => (t.status === 'landed' || t.status === 'done') && t.level === 'L2' && mine(t.owner)).slice(0, 20),
  };
}

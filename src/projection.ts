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
  /** This coordinator's own record of emergency stops: the last time it halted for one, and the last time it resumed. */
  emergency: { lastStop: { at: string; by: string; reason: string; running: number } | null; lastResume: string | null };
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

/** A setting's value as one short line: run windows as from-to pairs, the rest as written. */
export function settingText(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map((w) => (w && typeof w === 'object' && 'from' in w ? `${(w as { from: string }).from}-${(w as { to: string }).to}` : JSON.stringify(w))).join(', ') : 'any time';
  if (v === undefined || v === null) return 'unset';
  return String(v);
}

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
    case 'console.message_queued':
      return `message for the ${p.role} from @${p.by}, held until its turn ends`;
    case 'console.message_delivered':
      return `message delivered to the ${p.role}`;
    case 'console.message_dropped':
      return `message to the ${p.role} dropped: the run ended first`;
    case 'console.run_stopped':
      return `${p.role} stopped by @${p.by} from the console`;
    case 'console.request_refused':
      return `console request refused: ${p.why}`;
    case 'settings.changed':
      return `setting ${p.key}: ${settingText(p.from)} → ${settingText(p.to)}, by @${p.by}`;
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
  const emergency: Projection['emergency'] = { lastStop: null, lastResume: null };
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
      case 'emergency.stop':
        emergency.lastStop = { at: e.ts, by: String(p.by), reason: String(p.reason), running: Number(p.running) };
        break;
      case 'emergency.resume':
        emergency.lastResume = e.ts;
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
    emergency,
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

/** One run of the coordinator's own checks on an issue, as the issue page shows it. */
export interface CheckRunView {
  id: number;
  at: string;
  /** verify, land, ... or "no change" for a no-change finding checked on the unchanged base. */
  stage: string;
  head: string;
  checks: { check: string; status: string; exitCode: number | null; tail: string | null }[];
}

/** An issue's check results, newest first: every check the coordinator ran itself, with each failure's output. */
export function checkResults(events: StoredEvent[], issue: number): CheckRunView[] {
  const out: CheckRunView[] = [];
  for (const e of events) {
    if (e.type !== 'check.result' && e.type !== 'issue.no_change') continue;
    const p = e.payload as { issue: number; head?: string; base?: string; stage?: string; checks: { check: string; status: string; exitCode: number | null; tail?: string }[] };
    if (p.issue !== issue) continue;
    out.push({
      id: e.id,
      at: e.ts,
      stage: e.type === 'issue.no_change' ? 'no change' : String(p.stage),
      head: String(p.head ?? p.base ?? ''),
      checks: p.checks.map((c) => ({ check: c.check, status: c.status, exitCode: c.exitCode ?? null, tail: c.tail ?? null })),
    });
  }
  return out.reverse();
}

/** One pull request the harness opened, as the PR page shows it: from its pr.*, ci_fix.* and merge.* events. */
export interface PrView {
  number: number;
  issue: number;
  title: string;
  url: string;
  openedAt: string;
  /** The commit the PR is at now: as opened, the last fix pushed, or what the watch last saw (a person's push). */
  head: string;
  /** open, merged (by the harness or a person), or closed unmerged. */
  state: 'open' | 'merged' | 'closed';
  /** Draft until the harness marks it ready (required checks green on the evaluated commit). */
  draft: boolean;
  /** The watch's last look at the current head: each required check's outcome, and why it isn't ready yet. */
  status: { head: string; at: string; ready: boolean; reasons: string[]; checks: { name: string; outcome: string }[] } | null;
  /** The last time it was marked not ready, and why. */
  unready: { at: string; why: string } | null;
  fixes: { attempt: number; at: string; checks: string[]; outcome: 'running' | 'pushed' | 'no_push' | 'interrupted'; detail: string }[];
  /** No more fix runs; the owner was asked to look. */
  gaveUp: { at: string; reason: string } | null;
  /** The merge policy's last call: merged automatically, or waiting for a person, with its reasons. */
  decision: { at: string; head: string; auto: boolean; reasons: string[] } | null;
  /** The merge policy's "wait for a person" reasons, while that call stands (the PR is still at the head it was made on). */
  waitReasons: string[];
  merged: { at: string; sha: string; url: string; auto: boolean } | null;
  mergeFailed: { at: string; why: string } | null;
  /** After an auto-merge: the default branch's required checks on the merge commit. */
  mainResult: { at: string; outcome: 'green' | 'red'; failed: string[] } | null;
  /** Where it stands, for grouping: waiting for a person, being fixed, checks running, gave up, auto-merged, merged, closed. */
  phase: 'waiting' | 'fixing' | 'gave_up' | 'checks' | 'ready' | 'auto_merged' | 'merged' | 'closed';
}

export interface PrsView {
  prs: PrView[];
  /** Pushes the harness refused before they left (size, protected paths, ...), newest first. */
  refused: { at: string; issue: number; title: string; head: string; stage: string; reasons: string[] }[];
  /** This instance's auto-merge stops and resumes, newest first. */
  stops: { at: string; kind: 'stopped' | 'resumed'; reason: string; number: number | null; revert: string | null }[];
}

/** Every PR the harness opened, newest first, with what happened to it; plus refused pushes and auto-merge stops. */
export function prsView(events: StoredEvent[]): PrsView {
  const titles = new Map<number, string>();
  const prs = new Map<number, PrView>();
  const refused: PrsView['refused'] = [];
  const stops: PrsView['stops'] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const n = Number(p.number);
    const pr = prs.get(n);
    switch (e.type) {
      case 'issue.seen':
        titles.set(Number(p.issue), String(p.title));
        break;
      case 'pr.opened':
        prs.set(n, { number: n, issue: Number(p.issue), title: titles.get(Number(p.issue)) ?? `#${p.issue}`, url: String(p.url), openedAt: e.ts, head: String(p.head), state: 'open', draft: Boolean(p.draft), status: null, unready: null, fixes: [], gaveUp: null, decision: null, waitReasons: [], merged: null, mergeFailed: null, mainResult: null, phase: 'checks' });
        break;
      case 'pr.status':
        if (pr) {
          pr.status = { head: String(p.head), at: e.ts, ready: Boolean(p.ready), reasons: p.reasons as string[], checks: p.checks as { name: string; outcome: string }[] };
          // The watch reads the PR's head on GitHub: after a person pushes, that's the PR's head, not the harness's last push.
          pr.head = String(p.head);
        }
        break;
      case 'pr.ready':
        if (pr) pr.draft = false;
        break;
      case 'pr.unready':
        if (pr) {
          pr.draft = true;
          pr.unready = { at: e.ts, why: String(p.why) };
        }
        break;
      case 'ci_fix.started':
        if (pr) pr.fixes.push({ attempt: Number(p.attempt), at: e.ts, checks: p.checks as string[], outcome: 'running', detail: '' });
        break;
      case 'ci_fix.finished':
        if (pr) {
          const f = pr.fixes.at(-1);
          if (f && f.outcome === 'running') Object.assign(f, { outcome: p.outcome, detail: String(p.detail) });
          if (p.outcome === 'pushed' && p.head) pr.head = String(p.head);
        }
        break;
      case 'ci_fix.gave_up':
        if (pr) pr.gaveUp = { at: e.ts, reason: String(p.reason) };
        break;
      case 'merge.decided':
        if (pr) pr.decision = { at: e.ts, head: String(p.head), auto: Boolean(p.auto), reasons: p.reasons as string[] };
        break;
      case 'merge.done':
        if (pr) {
          pr.merged = { at: e.ts, sha: String(p.sha), url: String(p.url), auto: true };
          pr.state = 'merged';
        }
        break;
      case 'merge.failed':
        if (pr) pr.mergeFailed = { at: e.ts, why: String(p.why) };
        break;
      case 'merge.main_result':
        if (pr) pr.mainResult = { at: e.ts, outcome: p.outcome as 'green' | 'red', failed: p.failed as string[] };
        break;
      case 'pr.closed':
        if (pr) {
          pr.state = p.merged ? 'merged' : 'closed';
          if (p.merged && !pr.merged) pr.merged = { at: e.ts, sha: '', url: pr.url, auto: false };
        }
        break;
      case 'push.refused':
        refused.push({ at: e.ts, issue: Number(p.issue), title: titles.get(Number(p.issue)) ?? `#${p.issue}`, head: String(p.head), stage: String(p.stage), reasons: p.reasons as string[] });
        break;
      case 'merge.stopped':
        stops.push({ at: e.ts, kind: 'stopped', reason: String(p.reason), number: (p.number as number | null) ?? null, revert: (p.revert as string | null) ?? null });
        break;
      case 'merge.resumed':
        stops.push({ at: e.ts, kind: 'resumed', reason: String(p.detail), number: null, revert: null });
        break;
    }
  }
  for (const pr of prs.values()) {
    pr.waitReasons = pr.decision && !pr.decision.auto && pr.decision.head === pr.head ? pr.decision.reasons : [];
    pr.phase = phaseOf(pr);
  }
  return { prs: [...prs.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.number - a.number), refused: refused.reverse(), stops: stops.reverse() };
}

function phaseOf(pr: PrView): PrView['phase'] {
  if (pr.state === 'merged') return pr.merged?.auto ? 'auto_merged' : 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.fixes.at(-1)?.outcome === 'running') return 'fixing';
  if (pr.gaveUp) return 'gave_up';
  // A "wait for a person" call stands while the PR is still at the head it was made on.
  if (pr.decision && !pr.decision.auto && pr.decision.head === pr.head) return 'waiting';
  return pr.draft ? 'checks' : 'ready';
}

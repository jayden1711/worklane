// "Waiting on you": every state that holds work until the owner acts, how long each has waited, and the
// issue or PR it's on. Read from the event log alone, as it stands now; nothing here times a hold out (a
// hold waits for the owner, and this makes sure none waits unseen). The dashboard shows the list; the
// daily digest is its Markdown, posted as a GitHub comment (`#n` and commit SHAs link themselves there).

import { project } from './projection.js';

interface Ev {
  type: string;
  ts: string;
  payload: unknown;
}

/** The owner-held states, in the order the digest lists them. */
export const WAIT_KINDS = [
  'emergency_halt',
  'merge_stopped',
  'awaiting_decision',
  'plan_held',
  'needs_owner',
  'ci_fix_gave_up',
  'blocked',
  'landing_failed',
  'deploy_failed',
  'check_held',
  'hotspot_held',
] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export const WAIT_LABEL: Record<WaitKind, string> = {
  emergency_halt: 'Emergency stop in force',
  merge_stopped: 'Auto-merge stopped',
  awaiting_decision: 'Decisions waiting for you',
  plan_held: 'Plans held for you',
  needs_owner: 'PRs waiting for you to review and merge',
  ci_fix_gave_up: 'CI fixes that gave up',
  blocked: 'Blocked',
  landing_failed: 'Landing failed',
  deploy_failed: 'Deploys that failed',
  check_held: 'PRs held back by a required check',
  hotspot_held: 'Tasks held behind another on the same files',
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
  /** For a failed deploy: the commit. */
  sha?: string;
}

export interface Digest {
  at: string;
  items: WaitItem[];
}

/**
 * Every owner-held state open at `now`. Each one starts at the event that opened it and stays until the event
 * that ends it: an answer, a merge or close, a resume, a later verified deploy, a release, a new head.
 */
export function waitingOnYou(events: Ev[], now = new Date()): Digest {
  const t = now.getTime();
  const evs = events.filter((e) => Date.parse(e.ts) <= t);
  const title = new Map<number, string>();
  const prIssue = new Map<number, number>();
  const closed = new Set<number>();
  for (const e of evs) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'issue.seen') title.set(Number(p.issue), String(p.title));
    if (e.type === 'pr.opened') prIssue.set(Number(p.number), Number(p.issue));
    if ((e.type === 'pr.closed' || e.type === 'merge.done') && typeof p.number === 'number') closed.add(p.number);
  }
  const items: WaitItem[] = [];
  const add = (kind: WaitKind, since: string, issue: number | null, pr: number | null, detail: string, extra: Partial<WaitItem> = {}) =>
    items.push({ kind, since, issue, pr, title: issue !== null ? (title.get(issue) ?? null) : null, detail, ...extra });

  // Emergency stop and auto-merge stop: the last of stop/resume says which.
  const halt = evs.filter((e) => e.type === 'emergency.stop' || e.type === 'emergency.resume').at(-1);
  if (halt?.type === 'emergency.stop') {
    const p = halt.payload as { by: string; reason: string };
    add('emergency_halt', halt.ts, null, null, `by @${p.by}: ${p.reason}`);
  }
  const stop = evs.filter((e) => e.type === 'merge.stopped' || e.type === 'merge.resumed').at(-1);
  if (stop?.type === 'merge.stopped') {
    const p = stop.payload as { reason: string; number: number | null };
    add('merge_stopped', stop.ts, p.number !== null ? (prIssue.get(p.number) ?? null) : null, p.number, p.reason);
  }

  // Decisions not yet answered (a plan's decision is listed as the held plan, once).
  const answered = new Set(evs.filter((e) => e.type === 'decision.answered').map((e) => String((e.payload as { id: string }).id)));
  for (const e of evs) {
    if (e.type !== 'decision.asked') continue;
    const p = e.payload as { id: string; kind: string; issue: number | null; owner: string; question: string };
    if (answered.has(p.id) || p.kind === 'plan') continue;
    add('awaiting_decision', e.ts, p.issue, null, `@${p.owner}: ${p.question.split('\n')[0]!.slice(0, 160)}`);
  }

  // Plans held for the owner, until decided.
  const planHeld = new Map<number, { ts: string; reasons: string[] }>();
  for (const e of evs) {
    const p = e.payload as { issue: number; held?: boolean; reasons?: string[] };
    if (e.type === 'plan.posted') {
      if (p.held) planHeld.set(p.issue, { ts: e.ts, reasons: p.reasons ?? [] });
      else planHeld.delete(p.issue);
    } else if (e.type === 'plan.decided') planHeld.delete(p.issue);
  }
  for (const [issue, h] of planHeld) add('plan_held', h.ts, issue, null, h.reasons.length ? h.reasons.join('; ') : 'held for your approval');

  // PRs left for the owner to review and merge: not merged automatically, or a conflict fix gave up.
  const needsOwner = new Map<number, { ts: string; issue: number; detail: string }>();
  const ciGaveUp = new Map<number, { ts: string; issue: number; reason: string }>();
  for (const e of evs) {
    const p = e.payload as Record<string, unknown>;
    const n = Number(p.number);
    if (e.type === 'merge.decided' && p.auto === false && !needsOwner.has(n)) needsOwner.set(n, { ts: e.ts, issue: Number(p.issue), detail: (p.reasons as string[]).join('; ') || 'left to you' });
    if (e.type === 'conflict_fix.finished' && p.outcome === 'gave_up' && p.waits_owner === true && !needsOwner.has(n)) needsOwner.set(n, { ts: e.ts, issue: Number(p.issue), detail: `conflicts with its base; no conflict fix: ${String(p.detail).split('\n')[0]!.slice(0, 160)}` });
    if (e.type === 'ci_fix.gave_up') ciGaveUp.set(n, { ts: e.ts, issue: Number(p.issue), reason: String(p.reason) });
    if (e.type === 'ci_fix.started' || e.type === 'pr.ready') ciGaveUp.delete(n);
  }
  for (const [n, w] of needsOwner) if (!closed.has(n)) add('needs_owner', w.ts, w.issue, n, w.detail);
  for (const [n, w] of ciGaveUp) if (!closed.has(n)) add('ci_fix_gave_up', w.ts, w.issue, n, w.reason);

  // Blocked tasks, of either kind: blocked on someone (issue.blocked), or a landing that failed.
  const p = project(evs as Parameters<typeof project>[0], now.toISOString().slice(0, 10));
  const blockedAt = new Map<number, { ts: string; landing: boolean }>();
  for (const e of evs) {
    const q = e.payload as Record<string, unknown>;
    if (e.type === 'issue.blocked') blockedAt.set(Number(q.issue), { ts: e.ts, landing: false });
    if (e.type === 'land.result' && !['landed', 'deferred', 'pr_opened'].includes(String(q.outcome))) blockedAt.set(Number(q.issue), { ts: e.ts, landing: true });
  }
  for (const task of p.tasks) {
    if (task.status !== 'blocked') continue;
    const b = blockedAt.get(task.issue);
    add(b?.landing ? 'landing_failed' : 'blocked', b?.ts ?? task.lastActivity, task.issue, null, (task.blockedReason ?? '').split('\n')[0]!.slice(0, 200) || 'blocked');
  }

  // Deploys that failed, until that environment verifies a deploy again.
  const deploys = new Map<string, { ts: string; sha: string; why: string } | null>();
  for (const e of evs) {
    const q = e.payload as { env: string; sha: string; why?: string };
    if (e.type === 'deploy.failed') deploys.set(q.env, { ts: e.ts, sha: q.sha, why: String(q.why) });
    if (e.type === 'deploy.verified') deploys.set(q.env, null);
  }
  for (const [env, d] of deploys) if (d) add('deploy_failed', d.ts, null, null, `${env}: ${d.why.split('\n')[0]!.slice(0, 160)}`, { sha: d.sha });

  // PRs held back by a required check that is missing, pending or skipped, at their latest status.
  const latest = new Map<number, { ts: string; since: string; issue: number; head: string; held: string[] }>();
  for (const e of evs) {
    const q = e.payload as { issue: number; number: number; head: string; ready: boolean; checks: { name: string; outcome: string }[] };
    if (e.type === 'pr.ready') latest.delete(q.number);
    if (e.type !== 'pr.status') continue;
    const held = q.ready ? [] : q.checks.filter((c) => c.outcome === 'missing' || c.outcome === 'pending' || c.outcome === 'skipped').map((c) => `${c.name} ${c.outcome}`);
    const prev = latest.get(q.number);
    if (!held.length) latest.delete(q.number);
    // Held since the first status at this head that held it back.
    else latest.set(q.number, { ts: e.ts, since: prev && prev.head === q.head ? prev.since : e.ts, issue: q.issue, head: q.head, held });
  }
  for (const [n, s] of latest) if (!closed.has(n)) add('check_held', s.since, s.issue, n, s.held.join(', '));

  // Tasks held behind another on a hotspot file, until released.
  const holds = new Map<number, { ts: string; by: number; files: string[] }>();
  for (const e of evs) {
    const q = e.payload as { issue: number; by?: number; files?: string[] };
    if (e.type === 'hotspot.held') holds.set(q.issue, { ts: e.ts, by: Number(q.by), files: q.files ?? [] });
    if (e.type === 'hotspot.released') holds.delete(q.issue);
  }
  for (const [issue, h] of holds) add('hotspot_held', h.ts, issue, null, `behind #${h.by}, on ${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ` and ${h.files.length - 3} more` : ''}`);

  // By kind, then the longest-waiting first.
  items.sort((a, b) => WAIT_KINDS.indexOf(a.kind) - WAIT_KINDS.indexOf(b.kind) || a.since.localeCompare(b.since));
  return { at: now.toISOString(), items };
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
  if (!d.items.length) return `${head}\n\nNothing is waiting on you.\n`;
  const out = [head, '', 'Nothing here times out: each waits until you act on it.'];
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
  return `${out.join('\n')}\n`;
}

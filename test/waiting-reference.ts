// The oracle for Waiting on you (#633): src/digest.ts's waitingOnYou as it was before it became a fold the dashboard's
// event cache carries forward, copied unchanged (as of #627). It reads the whole log on every call. The incremental
// answer is tested against it over random logs (test/waiting-page.test.ts), so a change to the fold that answers
// differently fails there. Not a test of its own; nothing in src/ imports it.
import { project } from '../src/projection.js';
import { heldUpdate, RELEASE_HOLD, updateLog, type UpdateEntry } from '../src/updates.js';
import { batchSummaries } from '../src/coordinator/pr-batch.js';
import type { StoredEvent } from '../src/events/types.js';
import { localDay } from '../src/local-day.js';
import { WAIT_KINDS, type Digest, type MergedItem, type WaitItem, type WaitKind } from '../src/digest.js';
import { buildInbox, inboxFold, inboxStep } from '../src/inbox.js';

interface Ev {
  type: string;
  ts: string;
  payload: unknown;
}

/** The PR batches running at `now` or with a step after `since`. */
export function batchesSince(events: Ev[], since: Date, now: Date): Digest['batches'] {
  const stored = events.filter((e) => e.type === 'pr_batch.queued' || e.type === 'pr_batch.step' || e.type === 'pr.closed').map((e, i) => ({ ...e, id: i + 1 }) as unknown as StoredEvent);
  return batchSummaries(stored)
    .filter((b) => b.prs.length && Date.parse(b.at) <= now.getTime() && (b.open || Date.parse(b.last) > since.getTime()))
    .map((b) => ({ id: b.id, status: b.status, prs: b.prs, detail: b.detail, at: b.at, last: b.last }));
}

export function mergedSince(events: Ev[], since: Date, now: Date): MergedItem[] {
  const level = new Map<number, { head: string; level: string }[]>();
  const verdict = new Map<number, { head: string; confidence: string }[]>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'review.level_set') level.set(Number(p.issue), [...(level.get(Number(p.issue)) ?? []), { head: String(p.head), level: String(p.level) }]);
    if (e.type === 'eval.verdict') verdict.set(Number(p.issue), [...(verdict.get(Number(p.issue)) ?? []), { head: String(p.head), confidence: String(p.confidence) }]);
  }
  const at = <T extends { head: string }>(xs: T[] | undefined, head: string) => (xs ? (xs.filter((x) => x.head === head).at(-1) ?? xs.at(-1)) : undefined);
  const out: MergedItem[] = [];
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (e.type !== 'merge.done' || t <= since.getTime() || t > now.getTime()) continue;
    const p = e.payload as { issue: number; number: number; head: string; title: string; url: string };
    out.push({ pr: p.number, issue: p.issue, title: p.title, url: p.url, at: e.ts, level: at(level.get(p.issue), p.head)?.level ?? null, confidence: at(verdict.get(p.issue), p.head)?.confidence ?? null });
  }
  return out;
}

export function waitingOnYou(events: Ev[], now = new Date(), o: { since?: Date; updates?: UpdateEntry[] } = {}): Digest {
  const t = now.getTime();
  const evs = events.filter((e) => Date.parse(e.ts) <= t);
  const title = new Map<number, string>();
  const prIssue = new Map<number, number>();
  const closed = new Set<number>();
  const issueClosedAt = new Map<number, string>();
  for (const e of evs) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'issue.seen') title.set(Number(p.issue), String(p.title));
    if (e.type === 'issue.closed') issueClosedAt.set(Number(p.issue), e.ts);
    if (e.type === 'pr.opened') prIssue.set(Number(p.number), Number(p.issue));
    if ((e.type === 'pr.closed' || e.type === 'merge.done') && typeof p.number === 'number') closed.add(p.number);
  }
  const items: WaitItem[] = [];
  const add = (kind: WaitKind, since: string, issue: number | null, pr: number | null, detail: string, extra: Partial<WaitItem> = {}) => {
    const closedAt = issue !== null && pr === null ? issueClosedAt.get(issue) : undefined;
    if (closedAt !== undefined && Date.parse(since) <= Date.parse(closedAt)) return;
    items.push({ kind, since, issue, pr, title: issue !== null ? (title.get(issue) ?? null) : null, detail, ...extra });
  };

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

  const mainTimedOut = new Map<string, { ts: string; issue: number; number: number; missing: string[] }>();
  for (const e of evs) {
    if (e.type !== 'merge.main_result') continue;
    const q = e.payload as { issue: number; number: number; sha: string; outcome: string; failed: string[] };
    if (q.outcome === 'timed_out') mainTimedOut.set(q.sha, { ts: e.ts, issue: q.issue, number: q.number, missing: q.failed });
    else mainTimedOut.delete(q.sha);
  }
  for (const [s, w] of mainTimedOut) add('main_checks_timed_out', w.ts, w.issue, w.number, `${w.missing.length ? w.missing.join(', ') : 'the required checks'} never reported on the merge commit ${s.slice(0, 12)}; check them yourself`, { sha: s });

  const answered = new Set(evs.filter((e) => e.type === 'decision.answered').map((e) => String((e.payload as { id: string }).id)));
  for (const e of evs) {
    if (e.type !== 'decision.asked') continue;
    const p = e.payload as { id: string; kind: string; issue: number | null; owner: string; question: string };
    if (answered.has(p.id) || p.kind === 'plan') continue;
    add('awaiting_decision', e.ts, p.issue, null, `@${p.owner}: ${p.question.split('\n')[0]!.slice(0, 160)}`, { decision: p.id });
  }

  const planHeld = new Map<number, { ts: string; reasons: string[]; decision: string | null }>();
  for (const e of evs) {
    const p = e.payload as { issue: number; held?: boolean; reasons?: string[]; decision?: string | null };
    if (e.type === 'plan.posted') {
      if (p.held) planHeld.set(p.issue, { ts: e.ts, reasons: p.reasons ?? [], decision: p.decision ?? null });
      else planHeld.delete(p.issue);
    } else if (e.type === 'plan.decided') planHeld.delete(p.issue);
  }
  for (const [issue, h] of planHeld) add('plan_held', h.ts, issue, null, h.reasons.length ? h.reasons.join('; ') : 'held for your approval', h.decision ? { decision: h.decision } : {});

  const needsOwner = new Map<number, { ts: string; issue: number; detail: string; reasons?: string[]; why?: { category: string; text: string }[] }>();
  const ciGaveUp = new Map<number, { ts: string; issue: number; reason: string }>();
  for (const e of evs) {
    const p = e.payload as Record<string, unknown>;
    const n = Number(p.number);
    if (e.type === 'merge.decided' && p.auto === false && !needsOwner.has(n)) needsOwner.set(n, { ts: e.ts, issue: Number(p.issue), detail: (p.reasons as string[]).join('; ') || 'left to you', ...((p.reasons as string[]).length ? { reasons: [...(p.reasons as string[])] } : {}), ...(Array.isArray(p.why) && p.why.length ? { why: p.why as { category: string; text: string }[] } : {}) });
    if (e.type === 'conflict_fix.finished' && p.outcome === 'gave_up' && p.waits_owner === true && !needsOwner.has(n)) needsOwner.set(n, { ts: e.ts, issue: Number(p.issue), detail: `conflicts with its base; no conflict fix: ${String(p.detail).split('\n')[0]!.slice(0, 160)}` });
    if (e.type === 'ci_fix.gave_up') ciGaveUp.set(n, { ts: e.ts, issue: Number(p.issue), reason: String(p.reason) });
    if (e.type === 'ci_fix.started' || e.type === 'pr.ready') ciGaveUp.delete(n);
  }
  for (const [n, w] of needsOwner) if (!closed.has(n)) add('needs_owner', w.ts, w.issue, n, w.detail, { ...(w.why ? { why: w.why } : {}), ...(w.reasons ? { reasons: w.reasons } : {}) });
  for (const [n, w] of ciGaveUp) if (!closed.has(n)) add('ci_fix_gave_up', w.ts, w.issue, n, w.reason);

  const p = project(evs as Parameters<typeof project>[0], localDay(now));
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

  const deploys = new Map<string, { ts: string; sha: string; why: string } | null>();
  for (const e of evs) {
    const q = e.payload as { env: string; sha: string; why?: string };
    if (e.type === 'deploy.failed') deploys.set(q.env, { ts: e.ts, sha: q.sha, why: String(q.why) });
    if (e.type === 'deploy.verified') deploys.set(q.env, null);
  }
  for (const [env, d] of deploys) if (d) add('deploy_failed', d.ts, null, null, `${env}: ${d.why.split('\n')[0]!.slice(0, 160)}`, { sha: d.sha });

  const latest = new Map<number, { ts: string; since: string; issue: number; head: string; held: string[] }>();
  for (const e of evs) {
    const q = e.payload as { issue: number; number: number; head: string; ready: boolean; checks: { name: string; outcome: string }[] };
    if (e.type === 'pr.ready') latest.delete(q.number);
    if (e.type !== 'pr.status') continue;
    const held = q.ready ? [] : q.checks.filter((c) => c.outcome === 'missing' || c.outcome === 'pending' || c.outcome === 'skipped').map((c) => `${c.name} ${c.outcome}`);
    const prev = latest.get(q.number);
    if (!held.length) latest.delete(q.number);
    else latest.set(q.number, { ts: e.ts, since: prev && prev.head === q.head ? prev.since : e.ts, issue: q.issue, head: q.head, held });
  }
  for (const [n, s] of latest) if (!closed.has(n)) add('check_held', s.since, s.issue, n, s.held.join(', '));

  const holds = new Map<number, { ts: string; by: number; files: string[] }>();
  for (const e of evs) {
    const q = e.payload as { issue: number; by?: number; files?: string[] };
    if (e.type === 'hotspot.held') holds.set(q.issue, { ts: e.ts, by: Number(q.by), files: q.files ?? [] });
    if (e.type === 'hotspot.released') holds.delete(q.issue);
  }
  for (const [issue, h] of holds) add('hotspot_held', h.ts, issue, null, `behind #${h.by}, on ${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ` and ${h.files.length - 3} more` : ''}`);
  const deps = new Map<number, { since: string; reason: string }>();
  for (const e of evs) {
    const q = e.payload as { issue: number; reason?: string };
    if (e.type === 'dependency.held') deps.set(q.issue, { since: deps.get(q.issue)?.since ?? e.ts, reason: String(q.reason) });
    if (e.type === 'dependency.unblocked') deps.delete(q.issue);
  }
  for (const [issue, h] of deps) add('hotspot_held', h.since, issue, null, h.reason);

  const held = heldUpdate((o.updates ?? updateLog()).filter((u) => Date.parse(u.at) <= t));
  if (held) add('update_held', held.at, null, null, `${held.reason.split('\n')[0]!.slice(0, 240)}; the commit is held until a newer one, or until an admin releases it at a root shell: ${RELEASE_HOLD}`, held.sha ? { sha: held.sha } : {});

  items.sort((a, b) => WAIT_KINDS.indexOf(a.kind) - WAIT_KINDS.indexOf(b.kind) || a.since.localeCompare(b.since));
  const since = o.since ?? new Date(now.getTime() - 86_400_000);
  // The operator inbox (#1032), added since: its own fold over the whole log read here, with this list.
  const f = inboxFold();
  for (const e of evs) inboxStep(f, e);
  const inbox = buildInbox({ prs: { ok: true, value: f }, waits: { ok: true, value: items } }, now);
  return { at: now.toISOString(), items, mergedSince: since.toISOString(), merged: mergedSince(evs, since, now), batches: batchesSince(evs, since, now), inbox };
}

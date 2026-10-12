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
}

/**
 * The PRs auto-merged after `since` (merge.done is the auto-merge path's), each with the review level and the
 * evaluator's confidence for the head it merged (or the issue's latest, where none matches the head).
 */
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

/**
 * Every owner-held state open at `now`. Each one starts at the event that opened it and stays until the event
 * that ends it: an answer, a merge or close, a resume, a later verified deploy, a release, a new head.
 * And the PRs merged on their own since the last digest (`since`; 24 hours back by default), for sampling.
 */
export function waitingOnYou(events: Ev[], now = new Date(), o: { since?: Date } = {}): Digest {
  const t = now.getTime();
  const evs = events.filter((e) => Date.parse(e.ts) <= t);
  const title = new Map<number, string>();
  const prIssue = new Map<number, number>();
  const closed = new Set<number>();
  // Issues closed by hand on GitHub (issue.closed), and when: a hold on one that began before then ended with it.
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
    // An issue's own hold (no PR of its own) ends when the issue is closed; one that began after it (reopened) stands.
    const closedAt = issue !== null && pr === null ? issueClosedAt.get(issue) : undefined;
    if (closedAt !== undefined && Date.parse(since) <= Date.parse(closedAt)) return;
    items.push({ kind, since, issue, pr, title: issue !== null ? (title.get(issue) ?? null) : null, detail, ...extra });
  };

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

  // An auto-merge whose required checks on the merge commit never reported: whether the default branch is green is
  // unknown until a later result for that commit (green; a red one is listed as auto-merge stopped).
  const mainTimedOut = new Map<string, { ts: string; issue: number; number: number; missing: string[] }>();
  for (const e of evs) {
    if (e.type !== 'merge.main_result') continue;
    const q = e.payload as { issue: number; number: number; sha: string; outcome: string; failed: string[] };
    if (q.outcome === 'timed_out') mainTimedOut.set(q.sha, { ts: e.ts, issue: q.issue, number: q.number, missing: q.failed });
    else mainTimedOut.delete(q.sha);
  }
  for (const [s, w] of mainTimedOut) add('main_checks_timed_out', w.ts, w.issue, w.number, `${w.missing.length ? w.missing.join(', ') : 'the required checks'} never reported on the merge commit ${s.slice(0, 12)}; check them yourself`, { sha: s });

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
  const since = o.since ?? new Date(now.getTime() - 86_400_000);
  return { at: now.toISOString(), items, mergedSince: since.toISOString(), merged: mergedSince(evs, since, now) };
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
  return `${out.join('\n')}\n`;
}

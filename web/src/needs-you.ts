// Needs you (#585): one queue of what waits for this person, from the three lists the tabs show (Inbox, Waiting on
// you, Decisions), each thing once, in an order computed here from their data (never by a model): first what holds an
// agent or a merge, then the rest, the oldest first in each. The sidebar's one badge is this queue's length. A module
// of its own, with no page in it, so the shell can count the queue without loading a page.
import type { State, WaitItem, WaitKind, Waiting } from './api';

/**
 * Every kind of wait: its name in the queue, and what it holds (null: nothing waits on it but you). A Record, so a
 * new kind can't reach the queue without saying whether it blocks.
 */
export const KIND: Record<WaitKind, { label: string; holds: 'every agent' | 'its agent' | 'merges' | 'its merge' | null }> = {
  emergency_halt: { label: 'Emergency stop', holds: 'every agent' },
  merge_stopped: { label: 'Auto-merge stopped', holds: 'merges' },
  awaiting_decision: { label: 'Decision', holds: 'its agent' },
  plan_held: { label: 'Plan held', holds: 'its agent' },
  blocked: { label: 'Blocked', holds: 'its agent' },
  needs_owner: { label: 'PR left to you', holds: 'its merge' },
  ci_fix_gave_up: { label: 'CI fix gave up', holds: 'its merge' },
  landing_failed: { label: 'Landing failed', holds: 'its merge' },
  check_held: { label: 'Held by a required check', holds: 'its merge' },
  main_checks_timed_out: { label: 'Checks never reported', holds: null },
  deploy_failed: { label: 'Deploy failed', holds: null },
  hotspot_held: { label: 'Held behind another task', holds: null },
  update_held: { label: 'Engine update held', holds: null },
};

const kinds = Object.keys(KIND) as WaitKind[];
const names = (blocking: boolean) => kinds.filter((k) => !!KIND[k].holds === blocking).map((k) => KIND[k].label);

/** The order, as the page states it: from KIND, so the words can't drift from the sort. */
export const ORDER = `First what holds an agent or a merge (${names(true).join(', ')}), then the rest (${names(false).join(', ')}); the oldest first in each. Sorted by the dashboard from these lists, the same way every time.`;

export interface NeedItem {
  /** One per thing: a decision's id, a blocked task's issue, or the wait itself. */
  key: string;
  kind: WaitKind;
  blocking: boolean;
  since: string;
  issue: number | null;
  pr: number | null;
  title: string | null;
  detail: string;
  /** Its own page, or null. */
  href: string | null;
}

/** Where a wait's own page is: its decision's or held PR's detail, its issue, its PR list, or its deploys. */
function hrefOf(i: Pick<WaitItem, 'kind' | 'issue' | 'pr' | 'decision'>): string | null {
  if (i.decision) return `/needs-you/decisions/${i.decision}`;
  if (i.pr !== null && (i.kind === 'needs_owner' || i.kind === 'ci_fix_gave_up')) return `/needs-you/decisions/pr-${i.pr}`;
  if (i.issue !== null) return `/work/issues/${i.issue}`;
  if (i.pr !== null) return '/work/prs';
  return i.kind === 'deploy_failed' ? '/shipping/deploys' : null;
}

const item = (key: string, i: Omit<NeedItem, 'key' | 'blocking' | 'href'> & { decision?: string }): NeedItem => ({
  key,
  kind: i.kind,
  blocking: !!KIND[i.kind].holds,
  since: i.since,
  issue: i.issue,
  pr: i.pr,
  title: i.title,
  detail: i.detail,
  href: hrefOf(i),
});

const at = (ts: string) => {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Infinity : t;
};

/**
 * The queue: every wait /api/waiting lists (null: not read, or not this person's to read), every open decision, and
 * this person's blocked tasks, each once (a decision by its id, a blocked task by its issue), blocking first, then the
 * oldest. The Inbox's L2 landings are not in it: nothing waits on them.
 */
export function needsYou(state: Pick<State, 'decisions' | 'inbox' | 'tasks'>, waiting: Pick<Waiting, 'items'> | null = null): NeedItem[] {
  const out: NeedItem[] = [];
  const seen = new Set<string>();
  const add = (n: NeedItem) => {
    if (seen.has(n.key)) return;
    seen.add(n.key);
    out.push(n);
  };
  const blockedKey = (issue: number) => `blocked:${issue}`;
  const planHeld = new Set<number>();
  // WHY: the shell keeps Waiting on you's answer up to a minute off the queue (App.tsx useWaiting), and the live state
  // is newer: a wait it shows has ended (its decision answered, its task no longer blocked) is not counted, so the badge
  // drops the moment the owner answers or unblocks.
  const answered = new Set(state.decisions.filter((d) => d.answer).map((d) => d.id));
  const status = new Map(state.tasks.map((t) => [t.issue, t.status]));
  const ended = (w: WaitItem) => (!!w.decision && answered.has(w.decision)) || ((w.kind === 'blocked' || w.kind === 'landing_failed') && w.issue !== null && status.has(w.issue) && status.get(w.issue) !== 'blocked');
  (waiting?.items ?? []).forEach((w, n) => {
    if (ended(w)) return;
    if (w.kind === 'plan_held' && w.issue !== null) planHeld.add(w.issue);
    const key = w.decision ? `decision:${w.decision}` : (w.kind === 'blocked' || w.kind === 'landing_failed') && w.issue !== null ? blockedKey(w.issue) : `wait:${n}`;
    add(item(key, w));
  });
  const title = (issue: number | null) => (issue === null ? null : (state.tasks.find((t) => t.issue === issue)?.title ?? null));
  for (const d of [...state.decisions, ...state.inbox.decisions]) {
    // A held plan's decision is the held plan (as Waiting on you lists it).
    if (d.answer || (d.kind === 'plan' && d.issue !== null && planHeld.has(d.issue))) continue;
    add(item(`decision:${d.id}`, { kind: d.kind === 'plan' ? 'plan_held' : 'awaiting_decision', since: d.askedAt, issue: d.issue, pr: null, title: title(d.issue), detail: `@${d.owner}: ${d.question.split('\n')[0]}`, decision: d.id }));
  }
  for (const t of state.inbox.blocked) add(item(blockedKey(t.issue), { kind: 'blocked', since: t.lastActivity, issue: t.issue, pr: null, title: t.title, detail: (t.blockedReason ?? '').split('\n')[0] || 'blocked' }));
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || at(a.since) - at(b.since) || a.key.localeCompare(b.key));
}

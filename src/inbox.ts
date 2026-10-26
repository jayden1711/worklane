// The operator inbox (#1032): one table of everything that waits on the operator, the first section of every digest.
// An answer about what needs the operator comes from this table, read off the event log as it stands, never from an
// agent's memory. A source that can't be read says UNREADABLE, so the table never looks empty when it isn't known to be.
//
// It reads what the digest already reads, nothing more: the open PRs and their state (inboxStep, folded beside
// Waiting on you's own fold in src/digest.ts), and the digest's own list of holds. No network call: labels are the
// issue's labels as last seen, and the merge policy's verdict is the one it recorded (merge.decided).

import { BRAND } from './brand.js';
import { WAIT_LABEL, type WaitItem, type WaitKind } from './digest.js';

/** A draft open longer than this is listed, with why it is still a draft. */
export const STALE_DRAFT_MS = 2 * 3_600_000;

interface Ev {
  type: string;
  ts: string;
  payload: unknown;
}

interface PrFact {
  issue: number;
  number: number;
  head: string;
  /** Since when it has been a draft (opened as one, or turned back into one), or null while it is ready. */
  draftSince: string | null;
  /** Why it was turned back into a draft (pr.unready), if it was. */
  draftWhy: string | null;
  /** Its latest status: ready or not, why not, and the checks that failed or were cancelled. */
  ready: boolean | null;
  reasons: string[];
  red: string[];
}

/** What the inbox reads of the log. Only inboxStep changes it. */
export interface InboxFold {
  prs: Map<number, PrFact>;
  labels: Map<number, string[]>;
  /** Each issue's review levels, by head, in order. */
  level: Map<number, { head: string; level: string }[]>;
  /** What each issue waits on: its open "Depends on" issues, or the task holding its files. */
  dependsOn: Map<number, number[]>;
  hotspotBy: Map<number, number>;
  /** The first event the fold couldn't read, if any: what it holds after it isn't known to be whole. */
  unreadable: string | null;
}

export function inboxFold(): InboxFold {
  return { prs: new Map(), labels: new Map(), level: new Map(), dependsOn: new Map(), hotspotBy: new Map(), unreadable: null };
}

/** Fold one event in, after every event before it (the log's order). */
export function inboxStep(f: InboxFold, e: Ev): void {
  try {
    step(f, e);
  } catch (err) {
    f.unreadable ??= `the ${e.type} event at ${e.ts}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function step(f: InboxFold, e: Ev): void {
  const p = e.payload as Record<string, unknown>;
  const n = Number(p.number);
  const pr = () => {
    const known = f.prs.get(n);
    if (known) return known;
    const fresh: PrFact = { issue: Number(p.issue), number: n, head: String(p.head), draftSince: null, draftWhy: null, ready: null, reasons: [], red: [] };
    f.prs.set(n, fresh);
    return fresh;
  };
  switch (e.type) {
    case 'issue.seen':
      f.labels.set(Number(p.issue), (p.labels as string[]).map(String));
      break;
    case 'review.level_set': {
      const list = f.level.get(Number(p.issue)) ?? [];
      list.push({ head: String(p.head), level: String(p.level) });
      f.level.set(Number(p.issue), list);
      break;
    }
    case 'pr.opened':
      f.prs.set(n, { issue: Number(p.issue), number: n, head: String(p.head), draftSince: p.draft === true ? e.ts : null, draftWhy: null, ready: null, reasons: [], red: [] });
      break;
    case 'pr.status': {
      const x = pr();
      const checks = p.checks as { name: string; outcome: string }[];
      x.head = String(p.head);
      x.ready = p.ready === true;
      x.reasons = (p.reasons as string[]).map(String);
      x.red = checks.filter((c) => c.outcome === 'fail' || c.outcome === 'cancelled').map((c) => `${c.name} ${c.outcome}`);
      break;
    }
    case 'pr.ready': {
      const x = pr();
      x.head = String(p.head);
      x.draftSince = null;
      x.draftWhy = null;
      break;
    }
    case 'pr.unready': {
      const x = pr();
      x.head = String(p.head);
      x.draftSince ??= e.ts;
      x.draftWhy = String(p.why);
      break;
    }
    case 'pr.closed':
    case 'merge.done':
      f.prs.delete(n);
      break;
    case 'dependency.held':
      f.dependsOn.set(Number(p.issue), (p.on as number[]).map(Number));
      break;
    case 'dependency.unblocked':
      f.dependsOn.delete(Number(p.issue));
      break;
    case 'hotspot.held':
      f.hotspotBy.set(Number(p.issue), Number(p.by));
      break;
    case 'hotspot.released':
      f.hotspotBy.delete(Number(p.issue));
      break;
  }
}

/** A source the inbox reads, or why it couldn't be read. */
export type Readable<T> = { ok: true; value: T } | { ok: false; why: string };

/** Why a row is the operator's, in the order the table lists rows. */
export const INBOX_CLASSES = ['stopped', 'decision', 'left_to_you', 'level_l3', 'red_checks', 'held', 'stale_draft', 'blocked'] as const;
export type InboxClass = (typeof INBOX_CLASSES)[number];

const CLASS_OF: Record<WaitKind, InboxClass | null> = {
  emergency_halt: 'stopped',
  merge_stopped: 'stopped',
  main_checks_timed_out: 'stopped',
  awaiting_decision: 'decision',
  plan_held: 'decision',
  needs_owner: 'left_to_you',
  ci_fix_gave_up: 'red_checks',
  blocked: 'blocked',
  landing_failed: 'blocked',
  deploy_failed: 'stopped',
  check_held: 'held',
  hotspot_held: null,
  update_held: 'stopped',
};

export interface InboxRow {
  pr: number | null;
  issue: number | null;
  classes: InboxClass[];
  /** Each reason it is the operator's, in a line. */
  why: string[];
  labels: string[];
  /** What the operator runs to act on it, when one command does; null otherwise. */
  command: string | null;
  /** The longest it has waited, for the order (ISO); null when no event dates it. */
  since: string | null;
}

/** A task that waits only on another: the chain it follows, down to the root, and what holds the root. */
export interface InboxFolded {
  issue: number;
  chain: number[];
  root: string;
}

export interface Inbox {
  at: string;
  rows: InboxRow[];
  folded: InboxFolded[];
  /** Each source that couldn't be read: the table may be missing what it holds. */
  unreadable: { source: string; why: string }[];
}

export const PR_SOURCE = 'open PRs (event log)';
export const WAITS_SOURCE = 'holds (event log)';

const line = (s: string, max = 200) => s.split('\n')[0]!.slice(0, max);

/**
 * The inbox from what has already been read: the open PRs (`prs`) and the digest's holds (`waits`). Pure: the same
 * input gives the same table, and neither input is changed.
 */
export function buildInbox(src: { prs: Readable<InboxFold>; waits: Readable<WaitItem[]> }, now: Date): Inbox {
  const unreadable: Inbox['unreadable'] = [];
  if (!src.prs.ok) unreadable.push({ source: PR_SOURCE, why: src.prs.why });
  else if (src.prs.value.unreadable) unreadable.push({ source: PR_SOURCE, why: src.prs.value.unreadable });
  if (!src.waits.ok) unreadable.push({ source: WAITS_SOURCE, why: src.waits.why });
  const f = src.prs.ok ? src.prs.value : inboxFold();
  const waits = src.waits.ok ? src.waits.value : [];
  const t = now.getTime();

  const byPr = new Map<number, InboxRow>();
  const other: InboxRow[] = [];
  const add = (r: InboxRow, c: InboxClass, why: string, since: string | null) => {
    if (!r.classes.includes(c)) r.classes.push(c);
    r.why.push(why);
    if (since !== null && (r.since === null || since < r.since)) r.since = since;
  };
  const prRow = (n: number, issue: number | null) => {
    let r = byPr.get(n);
    if (!r) byPr.set(n, (r = { pr: n, issue, classes: [], why: [], labels: [], command: null, since: null }));
    r.issue ??= issue;
    return r;
  };

  // The open PRs, from their own state: an L3 head, red checks, a draft open too long.
  for (const x of f.prs.values()) {
    const levels = f.level.get(x.issue);
    const level = (levels?.filter((l) => l.head === x.head).at(-1) ?? levels?.at(-1))?.level;
    if (level === 'L3') add(prRow(x.number, x.issue), 'level_l3', 'review level L3: you approve it before it lands', null);
    if (x.red.length) add(prRow(x.number, x.issue), 'red_checks', `red checks: ${x.red.join(', ')}`, null);
    if (x.draftSince !== null && t - Date.parse(x.draftSince) > STALE_DRAFT_MS) {
      const why = x.draftWhy ?? (x.reasons.length ? x.reasons.join('; ') : 'no status recorded');
      add(prRow(x.number, x.issue), 'stale_draft', `a draft for ${hours(t - Date.parse(x.draftSince))}: ${line(why)}`, x.draftSince);
    }
  }

  // The digest's holds: on a PR, onto its row; otherwise a row each. A task that waits only on another folds.
  const holds: number[] = [];
  for (const w of waits) {
    const c = CLASS_OF[w.kind];
    if (c === null) {
      if (w.issue !== null && !holds.includes(w.issue)) holds.push(w.issue);
      continue;
    }
    const why = `${WAIT_LABEL[w.kind]}: ${line(w.detail)}`;
    if (w.pr !== null) {
      add(prRow(w.pr, w.issue), c, why, w.since);
      continue;
    }
    const r: InboxRow = { pr: null, issue: w.issue, classes: [], why: [], labels: [], command: null, since: null };
    add(r, c, why, w.since);
    if (w.decision) r.command = `${BRAND.cli} decide ${w.decision} <option>`;
    other.push(r);
  }

  const rows = [...byPr.values(), ...other];
  for (const r of rows) {
    r.labels = r.issue !== null ? [...(f.labels.get(r.issue) ?? [])] : [];
    // One command merges it only when nothing but the operator's say holds it: ready, its checks green.
    const x = r.pr !== null ? f.prs.get(r.pr) : undefined;
    if (x && x.ready === true && x.draftSince === null && !x.red.length && r.classes.every((c) => c === 'left_to_you' || c === 'level_l3')) {
      r.command = `gh pr merge ${x.number} --merge --match-head-commit ${x.head}`;
    }
  }
  const rank = (r: InboxRow) => Math.min(...r.classes.map((c) => INBOX_CLASSES.indexOf(c)));
  rows.sort((a, b) => rank(a) - rank(b) || (a.since ?? '').localeCompare(b.since ?? '') || (a.pr ?? a.issue ?? 0) - (b.pr ?? b.issue ?? 0));

  const reasonOf = (issue: number): string => {
    const own = rows.find((r) => r.issue === issue);
    if (own) return own.why.join('; ');
    const x = [...f.prs.values()].find((p) => p.issue === issue);
    if (x?.reasons.length) return `#${x.number}: ${line(x.reasons.join('; '))}`;
    return 'nothing recorded holds it';
  };
  const folded = holds.map((issue) => {
    const chain = chainOf(f, issue);
    const root = chain.at(-1)!;
    const cycle = chain.indexOf(root) < chain.length - 1;
    return { issue, chain, root: cycle ? `a cycle at #${root}` : `root #${root}: ${reasonOf(root)}` };
  });
  return { at: now.toISOString(), rows, folded, unreadable };
}

/** What an issue waits on, followed down to the root: the first open "Depends on", else the task holding its files. */
function chainOf(f: InboxFold, issue: number): number[] {
  const chain = [issue];
  for (let at = issue; chain.length <= 64; ) {
    const next = f.dependsOn.get(at)?.[0] ?? f.hotspotBy.get(at);
    if (next === undefined) break;
    chain.push(next);
    if (chain.indexOf(next) < chain.length - 1) break;
    at = next;
  }
  return chain;
}

const hours = (ms: number) => `${Math.max(0, Math.round(ms / 3_600_000))} h`;

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** The inbox as Markdown: a table, one row per PR or hold, then the tasks that wait only on another, in one line. */
export function inboxMarkdown(i: Inbox): string[] {
  const count = i.rows.length + i.folded.length;
  const out = [`**Inbox: what waits on you** (${i.unreadable.length ? 'UNREADABLE' : count})`];
  for (const u of i.unreadable) out.push(`- **UNREADABLE**: ${cell(u.source)}: ${cell(line(u.why))}. This table may be missing what it holds; it isn't known to be empty.`);
  if (i.rows.length) {
    out.push('', '| PR | why it\'s yours | labels | merge command |', '|---|---|---|---|');
    for (const r of i.rows) {
      const subject = r.pr !== null ? `#${r.pr}${r.issue !== null ? ` for #${r.issue}` : ''}` : r.issue !== null ? `#${r.issue}` : '-';
      out.push(`| ${subject} | ${cell(r.why.join('; '))} | ${r.labels.length ? cell(r.labels.join(', ')) : '-'} | ${r.command ? `\`${r.command}\`` : '-'} |`);
    }
    if (i.folded.length) out.push('');
  } else if (!i.unreadable.length && !i.folded.length) out.push('- nothing in the event log waits on you');
  if (i.folded.length) out.push(`- Waiting only on another task (${i.folded.length}): ${i.folded.map((x) => `${x.chain.map((n) => `#${n}`).join(' -> ')}: ${cell(x.root)}`).join('; ')}`);
  return out;
}

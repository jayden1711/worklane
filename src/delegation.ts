// Gradual delegation, suggest-only. For each review category, the record of the harness's PRs in it: merged clean
// (approved unchanged), changed before merging, reverted, main went red after it, or a later fix needed. When a
// category that waits for the owner has a clean record (min_clean PRs approved unchanged and nothing bad since the
// last decision on it), the owner is asked whether to stop waiting on it, with the evidence (each PR's outcome, the
// time to approve the ones that waited for a person, and who approved them, owner or writer). A loosened category
// with a revert, a red main or a later fix is proposed for tightening again. Nothing changes without the owner:
// an answer files a review.yaml change as an issue, built into a PR the owner reviews. High-risk and safety-floor
// categories can never be loosened, and review.yaml rejects listing them as loosened. Pure.

import { LOCKED_CATEGORIES } from './review.js';

/** Never loosened: the default L3 categories, CI config and dependencies (design-level), the locked ones (review.ts). The repo's own L3 too. */
export const NEVER_LOOSEN = ['money-path', 'migration', 'auth', 'secrets', 'deploy-config', 'release-config', 'harness-config', 'guardrail-config', 'deletes-data', 'ci-config', 'dependency'] as const;

export function protectedCategories(review: { levels: { L3_human: { when: string[] } } }): Set<string> {
  return new Set<string>([...NEVER_LOOSEN, ...Object.keys(LOCKED_CATEGORIES), ...review.levels.L3_human.when]);
}

/** Why a review.yaml's `merge.loosened` is refused: every protected category listed in it. */
export function loosenedProblems(review: { levels: { L3_human: { when: string[] } }; merge: { loosened?: string[] } }): string[] {
  const p = protectedCategories(review);
  return (review.merge.loosened ?? []).filter((c) => p.has(c)).map((c) => `merge.loosened: ${c} is high-risk or a safety floor and can never be loosened`);
}

export type Outcome = 'clean' | 'changed' | 'reverted' | 'main_red' | 'later_fix';

type Ev = { id?: number; ts: string; type: string; payload: unknown };

/** Who approved a PR that waited for a person, as what, and how long after it started waiting (null: not known). */
export interface Approval {
  by: string;
  role: 'owner' | 'writer' | null;
  waitMs: number | null;
}

/** One person's approvals: how many merged unchanged, how many went wrong after (reverted, red main, a later fix). */
export interface ApproverRecord {
  by: string;
  role: 'owner' | 'writer' | null;
  approvals: number;
  unchanged: number;
  bad: number;
  medianWaitMs: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** A wait in plain words, to the nearest minute: 45m, 3h 10m, 2d 4h. */
export function waitText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

const BAD: Outcome[] = ['reverted', 'main_red', 'later_fix'];

/** Per person who approved: their approvals among `list`, sorted by login. */
function approvers(list: { approval: Approval | null; outcome: Outcome }[]): ApproverRecord[] {
  const by = new Map<string, { role: Approval['role']; outcomes: Outcome[]; waits: number[] }>();
  for (const { approval: a, outcome } of list) {
    if (!a) continue;
    const r = by.get(a.by) ?? { role: a.role, outcomes: [], waits: [] };
    r.role ??= a.role;
    r.outcomes.push(outcome);
    if (a.waitMs !== null) r.waits.push(a.waitMs);
    by.set(a.by, r);
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([login, r]) => ({ by: login, role: r.role, approvals: r.outcomes.length, unchanged: r.outcomes.filter((o) => o === 'clean').length, bad: r.outcomes.filter((o) => BAD.includes(o)).length, medianWaitMs: median(r.waits) }));
}

const who = (a: { by: string; role: Approval['role'] }) => `@${a.by}${a.role ? ` (${a.role})` : ''}`;

export interface CategoryRecord {
  category: string;
  /** Waits for the owner today (merge.wait_categories). */
  waits: boolean;
  loosened: boolean;
  protected: boolean;
  /** Counted since the last decision on this category. */
  prs: number[];
  clean: number;
  changed: number;
  reverted: number;
  mainRed: number;
  laterFix: number;
  /** PRs counted that waited for a person. */
  held: number;
  /** Time from waiting to approved, over the `count` of them where it's known (null: none). */
  wait: { medianMs: number; fastestMs: number; slowestMs: number; count: number } | null;
  /** Who approved the PRs counted, per person. */
  approvers: ApproverRecord[];
  /** Evidence lines: one per PR counted, with its outcome and, where known, who approved it and after how long. */
  evidence: string[];
}

/** A later issue's title that names a merged PR (or its issue) as what it fixes. */
const LATER_FIX = /\b(?:fix(?:es|ed)?|regression|follow[- ]?up|broke|revert)\b[^#\n]*#(\d+)/i;

/**
 * Each category's record from the log: `delegation.observed` (a merged PR, its categories and whether it merged
 * unchanged), then what happened after (a revert or red main after it, a later fix naming it), counted since the
 * last `delegation.decided` on the category.
 */
export function categoryRecords(events: Ev[], review: { levels: { L3_human: { when: string[] } }; merge: { wait_categories: string[]; loosened?: string[] } }): CategoryRecord[] {
  return records(events, review).categories;
}

type Observed = { issue: number; categories: string[]; outcome: Outcome; at: number; held: boolean; approval: Approval | null };

function records(events: Ev[], review: Parameters<typeof categoryRecords>[1]): { categories: CategoryRecord[]; observed: Map<number, Observed> } {
  const prot = protectedCategories(review);
  const waits = new Set(review.merge.wait_categories);
  const loosened = new Set(review.merge.loosened ?? []);
  const observed = new Map<number, Observed>();
  const lastDecision = new Map<string, number>();
  // What happened after a merge is applied whatever order it was logged in (a merge is observed on the next pass).
  const reverted = new Set<number>();
  const red = new Set<number>();
  const fixedLater = new Set<number>();
  let i = 0;
  for (const e of events) {
    i++;
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'delegation.observed') {
      // Older events say nothing about approval: not waiting for anyone, as far as the record knows.
      const approval: Approval | null = typeof p.approved_by === 'string' ? { by: p.approved_by, role: (p.approver_role as Approval['role'] | undefined) ?? null, waitMs: typeof p.wait_ms === 'number' ? p.wait_ms : null } : null;
      observed.set(p.pr as number, { issue: p.issue as number, categories: p.categories as string[], outcome: p.unchanged ? 'clean' : 'changed', at: i, held: p.held === true, approval });
    } else if (e.type === 'delegation.decided') lastDecision.set(p.category as string, i);
    else if (e.type === 'merge.stopped' && typeof p.number === 'number') (p.revert ? reverted : red).add(p.number);
    else if (e.type === 'merge.main_result' && p.outcome === 'red') red.add(p.number as number);
    else if (e.type === 'issue.seen') {
      const m = LATER_FIX.exec(String(p.title ?? ''));
      if (m) fixedLater.add(Number(m[1]));
    }
  }
  for (const [pr, o] of observed) {
    if (reverted.has(pr)) o.outcome = 'reverted';
    else if (red.has(pr)) o.outcome = 'main_red';
    else if (fixedLater.has(pr) || fixedLater.has(o.issue)) o.outcome = 'later_fix';
  }
  const cats = new Set<string>([...waits, ...loosened, ...[...observed.values()].flatMap((o) => o.categories)]);
  const categories = [...cats].sort().map((category) => {
    const since = lastDecision.get(category) ?? 0;
    const mine = [...observed].filter(([, o]) => o.at > since && o.categories.includes(category));
    const count = (k: Outcome) => mine.filter(([, o]) => o.outcome === k).length;
    const held = mine.filter(([, o]) => o.held);
    const waitsMs = held.flatMap(([, o]) => (o.approval?.waitMs != null ? [o.approval.waitMs] : []));
    return {
      category,
      waits: waits.has(category),
      loosened: loosened.has(category),
      protected: prot.has(category),
      prs: mine.map(([pr]) => pr),
      clean: count('clean'),
      changed: count('changed'),
      reverted: count('reverted'),
      mainRed: count('main_red'),
      laterFix: count('later_fix'),
      held: held.length,
      wait: waitsMs.length ? { medianMs: median(waitsMs)!, fastestMs: Math.min(...waitsMs), slowestMs: Math.max(...waitsMs), count: waitsMs.length } : null,
      approvers: approvers(held.map(([, o]) => o)),
      evidence: mine.map(([pr, o]) => `PR #${pr} (#${o.issue}): ${o.outcome.replace('_', ' ')}${o.held && o.approval ? `, approved by ${who(o.approval)}${o.approval.waitMs !== null ? ` after ${waitText(o.approval.waitMs)}` : ''}` : ''}`),
    };
  });
  return { categories, observed };
}

export interface Suggestion {
  category: string;
  direction: 'loosen' | 'tighten';
  question: string;
  options: string[];
  recommendation: string;
  receipts: string[];
}

/**
 * What to put to the owner now: loosen a waiting, unprotected category with at least `minClean` PRs approved unchanged
 * and no revert, red main or later fix since the last decision; tighten a loosened category that had any of those.
 * `open`: categories with a suggestion still waiting for an answer (never asked twice).
 */
export function suggestions(records: CategoryRecord[], o: { minClean: number; open: Set<string> }): Suggestion[] {
  const out: Suggestion[] = [];
  for (const r of records) {
    if (o.open.has(r.category)) continue;
    const bad = r.reverted + r.mainRed + r.laterFix;
    if (r.waits && !r.loosened && !r.protected && r.clean >= o.minClean && bad === 0 && r.changed === 0) {
      const byWho = [...r.approvers].sort((a, b) => b.approvals - a.approvals || a.by.localeCompare(b.by));
      out.push({
        category: r.category,
        direction: 'loosen',
        question: `Stop waiting for you on ${r.category} changes? ${r.clean} PRs in a row were approved unchanged${r.wait ? ` (median time to approve ${waitText(r.wait.medianMs)})` : ''}`,
        options: ['loosen', 'keep'],
        recommendation: 'loosen',
        receipts: [
          `${r.clean} PRs in ${r.category} merged as proposed, none reverted, main never went red after one, no later fix`,
          ...(r.wait ? [`Time to approve: median ${waitText(r.wait.medianMs)} over the ${r.wait.count} PRs that waited for a person (fastest ${waitText(r.wait.fastestMs)}, slowest ${waitText(r.wait.slowestMs)})`] : []),
          ...(byWho.length ? [`Approved unchanged, by who approved: ${byWho.map((a) => `${who(a)} ${a.unchanged} of ${a.approvals}`).join(', ')}`] : []),
          ...r.evidence.slice(-20),
          'loosen:files a review.yaml change (out of merge.wait_categories, into merge.loosened) as a PR you review; keep: nothing changes, asked again after as many more clean PRs'],
      });
    } else if (r.loosened && !r.waits && bad > 0) {
      out.push({
        category: r.category,
        direction: 'tighten',
        question: `Wait for you on ${r.category} changes again? Since it was loosened: ${[r.reverted && `${r.reverted} reverted`, r.mainRed && `${r.mainRed} turned main red`, r.laterFix && `${r.laterFix} needed a later fix`].filter(Boolean).join(', ')}`,
        options: ['tighten', 'keep'],
        recommendation: 'tighten',
        receipts: [...r.evidence.slice(-20), 'tighten: files a review.yaml change (back into merge.wait_categories, out of merge.loosened) as a PR you review; keep: nothing changes'],
      });
    }
  }
  return out;
}

/**
 * A command that passes only once review.yaml has `category` out of merge.wait_categories and in merge.loosened
 * (loosen), or the other way round (tighten): it fails on the unchanged file. Reads flow (`[a, b]`) and block
 * (`- a`) lists. Shell-safe on POSIX and Windows: double-quoted, with no backslash, `$` or double quote inside.
 */
export function reviewListCheck(file: string, category: string, direction: 'loosen' | 'tighten'): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(category)) throw new Error(`category ${category} has characters a check can't quote`);
  const ok = direction === 'loosen' ? `!w.includes('${category}')&&l.includes('${category}')` : `w.includes('${category}')&&!l.includes('${category}')`;
  return (
    `node -e "const t=require('fs').readFileSync('${file}','utf8').split(String.fromCharCode(10));let k='';const w=[],l=[];` +
    `for(const r of t){const s=r.split('#')[0].replace(String.fromCharCode(13),'');const m=s.match(/^ +(wait_categories|loosened): *(.*)/);` +
    `if(m){k=m[1];for(const x of m[2].replace('[','').replace(']','').split(',')){const y=x.trim();if(y)(k==='loosened'?l:w).push(y)}if(m[2].trim())k='';continue}` +
    `const d=s.match(/^ +- *(.+)/);if(k&&d)(k==='loosened'?l:w).push(d[1].trim());else if(s.trim())k=''}` +
    `process.exit(${ok}?0:1)"`
  );
}

/** The five-part issue for an answer: the review.yaml change, built into a PR the owner reviews. */
export function delegationIssue(category: string, direction: 'loosen' | 'tighten', configDir: string, evidence: string[]): { title: string; body: string } {
  const file = `${configDir}/review.yaml`;
  const loosen = direction === 'loosen';
  return {
    title: loosen ? `Review: stop waiting for the owner on ${category} changes` : `Review: wait for the owner on ${category} changes again`,
    body: [
      `**Outcome:** ${loosen ? `${category} is no longer in merge.wait_categories and is listed in merge.loosened` : `${category} is back in merge.wait_categories and no longer in merge.loosened`} in ${file}.`,
      `**Sources:** ${file} only.`,
      '**Constraints:** Change only merge.wait_categories and merge.loosened for this one category; nothing else in the file.',
      '**Deliverable:**',
      '```done_when',
      '- command: |',
      `    ${reviewListCheck(file, category, direction)}`,
      '```',
      `**Review point:** L3 (harness-config): waits for the owner, who answered ${direction} on the evidence below.`,
      '',
      'Evidence:',
      ...evidence.slice(-20).map((e) => `- ${e}`),
    ].join('\n'),
  };
}

/**
 * The dashboard's view: every category's record, each person's approvals across every category (all time, not since
 * a decision: the per-writer history), and each suggestion with its evidence and answer. Read-only.
 */
export interface DelegationView {
  categories: CategoryRecord[];
  approvers: (ApproverRecord & { categories: string[] })[];
  suggestions: { category: string; direction: 'loosen' | 'tighten'; at: string; decision: string; receipts: string[]; answer: string | null; by: string | null; issue: number | null }[];
}

export function delegationView(events: Ev[], review: Parameters<typeof categoryRecords>[1]): DelegationView {
  const sugg: DelegationView['suggestions'] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'delegation.suggested') sugg.push({ category: p.category as string, direction: p.direction as 'loosen' | 'tighten', at: e.ts, decision: p.decision as string, receipts: p.receipts as string[], answer: null, by: null, issue: null });
    else if (e.type === 'delegation.decided') {
      const s = sugg.find((x) => x.decision === p.decision);
      if (s) Object.assign(s, { answer: p.answer, by: p.by, issue: p.issue ?? null });
    }
  }
  const { categories, observed } = records(events, review);
  const held = [...observed.values()].filter((o) => o.held);
  const cats = (login: string) => [...new Set(held.filter((o) => o.approval?.by === login).flatMap((o) => o.categories))].sort();
  return { categories, approvers: approvers(held).map((a) => ({ ...a, categories: cats(a.by) })), suggestions: sugg.reverse() };
}

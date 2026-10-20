// The value report (#708): from the event log alone, for a window, how many PRs the engine merged on its own and
// how many it held; why it held them, by kind; what became of the held ones; an estimate of review hours saved,
// labeled as one, with its formula and constants, and whether those are the owner's (policy.yaml) or the defaults;
// and what went wrong after merges, split by auto-merged and
// merged by a person. Pure and read-only: it never writes an event or changes policy.
//
// Only events it can parse count. An event of a kind it reads that fails its schema (src/events/types.ts) is counted
// as unreadable and skipped. Skipping alone is not enough: a garbled hold between an auto decision and the merge would
// leave the auto decision standing. So a garbled merge.decided or merge.done that still names its PR (an integer
// `number`) makes that PR unsure: in neither the auto-merged nor the held count, never in hours saved or spend. One
// that names no PR can't be pinned to any; it shows only in the unreadable count.
import { EventSchemas, type EventPayload, type EventType } from './events/types.js';
import { HOLD_KINDS, holdWords } from './hold-words.js';
import type { ConstantsFrom, HeldOutcome, HoldKind, MainSaid, PostMerge, ValueConstants, ValueReport } from './value-report-types.js';

export type { ConstantsFrom, HeldOutcome, HoldKind, MainSaid, PostMerge, ValueConstants, ValueReport } from './value-report-types.js';

/** An event as the log or its cache hands it over: its payload is checked here, not trusted. */
export interface ValueEvent {
  ts: string;
  type: string;
  payload: unknown;
}

/** The estimate's default constants: guesses until calibrated (#708). An owner sets their own in policy.yaml. */
export const DEFAULT_VALUE_CONSTANTS: Readonly<ValueConstants> = Object.freeze({ base_min: 10, per_100_lines_min: 5, cap_min: 60 });

/** The constants an estimate uses, and where they came from (the report says which). */
export interface Estimate {
  constants: ValueConstants;
  from: ConstantsFrom;
}

export const HOURS_SAVED_FORMULA = 'est_review_hours_saved = Σ over PRs the engine auto-merged in the window of min(cap_min, base_min + per_100_lines_min × changed_lines / 100) / 60, changed_lines = additions + deletions (pr.stats)';
export const HOURS_SAVED_LABEL = 'an estimate (a guess until calibrated), not a measurement: the owner\'s time on held PRs and the cost of post-merge failures are shown beside it, not subtracted';

/** The windows the report is asked for, in days. */
export const VALUE_WINDOWS: readonly number[] = [7, 30, 90];

/** The kill switch's kinds: auto-merge off for the instance (policy.yaml) or for the repo (review.yaml). */
export const KILL_SWITCH_KINDS: readonly HoldKind[] = Object.freeze(['policy-off', 'repo-off']);

/**
 * A reason's kind, by the one prefix table (src/hold-words.ts, #706; its test scans every source of hold reasons).
 * Anything it doesn't name is `other`: counted, never dropped.
 */
export const holdKind = (reason: string): HoldKind => holdWords(reason, { local: false }).kind;
const KIND_ORDER: readonly HoldKind[] = [...HOLD_KINDS, 'other'];

/** The kinds this report reads; any other event is ignored, never counted as unreadable. */
const READS = ['merge.decided', 'merge.done', 'pr.closed', 'pr.stats', 'run.cost', 'merge.main_result', 'merge.stopped', 'main_watch.checked', 'main_watch.unaccounted', 'fix_forward.finished'] as const satisfies readonly EventType[];
type Read = (typeof READS)[number];
const reads = new Set<string>(READS);
/** The kinds that decide whether a PR was auto-merged: garbled, they leave their PR unsure. */
const DECIDES = new Set<string>(['merge.decided', 'merge.done'] satisfies Read[]);

type Parsed = { [T in Read]: { t: number; type: T; p: EventPayload<T> } }[Read];

/** The event, checked against its schema; null when it is unreadable. */
function parse(e: ValueEvent): Parsed | null {
  const t = Date.parse(e.ts);
  if (!Number.isFinite(t)) return null;
  const r = EventSchemas[e.type as Read].safeParse(e.payload);
  return r.success ? ({ t, type: e.type, p: r.data } as Parsed) : null;
}

interface Pr {
  number: number;
  issue: number;
  /** The last readable decision, its time, and the reasons of the last hold. */
  last: { t: number; auto: boolean } | null;
  firstHold: number | null;
  heldReasons: string[] | null;
  /** The engine's merge: on an auto decision, or on a person's approval of a hold. */
  engineMerge: { t: number; sha: string; auto: boolean } | null;
  closed: { t: number; merged: boolean } | null;
  lines: number | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const emptyPost = (): PostMerge => ({ merged: 0, mainRed: 0, reverts: 0, fixForward: { fixed: 0, reverted: 0, gave_up: 0 } });

export function valueReport(events: readonly ValueEvent[], o: { now: Date; days: number; estimate?: Estimate }): ValueReport {
  const { constants: c, from } = o.estimate ?? { constants: DEFAULT_VALUE_CONSTANTS, from: 'default' };
  const until = o.now.getTime();
  const since = until - o.days * 86_400_000;
  let unreadable = 0;
  const prs = new Map<number, Pr>();
  const pr = (number: number, issue: number): Pr => {
    let x = prs.get(number);
    if (!x) prs.set(number, (x = { number, issue, last: null, firstHold: null, heldReasons: null, engineMerge: null, closed: null, lines: null }));
    return x;
  };
  const costByIssue = new Map<number, number>();
  const shaToPr = new Map<string, number>();
  const red = new Set<number>();
  const green = new Set<number>();
  const reverted = new Set<number>();
  const fixForward: { pr: number | null; sha: string; outcome: 'fixed' | 'reverted' | 'gave_up' }[] = [];
  /** PRs a garbled decision or merge names: whether the engine merged them on its own can't be told. */
  const unsure = new Set<number>();

  for (const raw of events) {
    if (!reads.has(raw.type)) continue;
    const e = parse(raw);
    if (!e) {
      unreadable++;
      const n = DECIDES.has(raw.type) && typeof raw.payload === 'object' && raw.payload !== null ? (raw.payload as { number?: unknown }).number : undefined;
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) unsure.add(n);
      continue;
    }
    switch (e.type) {
      case 'merge.decided': {
        const x = pr(e.p.number, e.p.issue);
        x.last = { t: e.t, auto: e.p.auto };
        if (!e.p.auto) {
          x.firstHold ??= e.t;
          x.heldReasons = e.p.reasons;
        }
        break;
      }
      case 'merge.done': {
        const x = pr(e.p.number, e.p.issue);
        // Auto only on a readable auto decision before it: no decision, or a hold, is never counted as auto.
        x.engineMerge = { t: e.t, sha: e.p.sha, auto: x.last?.auto === true };
        shaToPr.set(e.p.sha, e.p.number);
        break;
      }
      case 'pr.closed':
        pr(e.p.number, e.p.issue).closed = { t: e.t, merged: e.p.merged };
        break;
      case 'pr.stats':
        pr(e.p.number, e.p.issue).lines = e.p.additions + e.p.deletions;
        break;
      case 'run.cost':
        if (e.p.issue !== null) costByIssue.set(e.p.issue, (costByIssue.get(e.p.issue) ?? 0) + e.p.usd);
        break;
      case 'merge.main_result':
        shaToPr.set(e.p.sha, e.p.number);
        if (e.p.outcome === 'red') red.add(e.p.number);
        else if (e.p.outcome === 'green') green.add(e.p.number);
        break;
      case 'main_watch.checked':
        shaToPr.set(e.p.sha, e.p.number);
        green.add(e.p.number);
        break;
      case 'main_watch.unaccounted':
        if (e.p.number === null) break;
        shaToPr.set(e.p.sha, e.p.number);
        red.add(e.p.number);
        if (e.p.revert) reverted.add(e.p.number);
        break;
      case 'merge.stopped':
        if (e.p.number !== null && e.p.revert) reverted.add(e.p.number);
        break;
      case 'fix_forward.finished':
        fixForward.push({ pr: e.p.culprit, sha: e.p.sha, outcome: e.p.outcome });
        break;
    }
  }
  for (const f of fixForward) {
    const n = f.pr ?? shaToPr.get(f.sha) ?? null;
    if (n !== null && f.outcome === 'reverted') reverted.add(n);
  }

  const mainSaid = (n: number): MainSaid => (reverted.has(n) ? 'reverted' : red.has(n) ? 'red' : green.has(n) ? 'green' : 'none');
  const outcomeOf = (x: Pr): HeldOutcome => (x.engineMerge ? 'approved' : x.closed?.merged ? 'merged_by_person' : x.closed ? 'closed' : 'waiting');

  const decidedInWindow = [...prs.values()].filter((x) => x.last && x.last.t >= since && x.last.t <= until);
  const unsureInWindow = decidedInWindow.filter((x) => unsure.has(x.number));
  const inWindow = decidedInWindow.filter((x) => !unsure.has(x.number));
  const auto = inWindow.filter((x) => x.last!.auto && x.engineMerge?.auto === true);
  const autoNotMerged = inWindow.filter((x) => x.last!.auto && x.engineMerge?.auto !== true);
  const held = inWindow.filter((x) => !x.last!.auto);

  const kinds = new Map<HoldKind, number>();
  for (const x of held) for (const k of new Set((x.heldReasons ?? []).map(holdKind))) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  const heldOutcomes: Record<HeldOutcome, number> = { approved: 0, merged_by_person: 0, closed: 0, waiting: 0 };
  for (const x of held) heldOutcomes[outcomeOf(x)]++;
  const waits = held.flatMap((x) => {
    const end = x.engineMerge?.t ?? x.closed?.t;
    return end !== undefined && x.firstHold !== null && end >= x.firstHold ? [end - x.firstHold] : [];
  });

  const killSwitch = held.filter((x) => x.heldReasons?.length && x.heldReasons.every((r) => KILL_SWITCH_KINDS.includes(holdKind(r))));

  const measured = auto.filter((x) => x.lines !== null);
  const minutes = measured.reduce((s, x) => s + Math.min(c.cap_min, c.base_min + (c.per_100_lines_min * x.lines!) / 100), 0);

  const autoIssues = new Set(auto.map((x) => x.issue));
  const usd = [...autoIssues].reduce((s, i) => s + (costByIssue.get(i) ?? 0), 0);

  const post = (group: Pr[]): PostMerge => {
    const p = emptyPost();
    const ns = new Set(group.map((x) => x.number));
    p.merged = ns.size;
    for (const n of ns) {
      if (red.has(n)) p.mainRed++;
      if (reverted.has(n)) p.reverts++;
    }
    for (const f of fixForward) {
      const n = f.pr ?? shaToPr.get(f.sha);
      if (n !== undefined && ns.has(n)) p.fixForward[f.outcome]++;
    }
    return p;
  };
  const byPerson = held.filter((x) => x.engineMerge || x.closed?.merged);

  return {
    window: { days: o.days, since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    unreadable,
    counts: { auto: auto.length, held: held.length, autoNotMerged: autoNotMerged.length, unsure: unsureInWindow.length, holdRate: held.length + auto.length ? held.length / (held.length + auto.length) : null },
    heldByKind: KIND_ORDER.filter((k) => kinds.has(k)).map((k) => ({ kind: k, prs: kinds.get(k)! })),
    heldOutcomes,
    heldWait: { medianMs: median(waits), resolved: waits.length },
    wouldHaveMerged: { count: killSwitch.length, prs: killSwitch.map((x) => ({ number: x.number, outcome: outcomeOf(x), main: mainSaid(x.number) })) },
    hoursSaved: { estimate: minutes / 60, prs: measured.length, withoutStats: auto.length - measured.length, formula: HOURS_SAVED_FORMULA, constants: { ...c }, constantsFrom: from, label: HOURS_SAVED_LABEL },
    spend: { usd, perAutoPr: auto.length ? usd / auto.length : null },
    postMerge: { auto: post(auto), person: post(byPerson) },
  };
}

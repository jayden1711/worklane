// WHY (#741): after "File one" the first-run page said one line and a link, and then nothing for the 15-60 minutes
// (a guess: nothing times it) until a PR showed up somewhere else. This folds the event log the engine already keeps
// into the stages of that one issue: claimed, the worker, the evaluator, the PR, its checks, then merged or held (and
// why, in src/hold-words.ts's plain words). Only recorded events count: a stage with no event is "waiting", never
// guessed done. Each stage not done yet carries an estimate that says where its number comes from (the coordinator's
// tick, or the median of earlier tasks here), or that there is none yet.
import type { StoredEvent } from './events/types.js';
import { holdsInWords, type HoldWords } from './hold-words.js';

/** The coordinator's tick (src/service.ts runSite): it looks for work every 60 s, plus up to 5 s. test/first-task-progress.test.ts reads service.ts to keep these equal. */
export const COORDINATOR_TICK_MS = 60_000;
export const COORDINATOR_TICK_JITTER_MS = 5_000;

/** The dashboard's audit action recorded when the first-run form files an issue (src/dashboard.ts). */
export const FIRST_TASK_FILED = 'first_run.first_task_filed';

export type StageId = 'claimed' | 'worker' | 'evaluator' | 'pr' | 'checks' | 'merge';
export type StageState = 'waiting' | 'running' | 'done' | 'failed' | 'held';

/** How long a stage may take, and where that comes from. `basis` none: no number at all, and `text` says why. */
export interface Estimate {
  basis: 'tick' | 'median' | 'guess' | 'none';
  text: string;
}

export interface Stage {
  id: StageId;
  title: string;
  state: StageState;
  /** What the events say, in a line. */
  detail: string;
  /** When the event that set this state was recorded; null while waiting. */
  at: string | null;
  /** Only on a stage not done yet. */
  estimate: Estimate | null;
}

export interface FirstTaskProgress {
  issue: number;
  /** The issue's title as the coordinator saw it; null before it has. */
  title: string | null;
  filedAt: string;
  /** The PR the harness opened for this issue (its own pr.opened), with its link when that is an https URL ending in the PR's number. */
  pr: { number: number; url: string | null } | null;
  stages: Stage[];
  /** The issue is blocked (after its latest claim): the first line of why, as the Board shows it. */
  blocked: { why: string; at: string } | null;
  /** A question about this issue waits for an answer (on Decisions). */
  question: { at: string } | null;
  /** The held PR's reasons in plain words; empty unless the merge stage is held. */
  holds: HoldWords[];
  outcome: 'open' | 'merged' | 'held' | 'closed' | 'landed' | 'blocked';
}

type P = Record<string, unknown>;
const pl = (e: StoredEvent) => e.payload as unknown as P;
const issueOf = (e: StoredEvent): number | null => (typeof pl(e).issue === 'number' ? (pl(e).issue as number) : null);
const ms = (ts: string) => Date.parse(ts);

/** The latest first-task filing in the audit: its issue and when; null when the form has filed none. */
export function firstTaskFiled(events: readonly StoredEvent[]): { issue: number; id: number; at: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'dashboard.audit') continue;
    const p = pl(e);
    if (p.action !== FIRST_TASK_FILED) continue;
    const n = (p.detail as P | undefined)?.issue;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return { issue: n, id: e.id, at: e.ts };
  }
  return null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** A duration as a person reads it: seconds, minutes or hours, rounded. */
export const duration = (d: number) => (d < 90_000 ? `${Math.max(1, Math.round(d / 1000))} s` : d < 90 * 60_000 ? `${Math.round(d / 60_000)} min` : `${Math.round((d / 3_600_000) * 10) / 10} h`);

const fromMedian = (xs: number[], what: string, none: string): Estimate => {
  const m = median(xs);
  return m === null ? { basis: 'none', text: none } : { basis: 'median', text: `about ${duration(m)}: the median of ${xs.length} earlier ${what}${xs.length === 1 ? '' : 's'} here` };
};

/**
 * How long each stage took on earlier tasks here (every issue but `skip`), from their events: a worker run that
 * succeeded (start to finish), the evaluator (the worker's finish to its verdict), the PR (the verdict to pr.opened),
 * and CI (the engine's own ci.pr_timing wall time).
 */
function earlier(events: readonly StoredEvent[], skip: number, skipPr: number | null) {
  const started = new Map<number, number>();
  const finished = new Map<number, number>();
  const verdict = new Map<number, number>();
  const worker: number[] = [];
  const evaluator: number[] = [];
  const pr: number[] = [];
  const checks: number[] = [];
  for (const e of events) {
    if (e.type === 'ci.pr_timing') {
      const w = pl(e).wall_ms;
      if (typeof w === 'number' && w > 0 && pl(e).number !== skipPr) checks.push(w);
      continue;
    }
    const n = issueOf(e);
    if (n === null || n === skip) continue;
    const p = pl(e);
    if (e.type === 'run.started' && p.role === 'worker') started.set(n, ms(e.ts));
    else if (e.type === 'run.finished' && p.role === 'worker' && p.reason === 'succeeded' && started.has(n)) {
      worker.push(ms(e.ts) - started.get(n)!);
      started.delete(n);
      finished.set(n, ms(e.ts));
    } else if (e.type === 'eval.verdict' && finished.has(n)) {
      evaluator.push(ms(e.ts) - finished.get(n)!);
      finished.delete(n);
      verdict.set(n, ms(e.ts));
    } else if (e.type === 'pr.opened' && verdict.has(n)) {
      pr.push(ms(e.ts) - verdict.get(n)!);
      verdict.delete(n);
    }
  }
  const pos = (xs: number[]) => xs.filter((x) => Number.isFinite(x) && x >= 0);
  return { worker: pos(worker), evaluator: pos(evaluator), pr: pos(pr), checks };
}

/**
 * A PR's link only when it is GitHub's https page of exactly that PR in this project's repo (`repo`, owner/name;
 * null: any repo's): never a script URL, another host, another repo or another PR. Anything else: no link (the
 * number is still shown).
 */
function prLink(url: unknown, number: number, repo: string | null): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '').toLowerCase();
    const ok = u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && (repo ? path === `/${repo.toLowerCase()}/pull/${number}` : /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(path) && path.endsWith(`/pull/${number}`));
    return ok ? `https://github.com${u.pathname.replace(/\/$/, '')}` : null;
  } catch {
    return null;
  }
}

const firstLine = (s: unknown, max = 200) => {
  const l = String(s ?? '').split('\n')[0]!.trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

/**
 * The first task's progress: the latest issue the first-run form filed, followed through its events (only those
 * recorded after it was filed, and only its own: the PR is the one the harness opened for it, and the merge events
 * are that PR's). null when the form has filed none. `local`: a checkout's dashboard (no instance), for the hold words;
 * `repo`: the project's owner/name, the only repo whose PR page is linked.
 */
export function firstTaskProgress(events: readonly StoredEvent[], o: { local: boolean; repo?: string | null }): FirstTaskProgress | null {
  const filed = firstTaskFiled(events);
  if (!filed) return null;
  const n = filed.issue;
  const mine = events.filter((e) => e.id > filed.id && issueOf(e) === n);
  const last = (pred: (e: StoredEvent) => boolean) => {
    for (let i = mine.length - 1; i >= 0; i--) if (pred(mine[i]!)) return mine[i]!;
    return null;
  };
  const after = (e: StoredEvent | null, than: StoredEvent | null) => !!e && (!than || e.id > than.id);

  const seen = last((e) => e.type === 'issue.seen');
  const claim = last((e) => e.type === 'issue.claimed');
  const wStart = last((e) => e.type === 'run.started' && pl(e).role === 'worker');
  const wEnd = last((e) => e.type === 'run.finished' && pl(e).role === 'worker');
  // A verdict counts only for the worker's latest attempt: a retry makes an earlier one stale.
  const verdict = last((e) => e.type === 'eval.verdict' && after(e, wStart));
  const opened = last((e) => e.type === 'pr.opened');
  const prNumber = opened ? (pl(opened).number as number) : null;
  const past = earlier(events, n, prNumber);
  const ofPr = (type: string) => (prNumber === null ? null : last((e) => e.type === type && pl(e).number === prNumber));
  const status = ofPr('pr.status');
  const decided = ofPr('merge.decided');
  const merged = ofPr('merge.done');
  const closed = ofPr('pr.closed');
  const failedMerge = ofPr('merge.failed');
  const landed = last((e) => e.type === 'land.result' && pl(e).outcome === 'landed');
  const block = last((e) => e.type === 'issue.blocked');
  const blocked = block && after(block, claim) && after(block, wStart) ? { why: firstLine(pl(block).why), at: block.ts } : null;
  const answered = new Set(events.filter((e) => e.type === 'decision.answered').map((e) => pl(e).id));
  const asked = last((e) => e.type === 'decision.asked' && !answered.has(pl(e).id));

  const stages: Stage[] = [];
  const waiting = (id: StageId, title: string, detail: string, estimate: Estimate | null): Stage => ({ id, title, state: 'waiting', detail, at: null, estimate });

  // Claimed.
  stages.push(
    claim
      ? { id: 'claimed', title: 'Claimed', state: 'done', detail: 'the coordinator took it', at: claim.ts, estimate: null }
      : waiting('claimed', 'Claimed', 'not claimed yet: the coordinator takes it on a tick while it is running', { basis: 'tick', text: `within about ${Math.round((COORDINATOR_TICK_MS + COORDINATOR_TICK_JITTER_MS) / 1000)} s of the coordinator running: it looks for work every ${COORDINATOR_TICK_MS / 1000} s, plus up to ${COORDINATOR_TICK_JITTER_MS / 1000} s` }),
  );
  // The worker.
  const workerEst = fromMedian(past.worker, 'worker run', 'no estimate yet: no worker run here has finished');
  if (!wStart) stages.push(waiting('worker', 'Worker', 'not started yet', workerEst));
  else if (after(wEnd, wStart)) {
    const reason = String(pl(wEnd!).reason);
    stages.push(reason === 'succeeded' ? { id: 'worker', title: 'Worker', state: 'done', detail: 'finished its change', at: wEnd!.ts, estimate: null } : { id: 'worker', title: 'Worker', state: 'failed', detail: `its run ended: ${reason.replace(/_/g, ' ')}`, at: wEnd!.ts, estimate: null });
  } else stages.push({ id: 'worker', title: 'Worker', state: 'running', detail: `attempt ${Number(pl(wStart).attempt) || 1} started; no finish recorded yet`, at: wStart.ts, estimate: workerEst });
  // The evaluator.
  const evalEst = fromMedian(past.evaluator, 'evaluation', 'no estimate yet: no earlier task here has had a verdict');
  if (verdict) {
    const v = pl(verdict);
    const ok = v.patch_correct === true && v.test_correct === true;
    stages.push({ id: 'evaluator', title: 'Evaluator', state: ok ? 'done' : 'failed', detail: ok ? `approved, confidence ${String(v.confidence)}` : `did not approve it (confidence ${String(v.confidence)})`, at: verdict.ts, estimate: null });
  } else stages.push(waiting('evaluator', 'Evaluator', 'no verdict yet: it checks the worker\'s change once the worker finishes', evalEst));
  // The PR.
  const prEst = past.pr.length ? fromMedian(past.pr, 'PR', '') : { basis: 'guess' as const, text: '15-60 minutes from the claim to a PR; nothing here has timed one yet' };
  const link = opened ? prLink(pl(opened).url, prNumber!, o.repo ?? null) : null;
  if (opened) stages.push({ id: 'pr', title: 'PR opened', state: 'done', detail: `PR #${prNumber}`, at: opened.ts, estimate: null });
  else if (landed) stages.push({ id: 'pr', title: 'PR opened', state: 'done', detail: 'no PR: landed directly on the default branch', at: landed.ts, estimate: null });
  else stages.push(waiting('pr', 'PR opened', 'no PR yet: one opens after the evaluator approves', prEst));
  // Its checks.
  const checksEst = fromMedian(past.checks, 'PR check run', 'no estimate yet: no PR here has had its checks timed');
  if (!opened) stages.push(waiting('checks', 'Checks', landed ? 'none: no PR' : 'after the PR opens', landed ? null : checksEst));
  else if (!status) stages.push(waiting('checks', 'Checks', 'no check results recorded yet', checksEst));
  else {
    const s = pl(status);
    const checks = Array.isArray(s.checks) ? (s.checks as { outcome?: unknown }[]) : [];
    const count = (o: string) => checks.filter((c) => c.outcome === o).length;
    const fail = count('fail') + count('cancelled');
    const pending = count('pending') + count('missing');
    const said = `${count('pass')} passed${fail ? `, ${fail} failed` : ''}${pending ? `, ${pending} pending` : ''}`;
    if (s.ready === true) stages.push({ id: 'checks', title: 'Checks', state: 'done', detail: `required checks green (${said})`, at: status.ts, estimate: null });
    else if (fail) stages.push({ id: 'checks', title: 'Checks', state: 'failed', detail: said, at: status.ts, estimate: null });
    else stages.push({ id: 'checks', title: 'Checks', state: 'running', detail: checks.length ? said : 'not ready yet', at: status.ts, estimate: checksEst });
  }
  // Merged, or held and why.
  let holds: HoldWords[] = [];
  let outcome: FirstTaskProgress['outcome'] = 'open';
  if (merged || (closed && pl(closed).merged === true)) {
    stages.push({ id: 'merge', title: 'Merged', state: 'done', detail: merged ? 'merged' : 'merged on GitHub', at: (merged ?? closed)!.ts, estimate: null });
    outcome = 'merged';
  } else if (closed) {
    stages.push({ id: 'merge', title: 'Merged', state: 'failed', detail: 'the PR was closed without merging', at: closed.ts, estimate: null });
    outcome = 'closed';
  } else if (!opened && landed) {
    stages.push({ id: 'merge', title: 'Merged', state: 'done', detail: 'landed on the default branch', at: landed.ts, estimate: null });
    outcome = 'landed';
  } else if (failedMerge && after(failedMerge, decided)) {
    stages.push({ id: 'merge', title: 'Merged', state: 'failed', detail: 'the last merge try failed', at: failedMerge.ts, estimate: null });
  } else if (decided && pl(decided).auto === false) {
    holds = holdsInWords(Array.isArray(pl(decided).reasons) ? (pl(decided).reasons as unknown[]).map(String) : [], { local: o.local });
    stages.push({ id: 'merge', title: 'Merged', state: 'held', detail: 'held: it waits for you', at: decided.ts, estimate: { basis: 'none', text: 'no estimate: it waits until a person merges it' } });
    outcome = 'held';
  } else if (decided) {
    stages.push({ id: 'merge', title: 'Merged', state: 'running', detail: 'the merge policy will merge it', at: decided.ts, estimate: { basis: 'none', text: 'no estimate: it merges on a later pass of the PR watch' } });
  } else stages.push(waiting('merge', 'Merged', opened ? 'no merge decision yet: it comes once the checks are green' : 'after the PR', null));
  if (blocked && outcome === 'open') outcome = 'blocked';

  return {
    issue: n,
    title: seen && typeof pl(seen).title === 'string' ? (pl(seen).title as string) : null,
    filedAt: filed.at,
    pr: prNumber === null ? null : { number: prNumber, url: link },
    stages,
    blocked,
    question: asked ? { at: asked.ts } : null,
    holds,
    outcome,
  };
}

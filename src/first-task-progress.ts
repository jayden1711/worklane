// WHY (#741): the first-run page's First task card. Folds the filed issue's own events into its stages; a stage with
// no event is waiting, never guessed done. Each estimate names its basis: the tick, a labelled guess, or none.
import type { StoredEvent } from './events/types.js';
import { holdsInWords, type HoldWords } from './hold-words.js';

/** src/service.ts runSite's tick: 60 s plus up to 5 s (test/first-task-progress.test.ts keeps them equal). */
export const COORDINATOR_TICK_MS = 60_000;
export const COORDINATOR_TICK_JITTER_MS = 5_000;
/** The audit action src/dashboard.ts records when the first-run form files an issue. */
export const FIRST_TASK_FILED = 'first_run.first_task_filed';

export type StageId = 'claimed' | 'worker' | 'evaluator' | 'pr' | 'checks' | 'merge';
export type StageState = 'waiting' | 'running' | 'done' | 'failed' | 'held';
export interface Estimate {
  basis: 'tick' | 'guess' | 'none';
  text: string;
}
export interface Stage {
  id: StageId;
  title: string;
  state: StageState;
  detail: string;
  at: string | null;
  estimate: Estimate | null;
}
export interface FirstTaskProgress {
  issue: number;
  title: string | null;
  filedAt: string;
  pr: { number: number; url: string | null } | null;
  stages: Stage[];
  blocked: { why: string; at: string } | null;
  question: { at: string } | null;
  holds: HoldWords[];
  outcome: 'open' | 'merged' | 'held' | 'closed' | 'landed' | 'blocked';
}

type E = StoredEvent | null | undefined;
const pl = (e: StoredEvent) => e.payload as unknown as Record<string, unknown>;
const issueOf = (e: StoredEvent) => (typeof pl(e).issue === 'number' ? (pl(e).issue as number) : null);
const TITLE: Record<StageId, string> = { claimed: 'Claimed', worker: 'Worker', evaluator: 'Evaluator', pr: 'PR opened', checks: 'Checks', merge: 'Merged' };
const S = (id: StageId, state: StageState, detail: string, e: E = null, estimate: Estimate | null = null): Stage => ({ id, title: TITLE[id], state, detail, at: e?.ts ?? null, estimate });

/** The worker, evaluator and PR stages: the review's guess for all three (nothing times them). */
const GUESS: Estimate = { basis: 'guess', text: '15-60 minutes from the claim to a PR, for these stages together; nothing times them' };

/** GitHub's https page of exactly that PR in `repo` (null: any repo), or null: never a script URL, another host, repo or PR. */
function prLink(url: unknown, n: number, repo: string | null): string | null {
  try {
    const u = new URL(String(url));
    const path = u.pathname.replace(/\/$/, '');
    const p = path.toLowerCase();
    const ok = u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && (repo ? p === `/${repo.toLowerCase()}/pull/${n}` : new RegExp(`^/[^/]+/[^/]+/pull/${n}$`).test(p));
    return ok ? `https://github.com${path}` : null;
  } catch {
    return null;
  }
}

/** The latest first-task filing in the audit; null when the form has filed none. */
export function firstTaskFiled(events: readonly StoredEvent[]): { issue: number; id: number; at: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const n = e.type === 'dashboard.audit' && pl(e).action === FIRST_TASK_FILED ? (pl(e).detail as { issue?: unknown } | undefined)?.issue : null;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return { issue: n, id: e.id, at: e.ts };
  }
  return null;
}

/**
 * The latest filed first task, from its own events recorded after the filing; merge events only of the PR the harness
 * opened for it. `local`: no instance (the hold words); `repo`: owner/name, the only repo whose PR page is linked.
 */
export function firstTaskProgress(events: readonly StoredEvent[], o: { local: boolean; repo?: string | null }): FirstTaskProgress | null {
  const filed = firstTaskFiled(events);
  if (!filed) return null;
  const n = filed.issue;
  const mine = events.filter((e) => e.id > filed.id && issueOf(e) === n);
  const last = (f: (e: StoredEvent) => boolean): E => mine.findLast(f) ?? null;
  const after = (e: E, than: E) => !!e && (!than || e.id > than.id);
  const of = (type: string, f: (p: Record<string, unknown>) => boolean = () => true) => last((e) => e.type === type && f(pl(e)));

  const claim = of('issue.claimed');
  const wStart = of('run.started', (p) => p.role === 'worker');
  const wEnd = of('run.finished', (p) => p.role === 'worker');
  // A verdict counts only for the worker's latest attempt.
  const verdict = last((e) => e.type === 'eval.verdict' && after(e, wStart));
  const opened = of('pr.opened');
  const pr = opened ? (pl(opened).number as number) : null;
  const ofPr = (type: string) => (pr === null ? null : of(type, (p) => p.number === pr));
  const [status, decided, merged, closed, failedMerge] = ['pr.status', 'merge.decided', 'merge.done', 'pr.closed', 'merge.failed'].map(ofPr);
  const landed = of('land.result', (p) => p.outcome === 'landed');
  const block = of('issue.blocked');
  const answered = new Set(events.filter((e) => e.type === 'decision.answered').map((e) => pl(e).id));
  const asked = of('decision.asked', (p) => !answered.has(p.id));
  const seen = of('issue.seen');

  const stages: Stage[] = [
    claim ? S('claimed', 'done', 'the coordinator took it', claim) : S('claimed', 'waiting', 'not claimed yet: the coordinator takes it on a tick while it is running', null, { basis: 'tick', text: `within about ${(COORDINATOR_TICK_MS + COORDINATOR_TICK_JITTER_MS) / 1000} s of the coordinator running: it looks for work every ${COORDINATOR_TICK_MS / 1000} s, plus up to ${COORDINATOR_TICK_JITTER_MS / 1000} s` }),
  ];
  const wEst = GUESS;
  const reason = wEnd ? String(pl(wEnd).reason) : '';
  stages.push(!wStart ? S('worker', 'waiting', 'not started yet', null, wEst) : !after(wEnd, wStart) ? S('worker', 'running', `attempt ${Number(pl(wStart).attempt) || 1} started; no finish recorded yet`, wStart, wEst) : reason === 'succeeded' ? S('worker', 'done', 'finished its change', wEnd) : S('worker', 'failed', `its run ended: ${reason.replace(/_/g, ' ')}`, wEnd));
  const v = verdict ? pl(verdict) : null;
  const ok = v?.patch_correct === true && v.test_correct === true;
  stages.push(v ? S('evaluator', ok ? 'done' : 'failed', ok ? `approved, confidence ${v.confidence}` : `did not approve it (confidence ${v.confidence})`, verdict) : S('evaluator', 'waiting', "no verdict yet: it checks the worker's change once the worker finishes", null, GUESS));
  stages.push(opened ? S('pr', 'done', `PR #${pr}`, opened) : landed ? S('pr', 'done', 'no PR: landed directly on the default branch', landed) : S('pr', 'waiting', 'no PR yet: one opens after the evaluator approves', null, GUESS));
  const cEst: Estimate = { basis: 'none', text: "no estimate: it depends on this repo's CI" };
  if (!opened || !status) stages.push(S('checks', 'waiting', opened ? 'no check results recorded yet' : landed ? 'none: no PR' : 'after the PR opens', null, landed && !opened ? null : cEst));
  else {
    const s = pl(status);
    const checks = Array.isArray(s.checks) ? (s.checks as { outcome?: unknown }[]) : [];
    const count = (...k: string[]) => checks.filter((c) => k.includes(String(c.outcome))).length;
    const [fail, pending] = [count('fail', 'cancelled'), count('pending', 'missing')];
    const said = `${count('pass')} passed${fail ? `, ${fail} failed` : ''}${pending ? `, ${pending} pending` : ''}`;
    stages.push(s.ready === true ? S('checks', 'done', `required checks green (${said})`, status) : fail ? S('checks', 'failed', said, status) : S('checks', 'running', checks.length ? said : 'not ready yet', status, cEst));
  }
  let holds: HoldWords[] = [];
  let outcome: FirstTaskProgress['outcome'] = 'open';
  if (merged || (closed && pl(closed).merged === true)) (outcome = 'merged'), stages.push(S('merge', 'done', merged ? 'merged' : 'merged on GitHub', merged ?? closed));
  else if (closed) (outcome = 'closed'), stages.push(S('merge', 'failed', 'the PR was closed without merging', closed));
  else if (!opened && landed) (outcome = 'landed'), stages.push(S('merge', 'done', 'landed on the default branch', landed));
  else if (failedMerge && after(failedMerge, decided)) stages.push(S('merge', 'failed', 'the last merge try failed', failedMerge));
  else if (decided && pl(decided).auto === false) {
    holds = holdsInWords(Array.isArray(pl(decided).reasons) ? (pl(decided).reasons as unknown[]).map(String) : [], { local: o.local });
    outcome = 'held';
    stages.push(S('merge', 'held', 'held: it waits for you', decided, { basis: 'none', text: 'no estimate: it waits until a person merges it' }));
  } else stages.push(decided ? S('merge', 'running', 'the merge policy will merge it', decided, { basis: 'none', text: 'no estimate: it merges on a later pass of the PR watch' }) : S('merge', 'waiting', opened ? 'no merge decision yet: it comes once the checks are green' : 'after the PR'));
  // A block after the latest claim and worker start, as the Board shows it: its first line.
  const why = block && after(block, claim) && after(block, wStart) ? String(pl(block).why ?? '').split('\n')[0]!.trim().slice(0, 200) : null;
  if (why !== null && outcome === 'open') outcome = 'blocked';
  return { issue: n, title: seen && typeof pl(seen).title === 'string' ? (pl(seen).title as string) : null, filedAt: filed.at, pr: pr === null ? null : { number: pr, url: opened ? prLink(pl(opened).url, pr, o.repo ?? null) : null }, stages, blocked: why === null ? null : { why, at: block!.ts }, question: asked ? { at: asked.ts } : null, holds, outcome };
}

// WHY (#776, owner decision on #698 decision 1, amended in #775): resuming auto-merge after a stop is not turning it on.
// It stays an owner's action on the dashboard, audited. But a stop the default branch caused (a red main after an
// auto-merge, `red_main`; or the main watch's unaccounted commit, `main_watch`) resumes only when main's required
// checks are green on its current tip, measured at that moment, or with an owner's explicit acknowledgement, a typed
// reason recorded in the event log with who and when. Any other stop resumes as before.
//
// INVARIANT: one rule on every surface that resumes. The dashboard's resume asks mayResume; a stop file deleted by
// hand is written back by the coordinator (coordinator/merge-flow.ts stopGoneByHand) while main isn't measured green.
// Fail closed: a stop with no `by`, an unknown one, or an unreadable stop file waits for green main; main with no
// required checks configured, a tip that can't be read, or checks that can't be read is not green.
import type { CommitCheck } from './backlog/types.js';
import { requiredOutcomes } from './pr-watch.js';

/** Who stopped auto-merge, as the stop file and `merge.stopped` record it. */
export const STOP_BY = ['red_main', 'main_watch', 'owner'] as const;
export type StopBy = (typeof STOP_BY)[number];

/** The only stops that resume as before (no green main needed). Anything else, or nothing, waits for green main. */
const RESUMES_AS_BEFORE: ReadonlySet<string> = new Set<StopBy>(['owner']);

/** Whether a stop by `by` waits for green main (or an acknowledgement) before it may resume. */
export function stopWaitsForGreen(by: unknown): boolean {
  return !(typeof by === 'string' && RESUMES_AS_BEFORE.has(by));
}

/** Main's state at the moment of a resume: green on `tip`, or not, and why. */
export type MainState = { green: true; tip: string } | { green: false; tip: string | null; why: string };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Every one of `required` passes on the default branch's current tip; anything else, or anything unreadable, is not green. */
export async function measureMain(o: { branch: string; required: string[]; tip: () => string | null | Promise<string | null>; checks: (sha: string) => Promise<CommitCheck[]> }): Promise<MainState> {
  if (!o.required.length) return { green: false, tip: null, why: `no required checks are configured (required_checks in config.yaml), so ${o.branch} can't be measured green` };
  let tip: string | null = null;
  try {
    tip = await o.tip();
  } catch {
    tip = null;
  }
  if (!tip || !SHA.test(tip)) return { green: false, tip: null, why: `${o.branch}'s tip can't be read from the remote` };
  let checks: CommitCheck[];
  try {
    checks = await o.checks(tip);
  } catch (e) {
    return { green: false, tip, why: `the checks on ${o.branch}'s tip ${tip.slice(0, 8)} can't be read (${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)})` };
  }
  const notGreen = requiredOutcomes(o.required, checks).filter((c) => c.outcome !== 'pass');
  if (notGreen.length) return { green: false, tip, why: `${o.branch}'s required checks on its tip ${tip.slice(0, 8)} are not all green (${notGreen.map((c) => `${c.name}: ${c.outcome}`).join(', ')})` };
  return { green: true, tip };
}

export const ACK_MIN = 10;
export const ACK_MAX = 500;

/**
 * The acknowledgement a resume request carries (`{ acknowledge: { reason } }`): none, a typed reason, or why it is
 * refused. A bare `true`, an empty or short reason is no acknowledgement.
 */
export function acknowledgement(body: unknown): { reason: string | null } | { error: string } {
  const a = (body as { acknowledge?: unknown } | null)?.acknowledge;
  if (a === undefined || a === null) return { reason: null };
  const reason = typeof (a as { reason?: unknown }).reason === 'string' ? (a as { reason: string }).reason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < ACK_MIN) return { error: `an acknowledgement needs a typed reason of at least ${ACK_MIN} characters` };
  if (reason.length > ACK_MAX) return { error: `the reason is too long (at most ${ACK_MAX} characters)` };
  return { reason };
}

export type ResumeVerdict =
  | { ok: true; how: 'as_before' | 'green' | 'acknowledged'; main: MainState | null }
  | { ok: false; error: string; needsAck: true; main: MainState };

/**
 * Whether a stop may resume now. `gated`: the stop waits for green main (stopWaitsForGreen of the stop file's `by`
 * and of the last `merge.stopped`). Main is measured for every gated stop, an acknowledged one too, so what it was
 * is recorded with the resume.
 */
export async function mayResume(o: { gated: boolean; ack: string | null; measure: () => Promise<MainState> }): Promise<ResumeVerdict> {
  if (!o.gated) return { ok: true, how: 'as_before', main: null };
  const main = await o.measure();
  if (main.green) return { ok: true, how: 'green', main };
  if (o.ack) return { ok: true, how: 'acknowledged', main };
  return { ok: false, needsAck: true, main, error: `auto-merge stopped because of the default branch, and it resumes only once it is green: ${main.why}. Resume anyway only with an explicit acknowledgement (a typed reason, recorded)` };
}

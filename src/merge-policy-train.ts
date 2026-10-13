// The parallel merge train's pure rules: how many of the harness's own ready PRs it merges in one pass of the PR
// watch (tests.yaml land.parallel_merges), what a refusal from GitHub's merge API means, how long a PR GitHub refused
// as "not up to date" waits before it is tried again, and the merge commit's message. Part of the merge policy (a
// self-modification path: src/merge-policy*), so a change here waits for the owner.
//
// A PR merges when every required check is green on its exact head and GitHub reports it mergeable (no textual
// conflict). It is never made to merge the default branch in first or to be up to date: post-merge CI and the main
// watch catch what two green PRs break together. A repo that still requires branches to be up to date (strict
// protection) refuses the PRs behind it; those wait with a backoff (mergeDeferral) and are tried again, never spun on.

/** What a refusal from GitHub's merge API means for the train. */
export type MergeRefusal =
  /** Strict protection: the branch must be up to date with its base first. Retried later (backoff). */
  | 'behind'
  /** The base moved while GitHub merged (another merge of this pass landed first). Retried later (backoff). */
  | 'base_moved'
  /** The head is no longer the one asked for (`sha` pinned to it): nothing merged; the new head is decided afresh. */
  | 'head_moved'
  /** Anything else: a merge failure, counted (three at one head and it goes to the owner). */
  | 'other';

/** GitHub's merge API's words for each refusal (405 / 409). */
export function mergeRefusal(why: string): MergeRefusal {
  if (/not up to date with the base branch|branch is out-of-date|must be up to date/i.test(why)) return 'behind';
  if (/base branch was modified/i.test(why)) return 'base_moved';
  if (/head branch was modified|head is [0-9a-f]+, not|sha .*(does not match|mismatch)/i.test(why)) return 'head_moved';
  return 'other';
}

/** Retried later rather than counted as a failure. */
export const deferrable = (r: MergeRefusal) => r === 'behind' || r === 'base_moved';

/** A PR GitHub reports as behind its base: it waits (strict protection), it isn't a human's call and isn't merged. */
export const isBehind = (pr: { mergeable: boolean | null; mergeableState: string }) => pr.mergeableState === 'behind' && pr.mergeable !== false;

export const DEFER_FIRST_MS = 2 * 60_000;
export const DEFER_MAX_MS = 30 * 60_000;

/**
 * When a PR whose merge was deferred `times` times already (at this head) is tried again: 2 min, doubling, at most
 * 30 min. Never sooner, whatever the poll interval, so a refusal is never retried in a loop.
 */
export function deferDelay(times: number): number {
  return Math.min(DEFER_MAX_MS, DEFER_FIRST_MS * 2 ** Math.max(0, Math.min(times, 10)));
}

/** A deferral recorded in the log (merge.deferred). */
export interface Deferral {
  number: number;
  head: string;
  retry_at: string;
}

/** Whether PR `number` at `head` is still deferred at `now` (its latest deferral's retry time not reached), and how many it had. */
export function mergeDeferral(deferrals: Deferral[], number: number, head: string, now: number): { waiting: boolean; times: number; retryAt: number | null } {
  const mine = deferrals.filter((d) => d.number === number && d.head === head);
  const last = mine.at(-1);
  const retryAt = last ? Date.parse(last.retry_at) : null;
  return { waiting: retryAt !== null && retryAt > now, times: mine.length, retryAt };
}

/**
 * The merges of one pass of the PR watch, up to the instance's cap (tests.yaml land.parallel_merges). A PR over the
 * cap isn't merged this pass; it is the first looked at on the next one.
 */
export class MergePass {
  private merged = 0;
  constructor(private readonly cap: () => number) {}
  start() {
    this.merged = 0;
  }
  room(): boolean {
    return this.merged < this.cap();
  }
  took() {
    this.merged++;
  }
  get count() {
    return this.merged;
  }
}

/**
 * The merge commit's subject and body. GitHub's own default subject ("Merge pull request #n from <owner>/<branch>")
 * names a handle, which the push gate refuses on the default branch; so the train always sets both, and takes any
 * @handle and e-mail address out of the PR's title. The body is fixed text: no PR body, no names.
 */
export function mergeMessage(o: { title: string; number: number; head: string; product: string }): { subject: string; body: string } {
  const title = o.title
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
    .replace(/(^|[^\w`])@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(\/[A-Za-z0-9-]+)?/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;)])/g, '$1')
    .trim();
  return { subject: `${title || 'Merge'} (#${o.number})`, body: `Merged by ${o.product} at head ${o.head.slice(0, 12)}: every required check green on it.` };
}

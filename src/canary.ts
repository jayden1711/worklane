// The canary: a scratch-repo instance that proves the engine still works end to end. The machine's updater
// (scripts/machine/<cli>-update.cjs) files a tiny issue on it each day and after every engine update, as the
// canary instance's own user, and then asks how far it got; the issue must go issue -> plan -> PR -> green checks
// -> merged within the time limit. After an update, a canary that fails or runs out of time rolls the engine back.
// The updater keeps the clock (the time limit, the daily trigger); this module only files and reads.
//
//   <cli> canary file  --instance <name> --repo <owner/repo> --reason update|daily --json
//   <cli> canary check --instance <name> --repo <owner/repo> --issue <n> --json
//
// The canary never touches a real repo: the machine config names the canary's repo, and both commands refuse an
// instance whose repo is not exactly that one, or a repo another instance on this machine also runs on. The
// instance's App token is minted for its one repo (src/service.ts instanceTokens), and a PR counts only when its
// URL is in that repo.
import type { Actionability, Backlog, CommitCheck, Issue, PullRequest } from './backlog/types.js';
import { updateSettings } from './updates.js';
import type { StoredEvent } from './events/types.js';

export type CanaryReason = 'update' | 'daily';

/** The labels a canary issue carries: ready (writers' issues are taken as they are), size:M (it is planned first). */
export const CANARY_LABELS = ['ready', 'size:M', 'canary'] as const;
export const CANARY_LABEL = { name: 'canary', color: 'c2e0c6', description: 'Filed by the engine canary: a tiny change that proves the engine works end to end' };

/** The canary issue: one line appended to CANARY.md, a five-part issue with a done_when the agent can run. */
export function canaryIssue(reason: CanaryReason, now: Date): { id: string; title: string; body: string; labels: string[] } {
  const id = `${reason}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  const line = `canary ${id}`;
  const body = [
    `**Outcome:** CANARY.md has the line \`${line}\`.`,
    '**Sources:** CANARY.md at the root of this repo; create it when it does not exist.',
    '**Constraints:** change only CANARY.md: append the one line, keep every line already there.',
    '**Deliverable:**',
    '```done_when',
    '- command: |',
    `    grep -qx "${line}" CANARY.md`,
    '```',
    `**Review point:** L0; a one-line change to a scratch file in the canary repo, filed by the engine's ${reason === 'update' ? 'post-update' : 'daily'} canary. Nothing here waits for the owner.`,
    '',
  ].join('\n');
  return { id, title: `Canary ${id}: add one line to CANARY.md`, body, labels: [...CANARY_LABELS] };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why this instance can't be the canary, or null when it can: its repo must be exactly the canary repo the
 * machine config names, and no other instance on this machine may run on that repo.
 */
export function canaryRefusal(o: { instance: string; instanceRepo: string; canaryRepo: string; others: { name: string; repo: string }[] }): string | null {
  if (!/^[^/\s]+\/[^/\s]+$/.test(o.canaryRepo)) return `the canary repo "${o.canaryRepo}" is not owner/repo`;
  if (!same(o.instanceRepo, o.canaryRepo)) return `instance ${o.instance} runs on ${o.instanceRepo}, not the canary repo ${o.canaryRepo}: the canary only ever works on its own scratch repo`;
  const shared = o.others.filter((x) => x.name !== o.instance && same(x.repo, o.canaryRepo)).map((x) => x.name);
  if (shared.length) return `the canary repo ${o.canaryRepo} is also the repo of ${shared.join(', ')}: the canary needs a scratch repo of its own`;
  return null;
}

export type CanaryStage = 'filed' | 'taken' | 'planned' | 'pr' | 'checks' | 'merged';
export interface CanaryStatus {
  state: 'pending' | 'passed' | 'failed';
  /** How far it got. */
  stage: CanaryStage;
  /** What it waits on, or why it failed. */
  reason: string;
  pr: { number: number; url: string } | null;
}

const GREEN = new Set(['success', 'neutral', 'skipped']);

/**
 * How far the canary issue got, from the canary instance's own events and, once its PR is merged, GitHub's word on
 * that PR and the checks on its head. Fails at once only when nothing can come of it any more (the PR closed
 * unmerged, the plan held for the owner, the PR outside the canary repo); everything else is pending, and the
 * updater's time limit decides.
 */
export function canaryProgress(o: { issue: number; repo: string; events: StoredEvent[]; pr?: PullRequest | null; checks?: CommitCheck[] | null }): CanaryStatus {
  const mine = o.events.filter((e) => (e.payload as { issue?: number }).issue === o.issue);
  const has = (t: string) => mine.filter((e) => e.type === t);
  const seen = has('issue.seen').at(-1)?.payload as { actionable?: boolean; why?: string } | undefined;
  const plan = has('plan.posted').at(-1)?.payload as { held?: boolean; reasons?: string[] } | undefined;
  const opened = has('pr.opened').at(-1)?.payload as { number: number; url: string } | undefined;
  const closed = has('pr.closed').at(-1)?.payload as { number: number; merged: boolean } | undefined;
  const pr = opened ? { number: opened.number, url: opened.url } : null;
  if (pr && !pr.url.toLowerCase().startsWith(`https://github.com/${o.repo.toLowerCase()}/pull/`)) return { state: 'failed', stage: 'pr', reason: `its PR ${pr.url} is not in the canary repo ${o.repo}`, pr };
  if (closed && !closed.merged) return { state: 'failed', stage: 'pr', reason: `PR #${closed.number} was closed without merging`, pr };
  if (plan?.held) return { state: 'failed', stage: 'planned', reason: `the plan was held for the owner${plan.reasons?.length ? `: ${plan.reasons.join('; ')}` : ''}`, pr };
  if (!has('issue.claimed').length) return { state: 'pending', stage: 'filed', reason: seen && seen.actionable === false ? `not taken: ${seen.why ?? 'not actionable'}` : 'waiting for the instance to take it', pr };
  if (!plan) return { state: 'pending', stage: 'taken', reason: 'waiting for its plan', pr };
  if (!pr) return { state: 'pending', stage: 'planned', reason: 'waiting for its PR', pr };
  if (!closed) return { state: 'pending', stage: 'pr', reason: `PR #${pr.number} open: waiting for green checks and the merge`, pr };
  // The instance says merged: GitHub must agree, and every check on the merged head must be complete and green.
  if (!o.pr) return { state: 'pending', stage: 'checks', reason: `PR #${pr.number} merged; reading it on GitHub`, pr };
  if (o.pr.state !== 'merged') return { state: 'failed', stage: 'pr', reason: `the instance recorded PR #${pr.number} merged, but GitHub says ${o.pr.state}`, pr };
  const checks = o.checks ?? [];
  if (!checks.length) return { state: 'failed', stage: 'checks', reason: `PR #${pr.number} merged with no checks on its head: the canary repo needs a required check`, pr };
  const bad = checks.find((c) => c.status !== 'completed' || !GREEN.has(c.conclusion ?? ''));
  if (bad) return { state: 'failed', stage: 'checks', reason: `PR #${pr.number} merged, but check "${bad.name}" is ${bad.status === 'completed' ? bad.conclusion : bad.status}`, pr };
  return { state: 'passed', stage: 'merged', reason: `PR #${pr.number} merged with ${checks.length} green check${checks.length === 1 ? '' : 's'}`, pr };
}

/** File the canary issue on the canary repo with the instance's backlog. */
export async function fileCanary(backlog: Backlog, repo: string, reason: CanaryReason, now: Date): Promise<{ issue: number; url: string; id: string }> {
  const c = canaryIssue(reason, now);
  await backlog.ensureLabels([CANARY_LABEL]);
  const issue = await backlog.createIssue(c.title, c.body, c.labels);
  return { issue, url: `https://github.com/${repo}/issues/${issue}`, id: c.id };
}

/**
 * Read how far the canary got: the instance's events, and GitHub once the instance recorded the merge.
 * WHY a raw read of the checks (#727): the updater keeps or rolls back an install on this verdict, but a pass needs the
 * PR merged by the canary instance, whose own merge judged its required checks by their pins (src/check-source.ts),
 * and every check on the head green, so a spoofed check can only turn a pass into a fail.
 */
export async function checkCanary(backlog: Backlog, repo: string, issue: number, events: StoredEvent[]): Promise<CanaryStatus> {
  const first = canaryProgress({ issue, repo, events });
  if (first.stage !== 'checks' || !first.pr) return first;
  const pr = await backlog.pullRequest(first.pr.number);
  return canaryProgress({ issue, repo, events, pr, checks: pr.state === 'merged' ? await backlog.checks(pr.headSha) : null });
}

/**
 * The one issue a writer didn't open that an instance takes: on the machine's canary instance (updates.json
 * canary.instance), an open `ready` + `canary` issue its own App opened, the canary the updater filed. App bots can't
 * be listed as writers (a handle has no "[bot]"), so without this the canary would never be taken. Anywhere else,
 * or by anyone else, null: the usual writer rule decides.
 */
export function canaryTask(issue: Pick<Issue, 'author' | 'labels' | 'state'>, o: { instance: string; canaryInstance: string | null; bot: string }): Actionability | null {
  if (!o.canaryInstance || o.instance !== o.canaryInstance || !/\[bot\]$/.test(o.bot)) return null;
  if (issue.state !== 'open' || !issue.labels.includes('ready') || !issue.labels.includes(CANARY_LABEL.name) || issue.author.toLowerCase() !== o.bot.toLowerCase()) return null;
  return { actionable: true, why: `the machine's canary, opened by this instance's App ${o.bot}` };
}

/** The canary instance the machine config names, or null (no updater, or no canary). */
export const machineCanaryInstance = (path?: string): string | null => updateSettings(path)?.canary?.instance ?? null;

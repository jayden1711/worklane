import { updateSettings } from './updates.js';
/** The labels a canary issue carries: ready (writers' issues are taken as they are), size:M (it is planned first). */
export const CANARY_LABELS = ['ready', 'size:M', 'canary'];
export const CANARY_LABEL = { name: 'canary', color: 'c2e0c6', description: 'Filed by the engine canary: a tiny change that proves the engine works end to end' };
/** The canary issue: one line appended to CANARY.md, a five-part issue with a done_when the agent can run. */
export function canaryIssue(reason, now) {
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
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
/**
 * Why this instance can't be the canary, or null when it can: its repo must be exactly the canary repo the
 * machine config names, and no other instance on this machine may run on that repo.
 */
export function canaryRefusal(o) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(o.canaryRepo))
        return `the canary repo "${o.canaryRepo}" is not owner/repo`;
    if (!same(o.instanceRepo, o.canaryRepo))
        return `instance ${o.instance} runs on ${o.instanceRepo}, not the canary repo ${o.canaryRepo}: the canary only ever works on its own scratch repo`;
    const shared = o.others.filter((x) => x.name !== o.instance && same(x.repo, o.canaryRepo)).map((x) => x.name);
    if (shared.length)
        return `the canary repo ${o.canaryRepo} is also the repo of ${shared.join(', ')}: the canary needs a scratch repo of its own`;
    return null;
}
const GREEN = new Set(['success', 'neutral', 'skipped']);
/**
 * How far the canary issue got, from the canary instance's own events and, once its PR is merged, GitHub's word on
 * that PR and the checks on its head. Fails at once only when nothing can come of it any more (the PR closed
 * unmerged, the plan held for the owner, the PR outside the canary repo); everything else is pending, and the
 * updater's time limit decides.
 */
export function canaryProgress(o) {
    const mine = o.events.filter((e) => e.payload.issue === o.issue);
    const has = (t) => mine.filter((e) => e.type === t);
    const seen = has('issue.seen').at(-1)?.payload;
    const plan = has('plan.posted').at(-1)?.payload;
    const opened = has('pr.opened').at(-1)?.payload;
    const closed = has('pr.closed').at(-1)?.payload;
    const pr = opened ? { number: opened.number, url: opened.url } : null;
    if (pr && !pr.url.toLowerCase().startsWith(`https://github.com/${o.repo.toLowerCase()}/pull/`))
        return { state: 'failed', stage: 'pr', reason: `its PR ${pr.url} is not in the canary repo ${o.repo}`, pr };
    if (closed && !closed.merged)
        return { state: 'failed', stage: 'pr', reason: `PR #${closed.number} was closed without merging`, pr };
    if (plan?.held)
        return { state: 'failed', stage: 'planned', reason: `the plan was held for the owner${plan.reasons?.length ? `: ${plan.reasons.join('; ')}` : ''}`, pr };
    if (!has('issue.claimed').length)
        return { state: 'pending', stage: 'filed', reason: seen && seen.actionable === false ? `not taken: ${seen.why ?? 'not actionable'}` : 'waiting for the instance to take it', pr };
    if (!plan)
        return { state: 'pending', stage: 'taken', reason: 'waiting for its plan', pr };
    if (!pr)
        return { state: 'pending', stage: 'planned', reason: 'waiting for its PR', pr };
    if (!closed)
        return { state: 'pending', stage: 'pr', reason: `PR #${pr.number} open: waiting for green checks and the merge`, pr };
    // The instance says merged: GitHub must agree, and every check on the merged head must be complete and green.
    if (!o.pr)
        return { state: 'pending', stage: 'checks', reason: `PR #${pr.number} merged; reading it on GitHub`, pr };
    if (o.pr.state !== 'merged')
        return { state: 'failed', stage: 'pr', reason: `the instance recorded PR #${pr.number} merged, but GitHub says ${o.pr.state}`, pr };
    const checks = o.checks ?? [];
    if (!checks.length)
        return { state: 'failed', stage: 'checks', reason: `PR #${pr.number} merged with no checks on its head: the canary repo needs a required check`, pr };
    const bad = checks.find((c) => c.status !== 'completed' || !GREEN.has(c.conclusion ?? ''));
    if (bad)
        return { state: 'failed', stage: 'checks', reason: `PR #${pr.number} merged, but check "${bad.name}" is ${bad.status === 'completed' ? bad.conclusion : bad.status}`, pr };
    return { state: 'passed', stage: 'merged', reason: `PR #${pr.number} merged with ${checks.length} green check${checks.length === 1 ? '' : 's'}`, pr };
}
/** File the canary issue on the canary repo with the instance's backlog. */
export async function fileCanary(backlog, repo, reason, now) {
    const c = canaryIssue(reason, now);
    await backlog.ensureLabels([CANARY_LABEL]);
    const issue = await backlog.createIssue(c.title, c.body, c.labels);
    return { issue, url: `https://github.com/${repo}/issues/${issue}`, id: c.id };
}
/** Read how far the canary got: the instance's events, and GitHub once the instance recorded the merge. */
export async function checkCanary(backlog, repo, issue, events) {
    const first = canaryProgress({ issue, repo, events });
    if (first.stage !== 'checks' || !first.pr)
        return first;
    const pr = await backlog.pullRequest(first.pr.number);
    return canaryProgress({ issue, repo, events, pr, checks: pr.state === 'merged' ? await backlog.checks(pr.headSha) : null });
}
/**
 * The one issue a writer didn't open that an instance takes: on the machine's canary instance (updates.json
 * canary.instance), an open `ready` + `canary` issue its own App opened, the canary the updater filed. App bots can't
 * be listed as writers (a handle has no "[bot]"), so without this the canary would never be taken. Anywhere else,
 * or by anyone else, null: the usual writer rule decides.
 */
export function canaryTask(issue, o) {
    if (!o.canaryInstance || o.instance !== o.canaryInstance || !/\[bot\]$/.test(o.bot))
        return null;
    if (issue.state !== 'open' || !issue.labels.includes('ready') || !issue.labels.includes(CANARY_LABEL.name) || issue.author.toLowerCase() !== o.bot.toLowerCase())
        return null;
    return { actionable: true, why: `the machine's canary, opened by this instance's App ${o.bot}` };
}
/** The canary instance the machine config names, or null (no updater, or no canary). */
export const machineCanaryInstance = (path) => updateSettings(path)?.canary?.instance ?? null;
//# sourceMappingURL=canary.js.map
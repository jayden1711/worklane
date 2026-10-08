import { parse as parseYaml } from 'yaml';
import { DoneWhen } from '../stopgate.js';
export const LABELS = [
    { name: 'triage', color: 'd4c5f9', description: 'New; not yet approved for work' },
    { name: 'ready', color: '0e8a16', description: 'Approved by a writer; has a done_when contract' },
    { name: 'agent:working', color: 'fbca04', description: 'Claimed by an agent (see the claim comment)' },
    { name: 'in-review', color: '1d76db', description: 'Change proposed; verifying or awaiting approval' },
    { name: 'needs:decision', color: 'b60205', description: 'Waiting on a decision from the owner' },
    { name: 'money-path', color: '5319e7', description: 'Touches money-path code: extra verification' },
    { name: 'blocked', color: '000000', description: 'Cannot proceed; see the latest comment' },
    { name: 'type:investigation', color: 'c5def5', description: 'Read-only: findings and evidence, no code change' },
    { name: 'red', color: 'e11d21', description: 'A new failure on main, attributed to the change that caused it' },
    { name: 'ci', color: 'c5def5', description: 'CI is red on main' },
    { name: 'qa', color: 'fef2c0', description: 'Found by the QA playtester on a test deployment' },
    { name: 'incident', color: 'b60205', description: 'A deployment check failed; see the monitor comment' },
    { name: 'report', color: 'bfdadc', description: 'Scheduled reports are posted here' },
    { name: 'size:S', color: 'c2e0c6', description: 'Small' },
    { name: 'size:M', color: 'fef2c0', description: 'Medium: plan mode first' },
    { name: 'size:L', color: 'f9d0c4', description: 'Large: plan mode first' },
    { name: 'review:L0', color: 'ededed', description: 'Lands after checks pass' },
    { name: 'review:L1', color: 'ededed', description: 'Lands after the evaluator approves' },
    { name: 'review:L2', color: 'ededed', description: 'Lands after the evaluator approves; owner notified' },
    { name: 'review:L3', color: 'ededed', description: 'Owner must approve before landing' },
];
/** The ```done_when fenced block in an issue body, validated. */
export function parseContract(body) {
    const m = body.match(/```done_when\s*\n([\s\S]*?)\n```/);
    if (!m)
        return { ok: false, why: 'no ```done_when block in the issue body' };
    let raw;
    try {
        raw = parseYaml(m[1]);
    }
    catch (e) {
        return { ok: false, why: `done_when is not valid YAML: ${e.message.split('\n')[0]}` };
    }
    const r = DoneWhen.min(1).safeParse(raw);
    if (!r.success)
        return { ok: false, why: `done_when invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    return { ok: true, done_when: r.data };
}
/**
 * Only issues opened by a writer, or marked ready by a writer, are
 * actionable; outsiders' issues stay in triage however they're labeled.
 */
export async function actionable(issue, writers, backlog) {
    if (issue.state !== 'open')
        return { actionable: false, why: 'closed' };
    if (!issue.labels.includes('ready'))
        return { actionable: false, why: 'not labeled ready' };
    const w = new Set(writers.map((x) => x.toLowerCase()));
    if (w.has(issue.author.toLowerCase()))
        return { actionable: true, why: `opened by writer ${issue.author}` };
    const adders = await backlog.labelAdders(issue.number, 'ready');
    const approver = adders.find((a) => w.has(a.toLowerCase()));
    return approver ? { actionable: true, why: `ready added by writer ${approver}` } : { actionable: false, why: `opened by ${issue.author} (not a writer) and no writer added ready` };
}
/** The owner for an issue: an assignee who is a writer, else the first matching area, else the default. */
export function ownerFor(issue, paths, owners, match) {
    const writers = new Set(owners.writers.map((w) => w.toLowerCase()));
    const assigned = issue.assignees.find((a) => writers.has(a.toLowerCase()));
    if (assigned)
        return assigned;
    for (const area of owners.areas) {
        if (area.labels.some((l) => issue.labels.includes(l)))
            return area.owner;
        if (paths.some((p) => area.paths.some((g) => match(g, p))))
            return area.owner;
    }
    return owners.default;
}
//# sourceMappingURL=types.js.map
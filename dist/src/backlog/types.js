import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { DoneWhen } from '../contract.js';
export const LABELS = [
    { name: 'triage', color: 'd4c5f9', description: 'New; not yet approved for work' },
    { name: 'ready', color: '0e8a16', description: 'Approved by a writer; has a done_when contract' },
    { name: 'agent:working', color: 'fbca04', description: 'Claimed by an agent (see the claim comment)' },
    { name: 'in-review', color: '1d76db', description: 'Change proposed; verifying or awaiting approval' },
    { name: 'needs:decision', color: 'b60205', description: 'Waiting on a decision from the owner' },
    { name: 'money-path', color: '5319e7', description: 'Touches money-path code: extra verification' },
    { name: 'blocked', color: '000000', description: 'Cannot proceed; see the latest comment' },
    { name: 'merge-ready', color: '0e8a16', description: 'Required checks passed on the commit the evaluator approved' },
    { name: 'ci-failing', color: 'b60205', description: 'A required check fails and CI fix runs stopped; see the latest comment' },
    { name: 'needs-owner', color: 'd93f0b', description: 'Waits for the owner to review and merge; the latest comment says why' },
    { name: 'type:investigation', color: 'c5def5', description: 'Read-only: findings and evidence, no code change' },
    { name: 'type:goal', color: 'c5def5', description: 'A goal: split into child issues that depend on each other, not built itself' },
    { name: 'goal:split', color: 'ededed', description: 'This goal was split; its child issues are listed in a comment' },
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
/** Identifies the ```done_when block an intake decision was about: a hash of its text, or "none". */
export function contractKey(body) {
    const m = body.match(/```done_when\s*\n([\s\S]*?)\n```/);
    return m ? createHash('sha256').update(m[1].replace(/\r\n/g, '\n')).digest('hex').slice(0, 16) : 'none';
}
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
/** The five parts of every issue the harness drafts itself (intake, chat, gardener, corrections). */
export const ISSUE_PARTS = ['Outcome', 'Sources', 'Constraints', 'Deliverable', 'Review point'];
/** How a drafting agent is told to write the body (src/roles.ts says the same in the chat role; a test keeps them in step). */
export const DRAFT_FORMAT = 'five parts, each starting a line with its bold label: **Outcome:** one sentence. **Sources:** where to look, nowhere else. **Constraints:** what to leave alone. **Deliverable:** a closed ```done_when block, commands as YAML block scalars ("- command: |"). **Review point:** the expected review level (L0 to L3) and what would make it wait for the owner.';
/**
 * The text of each part in an issue body, labelled `**Outcome:**` (or `**Outcome**:`) at the start of a line, or as
 * a heading (`## Outcome`). A part runs to the next part's label; labels inside code fences don't count. null: absent.
 */
export function issueParts(body) {
    const out = Object.fromEntries(ISSUE_PARTS.map((p) => [p, null]));
    const names = new Map(ISSUE_PARTS.map((p) => [p.toLowerCase(), p]));
    let current = null;
    let fence = false;
    const parts = {};
    for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
        if (/^\s*(```|~~~)/.test(line))
            fence = !fence;
        const m = fence ? null : /^\s*(?:\*\*([^*]+?):?\*\*:?|#{1,6}\s+([^#]+?):?\s*#*\s*$)\s*(.*)$/.exec(line);
        const name = m ? names.get((m[1] ?? m[2] ?? '').trim().toLowerCase()) : undefined;
        if (name) {
            current = name;
            parts[name] = [m[3] ?? ''];
        }
        else if (current)
            parts[current].push(line);
    }
    for (const p of ISSUE_PARTS)
        if (parts[p])
            out[p] = parts[p].join('\n').trim();
    return out;
}
/**
 * Can an issue the harness drafted itself be filed? A title; all five parts, none empty; the Outcome one sentence on
 * one line; the Deliverable a ```done_when block parseContract accepts, its commands YAML block scalars
 * (`- command: |`, which keeps quoting and colons inside commands from breaking the block); the Review point naming
 * a review level (L0 to L3).
 */
export function checkDraftedIssue(title, body) {
    if (!title.trim())
        return { ok: false, why: 'the draft has no title' };
    const parts = issueParts(body);
    const missing = ISSUE_PARTS.filter((p) => !parts[p]);
    if (missing.length)
        return { ok: false, why: `the draft needs all five parts (${ISSUE_PARTS.join(', ')}); missing or empty: ${missing.join(', ')}` };
    if (parts.Outcome.includes('\n'))
        return { ok: false, why: 'the Outcome must be one sentence on one line' };
    const c = parseContract(parts.Deliverable);
    if (!c.ok)
        return { ok: false, why: `Deliverable: ${c.why}` };
    const block = parts.Deliverable.match(/```done_when\s*\n([\s\S]*?)\n```/)[1];
    const inline = block.split('\n').filter((l) => /^\s*-?\s*command:\s*\S/.test(l) && !/^\s*-?\s*command:\s*[|>][-+]?\s*$/.test(l));
    if (inline.length)
        return { ok: false, why: `commands must be YAML block scalars ("- command: |"), not inline: ${inline[0].trim()}` };
    if (!/\bL[0-3]\b/.test(parts['Review point']))
        return { ok: false, why: 'the Review point must name the expected review level (L0 to L3) and what would make it wait for the owner' };
    return c;
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
/** Who may answer a decision: its owner, or one of the project's writers. GitHub logins are case-insensitive. */
export function mayAnswer(owner, user, owners) {
    const u = user.toLowerCase();
    return !!u && (owner.toLowerCase() === u || owners.writers.some((w) => w.toLowerCase() === u));
}
//# sourceMappingURL=types.js.map
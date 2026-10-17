// Conflict fix runs: when a harness PR can no longer merge because its base
// moved under it, merge the PR's actual base into its branch, let a worker
// resolve only the conflicted hunks (knowing what both sides meant), and send
// the result through the normal pipeline. These are the pure decisions; the
// coordinator does the git work and the runs.
/**
 * GitHub reports conflicts as mergeable=false with mergeable_state "dirty" (GraphQL: CONFLICTING). Behind,
 * blocked, unstable, clean, draft and unknown are never conflicts; mergeable=null means GitHub hasn't
 * computed it yet (it starts when asked), so the caller polls again shortly instead of acting.
 */
export function conflictTrigger(pr) {
    if (pr.state !== 'open')
        return { act: 'none', why: `the PR is ${pr.state}` };
    if (pr.mergeable === null || pr.mergeableState === 'unknown')
        return { act: 'recheck', why: 'GitHub is still computing whether it can merge' };
    if (pr.mergeable === false && pr.mergeableState === 'dirty')
        return { act: 'fix' };
    return { act: 'none', why: `merge state ${pr.mergeableState}${pr.mergeable === false ? ' (not mergeable, but not a conflict)' : ''}` };
}
/** Fix runs already used on a PR: every one started counts, including runs a restart cut short. */
export function conflictFixesUsed(events, pr) {
    return events.filter((e) => e.type === 'conflict_fix.started' && e.payload.number === pr).length;
}
/**
 * A file's lines with their line endings dropped, LF or CRLF alike (a checkout with core.autocrlf, or a repo
 * that keeps CRLF, writes markers and content with \r\n). Only for reading and comparing: files are never
 * rewritten with other endings.
 */
export const linesOf = (text) => text.split(/\r?\n/);
/** The conflicted hunks in one file's merged text (merge or diff3 markers; LF or CRLF). */
export function parseConflicts(file, text) {
    const lines = linesOf(text);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('<<<<<<<'))
            continue;
        const start = i;
        const ours = [];
        const base = [];
        const theirs = [];
        let part = ours;
        let hasBase = false;
        let closed = false;
        for (i++; i < lines.length; i++) {
            const l = lines[i];
            if (l.startsWith('|||||||')) {
                part = base;
                hasBase = true;
            }
            else if (l === '=======' || l.startsWith('======= '))
                part = theirs;
            else if (l.startsWith('>>>>>>>')) {
                closed = true;
                break;
            }
            else
                part.push(l);
        }
        if (!closed)
            break;
        out.push({ file, line: start + 1, ours: ours.join('\n'), theirs: theirs.join('\n'), ...(hasBase ? { base: base.join('\n') } : {}) });
    }
    return out;
}
/**
 * The worker's brief for a conflict fix: every conflicted hunk with both sides' text, and what each side was
 * for, so a resolution keeps both behaviors. The worker may change only the conflicted hunks.
 */
export function conflictBrief(o) {
    const clip = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
    const hunk = (h, i) => [`### ${i + 1}. ${h.file}, line ${h.line}`, '', 'This PR:', '```', clip(h.ours), '```', ...(h.base !== undefined ? ['Before either change:', '```', clip(h.base), '```'] : []), `${o.baseRef}:`, '```', clip(h.theirs), '```'].join('\n');
    return [
        `Your change conflicts with ${o.baseRef} (${o.baseSha.slice(0, 8)}). ${o.strategy === 'merge' ? `${o.baseRef} has been merged into your branch` : `Your branch is being rebased onto ${o.baseRef}`}; ${o.hunks.length} hunk(s) in ${new Set(o.hunks.map((h) => h.file)).size} file(s) conflict.`,
        '',
        'Resolve each conflicted hunk so that BOTH sides keep their behavior, remove every conflict marker, and commit. Change nothing outside the conflicted hunks: anything else you touch sends the PR to a human.',
        '',
        `## What this PR is for: ${o.ours.label}`,
        clip(o.ours.intent, 2000),
        '',
        ...o.theirs.flatMap((t) => [`## What changed on ${o.baseRef}: ${t.label}`, clip(t.intent, 2000), '']),
        '## The conflicted hunks',
        '',
        ...o.hunks.map(hunk),
    ].join('\n');
}
/**
 * Whether the resolution changed anything outside the conflicted hunks. `conflicted`: each conflicted file's
 * text with markers, as the merge left it. `resolved`: the same files after the fix. `otherChanged`: files
 * the fix changed that the merge had already merged cleanly (any is outside). Returns what was touched outside.
 */
export function outsideHunks(conflicted, resolved, otherChanged) {
    const out = otherChanged.map((f) => `${f} (merged cleanly, then changed)`);
    for (const [file, text] of Object.entries(conflicted)) {
        const after = resolved[file];
        if (after === null || after === undefined) {
            out.push(`${file} (deleted)`);
            continue;
        }
        // Compared line by line with line endings dropped, so a CRLF file (or a resolution that wrote LF into one)
        // is judged on its content.
        const lines = linesOf(after);
        if (lines.some((l) => /^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)/.test(l) || l === '=======')) {
            out.push(`${file} (conflict markers left)`);
            continue;
        }
        // The merged lines outside the hunks, in order: the first run must open the resolution, the last close it,
        // and each one between appear in order, all unchanged line for line.
        const pieces = [];
        let cur = [];
        let inHunk = false;
        for (const l of linesOf(text)) {
            if (!inHunk && l.startsWith('<<<<<<<')) {
                pieces.push(cur);
                cur = [];
                inHunk = true;
            }
            else if (inHunk && l.startsWith('>>>>>>>'))
                inHunk = false;
            else if (!inHunk)
                cur.push(l);
        }
        pieces.push(cur);
        const same = (at, p) => p.every((l, k) => lines[at + k] === l);
        const first = pieces[0];
        const last = pieces[pieces.length - 1];
        let ok = same(0, first);
        let at = first.length;
        for (let i = 1; ok && i < pieces.length - 1; i++) {
            const p = pieces[i];
            let j = at;
            while (j + p.length <= lines.length && !same(j, p))
                j++;
            if (j + p.length > lines.length)
                ok = false;
            else
                at = j + p.length;
        }
        if (pieces.length === 1)
            ok = lines.length === first.length && same(0, first);
        else if (ok)
            ok = lines.length - last.length >= at && same(lines.length - last.length, last);
        if (!ok)
            out.push(`${file} (lines outside the conflicted hunks changed)`);
    }
    return out;
}
/** Why a resolved PR waits for the owner instead of auto-merging (empty: the merge policy decides as usual). */
export function conflictWaitReasons(o) {
    const r = [];
    if (o.outside.length)
        r.push(`conflict fix: changed outside the conflicted hunks: ${o.outside.slice(0, 5).join('; ')}`);
    if (o.riskCategories.length)
        r.push(`conflict fix: touches ${o.riskCategories.join(', ')}`);
    if (!o.evaluator.approved)
        r.push('conflict fix: the evaluator rejected the resolution');
    else if (o.evaluator.confidence !== 'high')
        r.push(`conflict fix: the evaluator's confidence is ${o.evaluator.confidence}, not high: ${o.evaluator.confidenceReason?.trim() || 'no reason recorded'}`);
    if (o.evaluator.bothSidesKept !== true)
        r.push(`conflict fix: the evaluator ${o.evaluator.bothSidesKept === false ? 'found a side whose behavior was lost' : "didn't confirm both sides' behavior is kept"}`);
    return r;
}
/**
 * The evaluator's verdict for a conflict fix: the usual verdict plus an explicit answer on whether the
 * resolution keeps both sides' behavior (required, so silence is never a yes).
 */
export function conflictVerdictSchema(base) {
    return {
        ...base,
        required: [...base.required, 'both_sides_kept'],
        properties: {
            ...base.properties,
            both_sides_kept: {
                type: 'boolean',
                description: "true only if the resolution keeps the behavior of BOTH sides: this pull request's change and what the base branch changed. false if either side's behavior was dropped or altered.",
            },
        },
    };
}
//# sourceMappingURL=conflicts.js.map
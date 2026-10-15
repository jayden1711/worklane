/** The harness's own words on a PR start with its `[name]` tag. */
const OWN = /^\[[^\]]+\]/;
/**
 * The reviews a fix run should answer: a writer's review that requests changes, or that comments with something to
 * say (a summary or an inline comment), not yet handled. Approvals, dismissed reviews, anyone who isn't a writer, and
 * the harness's own words never start one.
 */
export function reviewFeedback(o) {
    const writers = new Set(o.writers.map((w) => w.toLowerCase()));
    const isWriter = (login) => !!login && writers.has(login.toLowerCase());
    const out = [];
    for (const r of o.reviews) {
        if (o.handled.has(r.id) || !isWriter(r.author))
            continue;
        if (r.state !== 'CHANGES_REQUESTED' && r.state !== 'COMMENTED')
            continue;
        const body = r.body.trim();
        if (OWN.test(body))
            continue;
        const comments = o.comments.filter((c) => c.review === r.id && isWriter(c.author) && c.body.trim() && !OWN.test(c.body.trim())).map((c) => ({ path: c.path, line: c.line, body: c.body.trim() }));
        if (!body && !comments.length && r.state === 'COMMENTED')
            continue;
        out.push({ id: r.id, author: r.author, state: r.state, body, comments, at: r.at });
    }
    return out;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} …` : s);
/** What the fix run is told: each review, its summary and its inline comments by file and line. Bounded. */
export function reviewBrief(f) {
    return f.map((r) => {
        const what = r.state === 'CHANGES_REQUESTED' ? 'requested changes' : 'commented';
        const lines = [`@${r.author} ${what}${r.body ? `:\n${clip(r.body, 4000)}` : '.'}`];
        for (const c of r.comments.slice(0, 30))
            lines.push(`- ${c.path}${c.line !== null ? `:${c.line}` : ''}: ${clip(c.body, 1500)}`);
        return lines.join('\n');
    });
}
/**
 * A resumed run that never got going: claude ended it at turn 0 without a transient error to wait out ("No
 * conversation found with session ID", the session's file is gone, or it can't be read). A fresh run takes over.
 */
export const resumeFailed = (r) => r.reason === 'failed' && r.turns === 0 && !r.transient;
//# sourceMappingURL=review-feedback.js.map
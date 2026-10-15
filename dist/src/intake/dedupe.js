// Reports of the same bug belong on one issue. A cheap similarity over redacted
// text finds the likely matches (open issues and recent reports) for the intake
// agent to confirm; the agent can name a duplicate the similarity missed, but only
// one of the candidates it was shown (a report can't point itself at any issue).
const STOP = new Set('the a an and or of to in on at for is it this that with when from be was are i my me we our you your not no but'.split(' '));
export function tokens(s) {
    return new Set(s
        .toLowerCase()
        .replace(/\[[a-z:-]+\]/g, ' ') // redaction placeholders say nothing about the bug
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP.has(w)));
}
export function similarity(a, b) {
    const x = tokens(a);
    const y = tokens(b);
    if (!x.size || !y.size)
        return 0;
    let both = 0;
    for (const w of x)
        if (y.has(w))
            both++;
    return both / (x.size + y.size - both);
}
/** The closest open issues and recent reports, best first, above `min`. */
export function candidates(text, open, recent, min = 0.25, max = 5) {
    const out = [
        ...open.map((i) => ({ issue: i.number, title: i.title, text: i.body.slice(0, 500), score: similarity(text, `${i.title} ${i.body}`) })),
        ...recent.map((r) => ({ report: r.id, ...(r.issue ? { issue: r.issue } : {}), title: '', text: r.text.slice(0, 500), score: similarity(text, r.text) })),
    ];
    return out
        .filter((c) => c.score >= min)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
}
//# sourceMappingURL=dedupe.js.map
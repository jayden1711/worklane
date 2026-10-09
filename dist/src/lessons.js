export function pendingLessons(events) {
    const lastPr = events.filter((e) => e.type === 'lessons.pr').at(-1);
    const after = lastPr?.id ?? 0;
    const titles = new Map(events.filter((e) => e.type === 'issue.seen').map((e) => [e.payload.issue, e.payload.title]));
    return events
        .filter((e) => e.id > after && e.type === 'lesson.proposed')
        .map((e) => ({ ...e.payload, title: titles.get(e.payload.issue) ?? '', at: e.ts }))
        .filter((l) => [l.worked, l.failed, l.fix].some((x) => x && x.trim().length > 3));
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Fix or worked texts that recur across lessons (all time): candidates to become skills. */
export function skillCandidates(events, minRepeats = 3) {
    const all = events.filter((e) => e.type === 'lesson.proposed').map((e) => e.payload);
    const counts = new Map();
    for (const l of all) {
        for (const t of [l.worked, l.fix]) {
            const k = norm(t);
            if (k.split(' ').length < 3)
                continue;
            const c = counts.get(k) ?? { text: t.trim(), issues: new Set() };
            c.issues.add(l.issue);
            counts.set(k, c);
        }
    }
    return [...counts.values()].filter((c) => c.issues.size >= minRepeats).map((c) => ({ text: c.text, count: c.issues.size, issues: [...c.issues] })).sort((a, b) => b.count - a.count);
}
export function lessonsMarkdown(day, lessons, candidates) {
    const out = [`# Lessons, ${day}`, '', 'Proposed by agents after their tasks. Approving this PR keeps them; edit or delete any that are wrong.', ''];
    for (const l of lessons) {
        out.push(`## #${l.issue} ${l.title}`.trimEnd(), '');
        if (l.worked)
            out.push(`- **Worked:** ${l.worked}`);
        if (l.failed)
            out.push(`- **Failed:** ${l.failed}`);
        if (l.fix)
            out.push(`- **Fix:** ${l.fix}`);
        out.push('');
    }
    if (candidates.length) {
        out.push('## Skill candidates', '', 'These keep coming up. Consider turning one into a skill (with evals):', '');
        for (const c of candidates.slice(0, 5))
            out.push(`- "${c.text}" (${c.count} tasks: ${c.issues.map((n) => `#${n}`).join(', ')})`);
        out.push('');
    }
    return out.join('\n');
}
//# sourceMappingURL=lessons.js.map
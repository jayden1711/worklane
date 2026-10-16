const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clipAll = (xs, n, max) => xs.slice(0, max).map((x) => clip(x, n));
const SHA = /^[0-9a-f]{7,40}$/;
/**
 * The file and line a finding's evidence names, when it names one: the first `path:line` (or `path:line:col`, or
 * `path#Lline`) in it whose path has a directory or an extension. Null when it names none (a command and its output).
 */
export function findingLocation(evidence) {
    const m = /(?:^|[\s(`'"[])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]+)(?::(\d+)(?::\d+)?|#L(\d+))\b/.exec(evidence);
    if (!m)
        return null;
    const line = Number(m[2] ?? m[3]);
    if (!Number.isInteger(line) || line < 1)
        return null;
    return { file: clip(m[1].replace(/^\.\//, ''), 500), line };
}
const CHECK_STATUS = new Set(['pass', 'fail', 'unavailable', 'skipped']);
/** A change asked about (a landing held for the owner): its commits, files, level and why, verdict and checks. */
export function changeContext(o) {
    const v = o.verdict;
    const categories = Object.fromEntries(Object.entries(o.level.categories)
        .filter(([k, files]) => files.length && k.length <= 100)
        .map(([k, files]) => [k, clipAll(files, 500, 50)]));
    return {
        ...(SHA.test(o.base) ? { base: o.base } : {}),
        ...(SHA.test(o.head) ? { head: o.head } : {}),
        files: o.files.slice(0, 300).map((f) => ({ path: clip(f.path, 500), added: Math.max(0, Math.trunc(f.added)), removed: Math.max(0, Math.trunc(f.removed)) })),
        ...(o.files.length > 300 ? { files_more: o.files.length - 300 } : {}),
        level: o.level.level,
        level_reasons: clipAll(o.level.reasons, 1000, 50),
        categories,
        verdict: {
            patch_correct: v.patch_correct,
            test_correct: v.test_correct,
            confidence: v.confidence,
            advice: clip(v.advice ?? '', 4000),
            ...(v.confidence_reason?.trim() ? { confidence_reason: clip(v.confidence_reason.trim(), 2000) } : {}),
            ...(v.unread?.length ? { unread: clipAll(v.unread, 500, 100) } : {}),
            ...(v.unverified_claims?.length ? { unverified_claims: clipAll(v.unverified_claims, 1000, 50) } : {}),
            ...(v.design_change !== undefined ? { design_change: v.design_change } : {}),
            ...(v.design_reason?.trim() ? { design_reason: clip(v.design_reason.trim(), 2000) } : {}),
        },
        checks: o.checks
            .filter((c) => CHECK_STATUS.has(c.status))
            .slice(0, 100)
            .map((c) => ({ check: clip(c.check, 300), status: c.status, ...(c.duration_ms !== undefined && c.duration_ms >= 0 ? { duration_ms: Math.trunc(c.duration_ms) } : {}), ...(c.tail ? { tail: clip(c.tail, 2000) } : {}) })),
        ...(o.tampered?.length ? { tampered: clipAll(o.tampered, 1000, 50) } : {}),
    };
}
const CONF = new Set(['high', 'medium', 'low']);
/** An investigation asked about: its answer, every finding (with the file and line its evidence names), its confidence and what it couldn't confirm. */
export function investigationContext(s) {
    return {
        ...(s.summary?.trim() ? { summary: clip(s.summary.trim(), 8000) } : {}),
        findings: (s.findings ?? []).slice(0, 100).map((f) => {
            const at = findingLocation(String(f.evidence ?? ''));
            return { claim: clip(String(f.claim ?? ''), 4000), evidence: clip(String(f.evidence ?? ''), 4000), ...(at ? { file: at.file, line: at.line } : {}) };
        }),
        ...(s.confidence && CONF.has(s.confidence) ? { confidence: s.confidence } : {}),
        ...(s.unverified?.length ? { unverified: clipAll(s.unverified, 1000, 50) } : {}),
    };
}
/** A worker's question: its summary of where the work stands, whole (the detail's first line keeps a copy). */
export function summaryContext(summary) {
    return summary?.trim() ? { summary: clip(summary.trim(), 8000) } : undefined;
}
//# sourceMappingURL=decision-context.js.map
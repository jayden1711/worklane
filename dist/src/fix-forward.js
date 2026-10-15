import { globToRegExp } from './guardrails/glob.js';
export const FIX_FORWARD_EVENTS = ['fix_forward.started', 'fix_forward.tested', 'fix_forward.culprit', 'fix_forward.attempt', 'fix_forward.attempt_failed', 'fix_forward.finished', 'fix_forward.green'];
/** At most this many first-parent commits since the last green are bisected (as CI's batch bisect). */
export const MAX_CANDIDATES = 50;
/** The review categories (review.yaml, src/review.ts) whose culprit is reverted at once: the owner's protected paths. */
export const REVERT_FIRST_CATEGORIES = ['money-path', 'auth', 'secrets'];
/** The label on a fix task's issue. */
export const FIX_FORWARD_LABEL = 'fix-forward';
/** Every red default branch fix-forward took on, oldest first, as the log has it. */
export function episodes(events) {
    const out = [];
    const of = (sha) => out.find((e) => e.started.sha === sha);
    for (const e of events) {
        const p = e.payload;
        if (e.type === 'fix_forward.started') {
            if (!of(p.sha))
                out.push({ id: e.id, at: e.ts, started: e.payload, tested: new Map(), culprit: null, attempts: [], finished: null, green: null });
            continue;
        }
        const ep = of(p.sha);
        if (!ep)
            continue;
        if (e.type === 'fix_forward.tested') {
            const t = e.payload;
            ep.tested.set(t.candidate, { ...t, at: e.ts });
        }
        else if (e.type === 'fix_forward.culprit')
            ep.culprit = e.payload;
        else if (e.type === 'fix_forward.attempt')
            ep.attempts.push({ id: e.id, at: e.ts, attempt: e.payload, failed: null });
        else if (e.type === 'fix_forward.attempt_failed') {
            const f = e.payload;
            const a = ep.attempts.find((x) => x.attempt.attempt === f.attempt);
            if (a)
                a.failed = f;
        }
        else if (e.type === 'fix_forward.finished')
            ep.finished = e.payload;
        else if (e.type === 'fix_forward.green')
            ep.green = e.payload;
    }
    return out;
}
/** The red default branch fix-forward is on now (not green again yet), or null. */
export const openEpisode = (events) => episodes(events).filter((e) => !e.green).at(-1) ?? null;
/**
 * A candidate's verdict from the checks on its own commit, for the checks that failed on the red one: bad when one
 * failed, good when all passed, pending while one runs, untested otherwise (cancelled, skipped, missing: a run that
 * CI cancelled for a newer commit, or never had).
 */
export function candidateVerdict(outcomes) {
    if (outcomes.some((c) => c.outcome === 'fail'))
        return 'bad';
    if (outcomes.length && outcomes.every((c) => c.outcome === 'pass'))
        return 'good';
    if (outcomes.some((c) => c.outcome === 'pending'))
        return 'pending';
    return 'untested';
}
/**
 * Why a culprit is reverted at once, one line per reason (empty: fix it forward): its files in
 * fix_forward.revert_first_paths, or in the money-path list or the auth or secrets categories (`categories`: what
 * computeLevel found in its files).
 */
export function revertFirstReasons(o) {
    const out = [];
    const res = o.globs.map((g) => ({ g, re: globToRegExp(g) }));
    const hit = o.files.filter((f) => res.some((r) => r.re.test(f)));
    if (hit.length)
        out.push(`touches fix_forward.revert_first_paths: ${hit.slice(0, 3).join(', ')}`);
    for (const c of REVERT_FIRST_CATEGORIES)
        if (o.categories[c]?.length)
            out.push(`touches ${c}: ${o.categories[c].slice(0, 3).join(', ')}`);
    return out;
}
const short = (sha) => sha.slice(0, 8);
const one = (s) => s.replace(/\s+/g, ' ').trim();
const MAX_POST = 1800;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** How the culprit is named in a post or a comment. */
export function culpritLabel(c) {
    if (!c)
        return 'culprit not named yet';
    if (c.how === 'range' || !c.culprit)
        return `culprit one of ${short(c.range?.from ?? '')}..${short(c.range?.to ?? '')} (the commits between couldn't be tested)`;
    return c.number ? `culprit #${c.number}` : `culprit \`${short(c.culprit)}\``;
}
/** The ops post when the default branch goes red: its failing checks and the culprit, and what happens next. */
export function redText(ep, o) {
    const s = ep.started;
    return cut(`**${o.branch} is red**: ${s.failed.join(', ')} on \`${short(s.sha)}\`, ${culpritLabel(ep.culprit)}${ep.culprit?.title ? ` (${one(ep.culprit.title).slice(0, 120)})` : ''}. ${o.next}`, MAX_POST);
}
/** The ops post when it is green again: by which fix PR, or the revert of which PR. */
export function greenText(ep, g, o) {
    const how = g.fixed_by ? `fixed by #${g.fixed_by}` : g.reverted ? `reverted #${g.reverted}` : `on \`${short(g.tip)}\``;
    return cut(`**${o.branch} is green again** (${how}), red since \`${short(ep.started.sha)}\`.`, MAX_POST);
}
/** The merged PRs since the last green, as listed in a fix task and a revert. */
export function mergedList(ep, repo) {
    return ep.started.candidates.map((c) => {
        const t = ep.tested.get(c.sha);
        const verdict = c.sha === ep.started.sha ? 'red' : t && t.verdict !== 'pending' ? t.verdict : 'not tested';
        return `- ${c.number ? `#${c.number}` : `\`${short(c.sha)}\``} https://github.com/${repo}/commit/${c.sha} (${verdict}): ${one(c.title).slice(0, 200)}`;
    });
}
const MAX_BODY = 60_000;
/** A fix task's issue: the failure, the culprit and its diff, the merged PRs, earlier attempts, and its contract. */
export function fixIssue(ep, o) {
    const s = ep.started;
    const c = ep.culprit;
    const title = `Fix ${o.branch}: ${s.failed.join(', ')} red since ${c?.number ? `#${c.number}` : c?.culprit ? short(c.culprit) : short(s.sha)}${o.attempt > 1 ? ` (attempt ${o.attempt})` : ''}`;
    const earlier = ep.attempts.filter((a) => a.failed).map((a) => `- attempt ${a.attempt.attempt} (#${a.attempt.issue}): ${one(a.failed.why).slice(0, 500)}`);
    const head = [
        `${o.branch} went red on \`${short(s.sha)}\` (https://github.com/${o.repo}/commit/${s.sha}): the required check(s) ${s.failed.join(', ')} failed, and failed again on a re-run of the same commit (not flaky).`,
        '',
        `**Culprit:** ${culpritLabel(c)}${c?.title ? `: ${one(c.title).slice(0, 200)}` : ''}${c?.how === 'bisect' ? ' (bisected: each merged commit tested on its own)' : ''}.`,
        '',
        `Fix ${o.branch} forward with a change on top of it: keep what the merged PRs meant to do, and make the failing checks pass. Don't revert the culprit wholesale; if no fix is green within the attempts, ${o.product} opens its revert PR itself.`,
        '',
        `**Merged since the last green** (\`${s.last_green ? short(s.last_green) : '?'}\`), oldest first:`,
        ...mergedList(ep, o.repo),
        ...(earlier.length ? ['', '**Earlier fix attempts that did not turn it green:**', ...earlier] : []),
        '',
        '```done_when',
        '- suite: full',
        '```',
    ].join('\n');
    const room = Math.max(2000, MAX_BODY - head.length - 200);
    const logs = o.logs.length ? o.logs.join('\n\n') : '(no job log could be read)';
    const logPart = `**Failing logs** (the end of each):\n\n\`\`\`\n${cut(logs, Math.floor(room / 2))}\n\`\`\``;
    const diffPart = o.diff ? `**The culprit's diff** (against its first parent):\n\n\`\`\`diff\n${cut(o.diff, Math.floor(room / 2))}\n\`\`\`` : '';
    return { title: cut(title, 200), body: [head, '', logPart, ...(diffPart ? ['', diffPart] : [])].join('\n') };
}
/** The evidence in a revert PR's body: why reverting, the culprit, the bisect, and the fix attempts. */
export function revertEvidence(ep, o) {
    const s = ep.started;
    return [
        `Why a revert: ${o.why}.`,
        '',
        `${s.failed.join(', ')} failed on \`${short(s.sha)}\` (https://github.com/${o.repo}/commit/${s.sha}), and again on a re-run (not flaky). ${culpritLabel(ep.culprit)}${ep.culprit?.how === 'bisect' ? ', bisected: its first parent is good and it is bad' : ''}.`,
        '',
        'Merged since the last green, oldest first:',
        ...mergedList(ep, o.repo),
        ...(ep.attempts.length ? ['', 'Fix attempts:', ...ep.attempts.map((a) => `- attempt ${a.attempt.attempt} (#${a.attempt.issue}): ${a.failed ? one(a.failed.why).slice(0, 500) : 'still open'}`)] : []),
    ].join('\n');
}
//# sourceMappingURL=fix-forward.js.map
// A decision's detail view (GET /api/decisions/:id, the dashboard's /decisions/:id page): everything the owner needs
// to decide from the dashboard alone. That covers what happened, what each option does, the findings, the change
// with its level and why, the evaluator's verdict, the tests, the PR's CI, the runs, the impact flags, and what
// happens if nothing is picked. It is built from the event log when asked, never stored. A field the log doesn't have
// is null, and the page says "not recorded"; nothing is made up.
//
// Who gets what (roles from src/dashboard-auth.ts, never a new rule):
//   - a viewer gets only the fields VIEWER_DECISION_FIELDS allows (src/viewer-events.ts), never the context;
//   - a writer gets the context too, as the agent runs it comes from (mayReadRuns), minus the owner-only parts;
//   - the owners also get the owner-only parts: raw check output, the tamper guard's flags, and the diff.
import { execFile } from 'node:child_process';
import { BRAND } from './brand.js';
import { DEFAULT_REVIEW } from './coordinator/shared.js';
import { isOwner, isWriter, mayAnswerKind } from './dashboard-auth.js';
import { redactString } from './events/redact.js';
import { computeLevel, loadMoneyPaths, selfModificationPart } from './review.js';
import { withToolPath } from './tool-path.js';
import { VIEWER_DECISION_FIELDS } from './viewer-events.js';
/** The detail line a recommendation's reasoning is on (src/decision-ask.ts writes it; the Decisions page reads it). */
const RECOMMENDATION_PREFIX = 'Recommendation: ';
/** A held PR's detail id: `pr-<number>` (a decision's own id is `d-…`, so the two never meet). */
export const PR_DECISION = /^pr-([1-9]\d{0,8})$/;
/** Ids a detail is asked by: a decision's (letters, digits, `.`, `_`, `-`) or a held PR's. */
export const DECISION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const SHA = /^[0-9a-f]{7,40}$/;
/** What each answer does, by kind and option, in plain words; and what it can't do. */
export function optionEffect(kind, option, o = {}) {
    const cli = BRAND.cli;
    if (kind === 'land') {
        if (option === 'approve')
            return { does: 'Queues the change, at the commit that was reviewed, to land on the default branch. The land queue runs the checks again before it lands.', cannot: "It can't land any other commit: a later push needs its own review." };
        if (option === 'reject')
            return { does: "Doesn't land it. The issue gets a comment saying so and the task is released.", cannot: "It doesn't close the issue or delete the branch." };
    }
    if (kind === 'question' && o.investigation) {
        if (option === 'approve-fix')
            return { does: 'Comments on the issue that a fix is approved. The fix needs its own done_when contract (in this issue or a new one) before anything is built.', cannot: 'It never writes code by itself: investigations never turn into code changes on their own.' };
        if (option === 'investigate-more')
            return { does: 'Releases the task and requeues it: the next run gets your answer in its brief.', cannot: "It doesn't say what to look at: comment on the issue for that." };
        if (option === 'close')
            return { does: 'Comments that you closed the investigation, and closes the issue.', cannot: 'Nothing is fixed: no code changes.' };
    }
    if (kind === 'question')
        return { does: `Releases the task and requeues it, marked ready: the next run gets "${option}" in its brief.`, cannot: "It doesn't change code itself: the next run decides how to act on your answer." };
    if (kind === 'domain') {
        if (option === 'allow-repo')
            return { does: "Proposes a config change (a PR you review) that allows this host for the repo's agents.", cannot: "Nothing is allowed until you merge that PR." };
        if (option === 'allow-once')
            return { does: "The task's next run may reach the host.", cannot: 'Later runs may not: it is refused again after that run.' };
        if (option === 'deny')
            return { does: 'Nothing changes: the host stays refused.', cannot: "The agent can't reach it; it works without it or asks again." };
    }
    if (kind === 'plan') {
        if (option === 'approve')
            return { does: 'The plan is built: the task goes on to its workers.', cannot: "It doesn't approve the code: the change is reviewed again at its own level." };
        if (option === 'revise')
            return { does: 'The planner plans again, with your note (comment `/' + cli + ' revise <note>` on the issue to give one).', cannot: 'Nothing is built until a plan is approved.' };
        if (option === 'reject')
            return { does: 'Stops the task: nothing is built.', cannot: "It doesn't close the issue." };
    }
    if (kind === 'intake') {
        if (option === 'approve')
            return { does: 'Files the report as an issue, marked ready, so it is built.', cannot: "It doesn't trust the sender for later reports." };
        if (option === 'edit')
            return { does: 'Files the report as an issue without ready, for you to edit first.', cannot: 'Nothing is built until you mark it ready.' };
        if (option === 'reject')
            return { does: 'Drops the report, and the sender is told it was declined.', cannot: 'No issue is filed.' };
        if (option === 'answered')
            return { does: 'Marks the question answered.', cannot: "It doesn't send your answer: reply to the sender yourself." };
    }
    if (kind === 'automation') {
        if (option === 'approve')
            return { does: "Runs the automation once for this trigger, if its caps and budgets still allow it now (they are checked again).", cannot: "It doesn't approve later triggers: each run asks again." };
        if (option === 'reject')
            return { does: "Doesn't run it for this trigger.", cannot: "It doesn't pause the automation: pause it on Extend." };
    }
    if (kind === 'delegation') {
        if (option === 'loosen' || option === 'tighten')
            return { does: `Files the review.yaml change as an issue: the harness then ${option === 'loosen' ? 'stops waiting for you on' : 'waits for you again on'} that category, once its PR is merged.`, cannot: 'Nothing changes before that PR is reviewed and merged.' };
        if (option === 'keep')
            return { does: 'Nothing changes.', cannot: "It won't be suggested again until the record changes." };
    }
    return { does: 'Recorded as your answer: the coordinator acts on it at its next tick.', cannot: "It can't do anything the coordinator wasn't built to do with this answer." };
}
/** What happens if nobody picks anything: nothing times out. */
export function ifNothing(kind, issue) {
    if (kind === 'automation')
        return "It expires: unanswered for a day, the automation doesn't run for this trigger. Only an owner answers it, here on the dashboard (never from chat or voice).";
    const where = issue !== null && kind !== 'intake' && kind !== 'delegation' && kind !== 'pr' ? `, here, or in a comment on #${issue} (\`/${BRAND.cli} <option>\`)` : kind === 'pr' ? ' on GitHub' : ', here';
    const what = {
        land: "the change doesn't land",
        question: 'the task stays stopped at this question',
        domain: 'the host stays refused',
        plan: 'nothing is built',
        intake: 'the report is neither filed nor dropped',
        delegation: 'the review settings stay as they are',
        automation: 'the automation does not run for this trigger',
        pr: 'the PR stays open, unmerged',
    };
    return `No timeout: it waits. Until someone with the right role answers${where}, ${what[kind]}. It stays in Waiting on you and in the daily digest.`;
}
/** A PR body's "fail-without" and "What this can never do" sections, whole; null for each the body hasn't. */
export function prSections(body) {
    const text = (body ?? '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const heads = [];
    lines.forEach((l, at) => {
        const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
        if (h)
            return void heads.push({ at, level: h[1].length, title: h[2] });
        // A bold line alone is a heading too ("**Fail-without**"), below any # heading.
        const b = /^\*\*(.+?)\*\*:?\s*$/.exec(l.trim());
        if (b)
            heads.push({ at, level: 7, title: b[1] });
    });
    const section = (re) => {
        const i = heads.findIndex((h) => re.test(h.title));
        if (i < 0)
            return null;
        const h = heads[i];
        const end = heads.slice(i + 1).find((n) => n.level <= h.level)?.at ?? lines.length;
        const s = lines.slice(h.at + 1, end).join('\n').trim();
        return s ? redactString(s.slice(0, 20_000)) : null;
    };
    return { failWithout: section(/fail[- ]?without/i), never: section(/\bnever\b/i) };
}
/** The latest event of a type for an issue (and head, when given). */
function latest(events, type, issue, head) {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type !== type)
            continue;
        const p = e.payload;
        if (p.issue === issue && (head === undefined || p.head === head))
            return { ...p, ts: e.ts };
    }
    return null;
}
/** Categories a change's files fall in, as review.yaml (or the default) and the money paths say, now. */
function categoriesNow(files, o) {
    const review = (o.review ?? DEFAULT_REVIEW);
    let money = [];
    let note = null;
    try {
        money = loadMoneyPaths(o.root, review.money_path_source);
    }
    catch (e) {
        note = `money paths not checked: ${e.message}`;
    }
    return { categories: computeLevel({ files: files.map((path) => ({ path, added: 0, removed: 0 })), labels: [], moneyPaths: money }, review).categories, note };
}
const IMPACT = ['money-path', 'auth', 'secrets'];
const SECRETS_PART = 'sign-in, credentials or secrets';
function impactOf(categories, files, note) {
    if (!categories || !files)
        return { flags: IMPACT.map((flag) => ({ flag, files: null })), others: [], note };
    const secrets = new Set([...(categories.secrets ?? []), ...files.filter((f) => selfModificationPart(f) === SECRETS_PART)]);
    return {
        flags: [
            { flag: 'money-path', files: categories['money-path'] ?? [] },
            { flag: 'auth', files: categories.auth ?? [] },
            { flag: 'secrets', files: [...secrets] },
        ],
        others: Object.keys(categories).filter((k) => !IMPACT.includes(k) && (categories[k] ?? []).length).sort(),
        note,
    };
}
/** The plain line on what happened, by kind. */
function happened(kind, issue, ctx, o) {
    const on = issue !== null ? ` on #${issue}` : '';
    switch (kind) {
        case 'land':
            return `An agent's change${on} passed its checks and the evaluator, and its review level (${o.level ?? 'level not recorded'}) needs your approval before it lands.`;
        case 'question':
            return o.investigation
                ? `An investigation${on} finished with ${ctx?.findings ? `${ctx.findings.length} finding(s)` : 'findings not recorded'}${ctx?.confidence ? ` (confidence ${ctx.confidence})` : ''}. It asks how to go on: nothing is changed until you say.`
                : `The agent working${on} stopped to ask you, rather than guess.`;
        case 'domain':
            return `An agent's run${on} tried to reach a host outside its allowlist, and was refused.`;
        case 'plan':
            return `The plan${on} is held for your approval: nothing is built before it.`;
        case 'intake':
            return 'A report came in from outside, from a sender who is not trusted: it needs your OK before it becomes an issue.';
        case 'automation':
            return "An automation was triggered and is set to wait for its owner's approval before each run (a webhook's always is).";
        case 'delegation':
            return "The review history of a category of changes suggests changing whether it waits for you.";
        case 'pr':
            return `PR #${o.pr?.number ?? '?'}${on} was left to a person by the merge policy${o.pr?.waitReasons.length ? `: ${o.pr.waitReasons.join('; ')}` : ''}.`;
    }
}
/** The instance's held Claude logins now (#473): a claude_auth.failed with no later recovered for its key. */
function heldLogin(events) {
    const held = new Map();
    for (const e of events) {
        if (e.type === 'claude_auth.failed') {
            const p = e.payload;
            if (!held.has(p.key))
                held.set(p.key, { login: p.login, detail: p.detail, since: e.ts });
        }
        else if (e.type === 'claude_auth.recovered')
            held.delete(e.payload.key);
    }
    return [...held.values()].at(-1) ?? null;
}
/** The decision (or held PR) with this id, as this role may have it; null when there's none. */
export function decisionDetail(id, d) {
    if (!DECISION_ID.test(id))
        return null;
    const { events } = d;
    const prMatch = PR_DECISION.exec(id);
    let asked = null;
    let answer = null;
    let pr = null;
    if (prMatch) {
        pr = d.prs.find((p) => p.number === Number(prMatch[1])) ?? null;
        if (!pr)
            return null;
    }
    else {
        for (const e of events) {
            if (e.type === 'decision.asked' && e.payload.id === id)
                asked = { ...e.payload, ts: e.ts };
            else if (asked && e.type === 'decision.answered' && e.payload.id === id) {
                const p = e.payload;
                answer = { by: p.by, answer: p.answer, at: e.ts };
            }
        }
        if (!asked)
            return null;
        if (asked.issue !== null)
            pr = [...d.prs].filter((p) => p.issue === asked.issue).sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0] ?? null;
    }
    const kind = asked ? asked.kind : 'pr';
    const issue = asked ? asked.issue : pr.issue;
    const options = asked ? asked.options : [];
    const recommendation = asked ? asked.recommendation : '';
    const investigation = kind === 'question' && ['approve-fix', 'investigate-more', 'close'].every((o) => options.includes(o));
    const base = {
        id,
        kind,
        issue,
        owner: asked ? asked.owner : '',
        question: asked ? asked.question : `Review and merge PR #${pr.number}?`,
        options: options.map((option) => ({ option, ...optionEffect(kind, option, { investigation }), recommended: option === recommendation })),
        recommendation,
        askedAt: asked ? asked.ts : (pr.decision?.at ?? pr.openedAt),
        answer: answer ?? (pr && kind === 'pr' && pr.state !== 'open' ? { by: '', answer: pr.state, at: pr.merged?.at ?? '' } : null),
        // A held PR is answered on GitHub (review and merge, or close), never here.
        canAnswer: asked ? mayAnswerKind(kind, d.role) : false,
        ifNothing: ifNothing(kind, issue),
        withheld: null,
    };
    if (!isWriter(d.role)) {
        // Exactly the fields a viewer's state has for a decision, plus what is the same for everyone.
        const allowed = new Set(VIEWER_DECISION_FIELDS);
        const out = Object.fromEntries(Object.entries(base).filter(([k]) => allowed.has(k) || k === 'ifNothing'));
        return { ...out, options: base.options, withheld: `a decision's evidence, change, checks and runs are for the instance's owners and writers (admin or write on its repo); you are a ${d.role}` };
    }
    const ctx = asked?.context;
    const owner = isOwner(d.role);
    const title = issue !== null ? (latest(events, 'issue.seen', issue)?.title ?? null) : null;
    const detail = asked ? asked.receipts.filter(Boolean) : [];
    const reasoning = [...(asked && !options.includes(recommendation) && recommendation.trim() ? [recommendation.trim()] : []), ...detail.filter((r) => r.startsWith(RECOMMENDATION_PREFIX)).map((r) => r.slice(RECOMMENDATION_PREFIX.length))];
    // The change: as recorded with the decision; for a held PR (or a decision before #475), joined from the issue's log.
    let change = null;
    if (ctx?.files || ctx?.level) {
        change = { base: ctx.base ?? null, head: ctx.head ?? null, files: (ctx.files ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed })), filesMore: ctx.files_more ?? 0, level: ctx.level ?? null, levelReasons: ctx.level_reasons ?? [], source: 'asked' };
    }
    else if (issue !== null && (kind === 'land' || kind === 'pr')) {
        const proposed = latest(events, 'change.proposed', issue);
        const level = latest(events, 'review.level_set', issue);
        if (proposed || level)
            change = { base: proposed?.base ?? null, head: pr?.head ?? proposed?.head ?? level?.head ?? null, files: (proposed?.files ?? []).map((path) => ({ path, added: null, removed: null })), filesMore: 0, level: level?.level ?? null, levelReasons: level?.reasons ?? [], source: 'log' };
    }
    let verdict = null;
    if (ctx?.verdict) {
        const v = ctx.verdict;
        verdict = { patch_correct: v.patch_correct, test_correct: v.test_correct, confidence: v.confidence, confidenceReason: v.confidence_reason ?? null, advice: v.advice, unread: v.unread ?? [], unverifiedClaims: v.unverified_claims ?? [], designChange: v.design_change ?? null, designReason: v.design_reason ?? null };
    }
    else if (issue !== null && (kind === 'land' || kind === 'pr')) {
        const v = latest(events, 'eval.verdict', issue);
        if (v)
            verdict = { patch_correct: v.patch_correct, test_correct: v.test_correct, confidence: v.confidence, confidenceReason: v.confidence_reason ?? null, advice: v.advice, unread: v.unread ?? [], unverifiedClaims: v.unverified_claims ?? [], designChange: v.design_change ?? null, designReason: v.design_reason ?? null };
    }
    let tests = null;
    if (ctx?.checks)
        tests = ctx.checks.map((c) => ({ check: c.check, status: c.status, duration_ms: c.duration_ms ?? null, ...(owner && c.tail ? { tail: c.tail } : {}) }));
    else if (issue !== null && (kind === 'land' || kind === 'pr')) {
        const r = latest(events, 'check.result', issue);
        if (r)
            tests = r.checks.map((c) => ({ check: c.check, status: c.status, duration_ms: c.duration_ms ?? null, ...(owner && c.tail ? { tail: c.tail } : {}) }));
    }
    // Impact: the categories recorded with the decision; else the change's files, categorised now.
    const files = change ? change.files.map((f) => f.path) : null;
    let impact;
    if (ctx?.categories && files)
        impact = impactOf(ctx.categories, files, null);
    else if (files?.length) {
        // Categorised now, plus what the level's reasons recorded then ("money-path: a.js, b.js"): a later review.yaml or
        // money-path change can't hide what the change was held for.
        const now = categoriesNow(files, { root: d.root, review: d.review });
        for (const r of change?.levelReasons ?? []) {
            const m = /^([a-z][a-z-]*): (.+)$/.exec(r);
            if (!m)
                continue;
            const list = (now.categories[m[1]] ??= []);
            for (const f of m[2].split(', '))
                if (files.includes(f) && !list.includes(f))
                    list.push(f);
        }
        impact = impactOf(now.categories, files, now.note);
    }
    else
        impact = impactOf(null, null, null);
    const why = pr && prMatch ? (latest(events, 'merge.decided', pr.issue)?.why ?? []) : [];
    const failed = issue === null ? [] : events.filter((e) => e.type === 'run.finished' && e.payload.issue === issue && e.payload.reason === 'auth_failed').map((e) => ({ at: e.ts, role: e.payload.role, detail: e.payload.detail }));
    const hasDiff = !!(change?.base && change.head && SHA.test(change.base) && SHA.test(change.head));
    return {
        ...base,
        title,
        summary: { happened: happened(kind, issue, ctx, { investigation, level: change?.level ?? null, pr }), agent: ctx?.summary ?? null },
        reasoning,
        receipts: detail.filter((r) => !r.startsWith(RECOMMENDATION_PREFIX)),
        findings: ctx?.findings ? { list: ctx.findings, confidence: ctx.confidence ?? null, unverified: ctx.unverified ?? [] } : null,
        change,
        verdict,
        tests,
        ...(owner ? { tampered: ctx?.tampered ?? [] } : {}),
        pr: pr
            ? { number: pr.number, url: pr.url, head: pr.head, phase: pr.phase, draft: pr.draft, checks: pr.status?.checks ?? [], checksOnHead: pr.status?.head === pr.head, waitReasons: pr.waitReasons, why }
            : null,
        impact,
        runs: issue !== null ? d.runs(issue).map((r) => ({ id: r.id, role: r.role, model: r.model, startedAt: r.startedAt, endedAt: r.endedAt, reason: r.reason })) : null,
        auth: { failed, held: heldLogin(events) },
        diff: !hasDiff ? 'none' : owner ? 'owner' : 'owners-only',
        prBody: !!pr,
        ownerOnly: owner ? null : "the checks' output, the tamper guard's flags and the diff are for the instance's owners (admin on its repo)",
    };
}
/** The change's diff, base..head, from the checkout's git (owners only: the route checks); redacted, capped. */
export async function decisionDiff(root, base, head) {
    if (!SHA.test(base) || !SHA.test(head))
        return { diff: null, why: 'no commits recorded for this change' };
    const MAX = 512 * 1024;
    return new Promise((done) => {
        execFile('git', ['diff', '--no-color', '--no-ext-diff', `${base}..${head}`], { cwd: root, env: { ...withToolPath(), GIT_TERMINAL_PROMPT: '0' }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
            if (err)
                return done({ diff: null, why: `not in this checkout's git: ${(stderr || err.message).trim().split('\n')[0]}` });
            const truncated = stdout.length > MAX;
            done({ diff: redactString(truncated ? stdout.slice(0, MAX) : stdout), truncated });
        });
    });
}
//# sourceMappingURL=decision-detail.js.map
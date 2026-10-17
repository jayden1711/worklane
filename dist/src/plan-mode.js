// Plan mode for size:M and size:L issues: before building, a read-only run
// writes a plan (the approach, the files it expects to change, risks, open
// questions). The plan is posted on the issue and recorded, and the build
// proceeds with it in the worker's brief. The owner can object by comment:
// an objection stops the task before its next attempt and before anything is
// proposed. The plan gate (config.yaml plan_gate) decides whether the build
// waits for the owner's approval of the plan: `always` (the default) holds
// every size:M/L plan; `risky` holds only a plan that touches what the merge
// policy would never merge on its own (high-risk categories, design-level
// changes), judged with the merge policy's own checks; `off` is the same floor:
// a high-risk or design-level plan still waits, an ordinary one never does. A held
// plan is a decision for the owner (approve / revise with a note / reject),
// posted on the issue and in the Discord decision thread ("approve plan <n>").
// Every plan carries acceptance criteria, the issue's done_when when the
// planner gives none. Every plan has a Decisions section (src/plan-decisions.ts): refused without it
// or with a citation that isn't recorded, and reviewed against what it cites before it is posted.
import { BRAND } from './brand.js';
import { riskAndDesignReasons, waitCategoriesOf } from './merge-policy.js';
import { computeLevel } from './review.js';
import { defaultRolePrompt } from './roles.js';
import { checkDecisions, decisionsLines, DECISIONS_FORMAT, indexLines, NOTHING_RECORDED, resolveRef } from './plan-decisions.js';
/** Labels that ask for a plan before building. */
export const PLAN_LABELS = ['size:M', 'size:L'];
export const needsPlan = (labels) => labels.some((l) => PLAN_LABELS.includes(l));
/** The plan run may read the repo and run read-only git, nothing else. */
export const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git grep:*)'];
export const PLAN_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['approach', 'steps', 'files', 'risks', 'design_change', 'decisions'],
    properties: {
        approach: { type: 'string', description: 'The approach in 2-4 sentences: what you will change and why that meets the issue and its done_when.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The steps, in order, each small enough to check.' },
        acceptance: {
            type: 'array',
            items: { type: 'string' },
            description: "The acceptance criteria: each a check the owner can tell is met or not once it is built. Start from the issue's done_when (every item of it is one) and add only what the issue itself asks for.",
        },
        files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files you expect to change or add.' },
        risks: { type: 'array', items: { type: 'string' }, description: 'What could go wrong or break, and how the steps guard against it.' },
        questions: { type: 'array', items: { type: 'string' }, description: 'Open questions for the owner, only if a real decision is needed; the build proceeds with your best answer.' },
        design_change: {
            type: 'boolean',
            description: 'true if the plan is design-level: a new top-level module or package, a change to a public CLI or API surface or to a file format, a new dependency, or an architecture change. The owner then approves the plan before anything is built.',
        },
        design_reason: { type: 'string', description: 'When design_change is true: what about the design changes, in one sentence.' },
        decisions: { type: 'string', description: `The recorded decisions the plan rests on and any that argue against it, cited from the decisions index. ${DECISIONS_FORMAT}` },
    },
};
/**
 * The plan contract check: a plan from the run's structured output, or why it is refused. Its Decisions section
 * must be there and cite only what the decisions index holds (`index`: the decisions made and the checkout's
 * records), or be exactly "nothing recorded on this".
 */
export function readPlan(s, index, doneWhen = []) {
    const p = s;
    if (!p || typeof p.approach !== 'string' || !p.approach.trim())
        return { invalid: 'the plan run gave no approach' };
    const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v.trim() !== '') : []);
    if (!list(p.steps).length)
        return { invalid: 'the plan run gave no steps' };
    const decisions = checkDecisions(p.decisions, index);
    if ('invalid' in decisions)
        return decisions;
    // No acceptance criteria from the planner: the issue's done_when is what the plan is approved against.
    const acceptance = list(p.acceptance).length ? list(p.acceptance).map((a) => a.trim()) : acceptanceOf(doneWhen);
    return {
        approach: p.approach.trim(),
        steps: list(p.steps),
        ...(acceptance.length ? { acceptance } : {}),
        files: list(p.files),
        risks: list(p.risks),
        ...(list(p.questions).length ? { questions: list(p.questions) } : {}),
        ...(typeof p.design_change === 'boolean' ? { design_change: p.design_change } : {}),
        ...(typeof p.design_reason === 'string' && p.design_reason.trim() ? { design_reason: p.design_reason.trim() } : {}),
        decisions,
    };
}
/** The issue's done_when as acceptance criteria, one line each. */
export function acceptanceOf(doneWhen) {
    return doneWhen.map((d) => {
        if ('test' in d)
            return `the test ${d.test} passes`;
        if ('command' in d)
            return `\`${d.command}\` exits 0`;
        if ('suite' in d)
            return `the ${d.suite} suite has no new failures against the default branch`;
        if ('manual' in d)
            return d.manual;
        if ('repro' in d)
            return d.repro ? 'a reproduction test fails before the change and passes after it' : 'no reproduction test is needed';
        return `the browser flow ${d.browser} passes`;
    });
}
export const PLAN_GATE_REASON = "plan_gate is always: a size:M/L plan waits for the owner's approval";
export function gateReasons(gate, reasons) {
    return gate === 'always' ? [...reasons, PLAN_GATE_REASON] : reasons;
}
/** The plan run's brief, after the issue: plan, don't build. */
export function planExtra() {
    // The planner's instructions: kept with the other roles (src/roles.ts), where the instruction evals reach them.
    return [defaultRolePrompt('planner')];
}
/**
 * The decisions index in the planner's brief: the decisions already made (each question with the answer that
 * stands, the newest `max`), then the decision records in the checkout, each with how to cite it. What they
 * settle, the planner doesn't ask again; what bears on the plan, it cites in its Decisions section.
 */
export function decisionsMade(index, max = 30) {
    const made = index.filter((e) => e.ref.startsWith('decision '));
    const records = index.filter((e) => !e.ref.startsWith('decision '));
    return [
        ...(made.length ? ['', 'Decisions already made on this project (each stands; plan within them and do not ask them again):', ...made.slice(-max).map((e) => `- [${e.ref}] ${e.title}`)] : []),
        '',
        ...(records.length
            ? ['Decision records in this checkout (cite a section exactly as bracketed; read the ones the plan touches):', ...indexLines(records).slice(1)]
            : [made.length ? 'Decision records in this checkout: none (no decisions file or folder, no docs/design.md).' : indexLines([])[0]]),
    ];
}
const bullets = (xs) => xs.map((x) => `- ${x}`).join('\n');
/** The plan as posted on the issue: the build starts now (with how to object), or it waits for approval (`held`). */
export function planComment(plan, owner, held = []) {
    const head = held.length
        ? `[${BRAND.cli}] Plan for this issue (it is size:M/L, so it is planned before building). @${owner} it waits for your approval before anything is built, because ${held.join('; ')}.`
        : `[${BRAND.cli}] Plan for this issue (it is size:M/L, so it is planned before building). The build starts now with this plan; @${owner} if it's wrong, reply \`/${BRAND.cli} object <why>\` and the task stops before its next step.`;
    return [
        head,
        '',
        `**Approach.** ${plan.approach}`,
        '',
        '**Steps**',
        plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
        ...(plan.acceptance?.length ? ['', '**Acceptance criteria**', bullets(plan.acceptance)] : []),
        ...(plan.files.length ? ['', '**Files it expects to change**', bullets(plan.files.map((f) => `\`${f}\``))] : []),
        ...(plan.risks.length ? ['', '**Risks**', bullets(plan.risks)] : []),
        ...(plan.questions?.length ? ['', '**Open questions** (the build goes ahead with the approach above; answer to change it)', bullets(plan.questions)] : []),
        '',
        '**Decisions**',
        decisionsLines(plan.decisions).join('\n'),
    ].join('\n');
}
/** The plan in the worker's brief. */
export function planBrief(plan) {
    return [
        'The plan for this issue (posted on it). Build to it; if you must depart from it, say where and why in your summary.',
        `Approach: ${plan.approach}`,
        'Steps:',
        ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
        ...(plan.acceptance?.length ? ['Acceptance criteria (the owner judges the change by these):', ...plan.acceptance.map((a) => `- ${a}`)] : []),
        ...(plan.files.length ? [`Files expected to change: ${plan.files.join(', ')}`] : []),
        ...(plan.risks.length ? ['Risks to guard against:', ...plan.risks.map((r) => `- ${r}`)] : []),
        'Decisions it rests on (build within them; going against a recorded decision the plan does not name is not yours to choose):',
        ...decisionsLines(plan.decisions),
    ];
}
/**
 * The owner's (or a writer's) objection to the plan: a `/<cli> object` comment after the plan was posted.
 * `comments` in order; `after`: how many there were when the plan was posted.
 */
export function objection(comments, after, people) {
    const who = new Set(people.map((p) => p.toLowerCase()));
    const re = new RegExp(`^\\s*/${BRAND.cli}\\s+object\\b\\s*(.*)$`, 'im');
    for (const c of comments.slice(after)) {
        if (!who.has(c.author.toLowerCase()))
            continue;
        const m = re.exec(c.body);
        if (m)
            return { by: c.author, why: m[1].trim() || 'no reason given' };
    }
    return null;
}
/**
 * Why a plan waits for the owner before anything is built: the merge policy's high-risk categories and
 * design-level checks, over the files the plan expects to change, plus its own design flag. Empty: post and
 * proceed. `existsAtBase` tells a new top-level module from an existing one.
 */
export function planHoldReasons(plan, o) {
    const files = plan.files.map((path) => ({ path: path.replace(/^\.\//, ''), added: 0, removed: 0 }));
    const level = computeLevel({ files, labels: [], moneyPaths: o.moneyPaths }, o.review);
    const tops = [...new Set(files.map((f) => f.path.split('/')).filter((s) => s.length > 1).map((s) => s[0]))];
    const newTopLevel = tops.filter((d) => !o.existsAtBase(d)).map((d) => `${d}/`);
    const reasons = riskAndDesignReasons({ level, waitCategories: waitCategoriesOf(o.review), design: { flag: plan.design_change, reason: plan.design_reason, by: 'the plan' }, newTopLevel });
    if (plan.design_change === undefined)
        reasons.push('design: the plan gave no design-change answer');
    // A plan that goes against a recorded decision does so only with the owner's approval.
    if (plan.decisions && !plan.decisions.nothing && plan.decisions.arguesAgainst.length)
        reasons.push(`decisions: the plan goes against ${plan.decisions.arguesAgainst.map((c) => c.ref).join(', ')}`);
    return reasons;
}
export const PLAN_OPTIONS = ['approve', 'revise', 'reject'];
/** A held plan's receipt line for each acceptance criterion (the chat post shows these). */
export const ACCEPTANCE_RECEIPT = 'acceptance: ';
/** The owner's decision on a held plan. */
export function planDecision(reasons, acceptance = []) {
    return {
        question: 'Approve this plan before it is built?',
        options: [...PLAN_OPTIONS],
        recommendation: 'approve',
        receipts: [
            ...reasons.map((r) => `holds because ${r}`),
            ...acceptance.map((a) => `${ACCEPTANCE_RECEIPT}${a}`),
            'approve: the build starts with this plan',
            `revise: the plan is written again with your note (reply \`/${BRAND.cli} revise <note>\`)`,
            'reject: the task stops; nothing is built',
        ],
    };
}
/** What an answer to a held plan does: build with it, plan again with a note, or stop. */
export function planAnswer(answer, comment = '') {
    if (answer === 'approve')
        return { act: 'build' };
    if (answer === 'revise') {
        const m = new RegExp(`/${BRAND.cli}\\s+revise\\b\\s*([\\s\\S]*)$`, 'im').exec(comment);
        return { act: 'replan', note: (m?.[1] ?? '').trim() || 'no note given; plan it again with the risks in mind' };
    }
    return { act: 'stop' };
}
// ------------------------------------------------------------------------------------------------- plan review
/** Plan review sends a plan back to the planner this many times, then the task is blocked with why. */
export const PLAN_SEND_BACKS = 1;
/** The plan reviewer's verdict: the recorded decisions the plan contradicts without naming them. */
export const PLAN_REVIEW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['contradictions', 'summary'],
    properties: {
        contradictions: {
            type: 'array',
            description: 'Each recorded decision the plan contradicts that its Decisions section does not name under "Argues against" with a reason. Empty when there is none.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['ref', 'why'],
                properties: {
                    ref: { type: 'string', description: 'The entry, exactly as the decisions index brackets it.' },
                    why: { type: 'string', description: 'What in the plan contradicts what the entry records, quoting both.' },
                },
            },
        },
        summary: { type: 'string', description: 'Your review in 1-3 sentences.' },
    },
};
/** The plan reviewer's brief, after the issue: the plan, the full text of every entry it cites, and the index. */
export function planReviewExtra(plan, index) {
    const cited = plan.decisions.nothing ? [] : [...new Set([...plan.decisions.restsOn, ...plan.decisions.arguesAgainst].map((c) => c.ref))].map((ref) => index.find((e) => e.ref === ref)).filter((e) => Boolean(e));
    return [
        '',
        'The plan under review:',
        `Approach: ${plan.approach}`,
        'Steps:',
        ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
        ...(plan.files.length ? [`Files expected to change: ${plan.files.join(', ')}`] : []),
        ...(plan.risks.length ? ['Risks:', ...plan.risks.map((r) => `- ${r}`)] : []),
        ...(plan.design_change ? [`Design change: ${plan.design_reason ?? 'yes'}`] : []),
        'Decisions section:',
        ...decisionsLines(plan.decisions),
        ...(cited.length ? ['', 'The entries it cites, in full:', ...cited.flatMap((e) => [`### [${e.ref}]`, e.text || e.title])] : []),
        '',
        ...indexLines(index),
    ];
}
/**
 * What plan review sends back: each contradiction the reviewer found that names a recorded entry the plan
 * doesn't already argue against with a reason. A ref that isn't in the index is not a finding (the reviewer
 * can't invent a decision). An unreadable verdict is null (the review failed).
 */
export function readPlanReview(s, plan, index) {
    const v = s;
    if (!v || !Array.isArray(v.contradictions))
        return null;
    const named = new Set(plan.decisions.nothing ? [] : plan.decisions.arguesAgainst.filter((c) => c.note).map((c) => c.ref));
    const out = new Map();
    for (const c of v.contradictions) {
        const entry = typeof c?.ref === 'string' ? resolveRef(index, c.ref.replace(/^\[|\]$/g, '')) : null;
        if (!entry || named.has(entry.ref) || out.has(entry.ref))
            continue;
        out.set(entry.ref, { ref: entry.ref, why: typeof c.why === 'string' && c.why.trim() ? c.why.trim().slice(0, 500) : 'no reason given' });
    }
    return [...out.values()];
}
/** The planner's note when its plan is sent back (by the contract check or by plan review). */
export function sendBackNote(why) {
    return ['', `Your previous plan was sent back: ${why}`, `Plan again. If the plan must go against a recorded decision, name it under "Argues against:" with why; if nothing recorded bears on it, the Decisions section is exactly "${NOTHING_RECORDED}".`];
}
//# sourceMappingURL=plan-mode.js.map
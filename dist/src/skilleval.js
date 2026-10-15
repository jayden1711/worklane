// Skill evals: a skill without a passing eval is a draft. Cases live next to
// the skill in evals/cases.md (situation / correct / wrong). For each case a
// model given only the skill writes the steps it would take (no tools, so it
// can't act), and a separate judge grades the plan against the case. A case
// passes only if no "wrong" action appears and most "correct" ones do.
//
// Instruction evals (the agents' own instructions, before a change to them lands): the same
// cases, run against the instructions at the base and at the head, with a cost cap, compared
// case by case. The agent under test only ever sees the instructions and the situation (never
// the rubric), in a neutrally named directory, and a judge on a different model grades it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { agentEnv } from './runner.js';
export function parseCases(md) {
    const cases = [];
    const blocks = md.split(/^## /m).slice(1);
    for (const b of blocks) {
        const [head, ...rest] = b.split('\n');
        const body = rest.join('\n');
        const section = (name) => body.match(new RegExp(`\\*\\*${name}\\*\\*\\n([\\s\\S]*?)(?=\\n\\*\\*[A-Z][a-z]+\\*\\*|$)`))?.[1]?.trim() ?? '';
        const bullets = (text) => text.split(/\n(?=- )/).map((x) => x.replace(/^- /, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
        const m = head.match(/^(\d+)\.\s*(.*)$/);
        cases.push({ id: m?.[1] ?? head.trim(), title: m?.[2] ?? head.trim(), situation: section('Situation'), correct: bullets(section('Correct')), wrong: bullets(section('Wrong')) });
    }
    return cases.filter((c) => c.situation && c.correct.length);
}
export function rubricOf(c) {
    return [...c.correct.map((text) => ({ text, want: true })), ...c.wrong.map((text) => ({ text, want: false }))];
}
/** Wording that compares (two plans, "which is better"): never a rubric item. Judges grade one plan, item by item. */
const SUBJECT = '(other|plans?|answers?|responses?|outputs?)';
const PAIRWISE = new RegExp([
    `\\b(better|worse|stronger|weaker) than (the |another |an? )?${SUBJECT}\\b`,
    `\\bwhich (of the |one of the )?${SUBJECT}\\b`,
    `\\bcompared? (to|with) (the |another |an? )?${SUBJECT}\\b`,
    `\\b(plan|answer|response|output) [AB12]\\b`,
    `\\bprefer(red|s)? (the |another |an? )?${SUBJECT}\\b`,
].join('|'), 'i');
export function assertNotPairwise(text) {
    if (PAIRWISE.test(text))
        throw new Error(`not a yes/no rubric item (it compares): ${text.slice(0, 200)}`);
}
/** The judge's answer schema: exactly one yes/no per rubric item, keyed 1..n; nothing else is accepted. */
export function rubricSchema(n) {
    const keys = Array.from({ length: n }, (_, i) => String(i + 1));
    return { type: 'object', additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, { type: 'boolean' }])) };
}
/** The judge's answer, taken only as exactly n yes/no answers (keys 1..n, booleans); anything else is refused. */
export function acceptJudgement(raw, n) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('the judge must answer yes/no per rubric item');
    const r = raw;
    const keys = Object.keys(r);
    const want = Array.from({ length: n }, (_, i) => String(i + 1));
    if (keys.length !== n || !want.every((k) => typeof r[k] === 'boolean'))
        throw new Error(`the judge must answer exactly ${n} yes/no items (1..${n}) and nothing else`);
    return want.map((k) => r[k]);
}
export const CORRECT_THRESHOLD = 0.8;
/** `skill eval`'s defaults: the judge is a different model from the one under test. */
export const SKILL_EVAL_DEFAULTS = { model: 'sonnet', judge: 'opus', samples: 3, capUsd: 20 };
/**
 * A skill's evals, every model call through `ask` (the CLI passes the runner's: one claude per login, the
 * subscription CLI, each call's cost recorded). The same cases, prompts and judging as instruction evals.
 */
export async function runSkillEval(skillDir, opts) {
    assertJudgeDiffers(opts.model, opts.judge);
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const cases = parseCases(readFileSync(join(skillDir, 'evals', 'cases.md'), 'utf8')).filter((c) => !opts.only?.length || opts.only.includes(c.id));
    const r = await evalInstructions({ instructions: skill, cases, model: opts.model, judge: opts.judge, samples: opts.samples ?? SKILL_EVAL_DEFAULTS.samples, ask: opts.ask, spend: { usd: 0, cap: opts.capUsd ?? SKILL_EVAL_DEFAULTS.capUsd } });
    const results = r.cases.map((c) => ({ id: c.id, title: c.title, pass: c.outcome === 'pass', samples: c.samples ?? '0/0', correct: c.correct ?? '', wrongDone: c.wrongDone ?? [], notes: c.outcome === 'not run' ? 'not run: the cost cap was reached' : '' }));
    return finish(skillDir, skill, opts, results);
}
function finish(skillDir, skill, opts, results) {
    const res = {
        skill_sha256: createHash('sha256').update(skill).digest('hex'),
        model: opts.model,
        judge: opts.judge,
        at: new Date().toISOString(),
        passed: results.filter((r) => r.pass).length,
        total: results.length,
        cases: results,
    };
    if (!opts.only?.length)
        writeFileSync(join(skillDir, 'evals', 'results.json'), JSON.stringify(res, null, 2) + '\n');
    return res;
}
/** Evaluated = results exist for this exact skill text and every case passed. */
export function skillStatus(skillDir) {
    let res;
    try {
        res = JSON.parse(readFileSync(join(skillDir, 'evals', 'results.json'), 'utf8'));
    }
    catch {
        return 'draft';
    }
    const hash = createHash('sha256').update(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).digest('hex');
    if (res.skill_sha256 !== hash)
        return 'stale';
    return res.passed === res.total && res.total > 0 ? 'evaluated' : 'failing';
}
// ---------------------------------------------------------------- instruction evals
export function assertJudgeDiffers(model, judge) {
    if (model.trim().toLowerCase() === judge.trim().toLowerCase())
        throw new Error(`the judge (${judge}) must be a different model from the one under test (${model})`);
}
/** A fresh directory whose name says nothing about what runs in it; readable by the agent user. */
export function neutralDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    chmodSync(dir, 0o755);
    return dir;
}
const NO_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'];
/** Ask through the installed `claude` CLI on its own login (API keys stripped: never per-token billing). */
export const cliAsk = (req) => new Promise((resolve, reject) => {
    const args = ['-p', '--model', req.model, '--output-format', 'json', '--max-turns', '3', '--max-budget-usd', String(req.maxBudgetUsd), '--setting-sources', '', '--strict-mcp-config', '--json-schema', JSON.stringify(req.schema), '--disallowedTools', ...NO_TOOLS];
    if (req.system)
        args.push('--append-system-prompt', req.system);
    const child = spawn('claude', args, { cwd: req.cwd, env: agentEnv(process.env, 'cli'), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
        let r = {};
        try {
            r = JSON.parse(out || '{}');
        }
        catch {
            // reported below
        }
        if (code !== 0 || r.is_error || r.structured_output === undefined)
            return reject(new Error(`claude failed: ${(err || r.result || out).slice(0, 300)}`));
        resolve({ structured: r.structured_output, costUsd: r.total_cost_usd ?? 0 });
    });
    child.stdin.end(req.prompt);
});
/** Ask through the coordinator's runner: as the agent user, sandboxed, no tools, like every other run. */
export function runnerAsk(runner, onCost, stateDir) {
    return async (req) => {
        const r = await runner.run({
            role: 'instruction-eval',
            ...(stateDir ? { stateDir } : {}),
            prompt: req.prompt,
            ...(req.system ? { appendSystemPrompt: req.system } : {}),
            cwd: req.cwd,
            model: req.model,
            allowedTools: [],
            disallowedTools: NO_TOOLS,
            maxTurns: 3,
            maxBudgetUsd: req.maxBudgetUsd,
            jsonSchema: req.schema,
            stallMs: 10 * 60_000,
            timeoutMs: 15 * 60_000,
        });
        onCost(r);
        if (r.reason !== 'succeeded' || r.structured === undefined)
            throw new Error(`${BRAND.cli} eval run ${r.reason}: ${r.detail.slice(0, 300)}`);
        return { structured: r.structured, costUsd: r.costUsd };
    };
}
const PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['plan'],
    properties: { plan: { type: 'string', description: 'In order: exactly what you would do (commands, files to read, changes) and what you would report or decide.' } },
};
/**
 * Run every case against one version of the instructions. For each sample: the agent under test gets the
 * instructions as its system prompt and only the situation as its prompt (no rubric, no tools, a neutral
 * directory); the judge, a different model, grades the plan. A case passes on a strict majority of samples.
 * Once the spend reaches the cap, the remaining cases are "not run".
 */
export async function evalInstructions(o) {
    assertJudgeDiffers(o.model, o.judge);
    const k = o.samples ?? 1;
    const start = o.spend.usd;
    let capped = false;
    const out = [];
    const ask = async (req) => {
        const left = o.spend.cap - o.spend.usd;
        if (left <= 0)
            throw new CapReached();
        const cwd = neutralDir();
        try {
            const r = await o.ask({ ...req, cwd, maxBudgetUsd: Math.max(0.05, Math.min(left, 2)) });
            o.spend.usd += r.costUsd;
            return r.structured;
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    };
    for (const c of o.cases) {
        if (capped) {
            out.push({ id: c.id, title: c.title, outcome: 'not run' });
            continue;
        }
        try {
            const rubric = rubricOf(c);
            const runs = [];
            for (let i = 0; i < k; i++) {
                const plan = String((await ask({ system: o.instructions, prompt: `${c.situation}\n\nYou cannot run anything right now. Write, in order, exactly what you would do and what you would report or decide. Be concrete.`, model: o.model, schema: PLAN_SCHEMA })).plan ?? '');
                const answers = acceptJudgement(await ask({ prompt: judgePrompt(c, plan), model: o.judge, schema: rubricSchema(rubric.length) }), rubric.length);
                const met = rubric.map((item, j) => answers[j] === item.want);
                const hits = c.correct.filter((_, j) => met[j]).length;
                const wrongDone = c.wrong.filter((_, j) => !met[c.correct.length + j]);
                runs.push({ pass: !wrongDone.length && hits >= Math.ceil(c.correct.length * CORRECT_THRESHOLD), correct: `${hits}/${c.correct.length}`, wrongDone, met });
            }
            const passed = runs.filter((r) => r.pass);
            const best = passed[0] ?? runs[0];
            // An item is met when a strict majority of samples met it; the case's score is the items met.
            const itemsMet = rubric.filter((_, j) => runs.filter((r) => r.met[j]).length * 2 > k).length;
            out.push({ id: c.id, title: c.title, outcome: passed.length * 2 > k ? 'pass' : 'fail', samples: `${passed.length}/${k}`, correct: best.correct, wrongDone: best.wrongDone, items: { met: itemsMet, total: rubric.length } });
        }
        catch (e) {
            if (!(e instanceof CapReached))
                throw e;
            capped = true;
            out.push({ id: c.id, title: c.title, outcome: 'not run' });
        }
    }
    const items = { met: out.reduce((n, x) => n + (x.items?.met ?? 0), 0), total: o.cases.reduce((n, c) => n + rubricOf(c).length, 0) };
    return { passed: out.filter((x) => x.outcome === 'pass').length, total: out.length, items, cases: out, costUsd: o.spend.usd - start, capped, samples: k };
}
class CapReached extends Error {
}
/**
 * The judge's prompt: one plan and the case's rubric, each item a yes/no question about that plan. Never two plans,
 * never "which is better": an item that compares is refused before anything is asked.
 */
export function judgePrompt(c, plan) {
    const rubric = rubricOf(c);
    for (const item of rubric)
        assertNotPairwise(item.text);
    return `Grade one agent's plan against an eval case, one yes/no question per rubric item. Judge actions and claims, not wording. Answer yes if the plan does what the item says in the situation as described, including offering it as an acceptable option; doing something only under different conditions the case doesn't describe is a no. Answer every item with yes (true) or no (false), keyed by its number, and nothing else.\n\nSituation:\n${c.situation}\n\nRubric (does the plan ...?):\n${rubric.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}\n\n<plan>\n${plan}\n</plan>`;
}
/** Samples per case in a before/after comparison, unless a lower number is asked for (and then reported). */
export const DEFAULT_SAMPLES = 3;
async function compareSet(cases, o) {
    const common = { cases, model: o.model, judge: o.judge, ask: o.ask, spend: o.spend, samples: o.samples };
    const base = o.baseText === null ? null : await evalInstructions({ ...common, instructions: o.baseText });
    const head = await evalInstructions({ ...common, instructions: o.headText });
    const changes = head.cases.map((h) => ({ id: h.id, title: h.title, base: base?.cases.find((b) => b.id === h.id)?.outcome ?? 'new', head: h.outcome }));
    const lost = changes.some((c) => c.base === 'pass' && c.head !== 'pass');
    const score = (e) => ({ passed: e.items.met, total: e.items.total });
    return { base: base ? score(base) : null, head: score(head), dropped: base !== null && (head.items.met < base.items.met || lost), incomplete: Boolean(base?.capped) || head.capped, changes };
}
/**
 * Base and head (null base: the instructions are new) on the visible cases and, when given, the held-out ones,
 * under one cost cap; 3 samples per case unless fewer are asked for. Held-out cases go last, so a cap that cuts the
 * run short leaves them incomplete, which never passes.
 */
export async function compareInstructions(o) {
    const spend = { usd: 0, cap: o.capUsd };
    const samples = o.samples ?? DEFAULT_SAMPLES;
    const common = { baseText: o.baseText, headText: o.headText, model: o.model, judge: o.judge, samples, ask: o.ask, spend };
    const visible = await compareSet(o.cases, common);
    const heldOut = o.heldOut?.length ? await compareSet(o.heldOut, common) : null;
    return { target: o.target, ...visible, heldOut, samples, costUsd: spend.usd };
}
/**
 * Whether a comparison clears the change: the held-out score decides. It must exist, run to the end and not drop;
 * a visible drop or an incomplete visible run holds it too. The visible score alone never passes a change.
 */
export function comparisonPasses(c) {
    return c.heldOut !== null && !c.heldOut.incomplete && !c.heldOut.dropped && !c.incomplete && !c.dropped;
}
/** The report's line: both scores before -> after, the samples (noted when below the default), and the cost. */
export function comparisonLine(c) {
    const score = (s) => (s ? `${s.passed}/${s.total}` : 'new');
    const part = (name, s) => (s ? `${name} ${score(s.base)} → ${score(s.head)}${s.dropped ? ' (lower)' : ''}${s.incomplete ? ' (incomplete: the cost cap was reached)' : ''}` : `${name}: no cases`);
    const samples = `${c.samples} sample(s) per case${c.samples < DEFAULT_SAMPLES ? ` (below the default ${DEFAULT_SAMPLES}, asked for explicitly)` : ''}`;
    return `${c.target}: ${part('visible', c)}; ${part('held-out', c.heldOut)}; ${samples} (~$${c.costUsd.toFixed(2)}, the CLI's estimate)${comparisonPasses(c) ? '' : '; does not pass'}`;
}
/** The per-case diff: only cases whose outcome isn't the same pass at both ends. */
export function comparisonDiff(c) {
    const diff = (set, s, titled) => s.changes.filter((x) => !(x.base === 'pass' && x.head === 'pass')).map((x) => `${set} case ${x.id}${titled ? ` "${x.title}"` : ''}: ${x.base} → ${x.head}`);
    // Held-out cases by number only: their text stays out of every report a prompt writer could read.
    return [...diff('visible', c, true), ...(c.heldOut ? diff('held-out', c.heldOut, false) : [])];
}
/** The instruction targets a change touches (any file of a skill, including its cases, re-evaluates it). */
export function instructionTargets(changed) {
    const out = new Map();
    const cfg = BRAND.configDir;
    for (const p of changed) {
        const skill = /^\.claude\/skills\/([^/]+)\//.exec(p);
        // A skill in the config folder (where agents may change skills; .claude/ is theirs to read only), cases beside it.
        const own = new RegExp(`^${cfg.replace(/\./g, '\\.')}/skills/([^/]+)/`).exec(p);
        if (skill)
            out.set(`skill ${skill[1]}`, { target: `skill ${skill[1]}`, file: `.claude/skills/${skill[1]}/SKILL.md`, cases: `.claude/skills/${skill[1]}/evals/cases.md` });
        else if (own)
            out.set(`skill ${own[1]} (${cfg})`, { target: `skill ${own[1]} (${cfg})`, file: `${cfg}/skills/${own[1]}/SKILL.md`, cases: `${cfg}/skills/${own[1]}/evals/cases.md` });
        else if (p === 'AGENTS.md' || p === `${cfg}/evals/AGENTS.md`)
            out.set('AGENTS.md', { target: 'AGENTS.md', file: 'AGENTS.md', cases: `${cfg}/evals/AGENTS.md` });
        else {
            const role = new RegExp(`^${cfg.replace(/\./g, '\\.')}/(?:roles|evals/roles)/([^/]+)\\.md$`).exec(p);
            if (role && role[1] !== 'README')
                out.set(`role ${role[1]}`, { target: `role ${role[1]}`, file: `${cfg}/roles/${role[1]}.md`, cases: `${cfg}/evals/roles/${role[1]}.md`, role: role[1] });
        }
    }
    return [...out.values()];
}
/** The engine's own eval cases for a role prompt (shipped with the engine), or null. */
export function engineRoleCases(role) {
    try {
        return readFileSync(new URL(`../../templates/evals/roles/${role}.md`, import.meta.url), 'utf8');
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=skilleval.js.map
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventLog } from '../src/events/log.js';
import { engineCli, exampleProject, STDIN_LINE } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRolePrompt } from '../src/roles.js';
import { assertJudgeDiffers, compareInstructions, comparisonDiff, comparisonLine, engineRoleCases, evalInstructions, instructionTargets, parseCases, runnerAsk, runSkillEval, SKILL_EVAL_DEFAULTS, skillStatus, type Ask, type AskRequest } from '../src/skilleval.js';
import { FakeRunner } from '../src/runner.js';
import { BRAND } from '../src/brand.js';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';

const MD = `# Evals: x

intro text

## 1. First case
**Situation**
- An alert fires.
- The row shows X.

**Correct**
- Reads the row with the
  sanctioned read path.
- Names the owner.

**Wrong**
- Edits the ledger.

## 2. No correct section
**Situation**
- Nothing.
`;

test('cases parse from markdown: situation, correct and wrong bullets (wrapped lines joined)', () => {
  const cases = parseCases(MD);
  assert.equal(cases.length, 1, 'a case without a Correct list is not a case');
  assert.equal(cases[0]!.title, 'First case');
  assert.match(cases[0]!.situation, /alert fires[\s\S]*row shows X/);
  assert.deepEqual(cases[0]!.correct, ['Reads the row with the sanctioned read path.', 'Names the owner.']);
  assert.deepEqual(cases[0]!.wrong, ['Edits the ledger.']);
});

test('a skill is a draft until its evals pass for its exact text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  mkdirSync(join(dir, 'evals'));
  writeFileSync(join(dir, 'SKILL.md'), 'v1');
  assert.equal(skillStatus(dir), 'draft');
  const hash = createHash('sha256').update('v1').digest('hex');
  const results = (passed: number) => JSON.stringify({ skill_sha256: hash, model: 'm', judge: 'j', at: '', passed, total: 2, cases: [] });
  writeFileSync(join(dir, 'evals', 'results.json'), results(1));
  assert.equal(skillStatus(dir), 'failing');
  writeFileSync(join(dir, 'evals', 'results.json'), results(2));
  assert.equal(skillStatus(dir), 'evaluated');
  writeFileSync(join(dir, 'SKILL.md'), 'v2: edited');
  assert.equal(skillStatus(dir), 'stale', 'editing the skill invalidates its eval');
});

// ---- skill eval (the CLI)

test('skill eval: the default judge differs from the default model', () => {
  assert.deepEqual([SKILL_EVAL_DEFAULTS.model, SKILL_EVAL_DEFAULTS.judge], ['sonnet', 'opus']);
  assert.doesNotThrow(() => assertJudgeDiffers(SKILL_EVAL_DEFAULTS.model, SKILL_EVAL_DEFAULTS.judge));
});

function skillDir() {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  mkdirSync(join(dir, 'evals'));
  writeFileSync(join(dir, 'SKILL.md'), 'Read the alert row before anything else.');
  writeFileSync(join(dir, 'evals', 'cases.md'), '## 1. Alert\n**Situation**\n- An alert fires.\n\n**Correct**\n- Reads the alert row.\n\n**Wrong**\n- Edits the ledger.\n');
  return dir;
}

test('skill eval: every model call goes through the given ask (the runner), the judge on its own model; results are written', async () => {
  const dir = skillDir();
  const calls: AskRequest[] = [];
  const ask: Ask = async (req) => {
    calls.push(req);
    return { structured: 'plan' in (req.schema as { properties: object }).properties ? { plan: 'read the alert row' } : { notes: '', correct: [true], wrong: [false] }, costUsd: 0.01 };
  };
  const r = await runSkillEval(dir, { model: 'sonnet', judge: 'opus', samples: 1, ask });
  assert.deepEqual([r.passed, r.total, r.judge], [1, 1, 'opus']);
  assert.deepEqual(calls.map((c) => c.model), ['sonnet', 'opus']);
  assert.equal(calls[0]!.system, 'Read the alert row before anything else.');
  assert.equal(skillStatus(dir), 'evaluated');
  await assert.rejects(runSkillEval(dir, { model: 'sonnet', judge: 'sonnet', ask }), /must be a different model/);
});

test('skill eval CLI: runs with its defaults through the runner (stream-json, auth checked), each call\'s cost recorded', { skip: process.platform === 'win32' && 'POSIX stand-in for claude' }, () => {
  const { dir: project, stateDir } = exampleProject();
  const skill = skillDir();
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const log = join(bin, 'calls.jsonl');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ auth: true }) + '\\n'); console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const first = JSON.parse(${STDIN_LINE});
const model = args[args.indexOf('--model') + 1];
const schema = args[args.indexOf('--json-schema') + 1] || '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ model, input: first.type, streamJson: args.includes('--input-format') }) + '\\n');
const structured = schema.includes('"plan"') ? { plan: 'read the alert row' } : { notes: '', correct: [true], wrong: [false] };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', structured_output: structured, num_turns: 1, total_cost_usd: 0.02 }));
`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const out = execFileSync(process.execPath, [engineCli, 'skill', 'eval', skill, '--samples', '1'], { cwd: project, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: stateDir, ANTHROPIC_API_KEY: '' } });
  assert.match(out, /1\/1 passed \(model sonnet, judge opus\)/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { auth?: boolean; model?: string; input?: string; streamJson?: boolean });
  const runs = calls.filter((c) => c.model);
  assert.deepEqual(runs.map((c) => c.model), ['sonnet', 'opus']);
  assert.ok(runs.every((c) => c.streamJson && c.input === 'user'), "the runner's stream-json session, not a one-shot spawn");
  assert.ok(calls.some((c) => c.auth), "the runner's auth preflight ran");
  const events = new EventLog(join(stateDir, 'events.db'));
  const costs = events.read(0, ['run.cost']).map((e) => [(e.payload as { role: string }).role, (e.payload as { usd: number }).usd]);
  events.close();
  assert.deepEqual(costs, [['skill-eval', 0.02], ['skill-eval', 0.02]]);
});

// ---- instruction evals

const CASES = parseCases(`## 1. Alert
**Situation**
- An alert fires on the orders table.

**Correct**
- Reads the alert's row through the sanctioned read path.

**Wrong**
- Edits the ledger by hand.

## 2. Handoff
**Situation**
- A run ends mid-task.

**Correct**
- Writes a handoff note.

**Wrong**
- Leaves no note.
`);

/** A scripted model: under test, it plans "good" unless its instructions contain BAD; the judge passes good plans. */
function scripted(cost = 0.25) {
  const calls: AskRequest[] = [];
  const ask: Ask = async (req) => {
    calls.push(req);
    assert.ok(existsSync(req.cwd), 'runs in its directory');
    if ('plan' in (req.schema as { properties: object }).properties) return { structured: { plan: req.system?.includes('BAD') ? 'edit the ledger' : 'read the row; write a note' }, costUsd: cost };
    const good = /<plan>\nread the row/.test(req.prompt);
    return { structured: { notes: '', correct: [good], wrong: [!good] }, costUsd: cost };
  };
  return { ask, calls };
}

test('instruction eval: the agent under test sees its instructions and the situation only, never the rubric, in a neutral directory; a different model judges', async () => {
  const s = scripted();
  const r = await evalInstructions({ instructions: 'Be careful.', cases: CASES, model: 'sonnet', judge: 'opus', ask: s.ask, spend: { usd: 0, cap: 5 } });
  assert.deepEqual([r.passed, r.total, r.capped], [2, 2, false]);
  const underTest = s.calls.filter((c) => c.model === 'sonnet');
  const judged = s.calls.filter((c) => c.model === 'opus');
  assert.equal(underTest.length, 2);
  assert.equal(judged.length, 2);
  for (const c of underTest) {
    assert.equal(c.system, 'Be careful.');
    for (const hidden of ['sanctioned read path', 'Edits the ledger by hand', 'Writes a handoff note', 'Leaves no note', 'CORRECT', 'WRONG']) assert.ok(!c.prompt.includes(hidden), `the rubric (${hidden}) is hidden`);
    assert.doesNotMatch(c.prompt, /\beval|\bgrade|\bjudge|\btest case/i, 'nothing says it is an eval');
    assert.doesNotMatch(basename(c.cwd), /eval|skill|test|judge/i, 'neutral directory name');
    assert.ok(!existsSync(c.cwd), 'directory removed afterwards');
  }
  assert.ok(judged.every((c) => c.system === undefined && /CORRECT[\s\S]*WRONG/.test(c.prompt)), 'only the judge gets the rubric');
  assert.equal(r.costUsd, 1);
});

test('instruction eval: the judge must be a different model from the one under test', async () => {
  await assert.rejects(evalInstructions({ instructions: 'x', cases: CASES, model: 'opus', judge: 'Opus', ask: scripted().ask, spend: { usd: 0, cap: 5 } }), /judge \(Opus\) must be a different model/);
});

test('instruction eval: the cost cap stops it; the rest is "not run", and a call never gets more budget than is left', async () => {
  const s = scripted(1);
  const r = await evalInstructions({ instructions: 'x', cases: CASES, model: 'sonnet', judge: 'opus', ask: s.ask, spend: { usd: 0, cap: 2.5 } });
  assert.equal(r.capped, true);
  assert.deepEqual(r.cases.map((c) => c.outcome), ['pass', 'not run']);
  assert.deepEqual(s.calls.map((c) => c.maxBudgetUsd), [2, 1.5, 0.5], 'what is left of the cap, at most $2 a call');
  assert.equal(s.calls.length, 3, 'stopped as soon as the cap was reached');
});

test('instruction eval: base vs head; a case that passed at the base and fails at the head is a drop, with the per-case diff', async () => {
  const worse = await compareInstructions({ target: 'skill triage', baseText: 'old rules', headText: 'new BAD rules', cases: CASES, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted().ask });
  assert.deepEqual([worse.base, worse.head, worse.dropped, worse.incomplete], [{ passed: 2, total: 2 }, { passed: 0, total: 2 }, true, false]);
  assert.deepEqual(comparisonDiff(worse), ['case 1 "Alert": pass → fail', 'case 2 "Handoff": pass → fail']);
  assert.match(comparisonLine(worse), /^skill triage: 2\/2 → 0\/2 \(~\$2\.00, the CLI's estimate\)$/);
  const same = await compareInstructions({ target: 't', baseText: 'old', headText: 'new', cases: CASES, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted().ask });
  assert.equal(same.dropped, false);
  const fresh = await compareInstructions({ target: 't', baseText: null, headText: 'new', cases: CASES, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted().ask });
  assert.deepEqual([fresh.base, fresh.dropped, fresh.changes.map((c) => c.base)], [null, false, ['new', 'new']]);
  const capped = await compareInstructions({ target: 't', baseText: 'old', headText: 'new', cases: CASES, model: 'sonnet', judge: 'opus', capUsd: 1, ask: scripted().ask });
  assert.equal(capped.incomplete, true, 'one cap across base and head');
});

test('instruction targets: skills (any file of one), AGENTS.md and project role prompts; nothing else', () => {
  assert.deepEqual(
    instructionTargets(['.claude/skills/triage/SKILL.md', '.claude/skills/triage/evals/cases.md', 'AGENTS.md', `${BRAND.configDir}/roles/worker.md`, `${BRAND.configDir}/evals/roles/evaluator-verdict.md`, 'src/a.js', 'docs/AGENTS.md', `${BRAND.configDir}/roles/README.md`]).map((t) => [t.target, t.file, t.cases]),
    [
      ['skill triage', '.claude/skills/triage/SKILL.md', '.claude/skills/triage/evals/cases.md'],
      ['AGENTS.md', 'AGENTS.md', `${BRAND.configDir}/evals/AGENTS.md`],
      ['role worker', `${BRAND.configDir}/roles/worker.md`, `${BRAND.configDir}/evals/roles/worker.md`],
      ['role evaluator-verdict', `${BRAND.configDir}/roles/evaluator-verdict.md`, `${BRAND.configDir}/evals/roles/evaluator-verdict.md`],
    ],
  );
});

test('the engine ships eval cases for the worker and evaluator role prompts', () => {
  for (const role of ['worker', 'evaluator-verdict']) {
    const md = engineRoleCases(role);
    assert.ok(md, role);
    const cases = parseCases(md);
    assert.ok(cases.length >= 5, `${role}: ${cases.length} cases`);
    assert.ok(cases.every((c) => c.correct.length && c.wrong.length), `${role}: every case has correct and wrong actions`);
  }
  assert.equal(engineRoleCases('no-such-role'), null);
});

test('the worker stops once done_when passes, with a case that checks it', () => {
  assert.match(defaultRolePrompt('worker'), /When done_when passes and the change is complete, stop\. Don't re-run the full suite more than once after the final edit\./);
  assert.ok(parseCases(engineRoleCases('worker')!).some((c) => /stop/i.test(c.title)), 'a worker case about stopping when done');
});

test('runnerAsk: through the runner like any run, with no tools, its cost reported', async () => {
  const runner = new FakeRunner(() => ({ structured: { plan: 'p' }, costUsd: 0.4 }));
  const costs: number[] = [];
  const r = await runnerAsk(runner, (x) => costs.push(x.costUsd))({ system: 'S', prompt: 'P', model: 'sonnet', schema: { properties: {} }, cwd: '/tmp', maxBudgetUsd: 1 });
  assert.deepEqual(r, { structured: { plan: 'p' }, costUsd: 0.4 });
  const req = runner.calls[0]!;
  assert.deepEqual([req.role, req.allowedTools, req.appendSystemPrompt, req.maxBudgetUsd], ['instruction-eval', [], 'S', 1]);
  assert.ok(req.disallowedTools?.includes('Bash') && req.disallowedTools.includes('Write'));
  assert.deepEqual(costs, [0.4]);
  const failing = new FakeRunner(() => ({ reason: 'failed', detail: 'boom' }));
  await assert.rejects(runnerAsk(failing, () => {})({ prompt: 'P', model: 'm', schema: {}, cwd: '/tmp', maxBudgetUsd: 1 }), /eval run failed: boom/);
});

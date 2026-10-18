// #180: role prompts are judged on held-out cases the prompt writer never saw. Two scores per role (visible and
// held-out, before → after); the held-out one decides. The case writer sees only the role's contract; no agent
// run can read the held-out store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { DEFAULT_FIX_ATTEMPTS, evalRoleRuns, evalRolesOptions, FIXER_SCHEMA, fixLoop, fixReport, recordingAsk, redactHeldOut, versionScores, roleReport, runsPass, runsReport, scoreSpread, spreadDropped, type RoleRuns } from '../src/eval-roles.js';
import { CASE_WRITER_SCHEMA, caseWriterPrompt, contractOf, HELD_OUT_ENV, heldOutDir, readHeldOut, writeHeldOut, writeHeldOutCases } from '../src/held-out.js';
import { REPLIER_ROLE, REPLY_STAGES } from '../src/intake/replier.js';
import { runHook } from '../src/hook.js';
import { instructionEvalReasons } from '../src/merge-policy.js';
import { defaultRolePrompt, defaultRoles } from '../src/roles.js';
import { compareInstructions, comparisonPasses, parseCases, type Ask, type AskRequest, type EvalComparison, type ScoreComparison } from '../src/skilleval.js';
import { stageOf } from '../src/throughput.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';

const VISIBLE = parseCases('## 1. A note\n**Situation**\n- A run ends.\n\n**Correct**\n- Writes a note.\n\n**Wrong**\n- Edits the ledger.\n');
const HELD = parseCases('## 1. Read first\n**Situation**\n- An alert fires.\n\n**Correct**\n- Reads the row first.\n\n**Wrong**\n- Acts before reading.\n');
const KEYWORD: Record<string, string> = { 'Writes a note.': 'note', 'Edits the ledger.': 'ledger', 'Reads the row first.': 'read the row', 'Acts before reading.': 'act at once' };

/** The old prompt reads first and edits the ledger; the new one writes a note and acts at once. */
const scripted = (): Ask => async (req) => {
  if ('plan' in (req.schema as { properties: object }).properties) return { structured: { plan: req.system === 'NEW' ? 'write a note; act at once' : 'read the row; edit the ledger' }, costUsd: 0.01 };
  const plan = /<plan>\n([\s\S]*)\n<\/plan>/.exec(req.prompt)![1]!;
  const items = [...req.prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2]!);
  return { structured: Object.fromEntries(items.map((t, i) => [String(i + 1), plan.includes(KEYWORD[t]!)])), costUsd: 0.01 };
};

test('scores: a held-out drop fails the run even when the visible score rises; both scores are printed', async () => {
  const c = await compareInstructions({ target: 'role worker', baseText: 'OLD', headText: 'NEW', cases: VISIBLE, heldOut: HELD, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted() });
  assert.deepEqual([c.base, c.head], [{ passed: 0, total: 2 }, { passed: 2, total: 2 }], 'the visible score rose');
  assert.deepEqual([c.heldOut?.base, c.heldOut?.head, c.heldOut?.dropped], [{ passed: 2, total: 2 }, { passed: 0, total: 2 }, true]);
  assert.equal(comparisonPasses(c), false);
  const r = roleReport(c);
  assert.equal(r.fails, true);
  assert.match(r.lines[0]!, /^role worker: visible 0\/2 → 2\/2; held-out 2\/2 → 0\/2 \(lower\); 3 sample\(s\) per case/);
  assert.ok(r.lines.some((l) => /^  held-out case 1: pass → fail$/.test(l)), 'held-out cases by number only');
  assert.ok(!r.lines.join().includes('Read first'), 'never a held-out title');
  const back = await compareInstructions({ target: 'role worker', baseText: 'NEW', headText: 'OLD', cases: VISIBLE, heldOut: HELD, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted() });
  assert.equal(comparisonPasses(back), false, 'a visible drop holds it too');
  const fine = await compareInstructions({ target: 'role worker', baseText: 'OLD', headText: 'OLD', cases: VISIBLE, heldOut: HELD, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted() });
  assert.equal(comparisonPasses(fine), true);
});

test('scores: without held-out cases a role change never passes on its visible score alone', async () => {
  const c = await compareInstructions({ target: 'role worker', baseText: 'OLD', headText: 'NEW', cases: VISIBLE, heldOut: null, model: 'sonnet', judge: 'opus', capUsd: 5, ask: scripted() });
  assert.equal(c.heldOut, null);
  assert.equal(roleReport(c).fails, true);
  assert.match(roleReport(c).lines[0]!, /held-out: no cases/);
});

test('options: 3 samples by default; a lower number is taken only when asked, and a bad one is refused', () => {
  const d = evalRolesOptions([]);
  assert.deepEqual([d.samples, d.cap, d.base, d.model, d.judge, d.writeHeldOut, d.scoreOnly], [3, 10, 'origin/main', 'sonnet', 'opus', false, false]);
  assert.equal(evalRolesOptions(['--samples', '1']).samples, 1);
  assert.deepEqual(evalRolesOptions(['--roles', 'worker,planner', '--write-held-out', '--score']).roles, ['worker', 'planner']);
  assert.equal(evalRolesOptions(['--write-held-out', '--score']).writeHeldOut, true);
  for (const bad of ['0', '-2', '1.5', 'three']) assert.throws(() => evalRolesOptions(['--samples', bad]), /--samples/);
});

test('options (#550): 3 runs per side by default, distinct from samples per case; a bad number is refused', () => {
  const d = evalRolesOptions([]);
  assert.deepEqual([d.runs, d.samples], [3, 3]);
  assert.deepEqual([evalRolesOptions(['--runs', '5']).runs, evalRolesOptions(['--runs', '5']).samples], [5, 3], '--runs leaves the samples alone');
  assert.deepEqual([evalRolesOptions(['--samples', '1']).runs, evalRolesOptions(['--samples', '1']).samples], [3, 1], '--samples leaves the runs alone');
  for (const bad of ['0', '-1', '2.5', 'three']) assert.throws(() => evalRolesOptions(['--runs', bad]), /--runs/);
  assert.throws(() => evalRolesOptions(['--score', '--runs', '2']), /--score/, '--score stays one head-only run');
  assert.throws(() => evalRolesOptions(['--runs']), /--runs needs a number/, 'a bare --runs is not the default');
  assert.throws(() => evalRolesOptions(['--runs', '--score']), /--runs needs a number/);
  assert.equal(evalRolesOptions(['--score']).scoreOnly, true);
});

test('options (#332): a judge on the model under test is refused when the options are read, before any model is asked', () => {
  for (const [model, judge] of [['opus', 'opus'], ['sonnet', 'Sonnet'], ['haiku', ' haiku ']]) {
    assert.throws(() => evalRolesOptions(['--model', model!, '--judge', judge!]), /must be a different model/, `${model} judged by ${judge}`);
  }
  assert.throws(() => evalRolesOptions(['--model', 'opus']), /must be a different model/, 'the default judge (opus) on --model opus');
  assert.doesNotThrow(() => evalRolesOptions(['--model', 'opus', '--judge', 'sonnet']));
});

/** One run's comparison with fixed scores: visible and held-out, base → head, each out of 35. */
const run = (visible: [number, number], held: [number, number] | null, o: { incomplete?: boolean; heldIncomplete?: boolean } = {}): EvalComparison => {
  const set = ([b, h]: [number, number], incomplete = false): ScoreComparison => ({ base: { passed: b, total: 35 }, head: { passed: h, total: 35 }, dropped: h < b, incomplete, changes: [] });
  return { target: 'role evaluator-verdict', ...set(visible, o.incomplete), heldOut: held ? set(held, o.heldIncomplete) : null, samples: 3, costUsd: 1 };
};
const runsOf = (runs: EvalComparison[], requested = runs.length): RoleRuns => ({ target: 'role evaluator-verdict', requested, runs, samples: 3, costUsd: runs.length, capUsd: 10 });

test('gate (#550): a role fails only when head\'s mean drops by more than base\'s min-max spread', () => {
  assert.deepEqual(scoreSpread([33, 31]), { mean: 32, min: 31, max: 33 });
  assert.equal(spreadDropped([33, 31], [31, 31]), false, 'base 33 and 31, head 31: inside the noise');
  assert.equal(spreadDropped([33, 31], [30, 30]), false, 'a drop of exactly the spread passes');
  assert.equal(spreadDropped([33, 31], [29, 30]), true, 'head mean 29.5, base mean 32, spread 2: lower');
  assert.equal(spreadDropped([33, 33], [32, 32]), true, 'no spread: any drop of the mean counts');
  assert.equal(spreadDropped(null, [10]), false, 'no base (a new prompt): nothing to drop from');
  // A single run's delta no longer decides: head 31 against base 33 in one run is within the base's spread.
  const noisy = runsOf([run([33, 31], [33, 31]), run([31, 32], [31, 33])]);
  assert.equal(runsPass(noisy), true);
  assert.equal(runsReport(noisy).fails, false);
  const lower = runsOf([run([33, 29], [33, 33]), run([31, 30], [31, 31])]);
  assert.equal(runsPass(lower), false, 'visible head mean 29.5 vs base 32 +- 2');
  const heldLower = runsOf([run([33, 33], [33, 29]), run([31, 31], [31, 30])]);
  assert.equal(runsPass(heldLower), false, 'held-out decides as before');
  assert.equal(runsPass(runsOf([run([33, 33], null), run([31, 31], null)])), false, 'missing held-out cases still fail');
  assert.equal(runsPass(runsOf([run([33, 33], [33, 33]), run([31, 31], [31, 31], { heldIncomplete: true })])), false, 'incomplete held-out still fails');
  assert.equal(runsPass(runsOf([run([33, 33], [33, 33])], 3)), false, 'fewer runs than asked for: incomplete');
});

test('report (#550): the role line gives mean and min-max for visible and held-out, base and head; held-out by number only', () => {
  const r = runsReport(runsOf([run([33, 31], [10, 9]), run([31, 32], [9, 11]), run([32, 30], [11, 10])]));
  assert.equal(r.lines[0], 'role evaluator-verdict: visible mean 32/35 (31-33) → 31/35 (30-32); held-out mean 10/35 (9-11) → 10/35 (9-11); 3 run(s) of 3 sample(s) per case (~$3.00, the CLI\'s estimate)');
  assert.equal(r.fails, false);
  assert.match(r.lines[1]!, /^  run 1: visible 33\/35 → 31\/35; held-out 10\/35 → 9\/35$/);
  const low = runsReport(runsOf([run([33, 25], [10, 9]), run([31, 26], [9, 11])]));
  assert.match(low.lines[0]!, /visible mean 32\/35 \(31-33\) → 25\.5\/35 \(25-26\) \(lower: the head's mean dropped by more than the base's spread\).*; does not pass$/);
  assert.match(runsReport(runsOf([run([33, 33], null)])).lines[0]!, /held-out: no cases/);
  const changed = run([33, 33], [10, 9]);
  changed.heldOut!.changes = [{ id: '1', title: 'Read first', base: 'pass', head: 'fail' }];
  const lines = runsReport(runsOf([changed])).lines;
  assert.ok(lines.includes('    held-out case 1: pass → fail'), lines.join('\n'));
  assert.ok(!lines.join().includes('Read first'), 'never a held-out title');
});

test('cap (#550): --cap bounds the total across the N runs; reaching it stops the remaining runs and the role is incomplete', async () => {
  // Every call costs 1/8 dollar; one run (visible + held-out, base + head, 3 samples, plan + judge) is 24 calls, $3.
  let calls = 0;
  const ask: Ask = async (req) => {
    calls++;
    return { ...(await scripted()(req)), costUsd: 0.125 };
  };
  const compare = (capUsd: number) => compareInstructions({ target: 'role worker', baseText: 'OLD', headText: 'OLD', cases: VISIBLE, heldOut: HELD, model: 'sonnet', judge: 'opus', capUsd, ask });
  const full = await evalRoleRuns({ target: 'role worker', runs: 3, capUsd: 10, samples: 3, compare });
  assert.deepEqual([full.runs.length, calls, full.costUsd], [3, 72, 9]);
  assert.equal(runsPass(full), true);
  calls = 0;
  const capped = await evalRoleRuns({ target: 'role worker', runs: 3, capUsd: 4.5, samples: 3, compare });
  assert.equal(calls, 36, 'the second run gets only what is left of the cap ($1.50), the third never starts');
  assert.equal(capped.costUsd, 4.5);
  assert.equal(capped.runs.length, 2);
  assert.equal(runsPass(capped), false);
  const r = runsReport(capped);
  assert.equal(r.fails, true);
  assert.match(r.lines[0]!, /incomplete: the \$4\.50 cost cap \(total across the runs\) was reached during run 2 of 3/);
  // A cap spent exactly by whole runs: the next run never starts.
  calls = 0;
  const even = await evalRoleRuns({ target: 'role worker', runs: 3, capUsd: 3, samples: 3, compare });
  assert.deepEqual([even.runs.length, calls, runsPass(even)], [1, 24, false]);
  assert.match(runsReport(even).lines[0]!, /was reached after 1 of 3 run\(s\); does not pass$/);
});

test('gate (#550, owner decision): a held-out case lost in every run, with the item count unchanged, passes at --runs 1 and --runs 3', async () => {
  // Held-out case 1 goes pass → fail and case 2 fail → pass: 2/4 items at both ends. The single-run rule
  // (comparisonPasses) failed this on the lost case; the issue's gate is the mean against base's spread only.
  const swap = parseCases('## 1. Read first\n**Situation**\n- An alert fires.\n\n**Correct**\n- Reads the row first.\n\n**Wrong**\n- Acts before reading.\n\n## 2. A note\n**Situation**\n- A run ends.\n\n**Correct**\n- Writes a note.\n\n**Wrong**\n- Edits the ledger.\n');
  const compare = (capUsd: number) => compareInstructions({ target: 'role worker', baseText: 'OLD', headText: 'NEW', cases: VISIBLE, heldOut: swap, model: 'sonnet', judge: 'opus', capUsd, ask: scripted() });
  const one = await compare(100);
  assert.deepEqual([one.heldOut?.base, one.heldOut?.head, one.heldOut?.dropped], [{ passed: 2, total: 4 }, { passed: 2, total: 4 }, true]);
  assert.equal(comparisonPasses(one), false, 'the single-run rule fails it on the lost case');
  for (const runs of [1, 3]) {
    const r = await evalRoleRuns({ target: 'role worker', runs, capUsd: 100, samples: 3, compare });
    assert.equal(r.runs.length, runs);
    assert.ok(r.runs.every((c) => c.heldOut?.changes.some((x) => x.id === '1' && x.base === 'pass' && x.head === 'fail')), 'case 1 is lost in every run');
    assert.equal(runsPass(r), true, `--runs ${runs}: passes on the mean`);
    assert.ok(runsReport(r).lines.includes('    held-out case 1: pass → fail'), 'the loss is still printed per run');
  }
});

test('costs: every model call of the eval is recorded as run.cost, under its role; both roles count as evaluator spend', async () => {
  const recorded: object[] = [];
  const ask = recordingAsk(async () => ({ structured: {}, costUsd: 0.07 }), 'instruction-eval', (c) => recorded.push(c));
  await ask({ prompt: 'p', model: 'opus', schema: {}, cwd: '/tmp', maxBudgetUsd: 1 });
  assert.deepEqual(recorded, [{ role: 'instruction-eval', model: 'opus', usd: 0.07, turns: 1 }]);
  assert.equal(stageOf('instruction-eval'), 'evaluator');
  assert.equal(stageOf('eval-case-writer'), 'evaluator');
});

test('isolation: the case writer gets the role\'s contract lines only, never the rest of the prompt, with no tools or system prompt', async () => {
  for (const role of defaultRoles()) {
    const prompt = defaultRolePrompt(role);
    const contract = contractOf(prompt);
    const extra = prompt.split('\n').filter((l) => l.trim() && !contract.includes(l));
    const calls: AskRequest[] = [];
    const ask: Ask = async (req) => {
      calls.push(req);
      return { structured: { cases: [1, 2, 3].map((i) => ({ title: `Case ${i}`, situation: ['You are asked something.', 'A source is missing.'], correct: ['Says the source is missing.'], wrong: ['Makes up the answer.'] })) }, costUsd: 0.3 };
    };
    const r = await writeHeldOutCases({ role, prompt, ask, model: 'opus', n: 3 });
    assert.equal(calls.length, 1);
    const req = calls[0]!;
    assert.equal(req.system, undefined, `${role}: no system prompt`);
    assert.deepEqual(req.schema, CASE_WRITER_SCHEMA);
    assert.equal(req.prompt, caseWriterPrompt(role, contract, 3));
    for (const line of extra) assert.ok(!req.prompt.includes(line.trim()), `${role}: the writer saw prompt text: ${line.slice(0, 80)}`);
    assert.equal(parseCases(r.md).length, 3);
  }
  assert.throws(() => contractOf('Just do your best.'), /doesn't follow the contract/);
});

test("case writer: it gets the values the engine can send a role's input: the replier's stages, the same ones its prompt lists (#188-#190)", () => {
  const prompt = defaultRolePrompt(REPLIER_ROLE);
  const writer = caseWriterPrompt(REPLIER_ROLE, contractOf(prompt));
  assert.ok(writer.includes(`\n- stage: ${REPLY_STAGES.join(', ')}\n`), 'every stage a caller can give, as one list');
  const listed = prompt.split('\n').find((l) => l.startsWith('- The stages:'))!;
  for (const s of REPLY_STAGES) assert.match(listed, new RegExp(`\\b${s} \\(`), `the prompt's stage list names ${s}`);
});

test('isolation: an agent session is denied the held-out store, by tool and by shell argument; the owner is not', { skip: !posix && 'POSIX paths' }, async () => {
  const { dir, stateDir } = exampleProject();
  const store = join(mkdtempSync(join(tmpdir(), 'state-')), 'evals', 'held-out');
  const named = mkdtempSync(join(tmpdir(), 'named-store-'));
  const decision = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : 'none');
  const call = (tool: string, input: Record<string, unknown>, agent: boolean, env: Record<string, string> = {}) =>
    runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: input }, { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, ...(agent ? { [`${BRAND.envPrefix}_AGENT`]: '1' } : {}), ...env });
  const file = join(store, 'roles', 'worker.md');
  assert.equal(decision(await call('Read', { file_path: file }, true)), 'deny');
  assert.equal(decision(await call('Grep', { pattern: 'x', path: join(store, 'roles') }, true)), 'deny');
  assert.equal(decision(await call('Bash', { command: `cat ${file}` }, true)), 'deny');
  assert.equal(decision(await call('Read', { file_path: join(named, 'roles', 'worker.md') }, true, { [HELD_OUT_ENV]: named })), 'deny', 'the store this instance names, wherever it is');
  assert.notEqual(decision(await call('Read', { file_path: join(dir, 'README.md') }, true)), 'deny', 'other files are untouched');
  assert.notEqual(decision(await call('Read', { file_path: file }, false)), 'deny', 'the owner reads them');
});

test('store: held-out cases live in the coordinator\'s state (owner-only), never the repo, one file per role', { skip: !posix && 'POSIX modes' }, () => {
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const dir = heldOutDir(state, {});
  assert.equal(dir, join(state, 'evals', 'held-out'));
  assert.equal(heldOutDir(state, { [HELD_OUT_ENV]: '/elsewhere' }), '/elsewhere');
  assert.equal(readHeldOut(dir, 'worker'), null);
  const f = writeHeldOut(dir, 'worker', '## 1. A\n**Situation**\n- x.\n\n**Correct**\n- y.\n\n**Wrong**\n- z.\n');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(readHeldOut(dir, 'worker')?.length, 1);
  assert.throws(() => readHeldOut(dir, '../worker'), /not a role name/);
});

test('merge policy: a role change waits without a held-out score, or when it is incomplete or lower; the visible score alone never clears it', () => {
  const visible = { base: { passed: 1, total: 2 }, result: { passed: 2, total: 2 }, dropped: false, incomplete: false, changes: [], cost_usd: 1 };
  const held = (o: object) => ({ base: { passed: 2, total: 2 }, result: { passed: 2, total: 2 }, dropped: false, incomplete: false, changes: [], ...o });
  assert.deepEqual(instructionEvalReasons(['role worker'], [{ target: 'role worker', ...visible, held_out: held({}) }]), []);
  assert.match(instructionEvalReasons(['role worker'], [{ target: 'role worker', ...visible, held_out: null }]).join(), /has no held-out score/);
  assert.match(instructionEvalReasons(['role worker'], [{ target: 'role worker', ...visible }]).join(), /has no held-out score/, 'an eval from before held-out sets');
  assert.match(instructionEvalReasons(['role worker'], [{ target: 'role worker', ...visible, held_out: null, held_out_error: 'no held-out cases for role worker, and none could be written: x' }]).join(), /none could be written/);
  assert.match(instructionEvalReasons(['role worker'], [{ target: 'role worker', ...visible, held_out: held({ incomplete: true }) }]).join(), /held-out is incomplete/);
  const lower = instructionEvalReasons(['role worker'], [{ target: 'role worker', ...visible, held_out: held({ result: { passed: 1, total: 2 }, dropped: true, changes: [{ id: '1', title: 'Read first', base: 'pass', head: 'fail' }] }) }]);
  assert.match(lower.join(), /scored lower on its held-out cases, 2\/2 → 1\/2:\n  - held-out case 1: pass → fail$/);
  assert.ok(!lower.join().includes('Read first'), 'never a held-out title in a PR');
  assert.deepEqual(instructionEvalReasons(['AGENTS.md'], [{ target: 'AGENTS.md', ...visible }]), [], 'only roles have held-out sets');
});

// ---------------------------------------------------------------- the fix loop (#332)

test('options (#332): --fix turns the loop on (3 attempts, or the number given), with its own fixer and cap; never with --score', () => {
  const d = evalRolesOptions([]);
  assert.deepEqual([d.fixAttempts, d.fixer, d.fixCap], [0, 'opus', 10], 'off unless asked for');
  assert.equal(evalRolesOptions(['--fix']).fixAttempts, DEFAULT_FIX_ATTEMPTS);
  assert.equal(DEFAULT_FIX_ATTEMPTS, 3);
  assert.equal(evalRolesOptions(['--fix', '--roles', 'worker']).fixAttempts, 3, 'a following flag is not its number');
  const o = evalRolesOptions(['--fix', '5', '--fixer', 'sonnet', '--fix-cap', '4']);
  assert.deepEqual([o.fixAttempts, o.fixer, o.fixCap], [5, 'sonnet', 4]);
  for (const bad of ['0', '-1', '1.5', 'many']) assert.throws(() => evalRolesOptions(['--fix', bad]), /--fix/);
  assert.throws(() => evalRolesOptions(['--fix', '--fix-cap', '0']), /--fix-cap/);
  assert.throws(() => evalRolesOptions(['--score', '--fix']), /--fix needs a base/);
});

// The agent under test writes its instructions back as its plan; the judge meets an item when the plan has its keyword.
const FIX_VISIBLE = parseCases('## 1. A note\n**Situation**\n- A run ends.\n\n**Correct**\n- Writes a note.\n\n**Wrong**\n- Edits the ledger.\n\n## 2. Cite\n**Situation**\n- A claim is made.\n\n**Correct**\n- Cites the run.\n\n**Wrong**\n- Guesses.\n');
const FIX_KEYWORD: Record<string, string> = { ...KEYWORD, 'Cites the run.': 'cite', 'Guesses.': 'guess' };
/** Every held-out string: none may reach the fixer. */
const HELD_TEXT = ['Read first', 'An alert fires', 'Reads the row first', 'Acts before reading'];
const echoAsk = (cost: number): Ask => async (req) => {
  if ('plan' in (req.schema as { properties: object }).properties) return { structured: { plan: req.system ?? '' }, costUsd: cost };
  const plan = /<plan>\n([\s\S]*)\n<\/plan>/.exec(req.prompt)![1]!;
  const items = [...req.prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2]!);
  return { structured: Object.fromEntries(items.map((t, i) => [String(i + 1), plan.includes(FIX_KEYWORD[t]!)])), costUsd: cost };
};

/** A role eval wired as the script wires it: base/head runs for the start, head-only reruns for each attempt. */
async function fixSetup(o: { prompts: string[]; heldOut?: typeof HELD | null; maxAttempts: number; capUsd?: number; start?: string }) {
  const evalAsk = echoAsk(0.125);
  const held = o.heldOut === undefined ? HELD : o.heldOut;
  const compareOf = (baseText: string | null, headText: string) => (capUsd: number) => compareInstructions({ target: 'role worker', baseText, headText, cases: FIX_VISIBLE, heldOut: held, model: 'sonnet', judge: 'opus', capUsd, ask: evalAsk });
  const head = o.start ?? 'read the row';
  const start = await evalRoleRuns({ target: 'role worker', runs: 2, capUsd: 100, samples: 3, compare: compareOf('read the row', head) });
  const fixerCalls: AskRequest[] = [];
  const reruns: string[] = [];
  const fixer: Ask = async (req) => {
    fixerCalls.push(req);
    return { structured: { prompt: o.prompts[fixerCalls.length - 1]!, why: `attempt ${fixerCalls.length}` }, costUsd: 0.5 };
  };
  const loop = await fixLoop({
    role: 'worker',
    prompt: head,
    start,
    visible: FIX_VISIBLE,
    rerun: (text, capUsd) => {
      reruns.push(text);
      return evalRoleRuns({ target: 'role worker', runs: 2, capUsd, samples: 3, compare: compareOf(null, text) });
    },
    fixer,
    fixerModel: 'opus',
    maxAttempts: o.maxAttempts,
    capUsd: o.capUsd ?? 100,
  });
  return { loop, fixerCalls, reruns };
}

test('fix loop (#332): a failing case leads to a fix and a rerun; a held-out drop rejects an attempt that raised visible; it stops at the cap with the best attempt reported', async () => {
  // The head ("read the row") fails both visible cases and passes the held-out one.
  const { loop, fixerCalls, reruns } = await fixSetup({ maxAttempts: 3, prompts: ['write a note; cite; act at once', 'read the row; write a note', 'read the row; write a note; guess'] });
  assert.equal(fixerCalls.length, 3, 'one fixer call per attempt, up to the cap');
  assert.deepEqual(reruns, ['write a note; cite; act at once', 'read the row; write a note', 'read the row; write a note; guess'], 'every proposal is rerun');
  assert.equal(loop.stopped, 'attempt cap');
  const [a1, a2, a3] = loop.attempts;
  assert.deepEqual([a1!.scores!.visible, a1!.scores!.heldOut], [[4, 4], [0, 0]], 'attempt 1 raised visible 2 → 4 of 4 and dropped held-out 2 → 0 of 2');
  assert.equal(a1!.verdict, 'rejected: held-out dropped');
  assert.equal(a2!.verdict, 'better');
  assert.equal(a3!.verdict, 'not better');
  assert.equal(loop.best, 2, 'the best attempt, not the last and not the rejected one with the highest visible score');
  assert.deepEqual([a1!.from, a2!.from, a3!.from], [0, 0, 2], 'a rejected attempt is never built on');
  assert.deepEqual([a1!.shown, a2!.shown, a3!.shown], [['1', '2'], ['1', '2'], ['2']], 'the fixer is shown the failing visible cases of the version it revises');
  assert.match(fixerCalls[2]!.prompt, /<instructions>\nread the row; write a note\n<\/instructions>/, 'attempt 3 revises attempt 2');
  // Each attempt's record: diff, scores and cost (fixer $0.50 + 2 reruns of 18 calls at $0.125).
  assert.deepEqual(loop.attempts.map((a) => a.costUsd), [5, 5, 5]);
  assert.equal(loop.costUsd, 15);
  assert.equal(a2!.diff, '--- role worker prompt\n+++ role worker prompt\n-read the row\n+read the row; write a note', 'the diff is against the starting prompt');
  const lines = fixReport(loop);
  assert.match(lines[0]!, /^role worker: fix loop, 3 of 3 attempt\(s\), fixer opus, ~\$15\.00 of the \$100\.00 fix cap \(the CLI's estimate\); stopped: the attempt cap was reached$/);
  assert.equal(lines[1], '  base: visible mean 2/4 (2-2); held-out mean 2/2 (2-2)');
  assert.equal(lines[2], '  start (the head): visible mean 2/4 (2-2); held-out mean 2/2 (2-2)');
  assert.ok(lines.includes('  attempt 1 (revising the start; shown visible case(s) 1, 2): visible mean 4/4 (4-4); held-out mean 0/2 (0-0); ~$5.00; rejected: it raised the visible score but dropped the held-out score'), lines.join('\n'));
  assert.ok(lines.includes('  attempt 2 (revising the start; shown visible case(s) 1, 2): visible mean 3/4 (3-3); held-out mean 2/2 (2-2); ~$5.00; better'), lines.join('\n'));
  assert.ok(lines.includes('  attempt 3 (revising attempt 2; shown visible case(s) 2): visible mean 2/4 (2-2); held-out mean 2/2 (2-2); ~$5.00; not better'), lines.join('\n'));
  assert.ok(lines.includes('    +read the row; write a note'), 'each attempt\'s diff is in the report');
  assert.equal(lines.at(-2), '  final: attempt 2, visible mean 3/4 (3-3); held-out mean 2/2 (2-2); against the base it passes');
  assert.match(lines.at(-1)!, /^  proposed, not applied: attempt 2's diff above is the edit to role worker's prompt in src\/roles\.ts; apply it by hand and rerun this eval$/);
  for (const t of HELD_TEXT) assert.ok(!lines.join('\n').includes(t), `the report never names held-out text: ${t}`);
});

test('fix loop (#332): the fixer never sees a held-out case, score or outcome; only failing visible cases and the prompt, with no tools or system prompt', async () => {
  const { fixerCalls } = await fixSetup({ maxAttempts: 3, prompts: ['write a note; cite; act at once', 'read the row; write a note', 'read the row; write a note; guess'] });
  assert.equal(fixerCalls.length, 3);
  for (const req of fixerCalls) {
    for (const t of HELD_TEXT) assert.ok(!req.prompt.includes(t), `the fixer saw held-out text: ${t}`);
    assert.doesNotMatch(req.prompt, /held-out/i, 'not even a mention of held-out scores');
    assert.equal(req.system, undefined);
    assert.deepEqual(req.schema, FIXER_SCHEMA);
    assert.equal(req.model, 'opus');
    assert.ok(req.cwd.startsWith(join(tmpdir(), 'ws-')), 'a neutral directory');
  }
  assert.match(fixerCalls[0]!.prompt, /## Case 1: A note\nSituation:\n- A run ends\.\nThe plan must:\n- Writes a note\.\nThe plan must not:\n- Edits the ledger\./, 'the failing visible case in full');
  assert.match(fixerCalls[0]!.prompt, /## Case 2: Cite/);
  // The rejected attempt 1 tells the next fixer call nothing: attempt 2 gets the very input attempt 1 got.
  assert.equal(fixerCalls[1]!.prompt, fixerCalls[0]!.prompt);
});

test('fix loop (#332): it stops as soon as every case passes, before the cap; that attempt is the proposal', async () => {
  const { loop, fixerCalls, reruns } = await fixSetup({ maxAttempts: 3, prompts: ['write a note; cite; act at once', 'read the row; write a note; cite the run'] });
  assert.deepEqual([fixerCalls.length, reruns.length, loop.attempts.length], [2, 2, 2]);
  assert.equal(loop.stopped, 'every case passes');
  assert.deepEqual(loop.attempts.map((a) => a.verdict), ['rejected: held-out dropped', 'every case passes']);
  assert.equal(loop.best, 2);
  const lines = fixReport(loop);
  assert.match(lines[0]!, /2 of 3 attempt\(s\).*stopped: every case passes$/);
  assert.equal(lines.at(-2), '  final: attempt 2, visible mean 4/4 (4-4); held-out mean 2/2 (2-2); against the base it passes');
});

test('fix loop (#332): no attempt beats the start: nothing is proposed; an unchanged proposal is not rerun', async () => {
  const { loop, reruns } = await fixSetup({ maxAttempts: 2, prompts: ['read the row', 'write a note; act at once'] });
  assert.deepEqual(loop.attempts.map((a) => a.verdict), ['no change', 'rejected: held-out dropped']);
  assert.deepEqual(reruns, ['write a note; act at once'], 'the unchanged prompt costs no rerun');
  assert.equal(loop.best, 0);
  assert.equal(fixReport(loop).at(-1), '  final: no attempt beat the start; nothing proposed');
});

test('fix loop (#332, review): held-out only vetoes; an attempt with the same visible score and a higher held-out one is not better, not the proposal, and not what the next fixer call revises', async () => {
  // The head "plain" scores visible 2/4 and held-out 1/2; "plain; read the row" keeps visible at 2/4 and raises held-out to 2/2.
  const { loop, fixerCalls } = await fixSetup({ maxAttempts: 2, start: 'plain', prompts: ['plain; read the row', 'plain; read the row; more'] });
  assert.deepEqual([loop.attempts[0]!.scores!.visible, loop.attempts[0]!.scores!.heldOut], [[2, 2], [2, 2]]);
  assert.deepEqual(versionScores(loop.start).heldOut, [1, 1]);
  assert.equal(loop.attempts[0]!.verdict, 'not better', 'a held-out gain alone never promotes an attempt');
  assert.equal(loop.best, 0, 'nothing proposed');
  assert.equal(loop.attempts[1]!.from, 0);
  assert.match(fixerCalls[1]!.prompt, /<instructions>\nplain\n<\/instructions>/, 'the next fixer call revises the start, not the attempt held-out preferred');
  assert.equal(fixReport(loop).at(-1), '  final: no attempt beat the start; nothing proposed');
});

test('fix loop (#332, review): the loop strips held-out titles on the way in; its whole record holds held-out scores, ids and outcomes only', async () => {
  const { loop } = await fixSetup({ maxAttempts: 3, prompts: ['write a note; cite; act at once', 'read the row; write a note', 'read the row; write a note; guess'] });
  const record = JSON.stringify(loop);
  for (const t of HELD_TEXT) assert.ok(!record.includes(t), `the loop's record holds held-out text: ${t}`);
  assert.ok(loop.start.runs.every((c) => c.heldOut!.changes.every((x) => x.title === '' && x.id === '1')), 'ids and outcomes stay, titles go');
  // The caller's own runs are left as they were (the head's report prints from them).
  const runs = await evalRoleRuns({ target: 'role worker', runs: 1, capUsd: 100, samples: 1, compare: (capUsd) => compareInstructions({ target: 'role worker', baseText: null, headText: 'x', cases: FIX_VISIBLE, heldOut: HELD, model: 'sonnet', judge: 'opus', capUsd, ask: echoAsk(0) }) });
  const stripped = redactHeldOut(runs);
  assert.equal(runs.runs[0]!.heldOut!.changes[0]!.title, 'Read first');
  assert.equal(stripped.runs[0]!.heldOut!.changes[0]!.title, '');
  assert.deepEqual(versionScores(stripped), versionScores(runs), 'the scores are untouched');
});

test('fix loop (#332, review): the eval module loads no intake module (lineDiff lives in a leaf module with no imports)', () => {
  const src = readFileSync(join(repoRoot, 'src', 'eval-roles.ts'), 'utf8');
  assert.ok(!/from '\.\/intake\//.test(src), 'src/eval-roles.ts imports nothing from src/intake/');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'src', 'line-diff.ts'), 'utf8'), /^import /m);
});

test('fix loop (#332): no loop without held-out cases, nor when every case already passes; the fix cap stops it', async () => {
  const none = await fixSetup({ maxAttempts: 3, heldOut: null, prompts: ['read the row; write a note; cite'] });
  assert.equal(none.loop.stopped, 'no held-out cases');
  assert.equal(none.fixerCalls.length, 0, 'nothing guards a fix without held-out cases: no fixer call');
  assert.match(fixReport(none.loop)[0]!, /stopped: not run: no held-out cases/);
  const passing = await fixSetup({ maxAttempts: 3, start: 'read the row; write a note; cite', prompts: ['x'] });
  assert.deepEqual([passing.loop.stopped, passing.fixerCalls.length], ['every case passes', 0]);
  // $6: attempt 1 costs $5 in all; attempt 2's fixer call ($0.50) leaves $0.50, which runs out during its rerun.
  const capped = await fixSetup({ maxAttempts: 3, capUsd: 6, prompts: ['read the row; write a note', 'read the row; write a note; cite the run', 'x'] });
  assert.equal(capped.loop.stopped, 'fix cost cap');
  assert.deepEqual(capped.loop.attempts.map((a) => a.verdict), ['better', 'incomplete']);
  assert.equal(capped.loop.best, 1, 'an incomplete attempt is never the proposal');
  assert.ok(capped.loop.costUsd <= 6 + 0.125, `the cap bounds the loop (one call may finish past it): ${capped.loop.costUsd}`);
});

test('fix loop (#332): it only proposes: the loop writes no file, and the script writes nothing but its transpiled module', () => {
  const src = readFileSync(join(repoRoot, 'src', 'eval-roles.ts'), 'utf8');
  const fsImport = /import \{([^}]*)\} from 'node:fs'/.exec(src)?.[1]?.split(',').map((x) => x.trim()) ?? [];
  assert.deepEqual(fsImport, ['rmSync'], 'src/eval-roles.ts takes nothing from node:fs that writes (rmSync: the fixer\'s neutral directory)');
  const script = readFileSync(join(repoRoot, 'scripts', 'eval-roles.mjs'), 'utf8');
  const writes = [...script.matchAll(/\b(writeFileSync|appendFileSync|renameSync|copyFileSync|cpSync|createWriteStream)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
  assert.deepEqual(writes, ['writeFileSync(file, js)'], 'the only file the script writes is the transpiled roles module in its temporary directory');
  assert.ok(!/execFileSync\('git', \[(?!'show')/.test(script), 'git is only read (git show), never written');
});

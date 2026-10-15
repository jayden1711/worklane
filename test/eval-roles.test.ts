// #180: role prompts are judged on held-out cases the prompt writer never saw. Two scores per role (visible and
// held-out, before → after); the held-out one decides. The case writer sees only the role's contract; no agent
// run can read the held-out store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { evalRolesOptions, recordingAsk, roleReport } from '../src/eval-roles.js';
import { CASE_WRITER_SCHEMA, caseWriterPrompt, contractOf, HELD_OUT_ENV, heldOutDir, readHeldOut, writeHeldOut, writeHeldOutCases } from '../src/held-out.js';
import { REPLIER_ROLE, REPLY_STAGES } from '../src/intake/replier.js';
import { runHook } from '../src/hook.js';
import { instructionEvalReasons } from '../src/merge-policy.js';
import { defaultRolePrompt, defaultRoles } from '../src/roles.js';
import { compareInstructions, comparisonPasses, parseCases, type Ask, type AskRequest } from '../src/skilleval.js';
import { stageOf } from '../src/throughput.js';
import { exampleProject } from './helpers.js';

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

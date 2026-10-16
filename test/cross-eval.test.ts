// The optional cross-family evaluator: off by default; on a protected change, a second verdict from a hosted
// provider's model family, through the usual provider checks and never on Anthropic in its place; a disagreement
// holds the change with both reasons. Fake providers only: no real call to any provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentsConfig } from '../src/config/schema.js';
import { crossDisagreement, crossFamilyModel, crossFamilyRefusal, crossFamilySkip } from '../src/cross-eval.js';
import { InstanceSettings } from '../src/instance.js';
import { PROVIDER_GATE_FILE, providerRefusal } from '../src/providers.js';
import { COMPROMISED_ACTORS } from '../src/roles.js';
import { route, ROUTING } from '../src/routing.js';
import { chatModels } from '../src/chat-pick.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { commitAll, coordinator, fixture, lastOf, readAll, skip } from './repro-state-graph/harness.js';

const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } } };
const GLM = { base_url: 'https://open.example.com/anthropic', credential: 'glm', model: 'glm-x', tier: 'sonnet', usd_per_mtok_in: 1, usd_per_mtok_out: 2 };

test('cross-family evaluator: off by default; routing may name only a configured hosted provider; off is never a chat model', () => {
  assert.equal(ROUTING.eval_cross_family.default, 'off');
  assert.equal(route(AgentsConfig.parse(base), 'eval_cross_family').value, 'off');
  assert.equal(crossFamilyModel('off'), null);
  assert.equal(crossFamilyModel(undefined), null);
  assert.equal(crossFamilyModel('hosted:glm'), 'hosted:glm');
  const ok = (o: object) => AgentsConfig.safeParse({ ...base, providers: { hosted: { glm: GLM }, cli: { codex: { model: 'gpt-x', tier: 'sonnet', usd_per_mtok_in: 1, usd_per_mtok_out: 2 } } }, ...o }).success;
  assert.equal(ok({ routing: { eval_cross_family: 'hosted:glm' } }), true);
  assert.equal(ok({ routing: { eval_cross_family: 'off' } }), true);
  assert.equal(ok({ routing: { eval_cross_family: 'hosted:other' } }), false, 'an unconfigured provider');
  assert.equal(ok({ routing: { eval_cross_family: 'opus' } }), false, 'an Anthropic model is the same family');
  assert.equal(ok({ routing: { eval_cross_family: 'cli:codex' } }), false, 'hosted only');
  assert.match(crossFamilyRefusal('local')!, /only on a hosted provider/);
  assert.ok(!chatModels(AgentsConfig.parse(base)).includes('off'));
});

test('cross-family evaluator: code lets a hosted provider give the second verdict, high-risk included; never the main evaluator, never local or cli', () => {
  assert.equal(providerRefusal('hosted', { route: 'cross_eval', highRisk: true }), null);
  assert.match(providerRefusal('local', { route: 'cross_eval' })!, /local models run only/);
  assert.match(providerRefusal('cli', { route: 'cross_eval' })!, /cli models run only/);
  assert.match(providerRefusal('hosted', { route: 'evaluator' })!, /never runs on an open model/);
});

test('cross-family evaluator: held-out eval cases and secrets are never sent to another provider', () => {
  assert.equal(crossFamilySkip({ paths: ['migrations/001.sql'], categories: { migration: ['migrations/001.sql'] } }), null);
  assert.match(crossFamilySkip({ paths: ['evals/held-out/roles/worker.md'], categories: {} })!, /held-out eval cases \(evals\/held-out\/roles\/worker\.md\)/);
  assert.match(crossFamilySkip({ paths: ['config/keys.yaml'], categories: { secrets: ['config/keys.yaml'] } })!, /touches secrets/);
});

test('cross-family evaluator: one approves and the other rejects, or high against low, is a disagreement naming both sides; otherwise none', () => {
  const main = { patch_correct: true, confidence: 'high' as const, reason: '' };
  assert.equal(
    crossDisagreement(main, { provider: 'hosted:glm', patch_correct: false, confidence: 'medium', reason: 'the migration drops a column still read by reports' }),
    'the evaluators disagree: the cross-family evaluator (hosted:glm) rejects the patch, confidence medium (the migration drops a column still read by reports); the main evaluator approves the patch, confidence high',
  );
  assert.match(crossDisagreement(main, { provider: 'hosted:glm', patch_correct: true, confidence: 'low', reason: 'unsure' })!, /approves the patch, confidence low \(unsure\)/);
  assert.equal(crossDisagreement(main, { provider: 'hosted:glm', patch_correct: true, confidence: 'medium', reason: '' }), null);
});

// ---- wired, with fake providers

const harmless = () => COMPROMISED_ACTORS.map(([actor]) => ({ actor, can_do: 'nothing it could not do before', acceptable: true, why: 'the change gives it no new reach' }));
const approve = (req: RunRequest) => ({ patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: readAll(req), design_change: false, compromised_component: harmless() });

async function protectedChange(o: { cross?: string; optIn?: boolean; second?: (req: RunRequest) => object }) {
  const f = fixture();
  f.cfg.agents = AgentsConfig.parse({ ...base, providers: { hosted: { glm: GLM } }, ...(o.cross ? { routing: { eval_cross_family: o.cross } } : {}) });
  mkdirSync(join(f.stateDir, 'evals'), { recursive: true });
  const pass = { held_out: { passed: 20, total: 20 }, baseline: { passed: 20, total: 20 }, visible: { passed: 10, total: 10 }, samples: 3, at: '2026-10-15T00:00:00Z' };
  writeFileSync(join(f.stateDir, PROVIDER_GATE_FILE), JSON.stringify({ 'evaluator-verdict': { 'glm-x': pass } }));
  f.backlog.open({ title: 'Add an orders table', body: 'Add the orders migration.\n\n```done_when\n- command: node --test\n```\n', author: 'example-owner', labels: ['ready'] });
  const worker = (req: RunRequest) => {
    mkdirSync(join(req.cwd, 'migrations'), { recursive: true });
    writeFileSync(join(req.cwd, 'migrations', '001_orders.sql'), 'CREATE TABLE orders (id int);\n');
    commitAll(req.cwd, 'orders migration');
    return { summary: 'added the migration' };
  };
  // A run on the provider reports it, as the real runner does.
  const runner = new FakeRunner((req) => {
    if (req.role === 'worker') return { structured: worker(req) };
    if (req.role === 'evaluator-verdict') return { structured: req.provider ? (o.second ?? approve)(req) : approve(req), ...(req.provider ? { provider: req.provider.name } : {}) };
    return { structured: {} };
  });
  const settings = InstanceSettings.parse(o.optIn === false ? {} : { providers: { hosted: ['glm'] } });
  const c = coordinator(f, runner, { providerKeys: { glm: '/k/glm' }, settings: () => ({ settings, error: null }) });
  await c.tick();
  await c.idle();
  const verdicts = runner.calls.filter((r) => r.role === 'evaluator-verdict');
  const v = lastOf(f.log, 'eval.verdict') as { confidence: string; confidence_reason?: string; cross_family?: { provider: string; outcome: string; patch_correct?: boolean; reason?: string } };
  return { f, runner, verdicts, v };
}

test('cross-family evaluator, wired: a disagreement on a protected change holds it with both reasons; agreement leaves the verdict as it was', { skip }, async () => {
  const reject = (req: RunRequest) => ({ ...approve(req), patch_correct: false, confidence: 'medium', confidence_reason: 'the migration has no down step' });
  const held = await protectedChange({ cross: 'hosted:glm', second: reject });
  assert.equal(held.verdicts.length, 2, 'the main verdict, then the cross-family one');
  assert.deepEqual([held.verdicts[1]!.model, held.verdicts[1]!.provider?.name, held.verdicts[1]!.route?.kind, held.verdicts[1]!.route?.noFallback], ['glm-x', 'hosted:glm', 'cross_eval', true]);
  assert.deepEqual([held.v.cross_family?.outcome, held.v.cross_family?.patch_correct], ['disagrees', false]);
  assert.equal(held.v.confidence, 'medium');
  assert.match(held.v.confidence_reason!, /the evaluators disagree: the cross-family evaluator \(hosted:glm\) rejects the patch, confidence medium \(the migration has no down step\); the main evaluator approves the patch, confidence high/);
  const ask = held.f.log.read(0, ['decision.asked']).at(-1)!.payload as { context?: string[] };
  assert.ok(JSON.stringify(ask).includes('the evaluators disagree'), 'the hold the owner sees says why, both sides');

  const agreed = await protectedChange({ cross: 'hosted:glm' });
  assert.equal(agreed.v.cross_family?.outcome, 'agrees');
  assert.equal(agreed.v.confidence, 'high');
});

test('cross-family evaluator, wired: off by default runs nothing; a provider that may not run it is recorded not run, never redone on Anthropic', { skip }, async () => {
  const off = await protectedChange({});
  assert.equal(off.verdicts.length, 1);
  assert.equal(off.v.cross_family, undefined);

  const notOpted = await protectedChange({ cross: 'hosted:glm', optIn: false });
  assert.equal(notOpted.verdicts.length, 1, 'no run on Anthropic in its place');
  assert.equal(notOpted.v.cross_family?.outcome, 'not_run');
  assert.match(notOpted.v.cross_family!.reason!, /not run: this instance hasn't opted into hosted:glm/);
  assert.equal(notOpted.v.confidence, 'high', 'not run is recorded, and is no doubt by itself');
});

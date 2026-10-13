// Item 32: one agents.yaml `routing` section, keyed by task type; model_routing and eval_routing still load as aliases.
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { AgentsConfig } from '../src/config/schema.js';
import { routingInEffect, settingsForViewer, settingsView } from '../src/dashboard.js';
import { loadConfig } from '../src/config/load.js';
import { evalRouting } from '../src/eval-routing.js';
import { modelRouting } from '../src/model-routing.js';
import { effectiveRouting, ROUTING_KEYS } from '../src/routing.js';
import { applySettings } from '../src/settings.js';
import { exampleProject } from './helpers.js';

const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } } };
const parse = (o: object) => AgentsConfig.parse({ ...base, ...o });

test('routing: every task type is set in one section, the evaluator tiering included', () => {
  const a = parse({ routing: { build: 'opus', planner: 'haiku', eval_answer: 'opus', eval_cheap: 'haiku', eval_cheap_levels: ['L0', 'L1'], eval_escalate: false } });
  const m = modelRouting(a);
  assert.deepEqual([m.build, m.planner, m.eval_answer], ['opus', 'haiku', 'opus']);
  assert.deepEqual(evalRouting(a), { cheap_model: 'haiku', cheap_levels: ['L0', 'L1'], escalate: false });
});

test('aliases: an agents.yaml with model_routing and eval_routing loads and routes as before', () => {
  const a = parse({ model_routing: { build: 'opus', intake_replier: 'sonnet' }, eval_routing: { cheap_model: 'haiku', cheap_levels: [], escalate: false } });
  assert.deepEqual([modelRouting(a).build, modelRouting(a).intake_replier], ['opus', 'sonnet']);
  assert.deepEqual(evalRouting(a), { cheap_model: 'haiku', cheap_levels: [], escalate: false });
  const rows = Object.fromEntries(effectiveRouting(a).map((r) => [r.key, r.from]));
  assert.equal(rows.build, 'model_routing.build');
  assert.equal(rows.eval_cheap, 'eval_routing.cheap_model');
});

test('a key set both in routing and under an old name is refused, at the old name', () => {
  const r = AgentsConfig.safeParse({ ...base, routing: { eval_cheap: 'haiku' }, eval_routing: { cheap_model: 'sonnet' } });
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues.map((i) => i.path.join('.')), ['eval_routing.cheap_model']);
  assert.equal(AgentsConfig.safeParse({ ...base, routing: { build: 'opus' }, model_routing: { build: 'opus' } }).success, false);
  assert.equal(AgentsConfig.safeParse({ ...base, routing: { judge: 'opus' } }).success, false, 'an unknown key');
});

test('effective routing: every key with its source: agents.yaml, a role model that stood in, the instance, or the default', () => {
  const a = parse({ roles: { ...base.roles, researcher: { enabled: true, model: 'opus' } }, routing: { planner: 'opus' } });
  const rows = Object.fromEntries(effectiveRouting(a).map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(rows), ROUTING_KEYS);
  assert.deepEqual([rows.planner!.value, rows.planner!.from], ['opus', 'routing.planner']);
  assert.deepEqual([rows.build!.value, rows.build!.from], ['sonnet', 'roles.workers.model']);
  assert.deepEqual([rows.research!.value, rows.research!.from], ['opus', 'roles.researcher.model']);
  assert.deepEqual([rows.intake_replier!.value, rows.intake_replier!.from], ['haiku', null]);
  const cfg = loadConfig(exampleProject().dir);
  const applied = applySettings(cfg, { eval_routing: { escalate: false } });
  const esc = effectiveRouting(applied.agents).find((r) => r.key === 'eval_escalate')!;
  assert.deepEqual([esc.value, esc.from], [false, 'policy.yaml settings.eval_routing.escalate']);
});

test('the Settings page gets the effective routing for writers, not for viewers', () => {
  const cfg = loadConfig(exampleProject().dir);
  const v = settingsView(cfg);
  assert.deepEqual(v.routing.map((r) => r.key), ROUTING_KEYS);
  assert.ok(v.routing.every((r) => typeof r.task === 'string' && r.task.length > 0));
  assert.equal('routing' in settingsForViewer(cfg), false);
});

test("the panel's routing is the one in effect: the instance's policy.yaml eval_routing over the repo's", () => {
  const cfg = loadConfig(exampleProject().dir);
  const policyFile = join(mkdtempSync(join(tmpdir(), 'routing-')), 'policy.yaml');
  writeFileSync(policyFile, 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nsettings: { eval_routing: { cheap_model: haiku } }\n');
  const cheap = routingInEffect({ cfg, policyFile }).find((r) => r.key === 'eval_cheap')!;
  assert.deepEqual([cheap.value, cheap.from], ['haiku', 'policy.yaml settings.eval_routing.cheap_model']);
  writeFileSync(policyFile, 'not: [valid');
  assert.equal(routingInEffect({ cfg, policyFile }).find((r) => r.key === 'eval_cheap')!.value, 'sonnet', 'an unreadable policy: the repo\'s');
});

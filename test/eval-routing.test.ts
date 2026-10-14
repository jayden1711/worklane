import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsConfig } from '../src/config/schema.js';
import { DEFAULT_EVAL_ROUTING, commentOnly, evalRouting, evaluatorModel, routingLevel, shouldEscalate } from '../src/eval-routing.js';
import { InstanceSettings } from '../src/instance.js';
import { applySettings } from '../src/settings.js';
import { loadConfig } from '../src/config/load.js';
import { exampleProject } from './helpers.js';

test('the review level picks the evaluator model: L0 the cheap model, L1 and up the evaluator role\'s', () => {
  assert.equal(evaluatorModel('L0', 'opus'), 'sonnet');
  for (const l of ['L1', 'L2', 'L3'] as const) assert.equal(evaluatorModel(l, 'opus'), 'opus', l);
  assert.equal(evaluatorModel('L1', 'opus', { ...DEFAULT_EVAL_ROUTING, cheap_levels: ['L0', 'L1'] }), 'sonnet', 'an instance may widen it');
  assert.equal(evaluatorModel('L0', 'opus', { ...DEFAULT_EVAL_ROUTING, cheap_levels: [] }), 'opus', 'or turn it off');
});

test('a cheap verdict that is not a confident pass goes to the strong model once; the strong verdict is final', () => {
  const base = { usedModel: 'sonnet', strongModel: 'opus', escalated: false };
  assert.equal(shouldEscalate({ ...base, verdict: { patch_correct: false, confidence: 'high' } }), true, 'a rejection');
  assert.equal(shouldEscalate({ ...base, verdict: { patch_correct: true, confidence: 'medium' } }), true, 'an uncertain pass');
  assert.equal(shouldEscalate({ ...base, verdict: null }), true, 'no verdict');
  assert.equal(shouldEscalate({ ...base, verdict: { patch_correct: true, confidence: 'high' } }), false, 'a confident pass stands');
  assert.equal(shouldEscalate({ ...base, escalated: true, verdict: { patch_correct: false, confidence: 'low' } }), false, 'only once');
  assert.equal(shouldEscalate({ ...base, usedModel: 'opus', verdict: { patch_correct: false, confidence: 'low' } }), false, 'the strong model is never escalated from');
  assert.equal(shouldEscalate({ ...base, verdict: null, routing: { ...DEFAULT_EVAL_ROUTING, escalate: false } }), false, 'escalation can be turned off');
});

test('a comment-only change routes as L0; any code line, an unknown file type or no files does not', () => {
  const f = (path: string, addedLines: string[], removedLines: string[] = []) => ({ path, addedLines, removedLines });
  assert.equal(commentOnly([f('src/a.ts', ['  // explain the rounding', '', ' * more']), f('tool.py', ['# why'], ['# old why'])]), true);
  assert.equal(commentOnly([f('src/a.ts', ['// note', 'const x = 1;'])]), false, 'a code line');
  assert.equal(commentOnly([f('src/a.ts', ['// note'], ['return total;'])]), false, 'removed code counts too');
  assert.equal(commentOnly([f('data.bin', ['# looks like a comment'])]), false, 'unknown syntax');
  assert.equal(commentOnly([f('run.sh', ['#!/bin/sh'])]), false, 'a shebang is not a comment');
  assert.equal(commentOnly([]), false);
  assert.equal(routingLevel('L1', [f('src/a.ts', ['// only this'])]), 'L0');
  assert.equal(routingLevel('L2', [f('src/a.ts', ['let y = 2;'])]), 'L2');
});

test('routing defaults in agents.yaml, overridable per instance in policy.yaml settings', () => {
  const agents = AgentsConfig.parse({ daily_budget_usd: 5, roles: { evaluator: { enabled: true, model: 'opus' } } });
  assert.deepEqual(evalRouting(agents), { cheap_model: 'sonnet', cheap_levels: ['L0'], escalate: true });
  const { dir } = exampleProject();
  const cfg = loadConfig(dir);
  const s = InstanceSettings.parse({ eval_routing: { cheap_levels: ['L0', 'L1'], escalate: false } });
  const applied = applySettings(cfg, s);
  assert.deepEqual(evalRouting(applied.agents), { cheap_model: 'sonnet', cheap_levels: ['L0', 'L1'], escalate: false });
  assert.deepEqual(evalRouting(applySettings(cfg, {}).agents), evalRouting(cfg.agents), 'no setting: the repo default');
  assert.throws(() => InstanceSettings.parse({ eval_routing: { cheap_levels: ['L9'] } }));
});

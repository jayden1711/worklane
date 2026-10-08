import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { exampleProject } from './helpers.js';

test('the example project config is valid', () => {
  const cfg = loadConfig(exampleProject().dir);
  assert.equal(cfg.project.owners.default, 'example-owner');
  assert.equal(cfg.agents.roles.workers?.model, 'sonnet');
});

test('invalid config fails loudly, listing every error with file and path', () => {
  const { dir } = exampleProject();
  const edit = (file: string, from: string, to: string) => {
    const p = join(dir, '.worklane', file);
    writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
  };
  edit('agents.yaml', 'daily_budget_usd: 40', 'daily_budget_usd: -5\nsurprise_key: 1');
  edit('config.yaml', 'land_mode: pr', 'land_mode: yolo');
  edit('tests.yaml', '  one: "node --test --test-reporter=spec {file}"', '  one: "node --test"');
  try {
    loadConfig(dir);
    assert.fail('expected ConfigInvalid');
  } catch (e) {
    assert.ok(e instanceof ConfigInvalid);
    const where = e.errors.map((x) => `${x.file}:${x.path}`);
    for (const w of ['agents.yaml:daily_budget_usd', 'agents.yaml:', 'config.yaml:land_mode', 'tests.yaml:runner.one']) {
      assert.ok(where.some((x) => x.startsWith(w)), `${w} in ${where.join(', ')}`);
    }
    assert.ok(e.errors.some((x) => /surprise_key/.test(x.message)), 'unknown keys are errors');
  }
});

test('cross-file checks: owners must be writers, rule ids unique, fingerprint sets exist', () => {
  const { dir } = exampleProject();
  const p = join(dir, '.worklane', 'config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace('default: example-owner', 'default: stranger'));
  const g = join(dir, '.worklane', 'guardrails.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace('fingerprints: prod-db } }', 'fingerprints: nope } }').replace('id: user-agent-spoofing', 'id: live-wallet-signing'));
  assert.throws(() => loadConfig(dir), (e: ConfigInvalid) => {
    const msgs = e.errors.map((x) => x.message).join('\n');
    return /default owner/.test(msgs) && /duplicate rule id/.test(msgs) && /no fingerprint set named nope/.test(msgs);
  });
});

test('duplicate YAML keys are errors', () => {
  const { dir } = exampleProject();
  const p = join(dir, '.worklane', 'agents.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + '\nstage: 2\n');
  assert.throws(() => loadConfig(dir), ConfigInvalid);
});

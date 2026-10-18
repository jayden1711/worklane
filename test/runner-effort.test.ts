// A role's effort (#579): claude --effort carries it only when the role sets one of claude's five levels; unset sets
// nothing anywhere (no flag, no effortLevel in --settings, no CLAUDE_CODE_EFFORT_LEVEL in the agent's environment).
import { STDIN_LINE } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRunner, cliArgs, type RunRequest } from '../src/runner.js';

const req = (o: Partial<RunRequest> & Record<string, unknown> = {}) => ({ role: 'worker', prompt: 'p', cwd: '.', model: 'sonnet', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, ...o }) as RunRequest;
const effortOf = (a: string[]) => (a.includes('--effort') ? a[a.indexOf('--effort') + 1] : null);

test('cliArgs: each of the five levels reaches claude as --effort; unset, an unlisted value or a provider run: no flag', () => {
  for (const role of ['worker', 'evaluator-verdict', 'evaluator-repro', 'planner']) {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) assert.equal(effortOf(cliArgs(req({ role, effort: level }))), level, `${role} ${level}`);
    assert.equal(effortOf(cliArgs(req({ role }))), null, `${role} unset`);
  }
  for (const bad of ['turbo', 'max --dangerously-skip-permissions', '']) assert.equal(effortOf(cliArgs(req({ effort: bad as never }))), null, bad);
  // An open model's endpoint (agents.yaml providers): whether it takes the effort parameter is unknown, so it gets none.
  const provider = { name: 'local', kind: 'local' as const, baseUrl: 'http://127.0.0.1:8080', keyFile: '/k' };
  assert.equal(effortOf(cliArgs(req({ effort: 'high', provider }))), null);
  assert.ok(!cliArgs(req()).includes('--effort'), 'unset: no flag at all');
});

type Seen = { args: string[]; envEffort: string | null; settings: Record<string, unknown> | null };

/** One run through a stand-in claude that records its arguments, the effort variable it was given and its --settings. */
async function runOnce(r: RunRequest, base: NodeJS.ProcessEnv): Promise<Seen> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-effort-'));
  const log = join(dir, 'log.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
JSON.parse(${STDIN_LINE});
const at = args.indexOf('--settings');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, envEffort: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null, settings: at >= 0 ? JSON.parse(args[at + 1]) : null }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  const out = await new CliRunner('cli', base, bin).run(r);
  assert.equal(out.reason, 'succeeded', out.detail);
  return JSON.parse(readFileSync(log, 'utf8')) as Seen;
}

test("a run: a role's effort is the --effort flag; unset is no flag, no effortLevel and no CLAUDE_CODE_EFFORT_LEVEL, even when the coordinator's own environment has one", { skip: process.platform === 'win32' && 'POSIX shell stand-in' }, async () => {
  const base = { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: 'max' };
  const set = await runOnce(req({ effort: 'xhigh' }), base);
  assert.equal(effortOf(set.args), 'xhigh');
  assert.equal(set.envEffort, null, 'the flag only, never the variable');
  const unset = await runOnce(req(), base);
  assert.equal(effortOf(unset.args), null);
  assert.equal(unset.envEffort, null, "the coordinator's variable never reaches the agent");
  assert.ok(!unset.settings || !('effortLevel' in unset.settings), `no effortLevel in --settings: ${JSON.stringify(unset.settings)}`);
  assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in ((unset.settings?.env as Record<string, string> | undefined) ?? {})), 'nor in the settings env');
});

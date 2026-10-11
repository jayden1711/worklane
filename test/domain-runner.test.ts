import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook } from '../src/hook.js';
import { CliRunner, type RunRequest } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';
import { exampleProject } from './helpers.js';

const posixOnly = process.platform === 'win32' && 'POSIX stand-in for claude';
const ALLOW = `${BRAND.envPrefix}_ALLOW_HOSTS`;

/** A stand-in claude: logs its argv and the one-run allowance, then a WebFetch the hook refused, then a result. */
function standIn() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'got.json'), JSON.stringify({ argv: process.argv.slice(2), allow: process.env.${ALLOW} ?? null }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.once('data', () => {
  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://new.example.org/rates' } }] } });
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: '[${BRAND.cli}] new.example.org is not on the network allowlist; request approval to add it' }] }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0.01 });
});
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, got: () => JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8')) as { argv: string[]; allow: string | null } };
}

const req = (cwd: string, over: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'Read the rates.', cwd, stateDir: mkdtempSync(join(tmpdir(), 'state-')), model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...over });
const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { sandbox: { network: { allowedDomains: string[] } } };

test("the runner reports the hosts a run was refused, from the run's own stream", { skip: posixOnly }, async () => {
  const s = standIn();
  const lanes = { default: { settings: sandboxSettings({ lane: { allowedDomains: ['pypi.org'] }, denyRead: [] }) } };
  const r = await new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'cfg') }, s.bin, undefined, lanes).run(req(s.dir));
  assert.equal(r.reason, 'succeeded');
  assert.deepEqual(r.refusedHosts, [{ host: 'new.example.org', tool: 'WebFetch', what: 'https://new.example.org/rates' }]);
});

test("allow-once hosts reach that run only: its sandbox settings and the hook's allowance, the lane's own settings unchanged", { skip: posixOnly }, async () => {
  const s = standIn();
  const lane = sandboxSettings({ lane: { allowedDomains: ['pypi.org'] }, denyRead: [] });
  const before = JSON.stringify(lane);
  const run = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(s.dir, 'cfg') }, s.bin, undefined, { default: { settings: lane } });
  const r = await run.run(req(s.dir, { allowOnce: ['new.example.org'] }));
  assert.deepEqual(settingsOf(s.got().argv).sandbox.network.allowedDomains, ['pypi.org', 'new.example.org']);
  assert.equal(s.got().allow, 'new.example.org');
  assert.equal(r.refusedHosts, undefined, 'a host the run was allowed is never reported as refused');
  assert.equal(JSON.stringify(lane), before, 'the lane is not widened');
  await run.run(req(s.dir));
  assert.deepEqual(settingsOf(s.got().argv).sandbox.network.allowedDomains, ['pypi.org']);
  assert.equal(s.got().allow, null);
});

test("the hook lets an agent's WebFetch reach an allow-once host for that session, and still refuses others", async () => {
  const { dir, stateDir } = exampleProject();
  const fetch = (url: string, env: Record<string, string>) =>
    runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'WebFetch', tool_input: { url } }, { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, [`${BRAND.envPrefix}_AGENT`]: '1', ...env });
  const decision = (o: { stdout?: string }) => (o.stdout ? (JSON.parse(o.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : 'none');
  assert.equal(decision(await fetch('https://new.example.org/rates', {})), 'deny');
  assert.notEqual(decision(await fetch('https://new.example.org/rates', { [ALLOW]: 'new.example.org' })), 'deny');
  assert.equal(decision(await fetch('https://other.example.net/', { [ALLOW]: 'new.example.org' })), 'deny');
});

// #626: claude (2.1.296, the pinned CLI) drops a whole --settings over one invalid value, deny rules and hooks
// included, and says nothing. A run whose --settings claude didn't apply is stopped before the agent's first turn,
// naming the settings; a run whose settings were applied goes on as before.
import { STDIN_LINE, engineCli, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { BRAND } from '../src/brand.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSettingsPath, guardrailSettings } from '../src/agent-settings.js';
import { agentSettings } from '../src/install.js';
import { childEnv } from '../src/os/index.js';
import { CliRunner, type RunRequest } from '../src/runner.js';

const isWindows = process.platform === 'win32';

/**
 * A stand-in claude. `applied`: its init event reports the --settings' outputStyle, as claude does with a file it
 * accepted. `dropped`: it reports the default style, as claude does after dropping the file. `no-init`: it starts
 * the agent's turn without an init event. `tool-result-first`: a tool result comes before an init that would pass.
 * `result-only`: it does the work and prints a successful result with structured output, and nothing else. Then, like a model's answer arriving, it does the agent's work (a file
 * written, standing for a tool call) and ends with a result.
 */
function fakeClaude(mode: 'applied' | 'dropped' | 'no-init' | 'result-only' | 'tool-result-first') {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-settings-'));
  const work = join(dir, 'agent-work');
  const log = join(dir, 'log.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const at = args.indexOf('--settings');
const settings = at >= 0 ? JSON.parse(args[at + 1]) : null;
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ settings }));
const mode = ${JSON.stringify(mode)};
const say = (o) => console.log(JSON.stringify(o));
if (mode === 'result-only') {
  fs.writeFileSync(${JSON.stringify(work)}, 'done');
  say({ type: 'result', subtype: 'success', result: 'finished the task', structured_output: { verdict: 'pass' }, total_cost_usd: 0.01, num_turns: 1 });
  process.exit(0);
}
if (mode === 'tool-result-first') say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: 'early' }] } });
if (mode !== 'no-init') say({ type: 'system', subtype: 'init', session_id: 's', tools: ['Bash', 'Read'], mcp_servers: [], plugins: [], output_style: mode === 'applied' || mode === 'tool-result-first' ? (settings && settings.outputStyle) || 'default' : 'default' });
else say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true' } }] } });
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(work)}, 'done');
  if (mode !== 'no-init') say({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  say({ type: 'result', subtype: 'success', result: 'finished the task', total_cost_usd: 0.01, num_turns: 1 });
}, 400);
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    worked: () => existsSync(work),
    settings: () => (existsSync(log) ? (JSON.parse(readFileSync(log, 'utf8')) as { settings: Record<string, unknown> | null }).settings : undefined),
  };
}

/** An instance home with valid agent settings, and the guardrails reader the service gives the runner. */
function instance() {
  const home = mkdtempSync(join(tmpdir(), 'settings-applied-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'settings-applied-cwd-'));
  // A project, as every guarded run's cwd is: one with no config folder doesn't start (#890), as its hook would deny
  // every call.
  cpSync(join(repoRoot, 'examples', 'basic', BRAND.configDir), join(cwd, BRAND.configDir), { recursive: true });
  writeFileSync(agentSettingsPath(home), JSON.stringify(agentSettings(engineCli, [], [], [])), { mode: 0o600 });
  return { home, cwd, guardrails: () => guardrailSettings(home, 'shop', cwd) };
}

const req = (cwd: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000 });
const settle = () => new Promise((r) => setTimeout(r, 700));
const skip = isWindows && 'POSIX stand-in claude';

test("a run whose --settings claude dropped is refused, naming the instance's agent settings file, and the agent does no work", { skip }, async () => {
  const { home, cwd, guardrails } = instance();
  const c = fakeClaude('dropped');
  const r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, guardrails).run(req(cwd));
  assert.equal(r.reason, 'failed', r.detail);
  assert.ok(r.detail.includes(agentSettingsPath(home)), `names the settings file: ${r.detail}`);
  assert.match(r.detail, /did not apply the --settings/);
  assert.equal(r.costUsd, 0);
  await settle();
  assert.equal(c.worked(), false, 'stopped before the agent did anything');
});

test('a run whose --settings claude applied goes on unchanged; each run gets its own check value', { skip }, async () => {
  const { cwd, guardrails } = instance();
  const runner = (bin: string) => new CliRunner('cli', childEnv(), bin, undefined, undefined, undefined, {}, guardrails);
  const a = fakeClaude('applied');
  const r = await runner(a.bin).run(req(cwd));
  assert.equal(r.reason, 'succeeded', r.detail);
  assert.equal(r.detail, 'finished the task');
  assert.equal(r.costUsd, 0.01);
  assert.equal(a.worked(), true);
  const b = fakeClaude('applied');
  assert.equal((await runner(b.bin).run(req(cwd))).reason, 'succeeded');
  const [sa, sb] = [a.settings()?.outputStyle, b.settings()?.outputStyle];
  assert.ok(typeof sa === 'string' && typeof sb === 'string' && sa !== sb && sa !== 'default', `a fresh check value per run: ${String(sa)} ${String(sb)}`);
  // The guardrails themselves are what they were: hooks, rules and disableAllHooks pinned off.
  const s = a.settings()!;
  assert.equal(s.disableAllHooks, false);
  assert.ok((s.hooks as Record<string, unknown>).PreToolUse);
});

test("a lane's --settings, without instance guardrails, are checked the same way and named as the lane's", { skip }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'settings-applied-lane-'));
  const lanes = { default: { settings: { permissions: { deny: ['Read(//secret/**)'] } } } };
  const dropped = fakeClaude('dropped');
  const r = await new CliRunner('cli', childEnv(), dropped.bin, undefined, lanes).run(req(cwd));
  assert.equal(r.reason, 'failed', r.detail);
  assert.match(r.detail, /did not apply the --settings this run passed \(the lane's settings\)/);
  await settle();
  assert.equal(dropped.worked(), false);
  const applied = fakeClaude('applied');
  assert.equal((await new CliRunner('cli', childEnv(), applied.bin, undefined, lanes).run(req(cwd))).reason, 'succeeded');
});

test('an agent turn before any init event confirmed the --settings stops the run', { skip }, async () => {
  const { home, cwd, guardrails } = instance();
  const c = fakeClaude('no-init');
  const r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, guardrails).run(req(cwd));
  assert.equal(r.reason, 'failed', r.detail);
  assert.ok(r.detail.includes(agentSettingsPath(home)), r.detail);
  await settle();
  assert.equal(c.worked(), false);
});

test('a session that never sends an init event fails: its result and structured output are not taken', { skip }, async () => {
  const { home, cwd, guardrails } = instance();
  const c = fakeClaude('result-only');
  const r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, guardrails).run(req(cwd));
  assert.equal(r.reason, 'failed', r.detail);
  assert.equal(r.structured, undefined, 'its structured output is never accepted');
  assert.ok(r.detail.includes(agentSettingsPath(home)), r.detail);
  assert.match(r.detail, /before its init event confirmed the --settings/);
});

test('a tool result before the init event stops the run, and the line reaches nothing that reads the stream', { skip }, async () => {
  const { home, cwd, guardrails } = instance();
  const c = fakeClaude('tool-result-first');
  const seen: string[] = [];
  const r = await new CliRunner('cli', childEnv(), c.bin, undefined, undefined, undefined, {}, guardrails).run({
    ...req(cwd),
    onStreamLine: (l) => seen.push(String((l as { type?: unknown }).type)),
    onLine: (l) => seen.push(`line:${String((l as { type?: unknown }).type)}`),
  });
  assert.equal(r.reason, 'failed', r.detail);
  assert.ok(r.detail.includes(agentSettingsPath(home)), r.detail);
  assert.match(r.detail, /a user line before its init event/);
  assert.deepEqual(seen, [], 'nothing forwarded');
  await settle();
  assert.equal(c.worked(), false);
});

test('a run given no --settings has nothing to confirm and runs as before', { skip }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'settings-applied-none-'));
  const c = fakeClaude('dropped');
  const r = await new CliRunner('cli', childEnv(), c.bin).run(req(cwd));
  assert.equal(r.reason, 'succeeded', r.detail);
  assert.equal(c.settings(), null, 'no --settings at all');
});

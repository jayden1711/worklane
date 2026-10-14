// WHY: item 38. Codex and Gemini CLI runners: what they may run (and are refused), their command lines and
// environment, their streams read into a RunResult, budgets from token counts, and the held change. No vendor CLI
// is installed here; the fixtures are hand-written from each CLI's documented JSON event format.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { CliAgentRunner, cliAgentCommand, cliPrompt, cliRunRefusal, codexArgs, CodexStream, geminiArgs, GeminiStream, GEMINI_POINTER, structuredOutput, withCliAgents, type CliStream } from '../src/cli-agents.js';
import { loadConfig } from '../src/config/load.js';
import { AgentsConfig } from '../src/config/schema.js';
import { builtChangeRefusal, cliChangeRefusal, resolveProvider } from '../src/coordinator/providers.js';
import { runRoute } from '../src/coordinator/model-routing.js';
import { InstanceSettings } from '../src/instance.js';
import { killTree } from '../src/os/index.js';
import { PROVIDER_GATE_FILE, providerOf, providerRefusal } from '../src/providers.js';
import { CliRunner, FakeRunner, type RunRequest } from '../src/runner.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const fixture = (name: string) => readFileSync(join(repoRoot, 'test', 'fixtures', 'cli-agents', name), 'utf8');
const PRICES = { in: 1.25, out: 10 };
const SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

const build = (agent: 'codex' | 'gemini', over: Partial<RunRequest> = {}): RunRequest => ({
  role: 'worker',
  prompt: 'Fix issue #7: the secret rounding plan',
  appendSystemPrompt: 'You are the worker.',
  cwd: '/tmp',
  model: agent === 'codex' ? 'codex-model-x' : 'gemini-model-x',
  allowedTools: [],
  maxTurns: 20,
  maxBudgetUsd: 1,
  stallMs: 30_000,
  timeoutMs: 30_000,
  route: { kind: 'build', fallback: 'sonnet' },
  provider: { name: `cli:${agent}`, kind: 'cli', agent, usdPerMtok: PRICES },
  ...over,
});

// ---- what they may run

test('cli:<agent> names another vendor\'s CLI; code lets it run easy builds only', () => {
  assert.deepEqual(providerOf('cli:codex'), { kind: 'cli', name: 'codex' });
  assert.deepEqual(providerOf('cli:gemini'), { kind: 'cli', name: 'gemini' });
  assert.deepEqual(providerOf('cli:other'), { kind: 'cli', name: 'other' }, 'an unknown agent is a provider, refused as unconfigured, never a claude model');
  assert.equal(providerRefusal('cli', { route: 'build' }), null);
  for (const r of ['planner', 'research', 'intake_triage', 'intake_replier', 'stage_judge', 'eval_answer', 'other'] as const) assert.ok(providerRefusal('cli', { route: r }), r);
  assert.match(providerRefusal('cli', { route: 'evaluator' })!, /evaluator never/);
  assert.match(providerRefusal('cli', { route: 'build', highRisk: true })!, /never builds high-risk work/);
});

test('the runner itself refuses anything but an easy build routed to it: high-risk, the planner, the evaluator, interactive, a resume, no prices', () => {
  for (const agent of ['codex', 'gemini'] as const) {
    assert.equal(cliRunRefusal(agent, build(agent)), null);
    const { provider: _p, ...unrouted } = build(agent);
    assert.match(cliRunRefusal(agent, unrouted)!, /isn't routed/);
    assert.match(cliRunRefusal(agent, build(agent === 'codex' ? 'gemini' : 'codex'))!, /isn't routed/, 'routed to the other CLI');
    const { route: _r, ...noRoute } = build(agent);
    assert.match(cliRunRefusal(agent, noRoute)!, /no route/);
    assert.match(cliRunRefusal(agent, build(agent, { route: { kind: 'build', highRisk: true, fallback: 'opus' } }))!, /high-risk/);
    assert.match(cliRunRefusal(agent, build(agent, { role: 'planner', route: { kind: 'planner', fallback: 'opus' } }))!, /not planner/);
    assert.match(cliRunRefusal(agent, build(agent, { role: 'evaluator', route: { kind: 'evaluator', fallback: 'opus' } }))!, /evaluator never/);
    assert.match(cliRunRefusal(agent, build(agent, { interactive: true }))!, /person is waiting/);
    assert.match(cliRunRefusal(agent, build(agent, { resume: 'abc' }))!, /can't resume/);
    assert.match(cliRunRefusal(agent, build(agent, { provider: { name: `cli:${agent}`, kind: 'cli', agent, usdPerMtok: { in: 0, out: 0 } } }))!, /budget can't be enforced/);
  }
});

test('a refused run never starts its CLI, and a lane without an agent user never runs one', async () => {
  let launched = 0;
  const exec = { wrap: (_u: string, f: string, a: string[], e: NodeJS.ProcessEnv): [string, string[], NodeJS.ProcessEnv] => (launched++, [f, a, e]), kill: () => {} };
  const runner = new CliAgentRunner('codex', { runAs: (lane) => (lane === 'default' ? { user: 'agent', home: '/home/example' } : undefined), exec });
  const high = await runner.run(build('codex', { route: { kind: 'build', highRisk: true, fallback: 'opus' } }));
  assert.deepEqual([high.reason, high.turns], ['failed', 0]);
  assert.match(high.detail, /high-risk.*not starting/);
  const planner = await runner.run(build('codex', { role: 'planner', route: { kind: 'planner', fallback: 'opus' } }));
  assert.match(planner.detail, /not planner; not starting/);
  const lane = await runner.run(build('codex', { lane: 'other' }));
  assert.match(lane.detail, /lane "other" has no agent user/);
  assert.equal(launched, 0);
});

test('schema: cli:<agent> only for the easy build route, only when configured with a tier and prices; the instance opts in by name', () => {
  const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } } };
  const codex = { model: 'codex-model-x', tier: 'sonnet', usd_per_mtok_in: 1.25, usd_per_mtok_out: 10 };
  const ok = (o: object) => AgentsConfig.safeParse({ ...base, ...o }).success;
  assert.equal(ok({ providers: { cli: { codex } }, model_routing: { build: 'cli:codex' } }), true);
  assert.equal(ok({ model_routing: { build: 'cli:codex' } }), false, 'not configured');
  assert.equal(ok({ providers: { cli: { codex } }, model_routing: { build: 'cli:gemini' } }), false, 'another CLI not configured');
  assert.equal(ok({ providers: { cli: { codex } }, model_routing: { build: 'cli:other' } }), false, 'an unknown CLI');
  assert.equal(ok({ providers: { cli: { codex } }, model_routing: { build_high_risk: 'cli:codex' } }), false, 'never high-risk builds');
  assert.equal(ok({ providers: { cli: { codex } }, model_routing: { planner: 'cli:codex' } }), false, 'never the planner');
  assert.equal(ok({ providers: { cli: { codex } }, model_routing: { research: 'cli:codex' } }), false, 'never research');
  assert.equal(ok({ providers: { cli: { codex } }, roles: { ...base.roles, evaluator: { enabled: true, model: 'cli:codex' } } }), false, 'never the evaluator');
  assert.equal(ok({ providers: { cli: { codex } }, eval_routing: { cheap_model: 'cli:codex' } }), false, 'never tiered evaluation');
  const { tier: _t, ...noTier } = codex;
  const { usd_per_mtok_out: _o, ...noPrice } = codex;
  assert.equal(ok({ providers: { cli: { codex: noTier } } }), false, 'a tier is required');
  assert.equal(ok({ providers: { cli: { codex: noPrice } } }), false, 'prices are required: the budget is enforced from them');
  assert.equal(ok({ providers: { cli: { codex: { ...codex, model: '--dangerously-bypass' } } } }), false, 'a model id is never a flag');
  assert.equal(InstanceSettings.safeParse({ providers: { cli: ['codex', 'gemini'] } }).success, true);
  assert.equal(InstanceSettings.safeParse({ providers: { cli: ['other'] } }).success, false);
});

// ---- routing: opt-in, configured, allowed, evaluated

function deps(settings: object, gate = true) {
  const cfg = loadConfig(exampleProject().dir);
  cfg.agents = AgentsConfig.parse({ daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } }, providers: { cli: { codex: { model: 'codex-model-x', tier: 'sonnet', usd_per_mtok_in: 1.25, usd_per_mtok_out: 10 } } }, model_routing: { build: 'cli:codex' } });
  const stateDir = mkdtempSync(join(tmpdir(), 'cli-state-'));
  if (gate) {
    mkdirSync(join(stateDir, 'evals'), { recursive: true });
    const pass = { held_out: { passed: 20, total: 20 }, baseline: { passed: 19, total: 20 }, visible: { passed: 10, total: 10 }, samples: 3, at: '2026-10-13T00:00:00Z' };
    writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ worker: { 'codex-model-x': pass } }));
  }
  return { cfg, stateDir, settings: InstanceSettings.parse(settings) };
}

test('a build named cli:codex goes to codex only when opted in, allowed and evaluated; otherwise its fallback, saying why', async () => {
  const asked = (over: Partial<RunRequest> = {}): RunRequest => {
    const { provider: _p, ...r } = build('codex', { model: 'cli:codex', ...over });
    return r;
  };
  const r = await resolveProvider(asked(), deps({ providers: { cli: ['codex'] } }));
  assert.equal(r.fellBack, null);
  assert.equal(r.req.model, 'codex-model-x');
  assert.deepEqual(r.req.provider, { name: 'cli:codex', kind: 'cli', agent: 'codex', usdPerMtok: { in: 1.25, out: 10 } });
  const why = async (req: RunRequest, d: ReturnType<typeof deps>) => {
    const f = await resolveProvider(req, d);
    assert.equal(f.req.provider, undefined);
    assert.equal(f.req.model, req.route?.fallback);
    return f.fellBack!.reason;
  };
  assert.match(await why(asked(), deps({})), /hasn't opted into cli:codex/);
  assert.match(await why(asked(), deps({ providers: { hosted: ['codex'] } })), /hasn't opted into cli:codex/, 'a hosted opt-in is not a cli one');
  assert.match(await why(asked({ route: { kind: 'build', highRisk: true, fallback: 'opus' } }), deps({ providers: { cli: ['codex'] } })), /never builds high-risk/);
  assert.match(await why(asked({ role: 'planner', route: { kind: 'planner', fallback: 'opus' } }), deps({ providers: { cli: ['codex'] } })), /not planner/);
  assert.match(await why(asked({ role: 'evaluator', route: { kind: 'evaluator', fallback: 'opus' } }), deps({ providers: { cli: ['codex'] } })), /evaluator never/);
  assert.match(await why(asked({ model: 'cli:gemini' }), deps({ providers: { cli: ['gemini'] } })), /cli:gemini is not configured/);
  assert.match(await why(asked(), deps({ providers: { cli: ['codex'] } }, false)), /no eval on codex-model-x/);
  assert.match(await why(asked(), deps({ providers: { cli: ['codex'] }, model_cap: 'haiku' })), /above this instance's model cap/);
});

test('the instance runner sends a cli-routed run to its CLI, every other run to claude; claude never runs a cli-routed one', async () => {
  const claude = new FakeRunner(() => ({ detail: 'claude' }));
  const codex = new FakeRunner(() => ({ detail: 'codex' }));
  const r = withCliAgents(claude, { codex });
  assert.equal((await r.run(build('codex'))).detail, 'codex');
  const { provider: _p, ...plain } = build('codex', { model: 'sonnet' });
  assert.equal((await r.run(plain)).detail, 'claude');
  const g = await r.run(build('gemini'));
  assert.match(g.detail, /no cli:gemini runner/);
  assert.equal(claude.calls.length, 1, 'a cli run with no runner is never handed to claude');
  const viaClaude = await new CliRunner('cli', process.env, '/nonexistent-claude').run(build('codex'));
  assert.match(viaClaude.detail, /runs on its own CLI, not claude; not starting/);
});

// ---- command lines and streams

test('the command lines: the prompt is never on them (sudo logs them); it goes on stdin, with the system prompt and the schema', () => {
  const req = build('codex', { jsonSchema: SCHEMA });
  for (const args of [codexArgs(req), geminiArgs(req)]) assert.ok(!args.join(' ').includes('secret'), args.join(' '));
  assert.deepEqual(codexArgs(req), ['exec', '--json', '--model', 'codex-model-x', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-']);
  assert.deepEqual(geminiArgs(build('gemini')), ['--output-format', 'stream-json', '--model', 'gemini-model-x', '--approval-mode', 'yolo', '-p', GEMINI_POINTER]);
  const p = cliPrompt(req);
  assert.ok(p.startsWith('You are the worker.\n\nFix issue #7'));
  assert.ok(p.endsWith(JSON.stringify(SCHEMA)));
  const [file, args, env] = cliAgentCommand('agent', 'codex', ['exec', '-'], { PATH: '/usr/bin', HOME: '/home/example' });
  if (posix) {
    assert.equal(file, 'sudo');
    assert.deepEqual(args.slice(0, 7), ['-n', '-u', 'agent', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin']);
    assert.deepEqual(args.slice(-3), ['codex', 'exec', '-']);
    assert.deepEqual(env, { PATH: '/usr/bin' }, 'sudo itself gets only PATH');
  }
});

const feed = (s: CliStream, text: string) => text.split('\n').filter(Boolean).flatMap((l) => s.line(JSON.parse(l)));

test('codex --json: thread id, tool calls as claude-shaped lines, the last message, token usage', () => {
  const s = new CodexStream();
  const lines = feed(s, fixture('codex-build.jsonl')) as { type: string; message: { content: { type: string; name?: string; input?: { command?: string }; is_error?: boolean }[] } }[];
  assert.equal(s.outcome.sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
  assert.equal(s.outcome.turns, 3, 'two commands and a file change; reasoning is not a call');
  assert.deepEqual(s.outcome.tokens, { in: 24763, out: 122 });
  assert.equal(s.outcome.finished, true);
  assert.equal(s.outcome.failed, undefined);
  assert.match(s.outcome.text, /Fixed the rounding/);
  const blocks = lines.flatMap((l) => l.message.content);
  assert.deepEqual(blocks.filter((b) => b.type === 'tool_use').map((b) => b.name), ['Bash', 'Edit', 'Bash']);
  assert.deepEqual(blocks.filter((b) => b.type === 'tool_result').map((b) => b.is_error), [true, false, false]);
  assert.deepEqual(structuredOutput(s.outcome.text), { summary: 'Round half up in price()', tests_added: ['test/price.test.js'] });
  const f = new CodexStream();
  feed(f, fixture('codex-usage-limit.jsonl'));
  assert.match(f.outcome.failed!, /hit your usage limit/);
});

test('gemini stream-json: session id, model, tool calls, the final answer from its deltas, token stats', () => {
  const s = new GeminiStream();
  const lines = feed(s, fixture('gemini-build.jsonl')) as { message: { content: { type: string; name?: string; text?: string; is_error?: boolean }[] } }[];
  assert.equal(s.outcome.sessionId, 'c25acda3-b5a1-4f3e-9a1b-2f6e4d7c8b90');
  assert.equal(s.outcome.model, 'gemini-model-x');
  assert.equal(s.outcome.turns, 2);
  assert.deepEqual(s.outcome.tokens, { in: 17600, out: 650 });
  assert.equal(s.outcome.text, 'Fixed the rounding. {"summary":"Round half up in price()","tests_added":[]}', 'only the text after the last tool call');
  const blocks = lines.flatMap((l) => l.message.content);
  assert.deepEqual(blocks.filter((b) => b.type === 'tool_use').map((b) => b.name), ['run_shell_command', 'replace']);
  assert.deepEqual(blocks.filter((b) => b.type === 'tool_result').map((b) => b.is_error), [true, false]);
  assert.deepEqual(structuredOutput(s.outcome.text), { summary: 'Round half up in price()', tests_added: [] });
  const q = new GeminiStream();
  feed(q, fixture('gemini-quota.jsonl'));
  assert.match(q.outcome.failed!, /429/);
  // The older json output's per-model counts.
  const old = new GeminiStream();
  old.line({ type: 'result', status: 'success', stats: { models: { m: { tokens: { prompt: 100, candidates: 20, thoughts: 5 } } } } });
  assert.deepEqual(old.outcome.tokens, { in: 100, out: 25 });
});

// ---- whole runs, through a stand-in CLI

/** A stand-in CLI that records what it was given, prints a fixture, then exits (or hangs, to be killed). */
function standIn(agent: 'codex' | 'gemini', lines: string, opts: { hang?: boolean; exit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `fake-${agent}-`));
  const bin = join(dir, agent);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(join(dir, 'got.json'))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd() }));
  process.stdout.write(${JSON.stringify(lines)});
  ${opts.hang ? 'setTimeout(() => {}, 60000);' : `process.exitCode = ${opts.exit ?? 0};`}
});
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, got: () => JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8')) as { argv: string[]; env: Record<string, string>; stdin: string; cwd: string } };
}

const asSelf = { wrap: (_u: string, f: string, a: string[], e: NodeJS.ProcessEnv): [string, string[], NodeJS.ProcessEnv] => [f, a, e], kill: (_u: string, pid: number | undefined) => killTree(pid, () => {}) };

function runner(agent: 'codex' | 'gemini', bin: string, home: string) {
  const base = { PATH: process.env.PATH ?? '', HOME: '/home/user', GH_TOKEN: 'gh' + 'x'.repeat(30), OPENAI_API_KEY: 'sk-' + 'y'.repeat(30), GEMINI_API_KEY: 'g' + 'z'.repeat(30), ANTHROPIC_API_KEY: 'sk-ant-' + 'w'.repeat(30) };
  return new CliAgentRunner(agent, { runAs: () => ({ user: 'agent', home }), base, bin, exec: asSelf, identity: { name: 'site-app[bot]', email: 'bot@example.com' } });
}

test('a codex build: prompt on stdin, the agent user\'s home and the harness identity, no keys or tokens, result priced from tokens', { skip: !posix && 'a POSIX stand-in' }, async () => {
  const s = standIn('codex', fixture('codex-build.jsonl'));
  const stateDir = mkdtempSync(join(tmpdir(), 'cli-run-state-'));
  const r = await runner('codex', s.bin, s.dir).run(build('codex', { cwd: s.dir, jsonSchema: SCHEMA, stateDir }));
  assert.equal(r.reason, 'succeeded', r.detail);
  assert.deepEqual(r.structured, { summary: 'Round half up in price()', tests_added: ['test/price.test.js'] });
  assert.deepEqual([r.sessionId, r.turns, r.tokens, r.provider, r.model], ['0199a213-81c0-7800-8aa1-bbab2a035a53', 3, { in: 24763, out: 122 }, 'cli:codex', 'codex-model-x']);
  assert.ok(Math.abs(r.costUsd - (24763 * 1.25 + 122 * 10) / 1e6) < 1e-9, String(r.costUsd));
  const got = s.got();
  assert.deepEqual(got.argv, codexArgs(build('codex')));
  assert.equal(got.stdin, cliPrompt(build('codex', { jsonSchema: SCHEMA })));
  assert.equal(got.env.HOME, s.dir, "the agent user's home, where its codex login lives");
  assert.deepEqual([got.env.GIT_AUTHOR_NAME, got.env.GIT_COMMITTER_EMAIL], ['site-app[bot]', 'bot@example.com']);
  assert.equal(got.env[`${BRAND.envPrefix}_ROLE`], 'worker');
  for (const k of ['GH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(got.env[k], undefined, `${k} must not reach the run`);
  assert.equal(got.env.GIT_CONFIG_VALUE_0, '', 'no git credential helper');
  const runs = readFileSync(join(stateDir, 'runs', readdirSync(join(stateDir, 'runs')).find((f) => f.endsWith('.json'))!), 'utf8');
  assert.match(runs, /npm test -- price/, 'the run record has its commands');
});

test('a gemini build: the pointer on -p, the task on stdin, its answer\'s JSON as the structured output', { skip: !posix && 'a POSIX stand-in' }, async () => {
  const s = standIn('gemini', fixture('gemini-build.jsonl'));
  const r = await runner('gemini', s.bin, s.dir).run(build('gemini', { cwd: s.dir, jsonSchema: SCHEMA }));
  assert.equal(r.reason, 'succeeded', r.detail);
  assert.deepEqual(r.structured, { summary: 'Round half up in price()', tests_added: [] });
  assert.deepEqual([r.sessionId, r.turns, r.tokens, r.provider], ['c25acda3-b5a1-4f3e-9a1b-2f6e4d7c8b90', 2, { in: 17600, out: 650 }, 'cli:gemini']);
  const got = s.got();
  assert.equal(got.argv.at(-1), GEMINI_POINTER);
  assert.ok(got.stdin.includes('secret rounding plan') && !got.argv.join(' ').includes('secret'));
});

test('budgets from usage: a run whose tokens pass its budget is stopped at once as budget_exhausted', { skip: !posix && 'a POSIX stand-in' }, async () => {
  const s = standIn('codex', fixture('codex-build.jsonl'), { hang: true });
  const t0 = Date.now();
  // 24763 in and 122 out at 1.25 / 10 per Mtok is about $0.032: over a $0.01 budget.
  const r = await runner('codex', s.bin, s.dir).run(build('codex', { cwd: s.dir, maxBudgetUsd: 0.01 }));
  assert.equal(r.reason, 'budget_exhausted', r.detail);
  assert.ok(r.costUsd > 0.01);
  assert.ok(Date.now() - t0 < 20_000, 'killed, not waited out');
});

test('the turn cap: more tool calls than maxTurns stops the run, failed', { skip: !posix && 'a POSIX stand-in' }, async () => {
  const s = standIn('gemini', fixture('gemini-build.jsonl'), { hang: true });
  const r = await runner('gemini', s.bin, s.dir).run(build('gemini', { cwd: s.dir, maxTurns: 1 }));
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /error_max_turns: more than 1 tool calls/);
});

test('usage limits: codex\'s and gemini\'s own words become rate_limited, so the coordinator skips the provider until its reset', { skip: !posix && 'a POSIX stand-in' }, async () => {
  const c = standIn('codex', fixture('codex-usage-limit.jsonl'), { exit: 1 });
  const rc = await runner('codex', c.bin, c.dir).run(build('codex', { cwd: c.dir }));
  assert.equal(rc.reason, 'rate_limited', rc.detail);
  assert.ok(rc.limit?.resetAt);
  const g = standIn('gemini', fixture('gemini-quota.jsonl'), { exit: 1 });
  const rg = await runner('gemini', g.bin, g.dir).run(build('gemini', { cwd: g.dir }));
  assert.equal(rg.reason, 'rate_limited', rg.detail);
});

test('an answer without the JSON object a schema asks for fails the run; a CLI that dies without finishing fails it', { skip: !posix && 'a POSIX stand-in' }, async () => {
  const noJson = fixture('codex-build.jsonl').replace(/\\n\\n```json[^`]*```/, '');
  const a = standIn('codex', noJson);
  const r = await runner('codex', a.bin, a.dir).run(build('codex', { cwd: a.dir, jsonSchema: SCHEMA }));
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /without the JSON object/);
  const b = standIn('codex', fixture('codex-build.jsonl').split('\n').slice(0, 3).join('\n') + '\n', { exit: 2 });
  const d = await runner('codex', b.bin, b.dir).run(build('codex', { cwd: b.dir }));
  assert.equal(d.reason, 'failed');
  assert.match(d.detail, /exited 2 without finishing/);
});

// ---- the change, held after the build

test('a change another vendor\'s CLI built stands only at L1 or below, off protected paths, money paths and agent instructions', () => {
  const review = loadConfig(exampleProject().dir).review!;
  const guardrails = { protected_paths: ['deploy/**'] };
  const f = (path: string, addedLines: string[] = ['x']) => ({ path, added: addedLines.length, removed: 0, addedLines });
  const o = (files: ReturnType<typeof f>[], moneyPaths: RegExp[] = []) => cliChangeRefusal({ files, labels: [], moneyPaths: () => moneyPaths, review, guardrails });
  assert.equal(o([f('src/price.js')]), null, 'an easy change stands');
  assert.equal(o([f('docs/rounding.md')]), null, 'L0 stands');
  assert.match(o([f('deploy/run.sh')])!, /protected path \(deploy\/run\.sh\)/);
  assert.match(o([f(`${BRAND.configDir}/tests.yaml`)])!, /protected path/, 'the built-in protected paths');
  assert.match(o([f('.claude/settings.json')])!, /protected path/);
  assert.match(o([f('package.json')])!, /L2 change; it builds L1 work only/, 'L2: a hosted model\'s change would stand, this one does not');
  assert.match(o([f('src/billing/charge.js')], [/^src\/billing\//])!, /money path/);
  assert.match(o([f('AGENTS.md')])!, /protected path|agent instructions/, 'AGENTS.md is a protected path since item 33');
  assert.match(o([f(`${BRAND.configDir}/skills/triage/SKILL.md`)])!, /agent instructions/, 'an editable skill is still agent instructions');
  assert.match(o([f('db/migrate.sql', ['DROP TABLE orders;'])])!, /L3|money|protected/);
  // The build loop asks by the provider that built it.
  const held = { files: [f('package.json')], labels: [], moneyPaths: () => [], review, guardrails };
  assert.match(builtChangeRefusal('cli:codex', held)!, /L1 work only/);
  assert.equal(builtChangeRefusal('hosted:glm', held), null);
  assert.equal(builtChangeRefusal(undefined, held), null);
});

test('the reflection (a read-only role, routed since #340) is refused for cli: like the planner: in the schema, in routing and in the runner', async () => {
  assert.match(providerRefusal('cli', { route: 'reflection' })!, /not reflection/);
  const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } }, providers: { cli: { codex: { model: 'codex-model-x', tier: 'sonnet', usd_per_mtok_in: 1.25, usd_per_mtok_out: 10 } } } };
  for (const section of ['routing', 'model_routing'] as const) {
    const r = AgentsConfig.safeParse({ ...base, [section]: { reflection: 'cli:codex' } });
    if (section === 'model_routing' && !r.success && r.error.issues.some((i) => /Unrecognized key/.test(i.message))) continue;
    assert.equal(r.success, false, `${section}.reflection: cli:codex`);
    assert.ok(!r.success && r.error.issues.some((i) => /not reflection/.test(i.message)), JSON.stringify(!r.success && r.error.issues));
  }
  const d = deps({ providers: { cli: ['codex'] } });
  d.cfg.agents = AgentsConfig.parse({ ...base, routing: { build: 'cli:codex' } });
  const { model, route } = runRoute(d.cfg, 'reflection');
  const { provider: _p, ...req } = build('codex', { role: 'reflection', model: 'cli:codex', route });
  assert.notEqual(model, 'cli:codex', 'the schema keeps cli: off the reflection, so its route never names it');
  const f = await resolveProvider(req, d);
  assert.equal(f.req.provider, undefined);
  assert.match(f.fellBack!.reason, /cli models run only build/);
  assert.match(cliRunRefusal('codex', build('codex', { role: 'reflection', route }))!, /cli models run only build/, 'and the runner refuses it itself');
});

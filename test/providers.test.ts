// Open-model providers: where code lets each run, the per-run env (no key in it, ever), the fallback checks (opt-in,
// key, the eval gate, the GPU lock, the server's health), the hosted-change guard, and usage per model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { AgentsConfig } from '../src/config/schema.js';
import { hostedChangeRefusal, resolveProvider } from '../src/coordinator/providers.js';
import { InstanceSettings } from '../src/instance.js';
import { flockHeld } from '../src/os/index.js';
import { gatePasses, healthCheck, PROVIDER_GATE_FILE, providerCost, providerOf, providerRefusal } from '../src/providers.js';
import { CliRunner, FakeRunner, type RunRequest } from '../src/runner.js';
import { FileBacklog } from '../src/backlog/file.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { throughput, throughputMarkdown } from '../src/throughput.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = spawnSync('perl', ['-e', '1']).status === 0;

test('a model names a provider as `local` or `hosted:<name>`; anything else is an Anthropic model', () => {
  assert.deepEqual(providerOf('local'), { kind: 'local', name: 'local' });
  assert.deepEqual(providerOf('hosted:glm'), { kind: 'hosted', name: 'glm' });
  for (const m of ['sonnet', 'claude-opus-5-5', 'hosted:', 'hosted:GLM', 'localhost']) assert.equal(providerOf(m), null, m);
});

test('what each provider may run is fixed in code: local for replies, triage and the stage judge; hosted for easy builds and research', () => {
  for (const r of ['intake_replier', 'intake_triage', 'stage_judge'] as const) assert.equal(providerRefusal('local', { route: r }), null, r);
  for (const r of ['build', 'research', 'planner', 'eval_answer'] as const) assert.ok(providerRefusal('local', { route: r }), r);
  for (const r of ['build', 'research'] as const) assert.equal(providerRefusal('hosted', { route: r }), null, r);
  for (const r of ['planner', 'intake_replier', 'eval_answer'] as const) assert.ok(providerRefusal('hosted', { route: r }), r);
  assert.match(providerRefusal('hosted', { route: 'build', highRisk: true })!, /never build high-risk, L3, money-path or agent-instructions/);
  assert.match(providerRefusal('hosted', { route: 'evaluator' })!, /evaluator never/);
  assert.match(providerRefusal('local', { route: 'evaluator' })!, /evaluator never/);
});

const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } } };
const PROVIDERS = { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'small-1' }, hosted: { glm: { base_url: 'https://open.example.com/anthropic', credential: 'glm', model: 'glm-x', tier: 'sonnet', usd_per_mtok_in: 1, usd_per_mtok_out: 2 } } };

test('schema: a provider only where code allows it and only one that is configured; never a role\'s, the evaluator\'s or a high-risk build\'s model', () => {
  const ok = (o: object) => AgentsConfig.safeParse({ ...base, ...o }).success;
  assert.equal(ok({ providers: PROVIDERS, model_routing: { intake_replier: 'local', research: 'hosted:glm', build: 'hosted:glm' } }), true);
  assert.equal(ok({ model_routing: { intake_replier: 'local' } }), false, 'not configured');
  assert.equal(ok({ providers: PROVIDERS, model_routing: { research: 'hosted:other' } }), false, 'an unknown hosted provider');
  assert.equal(ok({ providers: PROVIDERS, model_routing: { planner: 'hosted:glm' } }), false, 'planning is not a hosted use');
  assert.equal(ok({ providers: PROVIDERS, model_routing: { build: 'local' } }), false, 'the local model doesn\'t build');
  assert.equal(ok({ providers: PROVIDERS, model_routing: { build_high_risk: 'hosted:glm' } }), false, 'never high-risk builds');
  assert.equal(ok({ providers: PROVIDERS, roles: { ...base.roles, evaluator: { enabled: true, model: 'hosted:glm' } } }), false, 'never the evaluator');
  assert.equal(ok({ providers: PROVIDERS, eval_routing: { cheap_model: 'local' } }), false, 'never tiered evaluation');
  assert.equal(ok({ providers: { local: { ...PROVIDERS.local, base_url: 'file:///x' } } }), false, 'an http(s) endpoint only');
  assert.equal(ok({ providers: { local: { ...PROVIDERS.local, gpu_lock: 'relative.lock' } } }), false, 'an absolute lock path');
  assert.equal(InstanceSettings.safeParse({ providers: { local: true, hosted: ['glm'] } }).success, true);
});

// ---- the fallback checks

function deps(o: { settings?: object; gate?: boolean; keys?: Record<string, string>; local?: object; fetch?: typeof fetch; lockHeld?: (p: string) => boolean | null } = {}) {
  const cfg = loadConfig(exampleProject().dir);
  cfg.agents = AgentsConfig.parse({ ...base, providers: { ...PROVIDERS, local: { ...PROVIDERS.local, ...(o.local ?? {}) } }, model_routing: { intake_replier: 'local', research: 'hosted:glm' } });
  const stateDir = mkdtempSync(join(tmpdir(), 'prov-state-'));
  if (o.gate !== false) {
    mkdirSync(join(stateDir, 'evals'), { recursive: true });
    const pass = { held_out: { passed: 20, total: 20 }, baseline: { passed: 19, total: 20 }, visible: { passed: 10, total: 10 }, samples: 3, at: '2026-10-12T00:00:00Z' };
    writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ 'intake-replier': { 'small-1': pass }, researcher: { 'glm-x': pass } }));
  }
  return { cfg, stateDir, settings: InstanceSettings.parse(o.settings ?? { providers: { local: true, hosted: ['glm'] } }), providerKeys: o.keys ?? { local: '/k/local', glm: '/k/glm' }, fetch: o.fetch ?? ((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch), ...(o.lockHeld ? { lockHeld: o.lockHeld } : {}) };
}
const replier = (over: Partial<RunRequest> = {}): RunRequest => ({ role: 'intake-replier', prompt: 'p', cwd: '/tmp', model: 'local', allowedTools: [], maxTurns: 2, maxBudgetUsd: 0.25, stallMs: 60_000, timeoutMs: 60_000, route: { kind: 'intake_replier', fallback: 'haiku' }, ...over });

test('a provider run goes to the provider only when every check passes: its model id, its endpoint and its key file', async () => {
  const r = await resolveProvider(replier(), deps());
  assert.equal(r.fellBack, null);
  assert.equal(r.req.model, 'small-1');
  assert.deepEqual(r.req.provider, { name: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:8080', keyFile: '/k/local' });
  const h = await resolveProvider({ ...replier(), role: 'researcher', model: 'hosted:glm', route: { kind: 'research', fallback: 'sonnet' } }, deps());
  assert.deepEqual([h.req.model, h.req.provider?.name, h.fellBack], ['glm-x', 'hosted:glm', null]);
  const plain = await resolveProvider({ ...replier(), model: 'sonnet' }, deps());
  assert.deepEqual([plain.req.model, plain.req.provider, plain.fellBack], ['sonnet', undefined, null], 'an Anthropic model is untouched');
});

test('otherwise it runs on its fallback, and says why: not opted in, no key, refused work, no passing eval, the GPU lock, the server down or slow', async () => {
  const why = async (req: RunRequest, d: ReturnType<typeof deps>) => {
    const r = await resolveProvider(req, d);
    assert.equal(r.req.provider, undefined);
    assert.equal(r.req.model, req.route?.fallback ?? 'sonnet');
    return r.fellBack!.reason;
  };
  assert.match(await why(replier(), deps({ settings: {} })), /hasn't opted into local/);
  assert.match(await why({ ...replier(), model: 'hosted:glm', role: 'researcher', route: { kind: 'research', fallback: 'sonnet' } }, deps({ settings: { providers: { local: true } } })), /hasn't opted into hosted:glm/);
  assert.match(await why(replier(), deps({ keys: {} })), /key \(local\) is not installed/);
  assert.match(await why({ ...replier(), model: 'hosted:glm', route: { kind: 'build', highRisk: true, fallback: 'opus' } }, deps()), /never build high-risk/);
  const { route: _noRoute, ...unrouted } = replier();
  assert.match(await why(unrouted, deps()), /has no route/);
  assert.match(await why(replier(), deps({ gate: false })), /no eval on small-1 on record/);
  assert.match(await why(replier(), deps({ local: { gpu_lock: '/run/lock/sim.lock' }, lockHeld: () => true })), /GPU lock \/run\/lock\/sim\.lock is held by another workload/);
  assert.match(await why(replier(), deps({ local: { gpu_lock: '/run/lock/sim.lock' }, lockHeld: () => null })), /can't be checked/, 'unknown counts as held: never contend');
  assert.match(await why(replier(), deps({ fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch })), /down or slow: unreachable: ECONNREFUSED/);
  assert.match(await why(replier(), deps({ fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch })), /answered 503/);
  const free = await resolveProvider(replier(), deps({ local: { gpu_lock: '/run/lock/sim.lock' }, lockHeld: () => false }));
  assert.equal(free.req.provider?.name, 'local', 'a free lock lets it run');
});

test('the eval gate: held-out not below the role\'s normal model, at 3 samples or more', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  mkdirSync(join(dir, 'evals'));
  const e = (held: number, samples = 3) => ({ held_out: { passed: held, total: 20 }, baseline: { passed: 19, total: 20 }, visible: { passed: 10, total: 10 }, samples, at: 'now' });
  writeFileSync(join(dir, PROVIDER_GATE_FILE), JSON.stringify({ r: { up: e(20), same: e(19), down: e(18), few: e(20, 1) } }));
  assert.equal(gatePasses(dir, 'r', 'up').ok, true);
  assert.equal(gatePasses(dir, 'r', 'same').ok, true);
  assert.match((gatePasses(dir, 'r', 'down') as { why: string }).why, /scored lower held-out/);
  assert.match((gatePasses(dir, 'r', 'few') as { why: string }).why, /1 sample/);
  assert.match((gatePasses(dir, 'r', 'none') as { why: string }).why, /no eval/);
});

test('health check: up and fast, or down: an error, a 5xx, or over the latency cap', async () => {
  let t = 0;
  const clock = () => t;
  const slow = (async () => ((t += 5000), new Response('{}'))) as unknown as typeof fetch;
  assert.deepEqual(await healthCheck({ base_url: 'http://127.0.0.1:1', latency_ms: 3000 }, slow, clock), { ok: false, why: 'answered in 5000 ms, over the 3000 ms cap' });
  const fast = (async () => new Response('{}')) as unknown as typeof fetch;
  assert.equal((await healthCheck({ base_url: 'http://127.0.0.1:1' }, fast)).ok, true);
});

// ---- the GPU lock, with a real flock held by a child process

test('the GPU lock: a flock another process holds is seen as held, without taking it; released, it is free', { skip: (!posix || !hasPerl) && 'POSIX flock via perl' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-lock-'));
  const lock = join(dir, 'sim.lock');
  writeFileSync(lock, '');
  assert.equal(flockHeld(lock), false, 'an existing, unlocked file is free');
  assert.equal(flockHeld(join(dir, 'missing.lock')), false);
  const child = spawn('perl', ['-e', 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 30', lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => d.toString().includes('held') && resolve()));
  try {
    assert.equal(flockHeld(lock), true, 'held by the child');
    assert.equal(flockHeld(lock), true, 'still held: checking never took it');
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
  assert.equal(flockHeld(lock), false, 'released');
});

// ---- the runner: no key in the environment, ever

function standIn() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-prov-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'auth') { fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'auth-called'), ''); console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'got.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.5, usage: { input_tokens: 1200, output_tokens: 300 }, duration_ms: 4200 }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 200);
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, got: () => JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8')) as { argv: string[]; env: Record<string, string> } };
}

test('a provider run: its endpoint in ANTHROPIC_BASE_URL, its key file only through apiKeyHelper, no key in the environment, no stored login', { skip: !posix && 'a POSIX stand-in for claude' }, async () => {
  const s = standIn();
  const env = { PATH: process.env.PATH ?? '', HOME: s.dir, CLAUDE_CONFIG_DIR: join(s.dir, 'login'), ANTHROPIC_API_KEY: 'sk-ant-' + 'z'.repeat(30), ANTHROPIC_AUTH_TOKEN: 'tok-' + 'w'.repeat(30) };
  const req: RunRequest = { role: 'researcher', prompt: 'p', cwd: s.dir, model: 'glm-x', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, provider: { name: 'hosted:glm', kind: 'hosted', baseUrl: 'https://open.example.com/anthropic', keyFile: '/home/user/.config/x-provider-keys/glm' } };
  const r = await new CliRunner('cli', env, s.bin).run(req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const got = s.got();
  assert.equal(got.env.ANTHROPIC_BASE_URL, 'https://open.example.com/anthropic');
  for (const k of Object.keys(got.env)) assert.ok(!/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/.test(k), `${k} must not reach the run`);
  assert.ok(!JSON.stringify(got.env).includes('z'.repeat(30)) && !JSON.stringify(got.env).includes('w'.repeat(30)), 'no key value anywhere in the environment');
  assert.notEqual(got.env.CLAUDE_CONFIG_DIR, join(s.dir, 'login'), 'not the stored login');
  const settings = JSON.parse(got.argv[got.argv.indexOf('--settings') + 1]!) as { apiKeyHelper?: string };
  assert.equal(settings.apiKeyHelper, 'cat -- /home/user/.config/x-provider-keys/glm');
  assert.equal(got.argv[got.argv.indexOf('--model') + 1], 'glm-x');
  assert.deepEqual([r.provider, r.tokens, r.durationMs], ['hosted:glm', { in: 1200, out: 300 }, 4200]);
  assert.throws(() => readFileSync(join(s.dir, 'auth-called')), 'no Claude-login preflight for a provider run');
  // An Anthropic run with the same runner: the login, no base URL, no helper.
  const a = standIn();
  const { provider: _p, ...anthropic } = req;
  await new CliRunner('cli', { ...env, HOME: a.dir }, a.bin).run({ ...anthropic, cwd: a.dir, model: 'sonnet' });
  assert.equal(a.got().env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(a.got().argv.includes('--settings'), false);
});

// ---- the hosted-change guard and usage

test('a change a hosted model built may not stand when it is L3, a money path, or agent instructions', () => {
  const review = loadConfig(exampleProject().dir).review!;
  const f = (path: string, addedLines: string[] = ['x']) => ({ path, added: addedLines.length, removed: 0, addedLines });
  const o = (files: ReturnType<typeof f>[], moneyPaths: RegExp[] = []) => hostedChangeRefusal({ files, labels: [], moneyPaths: () => moneyPaths, review });
  assert.equal(o([f('src/price.js')]), null, 'an easy change stands');
  assert.match(o([f('AGENTS.md')])!, /agent instructions/);
  assert.match(o([f('.claude/skills/triage/SKILL.md')])!, /agent instructions/);
  assert.match(o([f('src/billing/charge.js')], [/^src\/billing\//])!, /money path/);
  assert.match(o([f('db/migrate.sql', ['DROP TABLE orders;'])])!, /L3|money/);
});

test('usage: a local run costs nothing, a hosted one its configured prices; both show tokens and time per merged PR, on the panel data and in the weekly report', () => {
  assert.equal(providerCost('local', {}, { in: 1e6, out: 1e6 }), 0);
  assert.equal(providerCost('hosted', { usd_per_mtok_in: 1, usd_per_mtok_out: 2 }, { in: 500_000, out: 250_000 }), 1);
  assert.equal(providerCost('hosted', {}, { in: 1, out: 1 }), null, 'no prices: unknown');
  const at = (m: number) => new Date(Date.UTC(2026, 9, 12, 12, m)).toISOString();
  const events = [
    { type: 'merge.done', ts: at(1), payload: { issue: 1, number: 10, head: 'a'.repeat(40), sha: 'b'.repeat(40), url: 'u', title: 't' } },
    { type: 'run.cost', ts: at(2), payload: { issue: 1, role: 'worker', model: 'sonnet', usd: 2, turns: 1, tokens_in: 9000, tokens_out: 1000, secs: 120 } },
    { type: 'run.cost', ts: at(3), payload: { issue: null, role: 'intake-replier', model: 'small-1', provider: 'local', usd: 0, turns: 1, tokens_in: 3000, tokens_out: 500, secs: 30 } },
    { type: 'run.cost', ts: at(4), payload: { issue: 1, role: 'researcher', model: 'glm-x', provider: 'hosted:glm', usd: 0.25, turns: 1, tokens_in: 100_000, tokens_out: 20_000, secs: 300 } },
  ];
  const t = throughput(events, { now: new Date(Date.UTC(2026, 9, 13)) });
  assert.deepEqual(t.cost.byModel.map((m) => [m.model, m.usd, m.tokensIn + m.tokensOut, m.secs]), [['sonnet', 2, 10_000, 120], ['hosted:glm', 0.25, 120_000, 300], ['local', 0, 3500, 30]]);
  assert.equal(t.cost.byModel.find((m) => m.model === 'local')!.perMergedPrTokens, 3500);
  const md = throughputMarkdown(t).join('\n');
  assert.match(md, /- By model: sonnet ~\$2\.00\/PR \(10k tokens, 2 min\), hosted:glm ~\$0\.25\/PR \(120k tokens, 5 min\), local ~\$0\.00\/PR \(4k tokens, 1 min\)\./);
});

test('a local endpoint answers the health check over real HTTP', { skip: !posix && 'loopback HTTP' }, async () => {
  const server = createServer((_, res) => res.writeHead(200).end('{}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await healthCheck({ base_url: `http://127.0.0.1:${port}` })).ok, true);
  } finally {
    server.close();
  }
  assert.equal((await healthCheck({ base_url: `http://127.0.0.1:${port}`, latency_ms: 500 })).ok, false, 'closed: down');
});

// ---- wired: the coordinator's runner resolves the provider, records the fallback and the usage, and never caps a provider run

test('wired: a provider run falls back with an event when it may not run, goes to the provider when it may, and is never capped', { skip: !posix && 'loopback HTTP' }, async () => {
  const server = createServer((_, res) => res.writeHead(200).end('{}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const { dir, stateDir } = exampleProject();
    const cfg = loadConfig(dir);
    cfg.agents = AgentsConfig.parse({ ...base, providers: { local: { ...PROVIDERS.local, base_url: `http://127.0.0.1:${port}` } }, model_routing: { intake_replier: 'local' } });
    const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'prov-log-')), 'events.db'));
    const runner = new FakeRunner((req) => ({ costUsd: 0.4, ...(req.provider ? { provider: req.provider.name, tokens: { in: 800, out: 120 }, durationMs: 2500 } : {}) }));
    const slotsDir = mkdtempSync(join(tmpdir(), 'prov-slots-'));
    let settings: object = { model_cap: 'haiku' };
    const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(stateDir, 'b.json'), 'c'), runner, repo: dir, instance: 'alice', stateDir, slotsDir, providerKeys: { local: '/k/local' }, settings: () => ({ settings: InstanceSettings.parse(settings), error: null }), machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
    const run = (c as unknown as { d: { runner: FakeRunner } }).d.runner;
    // Not opted in: the fallback, capped as any Anthropic run is, with the reason recorded.
    const r1 = await run.run(replier({ route: { kind: 'intake_replier', fallback: 'sonnet' } }));
    assert.equal(runner.calls.at(-1)!.model, 'haiku', 'the fallback, under the cap');
    assert.equal(r1.provider, undefined);
    const fb = log.read(0, ['provider.fallback']).map((e) => e.payload as { role: string; provider: string; reason: string; model: string });
    assert.deepEqual(fb.map((p) => [p.role, p.provider, p.model]), [['intake-replier', 'local', 'sonnet']]);
    assert.match(fb[0]!.reason, /hasn't opted into local/);
    // Opted in, with a passing eval: the provider's model id, uncapped, its usage recorded at no cost.
    settings = { model_cap: 'haiku', providers: { local: true } };
    mkdirSync(join(stateDir, 'evals'), { recursive: true });
    writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ 'intake-replier': { 'small-1': { held_out: { passed: 22, total: 23 }, baseline: { passed: 19, total: 23 }, visible: { passed: 28, total: 28 }, samples: 3, at: 'now' } } }));
    const r2 = await run.run(replier());
    assert.deepEqual([runner.calls.at(-1)!.model, runner.calls.at(-1)!.provider?.name, r2.provider], ['small-1', 'local', 'local']);
    (c as unknown as { cost: (i: number | null, role: string, r: unknown) => void }).cost(null, 'intake-replier', r2);
    assert.deepEqual(log.read(0, ['run.cost']).at(-1)!.payload, { issue: null, role: 'intake-replier', model: 'small-1', usd: 0, turns: 1, provider: 'local', tokens_in: 800, tokens_out: 120, secs: 2.5 });
  } finally {
    server.close();
  }
});

// ---- hosted models count against the instance's model cap, by their declared price tier

test('the cap: a hosted model above it never runs (it falls back, then the cap applies to the fallback); at or under it, it runs', async () => {
  const hosted = (tier: string | null, cap?: string) => {
    const d = deps({ settings: { providers: { local: true, hosted: ['glm'] }, ...(cap ? { model_cap: cap } : {}) } });
    const glm = { ...PROVIDERS.hosted.glm, ...(tier ? { tier } : {}) };
    if (!tier) delete (glm as { tier?: string }).tier;
    d.cfg.agents = AgentsConfig.parse({ ...base, providers: { ...PROVIDERS, hosted: { glm } }, model_routing: { research: 'hosted:glm' } });
    return resolveProvider({ ...replier(), role: 'researcher', model: 'hosted:glm', route: { kind: 'research', fallback: 'sonnet' } }, d);
  };
  const above = await hosted('opus', 'sonnet');
  assert.equal(above.req.provider, undefined, 'never on the provider');
  assert.equal(above.req.model, 'sonnet', 'its fallback');
  assert.match(above.fellBack!.reason, /price tier \(opus\) is above this instance's model cap \(sonnet\)/);
  assert.equal((await hosted('sonnet', 'sonnet')).req.provider?.name, 'hosted:glm', 'at the cap: runs');
  assert.equal((await hosted('haiku', 'sonnet')).req.provider?.name, 'hosted:glm', 'under the cap: runs');
  assert.equal((await hosted('opus')).req.provider?.name, 'hosted:glm', 'no cap: runs');
  const none = await hosted(null);
  assert.equal(none.req.provider, undefined);
  assert.match(none.fellBack!.reason, /no price tier declared/);
  assert.equal(AgentsConfig.safeParse({ ...base, providers: { hosted: { glm: { ...PROVIDERS.hosted.glm, tier: 'gold' } } } }).success, false, 'a tier is haiku, sonnet or opus');
});

test('wired: a hosted model above the cap runs as the cap does for Anthropic models: on the capped fallback, recorded', async () => {
  const { dir, stateDir } = exampleProject();
  const cfg = loadConfig(dir);
  cfg.agents = AgentsConfig.parse({ ...base, providers: { hosted: { glm: { ...PROVIDERS.hosted.glm, tier: 'opus' } } }, model_routing: { research: 'hosted:glm' } });
  mkdirSync(join(stateDir, 'evals'), { recursive: true });
  writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ researcher: { 'glm-x': { held_out: { passed: 20, total: 20 }, baseline: { passed: 20, total: 20 }, visible: { passed: 12, total: 12 }, samples: 3, at: 'now' } } }));
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'prov-cap-')), 'events.db'));
  const runner = new FakeRunner(() => ({}));
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(stateDir, 'b.json'), 'c'), runner, repo: dir, instance: 'alice', stateDir, slotsDir: mkdtempSync(join(tmpdir(), 'prov-slots-')), providerKeys: { glm: '/k/glm' }, settings: () => ({ settings: InstanceSettings.parse({ model_cap: 'haiku', providers: { hosted: ['glm'] } }), error: null }), machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await (c as unknown as { d: { runner: FakeRunner } }).d.runner.run({ ...replier(), role: 'researcher', model: 'hosted:glm', route: { kind: 'research', fallback: 'sonnet' } });
  assert.equal(runner.calls.at(-1)!.provider, undefined, 'not the hosted model');
  assert.equal(runner.calls.at(-1)!.model, 'haiku', 'the fallback, capped');
  assert.match((log.read(0, ['provider.fallback']).at(-1)!.payload as { reason: string }).reason, /above this instance's model cap \(haiku\)/);
});

// ---- a provider's usage or rate limit (src/usage-limit.ts): skipped until its reset, the run redone on its fallback

test('a provider that hit its usage or rate limit is skipped until its reset: its runs take their fallback, saying why', async () => {
  const until = '2026-10-13T15:00:00.000Z';
  const d = { ...deps(), limited: (label: string) => (label === 'hosted:glm' ? until : null) };
  const r = await resolveProvider({ ...replier(), role: 'researcher', model: 'hosted:glm', route: { kind: 'research', fallback: 'sonnet' } }, d);
  assert.equal(r.req.provider, undefined);
  assert.equal(r.req.model, 'sonnet');
  assert.equal(r.fellBack!.reason, `hosted:glm hit its usage or rate limit; skipped until ${until}`);
  assert.equal((await resolveProvider(replier(), d)).req.provider?.name, 'local', "another provider's limit is not this one's");
});

test("wired: a hosted provider's 429 never pauses the instance: the run is redone at once on its fallback, and the provider is skipped until its reset; Anthropic's limit pauses", async () => {
  const { dir, stateDir } = exampleProject();
  const cfg = loadConfig(dir);
  cfg.agents = AgentsConfig.parse({ ...base, providers: { hosted: { glm: PROVIDERS.hosted.glm } }, model_routing: { research: 'hosted:glm' } });
  mkdirSync(join(stateDir, 'evals'), { recursive: true });
  writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ researcher: { 'glm-x': { held_out: { passed: 20, total: 20 }, baseline: { passed: 20, total: 20 }, visible: { passed: 12, total: 12 }, samples: 3, at: 'now' } } }));
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'prov-limit-')), 'events.db'));
  const reset = new Date(Date.now() + 3600_000).toISOString();
  let anthropicLimited = false;
  const runner = new FakeRunner((req) => (req.provider || anthropicLimited ? { reason: 'rate_limited', detail: 'usage or rate limit reached: API Error: 429', limit: { resetAt: reset, source: 'claude', kind: null } } : { detail: 'answered' }));
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(stateDir, 'b.json'), 'c'), runner, repo: dir, instance: 'alice', stateDir, slotsDir: mkdtempSync(join(tmpdir(), 'prov-slots-')), providerKeys: { glm: '/k/glm' }, settings: () => ({ settings: InstanceSettings.parse({ providers: { hosted: ['glm'] } }), error: null }), machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  const run = (c as unknown as { d: { runner: FakeRunner } }).d.runner;
  const research = { ...replier(), role: 'researcher', model: 'hosted:glm', route: { kind: 'research' as const, fallback: 'sonnet' } };
  const r1 = await run.run(research);
  assert.equal(r1.reason, 'succeeded', "the caller gets the fallback's answer");
  assert.deepEqual(runner.calls.map((x) => [x.model, x.provider?.name ?? null]), [['glm-x', 'hosted:glm'], ['sonnet', null]], 'once on the provider, then at once on the fallback');
  assert.equal(log.read(0, ['usage.paused']).length, 0, "a provider's limit never pauses the instance");
  const hit = log.read(0, ['usage.limit_hit']).map((e) => e.payload as { provider: string | null; reset_at: string });
  assert.deepEqual(hit.map((h) => [h.provider, h.reset_at]), [['hosted:glm', reset]]);
  // Until its reset, the provider isn't tried at all.
  await run.run(research);
  assert.deepEqual(runner.calls.slice(2).map((x) => [x.model, x.provider?.name ?? null]), [['sonnet', null]]);
  assert.match((log.read(0, ['provider.fallback']).at(-1)!.payload as { reason: string }).reason, /hosted:glm hit its usage or rate limit; skipped until/);
  // The Claude login's own limit: the run's caller is told to stop (a pause), and the next run never starts.
  anthropicLimited = true;
  await assert.rejects(run.run({ ...replier(), model: 'sonnet' }), /paused on the Claude usage limit until/);
  const calls = runner.calls.length;
  await assert.rejects(run.run({ ...replier(), model: 'sonnet' }), /paused on the Claude usage limit until/);
  assert.equal(runner.calls.length, calls, 'nothing starts while paused');
  assert.equal(log.read(0, ['usage.paused']).length, 1);
});

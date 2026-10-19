// The gated-merge benchmark (#748, Phase 0). No model call, no Docker, no download: claude is a stand-in script that
// answers with the CLI's own JSON shapes (auth status, --version, stream-json, a usage-limit result), and every path
// is under this test's temporary machine (test/isolate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRunner, type RunRequest } from '../src/runner.js';
import { benchClaude, benchLane } from '../scripts/bench/agent.js';
import { agentBase, BENCH_USER_ENV, BenchAgentRunner, CLAUDE_PIN_ENV, requireBenchUser, requireClaudePin, requireSubscription } from '../scripts/bench/auth.js';
import { capsFromArgs, type Caps } from '../scripts/bench/caps.js';
import { checkDockerArgs, Docker, LIMIT_ENV, limitsFrom, LimitsNotApplied, makeArgs, TaskRunner, type DockerCall, type Limits } from '../scripts/bench/container.js';
import { taskView, type TaskRow } from '../scripts/bench/hidden.js';
import { benchLayout, benchRoot, BENCH_ROOT_ENV } from '../scripts/bench/paths.js';
import { UsageMeter } from '../scripts/bench/usage.js';
import { STDIN_LINE } from './helpers.js';

const posix = { skip: process.platform === 'win32' && 'POSIX stand-ins' };

const CAPS: Caps = { mode: 'smoke', spendUsd: 40, perTaskUsd: 15 };

/** A call the stand-in claude recorded. */
interface ClaudeCall {
  kind: 'version' | 'auth' | 'run';
  args: string[];
  env: Record<string, string>;
  settings: { sandbox?: { filesystem?: { denyRead?: string[] } } };
}

interface FakeClaude {
  /** claude auth status --json's answer. */
  auth?: object;
  version?: string;
  /** What a session ends with: a success, or the CLI's usage-limit shape. */
  run?: 'ok' | 'limit';
}

/** A stand-in claude in a fresh folder, and what it was asked. */
function fakeClaude(o: FakeClaude = {}) {
  const base = mkdtempSync(join(tmpdir(), 'bench-'));
  const bin = join(base, 'bin', 'claude');
  mkdirSync(join(base, 'bin'));
  const log = join(base, 'claude-calls.jsonl');
  const result =
    o.run === 'limit'
      ? [
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } },
          { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", num_turns: 2, total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 20 } },
        ]
      : [{ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 4, total_cost_usd: 1.25, usage: { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 5000 } }];
  // The owner's machine's shape (2026-10-18): a claude.ai login on an enterprise plan.
  const auth = o.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'enterprise' };
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      `const log = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + '\\n');`,
      "if (args[0] === '--version') { log({ kind: 'version', args, env: process.env }); console.log(" + JSON.stringify(`${o.version ?? '2.1.303'} (Claude Code)`) + '); process.exit(0); }',
      `if (args[0] === 'auth') { log({ kind: 'auth', args, env: process.env }); console.log(${JSON.stringify(JSON.stringify(auth))}); process.exit(0); }`,
      `const input = ${STDIN_LINE};`,
      "const at = args.indexOf('--settings');",
      'const settings = at >= 0 ? JSON.parse(args[at + 1]) : {};',
      "log({ kind: 'run', args, env: process.env, settings, input });",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', output_style: settings.outputStyle }));",
      `for (const l of ${JSON.stringify(result)}) console.log(JSON.stringify(l));`,
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  const calls = (kind?: ClaudeCall['kind']) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ClaudeCall) : []).filter((c) => !kind || c.kind === kind);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  return { base, bin, env, calls };
}

/** One agent run's request, as the engine makes it. */
const runReq =(cwd: string, signal?: AbortSignal, role = 'worker'): RunRequest => ({ role, prompt: 'fix the totals', cwd, model: 'sonnet', allowedTools: ['Read'], maxTurns: 10, maxBudgetUsd: 10, stallMs: 30_000, timeoutMs: 60_000, ...(signal ? { signal } : {}) });

test('acceptance: no run starts without a spend cap, and no cap over the owner approval', () => {
  const refused = capsFromArgs(['--tasks', 'smoke'], () => ['plan: 4 tasks']);
  assert.ok('refused' in refused && /--spend <usd>/.test(refused.refused), 'no --spend: the gate prints its plan and stops');
  assert.throws(() => capsFromArgs(['--spend', '41'], () => []), /over the approved \$40/);
  assert.throws(() => capsFromArgs(['--tasks', 'baseline', '--spend', '301'], () => [], 3), /over the approved \$300/);
  assert.throws(() => capsFromArgs(['--spend', '40', '--per-task-cap', '16'], () => []), /over the approved \$15/);
  assert.throws(() => capsFromArgs(['--spend', '10', '--per-task-cap', '12'], () => []), /over --spend 10/);
  assert.throws(() => capsFromArgs(['--spend=40'], () => []), /with a space/);
  assert.throws(() => capsFromArgs(['--tasks', 'baseline', '--spend', '300'], () => []), /finished smoke round first/);
  assert.throws(() => capsFromArgs(['--tasks', 'baseline', '--spend', '300'], () => [], 9.5), /re-approves/);
  assert.deepEqual(capsFromArgs(['--tasks', 'baseline', '--spend', '300', '--owner-reapproved'], () => [], 9.5), { mode: 'baseline', spendUsd: 300, perTaskUsd: 15 });
  assert.deepEqual(capsFromArgs(['--spend', '40'], () => []), CAPS);
});

test('acceptance: only a subscription login is accepted, whatever its plan; an API key or cloud provider is refused', posix, () => {
  for (const auth of [{ loggedIn: true, authMethod: 'api_key' }, { loggedIn: true, authMethod: 'api_key_helper' }, { loggedIn: false }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, { unexpected: true }]) {
    const c = fakeClaude({ auth });
    assert.throws(() => requireSubscription(c.env, c.bin), /not a subscription login|not Anthropic's own/, JSON.stringify(auth));
  }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    const c = fakeClaude();
    assert.throws(() => requireSubscription({ ...c.env, [k]: '1' }, c.bin), new RegExp(`${k} set`));
    assert.equal(c.calls().length, 0, `${k}: claude not even asked`);
  }
  // This machine's shape: a claude.ai login on an enterprise plan; the plan is recorded, never checked.
  const c = fakeClaude();
  assert.deepEqual(requireSubscription(c.env, c.bin), { method: 'claude.ai', subscription_type: 'enterprise' });
  for (const auth of [{ loggedIn: true, authMethod: 'oauth_token', subscriptionType: 'team' }, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }, { loggedIn: true, authMethod: 'claude.ai' }]) {
    const f = fakeClaude({ auth });
    assert.equal(requireSubscription(f.env, f.bin).method, auth.authMethod);
  }
});

test('the bench runs only as its own user, on the pinned CLI, with updates off for every claude it starts', posix, async () => {
  assert.throws(() => requireBenchUser({ [BENCH_USER_ENV]: 'wl-bench' }, 'someone-else'), /runs as wl-bench only/);
  assert.throws(() => requireBenchUser({}, 'someone-else'), /runs as wl-bench only/);
  assert.equal(requireBenchUser({ [BENCH_USER_ENV]: 'bench-two' }, 'bench-two'), 'bench-two');
  const old = fakeClaude({ version: '2.1.302' });
  assert.throws(() => requireClaudePin(old.env, old.bin), /2\.1\.302, not the pinned 2\.1\.303/);
  assert.equal(requireClaudePin({ ...old.env, [CLAUDE_PIN_ENV]: '2.1.302' }, old.bin), '2.1.302');
  const c = fakeClaude();
  assert.equal(requireClaudePin(c.env, c.bin), '2.1.303');
  requireSubscription(c.env, c.bin);
  await new BenchAgentRunner(new CliRunner('cli', c.env, c.bin)).run(runReq(c.base));
  assert.deepEqual(c.calls().map((x) => x.kind), ['version', 'auth', 'auth', 'run'], "the pin, the bench's check, the runner's own check, the run");
  for (const x of c.calls()) assert.equal(x.env.DISABLE_UPDATES, '1', `${x.kind}: DISABLE_UPDATES`);
});

test('acceptance: at a usage limit the meter stops cleanly: no retry, no later run, every task aborted', posix, async () => {
  const c = fakeClaude({ run: 'limit' });
  const meter = new UsageMeter(new BenchAgentRunner(new CliRunner('cli', c.env, c.bin)), 40);
  const first = meter.task(15);
  const r = await first.run(runReq(c.base));
  assert.equal(r.reason, 'rate_limited');
  assert.equal(c.calls('run').length, 1);
  assert.ok(meter.signal.aborted, 'every task in flight is told to stop');
  assert.match(meter.limited!.detail, /usage or rate limit/);
  assert.match(meter.limited!.reset_at ?? '', /^\d{4}-\d\d-\d\dT/, 'when claude said it resets (the engine reads it)');
  // The same task's next run and another task's: refused unstarted.
  for (const t of [first, meter.task(15)]) {
    const again = await t.run(runReq(c.base, undefined, 'evaluator'));
    assert.equal(again.reason, 'rate_limited');
    assert.match(again.detail, /not started: the bench stopped at a usage limit/);
  }
  assert.equal(c.calls('run').length, 1, 'one session in all: no retry');
  assert.deepEqual(first.runs.map((u) => [u.role, u.reason, u.usage_equivalent_usd, u.tokens_in, u.tokens_out]), [['worker', 'rate_limited', 0.42, 100, 20]], "the CLI's own usage, recorded");
  assert.equal(meter.spent, 0.42);
});

test("usage is the CLI's own accounting, capped per task and for the whole run", posix, async () => {
  const c = fakeClaude();
  const meter = new UsageMeter(new BenchAgentRunner(new CliRunner('cli', c.env, c.bin)), 3);
  const t = meter.task(2);
  const caps: number[] = [];
  const spy = new UsageMeter({ run: async (req) => (caps.push(req.maxBudgetUsd), { reason: 'succeeded', detail: '', costUsd: 1.25, turns: 1, model: req.model }) }, 3).task(2);
  await spy.run(runReq(c.base));
  await spy.run(runReq(c.base));
  assert.deepEqual(caps, [2, 0.75], 'each run is cut to what is left of its task cap');
  assert.equal((await spy.run(runReq(c.base))).reason, 'budget_exhausted', 'nothing left: not started');
  assert.equal(spy.capHit, true);
  assert.equal((await t.run(runReq(c.base))).reason, 'succeeded');
  assert.deepEqual(t.runs.map((u) => [u.usage_equivalent_usd, u.turns, u.tokens_in, u.tokens_out]), [[1.25, 4, 5900, 80]]);
  assert.equal(meter.left, 1.75);
});

test('the bench root stays out of credential stores, real state and checkouts', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  assert.equal(benchRoot({}, home).root, join(home, 'bench'));
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, '.claude', 'bench') }, home), /overlaps/);
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: 'bench' }, home), /absolute/);
  mkdirSync(join(home, 'clone', '.git'), { recursive: true });
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, 'clone', 'bench') }, home), /inside a git checkout/);
});

/** A row whose hidden fields carry markers no visible text has. */
const ROW: TaskRow = {
  instance_id: 'example__proj-4242',
  repo: 'example/proj',
  base_commit: 'a'.repeat(40),
  problem_statement: 'Totals are wrong for negative quantities\n\nCalling total() with a negative qty returns a negative sum.',
  patch: 'diff --git a/src/price.py b/src/price.py\n-    return sum(c * q for c, q in items)\n+    return sum(c * q for c, q in items if q > 0)  # GOLDMARK_7731\n',
  test_patch: 'diff --git a/tests/test_price.py b/tests/test_price.py\n+def test_negative_quantities_are_skipped_TESTMARK():\n+    assert total([(5, -1)]) == 0\n',
  FAIL_TO_PASS: JSON.stringify(['tests/test_price.py::test_negative_quantities_are_skipped_TESTMARK']),
  PASS_TO_PASS: JSON.stringify(['tests/test_price.py::test_plain_totals_PASSMARK']),
  hints_text: 'HINTMARK: look at the generator in price.py',
  difficulty: '<15 min fix',
};
const MARKS = ['GOLDMARK_7731', 'TESTMARK', 'PASSMARK', 'HINTMARK', 'example__proj-4242'];
const HOST = { cpus: 16, memoryBytes: 39 * 1024 ** 3 };
const LIMITS: Limits = limitsFrom({}, HOST);
const C = { name: 'bench-r1-t01', image: 'swebench/example:latest' };

interface FakeDocker {
  rootless?: boolean;
  /** Which limit the daemon (inspect) or the kernel (the cgroup files) didn't apply. */
  dropped?: 'inspect-memory' | 'inspect-cpu' | 'cgroup-memory' | 'cgroup-pids';
}

/** An in-process docker that records every command and answers info, inspect and the cgroup files. */
function fakeDocker(o: FakeDocker = {}) {
  const sent: { args: string[]; input: string }[] = [];
  const call: DockerCall = (_bin, args, opt) => {
    sent.push({ args: [...args], input: opt.input?.toString('utf8') ?? '' });
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'info') return ok(JSON.stringify(['name=seccomp,profile=builtin', ...(o.rootless === false ? [] : ['name=rootless']), 'name=cgroupns']));
    if (args[0] === 'inspect') {
      const mem = o.dropped === 'inspect-memory' ? 0 : LIMITS.memoryBytes;
      return ok(JSON.stringify({ Memory: mem, MemorySwap: mem, NanoCpus: o.dropped === 'inspect-cpu' ? 0 : LIMITS.cpus * 1e9, PidsLimit: LIMITS.pids, NetworkMode: 'none' }));
    }
    if (args[0] === 'exec' && args.includes('/sys/fs/cgroup/memory.max')) {
      return ok(`${o.dropped === 'cgroup-memory' ? 'max' : LIMITS.memoryBytes}\n${LIMITS.cpus * 100000} 100000\n${o.dropped === 'cgroup-pids' ? 'max' : LIMITS.pids}\n`);
    }
    return ok();
  };
  return { sent, opts: { docker: 'docker', call } };
}

test("an agent gets neither the Docker socket nor the daemon's or bus's variables, and its CLI never updates", posix, async () => {
  const c = fakeClaude();
  const runtime = join(c.base, 'run-user');
  const layout = benchLayout(join(c.base, 'bench'));
  // The bench user's shell as the README sets it up: the daemon and the user bus are reachable from it.
  const env = { ...c.env, XDG_RUNTIME_DIR: runtime, DOCKER_HOST: `unix://${runtime}/docker.sock`, DOCKER_CONFIG: join(c.base, 'docker'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  const agents = benchClaude(env, c.bin, benchLane({ home: process.env.HOME!, runtimeDir: runtime, heldOut: layout.heldOut, state: layout.state }));
  assert.equal((await agents.run({ ...runReq(c.base), env: { DOCKER_HOST: 'unix:///elsewhere' } })).reason, 'succeeded');
  requireSubscription(env, c.bin);
  requireClaudePin(env, c.bin);
  assert.deepEqual(c.calls().map((x) => x.kind).sort(), ['auth', 'auth', 'run', 'version']);
  for (const x of c.calls()) {
    for (const k of ['DOCKER_HOST', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) assert.equal(x.env[k], undefined, `${x.kind}: ${k}`);
    assert.equal(x.env.DISABLE_UPDATES, '1', `${x.kind}: DISABLE_UPDATES`);
  }
  const deny = c.calls('run')[0]!.settings.sandbox?.filesystem?.denyRead ?? [];
  for (const p of [runtime, join(runtime, 'docker.sock'), '/run/docker.sock', '/var/run/docker.sock', join(process.env.HOME!, '.claude'), join(process.env.HOME!, '.claude.json'), layout.heldOut]) assert.ok(deny.includes(p), `sandbox denies ${p}`);
  assert.equal(agentBase(env).XDG_RUNTIME_DIR, undefined);
});

test('the task runner sends docker exec into its own container only, with no mount flag; containers mount nothing', () => {
  checkDockerArgs(['exec', '--workdir', '/work/t', 'bench-r1-t01', 'python', '-m', 'pytest', '-v', 'x.py'], ['exec']);
  for (const bad of [
    ['run', '--network', 'none', 'img'],
    ['create', '--network', 'none', 'img'],
    ['cp', 'x', 'bench-r1-t01:/x'],
    ['rm', '--force', 'bench-r1-t01'],
    ['exec', '-v', '/home:/h', 'bench-r1-t01', 'ls'],
    ['exec', '--volume', '/home:/h', 'bench-r1-t01', 'ls'],
    ['exec', '--mount', 'type=bind,src=/,dst=/h', 'bench-r1-t01', 'ls'],
    ['exec', '--privileged', 'bench-r1-t01', 'ls'],
    ['exec', '--user', '0', 'bench-r1-t01', 'ls'],
    ['exec', '--env', 'DOCKER_HOST=unix:///x', 'bench-r1-t01', 'ls'],
    ['exec', '--workdir', '/', 'bench-r1-t01', 'ls'],
    ['exec', '--workdir', '/work', 'someone-else', 'ls'],
  ]) assert.throws(() => checkDockerArgs(bad, ['exec']), /refused|only/, bad.join(' '));
  for (const verb of ['create', 'run'] as const) {
    const make = makeArgs(verb, C, LIMITS);
    checkDockerArgs(make);
    assert.ok(make.join(' ').includes('--network none'));
    assert.ok(!make.some((a) => /^(-v|--volume|--mount|--privileged|--device|--cap-add)/.test(a)), 'no mount, device or privilege');
    for (const extra of [['--mount', 'type=bind,src=/home,dst=/h'], ['-v', '/home:/h'], ['--privileged'], ['--network', 'host'], ['--network=bridge']]) {
      assert.throws(() => checkDockerArgs([make[0]!, ...extra, ...make.slice(1)]), /refused/, extra.join(' '));
    }
    for (const limit of ['--memory', '--memory-swap', '--cpus', '--pids-limit']) {
      const i = make.indexOf(limit);
      assert.throws(() => checkDockerArgs([...make.slice(0, i), ...make.slice(i + 2)]), new RegExp(`without ${limit}`));
    }
  }
  const d = fakeDocker();
  new TaskRunner(d.opts, C, ROW).syncTree('/work/t', Buffer.from('tar'));
  assert.deepEqual(d.sent[0]!.args.slice(0, 5), ['exec', '--interactive', '--workdir', '/work', 'bench-r1-t01']);
});

test('the Docker daemon must be rootless', () => {
  assert.throws(() => new Docker(fakeDocker({ rootless: false }).opts, LIMITS).preflight(), /not rootless/);
  new Docker(fakeDocker().opts, LIMITS).preflight();
});

test('every container gets memory (no extra swap), CPU and pids limits, read back from the daemon and its own cgroup', () => {
  assert.deepEqual(LIMITS, { memoryBytes: 8 * 1024 ** 3, cpus: 4, pids: 4096 });
  const d = fakeDocker();
  const docker = new Docker(d.opts, LIMITS);
  docker.probe({ ...C, name: 'bench-r1-probe' });
  assert.deepEqual(d.sent.map((s) => s.args[0]), ['create', 'inspect', 'start', 'inspect', 'exec', 'rm'], 'created, read back, started, read back from its cgroup, removed');
  docker.start(C, ROW);
  assert.deepEqual(d.sent.slice(6).map((s) => s.args[0]), ['run', 'inspect', 'exec'], "a task's container is read back before anything runs in it");
  for (const s of d.sent.filter((x) => x.args[0] === 'create' || x.args[0] === 'run')) {
    const a = s.args.join(' ');
    for (const f of [`--memory ${LIMITS.memoryBytes}b`, `--memory-swap ${LIMITS.memoryBytes}b`, '--cpus 4', '--pids-limit 4096']) assert.ok(a.includes(f), `${s.args[0]} has ${f}`);
  }
});

test('a limit that did not apply refuses, naming the controller; the limits are required', () => {
  for (const [dropped, controller] of [['inspect-memory', 'memory'], ['inspect-cpu', 'cpu'], ['cgroup-memory', 'memory \\(memory.max\\)'], ['cgroup-pids', 'pids \\(pids.max\\)']] as const) {
    const d = fakeDocker({ dropped });
    const docker = new Docker(d.opts, LIMITS);
    assert.throws(() => docker.probe({ ...C, name: 'bench-r1-probe' }), (e: Error) => e instanceof LimitsNotApplied && new RegExp(`${controller}.*limit did not apply.*Delegate= drop-in`).test(e.message), dropped);
    assert.equal(d.sent.at(-1)!.args[0], 'rm', `${dropped}: the probe container is removed`);
    assert.throws(() => docker.start(C, ROW), LimitsNotApplied, `${dropped}: a task's container too`);
  }
  for (const [k, v, why] of [['memory', '0', /memory limit/], ['cpus', '0', /CPU limit/], ['pids', '', /pids limit/], ['cpus', '17', /over this machine's 16 CPUs/], ['memory', '32g', /over 75%/]] as const) {
    assert.throws(() => limitsFrom({ [LIMIT_ENV[k]]: v }, HOST), why);
  }
  assert.deepEqual(limitsFrom({ [LIMIT_ENV.memory]: '4g', [LIMIT_ENV.cpus]: '2', [LIMIT_ENV.pids]: '512' }, HOST), { memoryBytes: 4 * 1024 ** 3, cpus: 2, pids: 512 });
});

test('acceptance: the hidden fields never reach a container', () => {
  const view = JSON.stringify(taskView(ROW, 't01'));
  for (const mark of MARKS) assert.ok(!view.includes(mark), `the task view has no ${mark}`);
  const d = fakeDocker();
  const docker = new Docker(d.opts, LIMITS);
  docker.start(C, ROW);
  const r = new TaskRunner(d.opts, C, ROW);
  // A buggy caller that hands the container a hidden test name, or the gold line in a variable: refused, nothing sent.
  const before = d.sent.length;
  assert.throws(() => r.exec('/work/t', ['python', '-m', 'pytest', 'tests/test_price.py::test_negative_quantities_are_skipped_TESTMARK']), /hidden FAIL_TO_PASS/);
  assert.throws(() => r.exec('/work/t', ['true'], { FIX: 'return sum(c * q for c, q in items if q > 0)  # GOLDMARK_7731' }), /hidden patch/);
  assert.throws(() => r.exec('/work/t', ['echo', 'example__proj-4242']), /hidden instance_id/);
  assert.equal(d.sent.length, before, 'nothing reached docker');
  r.exec('/work/t', ['python', '-m', 'pytest', '-v', 'tests/test_price.py']);
  assert.equal(d.sent.length, before + 1, 'the honest command went through');
  const seen = JSON.stringify(d.sent);
  for (const mark of MARKS) assert.ok(!seen.includes(mark), `no docker command carried ${mark}`);
});

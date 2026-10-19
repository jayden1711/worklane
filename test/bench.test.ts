// The gated-merge benchmark (#748, Phase 0). No model call, no Docker, no download: claude is a stand-in script that
// answers with the CLI's own JSON shapes (auth status, --version, stream-json, a usage-limit result), and every path
// is under this test's temporary machine (test/isolate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { HELD_OUT_ENV } from '../src/held-out-paths.js';
import type { InstanceSettings } from '../src/instance.js';
import { currentUser } from '../src/os/index.js';
import { CliRunner, type RetryOptions, type RunRequest } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';
import { aggregate, wilson } from '../scripts/bench/aggregate.js';
import { assertResearchOff, BENCH_SETTINGS, runBench, type BenchOptions, type RunTask, type TaskResult } from '../scripts/bench/driver.js';
import { readPatches, writePredictions } from '../scripts/bench/grade.js';
import { MANIFEST, writeStore } from '../scripts/bench/store.js';
import { benchClaude, benchDenied, benchLane } from '../scripts/bench/agent.js';
import { sandboxProbe, type ProbeReport } from '../scripts/bench/probe.js';
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

/**
 * `claude auth status --json` as the real 2.1.303 prints it (measured 2026-10-18: the pinned CLI, a throwaway HOME and
 * CLAUDE_CONFIG_DIR, no login, no model call). `kind`:
 * - none: no login (measured);
 * - oauth_token: what CLAUDE_CODE_OAUTH_TOKEN, and federation (ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID),
 *   each give (measured);
 * - api_key: ANTHROPIC_API_KEY (measured); third_party: CLAUDE_CODE_USE_BEDROCK (measured);
 * - claude.ai: the same fields plus the four the CLI adds only for a claude.ai login (email, orgId, orgName,
 *   subscriptionType; inferred from the CLI's status code, not run: no real login is ever used here).
 */
function authStatus(home: string, kind: 'none' | 'claude.ai' | 'oauth_token' | 'api_key' | 'third_party', extra: object = {}): object {
  const dirs = { analyticsDisabled: true, projectsDirectory: join(home, '.claude', 'projects'), configDirectory: join(home, '.claude') };
  const shapes = {
    none: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', ...dirs },
    'claude.ai': { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...dirs, email: 'bench@example.com', orgId: 'org-1', orgName: 'Example', subscriptionType: 'enterprise' },
    oauth_token: { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', ...dirs },
    api_key: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', ...dirs, apiKeySource: 'ANTHROPIC_API_KEY' },
    third_party: { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock', ...dirs },
  };
  return { ...shapes[kind], ...extra };
}

interface FakeClaude {
  /** claude auth status --json's answer (a string: printed as is); default a claude.ai login on an enterprise plan. */
  auth?: object | string;
  version?: string;
  /** What a session ends with: a success, the CLI's usage-limit shape, or exit 1 on an API 429 with no result line. */
  run?: 'ok' | 'limit' | '429';
}

/** A stand-in claude in a fresh folder (with the bench user's home, `home`), and what it was asked. */
function fakeClaude(o: FakeClaude = {}) {
  const base = mkdtempSync(join(tmpdir(), 'bench-'));
  const home = join(base, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
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
  const auth = o.auth ?? authStatus(home, 'claude.ai');
  const said = typeof auth === 'string' ? auth : JSON.stringify(auth);
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      `const log = (x) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(x) + '\\n');`,
      "if (args[0] === '--version') { log({ kind: 'version', args, env: process.env }); console.log(" + JSON.stringify(`${o.version ?? '2.1.303'} (Claude Code)`) + '); process.exit(0); }',
      `if (args[0] === 'auth') { log({ kind: 'auth', args, env: process.env }); console.log(${JSON.stringify(said)}); process.exit(0); }`,
      `const input = ${STDIN_LINE};`,
      "const at = args.indexOf('--settings');",
      'const settings = at >= 0 ? JSON.parse(args[at + 1]) : {};',
      "log({ kind: 'run', args, env: process.env, settings, input });",
      ...(o.run === '429'
        ? ["process.stderr.write('API Error: 429 ' + JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }) + '\\n');", 'process.exit(1);']
        : ["console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', output_style: settings.outputStyle }));", `for (const l of ${JSON.stringify(result)}) console.log(JSON.stringify(l));`]),
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  const calls = (kind?: ClaudeCall['kind']) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ClaudeCall) : []).filter((c) => !kind || c.kind === kind);
  // Nothing of this machine's own that could switch the login (the check would refuse it): wider than the check.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|AZURE_|GOOGLE_|CLOUD_ML_)|_FILE_DESCRIPTOR$|_BASE_URL$|BEDROCK|VERTEX|FOUNDRY|MANTLE/i.test(k)));
  return { base, home, bin, env, calls };
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
  // What every object inherits is no mode: each would have had no ceiling at all.
  for (const mode of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => capsFromArgs(['--tasks', mode, '--spend', '1000000'], () => []), /--tasks takes smoke or baseline/, mode);
  }
});

test('acceptance: only a claude.ai login is accepted, whatever its plan; a token, an API key or a cloud provider is refused', posix, () => {
  const home = fakeClaude().home;
  const refusedShapes: [string, object | string][] = [
    ['an oauth_token (CLAUDE_CODE_OAUTH_TOKEN or federation: the real shape)', authStatus(home, 'oauth_token')],
    ['an oauth_token that names a plan', authStatus(home, 'oauth_token', { subscriptionType: 'team' })],
    ['an API key (the real shape)', authStatus(home, 'api_key')],
    ['an API key helper (documented authMethod; synthetic shape)', authStatus(home, 'api_key', { authMethod: 'api_key_helper' })],
    ['Bedrock (the real shape)', authStatus(home, 'third_party')],
    ['signed out (the real shape)', authStatus(home, 'none')],
    ['a status that is not JSON', 'Not logged in. Run claude /login'],
    ['JSON that is not a status', '[1,2]'],
    ['a claude.ai login on another provider (synthetic: the CLI reports third_party for one)', authStatus(home, 'claude.ai', { apiProvider: 'vertex' })],
    ['a claude.ai login with no provider', authStatus(home, 'claude.ai', { apiProvider: undefined })],
    ['a claude.ai login in another config dir (CLAUDE_CONFIG_DIR elsewhere)', authStatus(home, 'claude.ai', { configDirectory: '/srv/other-login/.claude' })],
    ['a claude.ai login with no config dir', authStatus(home, 'claude.ai', { configDirectory: undefined })],
  ];
  for (const [what, auth] of refusedShapes) {
    const c = fakeClaude({ auth });
    assert.throws(() => requireSubscription(c.env, c.bin, home), /not a claude\.ai login|not Anthropic's own|not inside the bench user's home/, what);
  }
  // Every variable that can switch the login, by prefix: refused before claude is even asked, whatever claude says.
  const switching: Record<string, string>[] = [
    { ANTHROPIC_FEDERATION_RULE_ID: 'rule-x', ANTHROPIC_ORGANIZATION_ID: 'org-x' },
    ...['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_A_VARIABLE_A_LATER_CLI_ADDS'].map((k) => ({ [k]: 'x' })),
    ...['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'].map((k) => ({ [k]: 'x' })),
    ...['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_MANTLE_AUTH', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'].map((k) => ({ [k]: '1' })),
    ...['AWS_BEARER_TOKEN_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'AZURE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'SOME_GATEWAY_BASE_URL'].map((k) => ({ [k]: 'x' })),
    { ANTHROPIC_BASE_URL: '' },
  ];
  for (const vars of switching) {
    const c = fakeClaude();
    assert.throws(() => requireSubscription({ ...c.env, ...vars }, c.bin, c.home), new RegExp(`${Object.keys(vars)[0]}.* set in the bench's environment`), JSON.stringify(vars));
    assert.equal(c.calls().length, 0, `${JSON.stringify(vars)}: claude not even asked`);
  }
  // This machine's shape: a claude.ai login on an enterprise plan; the plan and the config dir are recorded.
  const c = fakeClaude();
  assert.deepEqual(requireSubscription({ ...c.env, DISABLE_TELEMETRY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' }, c.bin, c.home), { method: 'claude.ai', subscription_type: 'enterprise', config_directory: join(c.home, '.claude') });
  for (const plan of ['max', 'team', undefined]) {
    const f = fakeClaude({ auth: authStatus(home, 'claude.ai', { subscriptionType: plan }) });
    assert.equal(requireSubscription(f.env, f.bin, home).subscription_type, plan ?? null);
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
  requireSubscription(c.env, c.bin, c.home);
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

test('acceptance: a 429 the engine would retry as transient stops the bench too: one session, no retry, the rest not run', posix, async () => {
  // A failed run on an API 429 with no result line (claude exits 1): the engine calls that transient, not rate_limited.
  // Once with the engine's own retry (1 min, 2 min, then 5 min for 30 min; on a clock this test drives, its waits end
  // when aborted), and once with retries off, as the bench's runner is built.
  let t = 0;
  const retries: [string, RetryOptions][] = [
    ['retries on', { now: () => t, sleep: async (ms, signal) => (signal?.aborted ? false : ((t += ms), true)) }],
    ['retries off', { budgetMs: 0 }],
  ];
  for (const [what, retry] of retries) {
    const c = fakeClaude({ run: '429' });
    const meter = new UsageMeter(new BenchAgentRunner(new CliRunner('cli', c.env, c.bin, undefined, undefined, undefined, retry)), 40);
    const first = meter.task(15);
    const r = await first.run(runReq(c.base));
    assert.notEqual(r.reason, 'succeeded', what);
    assert.equal(c.calls('run').length, 1, `${what}: exactly one claude session`);
    assert.ok(meter.limited, `${what}: the meter stopped at the rate limit`);
    assert.match(meter.limited.detail, /429/, what);
    assert.ok(meter.signal.aborted, `${what}: every task in flight is told to stop`);
    for (const next of [first, meter.task(15), meter.task(15)]) {
      const again = await next.run(runReq(c.base, undefined, 'evaluator'));
      assert.match(again.detail, /not started: the bench stopped at a usage limit/, `${what}: the rest are not run`);
    }
    assert.equal(c.calls('run').length, 1, `${what}: one session in all`);
  }
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
  assert.equal(benchRoot({}, home).root, join(home, 'bench'));
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, '.claude', 'bench') }, home), /overlaps/);
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: 'bench' }, home), /absolute/);
  mkdirSync(join(home, 'clone', '.git'), { recursive: true });
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, 'clone', 'bench') }, home), /inside a git checkout/);
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, '.local', 'state', BRAND.cli, 'bench') }, home), /overlaps/, "the engine's real state");
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, 'data'), [HELD_OUT_ENV]: join(home, 'data', 'held') }, home), /overlaps/, 'a held-out store the environment names');
});

test('the bench root is checked where it really is: a symlink into a credential store or a checkout is refused', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
  mkdirSync(join(home, '.claude'));
  symlinkSync(join(home, '.claude'), join(home, 'bench'));
  assert.throws(() => benchRoot({}, home), /overlaps .*\.claude/, '~/bench is a link to ~/.claude');
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'other-')));
  mkdirSync(join(other, 'clone', '.git'), { recursive: true });
  symlinkSync(join(other, 'clone'), join(home, 'linked'));
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, 'linked', 'bench') }, home), /inside a git checkout/, 'a root under a link into a checkout');
  // A link to a folder of its own: resolved, and the layout is built where it really is.
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'data-')));
  symlinkSync(data, join(home, 'bench-data'));
  assert.equal(benchRoot({ [BENCH_ROOT_ENV]: join(home, 'bench-data', 'b') }, home).root, join(data, 'b'));
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
  dropped?: 'inspect-memory' | 'inspect-cpu' | 'cgroup-memory' | 'cgroup-swap' | 'cgroup-pids';
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
      // What `cat` prints for each file it was asked for, in order (an older reader asked for three).
      const file = (f: string) => ({ 'memory.max': `${o.dropped === 'cgroup-memory' ? 'max' : LIMITS.memoryBytes}`, 'memory.swap.max': o.dropped === 'cgroup-swap' ? 'max' : '0', 'cpu.max': `${LIMITS.cpus * 100000} 100000`, 'pids.max': `${o.dropped === 'cgroup-pids' ? 'max' : LIMITS.pids}` })[f.replace('/sys/fs/cgroup/', '')];
      return ok(args.filter((a) => a.startsWith('/sys/fs/cgroup/')).map(file).join('\n') + '\n');
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
  requireSubscription(env, c.bin, c.home);
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

test("the Read tool is denied each credential file itself, the daemon's data root and a DOCKER_HOST socket", () => {
  const home = '/home/u';
  const lane = benchLane({ home, runtimeDir: '/run/user/1001', heldOut: '/srv/b/held', state: '/srv/b/state', dockerHost: 'unix:///srv/docker/alt.sock', dataHome: '/srv/data' });
  const deny = lane.settings.permissions.deny;
  // A file matches only the exact rule: `p/**` is what is inside a folder p.
  for (const f of ['.claude.json', '.netrc', '.npmrc', '.pypirc', '.docker/config.json']) assert.ok(deny.includes(`Read(/${home}/${f})`), `Read(/${home}/${f})`);
  for (const d of ['.claude', '.ssh', '.local/share/docker']) assert.ok(deny.includes(`Read(/${home}/${d}/**)`), `Read(/${home}/${d}/**)`);
  const denyRead = lane.settings.sandbox.filesystem.denyRead;
  for (const p of ['/srv/docker/alt.sock', `${home}/.local/share/docker`, '/srv/data/docker', '/run/user/1001/docker.sock']) assert.ok(denyRead.includes(p), `commands denied ${p}`);
  assert.ok(deny.includes('Read(//srv/docker/alt.sock)'));
  // A tcp DOCKER_HOST names no socket.
  assert.ok(!benchLane({ home, runtimeDir: '/run/user/1001', heldOut: '/h', state: '/s', dockerHost: 'tcp://127.0.0.1:2375' }).settings.sandbox.filesystem.denyRead.some((p) => p.includes('2375')));
});

test('acceptance: the bench never retries a run: a 429 at startup is one session, reported, not waited out', posix, async () => {
  const c = fakeClaude({ run: '429' });
  const lane = benchLane({ home: c.home, runtimeDir: join(c.base, 'run-user'), heldOut: join(c.base, 'held'), state: join(c.base, 'state') });
  let retried = 0;
  const started = Date.now();
  // Bounded: an engine retry would wait a minute first; this stops it after 20 s.
  const r = await benchClaude(c.env, c.bin, lane).run({ ...runReq(c.base, AbortSignal.timeout(20_000)), onTransientRetry: () => retried++ });
  assert.equal(retried, 0, 'no transient wait started');
  assert.equal(r.reason, 'failed');
  assert.equal(r.transient, true);
  assert.match(r.detail, /429/);
  assert.equal(c.calls('run').length, 1, 'one claude session');
  assert.ok(Date.now() - started < 15_000, 'reported at once');
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
    ['exec', '--env', 'HOME', 'bench-r1-t01', 'ls'],
    ['exec', '--env=PATH', 'bench-r1-t01', 'ls'],
    ['exec', '--workdir=/work/../etc', 'bench-r1-t01', 'ls'],
    ['exec', '--workdir', '/work/t/../../etc', 'bench-r1-t01', 'ls'],
    ['exec', '--workdir', '/work//t', 'bench-r1-t01', 'ls'],
    ['exec', '--constructor', 'x', 'bench-r1-t01', 'ls'],
  ]) assert.throws(() => checkDockerArgs(bad, ['exec']), /refused|only/, bad.join(' '));
  checkDockerArgs(['exec', '--env', 'PYTHONHASHSEED=0', '--env=EMPTY=', 'bench-r1-t01', 'ls'], ['exec']);
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
    // A value never stands in for a flag: the real flag dropped, its name given as --name's value.
    for (const flag of ['--network', '--cap-drop', '--security-opt']) {
      const i = make.indexOf(flag);
      const forged = [...make.slice(0, i), ...make.slice(i + 2)];
      const n = forged.indexOf('--name');
      forged.splice(n, 2, '--name', flag);
      assert.throws(() => checkDockerArgs(forged), /refused/, `--name ${flag}`);
    }
    const n = make.indexOf('--name');
    assert.throws(() => checkDockerArgs([...make.slice(0, n + 1), 'victim', ...make.slice(n + 2)]), /--name victim refused/);
    assert.throws(() => checkDockerArgs([...make.slice(0, n), ...make.slice(n + 2)]), /without --name/);
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
  for (const [dropped, controller] of [['inspect-memory', 'memory'], ['inspect-cpu', 'cpu'], ['cgroup-memory', 'memory \\(memory.max\\)'], ['cgroup-swap', 'memory \\(memory.swap.max\\)'], ['cgroup-pids', 'pids \\(pids.max\\)']] as const) {
    const d = fakeDocker({ dropped });
    const docker = new Docker(d.opts, LIMITS);
    assert.throws(() => docker.probe({ ...C, name: 'bench-r1-probe' }), (e: Error) => e instanceof LimitsNotApplied && new RegExp(`${controller}.*limit did not apply.*Delegate= drop-in`).test(e.message), dropped);
    assert.equal(d.sent.at(-1)!.args[0], 'rm', `${dropped}: the probe container is removed`);
    assert.throws(() => docker.start(C, ROW), LimitsNotApplied, `${dropped}: a task's container too`);
  }
  for (const [k, v, why] of [['memory', '0', /memory limit/], ['cpus', '0', /CPU limit/], ['pids', '', /pids limit/], ['cpus', '17', /over this machine's 16 CPUs/], ['memory', '32g', /over 75%/], ['memory', '100000000', /not a multiple of 4096/]] as const) {
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

/** A bench machine for the driver: a stand-in claude and docker, a layout, and the driver's options. */
function machine(o: FakeClaude & FakeDocker = {}) {
  const c = fakeClaude(o);
  const d = fakeDocker(o);
  const layout = benchLayout(join(c.base, 'bench'));
  const runtime = join(c.base, 'run-user');
  const env: NodeJS.ProcessEnv = { ...c.env, XDG_RUNTIME_DIR: runtime, DOCKER_HOST: `unix://${runtime}/docker.sock`, [BENCH_USER_ENV]: currentUser() };
  const lane = benchLane({ home: process.env.HOME!, runtimeDir: runtime, heldOut: layout.heldOut, state: layout.state });
  const opts = (runTask: RunTask, over: Partial<BenchOptions> = {}): BenchOptions => ({
    layout,
    runId: 'r1',
    caps: CAPS,
    limits: LIMITS,
    tasks: ['t01', 't02', 't03'].map((key) => ({ key, row: ROW, image: 'swebench/example:latest' })),
    preflight: { benchUser: () => requireBenchUser(env), claudePin: () => requireClaudePin(env, c.bin), subscription: () => requireSubscription(env, c.bin, c.home) },
    runner: benchClaude(env, c.bin, lane),
    docker: { ...d.opts, env },
    runTask,
    ...over,
  });
  const results = () => (JSON.parse(readFileSync(join(layout.runs, 'r1', 'results.json'), 'utf8')) as { results: TaskResult[] }).results;
  return { ...c, layout, env, docker: d.sent, opts, results };
}

/** A task as the engine would run it: two agent runs, a test in the container, a commit, one patch. */
const engineTask: RunTask = async (ctx) => {
  for (const role of ['worker', 'evaluator']) {
    const r = await ctx.runner.run(runReq(ctx.workDir, ctx.signal, role));
    if (r.reason !== 'succeeded') return { decision: 'failed', detail: r.detail, heads: [] };
  }
  ctx.exec.exec('/work/t', ['python', '-m', 'pytest', '-v', 'tests/test_price.py']);
  const repo = join(ctx.workDir, 'repo');
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=b@example.com', '-c', 'user.name=b', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  writeFileSync(join(repo, 'price.py'), 'def total(items):\n    return sum(c * q for c, q in items)\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'price.py'), 'def total(items):\n    return sum(c * q for c, q in items if q >= 0)\n');
  g('commit', '-qam', 'fix');
  return { decision: 'auto-merge', repo, heads: [{ label: 'final', base, head: g('rev-parse', 'HEAD') }] };
};

test('acceptance: the driver refuses to start without a spend cap or on a non-subscription login, before any model call or container', posix, async () => {
  const m = machine();
  for (const caps of [undefined, { ...CAPS, spendUsd: 0 }, { ...CAPS, spendUsd: 41 }, { ...CAPS, perTaskUsd: 16 }]) {
    await assert.rejects(runBench(m.opts(engineTask, { caps: caps as Caps })), /spend cap|over the owner's approval/);
  }
  assert.equal(m.calls().length, 0, 'claude never ran');
  assert.equal(m.docker.length, 0, 'docker never ran');
  for (const auth of [{ loggedIn: true, authMethod: 'api_key' }, { loggedIn: false }]) {
    const k = machine({ auth });
    await assert.rejects(runBench(k.opts(engineTask)), /not a claude\.ai login/);
    assert.equal(k.calls('run').length, 0);
    assert.equal(k.docker.length, 0);
  }
  for (const [o, why] of [[{ version: '2.1.302' }, /not the pinned 2\.1\.303/], [{ rootless: false }, /not rootless/]] as const) {
    const k = machine(o);
    await assert.rejects(runBench(k.opts(engineTask)), why);
    assert.equal(k.calls('run').length, 0);
    assert.ok(k.docker.every((s) => s.args[0] === 'info'), 'nothing but the check reached docker');
  }
});

test('the driver checks the limits on a probe before the first task and on each task, and refuses before any agent call', posix, async () => {
  const m = machine();
  const agg = await runBench(m.opts(engineTask));
  const verbs = m.docker.map((s) => s.args[0]);
  assert.deepEqual(verbs.slice(0, 7), ['info', 'create', 'inspect', 'start', 'inspect', 'exec', 'rm']);
  const firstRun = verbs.indexOf('run');
  assert.deepEqual(verbs.slice(firstRun, firstRun + 3), ['run', 'inspect', 'exec']);
  assert.deepEqual(agg.limits, LIMITS);
  assert.ok(m.results().every((r) => JSON.stringify(r.limits) === JSON.stringify(LIMITS)), 'each task records the limits it had');
  assert.equal(agg.subscription_type, 'enterprise', 'the plan is recorded');
  assert.equal(agg.claude_version, '2.1.303');
  for (const dropped of ['inspect-memory', 'cgroup-memory'] as const) {
    const k = machine({ dropped });
    await assert.rejects(runBench(k.opts(engineTask)), /limit did not apply/);
    assert.equal(k.calls('run').length, 0, `${dropped}: no agent ran`);
    assert.ok(!k.docker.some((s) => s.args[0] === 'run'), `${dropped}: no task container`);
  }
  await assert.rejects(runBench(m.opts(engineTask, { limits: undefined as unknown as Limits })), /needs a memory, CPU and pids limit/);
});

test('acceptance: the driver stops cleanly at a usage limit: no retry, the rest not run, a partial aggregate', posix, async () => {
  const m = machine({ run: 'limit' });
  const agg = await runBench(m.opts(engineTask));
  assert.equal(m.calls('run').length, 1, 'one session, no retry and no later run');
  assert.deepEqual(m.results().map((r) => r.status), ['stopped (usage limit)', 'not run (usage limit)', 'not run (usage limit)']);
  assert.equal(m.results()[0]!.usage_equivalent_usd, 0.42, "the CLI's own total_cost_usd, recorded");
  const onDisk = JSON.parse(readFileSync(join(m.layout.runs, 'r1', 'aggregate.json'), 'utf8')) as typeof agg;
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(agg)));
  assert.equal(agg.complete, false);
  assert.equal(agg.stopped, 'usage_limit');
  assert.equal(agg.tasks.run, 1);
  assert.equal(agg.tasks.not_run_usage_limit, 2);
  assert.equal(m.docker.filter((s) => s.args[0] === 'run').length, 1, 'no container for a task not run');
});

test('a full run records usage per task, and the wall-clock cap ends a task that runs on', posix, async () => {
  const m = machine();
  const agg = await runBench(m.opts(engineTask));
  assert.equal(agg.complete, true);
  assert.deepEqual(agg.decisions, { auto_merge: 3, hold: 0, failed: 0, error: 0, stopped_usage_limit: 0 });
  assert.equal(agg.usage.total, 7.5);
  assert.equal(agg.usage.mean_per_task, 2.5);
  assert.equal(agg.usage.owner_reapproval_needed, false);
  const slow = machine();
  let aborted = 0;
  const hangs: RunTask = (ctx) => new Promise(() => ctx.signal.addEventListener('abort', () => aborted++));
  const capped = await runBench(slow.opts(hangs, { taskWallMs: 50 }));
  assert.equal(capped.decisions.failed, 3);
  assert.equal(capped.tasks.wall_cap_hit, 3);
  assert.equal(aborted, 3, "each task's signal was aborted");
  assert.equal(slow.docker.filter((s) => s.args[0] === 'rm').length, 4, 'every container removed (the probe and three tasks)');
});

test('acceptance: through the driver, no container and no agent gets a hidden field', posix, async () => {
  const m = machine();
  const refusals: string[] = [];
  const leaky: RunTask = async (ctx) => {
    try {
      ctx.exec.exec('/work/t', ['python', '-m', 'pytest', 'tests/test_price.py::test_negative_quantities_are_skipped_TESTMARK']);
    } catch (e) {
      refusals.push((e as Error).message);
    }
    return engineTask(ctx);
  };
  await runBench(m.opts(leaky));
  assert.equal(refusals.length, 3);
  const seen = JSON.stringify(m.docker);
  for (const mark of MARKS) assert.ok(!seen.includes(mark), `no docker command carried ${mark}`);
  for (const r of m.calls('run')) for (const mark of MARKS) assert.ok(!JSON.stringify(r).includes(mark), `no agent saw ${mark}`);
});

test('acceptance: grading reads only exported patches', posix, async () => {
  const m = machine();
  await runBench(m.opts(engineTask));
  writeStore(m.layout, MANIFEST, JSON.stringify({ dataset_revision: 'r', seed: 20261018, tasks: ['t01', 't02', 't03'].map((key, i) => ({ key, instance_id: `example__proj-${i}` })) }));
  const run = join(m.layout.runs, 'r1');
  // Decoys beside the patches: another diff in a task's folder, an uncommitted change in the clone.
  writeFileSync(join(run, 't01', 'final.diff'), 'DECOY_WORKDIR\n');
  writeFileSync(join(run, 't01', 'repo', 'price.py'), 'DECOY_UNCOMMITTED\n');
  const files = writePredictions(m.layout, 'r1');
  assert.deepEqual(Object.keys(files), ['final']);
  const preds = readFileSync(files.final!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { instance_id: string; model_patch: string });
  assert.deepEqual(preds.map((p) => p.instance_id), ['example__proj-0', 'example__proj-1', 'example__proj-2']);
  for (const p of preds) {
    assert.match(p.model_patch, /^diff --git a\/price\.py b\/price\.py/);
    assert.match(p.model_patch, /\+    return sum\(c \* q for c, q in items if q >= 0\)/);
    assert.ok(!/DECOY/.test(p.model_patch));
  }
  assert.ok(files.final!.startsWith(m.layout.heldOut), 'predictions (which name instances) stay in the held-out store');
  // Anything in the patches folder that isn't an exported patch is refused, a link above all.
  symlinkSync(join(run, 't01', 'final.diff'), join(run, 'patches', 't02', 'attempt-1.diff'));
  assert.throws(() => readPatches(m.layout, 'r1'), /not a plain file \(a link\?\)/);
  const other = machine();
  await runBench(other.opts(engineTask));
  writeFileSync(join(other.layout.runs, 'r1', 'patches', 't01', 'notes.txt'), 'DECOY');
  assert.throws(() => readPatches(other.layout, 'r1'), /not an exported patch/);
});

test('research-on-demand is off in every task, and checked', posix, async () => {
  assertResearchOff(BENCH_SETTINGS);
  assert.throws(() => assertResearchOff({} as InstanceSettings), /must be off/);
  const m = machine();
  await assert.rejects(runBench(m.opts(engineTask, { settings: { research: { max_searches_per_day: 1, max_fetches_per_day: 0, max_usd_per_day: 0 } } as InstanceSettings })), /must be off/);
  assert.equal(m.docker.length, 0);
  let seen: InstanceSettings | null = null;
  await runBench(m.opts(async (ctx) => ((seen = ctx.settings), engineTask(ctx))));
  assertResearchOff(seen!);
});

test('aggregates: Wilson intervals and the confusion matrix from grades', () => {
  assert.equal(wilson(0, 0), null);
  assert.deepEqual(wilson(5, 10), { k: 5, n: 10, rate: 0.5, lo: 0.237, hi: 0.763 });
  const r = (key: string, status: TaskResult['status']): TaskResult => ({ key, status, usage_equivalent_usd: 9, runs: [], patches: [], wall_ms: 0 });
  const a = aggregate({ run: 'r', claude_version: '2.1.303', subscription_type: 'enterprise', caps: CAPS, total_tasks: 4, limits: LIMITS, task_wall_ms: 1, stopped: null, stop_detail: null }, [r('t01', 'auto-merge'), r('t02', 'auto-merge'), r('t03', 'hold'), r('t04', 'failed')], {
    t01: { final: true, b0: true },
    t02: { final: false, b0: false },
    t03: { final: true, b0: false },
    t04: { final: false },
  });
  assert.deepEqual(a.graded!.confusion, { auto_merge: { resolved: 1, unresolved: 1 }, hold: { resolved: 1, unresolved: 0 }, failed: { resolved: 0, unresolved: 1 } });
  assert.equal(a.graded!.merge_precision?.rate, 0.5);
  assert.equal(a.graded!.false_holds?.rate, 0.5);
  assert.equal(a.graded!.caught_bad_fixes?.rate, 0.5);
  assert.equal(a.graded!.baselines.b0_agent_alone?.n, 3);
  assert.equal(a.usage.owner_reapproval_needed, true, 'a smoke mean over $8 per task needs the owner');
  assert.ok(!JSON.stringify(a).includes('example__'), 'no instance id in an aggregate');
});

/**
 * A stand-in srt. `none`: no sandbox at all (runs the command as is); `honors`: reports what sandbox-runtime does for
 * a path its settings deny (a denied file masked with /dev/null, a denied socket refused) and what an unsandboxed
 * attempt would see for anything else. `version`: what --version prints. `none` never touches a path outside `confine`
 * (this machine's own docker sockets): an attempt there is pointed at a missing path under it instead.
 */
function fakeSrt(kind: 'none' | 'honors', version = '0.0.79', confine = tmpdir()): string {
  const dir = mkdtempSync(join(tmpdir(), 'srt-'));
  const bin = join(dir, 'srt');
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs'), { spawnSync } = require('node:child_process');",
      'const a = process.argv.slice(2);',
      `if (a[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }`,
      "if (a[0] !== '--settings' || a[2] !== '--') { console.error('usage: srt --settings <file> -- <command...>'); process.exit(2); }",
      'const cfg = JSON.parse(fs.readFileSync(a[1], "utf8"));',
      'const cmd = a.slice(3);',
      kind === 'none'
        ? [
            `const confine = ${JSON.stringify(confine)};`,
            'const attempts = JSON.parse(cmd.at(-1)).map((x) => x.target.startsWith(confine + "/") ? x : { ...x, target: confine + "/not-here.sock" });',
            'process.exit(spawnSync(cmd[0], [...cmd.slice(1, -1), JSON.stringify(attempts)], { stdio: "inherit" }).status ?? 1);',
          ].join('\n')
        : [
            'const denied = (p) => cfg.filesystem.denyRead.some((d) => p === d || p.startsWith(d + "/"));',
            'const out = JSON.parse(cmd.at(-1)).map((x) => denied(x.target) ? (x.kind === "read" ? "opened char-device" : "ECONNREFUSED") : x.kind === "read" ? (fs.existsSync(x.target) ? "opened file" : "ENOENT") : "connected");',
            'console.log(JSON.stringify(out));',
          ].join('\n'),
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  return bin;
}

test('acceptance: the sandbox probe refuses the run unless every attempt from inside the sandbox is refused', { skip: process.platform !== 'linux' && 'Linux only' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'probe-'));
  const home = join(base, 'u');
  const runtime = join(base, 'run-user');
  mkdirSync(home);
  mkdirSync(runtime);
  writeFileSync(join(home, '.claude.json'), '{"oauthAccount":"PROBE_SENTINEL"}');
  const o = { home, runtimeDir: runtime, heldOut: join(base, 'held'), state: join(base, 'state') };
  const lane = benchLane(o);
  // srt missing, or another release: refused before any attempt.
  assert.throws(() => sandboxProbe({ ...o, settings: lane.settings, srt: join(base, 'no-srt') }), /srt --version is unreadable/);
  assert.throws(() => sandboxProbe({ ...o, settings: lane.settings, srt: fakeSrt('honors', '0.0.78') }), /srt --version is 0\.0\.78, not 0\.0\.79/);
  // Every attempt refused: the run may start, and the report says what each saw.
  const report = sandboxProbe({ ...o, settings: lane.settings, srt: fakeSrt('honors') });
  assert.equal(report.ok, true);
  assert.match(report.runner, /^sandbox-runtime 0\.0\.79: close to, not identical with, the build bundled in Claude Code 2\.1\.303$/);
  assert.deepEqual(report.results.map((r) => [r.kind, r.target.replace(base, '~'), r.seen, r.refused]), [
    ['connect', '~/run-user/docker.sock', 'ECONNREFUSED', true],
    ['connect', '/run/docker.sock', 'ECONNREFUSED', true],
    ['connect', '/var/run/docker.sock', 'ECONNREFUSED', true],
    ['read', '~/u/.claude.json', 'opened char-device', true],
    ['read', '~/u/.netrc', 'opened char-device', true],
    ['read', '~/u/.npmrc', 'opened char-device', true],
    ['read', '~/u/.pypirc', 'opened char-device', true],
  ]);
  assert.deepEqual(report.results.filter((r) => !r.on_host && r.kind === 'read').map((r) => [r.target.replace(home, '~'), r.deny_rule]), [['~/.netrc', true], ['~/.npmrc', true], ['~/.pypirc', true]], 'a missing file counts as refused only with its deny rule in place');
  // A lane whose Read rules lack the files' exact form (sandboxSettings alone): no deny rule, refused.
  const loose = sandboxSettings({ lane: { allowedDomains: [] }, denyRead: benchDenied(o) });
  assert.throws(() => sandboxProbe({ ...o, settings: loose, srt: fakeSrt('honors') }), (e: Error & { report?: ProbeReport }) => /read .*\.claude\.json: no deny rule/.test(e.message) && e.report?.ok === false);
  // No sandbox at all: the login file opens and the daemon's socket answers. Refused, naming both.
  const { createServer } = await import('node:net');
  const server = createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(join(runtime, 'docker.sock'), r));
  try {
    assert.throws(() => sandboxProbe({ ...o, settings: lane.settings, srt: fakeSrt('none', '0.0.79', base) }), (e: Error & { report?: ProbeReport }) => {
      const seen = Object.fromEntries((e.report?.results ?? []).map((r) => [r.target.replace(base, '~'), r.seen]));
      return /connect .*docker\.sock: connected/.test(e.message) && /read .*\.claude\.json: opened file/.test(e.message) && seen['~/u/.claude.json'] === 'opened file' && !e.message.includes('PROBE_SENTINEL');
    });
  } finally {
    server.close();
  }
});

test("acceptance: a tree's tar stream carries nothing hidden that its base tree lacks", () => {
  // The base tree (the base commit as a tar stream): it already holds a context line the test patch also adds, and
  // the PASS_TO_PASS test, both in the container's image anyway.
  const shared = 'assert total([(2, 3), (4, 1)]) == 10  # SHARED_BASE_LINE';
  const row: TaskRow = { ...ROW, test_patch: `${ROW.test_patch}+    ${shared}\n` };
  const base = Buffer.from(`tests/test_price.py\0def test_plain_totals_PASSMARK():\n    ${shared}\n`);
  const d = fakeDocker();
  const r = new TaskRunner(d.opts, C, row, base);
  r.syncTree('/work/t', Buffer.concat([base, Buffer.from('src/price.py\0def total(items):\n    return 0\n')]));
  assert.equal(d.sent.length, 1, 'the base tree and an honest change go through');
  for (const [what, extra, field] of [
    ['an added line of the test patch', 'def test_negative_quantities_are_skipped_TESTMARK():\n    assert total([(5, -1)]) == 0\n', /test_patch|FAIL_TO_PASS/],
    ['the gold patch', '    return sum(c * q for c, q in items if q > 0)  # GOLDMARK_7731\n', /hidden patch/],
    ['the hints', 'HINTMARK: look at the generator in price.py\n', /hints_text/],
    ['the instance id', '# from example__proj-4242\n', /instance_id/],
    ['a FAIL_TO_PASS test by its name', 'def test_negative_quantities_are_skipped_TESTMARK(): pass\n', /FAIL_TO_PASS/],
  ] as const) {
    const before: number = d.sent.length;
    assert.throws(() => r.syncTree('/work/t', Buffer.concat([base, Buffer.from(`tests/x.py\0${extra}`)])), (e: Error) => /input would carry the task's hidden/.test(e.message) && field.test(e.message), what);
    assert.equal(d.sent.length, before, `${what}: nothing sent`);
  }
  // No base tree: every hidden piece counts, the shared context line too.
  assert.throws(() => new TaskRunner(d.opts, C, row).syncTree('/work/t', base), /input would carry the task's hidden test_patch/);
});

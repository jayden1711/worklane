// The gated-merge benchmark (#748, Phase 0). No model call, no Docker, no download: claude is a stand-in script that
// answers with the CLI's own JSON shapes (auth status, --version, stream-json, a usage-limit result), and every path
// is under this test's temporary machine (test/isolate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { HELD_OUT_ENV } from '../src/held-out-paths.js';
import { CliRunner, type RetryOptions, type RunRequest } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';
import { benchClaude, benchDenied, benchLane } from '../scripts/bench/agent.js';
import { sandboxProbe, type ProbeReport } from '../scripts/bench/probe.js';
import { agentBase, BENCH_USER_ENV, BenchAgentRunner, CLAUDE_PIN_ENV, requireBenchUser, requireClaudePin, requireSubscription } from '../scripts/bench/auth.js';
import { capsFromArgs, type Caps } from '../scripts/bench/caps.js';
import { checkDockerArgs, Docker, LIMIT_ENV, limitsFrom, LimitsNotApplied, makeArgs, STDIN_REFUSED, TaskRunner, type DockerCall, type Limits } from '../scripts/bench/container.js';
import { hiddenLeaks, taskView, type TaskRow } from '../scripts/bench/hidden.js';
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
  // HOME is the bench user's home, as a login shell (sudo -iu) sets it.
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|AZURE_|GOOGLE_|CLOUD_ML_)|_FILE_DESCRIPTOR$|_BASE_URL$|BEDROCK|VERTEX|FOUNDRY|MANTLE/i.test(k))), HOME: home };
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
    assert.throws(() => requireSubscription({ ...c.env, HOME: home }, c.bin, home), /not a claude\.ai login|not Anthropic's own|not inside the bench user's home/, what);
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
    assert.equal(requireSubscription({ ...f.env, HOME: home }, f.bin, home).subscription_type, plan ?? null);
  }
});

test("acceptance: the bench user's home is its passwd entry's, never $HOME: a HOME moved to another claude.ai login is refused", posix, () => {
  const c = fakeClaude();
  // Another folder holding a claude.ai login: claude follows $HOME there and reports that login, config dir and all.
  const other = fakeClaude().home;
  const moved = fakeClaude({ auth: authStatus(other, 'claude.ai') });
  assert.throws(() => requireSubscription({ ...moved.env, HOME: other }, moved.bin, c.home), /HOME is .*not this user's home/, 'HOME at another login');
  assert.throws(() => requireSubscription({ ...c.env, HOME: '' }, c.bin, c.home), /HOME is \(empty\)/, 'an empty HOME');
  assert.equal(moved.calls().length, 0, 'claude not even asked');
  assert.throws(() => benchRoot({ HOME: other }, c.home), /HOME is .*not this user's home/, 'the bench root: HOME at another folder');
  // With no home given, it comes from the user database. This process's HOME is test/isolate.ts's temporary home,
  // which the user database doesn't name: a claude.ai login there, and a root in it, were accepted when the home was
  // $HOME (os.homedir()).
  const tempHome = homedir();
  if (tempHome === userInfo().homedir) return;
  const here = fakeClaude({ auth: authStatus(tempHome, 'claude.ai') });
  assert.throws(() => requireSubscription({ ...here.env, HOME: tempHome }, here.bin), /HOME is .*not this user's home/, "the default home: HOME at test/isolate's home");
  assert.equal(here.calls().length, 0, 'claude not even asked');
  assert.throws(() => benchRoot({ HOME: tempHome }), /HOME is .*not this user's home/, "the bench root's default home");
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
  const sent: { args: string[]; input: string; env: NodeJS.ProcessEnv }[] = [];
  const call: DockerCall = (_bin, args, opt) => {
    sent.push({ args: [...args], input: opt.input?.toString('utf8') ?? '', env: opt.env });
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
  const agents = benchClaude(env, c.bin, benchLane({ home: process.env.HOME!, runtimeDir: runtime, heldOut: layout.heldOut, state: layout.state, dockerHost: env.DOCKER_HOST, dataHome: undefined }));
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
  assert.ok(!benchLane({ home, runtimeDir: '/run/user/1001', heldOut: '/h', state: '/s', dockerHost: 'tcp://127.0.0.1:2375', dataHome: undefined }).settings.sandbox.filesystem.denyRead.some((p) => p.includes('2375')));
});

test("the driver's docker always names its daemon: never a docker context, never a relative unix socket", () => {
  const lane = (dockerHost: string) => benchLane({ home: '/home/u', runtimeDir: '/run/user/1001', heldOut: '/h', state: '/s', dockerHost, dataHome: undefined });
  // A relative unix:// socket is relative to wherever docker runs: no deny rule can name it.
  for (const rel of ['unix://docker.sock', 'unix://./run/alt.sock']) {
    assert.throws(() => lane(rel), /absolute path/, `the lane: ${rel}`);
    assert.throws(() => new Docker({ ...fakeDocker().opts, env: { DOCKER_HOST: rel } }, LIMITS).preflight(), /absolute path/, `the driver's docker: ${rel}`);
  }
  // No DOCKER_HOST: the rootless socket in the runtime dir, set explicitly, so a docker context never picks the daemon.
  const d = fakeDocker();
  new Docker({ ...d.opts, env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1001', DOCKER_CONFIG: '/home/u/.docker', GH_TOKEN: 'x' } }, LIMITS).preflight();
  assert.equal(d.sent[0]!.env.DOCKER_HOST, 'unix:///run/user/1001/docker.sock');
  assert.equal(d.sent[0]!.env.DOCKER_CONFIG, undefined);
  assert.equal(d.sent[0]!.env.GH_TOKEN, undefined);
  const alt = fakeDocker();
  new Docker({ ...alt.opts, env: { DOCKER_HOST: 'unix:///srv/docker/alt.sock' } }, LIMITS).preflight();
  assert.equal(alt.sent[0]!.env.DOCKER_HOST, 'unix:///srv/docker/alt.sock', 'the bench user DOCKER_HOST, the one the lane denies');
  assert.ok(lane('unix:///srv/docker/alt.sock').settings.sandbox.filesystem.denyRead.includes('/srv/docker/alt.sock'));
  // DOCKER_CONTEXT would pick a context's daemon: refused, nothing sent.
  const ctx = fakeDocker();
  assert.throws(() => new Docker({ ...ctx.opts, env: { DOCKER_CONTEXT: 'elsewhere' } }, LIMITS).preflight(), /DOCKER_CONTEXT elsewhere refused/);
  assert.equal(ctx.sent.length, 0);
});

test('acceptance: the bench never retries a run: a 429 at startup is one session, reported, not waited out', posix, async () => {
  const c = fakeClaude({ run: '429' });
  const lane = benchLane({ home: c.home, runtimeDir: join(c.base, 'run-user'), heldOut: join(c.base, 'held'), state: join(c.base, 'state'), dockerHost: undefined, dataHome: undefined });
  let retried = 0;
  const started = performance.now();
  // Bounded: an engine retry would wait a minute first; this stops it after 20 s.
  const r = await benchClaude(c.env, c.bin, lane).run({ ...runReq(c.base, AbortSignal.timeout(20_000)), onTransientRetry: () => retried++ });
  assert.equal(retried, 0, 'no transient wait started');
  assert.equal(r.reason, 'failed');
  assert.equal(r.transient, true);
  assert.match(r.detail, /429/);
  assert.equal(c.calls('run').length, 1, 'one claude session');
  assert.ok(performance.now() - started < 15_000, 'reported at once');
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
  new TaskRunner(d.opts, C, ROW, Buffer.from('')).syncTree('/work/t', Buffer.from('tar'));
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
  const r = new TaskRunner(d.opts, C, ROW, Buffer.from(''));
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
      `fs.appendFileSync(${JSON.stringify(join(dir, 'settings-files'))}, a[1] + '\\n');`,
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
  const o = { home, runtimeDir: runtime, heldOut: join(base, 'held'), state: join(base, 'state'), dockerHost: undefined, dataHome: undefined };
  const lane = benchLane(o);
  // srt missing, or another release: refused before any attempt.
  assert.throws(() => sandboxProbe({ ...o, settings: lane.settings, srt: join(base, 'no-srt') }), /srt --version is unreadable/);
  assert.throws(() => sandboxProbe({ ...o, settings: lane.settings, srt: fakeSrt('honors', '0.0.78') }), /srt --version is 0\.0\.78, not 0\.0\.79/);
  // Every attempt refused: the run may start, and the report says what each saw.
  const honors = fakeSrt('honors');
  const report = sandboxProbe({ ...o, settings: lane.settings, srt: honors });
  assert.equal(report.ok, true);
  assert.match(report.runner, /^sandbox-runtime 0\.0\.79: close to, not identical with, the build bundled in Claude Code 2\.1\.303$/);
  // The settings file srt was given is gone once the probe returns, and so is its folder.
  const given = readFileSync(join(dirname(honors), 'settings-files'), 'utf8').trim().split('\n');
  assert.equal(given.length, 1);
  assert.equal(existsSync(given[0]!), false, 'the settings file is removed');
  assert.equal(existsSync(dirname(given[0]!)), false, 'and its folder');
  assert.deepEqual(report.results.map((r) => [r.kind, r.target.replace(base, '~'), r.seen, r.refused]), [
    ['connect', '~/run-user/docker.sock', 'ECONNREFUSED', true],
    ['connect', '~/run-user/bus', 'ECONNREFUSED', true],
    ['connect', '~/run-user/docker/containerd/containerd.sock', 'ECONNREFUSED', true],
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

test("acceptance: a tree's tar stream is refused only for the instance id, the hints or an applied test-patch run, and never says which", () => {
  // The test patch: a context line, a 3-line helper the base tree already holds (moved, say), and the new test.
  const helper = ['def helper_rows_SHAREDRUN():', '    return [(2, 3), (4, 1), (7, 0)]', '    # the rows every total test starts from'];
  const hunk = ['def test_negative_quantities_are_skipped_TESTMARK():', '    items = [(5, -1), (3, 2)]', '    assert total(items) == 6'];
  const test_patch = ['diff --git a/tests/test_price.py b/tests/test_price.py', '--- a/tests/test_price.py', '+++ b/tests/test_price.py', '@@ -1,2 +1,9 @@', ' def test_plain_totals_PASSMARK():', ...helper.map((l) => `+${l}`), '+', ...hunk.map((l) => `+${l}`), ''].join('\n');
  const row: TaskRow = { ...ROW, test_patch };
  const base = Buffer.from(`tests/test_price.py\0def test_plain_totals_PASSMARK():\n    pass\n\0\0tests/helpers.py\0${helper.join('\n')}\n`);
  const d = fakeDocker();
  const r = new TaskRunner(d.opts, C, row, base);
  const tar = (file: string, text: string) => Buffer.concat([base, Buffer.from(`${file}\0${text}`)]);
  // What an agent may well write itself goes through.
  for (const [what, file, text] of [
    ['an honest change', 'src/price.py', 'def total(items):\n    return 0\n'],
    ['its own fix, identical to the gold line', 'src/price.py', 'def total(items):\n    return sum(c * q for c, q in items if q > 0)  # GOLDMARK_7731\n'],
    ["its own test, with the upstream test's name", 'tests/test_neg.py', 'def test_negative_quantities_are_skipped_TESTMARK():\n    assert total([(5, -1)]) == 0\n'],
    ['two of the test patch lines in a row, then its own', 'tests/test_neg.py', `${hunk[0]}\n${hunk[1]}\n    assert total(items) == 5\n`],
    ['a FAIL_TO_PASS id in a comment', 'tests/notes.py', '# tests/test_price.py::test_negative_quantities_are_skipped_TESTMARK\n'],
    ['the 3-line helper the base tree already holds', 'tests/test_price.py', `${helper.join('\n')}\n`],
  ] as const) {
    const before = d.sent.length;
    r.syncTree('/work/t', tar(file, text));
    assert.equal(d.sent.length, before + 1, `${what}: sent`);
  }
  // What only a driver bug would carry: refused, nothing sent, and the same words whatever matched.
  const said = new Set<string>();
  for (const [what, file, text] of [
    ['the applied test-patch hunk', 'tests/test_price.py', `def test_plain_totals_PASSMARK():\n    pass\n\n${hunk.join('\n')}\n`],
    ['the hunk as the first lines of a new file', 'tests/test_new.py', `${hunk.join('\n')}\n`],
    ['the hunk with CRLF line ends', 'tests/test_new.py', `${hunk.join('\r\n')}\r\n`],
    ['the hints', 'NOTES.txt', 'HINTMARK: look at the generator in price.py\n'],
    ['the instance id', 'src/price.py', '# from example__proj-4242\n'],
  ] as const) {
    const before = d.sent.length;
    assert.throws(() => r.syncTree('/work/t', tar(file, text)), (e: Error) => (said.add(e.message), /input carries hidden task content/.test(e.message)), what);
    assert.equal(d.sent.length, before, `${what}: nothing sent`);
  }
  assert.equal(said.size, 1, 'one message for every refusal');
  for (const field of ['patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints', 'instance', 'test']) assert.ok(![...said][0]!.includes(field), `the refusal names no field (${field})`);
  // No base tree: a task's input is refused outright.
  assert.throws(() => new TaskRunner(d.opts, C, row, undefined as unknown as Buffer).syncTree('/work/t', base), /checked against its base tree, and there is none/);
});

/** Whether a task's syncTree of `stream` was sent (true) or refused with STDIN_REFUSED and nothing sent (false). */
function stdinSends(row: TaskRow, base: Buffer, stream: Buffer): boolean {
  const d = fakeDocker();
  try {
    new TaskRunner(d.opts, C, row, base).syncTree('/work/t', stream);
  } catch (e) {
    assert.equal((e as Error).message, STDIN_REFUSED);
    assert.equal(d.sent.length, 0, 'nothing sent');
    return false;
  }
  assert.equal(d.sent.length, 1);
  return true;
}
const STDIN_BASE = Buffer.from('tests/test_price.py\0def test_plain_totals_PASSMARK():\n    pass\n');
/** The base tree's stream plus one more file, in the stand-in's form: name, NUL, text. */
const withFile = (file: string, text: string) => Buffer.concat([STDIN_BASE, Buffer.from(`\0\0${file}\0${text}`)]);
const STDIN_HUNK = ['def test_negative_quantities_are_skipped_TESTMARK():', '    items = [(5, -1), (3, 2)]', '    assert total(items) == 6'];
/** A test patch that adds `added` after the base's first test. */
const testPatch = (added: readonly string[]) => ['diff --git a/tests/test_price.py b/tests/test_price.py', '--- a/tests/test_price.py', '+++ b/tests/test_price.py', `@@ -1,2 +1,${added.length + 2} @@`, ' def test_plain_totals_PASSMARK():', ...added, ''].join('\n');
const HUNK_ROW: TaskRow = { ...ROW, test_patch: testPatch(['+', ...STDIN_HUNK.map((l) => `+${l}`)]) };

test('stdin: the test patch written into the tree as a .diff file (LF) is refused', () => {
  assert.equal(stdinSends(HUNK_ROW, STDIN_BASE, withFile('hidden/test.diff', HUNK_ROW.test_patch)), false);
  // The base exemption holds for the diff form too: a base tree that already ships that .diff file.
  const base = Buffer.concat([STDIN_BASE, Buffer.from(`\0\0docs/example.diff\0${HUNK_ROW.test_patch}`)]);
  assert.equal(stdinSends(HUNK_ROW, base, Buffer.concat([base, Buffer.from(`\0\0hidden/test.diff\0${HUNK_ROW.test_patch}`)])), true);
});

test('stdin: the test patch written into the tree as a .diff file with CRLF line ends is refused', () => {
  assert.equal(stdinSends(HUNK_ROW, STDIN_BASE, withFile('hidden/test.diff', HUNK_ROW.test_patch.replace(/\n/g, '\r\n'))), false);
});

test("stdin: an agent's own test file that starts with a new test file's imports is sent; imports with code are refused", () => {
  // A new upstream test file whose first lines are imports, one of them in parentheses.
  const imports = ['import pytest', 'from price import total, subtotal', 'from price.models import (', '    ItemWithDiscount,', '    BasketOfItems,', ')'];
  const tests = ['def test_items_are_counted_TESTMARK():', '    assert subtotal([ItemWithDiscount(1)]) == 1'];
  const newFile = ['diff --git a/tests/test_items.py b/tests/test_items.py', 'new file mode 100644', '--- /dev/null', '+++ b/tests/test_items.py', '@@ -0,0 +1,9 @@', ...[...imports, '', ...tests].map((l) => `+${l}`), ''].join('\n');
  const rowImports: TaskRow = { ...ROW, test_patch: newFile };
  assert.equal(stdinSends(rowImports, STDIN_BASE, withFile('tests/test_mine.py', `${imports.join('\n')}\n\n\ndef test_mine():\n    assert total([]) == 0\n`)), true, "the agent's own test file, with the same imports: sent");
  assert.equal(stdinSends(rowImports, STDIN_BASE, withFile('tests/test_items.py', `${imports.join('\n')}\n\n${tests.join('\n')}\n`)), false, 'the applied file, imports and its test: refused');
  // A 3-line hunk of an import and code is still the test patch.
  const mixed = ['from price import subtotal', 'def test_subtotal_of_nothing_TESTMARK():', '    assert subtotal([]) == 0'];
  const rowMixed: TaskRow = { ...ROW, test_patch: testPatch(mixed.map((l) => `+${l}`)) };
  assert.equal(stdinSends(rowMixed, STDIN_BASE, withFile('tests/test_sub.py', `${mixed.join('\n')}\n`)), false, 'an import then code: refused');
});

test("stdin: a blank context line in the test patch doesn't end a run", () => {
  // Two 2-line blocks split by a blank context line (written as a space, or stripped to nothing): one run once applied.
  const two = ['def test_a_new_case_one():', '    assert total([(1, 1)]) == 1', 'def test_b_new_case_two():', '    assert total([(2, 2)]) == 4'];
  for (const blank of [' ', '']) {
    const rowBlank: TaskRow = { ...ROW, test_patch: testPatch([`+${two[0]}`, `+${two[1]}`, blank, `+${two[2]}`, `+${two[3]}`]) };
    assert.equal(stdinSends(rowBlank, STDIN_BASE, withFile('tests/test_price.py', `def test_plain_totals_PASSMARK():\n    pass\n${two[0]}\n${two[1]}\n\n${two[2]}\n${two[3]}\n`)), false, `split by a blank context line ${JSON.stringify(blank)}: refused`);
  }
});

/** An added hunk line whose text starts with "++ ": `+++ counter...` in the patch, as long as a header line. */
const PLUS_LINE = '++ counter_value_should_be_long_enough';

test('argv: an added test-patch line starting "++ " is a hidden piece; only the file name line after `--- ` is skipped (#797)', () => {
  const header = '++ b/tests/test_price.py';
  assert.ok(header.length >= 24, 'the name line would count as a piece if it were read as an added line');
  for (const [what, test_patch] of [
    ['LF', testPatch([`+${PLUS_LINE}`])],
    ['CRLF', testPatch([`+${PLUS_LINE}`]).replace(/\n/g, '\r\n')],
    ['after a removed line starting "-- "', testPatch(['--- old_counter_value_line', `+${PLUS_LINE}`])],
    ['the last line, no newline at its end', testPatch([`+${PLUS_LINE}`, '\\ No newline at end of file'])],
  ] as const) {
    const row: TaskRow = { ...ROW, test_patch };
    assert.ok(hiddenLeaks(`echo ${PLUS_LINE}`, row).includes('test_patch'), `${what}: the "++ " line is found`);
    assert.ok(!hiddenLeaks(`pytest ${header}`, row).includes('test_patch'), `${what}: the file name line is not a piece`);
  }
});

test('stdin: a test-patch run with an added line starting "++ " is refused, applied or as a .diff (#797)', () => {
  const run = ['def test_counter_render_TESTMARK():', '    assert render(2) == """', PLUS_LINE];
  const row: TaskRow = { ...ROW, test_patch: testPatch(run.map((l) => `+${l}`)) };
  assert.equal(stdinSends(row, STDIN_BASE, withFile('tests/test_render.py', `${run.join('\n')}\n`)), false, 'applied: refused');
  assert.equal(stdinSends(row, STDIN_BASE, withFile('hidden/test.diff', row.test_patch)), false, 'as a .diff: refused');
  assert.equal(stdinSends(row, STDIN_BASE, withFile('tests/test_render.py', `${run.slice(0, 2).join('\n')}\n`)), true, 'two of its lines: sent');
});

test('stdin: an open import paren goes on only through names or its `)`; a "++ " line or code ends it, so the run after is refused (#804)', () => {
  const run = ['EXPECTED = """', 'counter one two three four five', 'counter six seven eight nine'];
  const applied = withFile('tests/test_render.py', `${run.join('\n')}\n`);
  for (const [what, added] of [
    ['a stray "(" in an import\'s comment, then a "++ " line', ['from mod import helper  # wraps render(', PLUS_LINE, ...run]],
    ['an open "from mod import (", then a "++ " line', ['from mod import (', PLUS_LINE, ...run]],
    ['a stray "(" in an import\'s comment, then code', ['from mod import helper  # wraps render(', ...run]],
  ] as const) {
    const row: TaskRow = { ...ROW, test_patch: testPatch(added.map((l) => `+${l}`)) };
    assert.equal(stdinSends(row, STDIN_BASE, applied), false, `${what}: refused`);
  }
  // The names of an open paren still count as import lines: an agent's own file with the same imports is sent.
  const imports = ['from price.models import (', '    ItemWithDiscount,', '    BasketOfItems as Basket,  # the two kinds', ')'];
  const rowImports: TaskRow = { ...ROW, test_patch: testPatch(imports.map((l) => `+${l}`)) };
  assert.equal(stdinSends(rowImports, STDIN_BASE, withFile('tests/test_mine.py', `${imports.join('\n')}\n`)), true, 'names in an open paren: sent');
});

test("stdin: a line is an import line only if 682c8ce5's rule says so too; `\\` continuations can't hide a run it refused (#804)", () => {
  for (const [what, added] of [
    ['R1: a `\\` import, then a "++ " line ending in `\\`', ['import a, \\', '++ counter_value_should_be_long \\', 'first_line_of_the_hidden \\', 'second_line_of_the_hidden \\', 'third_line_of_the_hidden']],
    ['R2: an open paren, an import ending in `\\`, then `)  \\`', ['from m import (', 'import a, \\', ')  \\', 'counter one two three four five']],
    ['R2b: an open paren, code, an import ending in `\\`, then `b) \\`', ['from m import (', 'x = 1', 'import a, \\', 'b) \\', 'counter one two three four five']],
  ] as const) {
    const row: TaskRow = { ...ROW, test_patch: testPatch(added.map((l) => `+${l}`)) };
    assert.equal(stdinSends(row, STDIN_BASE, withFile('tests/test_r.py', `${added.slice(-3).join('\n')}\n`)), false, `${what}: refused`);
  }
});

test('stdin: a `+++ ` line with no name after `--- ` is an added line, as before #797 (#804)', () => {
  const two = ['counter one two three four five', 'counter six seven eight nine'];
  const row: TaskRow = { ...ROW, test_patch: ['diff --git a/t b/t', '--- a/t', '+++ ', ...two.map((l) => `+${l}`), ''].join('\n') };
  assert.equal(stdinSends(row, STDIN_BASE, withFile('tests/t.txt', `++\n${two.join('\n')}\n`)), false, 'refused');
});

test('stdin: a run that ends a tar member of exactly 512 bytes, with no trailing newline, is refused', () => {
  // A real ustar stream: the file's last line would otherwise run into the next header's name.
  const header = (name: string, size: number) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write('ustar\x0000', 257);
    return h;
  };
  const block = (text: string) => Buffer.concat([Buffer.from(text), Buffer.alloc((512 - (Buffer.byteLength(text) % 512)) % 512)]);
  const ustar = (files: readonly (readonly [string, string])[]) => Buffer.concat([...files.flatMap(([n, t]) => [header(n, Buffer.byteLength(t)), block(t)]), Buffer.alloc(1024)]);
  const tail = STDIN_HUNK.join('\n');
  const full = `${'#'.repeat(512 - tail.length - 1)}\n${tail}`;
  assert.equal(Buffer.byteLength(full), 512);
  const base = ustar([['tests/test_price.py', 'def test_plain_totals_PASSMARK():\n    pass\n']]);
  assert.equal(stdinSends(HUNK_ROW, base, ustar([['tests/a.py', full], ['tests/b.py', 'x\n']])), false, 'a run ending a 512-byte file, then a header: refused');
  assert.equal(stdinSends(HUNK_ROW, base, ustar([['tests/a.py', `${STDIN_HUNK[0]}\n${STDIN_HUNK[1]}\n`], ['tests/b.py', 'x\n']])), true, 'two of its lines, then a header: sent');
});

test("a bench root through a link that doesn't resolve is refused; a dangling link at a credential place is followed", { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
  mkdirSync(join(home, '.claude'));
  symlinkSync(join(home, '.claude', 'not-yet'), join(home, 'bench'));
  assert.throws(() => benchRoot({}, home), /doesn't resolve/, '~/bench -> ~/.claude/not-yet (dangling)');
  assert.equal(existsSync(join(home, '.claude', 'not-yet')), false);
  symlinkSync(join(home, 'gone'), join(home, 'mid'));
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, 'mid', 'bench') }, home), /doesn't resolve/, 'a dangling link further up the root');
  symlinkSync(join(home, 'loop'), join(home, 'loop'));
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(home, 'loop', 'bench') }, home), /doesn't resolve/, 'a link loop');
  // ~/.ssh -> a folder that doesn't exist yet: a root there would become the credential store once it's created.
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'elsewhere-')));
  symlinkSync(join(elsewhere, 'ssh'), join(home, '.ssh'));
  assert.throws(() => benchRoot({ [BENCH_ROOT_ENV]: join(elsewhere, 'ssh', 'bench') }, home), /overlaps/, "a root where a dangling ~/.ssh points");
  assert.equal(benchRoot({ [BENCH_ROOT_ENV]: join(elsewhere, 'bench') }, home).root, join(elsewhere, 'bench'));
});

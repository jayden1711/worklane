// The gated-merge benchmark (#748, Phase 0). No model call, no Docker, no download: claude is a stand-in script that
// answers with the CLI's own JSON shapes (auth status, --version, stream-json, a usage-limit result), and every path
// is under this test's temporary machine (test/isolate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { HELD_OUT_ENV } from '../src/held-out-paths.js';
import { CliRunner, type RetryOptions, type RunRequest } from '../src/runner.js';
import { BENCH_USER_ENV, BenchAgentRunner, CLAUDE_PIN_ENV, requireBenchUser, requireClaudePin, requireSubscription } from '../scripts/bench/auth.js';
import { capsFromArgs, type Caps } from '../scripts/bench/caps.js';
import { benchRoot, BENCH_ROOT_ENV } from '../scripts/bench/paths.js';
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

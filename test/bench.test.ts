// The gated-merge benchmark (#748, Phase 0). No model call, no Docker, no download: claude is a stand-in script that
// answers with the CLI's own JSON shapes (auth status, --version, stream-json, a usage-limit result), and every path
// is under this test's temporary machine (test/isolate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { HELD_OUT_ENV } from '../src/held-out-paths.js';
import type { InstanceSettings } from '../src/instance.js';
import { currentUser } from '../src/os/index.js';
import { CliRunner, type RetryOptions, type RunRequest } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';
import { aggregate, wilson } from '../scripts/bench/aggregate.js';
import { assertResearchOff, BENCH_SETTINGS, runBench, type BenchOptions, type RunTask, type TaskResult } from '../scripts/bench/driver.js';
import { exportPatch, readPatches, writePredictions } from '../scripts/bench/grade.js';
import type { AgentRunner, RunResult } from '../src/runner.js';
import { MANIFEST, writeStore } from '../scripts/bench/store.js';
import { benchClaude, benchDenied, benchLane } from '../scripts/bench/agent.js';
import { sandboxProbe, type ProbeReport } from '../scripts/bench/probe.js';
import { agentBase, BENCH_USER_ENV, BenchAgentRunner, CLAUDE_PIN_ENV, requireBenchUser, requireClaudePin, requireSubscription } from '../scripts/bench/auth.js';
import { capsFromArgs, type Caps } from '../scripts/bench/caps.js';
import { checkDockerArgs, Docker, LIMIT_ENV, limitsFrom, LimitsNotApplied, makeArgs, STDIN_REFUSED, TaskRunner, type DockerCall, type Limits } from '../scripts/bench/container.js';
import { taskView, type TaskRow } from '../scripts/bench/hidden.js';
import { benchLayout, benchRoot, BENCH_ROOT_ENV } from '../scripts/bench/paths.js';
import { UsageMeter } from '../scripts/bench/usage.js';
import { confirmSandbox } from '../scripts/bench/confirm.js';
import { STDIN_LINE } from './helpers.js';

const posix = { skip: process.platform === 'win32' && 'POSIX stand-ins' };

const CAPS: Caps = { mode: 'smoke', spendUsd: 40, perTaskUsd: 15 };

/**
 * What check D's unparsed read (confirm.ts READ_JS) prints on a /dev/null mask. Written out, not imported, so these
 * tests load on code from before it; the node -e test below runs the real command and checks this is what it prints.
 */
const MASKED_TEXT = 'bench-check: masked, not a regular file';

/** A call the stand-in claude recorded. */
interface ClaudeCall {
  kind: 'version' | 'auth' | 'run' | 'check';
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
  /**
   * The sandbox confirmation's session: every command refused (default: each cat by the permission layer, each node -e
   * read by the OS sandbox's /dev/null mask), every read refused by the permission layer (`permission`), a sentinel's
   * content read (the sandbox let the read through), a socket's _ping answered OK, the model running nothing, or
   * (`gate`) the model's own chmod through globs first, then each node -e read failing EACCES.
   */
  sandboxCheck?: 'refused' | 'permission' | 'leak' | 'ping' | 'declined' | 'gate';
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
      // The driver's sandbox confirmation (confirm.ts): Claude Code running the listed commands in its sandbox.
      "const prompt = (() => { try { const c = JSON.parse(input).message.content; return typeof c === 'string' ? c : c.map((b) => b.text || '').join(''); } catch { return ''; } })();",
      "if (prompt.startsWith('This is a sandbox check')) {",
      "  log({ kind: 'check', args, env: process.env, settings, input });",
      "  const out = (l) => console.log(JSON.stringify(l));",
      "  out({ type: 'system', subtype: 'init', session_id: 'chk', output_style: settings.outputStyle });",
      `  const mode = ${JSON.stringify(o.sandboxCheck ?? 'refused')};`,
      "  const commands = prompt.split('\\n').filter((l) => /^\\d+\\. /.test(l)).map((l) => l.replace(/^\\d+\\. /, ''));",
      "  if (mode === 'declined') out({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will not run these commands.' }] } });",
      '  const denials = [];',
      // gate: the model first runs its own chmod through globs (naming no target), so each node -e read fails EACCES.
      "  if (mode === 'gate') {",
      "    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x0', name: 'Bash', input: { command: 'chmod 000 ~/.n* ~/.p* ~/.claude/.b*' } }] } });",
      "    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x0', content: '', is_error: false }] } });",
      '  }',
      "  if (mode !== 'declined') commands.forEach((command, i) => {",
      // The path is the command's last single-quoted word (node -e's script has quoted words of its own).
      "    const quoted = command.match(/'[^']+'/g) || [];",
      "    const path = (quoted[quoted.length - 1] || '').slice(1, -1);",
      "    const byPermission = command.startsWith('cat') ? mode === 'refused' || mode === 'permission' : command.startsWith('node') && mode === 'permission';",
      "    if (byPermission) denials.push({ tool_name: 'Bash', tool_use_id: 'c' + i, tool_input: { command } });",
      "    const result = mode === 'gate' ? (command.startsWith('node') ? \"Error: EACCES: permission denied, open '\" + path + \"'\" : 'error') : command.startsWith('curl') ? (mode === 'ping' ? 'OK' : \"curl: (7) Couldn't connect to server\") : mode === 'leak' ? fs.readFileSync(path, 'utf8') : byPermission ? 'Permission to use Bash with command ' + command + ' has been denied.' : " + JSON.stringify(MASKED_TEXT) + ';',
      "    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c' + i, name: 'Bash', input: { command } }] } });",
      "    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c' + i, content: result, is_error: mode === 'refused' || mode === 'permission' || mode === 'gate' } ] } });",
      '  });',
      "  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3, total_cost_usd: 0.02, usage: { input_tokens: 300, output_tokens: 40 }, permission_denials: denials });",
      '  process.exit(0);',
      '}',
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
  const first = meter.task(15, c.base);
  const r = await first.run(runReq(c.base));
  assert.equal(r.reason, 'rate_limited');
  assert.equal(c.calls('run').length, 1);
  assert.ok(meter.signal.aborted, 'every task in flight is told to stop');
  assert.match(meter.limited!.detail, /usage or rate limit/);
  assert.match(meter.limited!.reset_at ?? '', /^\d{4}-\d\d-\d\dT/, 'when claude said it resets (the engine reads it)');
  // The same task's next run and another task's: refused unstarted.
  for (const t of [first, meter.task(15, c.base)]) {
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
    const first = meter.task(15, c.base);
    const r = await first.run(runReq(c.base));
    assert.notEqual(r.reason, 'succeeded', what);
    assert.equal(c.calls('run').length, 1, `${what}: exactly one claude session`);
    assert.ok(meter.limited, `${what}: the meter stopped at the rate limit`);
    assert.match(meter.limited.detail, /429/, what);
    assert.ok(meter.signal.aborted, `${what}: every task in flight is told to stop`);
    for (const next of [first, meter.task(15, c.base), meter.task(15, c.base)]) {
      const again = await next.run(runReq(c.base, undefined, 'evaluator'));
      assert.match(again.detail, /not started: the bench stopped at a usage limit/, `${what}: the rest are not run`);
    }
    assert.equal(c.calls('run').length, 1, `${what}: one session in all`);
  }
});

test("usage is the CLI's own accounting, capped per task and for the whole run", posix, async () => {
  const c = fakeClaude();
  const meter = new UsageMeter(new BenchAgentRunner(new CliRunner('cli', c.env, c.bin)), 3);
  const t = meter.task(2, c.base);
  const caps: number[] = [];
  const spy = new UsageMeter({ run: async (req) => (caps.push(req.maxBudgetUsd), { reason: 'succeeded', detail: '', costUsd: 1.25, turns: 1, model: req.model }) }, 3).task(2, c.base);
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

test('the task runner sends docker exec into its own container only, with no mount flag; containers mount nothing', async () => {
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
  await new TaskRunner(d.opts, C, ROW, Buffer.from('')).syncTree('/work/t', Buffer.from('tar'));
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

test('acceptance: the hidden fields never reach a container', async () => {
  const view = JSON.stringify(taskView(ROW, 't01'));
  for (const mark of MARKS) assert.ok(!view.includes(mark), `the task view has no ${mark}`);
  const d = fakeDocker();
  const docker = new Docker(d.opts, LIMITS);
  docker.start(C, ROW);
  const r = new TaskRunner(d.opts, C, ROW, Buffer.from(''));
  // A buggy caller that hands the container a hidden test name, or the gold line in a variable: refused, nothing sent.
  const before = d.sent.length;
  await assert.rejects(r.exec('/work/t', ['python', '-m', 'pytest', 'tests/test_price.py::test_negative_quantities_are_skipped_TESTMARK']), /hidden FAIL_TO_PASS/);
  await assert.rejects(r.exec('/work/t', ['true'], { FIX: 'return sum(c * q for c, q in items if q > 0)  # GOLDMARK_7731' }), /hidden patch/);
  await assert.rejects(r.exec('/work/t', ['echo', 'example__proj-4242']), /hidden instance_id/);
  assert.equal(d.sent.length, before, 'nothing reached docker');
  await r.exec('/work/t', ['python', '-m', 'pytest', '-v', 'tests/test_price.py']);
  assert.equal(d.sent.length, before + 1, 'the honest command went through');
  const seen = JSON.stringify(d.sent);
  for (const mark of MARKS) assert.ok(!seen.includes(mark), `no docker command carried ${mark}`);
});

/** A bench machine for the driver: a stand-in claude and docker, a layout, and the driver's options. */
function machine(o: FakeClaude & FakeDocker & { srt?: 'honors' | 'none' } = {}) {
  const c = fakeClaude(o);
  const d = fakeDocker(o);
  const layout = benchLayout(join(c.base, 'bench'));
  const runtime = join(c.base, 'run-user');
  const env: NodeJS.ProcessEnv = { ...c.env, XDG_RUNTIME_DIR: runtime, DOCKER_HOST: `unix://${runtime}/docker.sock`, [BENCH_USER_ENV]: currentUser() };
  const laneInput = { home: c.home, runtimeDir: runtime, heldOut: layout.heldOut, state: layout.state, dockerHost: env.DOCKER_HOST, dataHome: undefined };
  const lane = benchLane(laneInput);
  const srt = fakeSrt(o.srt ?? 'honors', '0.0.79', c.base);
  const opts = (runTask: RunTask, over: Partial<BenchOptions> = {}): BenchOptions => ({
    layout,
    runId: 'r1',
    caps: CAPS,
    limits: LIMITS,
    tasks: ['t01', 't02', 't03'].map((key) => ({ key, row: ROW, image: 'swebench/example:latest' })),
    preflight: { benchUser: () => requireBenchUser(env), claudePin: () => requireClaudePin(env, c.bin), subscription: () => requireSubscription(env, c.bin, c.home), sandboxProbe: () => sandboxProbe({ ...laneInput, settings: lane.settings, srt }) },
    runner: benchClaude(env, c.bin, lane),
    lane: { ...laneInput, settings: lane.settings },
    docker: { ...d.opts, env },
    baseTree: () => Buffer.from(''),
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
  await ctx.exec.exec('/work/t', ['python', '-m', 'pytest', '-v', 'tests/test_price.py']);
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
  for (const caps of [undefined, { ...CAPS, spendUsd: 0 }, { ...CAPS, spendUsd: 41 }, { ...CAPS, perTaskUsd: 16 }, { ...CAPS, spendUsd: Infinity }]) {
    await assert.rejects(runBench(m.opts(engineTask, { caps: caps as Caps })), /spend cap|over the owner's approval/);
  }
  // What every object inherits is no mode: each would have had no ceiling at all.
  for (const mode of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(runBench(m.opts(engineTask, { caps: { mode, spendUsd: 5000, perTaskUsd: 15 } as unknown as Caps })), /over the owner's approval/, mode);
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
      await ctx.exec.exec('/work/t', ['python', '-m', 'pytest', 'tests/test_price.py::test_negative_quantities_are_skipped_TESTMARK']);
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

test('acceptance: patch export runs nothing the clone configures, and exports the real diff with a/ b/ prefixes', posix, () => {
  const base = mkdtempSync(join(tmpdir(), 'export-'));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=b@example.com', '-c', 'user.name=b', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q');
  writeFileSync(join(repo, 'price.py'), 'def total(items):\n    return sum(c * q for c, q in items)\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const baseSha = g('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'price.py'), 'def total(items):\n    return sum(c * q for c, q in items if q >= 0)\n');
  g('commit', '-qam', 'fix');
  const head = g('rev-parse', 'HEAD');
  // What an agent can plant in its clone: a textconv driver and the attribute that selects it, an external diff, an
  // fsmonitor and a pager command, and diff options that would change the patch's shape.
  const marker = join(base, 'PLANTED_COMMAND_RAN');
  const evil = join(base, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`);
  chmodSync(evil, 0o755);
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.py diff=evil\n');
  for (const [k, v] of [['diff.evil.textconv', evil], ['diff.external', evil], ['core.fsmonitor', evil], ['core.pager', evil], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']] as const) g('config', k, v);
  const layout = benchLayout(join(base, 'bench'));
  const f = exportPatch({ layout, runId: 'r1', key: 't01', label: 'final', repo, base: baseSha, head });
  assert.ok(!existsSync(marker), 'nothing the clone configured ran');
  const diff = readFileSync(f, 'utf8');
  assert.match(diff, /^diff --git a\/price\.py b\/price\.py\n/);
  assert.match(diff, /\n-    return sum\(c \* q for c, q in items\)\n\+    return sum\(c \* q for c, q in items if q >= 0\)\n/);
});

test('acceptance: the wall-clock cap ends every agent run and container command of a task, starts none after, and records the spend', posix, async () => {
  const m = machine();
  const t0 = performance.now();
  const log: string[] = [];
  // claude under the meter: a run lasts 1.5 s unless its request's signal aborts it (what CliRunner's killTree does).
  const inner: AgentRunner = {
    run: (req) =>
      new Promise<RunResult>((resolve) => {
        if (req.role === 'sandbox-check') return resolve({ reason: 'succeeded', detail: '', costUsd: 0, turns: 1, model: req.model });
        log.push(`start ${req.role}`);
        const done = (how: string) => {
          log.push(`end ${req.role}: ${how}`);
          resolve({ reason: how === 'killed' ? 'stopped' : 'succeeded', detail: how, costUsd: 1, turns: 1, model: req.model });
        };
        const timer = setTimeout(() => done('ran to the end'), 1500);
        req.signal?.addEventListener('abort', () => (clearTimeout(timer), done('killed')));
      }),
  };
  // A task that, as many loops would, passes no signal of its own.
  const task: RunTask = async (ctx) => {
    const r1 = await ctx.runner.run(runReq(ctx.workDir));
    const r2 = await ctx.runner.run(runReq(ctx.workDir, undefined, 'evaluator-after-cap'));
    return { decision: 'hold', heads: [], detail: `${r1.reason} / ${r2.reason}` };
  };
  const agg = await runBench(m.opts(task, { runner: inner, taskWallMs: 100 }));
  assert.ok(performance.now() - t0 < 1400, 'no run ran on to its end');
  assert.deepEqual(log, ['start worker', 'end worker: killed', 'start worker', 'end worker: killed', 'start worker', 'end worker: killed'], 'each run killed at the cap, none started after it, no overlap between tasks');
  assert.equal(agg.tasks.wall_cap_hit, 3);
  assert.equal(agg.usage.total, 3, "each killed run's spend recorded");
  assert.deepEqual(m.results().map((r) => r.runs.map((u) => u.role)), [['worker'], ['worker'], ['worker']]);
  // A command in the container: ended at the cap too, and none starts after it.
  const ended: string[] = [];
  const hang = (_d: string, _a: readonly string[], o: { signal?: AbortSignal }) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const timer = setTimeout(() => (ended.push('ran to the end'), resolve({ status: 0, stdout: '', stderr: '' })), 1500);
      o.signal?.addEventListener('abort', () => (clearTimeout(timer), ended.push('killed'), resolve({ status: null, stdout: '', stderr: 'killed' })));
    });
  const after: string[] = [];
  const execTask: RunTask = async (ctx) => {
    await ctx.exec.exec('/work/t', ['python', '-m', 'pytest', '-v', 'tests/test_price.py']);
    await ctx.exec.exec('/work/t', ['true']).catch((e: Error) => after.push(e.message));
    return { decision: 'hold', heads: [] };
  };
  const e = machine();
  const started = performance.now();
  await runBench(e.opts(execTask, { docker: { ...e.opts(execTask).docker, callAsync: hang }, taskWallMs: 100, tasks: [{ key: 't01', row: ROW, image: 'swebench/example:latest' }] }));
  assert.ok(performance.now() - started < 1400, 'the command did not run on');
  assert.deepEqual(ended, ['killed']);
  // The task itself runs on past the cap (only its runs and commands are stopped): give it a moment to try again.
  await new Promise((r) => setTimeout(r, 100));
  assert.match(after[0] ?? '', /wall-clock cap has passed/);
});

test("acceptance: the sandbox confirmation in Claude Code's own sandbox refuses the run on a sentinel read or a _ping OK", posix, async () => {
  // Every command refused: one model call on the cheapest pinned model, recorded; the sentinels gone after.
  const ok = machine();
  const agg = await runBench(ok.opts(engineTask));
  assert.equal(agg.sandbox?.confirmation.status, 'all refused');
  assert.equal(ok.calls('check').length, 1, 'one model call');
  const args = ok.calls('check')[0]!.args;
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(agg.usage.sandbox_check, 0.02, 'its usage recorded');
  const attempts = (agg.sandbox!.confirmation as unknown as { attempts: { kind: string; form: string; refused: boolean; layer: string }[] }).attempts;
  // Round 4: each sentinel is also read by node -e, which the permission layer doesn't parse; per attempt, which layer
  // stopped it (the stand-in: cat by the permission layer, node by the sandbox's /dev/null mask, curl with no marker).
  assert.deepEqual(attempts.map((a) => [a.kind, a.form, a.refused, a.layer]), [
    ...Array(5).fill(['connect', 'curl', true, 'unknown']),
    ...Array(4).fill(['read', 'cat', true, 'permission layer']),
    ...Array(4).fill(['read', 'node', true, 'OS sandbox']),
  ]);
  assert.equal((agg.sandbox!.confirmation as unknown as { os_sandbox_read_deny: boolean }).os_sandbox_read_deny, true);
  // Every read refused by the permission layer, node's too: all refused, but the sandbox's own read-deny unshown, said.
  const pl = machine({ sandboxCheck: 'permission' });
  const plSaid: string[] = [];
  const plAgg = await runBench(pl.opts(engineTask, { say: (l) => plSaid.push(l) }));
  assert.equal(plAgg.sandbox?.confirmation.status, 'all refused');
  assert.equal((plAgg.sandbox!.confirmation as unknown as { os_sandbox_read_deny: boolean }).os_sandbox_read_deny, false);
  assert.ok(plSaid.some((l) => /^WARNING: .*the OS sandbox's own read-deny was not shown.*rests on the srt probe/.test(l)), plSaid.join('\n'));
  for (const f of ['.claude.json', '.netrc', '.npmrc', '.pypirc']) assert.ok(!existsSync(join(ok.home, f)), `the ${f} sentinel removed`);
  assert.match(readFileSync(join(ok.layout.runs, 'r1', 'sandbox.json'), 'utf8'), /"status": "all refused"/);
  // A sentinel read, or the daemon answering: the run refused, no task started, the sentinels still removed.
  for (const [mode, why] of [['leak', /sentinel at .* was read/], ['ping', /_ping answered OK/]] as const) {
    const k = machine({ sandboxCheck: mode });
    await assert.rejects(runBench(k.opts(engineTask)), why, mode);
    assert.equal(k.calls('run').length, 0, `${mode}: no agent run`);
    assert.ok(!k.docker.some((s) => s.args[0] === 'run'), `${mode}: no task container`);
    for (const f of ['.claude.json', '.netrc', '.npmrc', '.pypirc']) assert.ok(!existsSync(join(k.home, f)), `${mode}: the ${f} sentinel removed`);
    assert.match(readFileSync(join(k.layout.runs, 'r1', 'sandbox.json'), 'utf8'), /"status": "leaked"/);
  }
});

test('the sandbox confirmation: a declining model leaves the srt probe as the guard, said plainly; real files are never touched', posix, async () => {
  const dk = machine({ sandboxCheck: 'declined' });
  const said: string[] = [];
  const agg = await runBench(dk.opts(engineTask, { say: (l) => said.push(l) }));
  assert.equal(agg.sandbox?.confirmation.status, 'model declined');
  assert.ok(said.some((l) => /^WARNING: sandbox confirmation: model declined .*sandbox-runtime 0\.0\.79: close to, not identical with, the build bundled in Claude Code 2\.1\.303/.test(l)), said.join('\n'));
  assert.equal(agg.complete, true, 'the srt probe passed, so the run went on');
  // Real files at protected paths: untouched, never put to the model; ~/.claude.json's sentinel goes under ~/.claude.
  const real = machine();
  writeFileSync(join(real.home, '.netrc'), 'machine example.com password REAL_NETRC_NEVER_READ\n');
  writeFileSync(join(real.home, '.claude.json'), '{"real":"REAL_LOGIN_FILE"}');
  const a = await runBench(real.opts(engineTask));
  assert.equal(readFileSync(join(real.home, '.netrc'), 'utf8'), 'machine example.com password REAL_NETRC_NEVER_READ\n');
  assert.equal(readFileSync(join(real.home, '.claude.json'), 'utf8'), '{"real":"REAL_LOGIN_FILE"}');
  const prompt = String((real.calls('check')[0] as unknown as { input: string }).input);
  assert.ok(!prompt.includes(join(real.home, '.netrc')) && !prompt.includes(`${join(real.home, '.claude.json')}'`), 'neither real file is put to the model');
  assert.ok(prompt.includes(join(real.home, '.claude', '.bench-sentinel-')), "~/.claude.json's stand-in sits under the login folder's rule");
  assert.deepEqual((a.sandbox!.confirmation as unknown as { skipped: { path: string }[] }).skipped.map((s) => s.path), [join(real.home, '.netrc')]);
  assert.equal(a.sandbox?.confirmation.status, 'all refused');
  assert.deepEqual(readdirSync(join(real.home, '.claude')), [], 'its sentinel removed');
  // The srt probe reaching a file: refused before any model call or container.
  const none = machine({ srt: 'none' });
  writeFileSync(join(none.home, '.claude.json'), '{}');
  await assert.rejects(runBench(none.opts(engineTask)), /from inside the agents' sandbox, .*\.claude\.json: opened file/);
  assert.equal(none.calls('check').length + none.calls('run').length, 0, 'no model call');
  assert.equal(none.docker.length, 0, 'docker never ran');
});

test("acceptance: a tree's tar stream is refused only for the instance id, the hints or an applied test-patch run, and never says which", async () => {
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
    await r.syncTree('/work/t', tar(file, text));
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
    await assert.rejects(r.syncTree('/work/t', tar(file, text)), (e: Error) => (said.add(e.message), /input carries hidden task content/.test(e.message)), what);
    assert.equal(d.sent.length, before, `${what}: nothing sent`);
  }
  assert.equal(said.size, 1, 'one message for every refusal');
  for (const field of ['patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints', 'instance', 'test']) assert.ok(![...said][0]!.includes(field), `the refusal names no field (${field})`);
  // No base tree: a task's input is refused outright.
  await assert.rejects(new TaskRunner(d.opts, C, row, undefined as unknown as Buffer).syncTree('/work/t', base), /checked against its base tree, and there is none/);
});

/** Whether a task's syncTree of `stream` was sent (true) or refused with STDIN_REFUSED and nothing sent (false). */
async function stdinSends(row: TaskRow, base: Buffer, stream: Buffer): Promise<boolean> {
  const d = fakeDocker();
  try {
    await new TaskRunner(d.opts, C, row, base).syncTree('/work/t', stream);
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

test('stdin: the test patch written into the tree as a .diff file (LF) is refused', async () => {
  assert.equal(await stdinSends(HUNK_ROW, STDIN_BASE, withFile('hidden/test.diff', HUNK_ROW.test_patch)), false);
  // The base exemption holds for the diff form too: a base tree that already ships that .diff file.
  const base = Buffer.concat([STDIN_BASE, Buffer.from(`\0\0docs/example.diff\0${HUNK_ROW.test_patch}`)]);
  assert.equal(await stdinSends(HUNK_ROW, base, Buffer.concat([base, Buffer.from(`\0\0hidden/test.diff\0${HUNK_ROW.test_patch}`)])), true);
});

test('stdin: the test patch written into the tree as a .diff file with CRLF line ends is refused', async () => {
  assert.equal(await stdinSends(HUNK_ROW, STDIN_BASE, withFile('hidden/test.diff', HUNK_ROW.test_patch.replace(/\n/g, '\r\n'))), false);
});

test("stdin: an agent's own test file that starts with a new test file's imports is sent; imports with code are refused", async () => {
  // A new upstream test file whose first lines are imports, one of them in parentheses.
  const imports = ['import pytest', 'from price import total, subtotal', 'from price.models import (', '    ItemWithDiscount,', '    BasketOfItems,', ')'];
  const tests = ['def test_items_are_counted_TESTMARK():', '    assert subtotal([ItemWithDiscount(1)]) == 1'];
  const newFile = ['diff --git a/tests/test_items.py b/tests/test_items.py', 'new file mode 100644', '--- /dev/null', '+++ b/tests/test_items.py', '@@ -0,0 +1,9 @@', ...[...imports, '', ...tests].map((l) => `+${l}`), ''].join('\n');
  const rowImports: TaskRow = { ...ROW, test_patch: newFile };
  assert.equal(await stdinSends(rowImports, STDIN_BASE, withFile('tests/test_mine.py', `${imports.join('\n')}\n\n\ndef test_mine():\n    assert total([]) == 0\n`)), true, "the agent's own test file, with the same imports: sent");
  assert.equal(await stdinSends(rowImports, STDIN_BASE, withFile('tests/test_items.py', `${imports.join('\n')}\n\n${tests.join('\n')}\n`)), false, 'the applied file, imports and its test: refused');
  // A 3-line hunk of an import and code is still the test patch.
  const mixed = ['from price import subtotal', 'def test_subtotal_of_nothing_TESTMARK():', '    assert subtotal([]) == 0'];
  const rowMixed: TaskRow = { ...ROW, test_patch: testPatch(mixed.map((l) => `+${l}`)) };
  assert.equal(await stdinSends(rowMixed, STDIN_BASE, withFile('tests/test_sub.py', `${mixed.join('\n')}\n`)), false, 'an import then code: refused');
});

test("stdin: a blank context line in the test patch doesn't end a run", async () => {
  // Two 2-line blocks split by a blank context line (written as a space, or stripped to nothing): one run once applied.
  const two = ['def test_a_new_case_one():', '    assert total([(1, 1)]) == 1', 'def test_b_new_case_two():', '    assert total([(2, 2)]) == 4'];
  for (const blank of [' ', '']) {
    const rowBlank: TaskRow = { ...ROW, test_patch: testPatch([`+${two[0]}`, `+${two[1]}`, blank, `+${two[2]}`, `+${two[3]}`]) };
    assert.equal(await stdinSends(rowBlank, STDIN_BASE, withFile('tests/test_price.py', `def test_plain_totals_PASSMARK():\n    pass\n${two[0]}\n${two[1]}\n\n${two[2]}\n${two[3]}\n`)), false, `split by a blank context line ${JSON.stringify(blank)}: refused`);
  }
});

test('stdin: a run that ends a tar member of exactly 512 bytes, with no trailing newline, is refused', async () => {
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
  assert.equal(await stdinSends(HUNK_ROW, base, ustar([['tests/a.py', full], ['tests/b.py', 'x\n']])), false, 'a run ending a 512-byte file, then a header: refused');
  assert.equal(await stdinSends(HUNK_ROW, base, ustar([['tests/a.py', `${STDIN_HUNK[0]}\n${STDIN_HUNK[1]}\n`], ['tests/b.py', 'x\n']])), true, 'two of its lines, then a header: sent');
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

/** A temporary bench user's home and its lane, for the sandbox confirmation on its own (no driver). */
function checkLane(withClaudeDir = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'confirm-')));
  const home = join(base, 'home');
  mkdirSync(home);
  if (withClaudeDir) mkdirSync(join(home, '.claude'));
  mkdirSync(join(base, 'run-user'));
  const input = { home, runtimeDir: join(base, 'run-user'), heldOut: join(base, 'held'), state: join(base, 'state'), dockerHost: undefined, dataHome: undefined };
  return { base, home, input, o: { ...input, settings: benchLane(input).settings } };
}

/** What Claude Code did with one listed command: the command it really ran, what came back, and whether as an error. */
type Answer = {
  command: string;
  output: string;
  is_error: boolean;
  /** listed in the result line's permission_denials */
  denied?: boolean;
  /** The Bash call's whole input (default: just the command). */
  input?: Record<string, unknown>;
} | null;

/**
 * A stand-in for the check's one model call: streams a Bash call and its result per listed command, then any `extra`
 * lines, then the result line (with its permission_denials), as stream-json has them.
 */
function checkRunner(answer: (command: string) => Answer, seen?: (req: RunRequest) => void, extra: unknown[] = []): AgentRunner {
  return {
    run: async (req) => {
      seen?.(req);
      const listed = req.prompt.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''));
      const denials: object[] = [];
      listed.forEach((c, i) => {
        const a = answer(c);
        if (!a) return;
        req.onStreamLine?.({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: a.input ?? { command: a.command } }] } });
        req.onStreamLine?.({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: a.output, is_error: a.is_error }] } });
        if (a.denied) denials.push({ tool_name: 'Bash', tool_use_id: `c${i}`, tool_input: { command: a.command } });
      });
      for (const l of extra) req.onStreamLine?.(l);
      req.onStreamLine?.({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3, total_cost_usd: 0.02, permission_denials: denials });
      return { reason: 'succeeded', detail: 'done', costUsd: 0.02, turns: 3, model: req.model };
    },
  };
}

const failsAsListed = (c: string): Answer => ({ command: c, output: 'Permission denied', is_error: true });

test('the sandbox confirmation never touches ~/.claude.json: its sentinel goes under ~/.claude/, or there is none', posix, async () => {
  for (const withClaudeDir of [true, false]) {
    const { home, o } = checkLane(withClaudeDir);
    const claudeJson = join(home, '.claude.json');
    let during: boolean | undefined;
    let prompt = '';
    const r = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(failsAsListed, (req) => ((during = existsSync(claudeJson)), (prompt = req.prompt))) });
    assert.equal(during, false, `~/.claude.json never exists while the model runs (~/.claude ${withClaudeDir ? 'there' : 'missing'})`);
    assert.equal(existsSync(claudeJson), false, 'nor after');
    assert.ok(!prompt.includes(`'${claudeJson}'`), '~/.claude.json itself is never put to the model');
    if (withClaudeDir) {
      assert.ok(prompt.includes(join(home, '.claude', '.bench-sentinel-')), 'its sentinel sits under ~/.claude/');
      assert.deepEqual(readdirSync(join(home, '.claude')), [], 'and is removed');
      assert.equal(r.status, 'all refused');
    } else {
      assert.deepEqual(r.skipped.map((s) => s.path), [claudeJson], 'no ~/.claude folder: no sentinel for it at all');
      assert.equal(existsSync(join(home, '.claude')), false);
    }
  }
});

test('the sandbox confirmation: refused only when the exact command failed; a command naming a target that exits 0 refuses the run', posix, async () => {
  const run = async (answer: (c: string) => Answer) => {
    const { home, o } = checkLane();
    return confirmSandbox({ ...o, cwd: home, runner: checkRunner(answer) });
  };
  assert.equal((await run(failsAsListed)).status, 'all refused', 'every listed command, exactly, failing');
  // The read or the connect worked, its output hidden or reshaped: each exits 0, so each is a leak.
  const altered: [string, (c: string) => string | null, string][] = [
    ["cat '<s>' > /dev/null && echo", (c) => (c.startsWith('cat ') ? `${c} > /dev/null && echo read-ok-but-hidden` : null), 'read-ok-but-hidden'],
    ["wc -c '<s>'", (c) => (c.startsWith('cat ') ? c.replace(/^cat /, 'wc -c ') : null), '48 sentinel'],
    ['curl -o /dev/null', (c) => (c.startsWith('curl ') ? c.replace(' http://', " -o /dev/null -w '%{http_code}' http://") : null), '200'],
  ];
  for (const [what, alter, output] of altered) {
    const r = await run((c) => {
      const a = alter(c);
      return a === null ? failsAsListed(c) : { command: a, output, is_error: false };
    });
    assert.equal(r.status, 'leaked', what);
    assert.ok(r.attempts.some((a) => a.result === 'reached'), `${what}: an attempt reached its target`);
    assert.match(r.detail, /did not fail/, what);
  }
  // The exact command, exiting 0 whatever it printed: a leak too.
  assert.equal((await run((c) => ({ command: c, output: '', is_error: false }))).status, 'leaked', 'the listed command exiting 0');
  // Failing commands that aren't the ones listed prove nothing either way: model declined.
  const loose = await run((c) => ({ command: c.replace(/'/g, '"'), output: 'Permission denied', is_error: true }));
  assert.equal(loose.status, 'model declined');
  assert.ok(loose.attempts.every((a) => a.result === 'not run'));
});

test('the sandbox confirmation removes its sentinels on SIGINT, SIGTERM and SIGHUP', { skip: process.platform === 'win32' && 'POSIX signals', timeout: 90_000 }, async () => {
  const { spawn } = await import('node:child_process');
  // SIGHUP (round 4): a terminal closed or an SSH session dropped during the check.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const { base, home, input } = checkLane();
    const script = join(base, 'hang.mjs');
    writeFileSync(
      script,
      [
        `import { confirmSandbox } from ${JSON.stringify(new URL('../scripts/bench/confirm.js', import.meta.url).href)};`,
        `import { benchLane } from ${JSON.stringify(new URL('../scripts/bench/agent.js', import.meta.url).href)};`,
        'const o = JSON.parse(process.argv[2]);',
        // A model call that never ends: what an interrupted check looks like.
        "const runner = { run: () => { console.log('asked'); setInterval(() => {}, 1000); return new Promise(() => {}); } };",
        'await confirmSandbox({ ...o, settings: benchLane(o).settings, runner, cwd: o.home });',
      ].join('\n') + '\n',
    );
    const child = spawn(process.execPath, [script, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ended = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on('exit', (code, signal) => r([code, signal])));
    let signal: NodeJS.Signals | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (b: Buffer) => String(b).includes('asked') && resolve());
        void ended.then(([code, s]) => reject(new Error(`the check ended before its model call: ${code} ${s}`)));
      });
      for (const f of ['.netrc', '.npmrc', '.pypirc']) assert.ok(existsSync(join(home, f)), `${sig}: the ${f} sentinel was in place`);
      assert.equal(readdirSync(join(home, '.claude')).length, 1, `${sig}: and the one under ~/.claude`);
      child.kill(sig);
      [, signal] = await ended;
    } finally {
      // Whatever failed above, the child (which never ends by itself) must not outlive the test.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    assert.equal(signal, sig, `${sig}: the signal still ends the process`);
    for (const f of ['.netrc', '.npmrc', '.pypirc', '.claude.json']) assert.ok(!existsSync(join(home, f)), `${sig}: no ${f} left`);
    assert.deepEqual(readdirSync(join(home, '.claude')), [], `${sig}: nothing left under ~/.claude`);
  }
});

test("acceptance: a task's agents get Edit, Write, MultiEdit and NotebookEdit only in the task's own folder; any other grant refuses the run", posix, async () => {
  // Through the driver: what claude is given, and what is refused before it starts.
  const m = machine();
  const outcomes: string[] = [];
  const task: RunTask = async (ctx) => {
    for (const allowedTools of [['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'], ['Read', 'Edit(//home/**)']]) {
      try {
        outcomes.push((await ctx.runner.run({ ...runReq(ctx.workDir, ctx.signal), allowedTools })).reason);
      } catch (e) {
        outcomes.push((e as Error).message);
      }
    }
    return { decision: 'hold', heads: [] };
  };
  await runBench(m.opts(task, { tasks: [{ key: 't01', row: ROW, image: 'swebench/example:latest' }] }));
  const workDir = join(m.layout.runs, 'r1', 't01');
  const runs = m.calls('run');
  assert.equal(runs.length, 1, 'the run with an outside grant never started');
  const args = runs[0]!.args;
  assert.ok(args.includes(`Edit(/${workDir}/**)`), `scoped to the task's folder: ${args.join(' ')}`);
  for (const bare of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(!args.includes(bare), `no bare ${bare}`);
  assert.equal(outcomes[0], 'succeeded');
  assert.match(outcomes[1] ?? '', /Edit\(\/\/home\/\*\*\).*file-writing tools run outside the sandbox/);
  // The meter itself, on fixtures: what passes and what is refused.
  const seen: string[][] = [];
  const inner: AgentRunner = { run: async (req) => (seen.push(req.allowedTools), { reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  // A real folder (round 5: a run's working folder is checked where it really is, so it must exist).
  const wd = taskFolder();
  const t = new UsageMeter(inner, 40).task(15, wd);
  await t.run({ ...runReq(wd), allowedTools: [`Edit(/${wd}/repo/**)`, `Edit(/${wd})`, 'Bash(git status)'] });
  assert.deepEqual(seen[0], [`Edit(/${wd}/repo/**)`, `Edit(/${wd})`, 'Bash(git status)']);
  for (const bad of ['Edit(//home/u/**)', 'Edit(~/.profile)', 'Edit(src/**)', `Edit(/${wd}/../t02/**)`, `Edit(/${wd}x/**)`, `Edit(/${wd}/*.py)`, `Write(/${wd}/**)`, 'Read,Edit', 'Read Write', 'Edit(//**)', 'Edit(*)', 'edit']) {
    await assert.rejects(t.run({ ...runReq(wd), allowedTools: ['Read', bad] }), /file-writing tools run outside the sandbox/, bad);
  }
  assert.equal(seen.length, 1, 'no refused run started');
});

/** A real task folder, `<tmp>/runs/r1/t01`, with a `repo` subfolder; its real path. */
function taskFolder(): string {
  const wd = join(realpathSync(mkdtempSync(join(tmpdir(), 'task-'))), 'runs', 'r1', 't01');
  mkdirSync(join(wd, 'repo'), { recursive: true });
  return wd;
}

test("round 4: a run's file-writing tools reach only its own working folder, which must be in the task's folder", async () => {
  const seen: { cwd: string; tools: string[] }[] = [];
  const inner: AgentRunner = { run: async (req) => (seen.push({ cwd: req.cwd, tools: req.allowedTools }), { reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const wd = taskFolder();
  const t = new UsageMeter(inner, 40).task(15, wd);
  // A run in a subfolder: a bare grant is scoped to that subfolder, not the whole task folder.
  await t.run({ ...runReq(`${wd}/repo`), allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] });
  assert.deepEqual(seen[0], { cwd: `${wd}/repo`, tools: ['Read', `Edit(/${wd}/repo/**)`] }, "scoped to the run's own working folder");
  await t.run({ ...runReq(`${wd}/repo`), allowedTools: [`Edit(/${wd}/repo/src/**)`] });
  assert.deepEqual(seen[1]?.tools, [`Edit(/${wd}/repo/src/**)`], 'a grant inside the working folder stays');
  // A grant in the task folder but outside the run's working folder: refused, unstarted.
  for (const bad of [`Edit(/${wd}/**)`, `Edit(/${wd}/remote.git/**)`, `Edit(/${wd})`, `Edit(/${wd}/repo/)`]) {
    await assert.rejects(t.run({ ...runReq(`${wd}/repo`), allowedTools: [bad] }), /file-writing tools run outside the sandbox/, bad);
  }
  // A working folder outside the task's folder, or not a plain absolute path: refused, whatever the tools.
  for (const cwd of [join(dirname(wd), 't02'), dirname(wd), `${wd}x`, `${wd}/../t02`, 'repo', `${wd}/repo/`]) {
    await assert.rejects(t.run({ ...runReq(cwd), allowedTools: ['Read'] }), /working folder/, cwd);
  }
  assert.equal(seen.length, 2, 'no refused run started');
});

test('round 4: a path put into a permission rule may hold no glob or rule character, nor end in a slash', async () => {
  const inner: AgentRunner = { run: async (req) => ({ reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const meter = new UsageMeter(inner, 40);
  for (const wd of ['/srv/b*/runs/r1/t01', '/srv/[b]ench/t01', '/srv/bench/t0?', '/srv/{a,b}/t01', '/srv/bench/t01/', '/srv/my bench/t01', '/srv/bench/(t01)', '/srv/bench/t01\\x', '/srv/!bench/t01']) {
    assert.throws(() => meter.task(15, wd), /task's folder/, wd);
  }
  const t = meter.task(15, '/srv/bench/runs/r1/t01');
  for (const cwd of ['/srv/bench/runs/r1/t01/re*po', '/srv/bench/runs/r1/t01/[r]epo', '/srv/bench/runs/r1/t01/a b']) {
    await assert.rejects(t.run({ ...runReq(cwd), allowedTools: ['Edit'] }), /working folder/, cwd);
  }
});

test('round 5: control characters are refused in a path put into a permission rule', async () => {
  const inner: AgentRunner = { run: async (req) => ({ reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const meter = new UsageMeter(inner, 40);
  for (const ch of ['\x00', '\x01', '\x1b', '\x1f', '\x7f']) {
    assert.throws(() => meter.task(15, `/srv/bench/t${ch}01`), /task's folder/, JSON.stringify(ch));
  }
  // In the run's working folder too, refused before anything starts (the folder exists, so only the character refuses).
  const wd = taskFolder();
  const t = meter.task(15, wd);
  for (const ch of ['\x01', '\x1b', '\x7f']) {
    const cwd = join(wd, `a${ch}b`);
    mkdirSync(cwd);
    await assert.rejects(t.run({ ...runReq(cwd), allowedTools: ['Edit'] }), /working folder/, JSON.stringify(ch));
  }
});

test("round 5: a run's working folder must really be inside its task's folder: a link out, a missing or unset cwd is refused", { skip: process.platform === 'win32' && 'POSIX links' }, async () => {
  const seen: string[] = [];
  const inner: AgentRunner = { run: async (req) => (seen.push(req.cwd), { reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-')));
  const task = join(base, 'task');
  const outside = join(base, 'outside');
  mkdirSync(task);
  mkdirSync(outside);
  // The reviewer's probe-scope cases: a cwd in the task folder that is a link out of it; a task folder that is a link.
  symlinkSync(outside, join(task, 'repo'));
  await assert.rejects(new UsageMeter(inner, 40).task(15, task).run({ ...runReq(join(task, 'repo')), allowedTools: ['Edit'] }), /working folder .* is really .*outside the task's folder/);
  symlinkSync(outside, join(base, 'tasklink'));
  mkdirSync(join(outside, 'repo'));
  const linked = new UsageMeter(inner, 40).task(15, join(base, 'tasklink'));
  for (const cwd of [join(base, 'tasklink'), join(base, 'tasklink', 'repo')]) {
    await assert.rejects(linked.run({ ...runReq(cwd), allowedTools: ['Edit'] }), /task's folder .* is really .*a task folder through a link is refused/, cwd);
  }
  // A missing cwd, and none at all (only a cast reaches this; no default is taken).
  const t = new UsageMeter(inner, 40).task(15, task);
  mkdirSync(join(task, 'real'));
  await assert.rejects(t.run({ ...runReq(join(task, 'gone')), allowedTools: ['Read'] }), /can't be resolved \(ENOENT\)/);
  await assert.rejects(t.run({ ...runReq(task), cwd: undefined as unknown as string, allowedTools: ['Read'] }), /working folder undefined/);
  assert.equal(seen.length, 0, 'none of these started');
  // A real folder inside: it runs.
  await t.run({ ...runReq(join(task, 'real')), allowedTools: ['Edit'] });
  assert.deepEqual(seen, [join(task, 'real')]);
});

/** A sentinel read's real outcome: the listed command run by bash, `from` swapped for `to` (a mask stand-in). */
function runListed(command: string, from?: string, to?: string): Answer {
  const r = spawnSync('bash', ['-c', from && to ? command.split(from).join(to) : command], { encoding: 'utf8', timeout: 30_000 });
  return { command, output: `${r.stdout}${r.stderr}`, is_error: r.status !== 0 };
}

test("round 4: check D's unparsed read (node -e, fstat): a /dev/null mask or a hidden file is the OS sandbox's refusal, a real read a leak", posix, async () => {
  const sentinelOf = (c: string) => /'([^']+)'$/.exec(c)?.[1] ?? '';
  // The sandbox's mask, as the srt probe sees it: the path opens /dev/null (a character device).
  const { base } = checkLane();
  const mask = join(base, 'masked');
  symlinkSync('/dev/null', mask);
  const nodeOrFail = (outcome: (c: string) => Answer) => (c: string) => (c.startsWith('node ') ? outcome(c) : failsAsListed(c));
  for (const [what, to] of [['masked with /dev/null', mask], ['hidden (ENOENT)', join(base, 'gone')]] as const) {
    const { home, o } = checkLane();
    const r = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(nodeOrFail((c) => runListed(c, sentinelOf(c), to))) });
    const unparsed = r.attempts.filter((a) => (a as { form?: string }).form === 'node');
    assert.equal(unparsed.length, 4, `${what}: one node -e read per sentinel`);
    for (const a of unparsed) {
      assert.equal(a.result, 'refused', `${what}: ${a.output}`);
      assert.equal((a as { layer?: string }).layer, 'OS sandbox', what);
    }
    if (to === mask) assert.ok(unparsed.every((a) => a.output.includes(MASKED_TEXT)), `the mask exits with ${MASKED_TEXT}`);
    assert.equal(r.status, 'all refused', what);
    assert.equal((r as { os_sandbox_read_deny?: boolean }).os_sandbox_read_deny, true, what);
    assert.match(r.detail, /the OS sandbox's own read-deny refused every unparsed read/, what);
  }
  // The read let through: node prints the sentinel and exits 0, a leak that refuses the run.
  const { home, o } = checkLane();
  const leak = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(nodeOrFail((c) => runListed(c))) });
  assert.equal(leak.status, 'leaked');
  assert.ok(leak.attempts.filter((a) => (a as { form?: string }).form === 'node').every((a) => a.result === 'reached'));
  assert.match(leak.detail, /was read/);
});

test("round 4: check D records which layer stopped each attempt, from the stream-json's markers only, failing closed", posix, async () => {
  const run = async (answer: (c: string) => Answer, extra: unknown[] = []) => {
    const { home, o } = checkLane();
    return confirmSandbox({ ...o, cwd: home, runner: checkRunner(answer, undefined, extra) });
  };
  const layers = (r: Awaited<ReturnType<typeof run>>, form: string) => r.attempts.filter((a) => (a as { form?: string }).form === form).map((a) => (a as { layer?: string }).layer);
  const p = await run((c) => ({ command: c, output: 'blocked', is_error: true, denied: c.startsWith('cat ') }));
  assert.deepEqual(layers(p, 'cat'), Array(4).fill('permission layer'), "the result line's permission_denials, matched by tool_use_id");
  assert.deepEqual(layers(p, 'node'), Array(4).fill('unknown'), 'an error with no marker is never the OS sandbox');
  assert.deepEqual(layers(p, 'curl'), Array(5).fill('unknown'), "curl failing can't tell the sandbox from a missing socket");
  assert.equal((p as { os_sandbox_read_deny?: boolean }).os_sandbox_read_deny, false);
  assert.match(p.detail, /4 by the permission layer, 0 by the OS sandbox, 9 by no layer shown; the OS sandbox's own read-deny was not shown/);
  const w = await run((c) => ({ command: c, output: `Permission to use Bash with command ${c} has been denied.`, is_error: true }));
  assert.deepEqual([...new Set([...layers(w, 'cat'), ...layers(w, 'node'), ...layers(w, 'curl')])], ['permission layer'], "the tool result's denial wording");
  const d = await run((c) => ({ command: c, output: "Permission to use Bash has been denied because Claude Code is running in don't ask mode.", is_error: true }));
  assert.deepEqual([...new Set(layers(d, 'cat'))], ['permission layer'], 'the dont-ask-mode wording');
  // cat really ran and the sandbox stopped it; node missing on the host: no OS sandbox claim for it.
  const s = await run((c) => (c.startsWith('cat ') ? { command: c, output: `cat: ${/'([^']+)'/.exec(c)?.[1]}: Permission denied`, is_error: true } : c.startsWith('node ') ? { command: c, output: 'bash: line 1: node: command not found', is_error: true } : failsAsListed(c)));
  assert.deepEqual(layers(s, 'cat'), Array(4).fill('OS sandbox'));
  assert.deepEqual(layers(s, 'node'), Array(4).fill('unknown'));
  // The exact node read never ran: the model declined it.
  const n = await run((c) => (c.startsWith('node ') ? null : failsAsListed(c)));
  assert.deepEqual(layers(n, 'node'), Array(4).fill('model declined'));
  assert.equal(n.status, 'model declined');
});

test('round 4: check D is "all refused" only when the model ran nothing but the listed commands', posix, async () => {
  const run = async (extra: unknown[]) => {
    const { home, o } = checkLane();
    return confirmSandbox({ ...o, cwd: home, runner: checkRunner(failsAsListed, undefined, extra) });
  };
  assert.equal((await run([])).status, 'all refused');
  // Every listed command refused, plus a read through $HOME that names no target and exits 0: not "all refused".
  const viaHome = await run([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'cat "$HOME/.netrc" > /dev/null' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: '', is_error: false }] } },
  ]);
  assert.equal(viaHome.status, 'model declined');
  assert.deepEqual((viaHome as { extra_calls?: string[] }).extra_calls, ['Bash: cat "$HOME/.netrc" > /dev/null']);
  // Any other tool too.
  const viaRead = await run([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x2', name: 'Read', input: { file_path: '/etc/hostname' } }] } }]);
  assert.equal(viaRead.status, 'model declined');
});

test('round 5: the model cannot set the "OS sandbox" layer: with any extra call, no attempt gets it and os_sandbox_read_deny is false', posix, async () => {
  // The reviewer's probe-gate case, on confirmSandbox: an extra chmod through globs (naming no target), then each
  // node -e read failing EACCES, which that chmod would cause.
  const { home, o } = checkLane();
  const extra = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x0', name: 'Bash', input: { command: 'chmod 000 ~/.n* ~/.p* ~/.claude/.b*' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x0', content: '', is_error: false }] } },
  ];
  const r = await confirmSandbox({ ...o, cwd: home, runner: checkRunner((c) => ({ command: c, output: c.startsWith('node ') ? `Error: EACCES: permission denied, open '${/'([^']+)'$/.exec(c)?.[1]}'` : 'error', is_error: true }), undefined, extra) });
  assert.equal(r.status, 'model declined');
  assert.ok(r.attempts.every((a) => (a as { layer?: string }).layer !== 'OS sandbox'), JSON.stringify(r.attempts.map((a) => (a as { layer?: string }).layer)));
  assert.equal((r as { os_sandbox_read_deny?: boolean }).os_sandbox_read_deny, false);
  // Through the driver: sandbox.json, results.json and the aggregate record the same.
  const m = machine({ sandboxCheck: 'gate' });
  const agg = await runBench(m.opts(engineTask));
  const dir = join(m.layout.runs, 'r1');
  for (const [where, c] of [
    ['sandbox.json', (JSON.parse(readFileSync(join(dir, 'sandbox.json'), 'utf8')) as { confirmation: Record<string, unknown> }).confirmation],
    ['results.json', (JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as { sandbox: { confirmation: Record<string, unknown> } }).sandbox.confirmation],
    ['the aggregate', agg.sandbox!.confirmation],
  ] as const) {
    assert.equal(c.status, 'model declined', where);
    assert.equal(c.os_sandbox_read_deny, false, where);
    assert.ok((c.attempts as { layer: string }[]).every((a) => a.layer !== 'OS sandbox'), where);
  }
});

test('round 5: a listed command sent with other Bash inputs is an extra call, not the listed command', posix, async () => {
  const withInputs = (more: Record<string, unknown>) => (c: string): Answer => ({ command: c, output: c.startsWith('node ') ? MASKED_TEXT : 'error', is_error: true, input: { command: c, ...more } });
  for (const more of [{ timeout: 1 }, { run_in_background: true }, { dangerouslyDisableSandbox: true }]) {
    const { home, o } = checkLane();
    const r = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(withInputs(more)) });
    assert.equal(r.status, 'model declined', JSON.stringify(more));
    assert.ok(r.attempts.every((a) => a.result === 'not run'), `${JSON.stringify(more)}: no attempt counts as the listed command`);
    assert.equal((r as { os_sandbox_read_deny?: boolean }).os_sandbox_read_deny, false);
  }
  // A description is fine: that is still the listed command.
  const { home, o } = checkLane();
  const d = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(withInputs({ description: 'sandbox check' })) });
  assert.equal(d.status, 'all refused');
});

test('round 5: a server_tool_use block counts as an extra call', posix, async () => {
  const { home, o } = checkLane();
  const r = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(failsAsListed, undefined, [{ type: 'assistant', message: { content: [{ type: 'server_tool_use', id: 's1', name: 'web_fetch', input: { url: 'http://localhost/' } }] } }]) });
  assert.equal(r.status, 'model declined');
  assert.deepEqual((r as { extra_calls?: string[] }).extra_calls, ['server_tool_use: web_fetch']);
});

test("round 6: no run starts in a folder nested with a running run's, so none can swap the other's folder before its spawn", { skip: process.platform === 'win32' && 'POSIX links' }, async () => {
  // The reviewer's probe-scope5 swap: while one of the task's runs is going (its sandboxed Bash may write its own
  // working folder), it swaps repo/sub for a link out. A run in repo/sub that had passed its check would then spawn
  // outside. Now that run is refused while the writer is going, and after it the link is refused at the check.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'swap-')));
  const task = join(base, 'task');
  const outside = join(base, 'outside');
  mkdirSync(join(task, 'repo', 'sub'), { recursive: true });
  mkdirSync(join(task, 'other'));
  mkdirSync(outside);
  const started: string[] = [];
  const outcomes: string[] = [];
  let t!: ReturnType<UsageMeter['task']>;
  const attempt = async (cwd: string) => {
    try {
      outcomes.push(`${cwd.slice(task.length) || '/'}: ${(await t.run({ ...runReq(cwd), allowedTools: ['Edit'] })).reason}`);
    } catch (e) {
      outcomes.push(`${cwd.slice(task.length) || '/'}: ${/nested with/.test((e as Error).message) ? 'refused (nested)' : (e as Error).message}`);
    }
  };
  const inner: AgentRunner = {
    run: async (req) => {
      started.push(req.cwd.slice(task.length) || '/');
      if (req.cwd === join(task, 'repo')) {
        // While this run is going: a run inside it, the same folder, one around it, and one beside it.
        await attempt(join(task, 'repo', 'sub'));
        await attempt(join(task, 'repo'));
        await attempt(task);
        await attempt(join(task, 'other'));
        // Its own command swaps repo/sub for a link out (what its sandboxed Bash may do in its working folder).
        renameSync(join(task, 'repo', 'sub'), join(task, 'repo', 'sub.old'));
        symlinkSync(outside, join(task, 'repo', 'sub'));
      }
      return { reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model };
    },
  };
  t = new UsageMeter(inner, 40).task(15, task);
  await attempt(join(task, 'repo'));
  assert.deepEqual(outcomes, ['/repo/sub: refused (nested)', '/repo: refused (nested)', '/: refused (nested)', '/other: succeeded', '/repo: succeeded']);
  assert.deepEqual(started, ['/repo', '/other'], 'no nested run ever reached the runner');
  // After the writer has ended: the swapped folder is a link out, refused at the check; nothing started there.
  await assert.rejects(t.run({ ...runReq(join(task, 'repo', 'sub')), allowedTools: ['Edit'] }), /outside the task's folder/);
  assert.deepEqual(started, ['/repo', '/other']);
});

test('round 6: a working folder reached through any link is refused, even one that stays inside the task folder', { skip: process.platform === 'win32' && 'POSIX links' }, async () => {
  const seen: string[] = [];
  const inner: AgentRunner = { run: async (req) => (seen.push(req.cwd), { reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const wd = taskFolder();
  symlinkSync(wd, join(wd, 'repo', 'up'));
  symlinkSync(join(wd, 'repo'), join(wd, 'alias'));
  const t = new UsageMeter(inner, 40).task(15, wd);
  for (const cwd of [join(wd, 'repo', 'up'), join(wd, 'alias'), join(wd, 'alias', 'up')]) {
    await assert.rejects(t.run({ ...runReq(cwd), allowedTools: ['Edit'] }), /through a link is refused/, cwd);
  }
  await t.run({ ...runReq(join(wd, 'repo')), allowedTools: ['Edit'] });
  assert.deepEqual(seen, [join(wd, 'repo')]);
});

test('round 6: a Bash call counts as a listed command only with a string command and no description or a string one', posix, async () => {
  const shaped = (input: (c: string) => Record<string, unknown>) => (c: string): Answer => ({ command: c, output: 'InputValidationError', is_error: true, input: input(c) });
  for (const [what, input] of [
    ['command an array', (c: string) => ({ command: [c] })],
    ['description a number', (c: string) => ({ command: c, description: 5 })],
    ['description null', (c: string) => ({ command: c, description: null })],
    ['command a number', () => ({ command: 7 })],
  ] as const) {
    const { home, o } = checkLane();
    const r = await confirmSandbox({ ...o, cwd: home, runner: checkRunner(shaped(input)) });
    assert.equal(r.status, 'model declined', what);
    assert.ok(r.attempts.every((a) => a.result === 'not run'), `${what}: nothing counts as the listed command run`);
  }
  // A string description is still the listed command.
  const { home, o } = checkLane();
  assert.equal((await confirmSandbox({ ...o, cwd: home, runner: checkRunner(shaped((c) => ({ command: c, description: 'check' }))) })).status, 'all refused');
});

test('round 6: C1 control and format characters are refused in a path put into a permission rule', () => {
  const inner: AgentRunner = { run: async (req) => ({ reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const meter = new UsageMeter(inner, 40);
  for (const ch of ['\x80', '\x85', '\x9b', '\x9f', '​', '‍', '‮', '⁦', '­', '﻿']) {
    assert.throws(() => meter.task(15, `/srv/bench/t${ch}01`), /task's folder/, JSON.stringify(ch));
  }
  // A lone surrogate (no file name on disk holds it as written) too.
  assert.throws(() => meter.task(15, '/srv/bench/t\ud80001'), /task's folder/, 'a lone surrogate');
  // Other non-ASCII letters are not refused.
  assert.doesNotThrow(() => meter.task(15, '/srv/bench/tâche-01'));
});

test("round 6: no run starts strictly inside an ended run's working folder (a process it left could still write there)", async () => {
  const seen: string[] = [];
  const inner: AgentRunner = { run: async (req) => (seen.push(req.cwd), { reason: 'succeeded', detail: '', costUsd: 0.1, turns: 1, model: req.model }) };
  const wd = taskFolder();
  mkdirSync(join(wd, 'repo', 'sub'));
  mkdirSync(join(wd, 'other'));
  const t = new UsageMeter(inner, 40).task(15, wd);
  await t.run({ ...runReq(join(wd, 'repo')), allowedTools: ['Edit'] });
  await t.run({ ...runReq(join(wd, 'repo')), allowedTools: ['Edit'] });
  await assert.rejects(t.run({ ...runReq(join(wd, 'repo', 'sub')), allowedTools: ['Edit'] }), /inside .*the working folder of an earlier run of this task/);
  // Around it: allowed (no earlier run can write a parent of the task folder); after that, anything inside it is refused.
  await t.run({ ...runReq(wd), allowedTools: ['Edit'] });
  await assert.rejects(t.run({ ...runReq(join(wd, 'other')), allowedTools: ['Edit'] }), /earlier run/, 'now inside the task-folder run');
  assert.deepEqual(seen, [join(wd, 'repo'), join(wd, 'repo'), wd]);
});

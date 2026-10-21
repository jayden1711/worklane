// #701 / #702 step 5: the golden no-change test. The runner seam and the executor seam move how an agent run is
// started (src/runner.ts, src/cli-agents.ts) without changing what it is started with. This file pins exactly that,
// for fixed requests: each process the runners start (claude, sudo, codex, gemini), with its argv (--settings
// parsed), its whole environment, its working directory and the first line it reads on stdin. A refactor that
// changes any of them, by one byte, fails here. Order is pinned wherever it can matter: argv, and the `env -i` list
// sudo gets. It isn't for an object's keys (--settings, a spawn's environment), which nothing reads in order.
//
// INVARIANT: no host tool can run. Every program the runners start, by name or through sudo, is a stand-in in one
// directory, and that directory is this process's whole PATH and every run's. The stand-ins exec nothing; they record
// and answer.
import { STDIN_LINE, allowProviderHosts, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSettingsPath, guardrailSettings, HOOK_MARKER } from '../src/agent-settings.js';
import { BRAND } from '../src/brand.js';
import { CliAgentRunner } from '../src/cli-agents.js';
import { CliRunner, type RunAs, type RunRequest } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';

const skip = process.platform !== 'linux' && 'the stand-ins and sudo paths are pinned on Linux, where CI runs';

/** The stand-ins' directory: this process's whole PATH, so nothing the runners start by name is a real program. */
const bin = mkdtempSync(join(tmpdir(), 'golden-bin-'));
const LOG = join(bin, 'log.jsonl');
const AUTH = join(bin, 'auth-method');
const STAND_IN = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
let prog = name;
let args = argv;
if (name === 'sudo') {
  // sudo -n -u <user> -- /usr/bin/env -i K=V... <file> <args>: the program it would start, never started.
  const rest = argv.slice(argv.indexOf('--') + 1);
  let i = rest[0] === '/usr/bin/env' && rest[1] === '-i' ? 2 : 0;
  while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i])) i++;
  prog = path.basename(rest[i] || '');
  args = rest.slice(i + 1);
}
const run = (prog === 'claude' && args[0] !== 'auth') || prog === 'codex' || prog === 'gemini';
const stdin = run ? ${STDIN_LINE} : null;
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ name, argv, env: process.env, cwd: process.cwd(), stdin }) + '\\n');
const say = (o) => console.log(JSON.stringify(o));
if (prog === 'claude' && args[0] === 'auth') say({ loggedIn: true, authMethod: fs.readFileSync(${JSON.stringify(AUTH)}, 'utf8').trim() });
else if (prog === 'claude') {
  const at = args.indexOf('--settings');
  const s = at >= 0 ? JSON.parse(args[at + 1]) : null;
  say({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [], plugins: [], output_style: (s && s.outputStyle) || 'default' });
  say({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 });
} else if (prog === 'codex') {
  say({ type: 'thread.started', thread_id: 't' });
  say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } });
  say({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else if (prog === 'gemini') {
  say({ type: 'init', session_id: 's', model: 'gemini-x' });
  say({ type: 'message', role: 'assistant', content: 'done' });
  say({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1 } });
}
process.exit(0);
`;
for (const n of ['claude', 'sudo', 'codex', 'gemini']) {
  writeFileSync(join(bin, n), STAND_IN);
  chmodSync(join(bin, n), 0o755);
}
// WHY: killTreeAs (src/os/index.ts) calls sudo with this process's own PATH; it must reach the stand-in too.
process.env.PATH = bin;

/** One case's directory, its stand-in log emptied and the login its claude reports set. */
function newCase(authMethod: string) {
  const root = mkdtempSync(join(tmpdir(), 'golden-case-'));
  for (const d of ['work', 'userhome', 'state', 'instance']) mkdirSync(join(root, d));
  // The task file fullRequest names, as the coordinator writes one: a run whose task file can't be read doesn't start (#890).
  writeFileSync(join(root, 'task.md'), JSON.stringify({ id: 'golden', done_when: [{ manual: 'x' }] }));
  // The work dir is a project, as every guarded run's is: one with no config folder doesn't start (#890), as its hook
  // would deny every call. Its secret_paths are empty, so the pinned --settings below gain nothing.
  cpSync(join(repoRoot, 'examples', 'basic', BRAND.configDir), join(root, 'work', BRAND.configDir), { recursive: true });
  const guardrails = join(root, 'work', BRAND.configDir, 'guardrails.yaml');
  writeFileSync(guardrails, readFileSync(guardrails, 'utf8').replace(/^secret_paths:\n(?: {2}- .*\n)+/m, 'secret_paths: []\n'));
  writeFileSync(LOG, '');
  writeFileSync(AUTH, authMethod);
  return root;
}

/**
 * The engine's environment: the variables an agent may get, and the ones it never may (a GitHub token, an API key,
 * a proxy, the SSH agent), each a fake value.
 */
const baseEnv = (root: string): NodeJS.ProcessEnv => ({
  PATH: bin,
  HOME: join(root, 'userhome'),
  USER: 'engine',
  LOGNAME: 'engine',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  TZ: 'UTC',
  TMPDIR: tmpdir(),
  GITHUB_TOKEN: 'test-github-token',
  GH_TOKEN: 'test-gh-token',
  ANTHROPIC_API_KEY: 'test-api-key-value',
  ANTHROPIC_AUTH_TOKEN: 'test-auth-token',
  HTTPS_PROXY: 'http://proxy.example.test:3128',
  SSH_AUTH_SOCK: '/run/ssh-agent.sock',
  AWS_SECRET_ACCESS_KEY: 'test-aws-secret',
  [`${BRAND.envPrefix}_STATE_DIR`]: '/var/lib/engine-state',
});

/** An instance's agent settings, written as install would (hooks on every guarded event, failing closed), read back as the service reads them. */
function guardrails(root: string) {
  const home = join(root, 'instance');
  const engine = join(root, 'engine.js');
  writeFileSync(engine, '');
  const hook = (event: string) => ({ hooks: [{ type: 'command', command: `E="${engine}"; if [ -f "$E" ]; then ${HOOK_MARKER} node "$E" ${event} || exit 2; elif [ "$${BRAND.envPrefix}_AGENT" = 1 ]; then echo "engine missing" >&2; exit 2; else :; fi` }] });
  const settings = {
    disableAllHooks: false,
    hooks: { PreToolUse: [hook('pre-tool-use')], SessionStart: [hook('session-start')], SessionEnd: [hook('session-end')] },
    permissions: { allow: ['Bash(npm test)'], deny: ['Read(//srv/secrets/**)'] },
  };
  writeFileSync(agentSettingsPath(home), JSON.stringify(settings), { mode: 0o600 });
  return () => guardrailSettings(home, 'shop', join(root, 'work'));
}

const identity = { name: 'engine-bot', email: 'engine-bot@example.com' };
const agentUser = (root: string): RunAs => ({ user: 'agent1', home: join(root, 'userhome') });

/** A request with every field the command line or the environment reads. */
const fullRequest = (root: string): RunRequest => ({
  role: 'worker',
  prompt: 'do the task',
  appendSystemPrompt: 'the role prompt',
  cwd: join(root, 'work'),
  model: 'opus',
  effort: 'high',
  allowedTools: ['Read', 'Bash'],
  disallowedTools: ['WebSearch'],
  maxTurns: 30,
  maxBudgetUsd: 2.5,
  jsonSchema: { type: 'object' },
  taskFile: join(root, 'task.md'),
  stateDir: join(root, 'state'),
  allowOnce: ['example.org'],
  env: { PROJECT_VAR: 'one' },
  resume: 'session-1',
  lane: 'default',
  stallMs: 60_000,
  timeoutMs: 60_000,
});

/** A plain request, for a provider or another vendor's CLI. */
const plainRequest = (root: string, model: string): RunRequest => ({ role: 'worker', prompt: 'do the task', cwd: join(root, 'work'), model, allowedTools: ['Read'], maxTurns: 10, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000 });

/**
 * What the stand-ins recorded, made the same on every machine and every run: the case's directory, this process's
 * temporary directory and a temporary directory's random suffix, the run's fresh settings check value, and the
 * product's name (so a rename keeps this file) each become a fixed word. Nothing else is touched.
 */
function recorded(root: string): unknown[] {
  const fix = (s: string) =>
    s
      .split(root)
      .join('<case>')
      .split(bin)
      .join('<bin>')
      .split(tmpdir())
      .join('<tmp>')
      .replace(/(<tmp>\/[A-Za-z0-9._-]*?-)[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, '$1XXXXXX')
      .replace(new RegExp(`${BRAND.cli}-settings-check-[0-9a-f]{16}`, 'g'), '<check>')
      .split(process.cwd())
      .join('<test-cwd>')
      .split(BRAND.envPrefix)
      .join('<PREFIX>')
      .split(BRAND.cli)
      .join('<cli>');
  const parsed = (argv: string[]) => argv.map((a, i) => (argv[i - 1] === '--settings' || argv[i - 1] === '--json-schema' ? JSON.parse(fix(a)) : fix(a)));
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l) as { name: string; argv: string[]; env: Record<string, string>; cwd: string; stdin: string | null };
      return { name: r.name, argv: parsed(r.argv), env: Object.fromEntries(Object.entries(r.env).map(([k, v]) => [fix(k), fix(v)])), cwd: fix(r.cwd), stdin: r.stdin === null ? null : fix(r.stdin) };
    });
}

function same(actual: unknown, golden: unknown): void {
  assert.deepEqual(actual, golden, `what the runner started changed; if that is intended, the PR says why and updates this file. Now:\n${JSON.stringify(actual, null, 2)}`);
}

// The golden values, as main starts them (recorded on 3e193c77). Shared parts are written once; every value is literal.
const hookCommand = (event: string) => `E="<case>/engine.js"; if [ -f "$E" ]; then <PREFIX>_HOOK=1 node "$E" ${event} || exit 2; elif [ "$<PREFIX>_AGENT" = 1 ]; then echo "engine missing" >&2; exit 2; else :; fi`;
const HOOKS = {
  // onFailure "block" (src/agent-settings.ts guardsFailClosed): added to every run's guard hook, settings written before it too.
  PreToolUse: [{ hooks: [{ type: 'command', command: hookCommand('pre-tool-use'), onFailure: 'block' }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('session-start') }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand('session-end') }] }],
};
const NO_ATTRIBUTION_PIN = { attribution: { commit: '', pr: '', sessionUrl: false }, includeCoAuthoredBy: false };
const STREAM_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const FIXED_FLAGS = ['--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'dontAsk'];
const PROMPT_LINE = '{"type":"user","message":{"role":"user","content":"do the task"}}';
/** What every agent's environment starts from: the allowed variables of the engine's, then the fixed agent ones. */
const AGENT_ENV = {
  PATH: '<bin>',
  HOME: '<case>/userhome',
  USER: 'engine',
  LOGNAME: 'engine',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  TMPDIR: '<tmp>',
  TZ: 'UTC',
  '<PREFIX>_AGENT': '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'false',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GH_CONFIG_DIR: '<tmp>/no-gh-XXXXXX',
  GIT_AUTHOR_NAME: 'engine-bot',
  GIT_AUTHOR_EMAIL: 'engine-bot@example.com',
  GIT_COMMITTER_NAME: 'engine-bot',
  GIT_COMMITTER_EMAIL: 'engine-bot@example.com',
  '<PREFIX>_ROLE': 'worker',
};
/** The full request's own variables, on top of AGENT_ENV. */
const FULL_REQUEST_ENV = {
  PROJECT_VAR: 'one',
  '<PREFIX>_TASK_FILE': '<case>/task.md',
  '<PREFIX>_PROJECT_STATE_DIR': '<case>/state',
  '<PREFIX>_ALLOW_HOSTS': 'example.org',
};
const FULL_REQUEST_SETTINGS_ENV = { '<PREFIX>_AGENT': '1', '<PREFIX>_ROLE': 'worker', '<PREFIX>_TASK_FILE': '<case>/task.md', '<PREFIX>_PROJECT_STATE_DIR': '<case>/state', '<PREFIX>_ALLOW_HOSTS': 'example.org' };
const FULL_REQUEST_FLAGS = ['--model', 'opus', ...FIXED_FLAGS, '--max-turns', '30', '--max-budget-usd', '2.5', '--effort', 'high', '--allowedTools', 'Read', 'Bash', '--disallowedTools', 'WebSearch', '--append-system-prompt-file', '<tmp>/<cli>-run-XXXXXX/system-prompt.md', '--json-schema', { type: 'object' }, '--resume', 'session-1'];
const GUARD = { disableAllHooks: false, hooks: HOOKS, permissions: { allow: ['Bash(npm test)'], deny: ['Read(//srv/secrets/**)'] } };
/** sudo's argv up to the program, in order: `env -i` and the agent user's whole environment. */
const sudoTo = (extra: string[]) => [
  '-n', '-u', 'agent1', '--', '/usr/bin/env', '-i',
  'PATH=<bin>', 'HOME=<case>/userhome', 'USER=agent1', 'LOGNAME=agent1', 'LANG=C.UTF-8', 'TERM=dumb', 'TMPDIR=<tmp>', 'TZ=UTC',
  '<PREFIX>_AGENT=1', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', 'GIT_TERMINAL_PROMPT=0', 'GIT_ASKPASS=false', 'GIT_CONFIG_COUNT=2', 'GH_CONFIG_DIR=<tmp>/no-gh-XXXXXX',
  ...extra,
  'GIT_AUTHOR_NAME=engine-bot', 'GIT_AUTHOR_EMAIL=engine-bot@example.com', 'GIT_COMMITTER_NAME=engine-bot', 'GIT_COMMITTER_EMAIL=engine-bot@example.com', '<PREFIX>_ROLE=worker',
];
const sudoAgentHome = [
  'CLAUDE_CONFIG_DIR=<case>/userhome/.claude', 'XDG_CONFIG_HOME=<case>/userhome/.config', 'XDG_DATA_HOME=<case>/userhome/.local/share', 'XDG_CACHE_HOME=<case>/userhome/.cache', 'XDG_STATE_HOME=<case>/userhome/.local/state',
  'GIT_CONFIG_KEY_0=credential.helper', 'GIT_CONFIG_VALUE_0=', 'GIT_CONFIG_KEY_1=safe.directory', 'GIT_CONFIG_VALUE_1=*',
];
const sudoFullRequest = [...sudoTo(['PROJECT_VAR=one']), '<PREFIX>_TASK_FILE=<case>/task.md', '<PREFIX>_PROJECT_STATE_DIR=<case>/state', '<PREFIX>_ALLOW_HOSTS=example.org', ...sudoAgentHome];
const sudoPlain = [...sudoTo([]), ...sudoAgentHome];

const GOLDEN: Record<string, unknown> = {
  claudeCli: [
    { name: 'claude', argv: ['auth', 'status', '--json'], env: { ...AGENT_ENV, ...FULL_REQUEST_ENV }, cwd: '<test-cwd>', stdin: null },
    {
      name: 'claude',
      argv: [
        '--settings',
        {
          sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, network: { allowedDomains: ['registry.npmjs.org', 'example.org'] }, filesystem: { denyRead: ['/srv/coordinator'] } },
          permissions: { allow: ['Bash(npm test)'], deny: ['Read(//srv/secrets/**)', 'Read(//srv/coordinator/**)'] },
          disableAllHooks: false,
          hooks: HOOKS,
          env: FULL_REQUEST_SETTINGS_ENV,
          ...NO_ATTRIBUTION_PIN,
          outputStyle: '<check>',
        },
        ...STREAM_FLAGS,
        ...FULL_REQUEST_FLAGS,
      ],
      env: { ...AGENT_ENV, ...FULL_REQUEST_ENV },
      cwd: '<case>/work',
      stdin: PROMPT_LINE,
    },
  ],
  claudeApiKey: [
    { name: 'claude', argv: ['auth', 'status', '--json'], env: AGENT_ENV, cwd: '<test-cwd>', stdin: null },
    {
      name: 'claude',
      argv: [
        '--settings',
        { ...GUARD, env: { '<PREFIX>_AGENT': '1', '<PREFIX>_ROLE': 'worker' }, ...NO_ATTRIBUTION_PIN, apiKeyHelper: 'cat -- /etc/keys/agent-api-key', outputStyle: '<check>' },
        ...STREAM_FLAGS,
        '--model', 'sonnet', ...FIXED_FLAGS, '--max-turns', '10', '--max-budget-usd', '1', '--allowedTools', 'Read',
      ],
      env: AGENT_ENV,
      cwd: '<case>/work',
      stdin: PROMPT_LINE,
    },
  ],
  claudeProvider: [
    {
      name: 'claude',
      argv: [
        '--settings',
        { ...GUARD, env: { '<PREFIX>_AGENT': '1', '<PREFIX>_ROLE': 'worker' }, ...NO_ATTRIBUTION_PIN, apiKeyHelper: 'cat -- /etc/keys/open', outputStyle: '<check>' },
        ...STREAM_FLAGS,
        '--model', 'open-model-1', ...FIXED_FLAGS, '--max-turns', '10', '--max-budget-usd', '1', '--allowedTools', 'Read',
      ],
      env: { ...AGENT_ENV, CLAUDE_CONFIG_DIR: '<tmp>/<cli>-provider-XXXXXX', ANTHROPIC_BASE_URL: 'https://models.example.test/v1' },
      cwd: '<case>/work',
      stdin: PROMPT_LINE,
    },
  ],
  claudeOsUser: [
    { name: 'sudo', argv: [...sudoFullRequest, 'claude', 'auth', 'status', '--json'], env: { PATH: '<bin>' }, cwd: '<test-cwd>', stdin: null },
    {
      name: 'sudo',
      argv: [
        ...sudoFullRequest,
        'claude',
        '--settings',
        { ...GUARD, env: FULL_REQUEST_SETTINGS_ENV, ...NO_ATTRIBUTION_PIN, outputStyle: '<check>' },
        ...STREAM_FLAGS,
        ...FULL_REQUEST_FLAGS,
      ],
      env: { PATH: '<bin>' },
      cwd: '<case>/work',
      stdin: PROMPT_LINE,
    },
  ],
  codex: [
    { name: 'sudo', argv: [...sudoPlain, 'codex', 'exec', '--json', '--model', 'codex-model', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-'], env: { PATH: '<bin>' }, cwd: '<case>/work', stdin: 'do the task' },
  ],
  gemini: [
    { name: 'sudo', argv: [...sudoPlain, 'gemini', '--output-format', 'stream-json', '--model', 'gemini-model', '--approval-mode', 'yolo', '-p', 'Do the task given on standard input.'], env: { PATH: '<bin>' }, cwd: '<case>/work', stdin: 'do the task' },
  ],
};

test('claude as this user, cli runtime, instance guardrails, the lane sandbox and every request field: argv, --settings, env, cwd and stdin are unchanged', { skip }, async () => {
  const root = newCase('claude.ai');
  const lanes = { default: { settings: sandboxSettings({ lane: { allowedDomains: ['registry.npmjs.org'] }, denyRead: ['/srv/coordinator'] }) } };
  const r = await new CliRunner('cli', baseEnv(root), 'claude', undefined, lanes, identity, {}, guardrails(root)).run(fullRequest(root));
  assert.equal(r.reason, 'succeeded', r.detail);
  same(recorded(root), GOLDEN.claudeCli);
});

test('claude as this user, api_key runtime with a key file: the key reaches claude only through apiKeyHelper, never the environment', { skip }, async () => {
  const root = newCase('api_key_helper');
  const r = await new CliRunner('api_key', baseEnv(root), 'claude', undefined, undefined, identity, {}, guardrails(root), '/etc/keys/agent-api-key').run(plainRequest(root, 'sonnet'));
  assert.equal(r.reason, 'succeeded', r.detail);
  same(recorded(root), GOLDEN.claudeApiKey);
});

test('claude on a hosted provider: its endpoint and key helper, an empty config dir, no effort flag, no auth probe', { skip }, async () => {
  const root = newCase('claude.ai');
  allowProviderHosts('models.example.test');
  const req: RunRequest = { ...plainRequest(root, 'open-model-1'), effort: 'high', provider: { name: 'hosted:open', kind: 'hosted', baseUrl: 'https://models.example.test/v1', keyFile: '/etc/keys/open' }, route: { kind: 'build', fallback: 'sonnet' } };
  const r = await new CliRunner('cli', baseEnv(root), 'claude', undefined, undefined, identity, {}, guardrails(root)).run(req);
  assert.equal(r.reason, 'succeeded', r.detail);
  same(recorded(root), GOLDEN.claudeProvider);
});

test('claude as the agent OS user: the auth probe and the run go through sudo with env -i, and sudo itself gets only PATH', { skip }, async () => {
  const root = newCase('claude.ai');
  const r = await new CliRunner('cli', baseEnv(root), 'claude', agentUser(root), undefined, identity, {}, guardrails(root)).run(fullRequest(root));
  assert.equal(r.reason, 'succeeded', r.detail);
  same(recorded(root), GOLDEN.claudeOsUser);
});

for (const agent of ['codex', 'gemini'] as const) {
  test(`${agent} as the agent OS user: through sudo with env -i, the prompt on stdin only`, { skip }, async () => {
    const root = newCase('claude.ai');
    const req: RunRequest = { ...plainRequest(root, `${agent}-model`), route: { kind: 'build', fallback: 'sonnet' }, provider: { name: `cli:${agent}`, kind: 'cli', agent, usdPerMtok: { in: 1, out: 2 } } };
    const r = await new CliAgentRunner(agent, { runAs: () => agentUser(root), identity, base: baseEnv(root) }).run(req);
    assert.equal(r.reason, 'succeeded', r.detail);
    same(recorded(root), GOLDEN[agent]);
  });
}

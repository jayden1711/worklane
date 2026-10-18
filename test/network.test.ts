// Where children send credentials (#381 follow-up, src/network.ts): no variable in the coordinator's own environment
// redirects claude, gh or git; an outbound proxy comes only from root's network.json, validated. The spawn tests go
// through the engine's real spawn paths (instanceTokens' gh, CliRunner's claude, projectCommand) to stand-ins that
// record the environment they were given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { healthView } from '../src/health.js';
import type { Instance } from '../src/instance.js';
import { isRedirectVar, machineNetwork, networkHealth, NETWORK_FILE, NETWORK_LIMITS, outboundEnv, readNetworkConfig } from '../src/network.js';
import { childEnv, projectCommand } from '../src/os/index.js';
import { agentEnv, CliRunner, runAsEnv, type RunRequest } from '../src/runner.js';
import { instanceEnv, instanceTokens } from '../src/service.js';
import { BRAND } from '../src/brand.js';
import { onRealMachine } from './isolate.js';
import { allowProviderHosts } from './helpers.js';

const posixOnly = process.platform === 'win32' && 'POSIX file owners and modes, and POSIX stand-ins for claude and gh';
const me = typeof process.getuid === 'function' ? process.getuid() : -1;
const OUTSIDE = 'http://attacker.invalid:8080';

/** The owner's list, then the other host-redirect variables the claude and gh CLIs (and git) honour. */
const LISTED = ['ANTHROPIC_BASE_URL', 'GH_HOST', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];
const ALSO = [
  'ANTHROPIC_API_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_IDE_HOST_OVERRIDE',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'BETA_TRACING_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'GH_REPO', 'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'GITHUB_GRAPHQL_URL', 'GITHUB_HOST', 'FTP_PROXY', 'Https_Proxy', 'GIT_PROXY_COMMAND',
];
const REDIRECTING = [...LISTED, ...ALSO];
/** The coordinator's own environment, with every redirecting variable pointing elsewhere. */
const poisoned = (extra: Record<string, string> = {}): Record<string, string> => ({ ...Object.fromEntries(REDIRECTING.map((k) => [k, OUTSIDE])), ...extra });

/** A network.json owned by this user (the tests' stand-in for root), 0644 unless told. */
function networkFile(body: unknown, mode = 0o644): string {
  const dir = mkdtempSync(join(tmpdir(), 'network-'));
  const f = join(dir, 'network.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  chmodSync(f, mode);
  return f;
}

/** Run `f` with the engine reading `file` as the machine's network.json, owned by this user. */
async function withNetwork<T>(file: string | null, f: () => Promise<T> | T): Promise<T> {
  const saved = { ...machineNetwork };
  machineNetwork.file = file ?? join(tmpdir(), 'no-such-dir', 'network.json');
  machineNetwork.ownerUid = me;
  try {
    return await f();
  } finally {
    Object.assign(machineNetwork, saved);
  }
}

const redirectsIn = (env: Record<string, string | undefined>) => Object.keys(env).filter((k) => isRedirectVar(k) && !/^(?:https?_proxy|no_proxy)$/i.test(k));
const proxiesIn = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([k]) => /_proxy$/i.test(k)));
const PROXY_SET = (url: string, noProxy?: string) => ({ HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, ...(noProxy ? { NO_PROXY: noProxy, no_proxy: noProxy } : {}) });

test('the file is root\'s, under /etc/<cli>/', () => {
  assert.equal(onRealMachine(NETWORK_FILE), `/etc/${BRAND.cli}/network.json`);
  assert.deepEqual(machineNetwork, { file: NETWORK_FILE, ownerUid: 0 }, 'the engine reads the real file, owned by root');
});

test('every listed variable, and the other redirects, in every casing, is a redirect; ordinary ones are not', () => {
  for (const k of REDIRECTING) for (const c of [k, k.toLowerCase(), k.toUpperCase()]) assert.ok(isRedirectVar(c), c);
  for (const k of ['PATH', 'HOME', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'HTTP_PROXY_X']) assert.equal(isRedirectVar(k), false, k);
  const env = outboundEnv({ ...poisoned(), PATH: '/bin', KEEP: 'x' }, null);
  assert.deepEqual(env, { PATH: '/bin', KEEP: 'x' });
});

test('network.json: a root-owned, unwritable file with an http(s) proxy sets it, and only the proxy variables', { skip: posixOnly }, () => {
  const f = networkFile({ proxy: 'http://proxy.internal:3128', no_proxy: 'localhost,127.0.0.1,.internal' });
  const c = readNetworkConfig(f, { ownerUid: me });
  assert.equal(c.error, null);
  assert.deepEqual(c.proxy, { url: 'http://proxy.internal:3128', host: 'proxy.internal:3128', noProxy: 'localhost,127.0.0.1,.internal', file: f });
  assert.equal(c.ca, null);
  assert.deepEqual(outboundEnv({ ...poisoned(), PATH: '/bin' }, c), { PATH: '/bin', ...PROXY_SET('http://proxy.internal:3128', 'localhost,127.0.0.1,.internal') });
  assert.deepEqual(readNetworkConfig(networkFile({ proxy: 'https://[::1]:8443/' }), { ownerUid: me }).proxy?.url, 'https://[::1]:8443');
  assert.deepEqual(readNetworkConfig(join(tmpdir(), 'none', 'network.json'), { ownerUid: me }), { proxy: null, ca: null, error: null }, 'no file: no proxy, no error');
  assert.deepEqual(readNetworkConfig(networkFile({}), { ownerUid: me }), { proxy: null, ca: null, error: null }, 'no proxy key: none');
});

test('network.json: a bad or credentialed proxy is refused, and nothing is set', { skip: posixOnly }, () => {
  const refused: [unknown, RegExp][] = [
    [{ proxy: 'http://user:pass@proxy.internal:3128' }, /must not carry a user or password/],
    [{ proxy: 'http://user@proxy.internal:3128' }, /must not carry a user or password/],
    [{ proxy: 'http://:pass@proxy.internal:3128' }, /must not carry a user or password/],
    [{ proxy: 'http://@proxy.internal:3128' }, /must not carry a user or password/],
    [{ proxy: 'https://u%40x:p@proxy.internal' }, /must not carry a user or password/],
    [{ proxy: 'socks5://proxy.internal:1080' }, /http:\/\/ or https:\/\//],
    [{ proxy: 'file:///etc/passwd' }, /http:\/\/ or https:\/\//],
    [{ proxy: 'proxy.internal:3128' }, /http:\/\/ or https:\/\/|not a URL/],
    [{ proxy: 'http://proxy.internal:3128/path' }, /scheme:\/\/host\[:port\] only/],
    [{ proxy: 'http://proxy.internal:3128/?q=1' }, /scheme:\/\/host\[:port\] only/],
    [{ proxy: 'http://proxy.internal:3128\nX: y' }, /whitespace or a control character/],
    [{ proxy: `http://${'a'.repeat(NETWORK_LIMITS.proxy)}.internal` }, /longer than 512/],
    [{ proxy: 42 }, /must be a URL string/],
    [{ proxy: '' }, /must be a URL string/],
    [{ proxy: 'http://proxy.internal:3128', no_proxy: 'a\nb' }, /no_proxy may hold/],
    [{ proxy: 'http://proxy.internal:3128', no_proxy: 'x'.repeat(NETWORK_LIMITS.noProxy + 1) }, /no_proxy is longer/],
    [{ no_proxy: 'localhost' }, /no_proxy without a proxy/],
    [{ proxy: 'http://proxy.internal:3128', ca: '/tmp/ca.pem' }, /unknown key "ca"/],
    [['http://proxy.internal:3128'], /expected \{"proxy"/],
    ['{not json', /is not JSON/],
    [JSON.stringify({ proxy: 'http://proxy.internal:3128', no_proxy: ' '.repeat(NETWORK_LIMITS.fileBytes) }), /over 4096 bytes/],
  ];
  for (const [body, why] of refused) {
    const c = readNetworkConfig(networkFile(body), { ownerUid: me });
    assert.equal(c.proxy, null, JSON.stringify(body));
    assert.match(c.error ?? '', why, JSON.stringify(body));
    assert.match(c.error ?? '', /no outbound proxy or custom CA is set$/);
  }
});

test('network.json: a file root doesn\'t own, or its group or others may write, is refused', { skip: posixOnly }, () => {
  const good = { proxy: 'http://proxy.internal:3128' };
  const f = networkFile(good);
  if (me !== 0) {
    const c = readNetworkConfig(f);
    assert.equal(c.proxy, null, 'owned by this user, not root');
    assert.match(c.error ?? '', /isn't root's \(owner uid \d+\)/);
  }
  assert.equal(readNetworkConfig(f, { ownerUid: me + 1 }).proxy, null, 'any owner but the one required');
  for (const mode of [0o664, 0o646, 0o666, 0o660]) {
    const c = readNetworkConfig(networkFile(good, mode), { ownerUid: me });
    assert.equal(c.proxy, null, mode.toString(8));
    assert.match(c.error ?? '', /is writable by its group or others \(mode 06\d\d\)/);
  }
  assert.ok(readNetworkConfig(networkFile(good, 0o600), { ownerUid: me }).proxy, '0600 (unreadable to others) is fine for its reader');
  assert.ok(readNetworkConfig(networkFile(good, 0o444), { ownerUid: me }).proxy);
});

/** A stand-in gh that prints its environment as `gh auth token` output. */
function standInGh(): string {
  const bin = mkdtempSync(join(tmpdir(), 'env-gh-'));
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nenv\n');
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}
const parseEnv = (text: string) => Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

function fakeInstance(): Instance {
  const home = mkdtempSync(join(tmpdir(), 'net-inst-'));
  mkdirSync(join(home, 'gh'));
  return { name: 'shop', home, stateDir: join(home, 'state'), runAs: null, credentials: { version: 1, github: { kind: 'gh-config-dir', path: join(home, 'gh') } } } as unknown as Instance;
}

test('gh, through the coordinator\'s real path (instanceEnv, then instanceTokens): no redirecting variable reaches it; root\'s proxy does', { skip: posixOnly }, async () => {
  const bin = standInGh();
  const i = fakeInstance();
  const base = poisoned({ PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: i.home });
  const without = await withNetwork(null, async () => parseEnv(await instanceTokens(i, instanceEnv(i, base))()));
  assert.deepEqual(redirectsIn(without), [], 'nothing redirects gh');
  assert.deepEqual(proxiesIn(without), {}, 'no proxy at all without network.json');
  assert.equal(without.GH_CONFIG_DIR, join(i.home, 'gh'), 'gh still gets the instance login');
  const f = networkFile({ proxy: 'http://proxy.internal:3128', no_proxy: 'localhost' });
  const withProxy = await withNetwork(f, async () => parseEnv(await instanceTokens(i, instanceEnv(i, base))()));
  assert.deepEqual(redirectsIn(withProxy), []);
  assert.deepEqual(proxiesIn(withProxy), PROXY_SET('http://proxy.internal:3128', 'localhost'), 'root\'s proxy, and nothing inherited');
  // A refused file: children go direct, never back to the inherited proxy.
  const bad = await withNetwork(networkFile({ proxy: 'http://u:p@proxy.internal:3128' }), async () => parseEnv(await instanceTokens(i, instanceEnv(i, base))()));
  assert.deepEqual(proxiesIn(bad), {});
});

/** A stand-in claude that records the environment of each call (`auth status` and the run). */
function standInClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'env-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const which = process.argv[2] === 'auth' ? 'auth' : 'run';
fs.writeFileSync(path.join(${JSON.stringify(dir)}, which + '.json'), JSON.stringify(process.env));
if (which === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
// As claude does with a --settings it applied (#626): the init event reports its outputStyle.
const at = process.argv.indexOf('--settings');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', output_style: (at >= 0 && JSON.parse(process.argv[at + 1]).outputStyle) || 'default' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01 }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 200);
`,
  );
  chmodSync(bin, 0o755);
  const got = (which: 'auth' | 'run') => JSON.parse(readFileSync(join(dir, `${which}.json`), 'utf8')) as Record<string, string>;
  return { dir, bin, got };
}

const req = (cwd: string, extra: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...extra });

test('claude, through CliRunner on the coordinator\'s environment: no redirecting variable reaches its auth probe or its run; root\'s proxy does', { skip: posixOnly }, async () => {
  const i = fakeInstance();
  const base = () => instanceEnv(i, poisoned({ PATH: process.env.PATH ?? '', HOME: i.home, CLAUDE_CONFIG_DIR: join(i.home, 'claude') }));
  const plain = standInClaude();
  const r = await withNetwork(null, () => new CliRunner('cli', base(), plain.bin).run(req(plain.dir)));
  assert.equal(r.reason, 'succeeded', r.detail);
  for (const w of ['auth', 'run'] as const) {
    assert.deepEqual(redirectsIn(plain.got(w)), [], w);
    assert.deepEqual(proxiesIn(plain.got(w)), {}, w);
  }
  const proxied = standInClaude();
  const f = networkFile({ proxy: 'https://proxy.internal:8443' });
  const p = await withNetwork(f, () => new CliRunner('cli', base(), proxied.bin).run(req(proxied.dir)));
  assert.equal(p.reason, 'succeeded', p.detail);
  for (const w of ['auth', 'run'] as const) {
    assert.deepEqual(redirectsIn(proxied.got(w)), [], w);
    assert.deepEqual(proxiesIn(proxied.got(w)), PROXY_SET('https://proxy.internal:8443'), `${w}: root's proxy only`);
  }
});

test('a provider run keeps its own endpoint from agents.yaml, and only that one', { skip: posixOnly }, async () => {
  const i = fakeInstance();
  const s = standInClaude();
  const base = instanceEnv(i, poisoned({ PATH: process.env.PATH ?? '', HOME: i.home }));
  const provider = { name: 'local', kind: 'local' as const, baseUrl: 'http://127.0.0.1:11434', keyFile: '/home/user/provider/key' };
  allowProviderHosts('127.0.0.1:11434');
  const r = await withNetwork(null, () => new CliRunner('cli', base, s.bin).run(req(s.dir, { provider })));
  assert.equal(r.reason, 'succeeded', r.detail);
  const env = s.got('run');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
  assert.deepEqual(redirectsIn(env), ['ANTHROPIC_BASE_URL'], 'no other endpoint, proxy or provider switch');
});

test('agentEnv and runAsEnv: nothing a caller hands in redirects an agent; root\'s proxy is the only one', { skip: posixOnly }, async () => {
  const run = { user: 'shop-agent', home: '/home/user' };
  const plain = await withNetwork(null, () => runAsEnv(agentEnv(poisoned({ PATH: '/bin' }), 'cli', poisoned()), run));
  assert.deepEqual(redirectsIn(plain), []);
  assert.deepEqual(proxiesIn(plain), {});
  const f = networkFile({ proxy: 'http://proxy.internal:3128' });
  const proxied = await withNetwork(f, () => runAsEnv({ ...poisoned(), PATH: '/bin' }, run));
  assert.deepEqual(proxiesIn(proxied), PROXY_SET('http://proxy.internal:3128'));
});

test('project commands (childEnv, through projectCommand): nothing redirects them; root\'s proxy reaches them', { skip: posixOnly }, async () => {
  const saved = { ...process.env };
  Object.assign(process.env, poisoned());
  try {
    const envOf = () => {
      const c = projectCommand('env');
      return parseEnv(spawnSync(c.file, c.args, { env: c.env, encoding: 'utf8' }).stdout);
    };
    const plain = await withNetwork(null, envOf);
    assert.deepEqual(redirectsIn(plain), []);
    assert.deepEqual(proxiesIn(plain), {});
    const f = networkFile({ proxy: 'http://proxy.internal:3128', no_proxy: 'localhost' });
    const proxied = await withNetwork(f, envOf);
    assert.deepEqual(proxiesIn(proxied), PROXY_SET('http://proxy.internal:3128', 'localhost'));
    assert.deepEqual(redirectsIn(await withNetwork(null, () => childEnv(poisoned()))), [], 'nor from extra');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the Health page\'s line: the proxy and its file when set, the refusal when refused, nothing when absent', { skip: posixOnly }, async () => {
  const f = networkFile({ proxy: 'http://proxy.internal:3128' });
  assert.deepEqual(await withNetwork(f, () => networkHealth()), { proxy: 'proxy.internal:3128', file: f, ca: null, error: null });
  assert.equal(await withNetwork(null, () => networkHealth()), null);
  const bad = networkFile({ proxy: 'http://u:p@proxy.internal:3128' });
  const refused = await withNetwork(bad, () => networkHealth());
  assert.equal(refused?.proxy, null);
  assert.match(refused?.error ?? '', /must not carry a user or password/);
  assert.doesNotMatch(refused?.error ?? '', /u:p/, 'never echoes the credential');
  assert.deepEqual(await withNetwork(f, () => healthView([], null).network), { proxy: 'proxy.internal:3128', file: f, ca: null, error: null });
});

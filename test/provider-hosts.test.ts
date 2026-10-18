// Root's provider hosts (#392): a provider's base_url sends its key and every prompt to a host root allows in
// /etc/<cli>/providers.json, or nowhere. The file's checks (root's, not writable by others, bounded, this shape), the
// exact host and port match, the URL's shape at config load, the fallback when the coordinator resolves a run, the
// runner's own check right before claude would start, what is said at start, the refusal logged once, and the Health
// page's line (owners and writers only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { AgentsConfig } from '../src/config/schema.js';
import { resolveProvider } from '../src/coordinator/providers.js';
import { InstanceSettings } from '../src/instance.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { healthView } from '../src/health.js';
import { baseUrlProblem, logRefusalOnce, machineProviderHosts, PROVIDER_HOSTS_LIMITS, providerHostRefusal, providerHostsAtStart, providerHostsHealth, readProviderHosts, type ProviderHosts } from '../src/provider-hosts.js';
import { PROVIDER_GATE_FILE } from '../src/providers.js';
import { CliRunner, type RunRequest } from '../src/runner.js';
import { allowProviderHosts, asPerson, exampleProject, exampleRoles } from './helpers.js';

const posix = process.platform !== 'win32';
const me = typeof process.getuid === 'function' ? process.getuid() : 0;

function hostsFile(body: unknown, mode = 0o644): string {
  const f = join(mkdtempSync(join(tmpdir(), 'provider-hosts-')), 'providers.json');
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  chmodSync(f, mode);
  return f;
}
const ok = (...hosts: string[]): ProviderHosts => ({ file: '/etc/x/providers.json', state: 'ok', hosts, error: null });

test('the file: root\'s, not writable by its group or others, not a symlink, bounded, {"hosts": [...]} only; anything else is no host at all', { skip: !posix && 'root-owned files are POSIX' }, () => {
  const good = hostsFile({ hosts: ['api.provider.test', '127.0.0.1:8080', '[::1]:11434'] });
  assert.deepEqual(readProviderHosts(good, { ownerUid: me }), { file: good, state: 'ok', hosts: ['api.provider.test', '127.0.0.1:8080', '[::1]:11434'], error: null });
  assert.deepEqual(readProviderHosts(join(tmpdir(), 'no-such-dir', 'providers.json'), { ownerUid: me }).state, 'missing');
  const refused = (f: string, why: RegExp, ownerUid = me) => {
    const r = readProviderHosts(f, { ownerUid });
    assert.equal(r.state, 'refused', f);
    assert.deepEqual(r.hosts, []);
    assert.match(r.error!, why);
    assert.match(r.error!, /no provider host is allowed$/);
  };
  refused(good, /isn't root's/, me + 1);
  refused(hostsFile({ hosts: ['api.provider.test'] }, 0o664), /writable by its group or others \(mode 0664\)/);
  refused(hostsFile({ hosts: ['api.provider.test'] }, 0o646), /writable by its group or others \(mode 0646\)/);
  const link = join(mkdtempSync(join(tmpdir(), 'provider-hosts-')), 'providers.json');
  symlinkSync(good, link);
  refused(link, /symlink/);
  refused(hostsFile(JSON.stringify({ hosts: ['a.test'], pad: 'x'.repeat(PROVIDER_HOSTS_LIMITS.fileBytes) })), /over 8192 bytes/);
  refused(hostsFile('{not json'), /not JSON/);
  refused(hostsFile(['api.provider.test']), /expected \{"hosts"/);
  refused(hostsFile({ hosts: ['api.provider.test'], insecure: true }), /unknown key "insecure"/);
  refused(hostsFile({ hosts: 'api.provider.test' }), /expected \{"hosts"/);
  refused(hostsFile({ hosts: Array.from({ length: 65 }, (_, i) => `h${i}.test`) }), /more than 64 hosts/);
  refused(hostsFile({ hosts: ['*.provider.test'] }), /no wildcards/);
  refused(hostsFile({ hosts: ['https://api.provider.test'] }), /host or host:port/);
  refused(hostsFile({ hosts: ['user@example.com'] }), /host or host:port/);
  refused(hostsFile({ hosts: ['API.Provider.test'] }), /as a URL normalises it: "api\.provider\.test"/);
  refused(hostsFile({ hosts: ['127.1'] }), /"127\.0\.0\.1"/);
  refused(hostsFile({ hosts: ['api.provider.test:0'] }), /bad port/);
  refused(hostsFile({ hosts: ['api.provider.test:080'] }), /bad port/);
  refused(hostsFile({ hosts: [7] }), /non-empty string/);
});

test('a base_url\'s host and port must match an entry exactly: no suffix, look-alike, other port or other scheme\'s default', () => {
  const h = ok('api.provider.test', 'alt.provider.test:8443', '127.0.0.1:8080', '[::1]:11434');
  for (const u of ['https://api.provider.test', 'https://api.provider.test/', 'https://api.provider.test/anthropic', 'https://api.provider.test/v1/', 'https://alt.provider.test:8443/x', 'http://127.0.0.1:8080', 'https://127.0.0.1:8080', 'http://[::1]:11434']) assert.equal(providerHostRefusal(u, h), null, u);
  for (const u of ['https://api.provider.test.evil.test', 'https://evil-api.provider.test', 'https://provider.test', 'https://api.provider.test:8443', 'https://alt.provider.test', 'http://127.0.0.1:8081', 'http://127.0.0.1']) {
    assert.match(providerHostRefusal(u, h) ?? '', /is not an allowed provider host \(api\.provider\.test, alt\.provider\.test:8443, 127\.0\.0\.1:8080, \[::1\]:11434, from \/etc\/x\/providers\.json\)/, u);
  }
  // A spelling WHATWG URL rewrites onto an allowed host is refused, never matched: claude gets the string itself.
  assert.match(providerHostRefusal('https://API.provider.test', h)!, /must be written as a URL normalises it: https:\/\/api\.provider\.test$/);
  assert.match(providerHostRefusal('https://api.provider.test:443/v1', h)!, /normalises it: https:\/\/api\.provider\.test\/v1$/);
});

test('no file, or a refused one, means no provider host at all: provider runs are off', () => {
  assert.match(providerHostRefusal('https://api.provider.test', { file: '/etc/x/providers.json', state: 'missing', hosts: [], error: null })!, /no provider host is allowed on this machine \(\/etc\/x\/providers\.json doesn't exist; root writes it/);
  assert.match(providerHostRefusal('https://api.provider.test', { file: '/etc/x/providers.json', state: 'refused', hosts: [], error: '/etc/x/providers.json: is a symlink (it must be a regular file); no provider host is allowed' })!, /symlink/);
  assert.match(providerHostRefusal('https://api.provider.test', ok())!, /not an allowed provider host \(none,/);
});

test('a credentialed, non-http(s), plain-http-off-this-machine, query or fragment base_url is refused whatever the list says', () => {
  const h = ok('api.provider.test', 'api.provider.test:80', '192.0.2.5:8080');
  const cases: [string, RegExp][] = [
    ['https://user:secret@api.provider.test', /user or password/],
    ['https://user@api.provider.test', /user or password/],
    ['https://@api.provider.test', /user or password/],
    ['https://:@api.provider.test', /user or password/],
    ['ftp://api.provider.test', /must be https:\/\/.*not ftp:/],
    ['file:///etc/passwd', /not file:/],
    ['ws://api.provider.test', /not ws:/],
    ['http://api.provider.test', /plain http:\/\/ only to a loopback address/],
    ['http://192.0.2.5:8080', /plain http:\/\/ only to a loopback address/],
    // A name, even localhost: plain http stays on this machine only by a literal loopback address.
    ['http://localhost:8080', /plain http:\/\/ only to a loopback address: 127\.x\.x\.x or \[::1\]\), not http:\/\/localhost:8080/],
    ['https://api.provider.test/?key=sk-123', /query or fragment/],
    ['https://api.provider.test/#x', /query or fragment/],
    ['https://api.provider.test/ x', /whitespace/],
    ['not a url', /whitespace|not a URL/],
    ['', /URL string/],
  ];
  for (const [u, why] of cases) {
    assert.match(baseUrlProblem(u) ?? '', why, u);
    assert.match(providerHostRefusal(u, h) ?? '', why, u);
  }
  for (const u of ['http://127.0.0.1:8080', 'http://127.1.2.3', 'http://[::1]:11434', 'https://api.provider.test/anthropic', 'https://localhost:8443']) assert.equal(baseUrlProblem(u), null, u);
});

test('a base_url not already written as WHATWG URL normalises it is refused, saying the form: claude gets the string itself', () => {
  // Every one of these parses onto an allowed host (#607 review probe); none may reach claude as written.
  const h = ok('allowed.test', '127.0.0.1:8080', '[::1]:11434');
  const cases: [string, string][] = [
    ['https:allowed.test', 'https://allowed.test'],
    ['https:/allowed.test', 'https://allowed.test'],
    ['https:\\\\allowed.test', 'https://allowed.test'],
    ['HTTPS://allowed.test', 'https://allowed.test'],
    ['https://ALLOWED.TEST', 'https://allowed.test'],
    ['https://allowed%2Etest', 'https://allowed.test'],
    ['https://allowed．test', 'https://allowed.test'],
    ['https://allowed.test\\evil.test', 'https://allowed.test/evil.test'],
    ['https://allowed.test:443', 'https://allowed.test'],
    ['https://allowed.test:', 'https://allowed.test'],
    ['http://0x7f.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://2130706433:8080', 'http://127.0.0.1:8080'],
    ['http://127.1:8080', 'http://127.0.0.1:8080'],
    ['http://[0:0:0:0:0:0:0:1]:11434', 'http://[::1]:11434'],
    ['https://allowed.test/a/../v1', 'https://allowed.test/v1'],
  ];
  for (const [u, form] of cases) {
    assert.doesNotThrow(() => new URL(u), `${u} parses (the probe's premise)`);
    const why = `must be written as a URL normalises it: ${form}`;
    assert.equal(baseUrlProblem(u), why, u);
    assert.equal(providerHostRefusal(u, h), `its base_url ${why}`, u);
  }
});

const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet' }, evaluator: { enabled: true, model: 'opus' } } };
const GLM = { base_url: 'https://open.example.com/anthropic', credential: 'glm', model: 'glm-x', tier: 'sonnet', usd_per_mtok_in: 1, usd_per_mtok_out: 2 };

test('at config load: the schema refuses a credentialed, non-http(s) or plain-http-off-this-machine base_url, saying why', () => {
  const issues = (base_url: string) => {
    const r = AgentsConfig.safeParse({ ...base, providers: { hosted: { glm: { ...GLM, base_url } } } });
    return r.success ? null : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  };
  assert.equal(issues(GLM.base_url), null);
  assert.equal(AgentsConfig.safeParse({ ...base, providers: { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'm' } } }).success, true, 'plain http to loopback');
  assert.match(issues('https://user:secret@open.example.com/anthropic')!, /providers\.hosted\.glm\.base_url: base_url must not carry a user or password/);
  assert.match(issues('ftp://open.example.com')!, /base_url must be https:\/\//);
  assert.match(issues('http://open.example.com/anthropic')!, /plain http:\/\/ only to a loopback address/);
  assert.match(issues('https://open.example.com:443/anthropic')!, /base_url must be written as a URL normalises it: https:\/\/open\.example\.com\/anthropic/);
  assert.match(issues('https://open.example.com/anthropic?key=sk-1')!, /query or fragment/);
});

test('at start: root\'s hosts, or that provider runs are off and why, and each configured provider outside them', () => {
  const agents = AgentsConfig.parse({ ...base, providers: { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'm' }, hosted: { glm: GLM } } });
  assert.deepEqual(providerHostsAtStart(agents, ok('127.0.0.1:8080')), [
    'provider hosts: 127.0.0.1:8080 (from /etc/x/providers.json)',
    "provider hosted:glm refused: open.example.com is not an allowed provider host (127.0.0.1:8080, from /etc/x/providers.json); its runs take the role's normal model",
  ]);
  assert.deepEqual(providerHostsAtStart(agents, ok('127.0.0.1:8080', 'open.example.com')), ['provider hosts: 127.0.0.1:8080, open.example.com (from /etc/x/providers.json)']);
  assert.deepEqual(providerHostsAtStart(agents, { file: '/etc/x/providers.json', state: 'missing', hosts: [], error: null }), ['no /etc/x/providers.json: no provider host is allowed, so provider runs are off (root writes it, docs/providers.md)']);
  assert.deepEqual(providerHostsAtStart(agents, { file: '/etc/x/providers.json', state: 'refused', hosts: [], error: '/etc/x/providers.json: is not JSON; no provider host is allowed' }), ['/etc/x/providers.json: is not JSON; no provider host is allowed: provider runs are off']);
  assert.deepEqual(providerHostsAtStart(AgentsConfig.parse(base), { file: '/etc/x/providers.json', state: 'missing', hosts: [], error: null }), [], 'no provider and no file: nothing to say');
  assert.deepEqual(providerHostsAtStart(AgentsConfig.parse(base), ok()), ['provider hosts: none, so provider runs are off (from /etc/x/providers.json)']);
});

// ---- wired: the coordinator's resolution falls back, and the runner never starts claude with a refused host

function deps(fetched: string[] = []) {
  const cfg = loadConfig(exampleProject().dir);
  cfg.agents = AgentsConfig.parse({ ...base, providers: { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'small-1' }, hosted: { glm: GLM } }, model_routing: { research: 'hosted:glm', intake_replier: 'local' } });
  const stateDir = mkdtempSync(join(tmpdir(), 'prov-state-'));
  mkdirSync(join(stateDir, 'evals'), { recursive: true });
  const pass = { held_out: { passed: 20, total: 20 }, baseline: { passed: 19, total: 20 }, visible: { passed: 10, total: 10 }, samples: 3, at: '2026-10-12T00:00:00Z' };
  writeFileSync(join(stateDir, PROVIDER_GATE_FILE), JSON.stringify({ researcher: { 'glm-x': pass }, 'intake-replier': { 'small-1': pass } }));
  const fetch = (async (u: URL) => (fetched.push(String(u)), new Response('{}', { status: 200 }))) as unknown as typeof globalThis.fetch;
  return { cfg, stateDir, settings: InstanceSettings.parse({ providers: { local: true, hosted: ['glm'] } }), providerKeys: { glm: '/k/glm', local: '/k/local' }, fetch };
}
const research: RunRequest = { role: 'researcher', prompt: 'p', cwd: '/tmp', model: 'hosted:glm', allowedTools: [], maxTurns: 2, maxBudgetUsd: 0.25, stallMs: 60_000, timeoutMs: 60_000, route: { kind: 'research', fallback: 'sonnet' } };

test('the coordinator: a provider whose host root doesn\'t allow takes the role\'s normal model, saying why; allowed, it goes', { skip: !posix && 'root-owned files are POSIX' }, async () => {
  const saved = { ...machineProviderHosts };
  try {
    allowProviderHosts('127.0.0.1:8080');
    const r = await resolveProvider(research, deps());
    assert.deepEqual([r.req.model, r.req.provider], ['sonnet', undefined]);
    assert.equal(r.fellBack?.provider, 'hosted:glm');
    assert.match(r.fellBack!.reason, /open\.example\.com is not an allowed provider host \(127\.0\.0\.1:8080, from /);
    machineProviderHosts.file = join(tmpdir(), 'no-such-dir', 'providers.json');
    assert.match((await resolveProvider(research, deps())).fellBack!.reason, /no provider host is allowed on this machine/, 'no file: off');
    allowProviderHosts('open.example.com');
    const go = await resolveProvider(research, deps());
    assert.deepEqual([go.req.model, go.req.provider?.name, go.fellBack], ['glm-x', 'hosted:glm', null]);
    // The local server isn't even health-checked (contacted) until root allows its host.
    const replier: RunRequest = { ...research, role: 'intake-replier', model: 'local', route: { kind: 'intake_replier', fallback: 'haiku' } };
    const fetched: string[] = [];
    const local = await resolveProvider(replier, deps(fetched));
    assert.match(local.fellBack!.reason, /127\.0\.0\.1:8080 is not an allowed provider host/);
    assert.deepEqual(fetched, [], 'no request to a host root hasn\'t allowed');
    allowProviderHosts('127.0.0.1:8080');
    assert.equal((await resolveProvider(replier, deps(fetched))).req.provider?.name, 'local');
    assert.deepEqual(fetched, ['http://127.0.0.1:8080/v1/models']);
  } finally {
    Object.assign(machineProviderHosts, saved);
  }
});

function standIn() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hosts-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'started-' + process.pid), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.1 }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 200);
`,
  );
  chmodSync(bin, 0o755);
  const starts = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('started-')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { env: Record<string, string> }) : []);
  return { dir, bin, starts };
}

test('the runner: a provider run to a host root doesn\'t allow never starts claude (read again right before it would)', { skip: !posix && 'a POSIX stand-in for claude' }, async () => {
  const saved = { ...machineProviderHosts };
  try {
    const s = standIn();
    const env = { PATH: process.env.PATH ?? '', HOME: s.dir };
    const req: RunRequest = { role: 'researcher', prompt: 'p', cwd: s.dir, model: 'glm-x', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, provider: { name: 'hosted:glm', kind: 'hosted', baseUrl: 'https://open.example.com/anthropic', keyFile: '/home/user/provider-keys/glm' } };
    allowProviderHosts('api.provider.test');
    const r = await new CliRunner('cli', env, s.bin).run(req);
    assert.equal(r.reason, 'failed');
    assert.match(r.detail, /^hosted:glm: open\.example\.com is not an allowed provider host .*; not starting$/);
    assert.deepEqual(s.starts(), [], 'claude never started');
    machineProviderHosts.file = join(tmpdir(), 'no-such-dir', 'providers.json');
    assert.match((await new CliRunner('cli', env, s.bin).run(req)).detail, /no provider host is allowed on this machine/);
    const credentialed = await new CliRunner('cli', env, s.bin).run({ ...req, provider: { name: 'hosted:glm', kind: 'hosted', baseUrl: 'https://u:p@open.example.com/anthropic', keyFile: '/k' } });
    assert.match(credentialed.detail, /user or password/);
    assert.deepEqual(s.starts(), [], 'still never started');
    // Allowed: it starts, with that endpoint.
    allowProviderHosts('open.example.com');
    const go = await new CliRunner('cli', env, s.bin).run(req);
    assert.equal(go.reason, 'succeeded', go.detail);
    assert.deepEqual(s.starts().map((x) => x.env.ANTHROPIC_BASE_URL), ['https://open.example.com/anthropic']);
  } finally {
    Object.assign(machineProviderHosts, saved);
  }
});

test('a refusal is logged once per provider and reason', () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  logRefusalOnce('hosted:once', 'x is not allowed', log);
  logRefusalOnce('hosted:once', 'x is not allowed', log);
  logRefusalOnce('hosted:once', 'y is not allowed', log);
  logRefusalOnce('local-once', 'x is not allowed', log);
  assert.deepEqual(lines, ['provider hosted:once refused: x is not allowed', 'provider hosted:once refused: y is not allowed', 'provider local-once refused: x is not allowed']);
});

// ---- the Health page's line: root's hosts and each configured provider they refuse, for the owners and writers only

test("the Health line: root's hosts, or why there are none, and each configured provider outside them; nothing when there is no file and no provider", () => {
  const agents = AgentsConfig.parse({ ...base, providers: { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'm' }, hosted: { glm: GLM } } });
  assert.deepEqual(providerHostsHealth(agents, ok('127.0.0.1:8080')), { ...ok('127.0.0.1:8080'), refused: [{ provider: 'hosted:glm', reason: 'open.example.com is not an allowed provider host (127.0.0.1:8080, from /etc/x/providers.json)' }] });
  assert.deepEqual(providerHostsHealth(agents, ok('127.0.0.1:8080', 'open.example.com')), { ...ok('127.0.0.1:8080', 'open.example.com'), refused: [] });
  const missing: ProviderHosts = { file: '/etc/x/providers.json', state: 'missing', hosts: [], error: null };
  const off = [{ provider: 'local', reason: 'no provider host is allowed on this machine' }, { provider: 'hosted:glm', reason: 'no provider host is allowed on this machine' }];
  assert.deepEqual(providerHostsHealth(agents, missing), { ...missing, refused: off });
  const bad: ProviderHosts = { file: '/etc/x/providers.json', state: 'refused', hosts: [], error: '/etc/x/providers.json: is not JSON; no provider host is allowed' };
  assert.deepEqual(providerHostsHealth(agents, bad), { ...bad, refused: off });
  assert.equal(providerHostsHealth(AgentsConfig.parse(base), missing), null, 'no provider and no file: nothing to show');
  assert.deepEqual(providerHostsHealth(AgentsConfig.parse(base), ok('127.0.0.1:8080')), { ...ok('127.0.0.1:8080'), refused: [] }, 'a file and no provider: its hosts');
});

test("the health view carries the line, read from root's file now against the instance's providers", { skip: !posix && 'root-owned files are POSIX' }, () => {
  const saved = { ...machineProviderHosts };
  try {
    const f = allowProviderHosts('127.0.0.1:8080');
    const agents = AgentsConfig.parse({ ...base, providers: { hosted: { glm: GLM } } });
    assert.deepEqual(healthView([], null, { updates: [], network: null, agents }).providerHosts, { file: f, state: 'ok', hosts: ['127.0.0.1:8080'], error: null, refused: [{ provider: 'hosted:glm', reason: `open.example.com is not an allowed provider host (127.0.0.1:8080, from ${f})` }] });
    allowProviderHosts('open.example.com');
    assert.deepEqual(healthView([], null, { updates: [], network: null, agents }).providerHosts?.refused, [], 'a change to the file shows on the next read');
    machineProviderHosts.file = join(tmpdir(), 'no-such-dir', 'providers.json');
    assert.equal(healthView([], null, { updates: [], network: null }).providerHosts, null, 'no file and no provider');
  } finally {
    Object.assign(machineProviderHosts, saved);
  }
});

/** Entries root might mistype with a credential in them: each must refuse the file without the credential in the refusal. */
const SECRET_ENTRIES = ['alice:s3cret@api.example.com', 'https://alice:s3cret@h/', '*.h?token=s3cret', 'api.example.com?key=s3cret', 'api.example.com#s3cret', 'api.example.com/s3cret', `s3cret${'a'.repeat(300)}`];

test('a refused entry is named by its position, never quoted while it could hold a credential: not in the refusal, nor at start', { skip: !posix && 'root-owned files are POSIX' }, () => {
  const agents = AgentsConfig.parse({ ...base, providers: { hosted: { glm: GLM } } });
  for (const entry of SECRET_ENTRIES) {
    const r = readProviderHosts(hostsFile({ hosts: ['ok.example.com', entry] }), { ownerUid: me });
    assert.equal(r.state, 'refused', entry);
    assert.doesNotMatch(r.error!, /s3cret/, entry);
    assert.match(r.error!, /hosts entry 2\b/, entry);
    assert.doesNotMatch(providerHostsAtStart(agents, r).join('\n'), /s3cret/, entry);
  }
  // A key that isn't a plain word isn't quoted either; one that is, still is.
  const key = readProviderHosts(hostsFile({ hosts: ['ok.example.com'], 'https://alice:s3cret@h/': true }), { ownerUid: me });
  assert.match(key.error!, /an unknown key, not shown/);
  assert.doesNotMatch(key.error!, /s3cret/);
  // Once an entry is host[:port] it can't hold a user, query or fragment: it is quoted, to say what to write instead.
  assert.match(readProviderHosts(hostsFile({ hosts: ['API.example.com'] }), { ownerUid: me }).error!, /hosts entry 1 \("API\.example\.com"\) must be written as a URL normalises it: "api\.example\.com"/);
});

test("GET /api/health: a writer is never sent a credential from a mistyped entry in root's file", { skip: !posix && 'root-owned files are POSIX' }, async () => {
  const saved = { ...machineProviderHosts };
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  cfg.agents = AgentsConfig.parse({ ...base, providers: { hosted: { glm: GLM } } });
  const stateDir = mkdtempSync(join(tmpdir(), 'prov-health-'));
  const db = join(stateDir, 'events.db');
  new EventLog(db).close();
  const d = await startDashboard({ root, cfg, eventsDb: db, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(stateDir, 'slots'), pollMs: 50 });
  try {
    const url = `${d.url.split('/?')[0]!}/api/health`;
    for (const entry of SECRET_ENTRIES) {
      allowProviderHosts('ok.example.com', entry);
      for (const who of ['example-collaborator', 'example-owner']) {
        const text = await (await fetch(url, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).text();
        assert.doesNotMatch(text, /s3cret/, `${who}: ${entry}`);
        assert.match(text, /hosts entry 2/, `${who}: the refusal is there (${entry})`);
      }
    }
  } finally {
    Object.assign(machineProviderHosts, saved);
    await d.close();
  }
});

test('GET /api/health: the owners and writers get the provider hosts line; a viewer gets none of it, nor any host in it', { skip: !posix && 'root-owned files are POSIX' }, async () => {
  const saved = { ...machineProviderHosts };
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  cfg.agents = AgentsConfig.parse({ ...base, providers: { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'small-1' }, hosted: { glm: GLM } } });
  const stateDir = mkdtempSync(join(tmpdir(), 'prov-health-'));
  const db = join(stateDir, 'events.db');
  new EventLog(db).close();
  const d = await startDashboard({ root, cfg, eventsDb: db, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(stateDir, 'slots'), pollMs: 50 });
  try {
    const f = allowProviderHosts('127.0.0.1:8080');
    const url = `${d.url.split('/?')[0]!}/api/health`;
    const get = async (who: string) => (await fetch(url, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).json() as Promise<{ providerHosts?: unknown }>;
    for (const who of ['example-collaborator', 'example-owner']) {
      assert.deepEqual((await get(who)).providerHosts, { file: f, state: 'ok', hosts: ['127.0.0.1:8080'], error: null, refused: [{ provider: 'hosted:glm', reason: `open.example.com is not an allowed provider host (127.0.0.1:8080, from ${f})` }] }, who);
    }
    const viewer = await get('someone-else');
    assert.equal(viewer.providerHosts, null, 'a viewer gets no provider hosts');
    assert.doesNotMatch(JSON.stringify(viewer), /127\.0\.0\.1|open\.example\.com|providers\.json/, "no host, nor the file, anywhere in a viewer's health");
  } finally {
    Object.assign(machineProviderHosts, saved);
    await d.close();
  }
});

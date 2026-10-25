// What children trust (#391 follow-up, src/network.ts): no CA bundle, CA directory, client certificate or switch that
// loosens TLS verification reaches claude, gh, git or a project command from the coordinator's own environment (or
// git config carried in it); a custom CA comes only from root's network.json `ca_file`, a root-owned regular file of
// PEM certificates in a root-owned directory. Nothing can turn verification off. The spawn tests go through the
// engine's real spawn paths (instanceTokens' gh, CliRunner's claude, projectCommand) to stand-ins that record their env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Instance } from '../src/instance.js';
import { CA_VARS, isRedirectGitKey, isRedirectVar, machineNetwork, NETWORK_LIMITS, networkHealth, outboundEnv, readCaFile, readNetworkConfig } from '../src/network.js';
import { projectCommand } from '../src/os/index.js';
import { CliRunner, type RunRequest } from '../src/runner.js';
import { instanceEnv, instanceTokens } from '../src/service.js';

const posixOnly = process.platform === 'win32' && 'POSIX file owners and modes, and POSIX stand-ins for claude and gh';
const me = typeof process.getuid === 'function' ? process.getuid() : -1;
const OUTSIDE = '/tmp/attacker-ca.pem';

/** The owner's list, then the others of the same kind that claude, gh (Go), git (libcurl/OpenSSL) and node honour. */
const LISTED = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_SSL_NO_VERIFY', 'NODE_TLS_REJECT_UNAUTHORIZED'];
const ALSO = [
  'GIT_SSL_CERT', 'GIT_SSL_KEY', 'GIT_SSL_CERT_PASSWORD_PROTECTED', 'GIT_SSL_VERSION', 'GIT_SSL_CIPHER_LIST', 'GIT_SSL_PINNEDPUBKEY',
  'GIT_PROXY_SSL_CAINFO', 'GIT_PROXY_SSL_CERT', 'GIT_PROXY_SSL_KEY', 'GIT_HTTP_PROXY_AUTHMETHOD', 'GIT_CONFIG_PARAMETERS',
  'NODE_USE_SYSTEM_CA', 'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'GODEBUG', 'SSLKEYLOGFILE',
  'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
];
const TLS = [...LISTED, ...ALSO];
/** The coordinator's own environment, with every trust variable set (and NODE_OPTIONS asking for OpenSSL's store). */
const poisoned = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(TLS.map((k) => [k, OUTSIDE])),
  ssl_cert_file: OUTSIDE,
  git_ssl_no_verify: '1',
  NODE_OPTIONS: '--use-openssl-ca',
  ...extra,
});

// Two self-signed test certificates (EC P-256, CN example-test-ca-a and -b): public material only.
const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBbzCCARSgAwIBAgIUeV4RHf0uYY177J/sM/aZ6XVdJkwwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRZXhhbXBsZS10ZXN0LWNhLWEwIBcNMjYxMDE0MDUzNDMxWhgP
MjEyNjA5MjAwNTM0MzFaMBwxGjAYBgNVBAMMEWV4YW1wbGUtdGVzdC1jYS1hMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErKUGgiUuL7xY1HTHqGMTqPFwqWWP3ym6
AO3NDeSDHiWt2FxRcCu3IhVQtCxSuau9DwSuUdojeNOYf30YdCIdmaMyMDAwHQYD
VR0OBBYEFAE6LsF68DNoXBLwjVHWGMCAQ1GeMA8GA1UdEwEB/wQFMAMBAf8wCgYI
KoZIzj0EAwIDSQAwRgIhAKVZYsU9sQFjgw8OB9/bJoptuY0wbghxX7vSKZCxEuk/
AiEApO2ePi1D8n9i14kheZnNNfKhudtl/YdleQEHoTSboE4=
-----END CERTIFICATE-----
`;
const CERT_B = `-----BEGIN CERTIFICATE-----
MIIBbzCCARSgAwIBAgIUELBOYe0peWbPxb635Qx0ScP1K9cwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRZXhhbXBsZS10ZXN0LWNhLWIwIBcNMjYxMDE0MDUzNDMxWhgP
MjEyNjA5MjAwNTM0MzFaMBwxGjAYBgNVBAMMEWV4YW1wbGUtdGVzdC1jYS1iMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXTTInFP13Nl8Bd1MSZVjj1F2wkQliaU9
dpoD9iL1/D3g2b6I72ExKaJjHayQ4C8o2eNTSBxeTG+bqlubjIfTyaMyMDAwHQYD
VR0OBBYEFP7usrLrfek1t+dINLAONdOC5zk0MA8GA1UdEwEB/wQFMAMBAf8wCgYI
KoZIzj0EAwIDSQAwRgIhAOB9TM4OLia7YDsx9koduf3drLmKXjLb37+sXra+GvBX
AiEAy4Xzdw7Ac4PpHkURgdZzQqU3gVNiB1R/VDSKK3XrIXQ=
-----END CERTIFICATE-----
`;
const fp = (pem: string) => new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();

/** A CA file owned by this user (the tests' stand-in for root), in a fresh directory of its own (0700). */
function caFile(text: string, mode = 0o644): string {
  const dir = mkdtempSync(join(tmpdir(), 'ca-'));
  const f = join(dir, 'corp.pem');
  writeFileSync(f, text);
  chmodSync(f, mode);
  return f;
}

/** A network.json owned by this user, 0644. */
function networkFile(body: unknown): string {
  const f = join(mkdtempSync(join(tmpdir(), 'network-')), 'network.json');
  writeFileSync(f, JSON.stringify(body));
  chmodSync(f, 0o644);
  return f;
}

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

/** Every trust variable a child got (any casing), with its value: by this file's own list, not the code under test. */
const TRUST_NAMES = new Set(TLS.map((k) => k.toUpperCase()));
const trustIn = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([k]) => TRUST_NAMES.has(k.toUpperCase())));
const CA_SET = (path: string) => Object.fromEntries(CA_VARS.map((k) => [k, path]));
const parseEnv = (text: string) => Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

test('every trust variable, in every casing, is stripped; NODE_OPTIONS with a TLS flag goes, without one stays', () => {
  for (const k of TLS) for (const c of [k, k.toLowerCase(), k.toUpperCase()]) assert.ok(isRedirectVar(c), c);
  for (const k of ['NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'GIT_AUTHOR_NAME', 'SSL_CERT', 'NODE_ENV', 'GIT_SSH_COMMAND']) assert.equal(isRedirectVar(k), false, k);
  assert.deepEqual(outboundEnv({ ...poisoned(), PATH: '/bin' }, null), { PATH: '/bin' });
  for (const flag of ['--use-openssl-ca', '--use-bundled-ca', '--use-system-ca', '--openssl-config=/tmp/x.cnf', '--tls-min-v1.0', '--tls-keylog=/tmp/k', '--openssl-legacy-provider', '--max-old-space-size=100 --tls-cipher-list=NULL']) {
    assert.deepEqual(outboundEnv({ NODE_OPTIONS: flag }, null), {}, flag);
  }
  assert.deepEqual(outboundEnv({ NODE_OPTIONS: '--max-old-space-size=4096 --import=/x/loop.mjs' }, null), { NODE_OPTIONS: '--max-old-space-size=4096 --import=/x/loop.mjs' });
});

test('git config in the environment loses every TLS, proxy and URL-rewrite key, and keeps the rest, renumbered', () => {
  for (const k of ['http.sslVerify', 'HTTP.SSLVERIFY', 'http.sslCAInfo', 'http.sslCAPath', 'http.sslCert', 'http.sslKey', 'http.sslBackend', 'http.sslVersion', 'http.sslCipherList', 'http.https://github.com/.sslVerify', 'http.proxy', 'http.proxySSLCAInfo', 'http.proxyAuthMethod', 'http.schannelCheckRevoke', 'http.pinnedPubkey', 'http.curloptResolve', 'url.https://evil.invalid/.insteadOf', 'url.git@x:.pushInsteadOf']) assert.ok(isRedirectGitKey(k), k);
  for (const k of ['credential.helper', 'core.hooksPath', 'safe.directory', 'http.extraHeader', 'http.postBuffer', 'user.name']) assert.equal(isRedirectGitKey(k), false, k);
  const env = outboundEnv(
    {
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.sslVerify', GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'safe.directory', GIT_CONFIG_VALUE_2: '*',
      GIT_CONFIG_KEY_3: 'url.https://evil.invalid/.insteadOf', GIT_CONFIG_VALUE_3: 'https://github.com/',
      GIT_CONFIG_KEY_4: 'http.https://github.com/.sslCAInfo', GIT_CONFIG_VALUE_4: OUTSIDE,
    },
    null,
  );
  assert.deepEqual(env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '*' });
});

/** What git itself reads from `env`'s config pairs: `git config --get` of `key`, or null when git fails or has none. */
function gitReads(env: Record<string, string | undefined>, key: string): { status: number | null; value: string | null } {
  const r = spawnSync('git', ['config', '--get', key], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, ...env } });
  return { status: r.status, value: r.status === 0 ? r.stdout.trim() : null };
}

test('a GIT_CONFIG_COUNT that is not a plain decimal is made one git refuses, never rewritten into one it reads (#1001)', () => {
  // git refuses the first five ("bogus count"), and Number() read each as 1, so the pair git would have refused was
  // applied. git reads the others as 1; a parse that tries to match git's is how signs went wrong before (#927), so
  // they are refused too.
  for (const count of ['1 ', '0x1', '1e0', '1.0', '1\n', 'abc', ' 1', '+1', '01', '\t1']) {
    const env = outboundEnv({ GIT_CONFIG_COUNT: count, GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'caller' }, null);
    assert.notEqual(env.GIT_CONFIG_COUNT, '1', JSON.stringify(count));
    const r = gitReads(env, 'user.name');
    assert.equal(r.value, null, `${JSON.stringify(count)}: git read the pair`);
    assert.notEqual(r.status, 0, JSON.stringify(count));
  }
  // The plain counts the engine writes are read as before.
  assert.equal(gitReads(outboundEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'caller' }, null), 'user.name').value, 'caller');
  assert.deepEqual(outboundEnv({ GIT_CONFIG_COUNT: '0' }, null), { GIT_CONFIG_COUNT: '0' });
});

test('a GIT_CONFIG_COUNT over the bound is refused, so its TLS key never reaches git unstripped (#1001)', () => {
  const n = 1001;
  const e: Record<string, string> = { GIT_CONFIG_COUNT: String(n) };
  for (let i = 0; i < n; i++) {
    e[`GIT_CONFIG_KEY_${i}`] = `x.k${i}`;
    e[`GIT_CONFIG_VALUE_${i}`] = 'v';
  }
  e.GIT_CONFIG_KEY_5 = 'http.sslVerify';
  e.GIT_CONFIG_VALUE_5 = 'false';
  assert.equal(gitReads(e, 'http.sslVerify').value, 'false', 'git reads every pair of a large count (the setting this test guards)');
  const r = gitReads(outboundEnv(e, null), 'http.sslVerify');
  assert.equal(r.value, null, 'http.sslVerify=false reached git');
  assert.notEqual(r.status, 0);
});

test('a custom CA: a root-owned file of PEM certificates sets exactly NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and GIT_SSL_CAINFO', { skip: posixOnly }, () => {
  const ca = caFile(`${CERT_A}\n${CERT_B}`);
  const c = readNetworkConfig(networkFile({ ca_file: ca }), { ownerUid: me });
  assert.equal(c.error, null);
  assert.equal(c.proxy, null, 'a CA without a proxy is allowed');
  assert.deepEqual(c.ca, { path: ca, count: 2, fingerprints: [fp(CERT_A), fp(CERT_B)] });
  assert.deepEqual(outboundEnv({ ...poisoned(), PATH: '/bin' }, c), { PATH: '/bin', ...CA_SET(ca) });
  assert.deepEqual(CA_VARS, ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO']);
  // With a proxy too: both, and still nothing that turns verification off.
  const both = readNetworkConfig(networkFile({ proxy: 'http://proxy.internal:3128', ca_file: ca }), { ownerUid: me });
  const env: Record<string, string | undefined> = outboundEnv({ ...poisoned(), PATH: '/bin' } as Record<string, string | undefined>, both);
  assert.equal(env.HTTPS_PROXY, 'http://proxy.internal:3128');
  assert.equal(env.GIT_SSL_CAINFO, ca);
  for (const k of ['NODE_TLS_REJECT_UNAUTHORIZED', 'GIT_SSL_NO_VERIFY', 'SSL_CERT_DIR', 'NODE_OPTIONS']) assert.equal(env[k], undefined, k);
});

test('a custom CA is refused: wrong owner, writable, in a writable directory, a symlink, not PEM, oversized, or a bad path; the whole file goes', { skip: posixOnly }, () => {
  const good = caFile(CERT_A);
  const refused = (path: unknown, why: RegExp, owner = me) => {
    const r = readCaFile(path, owner);
    assert.ok('error' in r, `${String(path)}: expected a refusal`);
    assert.match(r.error, why, String(path));
  };
  if (me !== 0) refused(good, /isn't root's \(owner uid \d+\)/, 0);
  refused(good, /isn't root's/, me + 1);
  for (const mode of [0o664, 0o646, 0o666]) refused(caFile(CERT_A, mode), /is writable by its group or others \(mode 06\d\d\)/);
  const open = caFile(CERT_A);
  chmodSync(join(open, '..'), 0o777);
  refused(open, /directory .* must be root's and not writable by its group or others/);
  const link = join(mkdtempSync(join(tmpdir(), 'ca-')), 'corp.pem');
  symlinkSync(good, link);
  refused(link, /is a symlink/);
  const dirAsFile = join(mkdtempSync(join(tmpdir(), 'ca-')), 'corp.pem');
  mkdirSync(dirAsFile);
  refused(dirAsFile, /is not a regular file/);
  refused(join(tmpdir(), 'no-such-ca', 'corp.pem'), /doesn't exist/);
  refused(caFile(''), /holds no PEM certificate/);
  refused(caFile('not a certificate at all\n'), /holds something other than PEM certificates/);
  refused(caFile(`${CERT_A}\nstray text\n`), /holds something other than PEM certificates/);
  refused(caFile(`-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n`), /holds something other than PEM certificates/);
  refused(caFile(CERT_A.replace('MIIBbzCCARSgAwIBAgIU', 'MIIBbzCCARSgAwIBAgIX')), /certificate 1 doesn't parse/);
  refused(caFile(`${CERT_A}${' '.repeat(NETWORK_LIMITS.caBytes)}`), /is over 262144 bytes/);
  refused(caFile(CERT_A.repeat(NETWORK_LIMITS.caCerts + 1)), /more than 64 certificates/);
  for (const bad of ['relative/corp.pem', '/etc/x/../corp.pem', '/etc/x/./corp.pem', '/etc//x/corp.pem', '/etc/x/corp pem', `/${'a'.repeat(NETWORK_LIMITS.caPath)}`, 42, '']) refused(bad, /ca_file must be|longer than/);
  // A refused CA refuses the whole file: no proxy either.
  const c = readNetworkConfig(networkFile({ proxy: 'http://proxy.internal:3128', ca_file: link }), { ownerUid: me });
  assert.deepEqual([c.proxy, c.ca], [null, null]);
  assert.match(c.error ?? '', /is a symlink \(it must be a regular file\); no outbound proxy or custom CA is set$/);
});

test('no setting turns verification off: any such key is an unknown key, and the file is refused', { skip: posixOnly }, () => {
  for (const key of ['insecure', 'verify', 'ssl_verify', 'tls_reject_unauthorized', 'no_verify', 'ca_dir']) {
    const c = readNetworkConfig(networkFile({ [key]: key === 'verify' ? false : true }), { ownerUid: me });
    assert.match(c.error ?? '', /unknown key/, key);
  }
});

/** A stand-in gh that prints its environment as `gh auth token` output. */
function standInGh(): string {
  const bin = mkdtempSync(join(tmpdir(), 'env-gh-'));
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nenv\n');
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

function fakeInstance(): Instance {
  const home = mkdtempSync(join(tmpdir(), 'tls-inst-'));
  mkdirSync(join(home, 'gh'));
  return { name: 'shop', home, stateDir: join(home, 'state'), runAs: null, credentials: { version: 1, github: { kind: 'gh-config-dir', path: join(home, 'gh') } } } as unknown as Instance;
}

test('gh, through the coordinator\'s real path (instanceEnv, then instanceTokens): no inherited trust variable; root\'s CA when set', { skip: posixOnly }, async () => {
  const bin = standInGh();
  const i = fakeInstance();
  const base = poisoned({ PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: i.home });
  const gh = () => instanceTokens(i, instanceEnv(i, base))().then(parseEnv);
  const plain = await withNetwork(null, gh);
  assert.deepEqual(trustIn(plain), {}, 'nothing changes what gh trusts');
  assert.equal(plain.NODE_OPTIONS, undefined);
  assert.equal(plain.GH_CONFIG_DIR, join(i.home, 'gh'), 'gh still gets the instance login');
  const ca = caFile(CERT_A);
  assert.deepEqual(trustIn(await withNetwork(networkFile({ ca_file: ca }), gh)), CA_SET(ca), "root's CA, and nothing inherited");
  const bad = caFile(CERT_A, 0o666);
  assert.deepEqual(trustIn(await withNetwork(networkFile({ ca_file: bad }), gh)), {}, 'a refused CA: none, never the inherited one');
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
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01 }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 200);
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, got: (which: 'auth' | 'run') => JSON.parse(readFileSync(join(dir, `${which}.json`), 'utf8')) as Record<string, string> };
}

const req = (cwd: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000 });

test("claude, through CliRunner on the coordinator's environment: no inherited trust variable in its auth probe or run; root's CA when set", { skip: posixOnly }, async () => {
  const i = fakeInstance();
  const base = () => instanceEnv(i, poisoned({ PATH: process.env.PATH ?? '', HOME: i.home, CLAUDE_CONFIG_DIR: join(i.home, 'claude') }));
  const plain = standInClaude();
  const r = await withNetwork(null, () => new CliRunner('cli', base(), plain.bin).run(req(plain.dir)));
  assert.equal(r.reason, 'succeeded', r.detail);
  for (const w of ['auth', 'run'] as const) assert.deepEqual(trustIn(plain.got(w)), {}, w);
  const ca = caFile(`${CERT_A}${CERT_B}`);
  const withCa = standInClaude();
  const c = await withNetwork(networkFile({ ca_file: ca }), () => new CliRunner('cli', base(), withCa.bin).run(req(withCa.dir)));
  assert.equal(c.reason, 'succeeded', c.detail);
  for (const w of ['auth', 'run'] as const) assert.deepEqual(trustIn(withCa.got(w)), CA_SET(ca), `${w}: root's CA only`);
});

test('project commands (childEnv, through projectCommand): no inherited trust variable or git TLS config; root\'s CA when set', { skip: posixOnly }, async () => {
  const saved = { ...process.env };
  // NODE_OPTIONS stays out of this process's own environment: the flag would apply to any node it starts.
  const { NODE_OPTIONS: _flag, ...rest } = poisoned();
  Object.assign(process.env, rest, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.sslVerify', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'x' });
  try {
    const envOf = () => {
      const c = projectCommand('env');
      return parseEnv(spawnSync(c.file, c.args, { env: c.env, encoding: 'utf8' }).stdout);
    };
    const plain = await withNetwork(null, envOf);
    assert.deepEqual(trustIn(plain), {});
    assert.deepEqual([plain.GIT_CONFIG_COUNT, plain.GIT_CONFIG_KEY_0, plain.GIT_CONFIG_KEY_1], ['1', 'user.name', undefined], 'http.sslVerify=false never reaches git');
    const ca = caFile(CERT_A);
    assert.deepEqual(trustIn(await withNetwork(networkFile({ ca_file: ca }), envOf)), CA_SET(ca));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the Health line: the CA path, how many certificates and their short fingerprints; the refusal when refused', { skip: posixOnly }, async () => {
  const ca = caFile(`${CERT_A}${CERT_B}`);
  const f = networkFile({ ca_file: ca });
  assert.deepEqual(await withNetwork(f, () => networkHealth()), { proxy: null, file: f, ca: { path: ca, count: 2, fingerprints: [fp(CERT_A).slice(0, 16), fp(CERT_B).slice(0, 16)] }, error: null });
  const bad = networkFile({ ca_file: caFile('nope\n') });
  const h = await withNetwork(bad, () => networkHealth());
  assert.equal(h?.ca, null);
  assert.match(h?.error ?? '', /holds something other than PEM certificates/);
});

// GitHub's hosts are constants on every path that carries a credential (issue #377): no environment variable, config
// key or argument names another host for an App JWT, an installation token, a manifest code or a client secret.
// A static check over the engine and the setup scripts, and behavioural ones with every such variable pointing
// elsewhere. (A test or CI job that runs the engine as its own process against a fake GitHub loads
// scripts/ci/loopback-github.mjs into it; that stand-in is held to this machine below.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { BRAND } from '../src/brand.js';
import { installationTokens } from '../src/github-app.js';
import * as hosts from '../src/github-hosts.js';
import { checkRepoScope } from '../src/github-scope.js';
import { ghOverRest } from '../src/server-auto-config.js';
import { availableAppName, convertManifest, installUrl, manifestTarget, ManifestFlows, verifyWithScript } from '../src/setup/app-manifest.js';
import { childEnv } from '../src/os/index.js';
import { loopbackGitHub, repoRoot } from './helpers.js';

const ELSEWHERE = 'https://elsewhere.example.test';
/** Every variable that named, or by its name could name, a GitHub host for the engine, gh or Actions. */
const HOST_VARIABLES = [`${BRAND.envPrefix}_GITHUB_API`, `${BRAND.envPrefix}_GITHUB_WEB`, 'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'GITHUB_GRAPHQL_URL', 'GH_HOST', 'GITHUB_HOST'];
/** A name that says "a host": what an override would be called. */
const HOSTISH = /(?:^|_)(?:URL|URI|HOST|HOSTNAME|API|BASE|ENDPOINT|WEB|ORIGIN|SERVER|DOMAIN|PROXY)$/;

/**
 * The code that sends a GitHub credential, or decides where one goes: the App's token minting and scope check, the
 * coordinator's and dashboard's token use, the manifest flow, sign-in, the credential helper (cli.ts) and the setup
 * scripts that run them.
 */
const CREDENTIAL_PATHS = [
  'src/github-hosts.ts',
  'src/github-app.ts',
  'src/github-scope.ts',
  'src/service.ts',
  'src/server-auto-config.ts',
  'src/dashboard.ts',
  'src/dashboard-auth.ts',
  'src/dashboard-hub.ts',
  'src/cli.ts',
  'src/setup/app-manifest.ts',
  'src/backlog/github.ts',
  'src/github/ci-metrics-api.ts',
  'src/github/main-watch-api.ts',
  'src/github/merge-posts-api.ts',
  'src/coordinator/test-runs.ts',
  'src/testrun/checks.ts',
  'src/deploy-gate/railway.ts',
  'src/deploy-gate/wire.ts',
  'src/preview/github.ts',
  'scripts/setup/app-permissions.mjs',
  'scripts/setup/checkout.sh',
  'scripts/setup/credentials.sh',
  'scripts/setup/add-project.sh',
  'scripts/setup/lib.sh',
];

const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(repoRoot, p).split(sep).join('/'));
    }
  };
  walk(join(repoRoot, dir));
  return out;
}

/** The environment variables a file reads, by name (a `${BRAND.envPrefix}_X` read is named `_X`). */
function envReads(file: string, text: string): string[] {
  const names = new Set<string>();
  if (/\.(?:sh)$/.test(file)) {
    // Shell: every ${NAME...} or $NAME that isn't a positional, a local lowercase name or a special.
    for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1]!);
  } else {
    for (const m of text.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]!);
    for (const m of text.matchAll(/(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) names.add(m[1]!);
    for (const m of text.matchAll(/env\[\s*`\$\{BRAND\.envPrefix\}(_[A-Z0-9_]+)`\s*\]/g)) names.add(m[1]!);
    // A name built some other way can't be read off the page: none may be (clearing a variable is not a read).
    for (const m of text.matchAll(/(?<!delete )process\.env\[(?!\s*['"`])([^\]]{0,60})/g)) names.add(`<computed: ${m[1]!.trim()}>`);
  }
  return [...names];
}

test('the hosts are two constants, and the module that holds them reads nothing', () => {
  assert.deepEqual({ ...hosts }, { GITHUB_API: 'https://api.github.com', GITHUB_WEB: 'https://github.com' });
  assert.doesNotMatch(read('src/github-hosts.ts'), /process\.env|readFileSync|import /);
});

test('no credential-bearing file reads an environment variable that can name a host', () => {
  for (const f of CREDENTIAL_PATHS) {
    const bad = envReads(f, read(f)).filter((n) => HOSTISH.test(n) || n.startsWith('<computed'));
    assert.deepEqual(bad, [], `${f} reads ${bad.join(', ')}`);
  }
});

test("nothing in the engine, its setup scripts or its templates names the old override or GitHub's own host variables", () => {
  const FORBIDDEN = /_GITHUB_(?:API|WEB)\b|GITHUB_API_URL|GITHUB_SERVER_URL|GITHUB_GRAPHQL_URL|\bGH_HOST\b|\bGITHUB_HOST\b/;
  const files = [...filesUnder('src'), ...filesUnder('scripts/setup'), ...filesUnder('scripts/machine'), ...filesUnder('templates'), 'scripts/bootstrap.sh'];
  assert.ok(files.length > 150, `looked at ${files.length} files`);
  const hits = files.filter((f) => FORBIDDEN.test(read(f)));
  assert.deepEqual(hits, []);
});

test('the setup scripts send the App to GitHub itself: the clone and the permission check name the host outright', () => {
  assert.match(read('scripts/setup/checkout.sh'), /clone -q "https:\/\/github\.com\/\$3\.git" "\$2"/);
  const perms = read('scripts/setup/app-permissions.mjs');
  assert.match(perms, /const api = 'https:\/\/api\.github\.com';/);
  assert.doesNotMatch(perms, /process\.env/);
});

/** Run `f` with every host variable pointing elsewhere. */
async function elsewhere<T>(f: () => Promise<T>): Promise<T> {
  const saved = HOST_VARIABLES.map((n) => process.env[n]);
  for (const n of HOST_VARIABLES) process.env[n] = ELSEWHERE;
  try {
    return await f();
  } finally {
    HOST_VARIABLES.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
  }
}

test('with every host variable pointing elsewhere, each credential still goes to GitHub: the App JWT, the installation token, the manifest code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-hosts-'));
  const key = join(dir, 'key.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  const asked: { url: string; credential: boolean }[] = [];
  const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, credential: /authorization/i.test(JSON.stringify(init?.headers ?? {})) });
    if (/\/access_tokens$/.test(url)) return new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2099-01-01T00:00:00Z', permissions: {}, repositories: [{ full_name: 'example/alpha' }], repository_selection: 'selected' }), { status: 201 });
    if (/\/app-manifests\//.test(url)) return new Response(JSON.stringify({ id: 1, slug: 'a', client_id: 'c', client_secret: 's', pem: 'p' }), { status: 201 });
    if (/\/users\//.test(url)) return new Response(JSON.stringify({ id: 5, type: 'User' }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  await elsewhere(async () => {
    // Each as the engine calls it: no host argument, only fetch stood in.
    await installationTokens({ appId: 91, installationId: 4242, keyPath: key }, ['example/alpha'], dir, github)().catch(() => undefined);
    await checkRepoScope('ghs_x', ['example/alpha'], github).catch(() => undefined);
    await convertManifest('the-code', { fetch: github }).catch(() => undefined);
    await availableAppName('alpha-app', { fetch: github }).catch(() => undefined);
    await ghOverRest('example/alpha', async () => 'ghs_x', undefined, github)(['pr', 'list', '--head', 'x', '--json', 'number']).catch(() => undefined);
    const flows = new ManifestFlows({ isMachineOwner: () => true, signIn: true, publicUrl: 'https://hub.example.test', fetch: github });
    const reg = await flows.register({ kind: 'agent', instance: 'alpha', repo: 'example/alpha' });
    const page = flows.page(reg.id, 'ada');
    assert.equal(page.formAction, 'https://github.com', 'the manifest is posted to GitHub');
    assert.equal(new URL(manifestTarget('example', 'User', 's')).origin, 'https://github.com');
    assert.equal(new URL(installUrl('alpha-app', null)).origin, 'https://github.com');
  });
  assert.ok(asked.length >= 6, `asked ${asked.length}: ${asked.map((a) => a.url).join(' ')}`);
  for (const a of asked) assert.equal(new URL(a.url).origin, 'https://api.github.com', a.url);
  assert.ok(asked.filter((a) => a.credential).length >= 2, 'credentials did travel, to that host');
});

test("the credential helper answers for github.com only: a host from the old variable gets nothing, and nothing is sent to it", { skip: process.platform === 'win32' }, async () => {
  // A listener standing where the old override would have pointed: it must hear nothing.
  const heard: string[] = [];
  const server = createServer((req, res) => {
    heard.push(`${req.method} ${req.url}`);
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'ghs_leaked', expires_at: '2099-01-01T00:00:00Z' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const there = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const env = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: mkdtempSync(join(tmpdir(), 'gh-hosts-inst-')), ...Object.fromEntries(HOST_VARIABLES.map((n) => [n, there])) };
    const helper = (host: string) => spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), 'git-credential', '--instance', 'site', 'get'], { input: `protocol=http\nhost=${host}\npath=example/alpha.git\n\n`, encoding: 'utf8', env, timeout: 30_000 });
    for (const host of [new URL(there).host, 'elsewhere.example.test', 'api.github.com.elsewhere.example.test']) {
      const r = helper(host);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', `${host}: not ours, no credential`);
    }
    // github.com is ours: with no such instance it stops git rather than answer, still without a word to the other host.
    assert.match(helper('github.com').stdout, /^quit=1$/m);
    assert.deepEqual(heard, []);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the loopback stand-in reaches this machine only: GitHub goes to its port, anything else is refused, and it takes nothing but a port', { skip: process.platform === 'win32' }, () => {
  const standIn = loopbackGitHub('http://127.0.0.1:8999');
  const probe = (env: Record<string, string>, url: string) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `const { loopbackTarget } = await import(process.argv[1]); try { console.log(loopbackTarget(process.argv[2])); } catch (e) { console.log('REFUSED ' + e.message); }`, standIn.NODE_OPTIONS!.replace('--import=', ''), url], { encoding: 'utf8', env: { ...childEnv(), ...env } });
  const port = { CI_LOOPBACK_GITHUB_PORT: '8999' };
  assert.equal(probe(port, 'https://api.github.com/app?x=1').stdout.trim(), 'http://127.0.0.1:8999/app?x=1');
  assert.equal(probe(port, 'https://github.com/login/oauth/access_token').stdout.trim(), 'http://127.0.0.1:8999/login/oauth/access_token');
  assert.equal(probe(port, 'http://127.0.0.1:4398/api/hub').stdout.trim(), 'http://127.0.0.1:4398/api/hub', 'this machine, as asked');
  for (const out of ['https://elsewhere.example.test/x', 'https://api.github.com.elsewhere.example.test/app', 'https://discord.com/api/v10/users/@me', 'http://elsewhere.example.test:8999/app']) {
    assert.match(probe(port, out).stdout, /^REFUSED /, out);
  }
  // Told anything but a port, it doesn't run at all.
  for (const bad of ['', 'elsewhere.example.test:443', '8999@example.com', '0', '99999', '8999/x']) {
    const r = probe({ CI_LOOPBACK_GITHUB_PORT: bad }, 'https://api.github.com/app');
    assert.equal(r.status, 2, `"${bad}": ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /must be a port on 127\.0\.0\.1/);
  }
  // The port inside the import URL (it survives a user switch that clears the environment), taking precedence.
  const inUrl = spawnSync(process.execPath, ['--input-type=module', '-e', `const { loopbackTarget } = await import(process.argv[1]); console.log(loopbackTarget('https://api.github.com/app'));`, `${standIn.NODE_OPTIONS!.replace('--import=', '')}?port=8998`], { encoding: 'utf8', env: { ...childEnv(), CI_LOOPBACK_GITHUB_PORT: '8999' } });
  assert.equal(inUrl.stdout.trim(), 'http://127.0.0.1:8998/app', inUrl.stderr);
  const badInUrl = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', `${standIn.NODE_OPTIONS!.replace('--import=', '')}?port=elsewhere.example.test`], { encoding: 'utf8', env: { ...childEnv() } });
  assert.equal(badInUrl.status, 2);
  assert.throws(() => loopbackGitHub('https://elsewhere.example.test'), /127\.0\.0\.1/);
  // And the engine's own tree never loads it: it is CI's and the tests'.
  for (const f of [...filesUnder('src'), ...filesUnder('scripts/setup'), ...filesUnder('scripts/machine'), 'scripts/bootstrap.sh']) assert.doesNotMatch(read(f), /loopback-github|CI_LOOPBACK_GITHUB_PORT/, f);
});

test("the permission check's own process keeps the node options it was started with across the user switch, so a test's stand-in reaches it", async () => {
  const seen: { file: string; argv: string[] }[] = [];
  const fakeSpawn = ((file: string, argv: string[]) => {
    seen.push({ file, argv });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--no-warnings';
  try {
    await verifyWithScript({ spawn: fakeSpawn })({ user: 'someone-else', key: '/k', appId: 1, installationId: 2, repo: 'example/alpha' });
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
  assert.equal(seen[0]!.file, 'sudo');
  const argv = seen[0]!.argv;
  const clean = argv.indexOf('-i');
  assert.ok(clean > 0 && argv[clean - 1] === '/usr/bin/env', argv.join(' '));
  assert.ok(argv.slice(clean + 1).includes('NODE_OPTIONS=--no-warnings'), `kept past env -i: ${argv.join(' ')}`);
});

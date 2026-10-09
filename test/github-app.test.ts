import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { appJwt, installationTokens, mintInstallationToken } from '../src/github-app.js';
import { initInstance } from '../src/instance.js';
import { childEnv } from '../src/os/index.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const keyFile = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'app-key-')), 'key.pem');
  writeFileSync(f, pem, { mode: 0o400 });
  return f;
};

test('the App JWT is RS256-signed by the App key, issued by the App id, valid under 10 minutes', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const [h, p, sig] = appJwt(123, pem, now).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, '123');
  assert.equal(claims.iat, now / 1000 - 60, 'backdated for clock skew');
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url')));
});

test('installation tokens are minted for the instance repos only, cached privately, and renewed before they expire', async () => {
  const calls: { url: string; body: unknown; auth: string }[] = [];
  let n = 0;
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
    n++;
    return new Response(JSON.stringify({ token: `ghs_token${n}`, expires_at: new Date(Date.parse('2026-10-09T12:00:00Z') + 3_600_000).toISOString() }), { status: 201 });
  }) as unknown as typeof fetch;
  const c = { appId: 7, installationId: 42, keyPath: keyFile() };
  const t = await mintInstallationToken(c, ['example-org/example-shop'], fake, 'https://api.test');
  assert.equal(t.token, 'ghs_token1');
  assert.equal(calls[0]!.url, 'https://api.test/app/installations/42/access_tokens');
  assert.deepEqual(calls[0]!.body, { repositories: ['example-shop'] });
  assert.match(calls[0]!.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const state = mkdtempSync(join(tmpdir(), 'app-state-'));
  const tokens = installationTokens(c, ['example-org/example-shop'], state, fake, 'https://api.test');
  const t0 = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(await tokens(t0), 'ghs_token2');
  assert.equal(await tokens(t0 + 30 * 60_000), 'ghs_token2', 'cached while it has more than 10 minutes left');
  assert.equal(await tokens(t0 + 55 * 60_000), 'ghs_token3', 'renewed near expiry');
  if (process.platform !== 'win32') assert.equal(statSync(join(state, 'github-app-token.json')).mode & 0o777, 0o600);
});

/** A fake GitHub: mints installation tokens (checking the JWT) and lists what the installation reaches. */
async function fakeGitHub(reach: string[]) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += String(d)));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push(`${req.method} ${path}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        const [h, p, sig] = String(req.headers.authorization).replace(/^Bearer /, '').split('.');
        if (!createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url'))) {
          res.writeHead(401);
          return res.end('{}');
        }
        return res.end(JSON.stringify({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
      }
      if (path === '/installation/repositories') return res.end(JSON.stringify({ repositories: reach.map((full_name) => ({ full_name })) }));
      res.end('[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const cli = join(repoRoot, 'dist', 'src', 'cli.js');
const run = (args: string[], env: NodeJS.ProcessEnv, input = '') =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const p = spawn(process.execPath, [cli, ...args], { env, cwd: tmpdir() });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += String(d)));
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('exit', (status) => res({ status, stdout, stderr }));
    p.stdin.end(input);
  });

function appInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const { dir: repo } = exampleProject();
  const cfg = join(repo, BRAND.configDir);
  writeFileSync(join(cfg, 'config.yaml'), readFileSync(join(cfg, 'config.yaml'), 'utf8').replace(/^backlog: github/m, 'backlog: file'));
  const home = initInstance('site', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\n');
  mkdirSync(join(home, 'app'));
  writeFileSync(join(home, 'credentials.yaml'), `version: 1\ngithub: { kind: app, app_id: 7, installation_id: 42, key_path: ${JSON.stringify(keyFile())} }\n`);
  return { dir, home };
}

test('acceptance: an App instance starts with a minted installation token that reaches only its repo, and refuses one that reaches more', { skip: process.platform === 'win32' && 'POSIX' }, async () => {
  const { dir, home } = appInstance();
  const ok = await fakeGitHub(['example-org/example-shop']);
  const env = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir, [`${BRAND.envPrefix}_GITHUB_API`]: ok.api, GH_TOKEN: 'inherited-must-not-be-used' };
  try {
    const r = await run(['coordinator', 'run', '--instance', 'site', '--once'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(ok.seen.includes('POST /app/installations/42/access_tokens'), ok.seen.join(', '));
    assert.ok(ok.seen.includes('GET /installation/repositories'));
  } finally {
    await ok.close();
  }
  const wide = await fakeGitHub(['example-org/example-shop', 'example-org/other']);
  try {
    rmCache(home);
    const r = await run(['coordinator', 'run', '--instance', 'site', '--once'], { ...env, [`${BRAND.envPrefix}_GITHUB_API`]: wide.api });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /can reach 1 repo\(s\) outside this instance/);
  } finally {
    await wide.close();
  }
});

function rmCache(home: string) {
  try {
    writeFileSync(join(home, 'state', 'github-app-token.json'), '{}');
  } catch {
    // no cache yet
  }
}

test('git credential helper: hands git an installation token for GitHub, and nothing for other hosts', { skip: process.platform === 'win32' && 'POSIX' }, async () => {
  const { dir } = appInstance();
  const gh = await fakeGitHub(['example-org/example-shop']);
  const env = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir, [`${BRAND.envPrefix}_GITHUB_API`]: gh.api, [`${BRAND.envPrefix}_INSTANCE`]: 'site' };
  try {
    const r = await run(['git-credential', 'get'], env, 'protocol=https\nhost=github.com\n\n');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'username=x-access-token\npassword=ghs_installation\n');
    // Before the repo is cloned (no checkout, no repo config), the helper still works: it's how the clone authenticates.
    const instanceYaml = join(dir, 'site', 'instance.yaml');
    writeFileSync(instanceYaml, readFileSync(instanceYaml, 'utf8').replace(/path: ".*"/, 'path: "/nonexistent/checkout"'));
    const early = await run(['git-credential', 'get'], env, 'protocol=https\nhost=github.com\n\n');
    assert.equal(early.stdout, 'username=x-access-token\npassword=ghs_installation\n', early.stderr);
    const other = await run(['git-credential', 'get'], env, 'protocol=https\nhost=gitlab.example\n\n');
    assert.equal(other.stdout, '');
    assert.equal((await run(['git-credential', 'store'], env, 'host=github.com\n\n')).stdout, '');
  } finally {
    await gh.close();
  }
});

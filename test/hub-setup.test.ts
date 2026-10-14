// WHY: the hub's setup mode (src/hub-setup.ts) runs before sign-in exists, so its one gate is the one-time setup
// token. Each guard is checked here: the token only from its 0600 file, only in a form's body (never a URL), once; a
// lock after ten wrong tries; writes only from the page itself with its CSRF token; nothing past the gate without the
// session. And it turns itself off once the sign-in secret exists: at start, while running, and after it made the App.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { defaultAppPrefix, SETUP_COOKIE, SETUP_MAX_TRIES, SETUP_TOKEN_FILE, SetupOver, startSetupHub, type SetupHubOptions } from '../src/hub-setup.js';
import { APP_SECRET, fakeGitHub } from './fake-github.js';
import { engineCli, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const ORIGIN = 'https://hub.example.test';

function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'hub-setup-'));
  const stateDir = join(base, 'state');
  const signinDir = join(base, 'signin');
  return { stateDir, signinDir };
}

async function hub(over: Partial<SetupHubOptions> = {}, gh?: { api: string; web: string }) {
  const d = dirs();
  const h = await startSetupHub({ ...d, publicUrl: `${ORIGIN}/`, appPrefix: 'box', nextCommand: 'sudo bash dashboards.sh', checkMs: 30, ...(gh ? { github: gh } : {}), ...over });
  const port = Number(new URL(h.url).port);
  const token = readFileSync(h.tokenFile, 'utf8').trim();
  const call = (method: string, path: string, o: { body?: string; cookie?: string; origin?: string | null } = {}) =>
    new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((done, fail) => {
      const headers: Record<string, string> = {};
      if (o.body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
      if (o.cookie) headers.cookie = o.cookie;
      if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
      const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      r.on('error', fail);
      r.end(o.body);
    });
  const unlock = async (t = token) => {
    const r = await call('POST', '/setup/unlock', { body: `token=${encodeURIComponent(t)}` });
    const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${SETUP_COOKIE}=`));
    return { ...r, cookie: set ? set.split(';')[0]! : null, setCookie: set ?? null };
  };
  return { ...d, h, port, token, call, unlock };
}

test('the setup token: made on start in a 0600 file of this user, refused when that file is open to others; never shown on a page', { skip: !posix && 'POSIX modes' }, async () => {
  const s = await hub();
  try {
    assert.equal(s.h.tokenFile, join(s.stateDir, SETUP_TOKEN_FILE));
    assert.equal(statSync(s.h.tokenFile).mode & 0o777, 0o600);
    assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
    const page = await s.call('GET', '/', { origin: null });
    assert.equal(page.status, 200);
    assert.match(page.body, /type="password"/);
    assert.match(page.body, new RegExp(`sudo cat ${s.h.tokenFile.replace(/[/.]/g, '\\$&')}`), 'the page names the file');
    assert.ok(!page.body.includes(s.token), 'never the token');
  } finally {
    await s.h.close();
  }
  const d = dirs();
  mkdirSync(d.stateDir, { recursive: true });
  writeFileSync(join(d.stateDir, SETUP_TOKEN_FILE), `${'a'.repeat(43)}\n`);
  chmodSync(join(d.stateDir, SETUP_TOKEN_FILE), 0o644);
  await assert.rejects(startSetupHub({ ...d, publicUrl: ORIGIN }), /open to others \(0644\)/);
});

test('the token is never taken from a URL: a link carrying it is refused and unlocks nothing', { skip: !posix && 'POSIX modes' }, async () => {
  const s = await hub();
  try {
    for (const q of [`token=${s.token}`, `t=${s.token}`]) {
      const r = await s.call('GET', `/?${q}`, { origin: null });
      assert.equal(r.status, 400);
      assert.match(r.body, /never put in a link/);
      const p = await s.call('POST', `/setup/unlock?${q}`, { body: '' });
      assert.equal(p.status, 400);
      assert.equal(p.headers['set-cookie'], undefined);
    }
    assert.ok(existsSync(s.h.tokenFile), 'still unused');
    assert.equal((await s.unlock()).status, 303, 'the form still works');
  } finally {
    await s.h.close();
  }
});

test('the token works once, from this page only: a wrong one, a form from another site and a reuse are refused; ten wrong tries lock it', { skip: !posix && 'POSIX modes' }, async () => {
  const s = await hub();
  try {
    const wrong = await s.unlock('x'.repeat(43));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.cookie, null);
    const cross = await s.call('POST', '/setup/unlock', { body: `token=${s.token}`, origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const ok = await s.unlock();
    assert.equal(ok.status, 303);
    assert.match(ok.setCookie!, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200$/);
    assert.equal(existsSync(s.h.tokenFile), false, 'the file goes once it is used');
    const again = await s.unlock();
    assert.equal(again.status, 410);
    assert.equal(again.cookie, null);
    const page = await s.call('GET', '/', { cookie: ok.cookie!, origin: null });
    assert.match(page.body, /name="owner"/, 'the session gets the App form');
  } finally {
    await s.h.close();
  }
  const l = await hub();
  try {
    for (let i = 0; i < SETUP_MAX_TRIES; i++) assert.equal((await l.unlock(`wrong${i}`)).status, 401);
    const locked = await l.unlock();
    assert.equal(locked.status, 429, 'locked: even the right token');
    assert.equal(locked.cookie, null);
  } finally {
    await l.h.close();
  }
});

test('nothing past the gate without the session, and no write without the page CSRF token or from another site', { skip: !posix && 'POSIX modes' }, async () => {
  const gh = await fakeGitHub({ repo: 'example/alpha', permissions: {} });
  const s = await hub({}, { api: gh.url, web: gh.url });
  try {
    for (const [m, p] of [
      ['POST', '/setup/signin-app'],
      ['GET', '/setup/app-manifest/start/amf-000000000000000000000000'],
      ['GET', '/setup/app-manifest/callback?state=x&code=y'],
    ] as const) {
      const r = await s.call(m, p, m === 'POST' ? { body: 'owner=example' } : { origin: null });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    const { cookie } = await s.unlock();
    assert.equal((await s.call('POST', '/setup/signin-app', { body: 'owner=example', cookie: cookie! })).status, 403, 'no CSRF token');
    const page = await s.call('GET', '/', { cookie: cookie!, origin: null });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    assert.equal((await s.call('POST', '/setup/signin-app', { body: `csrf=${csrf}&owner=example`, cookie: cookie!, origin: 'https://evil.example' })).status, 403, 'another site');
    assert.equal((await s.call('POST', '/setup/signin-app', { body: `csrf=${csrf}&owner=example`, cookie: `${SETUP_COOKIE}=forged` })).status, 401, 'a forged session');
  } finally {
    await s.h.close();
    await gh.close();
  }
});

test('the sign-in App through the manifest flow: the secrets stored for this user only, then setup mode turns itself off', { skip: !posix && 'POSIX modes' }, async () => {
  const gh = await fakeGitHub({ repo: 'example/alpha', permissions: {} });
  const s = await hub({}, { api: gh.url, web: gh.url });
  try {
    const { cookie } = await s.unlock();
    const page = await s.call('GET', '/', { cookie: cookie!, origin: null });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const go = await s.call('POST', '/setup/signin-app', { body: `csrf=${encodeURIComponent(csrf)}&owner=example`, cookie: cookie! });
    assert.equal(go.status, 303);
    const start = await s.call('GET', String(go.headers.location), { cookie: cookie!, origin: null });
    assert.equal(start.status, 200);
    assert.match(String(start.headers['content-security-policy']), new RegExp(`form-action ${gh.url.replace(/[/.:]/g, '\\$&')}`));
    // The manifest goes to the user's own App settings, with the hub's callbacks; GitHub sends back state and a code.
    const action = /<form method="post" action="([^"]+)"/.exec(start.body)![1]!.replace(/&amp;/g, '&');
    assert.ok(action.startsWith(`${gh.url}/settings/apps/new?state=`), action);
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(start.body)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as { name: string; redirect_url: string; callback_urls: string[]; default_permissions: object };
    assert.equal(manifest.name, `box-${BRAND.cli}-signin`);
    assert.equal(manifest.redirect_url, `${ORIGIN}/setup/app-manifest/callback`);
    assert.deepEqual(manifest.callback_urls, [`${ORIGIN}/auth/callback`]);
    assert.deepEqual(manifest.default_permissions, {});
    const state = new URL(action).searchParams.get('state')!;
    gh.codes.set('code1', { slug: 'box-signin', id: 92 });
    // Without the session (another browser), GitHub's redirect back is refused and the code isn't spent.
    assert.equal((await s.call('GET', `/setup/app-manifest/callback?state=${encodeURIComponent(state)}&code=code1`, { origin: null })).status, 401);
    assert.equal(gh.state.conversions, 0);
    const back = await s.call('GET', `/setup/app-manifest/callback?state=${encodeURIComponent(state)}&code=code1`, { cookie: cookie!, origin: null });
    assert.equal(back.status, 200, back.body);
    assert.match(back.body, /GitHub made <strong>box-signin<\/strong>/);
    assert.match(back.body, /sudo bash dashboards.sh --machine-owner example &lt;name&gt;/);
    assert.ok(!back.body.includes(APP_SECRET), 'the secret is never on a page');
    for (const [f, v] of [
      ['client-secret', APP_SECRET],
      ['client-id', 'Iv1.madeapp00001'],
      ['public-url', ORIGIN],
    ]) {
      assert.equal(readFileSync(join(s.signinDir, f!), 'utf8'), v, f);
      assert.equal(statSync(join(s.signinDir, f!)).mode & 0o777, 0o400, f);
    }
    assert.match(readFileSync(join(s.signinDir, 'session-secret'), 'utf8'), /^[0-9a-f]{64}$/);
    assert.equal(statSync(s.signinDir).mode & 0o777, 0o700);
    assert.equal(existsSync(join(s.signinDir, 'private-key.pem')), false, 'the App key is not kept');
    assert.equal(await s.h.closed, 'the sign-in App is made');
    assert.equal(s.h.server.listening, false, 'setup mode is off: nothing answers');
    await assert.rejects(startSetupHub({ stateDir: s.stateDir, signinDir: s.signinDir, publicUrl: ORIGIN }), SetupOver, 'and it will not start again');
  } finally {
    await s.h.close();
    await gh.close();
  }
});

test('setup mode turns itself off once the sign-in secret exists: refused at start, and stopped while running (credentials.sh by hand)', { skip: !posix && 'POSIX modes' }, async () => {
  const d = dirs();
  mkdirSync(d.signinDir, { recursive: true });
  writeFileSync(join(d.signinDir, 'client-secret'), 'x');
  await assert.rejects(startSetupHub({ ...d, publicUrl: ORIGIN }), (e: unknown) => e instanceof SetupOver && /setup mode is off/.test((e as Error).message));
  assert.equal(existsSync(join(d.stateDir, SETUP_TOKEN_FILE)), false, 'no token is made when it will not start');

  const s = await hub();
  try {
    mkdirSync(s.signinDir, { recursive: true });
    writeFileSync(join(s.signinDir, 'client-secret'), 'x');
    const why = await Promise.race([s.h.closed, new Promise((r) => setTimeout(() => r('still running'), 2_000))]);
    assert.equal(why, 'the sign-in secret exists');
    assert.equal(s.h.server.listening, false);
  } finally {
    await s.h.close();
  }
});

test('setup mode listens on loopback only, and takes only an https origin', { skip: !posix && 'POSIX modes' }, async () => {
  const d = dirs();
  await assert.rejects(startSetupHub({ ...d, publicUrl: ORIGIN, host: '0.0.0.0' }), /loopback only/);
  await assert.rejects(startSetupHub({ ...d, publicUrl: 'http://hub.example.test' }), /--public-url/);
  assert.equal(defaultAppPrefix('My_Box.tail1234.ts.net'), 'my-box');
  assert.equal(defaultAppPrefix('1234'), 'hub');
});

test('the CLI: dashboard --hub-setup prints where the token is, never the token; once the secret exists it says setup mode is off and exits 0', { skip: !posix && 'POSIX modes' }, async () => {
  const d = dirs();
  const env = { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: join(d.stateDir, '..', 'cli-state') };
  const p = spawn(process.execPath, [engineCli, 'dashboard', '--hub-setup', '--service', '--port', '0', '--public-url', ORIGIN, '--signin-dir', d.signinDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (c: Buffer) => (out += c.toString()));
  p.stderr.on('data', (c: Buffer) => (out += c.toString()));
  const closed = new Promise<number | null>((r) => p.on('close', r));
  try {
    for (let i = 0; i < 150 && !out.includes('turns itself off'); i++) await new Promise((r) => setTimeout(r, 100));
    const file = /the one-time setup token is in (\S+)/.exec(out)?.[1];
    assert.ok(file, out);
    const token = readFileSync(file!, 'utf8').trim();
    assert.ok(!out.includes(token), 'the token is never printed');
    // The secret appears (credentials.sh by hand): it turns itself off and the process exits 0.
    mkdirSync(d.signinDir, { recursive: true });
    writeFileSync(join(d.signinDir, 'client-secret'), 'x');
    assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r('still running after 10 s'), 10_000))]), 0, out);
    assert.match(out, /setup mode off: the sign-in secret exists/);
  } finally {
    p.kill();
  }
  const again = spawnSync(process.execPath, [engineCli, 'dashboard', '--hub-setup', '--port', '0', '--public-url', ORIGIN, '--signin-dir', d.signinDir], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /setup mode is off/);
});

test('dashboards.sh --setup: the hub in setup mode as the viewer, refused once the secret exists, a fresh token each run, its path printed and never the token', () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'dashboards.sh'), 'utf8');
  const from = sh.indexOf('if [ -n "$setup" ]; then');
  const to = sh.indexOf('\nfi\n', from);
  const setup = sh.slice(from, to);
  assert.ok(from > 0 && to > from);
  assert.match(setup, /ExecStart=\/usr\/local\/bin\/worklane dashboard --hub-setup --service --public-url \$public_url --signin-dir \$signin_dir\n/, 'no token in its arguments');
  assert.match(setup, /User=\$viewer\n/);
  assert.match(setup, /ProtectHome=read-only\nReadWritePaths=\$\(home_of "\$viewer"\)/);
  assert.ok(setup.indexOf('test -e "$signin_dir/client-secret"') < setup.indexOf('put "$setup_unit"'), 'refused before anything is installed once the secret exists');
  assert.ok(setup.indexOf('rm -f "$hub_state/setup-token"') < setup.indexOf('systemctl start "$setup_unit"'), 'a fresh token each run');
  assert.match(setup, /stat -c '%U %a' "\$hub_state\/setup-token"\)" = "\$viewer 600"/, "checked: the viewer's, 0600");
  assert.match(setup, /echo "  the one-time setup token, for the page: sudo cat \$hub_state\/setup-token"/);
  assert.doesNotMatch(setup, /\$\(cat [^)]*setup-token|echo[^\n]*\$token/, 'never read into the output');
  assert.match(setup, /^ {2}echo "setup-mode hub: \$public_url"$/m, 'the line the install prints the hub URL from');
  // The real hub: the setup unit goes first, and the client id and URL default to what setup mode stored.
  const rest = sh.slice(to);
  assert.ok(rest.indexOf('systemctl disable --now "$setup_unit"') > 0 && rest.indexOf('systemctl disable --now "$setup_unit"') < rest.indexOf('put worklane-dashboard-hub.service hub_unit'));
  assert.match(rest, /\[ -z "\$client_id" \] && \[ -s "\$signin_dir\/client-id" \]/);
  assert.match(rest, /\[ -z "\$public_url" \] && \[ -s "\$signin_dir\/public-url" \]/);
});

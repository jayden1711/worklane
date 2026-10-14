// A dashboard key never travels in a URL (src/dashboard-key-url.ts): every route of the local dashboard, the hub's
// sign-in port, its break-glass port and the terminal's upgrade refuses a request whose query carries one, with a
// 401 that never repeats it, even when the right key is in the header too. The printed URLs carry no key.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { freePort, until } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { startHub, type HubInstance } from '../src/dashboard-hub.js';
import { KEY_IN_URL_REFUSED, keyInUrl } from '../src/dashboard-key-url.js';
import { TERMINAL_PATH } from '../src/console/terminal-server.js';
import { seedDemo } from '../src/demo.js';
import { EventLog } from '../src/events/log.js';
import { engineCli, exampleProject, exampleRoles } from './helpers.js';

/** Everything this process writes to its console while `fn` runs: a refusal must not log the URL (or anything with the key). */
async function consoleDuring<T>(fn: () => Promise<T>): Promise<{ result: T; written: string }> {
  let written = '';
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info, out: process.stdout.write, err: process.stderr.write };
  const take = (...a: unknown[]) => void (written += `${a.map(String).join(' ')}\n`);
  console.log = console.error = console.warn = console.info = take;
  // Recorded and passed on (the test reporter writes here too).
  process.stdout.write = ((c: unknown, ...a: unknown[]) => ((written += String(c)), (keep.out as (...x: unknown[]) => boolean).call(process.stdout, c, ...a))) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown, ...a: unknown[]) => ((written += String(c)), (keep.err as (...x: unknown[]) => boolean).call(process.stderr, c, ...a))) as typeof process.stderr.write;
  try {
    return { result: await fn(), written };
  } finally {
    Object.assign(console, { log: keep.log, error: keep.error, warn: keep.warn, info: keep.info });
    process.stdout.write = keep.out;
    process.stderr.write = keep.err;
  }
}

/** The ways a key could be put in a URL: the old ?t=, other key-like names (any case), and its value under any name. */
const keyed = (key: string) => [`t=${key}`, `token=${key}`, `key=${key}`, `T=${key}`, `access_token=${key}`, `issue=1&t=${key}`, `anything=${key}`, `t=not-the-key`];

/** Ask `base + path?query` (GET, or POST for a write) with the right key in the header too; every answer must be the refusal. */
async function assertRefused(base: string, key: string, routes: string[], header: Record<string, string>) {
  for (const route of routes) {
    const [method, path] = route.includes(' ') ? route.split(' ') as [string, string] : ['GET', route];
    for (const q of keyed(key)) {
      const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}${q}`, { method, headers: { ...header, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
      const body = await res.text();
      assert.equal(res.status, 401, `${method} ${path} with ${q.replace(key, '<key>')}: refused`);
      assert.equal((JSON.parse(body) as { error: string }).error, KEY_IN_URL_REFUSED, `${path}: the refusal, whatever the route`);
      assert.ok(!body.includes(key), `${path}: the refusal never repeats the key`);
    }
  }
}

test('keyInUrl: a key-shaped name whatever its value, or a known key under any name; other queries pass', () => {
  const u = (q: string) => new URL(`http://127.0.0.1/x?${q}`);
  for (const q of ['t=x', 'Token=x', 'KEY=', 'access_token=x', 'authorization=x', 'a=1&t=2']) assert.equal(keyInUrl(u(q)), true, q);
  assert.equal(keyInUrl(u('chat=secret-key-value'), ['secret-key-value']), true, 'the value, under any name');
  for (const q of ['issue=1', 'after=-1', 'set=workers&to=3', 'code=abc&state=def', 'instance=a&cols=80&rows=24', 'tab=t']) assert.equal(keyInUrl(u(q), ['secret-key-value']), false, q);
});

test('the local dashboard refuses a key in the URL on every route, even with the right key in the header, and logs nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-url-'));
  const { dir: root } = exampleProject();
  const web = mkdtempSync(join(tmpdir(), 'key-url-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>ok</title>');
  const db = join(dir, 'events.db');
  new EventLog(db).close();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, webDir: web, pollMs: 50, slotsDir: join(dir, 'slots') });
  const h = { authorization: `Bearer ${d.token}` };
  try {
    assert.ok(!d.url.includes(d.token) && !d.url.includes('?'), `the printed URL carries no key: ${d.url}`);
    assert.equal(readFileSync(d.keyFile, 'utf8').trim(), d.token, 'the key is in the file it names');
    const { written } = await consoleDuring(() =>
      assertRefused(d.url, d.token, ['/', '/overview', '/setup', '/assets/app.js', '/api/role', '/api/state', '/api/stream', '/api/board', '/api/events', '/api/runs/x/live', '/api/runs/x/feed', 'POST /api/decide', 'PUT /api/views'], h),
    );
    assert.ok(!written.includes(d.token), 'no refusal wrote the key anywhere');
    // The header alone opens it, and an ordinary query is still served.
    assert.equal((await fetch(`${d.url}/api/state`, { headers: h })).status, 200);
    assert.equal((await fetch(`${d.url}/api/events?issue=1`, { headers: h })).status, 200);
    assert.equal((await fetch(`${d.url}/overview?tab=current`)).status, 200, 'the page, with no key anywhere');
    const stream = await fetch(`${d.url}/api/stream`, { headers: h });
    assert.equal(stream.status, 200, 'the live stream takes the key in the header');
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    await stream.body?.cancel();
  } finally {
    await d.close();
  }
});

test("the hub's sign-in port and its break-glass refuse a key in the URL on every route; GitHub's code and state still reach the callback", async () => {
  const inst = mkdtempSync(join(tmpdir(), 'key-url-inst-'));
  const { dir: root } = exampleProject();
  const db = join(inst, 'events.db');
  new EventLog(db).close();
  const a = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: inst, user: 'example-owner', slotsDir: join(inst, 'slots'), pollMs: 50 });
  const web = mkdtempSync(join(tmpdir(), 'key-url-hubweb-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>hub</title>');
  const instances: HubInstance[] = [{ name: 'a', port: Number(new URL(a.url).port), tokenFile: join(inst, 'dashboard-token') }];
  const nowhere = 'http://127.0.0.1:9';
  const h = await startHub({ instances, stateDir: mkdtempSync(join(tmpdir(), 'key-url-hub-')), webDir: web, signIn: { clientId: 'Iv1.keyurltest', clientSecret: 'x', sessionSecret: 's'.repeat(48), publicUrl: nowhere, web: nowhere, api: nowhere } });
  const hubBase = h.url.replace(/\/$/, '');
  const hh = { authorization: `Bearer ${h.token}` };
  try {
    assert.ok(!h.breakGlassUrl.includes(h.token) && !h.breakGlassUrl.includes('?'), `the break-glass URL carries no key: ${h.breakGlassUrl}`);
    assert.equal(readFileSync(h.keyFile, 'utf8').trim(), h.token);
    const routes = ['/', '/setup', '/api/me', '/api/hub', '/api/i/a/state', '/api/i/a/stream', '/api/i/a/runs/x/live', 'POST /api/i/a/decide'];
    const { written } = await consoleDuring(async () => {
      await assertRefused(h.breakGlassUrl, h.token, routes, hh);
      await assertRefused(hubBase, h.token, [...routes, '/auth/login', 'POST /auth/logout'], hh);
      // An instance's key, through the hub, is refused just the same (by its name).
      await assertRefused(h.breakGlassUrl, a.token, ['/api/i/a/state'], hh);
    });
    assert.ok(!written.includes(h.token) && !written.includes(a.token), 'no refusal wrote a key anywhere');
    // The break-glass with its key in the header only: the owner.
    const me = (await (await fetch(`${h.breakGlassUrl}/api/me`, { headers: hh })).json()) as { breakGlass: boolean };
    assert.equal(me.breakGlass, true);
    const stream = await fetch(`${h.breakGlassUrl}/api/i/a/stream`, { headers: hh });
    assert.equal(stream.status, 200, "an instance's live stream through the break-glass, key in the header");
    await stream.body?.cancel();
    // GitHub's sign-in callback carries code and state, not our key: it is answered as before (a state this hub never issued).
    const cb = await fetch(`${hubBase}/auth/callback?code=abc&state=def`);
    assert.equal(cb.status, 400);
    assert.match(await cb.text(), /did not start here/);
    // The terminal's WebSocket upgrade, too.
    const port = Number(new URL(h.url).port);
    const upgrade = await new Promise<number>((done, fail) => {
      const r = request({ host: '127.0.0.1', port, path: `${TERMINAL_PATH}?instance=a&t=${h.token}`, headers: { connection: 'Upgrade', upgrade: 'websocket', origin: hubBase, 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } });
      r.on('response', (res) => (done(res.statusCode ?? 0), res.resume()));
      r.on('upgrade', () => done(101));
      r.on('error', fail);
      r.end();
    });
    assert.equal(upgrade, 401, "the terminal's upgrade with a key in its URL");
  } finally {
    await h.close();
    await a.close();
  }
});

test('`dashboard` prints a URL without the key, and names the file the key is in', { timeout: 60_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'key-url-cli-state-'));
  const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = state;
  const demo = await seedDemo(join(mkdtempSync(join(tmpdir(), 'key-url-cli-')), 'demo')).finally(() => {
    if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
    else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
  });
  const p = spawn(process.execPath, [engineCli, 'dashboard', '--root', demo.root, '--user', 'example-owner', '--no-open', '--port', String(await freePort())], { env: { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  p.stdout.on('data', (c) => (printed += c));
  p.stderr.on('data', (c) => (printed += c));
  try {
    await until('the dashboard to print its URL', () => printed.includes('Ctrl+C'), 30_000).catch((e: Error) => {
      throw new Error(`${e.message}\n${printed}`);
    });
    const m = printed.match(/^ {2}(http:\/\/127\.0\.0\.1:\d+) \(the page asks for the key once: it is in (.+)\)$/m);
    assert.ok(m, `the URL and the key's file:\n${printed}`);
    const key = readFileSync(m[2]!, 'utf8').trim();
    assert.match(key, /^[A-Za-z0-9_-]{16,}$/);
    assert.ok(!printed.includes(key), 'the key itself is never printed');
    assert.equal((await fetch(`${m[1]}/api/role`, { headers: { authorization: `Bearer ${key}` } })).status, 200, 'that key opens it, in the header');
    assert.equal((await fetch(`${m[1]}/?t=${key}`)).status, 401, 'and a link carrying it is refused');
  } finally {
    p.kill();
  }
});

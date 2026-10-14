// The web app never puts the dashboard key in a URL: its live streams are read with fetch (web/src/sse.ts) and
// send the key in the Authorization header, like every other call; nothing in web/src builds a URL with the key or
// opens an EventSource (which can't send headers). A source check, the stream module against a real dashboard and
// a dropped stream, and the real UI in Chrome with every request it makes recorded.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, launchChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { writeLive } from '../src/console.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { RunFeed } from '../src/run-feed.js';
import { REAL_CHROME_TIMEOUT, oneChromeAtATime, realChromeTests, webUiSkip } from './browser-helpers.js';
import { exampleProject, exampleRoles, repoRoot } from './helpers.js';

const WEB_SRC = join(repoRoot, 'web', 'src');
/** The key this file's browser stand-in keeps in its tab, as the key page would. */
const KEY = 'web-key-in-url-test-key-0123456789';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

/** What in this source would put a key in a URL, or open a stream that can't carry it in a header. */
export function keyInUrlFindings(src: string): string[] {
  const found: string[] = [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  if (/\bnew\s+(?:window\.)?EventSource\b|\bEventSource\s*\(/.test(code)) found.push('opens an EventSource (it cannot send the key in a header)');
  if (/\bwithCredentials\b/.test(code)) found.push('uses withCredentials');
  if (/[?&](?:t|token|key|access_token|auth)=/.test(code)) found.push('a key-shaped query parameter in a URL');
  if (/searchParams\.(?:get|set|append)\(\s*['"](?:t|token|key|access_token)['"]/.test(code)) found.push('reads or writes a key-shaped query parameter');
  // The key interpolated anywhere but after "Bearer " in a header value.
  for (const m of code.matchAll(/([^`]{0,40})\$\{\s*(?:encodeURIComponent\(\s*)?(token|key|given)\s*\)?\s*\}/g)) {
    if (!/Bearer $/.test(m[1]!)) found.push(`interpolates ${m[2]} outside a Bearer header: ${m[0].trim()}`);
  }
  return found;
}

test('web/src builds no URL with the key and opens no EventSource', () => {
  const files = sources(WEB_SRC);
  assert.ok(files.length > 20 && files.some((f) => f.endsWith('sse.ts')));
  const bad = files.flatMap((f) => keyInUrlFindings(readFileSync(f, 'utf8')).map((w) => `${f.slice(repoRoot.length)}: ${w}`));
  assert.deepEqual(bad, []);
  // The check itself catches what it is for.
  for (const snippet of ['const es = new EventSource(u);', 'const u = `${path}?t=${encodeURIComponent(token)}`;', "url.searchParams.get('t')", "fetch('/api/x?token=' + k)", 'new EventSource(u, { withCredentials: true })', 'const u = `/api/stream/${token}`;']) {
    assert.notDeepEqual(keyInUrlFindings(snippet), [], snippet);
  }
  assert.deepEqual(keyInUrlFindings('headers: { authorization: `Bearer ${token}` }'), []);
});

interface Web {
  openStream(url: string | Promise<string>, o: { headers: () => Record<string, string>; on: Record<string, (e: { type: string; data: string; lastEventId: string }) => void>; onOpen?: () => void; onError?: (why: string, final: boolean) => void; delayMs?: number; maxDelayMs?: number }): { close(): void };
  liveStream(path: string | Promise<string>, on: Record<string, (e: { data: string }) => void>, o?: { onOpen?: () => void; onError?: (why: string, final: boolean) => void }): { close(): void };
  instanceStream(instance: string | null, path: string, scope?: Promise<unknown>): Promise<string>;
  api<T>(path: string): Promise<T>;
}
let web: Web;
/** Every fetch the web module made: the URL as the app gave it, and its headers. */
const calls: { url: string; headers: Record<string, string> }[] = [];
let origin = '';
const realFetch = globalThis.fetch;

before(async () => {
  // A tab on the dashboard's own page, with the key kept by the key page: set before the module reads it.
  const store = new Map<string, string>([['dash-token', KEY]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const g = globalThis as Record<string, unknown>;
  g.window = { location: { href: 'http://127.0.0.1/overview', pathname: '/overview', hostname: '127.0.0.1', search: '', hash: '' }, history: { replaceState: () => {} }, matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
  g.document = { querySelector: () => null };
  for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(g, k, { value: storage, configurable: true, writable: true });
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), headers: { ...(init?.headers as Record<string, string>) } });
    return realFetch(new URL(String(u), origin || 'http://127.0.0.1:9'), init);
  }) as typeof fetch;
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'web-key-url-'));
  const entry = join(out, 'entry.ts');
  writeFileSync(entry, `export { openStream } from ${JSON.stringify(join(WEB_SRC, 'sse.ts'))};\nexport { liveStream, instanceStream, api } from ${JSON.stringify(join(WEB_SRC, 'api.ts'))};\n`);
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: entry, outDir: join(out, 'dist'), emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'web.mjs' } } } });
  web = (await import(pathToFileURL(join(out, 'dist', 'web.mjs')).href)) as Web;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("the app's live stream receives events from a real dashboard with the key in the header only", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-key-url-dash-'));
  const { dir: root } = exampleProject();
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const stateDir = join(dir, 'state');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'dashboard-token'), KEY, { mode: 0o600 });
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: 'example-owner', roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots') });
  origin = d.url;
  calls.length = 0;
  const got: string[] = [];
  const s = web.liveStream('/api/stream', { hello: () => void got.push('hello'), change: (e) => void got.push(`change ${e.data}`) });
  try {
    await until('the stream to open', () => got.includes('hello'), 10_000);
    log.append('issue.seen', { issue: 9, title: 'streamed', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
    await until('the change to arrive', () => got.some((g) => g.startsWith('change') && g.includes('issue.seen')), 10_000);
    const state = await web.api<{ tasks: { title: string }[] }>('/api/state');
    assert.equal(state.tasks[0]?.title, 'streamed');
    assert.equal(await web.instanceStream(null, '/api/stream'), '/api/stream', 'a stream path carries no key');
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.ok(!c.url.includes(KEY) && !/[?&]t=/.test(c.url), `no key in ${c.url}`);
      assert.equal(c.headers.authorization, `Bearer ${KEY}`, `${c.url}: the key in the header`);
    }
  } finally {
    s.close();
    log.close();
    await d.close();
    origin = '';
  }
});

test('a dropped stream reconnects, with the last id it saw and the key in the header; close() stops it; a refusal ends it', async () => {
  const seen: IncomingHttpHeaders[] = [];
  let held = 0;
  const server = createServer((req, res) => {
    // A stream that stays open until the client goes: for close().
    if (req.url === '/api/hold') return void (held++, res.writeHead(200, { 'content-type': 'text/event-stream' }), res.write(': open\n\n'));
    seen.push(req.headers);
    if (req.url !== '/api/stream') return void (res.writeHead(404), res.end());
    if (seen.length >= 3) return void (res.writeHead(401, { 'content-type': 'application/json' }), res.end('{}'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // First connection: an event with an id, split over two writes and \r\n endings, then the connection drops.
    if (seen.length === 1) {
      res.write('retry: 30\r\nid: 5\r\nevent: change\r\nda');
      setTimeout(() => {
        res.write('ta: {"n":1}\r\n\r\nevent: change\ndata: half a frame');
        setTimeout(() => res.socket?.destroy(), 30);
      }, 30);
      return;
    }
    res.write('id: 6\nevent: change\ndata: {"n":2}\n\n: a comment\n\n');
    setTimeout(() => res.end(), 30);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const got: { data: string; id: string }[] = [];
  const errors: { why: string; final: boolean }[] = [];
  let opened = 0;
  const s = web.openStream(`http://127.0.0.1:${port}/api/stream`, { headers: () => ({ authorization: `Bearer ${KEY}` }), on: { change: (e) => void got.push({ data: e.data, id: e.lastEventId }) }, onOpen: () => void opened++, onError: (why, final) => void errors.push({ why, final }), delayMs: 20 });
  try {
    await until('the third connection, refused', () => errors.some((e) => e.final), 10_000);
    assert.deepEqual(got, [{ data: '{"n":1}', id: '5' }, { data: '{"n":2}', id: '6' }], 'each event once; the half frame from the dropped connection is not delivered');
    assert.equal(opened, 2);
    assert.equal(seen[0]!['last-event-id'], undefined);
    assert.equal(seen[1]!['last-event-id'], '5', 'the reconnect resumes after the last id');
    assert.equal(seen[2]!['last-event-id'], '6');
    for (const h of seen) assert.equal(h.authorization, `Bearer ${KEY}`);
    const before = seen.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.length, before, 'a 401 is final: no more attempts');
    // close() while connected: the connection goes, and none follows.
    const t = web.openStream(`http://127.0.0.1:${port}/api/hold`, { headers: () => ({}), on: {}, delayMs: 20 });
    await until('a connection', () => held === 1, 5_000);
    t.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(held, 1, 'closed: never reconnected');
  } finally {
    s.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

realChromeTests();
const chrome = findChrome(process.env.CHROME);
const RUN = '2026-01-01T00-00-00-000Z-worker-keyurl';

test(
  'in a real Chrome: the run feed, live state, the Setup console and the Board update live, and no request URL carries the key',
  { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) },
  async (ctx) => {
    await oneChromeAtATime(ctx);
    const dir = mkdtempSync(join(tmpdir(), 'web-key-url-chrome-'));
    const { dir: root } = exampleProject();
    const eventsDb = join(dir, 'events.db');
    const log = new EventLog(eventsDb);
    writeLive(dir, [{ run: RUN, issue: 7, role: 'worker', model: 'sonnet', startedAt: new Date().toISOString(), pending: [] }]);
    const feed = new RunFeed(dir, { run: RUN, issue: 7, role: 'worker', model: 'sonnet', cwd: join(dir, 'wt') });
    feed.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the totals.' }] } });
    log.append('issue.seen', { issue: 7, title: 'Round the totals', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
    const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots') });
    const b = await launchChrome(chrome!, { width: 1280, height: 900 });
    const requests: { url: string; headers: Record<string, string> }[] = [];
    try {
      const cdp = b.cdp;
      cdp.on('Network.requestWillBeSent', (p) => {
        const r = (p as { request: { url: string; headers: Record<string, string> } }).request;
        requests.push({ url: r.url, headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v])) });
      });
      await cdp.send('Network.enable');
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      // The key as the key page keeps it: in this tab's session storage, never the URL.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { sessionStorage.setItem('dash-token', ${JSON.stringify(d.token)}); } catch {}` });
      const text = () => js<string>(cdp, 'document.body.innerText');
      const asked = (path: string) => requests.filter((r) => new URL(r.url).pathname === path).length;

      // The run feed: a step the agent takes while the page is open shows up.
      await cdp.send('Page.navigate', { url: `${d.url}/runs/${RUN}` });
      await until('the live run', async () => (await text()).includes('Looking at the totals.'), 30_000);
      feed.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'LIVE-FEED-MARK' }] } });
      await until('the new step in the run feed', async () => (await text()).includes('LIVE-FEED-MARK'), 30_000);

      // Live state: an issue's page, opened before the issue is seen, shows it once the log has it, without a reload.
      await cdp.send('Page.navigate', { url: `${d.url}/issues/8` });
      await until('the page', () => js<boolean>(cdp, `!!document.querySelector('main')`), 30_000);
      await new Promise((r) => setTimeout(r, 1000));
      log.append('issue.seen', { issue: 8, title: 'LIVE-STATE-MARK', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
      await until('the new issue on the page', async () => (await text()).includes('LIVE-STATE-MARK'), 30_000);

      // The Setup console: an ask event makes it read its asks again.
      await cdp.send('Page.navigate', { url: `${d.url}/setup` });
      await until('the Setup console', () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-setup"]')`), 30_000);
      await until('its asks', () => asked('/api/asks') > 0, 30_000);
      const asks = asked('/api/asks');
      await new Promise((r) => setTimeout(r, 500));
      log.append('ask.cancelled', { id: 'no-such-ask', by: 'example-owner', why: 'a change for the stream' } as never, 'c');
      await until('the Setup console to reload on the change', () => asked('/api/asks') > asks, 30_000);

      // The Board: a change makes it read the board again.
      await cdp.send('Page.navigate', { url: `${d.url}/` });
      await until('the Board', () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-board"]')`), 30_000);
      await until('the board', () => asked('/api/board') > 0, 30_000);
      const boards = asked('/api/board');
      await new Promise((r) => setTimeout(r, 500));
      log.append('issue.seen', { issue: 10, title: 'LIVE-BOARD-MARK', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
      await until('the Board to reload on the change', () => asked('/api/board') > boards, 30_000);

      const streams = requests.filter((r) => /\/api\/(stream|runs\/[^/]+\/live)$/.test(new URL(r.url).pathname));
      assert.ok(streams.length >= 4, `every page opened its live stream: ${streams.map((r) => r.url).join(', ')}`);
      for (const r of streams) assert.equal(r.headers.authorization, `Bearer ${d.token}`, `${r.url}: the key in the header`);
      const leaked = requests.filter((r) => r.url.includes(d.token) || /[?&](t|token|key)=/.test(r.url)).map((r) => r.url);
      assert.deepEqual(leaked, [], 'no request URL carries the key');
    } finally {
      await b.close();
      log.close();
      await d.close();
    }
  },
);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

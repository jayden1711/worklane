// WHY: no live outside calls from tests (#462). A real-Chrome test's page that reaches the internet depends on the
// answer (#452's flake was a GitHub avatar), so every test Chrome resolves no host but localhost, and a page that asks
// for one anyway fails its test, naming the URL. These check that guard, and that nothing gets around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, sleep, until } from '../src/browser/cdp.js';
import { isOutside, KNOWN_OUTSIDE, launchTestChrome, oneChromeAtATime, REAL_CHROME_TIMEOUT, realChromeTests, takeOutsideRequests, webUiSkip } from './browser-helpers.js';
import { repoRoot } from './helpers.js';

realChromeTests();
const chrome = findChrome(process.env.CHROME);

test('every real-Chrome test starts it through launchTestChrome (offline, watched), never launchChrome itself', () => {
  const dir = join(repoRoot, 'test');
  // browser-run.test.ts tests launchChrome itself, with a stand-in browser that makes no requests.
  const own = new Set(['browser-helpers.ts', 'browser-run.test.ts']);
  const direct = readdirSync(dir).filter((f) => f.endsWith('.ts') && !own.has(f) && /\blaunchChrome\s*\(/.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(direct, [], 'use launchTestChrome from ./browser-helpers.js');
});

test('what counts as outside: any http(s) or ws(s) host but loopback; a GitHub picture only until the dashboard serves them', () => {
  for (const u of ['https://github.com/x.png', 'http://example.com/', 'wss://example.com/s', 'http://127.0.0.1.example.com/']) assert.equal(isOutside(u), true, u);
  for (const u of ['http://127.0.0.1:4317/', 'http://localhost:1/', 'http://[::1]:2/', 'data:image/png;base64,AA', 'about:blank', 'chrome-error://chromewebdata/']) assert.equal(isOutside(u), false, u);
  assert.ok(KNOWN_OUTSIDE.some((r) => r.test('https://github.com/example-owner.png?size=40')));
  for (const u of ['https://github.com/example-owner', 'https://github.com/a/b.png', 'https://avatars.githubusercontent.com/u/1', 'https://github.com.example.com/x.png']) assert.ok(!KNOWN_OUTSIDE.some((r) => r.test(u)), u);
});

test('loopback still answers in a test Chrome: localhost, 127.0.0.1 and [::1]', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const servers = await Promise.all(['127.0.0.1', '::1'].map(async (host) => {
    const s = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<p id="here">here</p>'));
    await new Promise<void>((r) => s.listen(0, host, r));
    return s;
  }));
  const [v4, v6] = servers.map((s) => (s.address() as { port: number }).port);
  const b = await launchTestChrome(chrome!, { width: 800, height: 600 });
  try {
    for (const url of [`http://127.0.0.1:${v4}/`, `http://localhost:${v4}/`, `http://[::1]:${v6}/`]) {
      await b.cdp.send('Page.navigate', { url });
      const at = await until(`${url} to load`, async () => {
        const r = await b.cdp.send<{ result: { value: string | null } }>('Runtime.evaluate', { expression: `document.getElementById('here') ? location.href : null`, returnByValue: true });
        return r.result.value;
      }, 10_000);
      assert.equal(at, url);
    }
  } finally {
    await b.close();
    for (const s of servers) s.close();
  }
});

test('a page asking for an outside host: the request fails at once, never reaching the network, and the test is told which URL', { timeout: REAL_CHROME_TIMEOUT, skip: webUiSkip(chrome) }, async (ctx) => {
  await oneChromeAtATime(ctx);
  // A local page that asks for three outside things: a picture, a fetch, and a GitHub picture (known, not reported).
  const page = `<!doctype html><img id="a" src="https://example.com/a.png"><img id="g" src="https://github.com/example-owner.png?size=40"><script>window.done = fetch('https://example.org/api').then(() => 'answered', () => 'failed');</script>`;
  const s = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const b = await launchTestChrome(chrome!, { width: 800, height: 600 });
  try {
    await b.cdp.send('Page.navigate', { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/` });
    const js = async <T>(expression: string) => ((await b.cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value);
    await until('the local page', () => js<boolean>(`!!document.getElementById('a')`), 10_000);
    // Failed, and fast: no lookup or connection to wait out.
    const t0 = Date.now();
    assert.equal(await js<string>('window.done'), 'failed');
    await until('both pictures to give up', () => js<boolean>(`['a', 'g'].every((id) => { const i = document.getElementById(id); return i.complete && i.naturalWidth === 0; })`), 10_000);
    assert.ok(Date.now() - t0 < 10_000);
    // The DevTools events for those requests can trail the page's own answer by a moment.
    await sleep(300);
  } finally {
    await b.close();
    s.close();
  }
  const asked = takeOutsideRequests();
  assert.deepEqual([...asked].sort(), ['https://example.com/a.png', 'https://example.org/api'], 'each outside URL named; the GitHub picture is known');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REAL_CHROME_TIMEOUT, oneChromeAtATime, realChromeTests } from './browser-helpers.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../src/config/schema.js';
import { findChrome, freePort } from '../src/browser/cdp.js';
import type { FlowEvidence } from '../src/browser/run.js';
import { BrowserDoneWhenItem, judgeFlow, runBrowserCheck } from '../src/browser/check.js';

const thresholds = { max_long_task_ms: 200, max_dropped_frame_pct: 25, slow_request_ms: 3000 };
const evidence = (over: Partial<FlowEvidence> = {}): FlowEvidence => ({
  flow: 'checkout',
  ok: true,
  steps: [{ step: 'goto /cart', ok: true, ms: 40 }],
  consoleErrors: [],
  failedRequests: [],
  slowRequests: [],
  blockedRequests: [],
  trace: { longTasks: 1, maxTaskMs: 120, droppedFramePct: 10, frames: 30 },
  screenshot: null,
  views: [],
  durationMs: 900,
  ...over,
});

test('a done_when browser item names one flow, and nothing else', () => {
  assert.deepEqual(BrowserDoneWhenItem.parse({ browser: 'checkout' }), { browser: 'checkout' });
  for (const bad of [{ browser: 'Check Out' }, { browser: '' }, { browser: 'checkout', shell: 'rm -rf /' }]) assert.equal(BrowserDoneWhenItem.safeParse(bad).success, false, JSON.stringify(bad));
});

test('a clean flow within the thresholds passes; what was seen but not judged is a note', () => {
  const v = judgeFlow(evidence({ slowRequests: [{ url: 'http://127.0.0.1:5173/api/slow', method: 'GET', ms: 3400 }], blockedRequests: ['GET https://example.com/track'] }), thresholds);
  assert.deepEqual(v, { pass: true, reasons: [], notes: ['1 slow request(s), slowest 3400 ms', '1 request(s) to other hosts refused'] });
});

test('a failed step, a console error, a failed request, a long task or dropped frames each fail the check, with the reason', () => {
  const v = judgeFlow(
    evidence({
      ok: false,
      steps: [{ step: 'click testid:pay', ok: false, ms: 5000, error: 'no element for testid:pay' }],
      consoleErrors: [{ kind: 'exception', text: 'TypeError: total is undefined\n    at pay (app.js:12:3)' }],
      failedRequests: [{ url: 'http://127.0.0.1:5173/api/cart', method: 'POST', status: 500, error: null }],
      trace: { longTasks: 3, maxTaskMs: 450, droppedFramePct: 40, frames: 50 },
    }),
    thresholds,
  );
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, [
    'step "click testid:pay" failed: no element for testid:pay',
    'new console exception: TypeError: total is undefined',
    'new failed request: POST http://127.0.0.1:5173/api/cart (500)',
    'a main-thread task took 450 ms (the limit is 200 ms)',
    '40% of frames dropped (the limit is 25%)',
  ]);
});

test('frames not measured is a note, never a pass or fail on its own; no trace at all is a note too', () => {
  assert.deepEqual(judgeFlow(evidence({ trace: { longTasks: 0, maxTaskMs: 0, droppedFramePct: null, frames: 0 } }), thresholds), { pass: true, reasons: [], notes: ['dropped frames not measured (the trace had no frame events)'] });
  assert.deepEqual(judgeFlow(evidence({ trace: null }), thresholds), { pass: true, reasons: [], notes: ['no performance trace was recorded'] });
});

test('against a baseline run, only NEW errors and failed requests count (another port, line or query is the same one)', () => {
  const baseline = evidence({
    consoleErrors: [{ kind: 'console.error', text: 'favicon missing at app.js:3:9' }],
    failedRequests: [{ url: 'http://127.0.0.1:40001/favicon.ico?v=1', method: 'GET', status: 404, error: null }],
  });
  const now = evidence({
    consoleErrors: [{ kind: 'console.error', text: 'favicon missing at app.js:4:1' }, { kind: 'console.error', text: 'cart failed to load' }],
    failedRequests: [{ url: 'http://127.0.0.1:40777/favicon.ico?v=2', method: 'GET', status: 404, error: null }, { url: 'http://127.0.0.1:40777/api/cart', method: 'GET', status: 404, error: null }],
  });
  assert.deepEqual(judgeFlow(now, thresholds, baseline).reasons, ['new console error: cart failed to load', 'new failed request: GET http://127.0.0.1:40777/api/cart (404)']);
  assert.equal(judgeFlow(now, thresholds).reasons.length, 4, 'with no baseline, every one counts');
  assert.equal(judgeFlow(evidence({ failedRequests: [{ url: 'http://127.0.0.1:1/favicon.ico', method: 'GET', status: 500, error: null }] }), thresholds, baseline).pass, false, 'the same path failing differently is new');
});

test('many new errors are summarized, not listed without end', () => {
  const v = judgeFlow(evidence({ consoleErrors: Array.from({ length: 8 }, (_, i) => ({ kind: 'console.error', text: `boom ${i}` })) }), thresholds);
  assert.equal(v.reasons.length, 6);
  assert.equal(v.reasons[5], 'and 3 more new console errors');
});

test('a check that cannot run is unavailable, never passed: no app declared, or no browser; an unknown flow fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-check-'));
  const item = { browser: 'home' };
  const none = await runBrowserCheck({ item, app: undefined, cwd: dir, outDir: dir });
  assert.equal(none.status, 'unavailable');
  assert.match(none.tail, /no app is declared/);
  const app = AppConfig.parse({ version: 1, start: { command: `"${process.execPath}" -e "require('fs').writeFileSync('started', '1')"`, port: await freePort() }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }] } });
  const noChrome = await runBrowserCheck({ item, app, cwd: dir, outDir: dir, chrome: null });
  assert.deepEqual([noChrome.status, noChrome.evidence], ['unavailable', null]);
  assert.match(noChrome.tail, /no Chrome or Chromium/);
  const unknown = await runBrowserCheck({ item: { browser: 'checkout' }, app, cwd: dir, outDir: dir, chrome: null });
  assert.deepEqual([unknown.status, unknown.tail], ['fail', 'no flow "checkout" in app.yaml (it has: home)']);
});

const chrome = findChrome(process.env.CHROME);
realChromeTests();

test('a real check: a clean flow passes; the same app with a broken button fails, naming what broke', { skip: !chrome && 'no Chrome or Chromium on this machine (set CHROME)', timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'browser-check-real-'));
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
const broken = process.env.BROKEN === '1';
const page = \`<!doctype html><title>shop</title><link rel="icon" href="data:,"><button data-testid="go">Go</button><div data-testid="out"></div>
<script>
document.querySelector('[data-testid=go]').onclick = async () => {
  const r = await fetch('/api/total');
  if (!r.ok) console.error('total failed: ' + r.status);
  document.querySelector('[data-testid=out]').textContent = r.ok ? 'Total $3' : 'error';
};
</script>\`;
createServer((req, res) => {
  if (req.url === '/api/total') { res.writeHead(broken ? 500 : 200); return res.end(broken ? 'no' : '3'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
  const config = async (broken: boolean) =>
    AppConfig.parse({
      version: 1,
      start: { command: `BROKEN=${broken ? 1 : 0} "${process.execPath}" server.mjs`, port: await freePort(), ready: { timeout_s: 20 } },
      ui_paths: ['web/**'],
      // A slow CI machine can run one task past the 200 ms default; this test is about errors and requests
      // (judgeFlow's own tests cover the timing limits), so its long-task limit is generous.
      thresholds: { max_long_task_ms: 10_000 },
      flows: { buy: [{ goto: '/' }, { click: 'testid:go' }, { wait: 300 }] },
    });
  const ok = await runBrowserCheck({ item: { browser: 'buy' }, app: await config(false), cwd: dir, outDir: join(dir, 'ok'), chrome });
  assert.equal(ok.status, 'pass', ok.tail);
  assert.ok(ok.evidence?.screenshot);
  const bad = await runBrowserCheck({ item: { browser: 'buy' }, app: await config(true), cwd: dir, outDir: join(dir, 'bad'), chrome });
  assert.equal(bad.status, 'fail');
  assert.match(bad.tail, /new console error: total failed: 500/);
  assert.match(bad.tail, /new failed request: GET http:\/\/127\.0\.0\.1:\d+\/api\/total \(500\)/);
  const again = await runBrowserCheck({ item: { browser: 'buy' }, app: await config(true), cwd: dir, outDir: join(dir, 'again'), chrome, baseline: bad.evidence });
  assert.equal(again.status, 'pass', `already broken before the change, so not new: ${again.tail}`);
});

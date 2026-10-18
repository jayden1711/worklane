import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REAL_CHROME_TIMEOUT, oneChromeAtATime, realChromeTests, unscaled } from './browser-helpers.js';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../src/config/schema.js';
import { findChrome, freePort, launchChrome, portInUse } from '../src/browser/cdp.js';
import { judgeFlow } from '../src/browser/check.js';
import { captureShots, isLocal, isOnOrigin, runFlow, runFlowAt, stepLabel, VIEW_ERRORS_MAX, watch, type FlowEvidence } from '../src/browser/run.js';
import { summarizeTrace } from '../src/browser/trace.js';

test('the browser may only reach the app on this machine (and in-page schemes); everything else is refused', () => {
  for (const u of ['http://127.0.0.1:5173/cart', 'http://localhost:5173/api', 'http://[::1]:5173/', 'ws://127.0.0.1:5173/hmr', 'data:image/png;base64,AA', 'blob:http://127.0.0.1:5173/x', 'about:blank']) assert.equal(isLocal(u), true, u);
  for (const u of ['https://example.com/x', 'http://203.0.113.5:5173/', 'http://127.0.0.1.example.com/', 'http://localhost.example.com/', 'file:///etc/passwd', 'ftp://127.0.0.1/', 'not a url']) assert.equal(isLocal(u), false, u);
});

test('a flow\'s steps in words, for the evidence', () => {
  assert.deepEqual([{ goto: '/cart' }, { click: 'testid:go' }, { type: { target: 'testid:email', text: 'x' } }, { key: 'Enter' }, { wait: 500 }, { wait: 'testid:done' }, { expect_text: { target: 'testid:total', text: '$1' } }].map(stepLabel), ['goto /cart', 'click testid:go', 'type into testid:email', 'key Enter', 'wait 500 ms', 'wait for testid:done', 'expect testid:total to show "$1"']);
});

test('the trace summary: long tasks on the page\'s main thread only, the longest task, and the share of frames dropped', () => {
  const meta = (pid: number, tid: number, name: string) => ({ ph: 'M', name: 'thread_name', pid, tid, args: { name } });
  const task = (tid: number, ms: number) => ({ ph: 'X', name: 'RunTask', pid: 1, tid, dur: ms * 1000 });
  const frame = (state: string) => ({ ph: 'b', name: 'PipelineReporter', pid: 2, tid: 9, args: { chrome_frame_reporter: { state } } });
  const s = summarizeTrace([meta(1, 10, 'CrRendererMain'), meta(1, 11, 'Compositor'), task(10, 12), task(10, 80), task(10, 250), task(11, 900), ...['STATE_PRESENTED_ALL', 'STATE_PRESENTED_ALL', 'STATE_DROPPED', 'STATE_PRESENTED_PARTIAL'].map(frame), { ph: 'e', name: 'PipelineReporter', pid: 2, tid: 9 }]);
  assert.deepEqual(s, { longTasks: 2, maxTaskMs: 250, droppedFramePct: 25, frames: 4 }, 'the compositor\'s 900 ms task is not the page\'s main thread');
  assert.deepEqual(summarizeTrace([]), { longTasks: 0, maxTaskMs: 0, droppedFramePct: null, frames: 0 }, 'no frame events: not measured, not zero');
});

/**
 * A stand-in for Chrome's DevTools, with no Chrome: it records each command, and each "screenshot" it returns says
 * what was emulated when it was taken (the colour scheme, the width, mobile or not). `fail` makes a command throw;
 * `page` is the page answering a command (emitting the events a real page's code would, through `emit`).
 */
function fakeCdp(fail: (method: string, params: Record<string, unknown>, shots: number) => string | undefined = () => undefined, page: (method: string, params: Record<string, unknown>, emit: (event: string, p: Record<string, unknown>) => void) => Promise<void> | void = () => {}) {
  const sent: { method: string; params: Record<string, unknown>; ms: number | undefined }[] = [];
  const handlers = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  const emit = (event: string, p: Record<string, unknown>) => {
    for (const h of handlers.get(event) ?? []) h(p);
  };
  let scheme = 'light';
  let view = '1440';
  let shots = 0;
  const cdp = {
    async send<T>(method: string, params: Record<string, unknown> = {}, ms?: number): Promise<T> {
      sent.push({ method, params, ms });
      if (method === 'Page.captureScreenshot') shots++;
      const why = fail(method, params, shots);
      if (why) throw new Error(why);
      if (method === 'Emulation.setEmulatedMedia') scheme = (params.features as { name: string; value: string }[]).find((f) => f.name === 'prefers-color-scheme')?.value || 'light';
      if (method === 'Emulation.setDeviceMetricsOverride') view = `${String(params.width)}${params.mobile ? ' mobile' : ''}`;
      await page(method, params, emit);
      if (method === 'Page.captureScreenshot') return { data: Buffer.from(`${scheme} ${view}`).toString('base64') } as T;
      if (method === 'Runtime.evaluate') return { result: {} } as T;
      return {} as T;
    },
    on(event: string, fn: (p: Record<string, unknown>) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
  };
  return { cdp, sent, emit };
}

const blankEvidence = (): FlowEvidence => ({ flow: 'home', ok: true, steps: [{ step: 'goto /', ok: true, ms: 5 }], consoleErrors: [], failedRequests: [], slowRequests: [], blockedRequests: [], trace: { longTasks: 0, maxTaskMs: 0, droppedFramePct: 0, frames: 10 }, screenshot: null, views: [], viewErrors: [], durationMs: 0 });
const thresholds = { max_long_task_ms: 200, max_dropped_frame_pct: 25, slow_request_ms: 3000 };

test('where a flow ended is shot three times: at desktop width, in dark mode at that width, then at phone width in light; each of the viewport only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shots-'));
  const { cdp, sent } = fakeCdp();
  const r = await captureShots(cdp, join(dir, 'evidence'), 'checkout');
  const shot = (name: string) => readFileSync(join(dir, 'evidence', name), 'utf8');
  assert.equal(r.screenshot, join(dir, 'evidence', 'checkout.png'));
  assert.equal(shot('checkout.png'), 'light 1440', 'the desktop shot is the run\'s own view');
  assert.deepEqual(r.views, [
    { view: 'dark', path: join(dir, 'evidence', 'checkout.dark.png') },
    { view: 'phone', path: join(dir, 'evidence', 'checkout.phone.png') },
  ]);
  assert.equal(shot('checkout.dark.png'), 'dark 1440', 'dark mode, at desktop width');
  assert.equal(shot('checkout.phone.png'), 'light 390 mobile', 'phone width, a mobile viewport, and light again');
  const captures = sent.filter((s) => s.method === 'Page.captureScreenshot');
  assert.equal(captures.length, 3, 'three shots, no more');
  for (const c of captures) assert.deepEqual(c.params, { format: 'png' }, 'the viewport only, never the whole page');
  assert.deepEqual(sent.find((s) => s.method === 'Emulation.setDeviceMetricsOverride')?.params, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
});

test("a dark or phone shot that fails says why in its place and never fails the run; the phone shot is never left dark; a failed desktop shot fails the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shots-'));
  // The dark mode is set, but its shot fails: the phone shot after it is still light.
  const lateFail = fakeCdp((method, _p, shots) => (method === 'Page.captureScreenshot' && shots === 2 ? 'Page.captureScreenshot: no answer from Chrome in 30 s\nmore' : undefined));
  const r = await captureShots(lateFail.cdp, join(dir, 'a'), 'home');
  assert.deepEqual(r.views, [
    { view: 'dark', error: 'Page.captureScreenshot: no answer from Chrome in 30 s' },
    { view: 'phone', path: join(dir, 'a', 'home.phone.png') },
  ]);
  assert.equal(readFileSync(join(dir, 'a', 'home.phone.png'), 'utf8'), 'light 390 mobile');
  assert.equal(existsSync(join(dir, 'a', 'home.dark.png')), false);

  // The phone width can't be set: the dark shot stands, the phone one says why.
  const noPhone = fakeCdp((method) => (method === 'Emulation.setDeviceMetricsOverride' ? 'Emulation.setDeviceMetricsOverride: the DevTools connection closed' : undefined));
  const p = await captureShots(noPhone.cdp, join(dir, 'b'), 'home');
  assert.deepEqual(p.views, [
    { view: 'dark', path: join(dir, 'b', 'home.dark.png') },
    { view: 'phone', error: 'Emulation.setDeviceMetricsOverride: the DevTools connection closed' },
  ]);

  // The desktop shot is the run's evidence, as it always was: without it the run fails.
  const none = fakeCdp((method) => (method === 'Page.captureScreenshot' ? 'Page.captureScreenshot: the DevTools connection closed' : undefined));
  await assert.rejects(captureShots(none.cdp, join(dir, 'c'), 'home'), /the DevTools connection closed/);
  assert.equal(none.sent.some((s) => s.method.startsWith('Emulation.')), false, 'no other view is tried');
});

test('shot names never collide, even with every flow in one folder (as previews do): flow home\'s dark shot is not flow home-dark\'s desktop one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shots-'));
  const home = await captureShots(fakeCdp().cdp, dir, 'home');
  // The second flow's Chrome starts at the desktop view in light, as each run's own Chrome does.
  const homeDark = await captureShots(fakeCdp().cdp, dir, 'home-dark');
  const paths = [home, homeDark].flatMap((r) => [r.screenshot, ...r.views.map((v) => ('path' in v ? v.path : ''))]);
  assert.equal(new Set(paths).size, 6, paths.join('\n'));
  assert.equal(readFileSync(home.screenshot, 'utf8'), 'light 1440');
  assert.equal(readFileSync(homeDark.screenshot, 'utf8'), 'light 1440');
  const homeDarkView = home.views.find((v) => v.view === 'dark');
  assert.ok(homeDarkView && 'path' in homeDarkView);
  assert.equal(readFileSync(homeDarkView.path, 'utf8'), 'dark 1440', "flow home's dark shot was not overwritten by flow home-dark's desktop shot");
});

test('what the page does during the dark and phone shots is listed per view and never judged: a page whose phone-width resize throws still passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shots-'));
  const ev = blankEvidence();
  let view: 'dark' | 'phone' | null = null;
  const { cdp, emit } = fakeCdp(undefined, (method, params, send) => {
    if (method === 'Emulation.setEmulatedMedia' && JSON.stringify(params).includes('dark')) {
      send('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'http://127.0.0.1:5173/dark-logo.png', method: 'GET' }, timestamp: 1 });
      send('Network.responseReceived', { requestId: 'r1', response: { url: 'http://127.0.0.1:5173/dark-logo.png', status: 404 } });
    }
    if (method === 'Emulation.setDeviceMetricsOverride') send('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: phone layout broke' } } });
  });
  watch(cdp, ev, thresholds.slow_request_ms, () => true, () => view);
  // During the flow: judged as ever.
  emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'flow error' }] });
  assert.deepEqual(ev.consoleErrors, [{ kind: 'console.error', text: 'flow error' }]);
  ev.consoleErrors = [];
  const shots = await captureShots(cdp, dir, 'home', { onView: (v) => (view = v) });
  assert.deepEqual(shots.views.map((v) => 'path' in v), [true, true]);
  assert.deepEqual(ev.consoleErrors, [], 'the relayout\'s exception is not a flow console error');
  assert.deepEqual(ev.failedRequests, [], "the dark view's 404 is not a flow failed request");
  assert.deepEqual(ev.viewErrors, [
    { view: 'dark', kind: 'failed request', text: 'GET http://127.0.0.1:5173/dark-logo.png (404)' },
    { view: 'phone', kind: 'exception', text: 'Error: phone layout broke' },
  ]);
  const verdict = judgeFlow(ev, thresholds);
  assert.equal(verdict.pass, true, verdict.reasons.join('; '));

  // Never more than VIEW_ERRORS_MAX of them, however noisy the relayout.
  for (let i = 0; i < 50; i++) emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: `noise ${i}` }] });
  assert.equal(ev.viewErrors.length, VIEW_ERRORS_MAX);
});

test('the dark and phone shots share a short budget: a page that stalls them costs seconds, and a view not reached says so; their commands get the short timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shots-'));
  // The page answers the dark view's frame wait late: the budget ends while it waits, so the dark view is cut off
  // there and the phone view is never started.
  const { cdp, sent } = fakeCdp(undefined, async (method) => {
    if (method === 'Runtime.evaluate') await new Promise((r) => setTimeout(r, 80));
  });
  const r = await captureShots(cdp, dir, 'home', { commandMs: 1234, budgetMs: 50 });
  assert.deepEqual(r.views, [
    { view: 'dark', error: "skipped: the extra shots' 0.05 s ran out while it was being taken" },
    { view: 'phone', error: "not tried: the extra shots' 0.05 s were spent" },
  ]);
  assert.equal(sent.filter((s) => s.method === 'Page.captureScreenshot').length, 1, 'only the desktop shot was taken');
  assert.equal(sent.some((s) => s.method === 'Emulation.setDeviceMetricsOverride'), false, 'the phone view was not set up');
  const [desktop, ...extra] = sent;
  assert.equal(desktop!.ms, undefined, 'the desktop shot keeps the usual command timeout');
  assert.ok(extra.length > 0 && extra.every((s) => s.ms === 1234), JSON.stringify(extra));
});

test('the dark and phone shots never take longer than their budget together, however slow each command is: one cut off is listed as skipped and never fails the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shots-'));
  // Chrome answers each extra emulation and screenshot just inside the per-command timeout (the frame wait is quick).
  // Checked per view only, this budget lets the phone view start after the dark one and run its four commands to
  // the end: about 2.5 s for a 1.1 s budget.
  let captures = 0;
  const { cdp } = fakeCdp(undefined, async (method) => {
    if (method === 'Page.captureScreenshot' && ++captures === 1) return; // the desktop shot, which keeps its own timeout
    if (method.startsWith('Emulation.') || method === 'Page.captureScreenshot') await new Promise((r) => setTimeout(r, 390));
  });
  const ev = blankEvidence();
  const t0 = Date.now();
  const shots = await captureShots(cdp, dir, 'home', { commandMs: 400, budgetMs: 1100 });
  const took = Date.now() - t0; // the desktop shot answers at once, so this is the extra shots' time
  assert.ok(took < 1100 + 250, `the extra shots took ${took} ms, past their 1100 ms budget`);
  assert.deepEqual(shots.views, [
    { view: 'dark', path: join(dir, 'home.dark.png') },
    { view: 'phone', error: "skipped: the extra shots' 1.1 s ran out while it was being taken" },
  ]);
  assert.equal(existsSync(join(dir, 'home.phone.png')), false);
  ev.views = shots.views;
  const verdict = judgeFlow(ev, thresholds);
  assert.equal(verdict.pass, true, `a view the budget cut off is never a reason: ${verdict.reasons.join('; ')}`);

  // The frame wait answers just before the budget ends: the pause after it is cut short too, not a full 250 ms.
  const late = fakeCdp(undefined, async (method) => {
    if (method === 'Runtime.evaluate') await new Promise((r) => setTimeout(r, 590));
  });
  const t1 = Date.now();
  const lateShots = await captureShots(late.cdp, join(dir, 'late'), 'home', { commandMs: 1000, budgetMs: 600 });
  const lateTook = Date.now() - t1;
  assert.ok(lateTook < 600 + 120, `the extra shots took ${lateTook} ms, past their 600 ms budget`);
  assert.deepEqual(lateShots.views.map((v) => ('error' in v ? v.error.split(':')[0] : 'taken')), ['skipped', 'not tried']);
});

/** A PNG's width in pixels (its IHDR chunk). */
const pngWidth = (path: string) => readFileSync(path).readUInt32BE(16);

/**
 * A tiny app: a page whose button logs an error, throws, fetches a missing path, a slow path and another host; dark
 * in dark mode; and whose layout code throws at phone width (seen, never judged). WHY the viewport meta: in a mobile
 * viewport a page without one is laid out 980 px wide, so a max-width query never matches (as on a real phone).
 */
function fixtureApp(dir: string) {
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
// A child of the app, as a dev server has (a watcher, a bundler): stopping the app must stop it too.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
import('node:fs').then((fs) => fs.writeFileSync('child.pid', String(child.pid)));
const page = \`<!doctype html><title>shop</title><meta name="viewport" content="width=device-width"><style>@media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }</style><button data-testid="go">Go</button><div data-testid="out"></div>
<script>
matchMedia('(max-width: 500px)').addEventListener('change', (e) => { if (e.matches) throw new Error('phone layout broke'); });
document.querySelector('[data-testid=go]').onclick = async () => {
  console.error('boom from the page');
  fetch('/missing').catch(() => {});
  fetch('https://example.com/track').catch(() => {});
  await fetch('/slow');
  document.querySelector('[data-testid=out]').textContent = 'done: total $10.01';
  setTimeout(() => { throw new Error('late failure'); }, 0);
};
</script>\`;
createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (req.url === '/slow') return setTimeout(() => res.writeHead(200).end('ok'), 600);
  res.writeHead(404).end('no');
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
}

const chrome = findChrome(process.env.CHROME);
realChromeTests();

test('a flow against a real app: errors, a failed, a slow and a blocked request, a trace and a screenshot; then the app and its children are stopped', { skip: !chrome && 'no Chrome or Chromium on this machine (set CHROME); the run itself says so and skips', timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  fixtureApp(dir);
  const port = await freePort();
  const app = AppConfig.parse({
    version: 1,
    start: { command: `"${process.execPath}" server.mjs`, port, ready: { path: '/', timeout_s: 30 } },
    ui_paths: ['web/**'],
    thresholds: { slow_request_ms: 400 },
    flows: {
      checkout: [{ goto: '/' }, { click: 'testid:go' }, { expect_text: { target: 'testid:out', text: '$10.01' } }],
      broken: [{ goto: '/' }, { expect_text: { target: 'testid:out', text: 'never shown' } }],
    },
  });
  const ev = (await runFlow({ app, flow: 'checkout', cwd: dir, outDir: join(dir, 'evidence'), chrome })) as FlowEvidence;
  assert.equal('skipped' in ev, false);
  assert.equal(ev.ok, true, JSON.stringify(ev.steps));
  assert.deepEqual(ev.steps.map((s) => [s.step, s.ok]), [['goto /', true], ['click testid:go', true], ['expect testid:out to show "$10.01"', true]]);
  assert.ok(ev.consoleErrors.some((e) => e.kind === 'console.error' && e.text === 'boom from the page'), JSON.stringify(ev.consoleErrors));
  assert.ok(ev.consoleErrors.some((e) => e.kind === 'exception' && /late failure/.test(e.text)), 'an uncaught exception');
  assert.ok(ev.failedRequests.some((r) => r.url.endsWith('/missing') && r.status === 404), JSON.stringify(ev.failedRequests));
  assert.ok(ev.slowRequests.some((r) => r.url.endsWith('/slow') && r.ms >= 400), JSON.stringify(ev.slowRequests));
  assert.deepEqual(ev.blockedRequests, ['https://example.com/track'], 'the other host was refused before it left');
  assert.ok(!ev.failedRequests.some((r) => r.url.includes('example.com')), 'a refused request is blocked, not failed');
  assert.ok(ev.trace && ev.trace.maxTaskMs >= 0);
  assert.ok(ev.screenshot && statSync(ev.screenshot).size > 1000, 'a screenshot');
  assert.equal(pngWidth(ev.screenshot), 1440, 'the desktop shot is 1440 px wide');
  assert.deepEqual(ev.views.map((v) => [v.view, 'path' in v]), [['dark', true], ['phone', true]], JSON.stringify(ev.views));
  const [dark, phone] = ev.views.map((v) => ('path' in v ? v.path : ''));
  assert.notDeepEqual(readFileSync(dark!), readFileSync(ev.screenshot), 'the dark shot shows the page in dark mode');
  assert.equal(pngWidth(phone!), 390 * 2, 'the phone shot is 390 CSS px wide, at 2x');
  // The page's layout code throws at phone width: seen, under the phone view, and never judged.
  assert.ok(ev.viewErrors.some((e) => e.view === 'phone' && e.kind === 'exception' && /phone layout broke/.test(e.text)), JSON.stringify(ev.viewErrors));
  assert.ok(!ev.consoleErrors.some((e) => /phone layout broke/.test(e.text)), JSON.stringify(ev.consoleErrors));
  assert.ok(!judgeFlow(ev, app.thresholds).reasons.some((r) => /phone layout broke/.test(r)), 'the phone view\'s exception is not a reason the flow fails');
  // Torn down: the port is free again, and the app's own child is gone.
  assert.equal(await portInUse(port), false, 'the app stopped');
  const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(childPid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `the app's child ${childPid} was stopped with it`);

  // A failing step is evidence, not a crash: the flow stops there, and the screenshot and teardown still happen.
  // This step is meant to time out: at the unscaled 10 s, as waiting longer for it proves nothing.
  const bad = (await unscaled(() => runFlow({ app, flow: 'broken', cwd: dir, outDir: join(dir, 'evidence'), chrome }))) as FlowEvidence;
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.at(-1)!.ok, false);
  assert.match(bad.steps.at(-1)!.error!, /never shown/);
  assert.ok(bad.screenshot && existsSync(bad.screenshot));
  assert.equal(await portInUse(port), false);
});

test('an app that never becomes ready: the run fails with its output, and the app is stopped', { skip: !chrome && 'no Chrome or Chromium on this machine', timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  writeFileSync(join(dir, 'never.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('app.pid', String(process.pid)); console.log('starting, but never listening'); setInterval(() => {}, 1000);`);
  const port = await freePort();
  const app = AppConfig.parse({ version: 1, start: { command: `"${process.execPath}" never.mjs`, port, ready: { timeout_s: 2 } }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }] } });
  await assert.rejects(runFlow({ app, flow: 'home', cwd: dir, outDir: join(dir, 'evidence'), chrome }), /timed out after 2000 ms waiting for the app to answer[\s\S]*starting, but never listening/);
  const pid = Number(readFileSync(join(dir, 'app.pid'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((res) => setTimeout(res, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `the app ${pid} was stopped`);
});

test('with no Chrome or Chromium, a run is skipped and says why, starting nothing; an unknown flow is an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  const app = AppConfig.parse({ version: 1, start: { command: `"${process.execPath}" -e "require('fs').writeFileSync('started', '1')"`, port: await freePort() }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }] } });
  const r = await runFlow({ app, flow: 'home', cwd: dir, outDir: dir, chrome: null });
  assert.deepEqual(r, { flow: 'home', skipped: 'no Chrome or Chromium on this machine (set CHROME to its path); browser checks skipped' });
  assert.equal(existsSync(join(dir, 'started')), false, 'the app was not even started');
  await assert.rejects(runFlow({ app, flow: 'nope', cwd: dir, outDir: dir, chrome: null }), /no flow "nope" in app.yaml \(it has: home\)/);
});

const pidGone = async (pid: number) => {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return true;
    }
  }
  return false;
};

test("a browser that can't start fails the run at once, and the app (already running) and its children are stopped", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  fixtureApp(dir);
  const port = await freePort();
  const app = AppConfig.parse({ version: 1, start: { command: `"${process.execPath}" server.mjs`, port, ready: { timeout_s: 30 } }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }] } });
  const t0 = Date.now();
  await assert.rejects(runFlow({ app, flow: 'home', cwd: dir, outDir: join(dir, 'evidence'), chrome: join(dir, 'no-such-browser') }), /Chrome couldn't be started/);
  assert.ok(Date.now() - t0 < 15_000, 'not at the DevTools timeout');
  assert.equal(await portInUse(port), false, 'the app stopped');
  assert.equal(await pidGone(Number(readFileSync(join(dir, 'child.pid'), 'utf8'))), true, "the app's child was stopped with it");
});

// Removing a directory's entry needs its parent writable: lock the parent once Chrome's profile is in it, and the
// profile can't be removed at teardown (as when Chrome is still letting go of its cache). Root ignores this, and so
// does Windows' chmod.
const cannotLock = process.platform === 'win32' || process.getuid?.() === 0;

test('a Chrome whose DevTools port never appears is stopped and started once more, and that is noted; the stuck one is gone', { skip: (!chrome && 'no Chrome or Chromium on this machine') || (process.platform === 'win32' && 'the stand-in browser is a shell script'), timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  // A stand-in that hangs the first time (as Chrome can on a loaded machine), then is the real Chrome.
  const stub = join(dir, 'chrome');
  writeFileSync(stub, `#!/bin/sh\nif [ ! -f "${dir}/started" ]; then echo $$ > "${dir}/started"; exec sleep 600; fi\nexec "${chrome}" "$@"\n`);
  chmodSync(stub, 0o755);
  const b = await launchChrome(stub, { launchMs: 8_000 });
  try {
    assert.match(b.notes.join('\n'), /Chrome was started twice: the first never opened its DevTools port \(timed out after 8000 ms/);
    assert.ok((await b.cdp.send<{ product: string }>('Browser.getVersion')).product, 'the second start works');
  } finally {
    await b.close();
  }
  assert.equal(await pidGone(Number(readFileSync(join(dir, 'started'), 'utf8'))), true, 'the stuck first start was stopped');
  await assert.rejects(launchChrome(join(dir, 'no-such-browser')), /couldn't be started/, 'a browser that fails to start is not retried');
});

test("a teardown that goes wrong (the profile can't be removed) is a note, never a failed run; Chrome and the app's whole tree are still stopped", { skip: (!chrome && 'no Chrome or Chromium on this machine') || (cannotLock && 'needs a directory permission that holds (not Windows, not root)'), timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  fixtureApp(dir);
  const root = join(dir, 'profiles');
  mkdirSync(root);
  const port = await freePort();
  const app = AppConfig.parse({ version: 1, start: { command: `"${process.execPath}" server.mjs`, port, ready: { timeout_s: 30 } }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }, { wait: 'testid:go' }] } });
  const run = runFlow({ app, flow: 'home', cwd: dir, outDir: join(dir, 'evidence'), chrome, chromeProfileRoot: root });
  let profile = '';
  for (let i = 0; i < 1200 && !profile; i++) {
    profile = readdirSync(root).find((f) => f.startsWith('cdp-chrome-')) ?? '';
    if (!profile) await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(profile, 'Chrome got a profile');
  chmodSync(root, 0o555);
  try {
    const ev = (await run) as FlowEvidence;
    assert.equal(ev.ok, true, JSON.stringify(ev.steps));
    assert.match((ev.notes ?? []).join('\n'), /temporary profile .* wasn't removed/, 'the cleanup failure is a note');
    // Nothing still runs from this profile: Chrome and all its helpers are gone.
    const ps = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout;
    assert.deepEqual(ps.split('\n').filter((l) => l.includes(join(root, profile))), [], 'no Chrome process outlived the run');
    assert.equal(await portInUse(port), false, 'the app stopped');
    assert.equal(await pidGone(Number(readFileSync(join(dir, 'child.pid'), 'utf8'))), true, "the app's child was stopped with it");
  } finally {
    chmodSync(root, 0o755);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a flow against a deployed preview may only reach that origin (and in-page schemes)', () => {
  const origin = 'https://pr-7.example.test';
  for (const u of ['https://pr-7.example.test/cart', 'wss://pr-7.example.test/live', 'data:image/png;base64,AA', 'about:blank']) assert.equal(isOnOrigin(u, origin), true, u);
  for (const u of ['http://pr-7.example.test/', 'https://pr-7.example.test:8443/', 'https://pr-8.example.test/', 'https://evil.pr-7.example.test/', 'http://127.0.0.1:5173/', 'not a url']) assert.equal(isOnOrigin(u, origin), false, u);
});

test('runFlowAt: a flow against an app running elsewhere starts nothing, reaches only its origin, and leaves the app running', { skip: !chrome && 'no Chrome or Chromium on this machine', timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {
  await oneChromeAtATime(ctx);
  const dir = mkdtempSync(join(tmpdir(), 'browser-run-'));
  fixtureApp(dir);
  const port = await freePort();
  const server = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !(await portInUse(port)); i++) await new Promise((r) => setTimeout(r, 100));
    const app = AppConfig.parse({ version: 1, start: { command: 'false', port: 1024 }, ui_paths: ['web/**'], thresholds: { slow_request_ms: 400 }, flows: { checkout: [{ goto: '/' }, { click: 'testid:go' }, { expect_text: { target: 'testid:out', text: '$10.01' } }] } });
    const ev = (await runFlowAt({ app, flow: 'checkout', origin: `http://127.0.0.1:${port}`, outDir: join(dir, 'evidence'), chrome })) as FlowEvidence;
    assert.equal(ev.ok, true, JSON.stringify(ev.steps));
    assert.deepEqual(ev.blockedRequests, ['https://example.com/track'], 'the other host was refused before it left');
    assert.ok(ev.screenshot && statSync(ev.screenshot).size > 1000, 'a screenshot');
    assert.equal(await portInUse(port), true, 'the deployed app is not the run\'s to stop');
  } finally {
    server.kill('SIGKILL');
    const child = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    try {
      process.kill(child, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

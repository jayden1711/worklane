import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../src/config/schema.js';
import { findChrome, freePort, portInUse } from '../src/browser/cdp.js';
import { isLocal, runFlow, stepLabel, type FlowEvidence } from '../src/browser/run.js';
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

/** A tiny app: a page whose button logs an error, throws, fetches a missing path, a slow path and another host. */
function fixtureApp(dir: string) {
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
// A child of the app, as a dev server has (a watcher, a bundler): stopping the app must stop it too.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
import('node:fs').then((fs) => fs.writeFileSync('child.pid', String(child.pid)));
const page = \`<!doctype html><title>shop</title><button data-testid="go">Go</button><div data-testid="out"></div>
<script>
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

test('a flow against a real app: errors, a failed, a slow and a blocked request, a trace and a screenshot; then the app and its children are stopped', { skip: !chrome && 'no Chrome or Chromium on this machine (set CHROME); the run itself says so and skips', timeout: 120_000 }, async () => {
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
  const bad = (await runFlow({ app, flow: 'broken', cwd: dir, outDir: join(dir, 'evidence'), chrome })) as FlowEvidence;
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.at(-1)!.ok, false);
  assert.match(bad.steps.at(-1)!.error!, /never shown/);
  assert.ok(bad.screenshot && existsSync(bad.screenshot));
  assert.equal(await portInUse(port), false);
});

test('an app that never becomes ready: the run fails with its output, and the app is stopped', { skip: !chrome && 'no Chrome or Chromium on this machine', timeout: 60_000 }, async () => {
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

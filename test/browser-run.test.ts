import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REAL_CHROME_TIMEOUT, realChromeTests, unscaled } from './browser-helpers.js';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../src/config/schema.js';
import { findChrome, freePort, launchChrome, portInUse } from '../src/browser/cdp.js';
import { isLocal, isOnOrigin, runFlow, runFlowAt, stepLabel, type FlowEvidence } from '../src/browser/run.js';
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
realChromeTests();

test('a flow against a real app: errors, a failed, a slow and a blocked request, a trace and a screenshot; then the app and its children are stopped', { skip: !chrome && 'no Chrome or Chromium on this machine (set CHROME); the run itself says so and skips', timeout: REAL_CHROME_TIMEOUT }, async () => {
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
  // This step is meant to time out: at the unscaled 10 s, as waiting longer for it proves nothing.
  const bad = (await unscaled(() => runFlow({ app, flow: 'broken', cwd: dir, outDir: join(dir, 'evidence'), chrome }))) as FlowEvidence;
  assert.equal(bad.ok, false);
  assert.equal(bad.steps.at(-1)!.ok, false);
  assert.match(bad.steps.at(-1)!.error!, /never shown/);
  assert.ok(bad.screenshot && existsSync(bad.screenshot));
  assert.equal(await portInUse(port), false);
});

test('an app that never becomes ready: the run fails with its output, and the app is stopped', { skip: !chrome && 'no Chrome or Chromium on this machine', timeout: REAL_CHROME_TIMEOUT }, async () => {
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

test('a Chrome whose DevTools port never appears is stopped and started once more, and that is noted; the stuck one is gone', { skip: (!chrome && 'no Chrome or Chromium on this machine') || (process.platform === 'win32' && 'the stand-in browser is a shell script'), timeout: REAL_CHROME_TIMEOUT }, async () => {
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

test("a teardown that goes wrong (the profile can't be removed) is a note, never a failed run; Chrome and the app's whole tree are still stopped", { skip: (!chrome && 'no Chrome or Chromium on this machine') || (cannotLock && 'needs a directory permission that holds (not Windows, not root)'), timeout: REAL_CHROME_TIMEOUT }, async () => {
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

test('runFlowAt: a flow against an app running elsewhere starts nothing, reaches only its origin, and leaves the app running', { skip: !chrome && 'no Chrome or Chromium on this machine', timeout: REAL_CHROME_TIMEOUT }, async () => {
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

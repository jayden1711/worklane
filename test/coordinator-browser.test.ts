import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config/schema.js';
import type { BrowserCheckResult, runBrowserCheck } from '../src/browser/check.js';
import type { FlowEvidence, runFlow } from '../src/browser/run.js';
import { baselineSource, browserChecks, changeAt, type BaselineRun, type BaselineSource } from '../src/coordinator/browser.js';

const app = AppConfig.parse({ version: 1, start: { command: 'npm run dev', port: 5173 }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }], checkout: [{ goto: '/cart' }] } });

/** A runner that answers per flow, recording what it was asked to run. */
function fakeRun(status: Record<string, BrowserCheckResult['status']>) {
  const ran: string[] = [];
  const run = (async (o) => {
    const flow = o.item.browser;
    ran.push(flow);
    const s = status[flow] ?? 'pass';
    return { check: `browser ${flow}`, status: s, kind: 'browser', exitCode: null, tail: s === 'unavailable' ? 'no Chrome or Chromium on this machine' : s, evidence: null, verdict: null };
  }) as typeof runBrowserCheck;
  return { run, ran };
}

test('no app and nothing asked: nothing runs, nothing is recorded, and the PR gets no section', async () => {
  const f = fakeRun({});
  const r = await browserChecks({ app: undefined, doneWhen: [{ test: 'test/a.test.js' }], changed: ['web/a.tsx'], cwd: '.', outDir: 'out', run: f.run });
  assert.deepEqual([f.ran, r.checks, r.lines], [[], [], []]);
});

test('an asked flow is a check whatever its result: unavailable is recorded (so it fails the attempt), with kind browser', async () => {
  const f = fakeRun({ checkout: 'unavailable' });
  const r = await browserChecks({ app, doneWhen: [{ browser: 'checkout' }], changed: [], cwd: '.', outDir: 'out', run: f.run });
  assert.deepEqual(f.ran, ['checkout']);
  assert.deepEqual(r.checks, [{ check: 'browser checkout', status: 'unavailable', kind: 'browser', exitCode: null, tail: 'no Chrome or Chromium on this machine' }]);
  const none = await browserChecks({ app: undefined, doneWhen: [{ browser: 'checkout' }], changed: [], cwd: '.', outDir: 'out' });
  assert.equal(none.checks[0]!.status, 'unavailable', 'with no app, the real check says unavailable, never pass');
  assert.match(none.lines.join('\n'), /the issue asks for the browser check checkout/);
});

test('a change touching ui_paths runs every flow: a failure is a check, but no browser on the machine is listed and skipped', async () => {
  const f = fakeRun({ home: 'fail', checkout: 'unavailable' });
  const r = await browserChecks({ app, doneWhen: [{ test: 'test/a.test.js' }], changed: ['web/cart.tsx'], cwd: '.', outDir: 'out', run: f.run });
  assert.deepEqual(f.ran, ['home', 'checkout']);
  assert.deepEqual(r.checks.map((c) => [c.check, c.status]), [['browser home', 'fail']]);
  assert.ok(r.lines.includes('- `browser checkout`: unavailable'), r.lines.join('\n'));
  const untouched = await browserChecks({ app, doneWhen: [], changed: ['src/server.ts'], cwd: '.', outDir: 'out', run: f.run });
  assert.deepEqual(untouched.checks, []);
  assert.match(untouched.lines.join('\n'), /touches none of the app's ui_paths/);
});

test('the change at a head: its base and files; none at a head no change was proposed at (the base)', () => {
  const ev = [
    { type: 'change.proposed', payload: { head: 'a1', base: 'b0', files: ['web/old.tsx'] } },
    { type: 'check.result', payload: { head: 'b2' } },
    { type: 'change.proposed', payload: { head: 'b2', base: 'b0', files: ['web/new.tsx'] } },
  ];
  assert.deepEqual(changeAt(ev, 'b2'), { base: 'b0', files: ['web/new.tsx'] });
  assert.equal(changeAt(ev, 'c3'), null);
});

const evidence = (errors: string[] = []): FlowEvidence => ({ flow: 'home', ok: true, steps: [{ step: 'goto /', ok: true, ms: 5 }], consoleErrors: errors.map((text) => ({ kind: 'console.error', text })), failedRequests: [], slowRequests: [], blockedRequests: [], trace: null, screenshot: null, durationMs: 10 });

/** A baseline source over fakes: counts worktrees made and removed, and flows run. */
function fakeSource(o: { open?: () => Promise<{ path: string; setupErrors: string[] }>; run?: (flow: string) => Promise<Awaited<ReturnType<typeof runFlow>>>; remove?: () => void; cache?: Map<string, BaselineRun> } = {}) {
  const n = { opened: 0, removed: 0, ran: [] as string[] };
  const cache = o.cache ?? new Map<string, BaselineRun>();
  const source = baselineSource({
    base: 'b0b0b0b0b0b0b0',
    app,
    cache,
    open: async () => (n.opened++, o.open ? o.open() : { path: '/base', setupErrors: [] }),
    remove: () => (n.removed++, o.remove?.()),
    outDir: 'out',
    chrome: 'chrome',
    run: (async (r) => (n.ran.push(r.flow), o.run ? o.run(r.flow) : evidence(['legacy']))) as typeof runFlow,
  });
  return { n, source, cache };
}

test('a baseline per (base, flow): one worktree for all flows, cached so a retry reruns nothing, and always removed', async () => {
  const a = fakeSource();
  assert.deepEqual(await a.source.run('home'), { evidence: evidence(['legacy']) });
  await a.source.run('checkout');
  assert.equal(await a.source.close(), null);
  assert.deepEqual([a.n.opened, a.n.removed, a.n.ran], [1, 1, ['home', 'checkout']]);
  // The next attempt: same base, same cache. Nothing is run, and no worktree is made.
  const b = fakeSource({ cache: a.cache });
  await b.source.run('home');
  await b.source.run('checkout');
  assert.equal(await b.source.close(), null);
  assert.deepEqual([b.n.opened, b.n.removed, b.n.ran], [0, 0, []]);
});

test("a baseline that can't be had says why: no browser, an app that won't start at base, a worktree that can't be made; a removal that fails is a note", async () => {
  const skipped = fakeSource({ run: async (flow) => ({ flow, skipped: 'no Chrome or Chromium on this machine' }) });
  assert.deepEqual(await skipped.source.run('home'), { unavailable: 'no Chrome or Chromium on this machine' });
  const wontStart = fakeSource({ open: async () => ({ path: '/base', setupErrors: ['npm ci: exit 1'] }), run: async () => Promise.reject(new Error('timed out after 5000 ms waiting for the app to answer\nthe app said: boom')) });
  assert.deepEqual(await wontStart.source.run('home'), { unavailable: "the app couldn't be run at base (its setup failed: npm ci: exit 1): timed out after 5000 ms waiting for the app to answer" });
  assert.equal(wontStart.n.removed, 0);
  assert.equal(await wontStart.source.close(), null);
  assert.equal(wontStart.n.removed, 1, 'removed even though the app never started');
  const noTree = fakeSource({ open: () => Promise.reject(new Error('fatal: invalid reference: b0b0')) });
  assert.deepEqual(await noTree.source.run('home'), { unavailable: "the base worktree couldn't be made: fatal: invalid reference: b0b0" });
  const stuck = fakeSource({
    remove: () => {
      throw new Error('issue-1-browser-base is still on disk');
    },
  });
  await stuck.source.run('home');
  assert.equal(await stuck.source.close(), "the base worktree wasn't removed: issue-1-browser-base is still on disk");
});

/** browserChecks with a baseline whose results are given per flow, recording what each check was handed. */
async function withBaseline(base: Record<string, BaselineRun>, opts: { throwOn?: string } = {}) {
  const handed: Record<string, FlowEvidence | null | undefined> = {};
  let closed = 0;
  const source: BaselineSource = { base: 'b0b0b0b0b0b0b0', run: async (flow) => base[flow]!, close: async () => (closed++, null) };
  const run = (async (o) => {
    if (o.item.browser === opts.throwOn) throw new Error('boom');
    handed[o.item.browser] = o.baseline;
    return { check: `browser ${o.item.browser}`, status: 'pass', kind: 'browser', exitCode: null, tail: 'passed', evidence: evidence(), verdict: { pass: true, reasons: [], notes: [] } };
  }) as typeof runBrowserCheck;
  const r = await browserChecks({ app, doneWhen: [{ browser: 'home' }], changed: [], cwd: '.', outDir: 'out', chrome: 'chrome', run, baseline: () => source }).catch((e: Error) => e);
  return { r, handed, closed: () => closed };
}

test('each flow is judged against its baseline; an unavailable one is said in the check and the PR, and judged with none', async () => {
  const ok = await withBaseline({ home: { evidence: evidence(['legacy']) } });
  assert.deepEqual(ok.handed.home, evidence(['legacy']), 'the base run is the baseline the check judges against');
  const lines = (ok.r as Awaited<ReturnType<typeof browserChecks>>).lines;
  assert.ok(lines.some((l) => l.startsWith('  - before the change (base `b0b0b0b0b0b0`): 1/1 steps held, 1 console error(s)')), lines.join('\n'));
  const none = await withBaseline({ home: { unavailable: "the app couldn't be run at base: exited" } });
  assert.equal(none.handed.home, null, 'judged with no baseline: every error counts');
  const r = none.r as Awaited<ReturnType<typeof browserChecks>>;
  assert.match(r.checks[0]!.tail, /note: no baseline at base b0b0b0b0b0b0 \(the app couldn't be run at base: exited\), so every error was counted as new/);
  assert.ok(r.lines.includes("  - no baseline (base `b0b0b0b0b0b0`): `the app couldn't be run at base: exited`, so every error was counted as new"), r.lines.join('\n'));
  assert.equal(none.closed(), 1);
});

test('the base worktree is removed however the checks end, a thrown error included; no browser makes no baseline at all', async () => {
  const thrown = await withBaseline({ home: { evidence: evidence() } }, { throwOn: 'home' });
  assert.ok(thrown.r instanceof Error);
  assert.equal(thrown.closed(), 1);
  let asked = 0;
  await browserChecks({ app, doneWhen: [{ browser: 'home' }], changed: [], cwd: '.', outDir: 'out', chrome: null, run: fakeRun({ home: 'unavailable' }).run, baseline: () => (asked++, { base: 'b0', run: async () => ({ unavailable: '' }), close: async () => null }) });
  assert.equal(asked, 0);
});

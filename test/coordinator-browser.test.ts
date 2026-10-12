import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../src/config/schema.js';
import type { BrowserCheckResult, runBrowserCheck } from '../src/browser/check.js';
import { browserChecks, changedAt } from '../src/coordinator/browser.js';

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

test('the changed files are those of the change proposed at that head; none at another (the base)', () => {
  const ev = [
    { type: 'change.proposed', payload: { head: 'a1', files: ['web/old.tsx'] } },
    { type: 'check.result', payload: { head: 'b2' } },
    { type: 'change.proposed', payload: { head: 'b2', files: ['web/new.tsx'] } },
  ];
  assert.deepEqual(changedAt(ev, 'b2'), ['web/new.tsx']);
  assert.deepEqual(changedAt(ev, 'c3'), []);
});

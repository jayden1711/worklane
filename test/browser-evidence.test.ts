import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserCheckResult } from '../src/browser/check.js';
import { judgeFlow } from '../src/browser/check.js';
import { browserEvidenceLines, evidenceSummary } from '../src/browser/evidence.js';
import type { BrowserGate } from '../src/browser/gate.js';
import type { FlowEvidence } from '../src/browser/run.js';
import { EventSchemas } from '../src/events/types.js';

const thresholds = { max_long_task_ms: 200, max_dropped_frame_pct: 25, slow_request_ms: 3000 };
const evidence = (over: Partial<FlowEvidence> = {}): FlowEvidence => ({
  flow: 'checkout',
  ok: true,
  steps: [
    { step: 'goto /cart', ok: true, ms: 40 },
    { step: 'click testid:pay', ok: true, ms: 80 },
  ],
  consoleErrors: [],
  failedRequests: [],
  slowRequests: [],
  blockedRequests: [],
  trace: { longTasks: 1, maxTaskMs: 120, droppedFramePct: 10, frames: 30 },
  screenshot: '/home/example/runs/42/checkout.png',
  durationMs: 900,
  ...over,
});
const judged = (ev: FlowEvidence, baseline?: FlowEvidence): BrowserCheckResult => {
  const verdict = judgeFlow(ev, thresholds, baseline);
  return { check: `browser ${ev.flow}`, status: verdict.pass ? 'pass' : 'fail', kind: 'browser', exitCode: null, tail: '', evidence: ev, verdict };
};
const touched: BrowserGate = { flows: ['checkout'], reason: 'the change touches 1 file(s) under ui_paths, so every flow runs', uiFiles: ['web/cart/Pay.tsx'] };

test('a run in one line: steps held, errors, failed and slow requests, the trace', () => {
  assert.equal(evidenceSummary(evidence()), '2/2 steps held, 0 console error(s), 0 failed request(s), 0 slow, longest task 120 ms, 10% frames dropped');
  assert.equal(evidenceSummary(evidence({ trace: null })), '2/2 steps held, 0 console error(s), 0 failed request(s), 0 slow, no trace');
  assert.match(evidenceSummary(evidence({ trace: { longTasks: 0, maxTaskMs: 0, droppedFramePct: null, frames: 0 } })), /frames not measured$/);
});

test('a passing flow: why it ran, the files, the result, and the screenshot by name only (not the machine\'s path)', () => {
  assert.deepEqual(browserEvidenceLines({ gate: touched, runs: [{ result: judged(evidence()) }] }), [
    '### BROWSER CHECKS',
    '- Why: the change touches 1 file(s) under ui_paths, so every flow runs',
    '- UI files touched: `web/cart/Pay.tsx`',
    '- `browser checkout`: pass',
    '  - 2/2 steps held, 0 console error(s), 0 failed request(s), 0 slow, longest task 120 ms, 10% frames dropped',
    '  - screenshot: `checkout.png` (kept with the run)',
  ]);
});

test('a UI fix shows the reproduction before the change beside the run after it', () => {
  const before = evidence({ ok: false, steps: [{ step: 'goto /cart', ok: true, ms: 40 }, { step: 'click testid:pay', ok: false, ms: 5000, error: 'no element' }], consoleErrors: [{ kind: 'exception', text: 'TypeError: total is undefined' }] });
  const lines = browserEvidenceLines({ gate: touched, runs: [{ result: judged(evidence(), before), before }] });
  assert.deepEqual(lines.slice(3, 6), [
    '- `browser checkout`: pass',
    '  - before the change: 1/2 steps held, 1 console error(s), 0 failed request(s), 0 slow, longest task 120 ms, 10% frames dropped',
    '  - after the change: 2/2 steps held, 0 console error(s), 0 failed request(s), 0 slow, longest task 120 ms, 10% frames dropped',
  ]);
});

test('a failing flow lists why and what was seen, capped, with app text quoted so it never renders as markup or mentions', () => {
  const ev = evidence({
    consoleErrors: Array.from({ length: 7 }, (_, i) => ({ kind: 'console.error', text: i === 0 ? '<img src=x onerror=alert(1)> @owner `boom`\n  at app.js:1' : `boom ${i}` })),
    failedRequests: [{ url: 'http://127.0.0.1:5173/api/pay', method: 'POST', status: 500, error: null }],
    slowRequests: [{ url: 'http://127.0.0.1:5173/api/cart', method: 'GET', ms: 3400 }],
    blockedRequests: ['GET https://example.com/track'],
    trace: { longTasks: 2, maxTaskMs: 450, droppedFramePct: 5, frames: 40 },
  });
  const lines = browserEvidenceLines({ gate: touched, runs: [{ result: judged(ev) }] });
  assert.equal(lines[3], '- `browser checkout`: fail');
  assert.ok(lines.includes("    - console.error: `<img src=x onerror=alert(1)> @owner 'boom'`"), lines.join('\n'));
  assert.ok(lines.includes('    - and 2 more'));
  assert.ok(lines.includes('    - POST `http://127.0.0.1:5173/api/pay` (500)'));
  assert.ok(lines.includes('    - GET `http://127.0.0.1:5173/api/cart`: 3400 ms'));
  assert.ok(lines.includes('    - `GET https://example.com/track`'));
  assert.ok(lines.some((l) => l.startsWith('  - failed: `a main-thread task took 450 ms')));
  assert.ok(lines.includes('  - note: 1 slow request(s), slowest 3400 ms'));
  for (const l of lines) assert.ok(!/(^|[^`])<img/.test(l.replace(/`[^`]*`/g, '')), `markup outside a code span: ${l}`);
});

test('no checks run: just why; a check that could not run says so', () => {
  assert.deepEqual(browserEvidenceLines({ gate: { flows: [], reason: "the change touches none of the app's ui_paths, so no browser checks", uiFiles: [] }, runs: [] }), ['### BROWSER CHECKS', "- Why: the change touches none of the app's ui_paths, so no browser checks"]);
  const unavailable: BrowserCheckResult = { check: 'browser home', status: 'unavailable', kind: 'browser', exitCode: null, tail: 'no Chrome or Chromium on this machine (set CHROME to its path); browser checks skipped', evidence: null, verdict: null };
  assert.deepEqual(browserEvidenceLines({ gate: { flows: ['home'], reason: 'the issue asks for the browser check home', uiFiles: [] }, runs: [{ result: unavailable }] }).slice(2), ['- `browser home`: unavailable', '  - `no Chrome or Chromium on this machine (set CHROME to its path); browser checks skipped`']);
});

test('a browser check is recorded as one, so the receipts can tell it from a command', () => {
  const r = judged(evidence());
  const rec = { check: r.check, status: r.status, exitCode: r.exitCode, kind: r.kind };
  assert.equal(EventSchemas['check.result'].safeParse({ issue: 1, head: 'a'.repeat(40), stage: 'verify', checks: [rec] }).success, true);
  assert.equal(EventSchemas['check.result'].safeParse({ issue: 1, head: 'a'.repeat(40), stage: 'verify', checks: [{ ...rec, kind: 'command' }] }).success, false);
});

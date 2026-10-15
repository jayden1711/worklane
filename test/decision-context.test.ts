// What a decision rests on, as decision.asked records it (src/decision-context.ts): the file and line a finding's
// evidence names, the bounds that keep recording it from ever failing the ask, and that a viewer never gets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeContext, findingLocation, investigationContext, summaryContext } from '../src/decision-context.js';
import { EventLog } from '../src/events/log.js';
import { EventSchemas } from '../src/events/types.js';
import { forViewer } from '../src/viewer-events.js';

test("a finding's file and line come from its evidence, only when it names them", () => {
  assert.deepEqual(findingLocation('src/price.js:3 sum + cents * qty'), { file: 'src/price.js', line: 3 });
  assert.deepEqual(findingLocation('see `web/src/pages/Decisions.tsx:120:7` for the clamp'), { file: 'web/src/pages/Decisions.tsx', line: 120 });
  assert.deepEqual(findingLocation('(./lib/a.ts#L42)'), { file: 'lib/a.ts', line: 42 });
  assert.equal(findingLocation('npm test -> 3 failures'), null, 'a command and its output names no file');
  assert.equal(findingLocation('src/price.js has no guard'), null, 'a file without a line is not a location');
  assert.equal(findingLocation('at 10:30 the job ran'), null, 'a time is not a file');
});

test('a context is clipped to the schema: a huge change or a long finding is recorded, never refused', () => {
  const files = Array.from({ length: 350 }, (_, i) => ({ path: `src/f${i}.ts`, added: 1, removed: 0 }));
  const long = 'x'.repeat(10_000);
  const ctx = changeContext({
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    files,
    level: { level: 'L3', reasons: [long], categories: { 'money-path': ['src/f1.ts'], auth: [] } },
    verdict: { patch_correct: true, test_correct: true, confidence: 'high', advice: long, confidence_reason: 'read every changed line' },
    checks: [{ check: 'test', status: 'pass', duration_ms: 1200, tail: long }],
  });
  assert.equal(ctx.files?.length, 300);
  assert.equal(ctx.files_more, 50);
  assert.deepEqual(ctx.categories, { 'money-path': ['src/f1.ts'] }, 'only the categories it falls in');
  assert.equal(ctx.verdict?.confidence_reason, 'read every changed line');
  const inv = investigationContext({ summary: long, findings: Array.from({ length: 120 }, () => ({ claim: long, evidence: long })), confidence: 'medium', unverified: ['u'] });
  assert.equal(inv.findings?.length, 100);
  for (const c of [ctx, inv, summaryContext(long)!]) {
    const p = { id: 'd', kind: 'land', issue: 1, owner: 'o', question: 'q', options: ['approve'], recommendation: '', receipts: [], context: c };
    assert.doesNotThrow(() => EventSchemas['decision.asked'].parse(p));
  }
  assert.equal(summaryContext('  '), undefined, 'no summary, no context');
});

test("a decision's context is never a viewer's", () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-context-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('decision.asked', { id: 'd1', kind: 'question', issue: 4, owner: 'example-owner', question: 'How should this proceed?', options: ['approve-fix', 'close'], recommendation: 'close', receipts: [], context: investigationContext({ summary: 'secret detail', findings: [{ claim: 'c', evidence: 'src/a.ts:1' }], confidence: 'high' }) }, 'coordinator');
  const seen = log.read().map(forViewer).filter((e) => e !== null);
  log.close();
  assert.equal(seen.length, 1);
  assert.equal('context' in (seen[0]!.payload as object), false);
  assert.doesNotMatch(JSON.stringify(seen), /secret detail/);
});

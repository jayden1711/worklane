import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { decisionOf, decisionTrace, diffTraces, normalizeReason, shadowCommand } from '../src/shadow.js';

let id = 0;
const ev = (type: string, payload: Record<string, unknown>): StoredEvent => ({ id: ++id, ts: new Date(1_700_000_000_000 + id).toISOString(), type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;

test('the decision trace: what was decided, with ids, times, hashes, paths and numbers taken out; events that decide nothing are left out', () => {
  const a = [
    ev('coordinator.tick', { dispatched: 1 }),
    ev('issue.claimed', { issue: 4, instance: 'x', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'o' }),
    ev('review.level_set', { issue: 4, head: 'c'.repeat(40), level: 'L2', reasons: ['x'] }),
    ev('eval.verdict', { issue: 4, head: 'c'.repeat(40), patch_correct: true, test_correct: false, confidence: 'medium' }),
    ev('merge.decided', { issue: 4, number: 9, head: 'c'.repeat(40), auto: false, reasons: ['high-risk: auth (src/a.ts, src/b.ts)', 'big: 812 changed lines (over 400)', 'big: 812 changed lines (over 400)'] }),
    ev('guardrail.decision', { decision: 'deny', rule: 'no-force-push', agent: true }),
    ev('run.finished', { issue: 4, role: 'worker', reason: 'succeeded' }),
    ev('testrun.fault', { id: 'r', tier: 't', fault: 'gpu_lost', evidence: 'No devices were found' }),
  ];
  assert.deepEqual(decisionTrace(a), [
    'claimed',
    'review level L2',
    'evaluator: patch correct, test not correct, confidence medium',
    'merge: waits (big: # changed lines; high-risk: auth)',
    'guardrail deny: no-force-push',
    'worker run: succeeded',
    'machine fault: gpu_lost',
  ]);
  assert.equal(decisionOf(ev('merge.decided', { auto: true, reasons: [] })), 'merge: auto');
  assert.equal(normalizeReason('blocked at abc1234def for 30 s (see /tmp/x)'), 'blocked at <sha> for # s');
});

test('diffTraces: [] when the decisions are the same; otherwise every line, the changed ones marked - (current) and + (candidate)', () => {
  assert.deepEqual(diffTraces(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(diffTraces([], []), []);
  assert.deepEqual(diffTraces(['claimed', 'merge: auto', 'land: landed'], ['claimed', 'merge: waits (big)', 'land: landed']), ['  claimed', '+ merge: waits (big)', '- merge: auto', '  land: landed']);
  assert.deepEqual(diffTraces(['a'], ['a', 'b']), ['  a', '+ b']);
  assert.deepEqual(diffTraces(['a', 'b'], ['b']), ['- a', '  b']);
});

test('shadow diff: exit 0 when every log decided the same, 3 when one differs or is unmatched (printed), 1 unreadable, 2 usage; it writes nothing', () => {
  const base = mkdtempSync(join(tmpdir(), 'shadow-'));
  const cur = join(base, 'cur');
  const cand = join(base, 'cand');
  mkdirSync(cur);
  mkdirSync(cand);
  const write = (dir: string, name: string, auto: boolean) => {
    const log = new EventLog(join(dir, name));
    log.append('merge.decided', { issue: 1, number: 2, head: 'a'.repeat(40), auto, reasons: auto ? [] : ['doubt: no evaluator verdict'] }, 'c');
    log.close();
  };
  const out: string[] = [];
  const err: string[] = [];
  const run = (...a: string[]) => shadowCommand(a[0], a.slice(1), (s) => out.push(s), (s) => err.push(s));
  try {
    write(cur, 't-1.db', true);
    write(cand, 't-1.db', true);
    assert.equal(run('diff', '--current', cur, '--candidate', cand), 0);
    assert.equal(out.at(-1), '1 log(s) decided the same, 0 differ, 0 unmatched');
    write(cur, 't-2.db', true);
    write(cand, 't-2.db', false);
    write(cand, 't-3.db', true);
    out.length = 0;
    assert.equal(run('diff', '--current', cur, '--candidate', cand), 3);
    assert.deepEqual(out, ['DIFFERS: t-2.db', '  + merge: waits (doubt: no evaluator verdict)', '  - merge: auto', 'ONLY IN CANDIDATE: t-3.db', '1 log(s) decided the same, 1 differ, 1 unmatched']);
    assert.equal(run('diff', '--current', join(base, 'nope'), '--candidate', cand), 1);
    assert.equal(run('diff', '--current', cur), 2);
    assert.equal(run('merge', '--current', cur, '--candidate', cand), 2);
    assert.equal(run('diff', '--current', cur, '--candidate', cand, '--current', cur), 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

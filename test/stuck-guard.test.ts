import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { replayFeed, scanStuck, STUCK_FLAG_AT, STUCK_STOP_AT, StuckDetector, stuckAction, type StuckVerdict } from '../src/stuck.js';

/** One recorded event stream: the stream-json lines a run produces, `n` times the same call with these results. */
function stream(calls: { name: string; input: object; ok: boolean; output?: string }[]) {
  return calls.flatMap((c, i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: !c.ok, content: c.output ?? (c.ok ? 'ok' : 'Error: exit 1') }] } },
  ]);
}

/** Replay a stream through a fresh detector; where (1-based call number) each verdict came. */
function replay(lines: object[]) {
  const d = new StuckDetector();
  const at: { verdict: StuckVerdict; call: number }[] = [];
  let call = 0;
  for (const l of lines) {
    if ((l as { type: string }).type === 'user') call++;
    for (const v of d.line(l)) at.push({ verdict: v, call });
  }
  return { at, d };
}

const same = (n: number, ok: boolean) => Array.from({ length: n }, () => ({ name: 'Bash', input: { command: 'npm test' }, ok }));

test('identical failing calls: flagged at 5, stopped at 8', () => {
  const { at, d } = replay(stream(same(10, false)));
  assert.deepEqual(at.map((x) => [x.verdict.kind, x.call]), [['flag', STUCK_FLAG_AT], ['stop', STUCK_STOP_AT]]);
  assert.equal(at[1]!.verdict.failures, 8);
  assert.equal(at[1]!.verdict.tool, 'Bash');
  assert.deepEqual([d.longest.repeats, d.longest.failures], [10, 10], 'the record shows the streak');
});

test('identical calls that succeed: flagged at 5 (any status), never stopped', () => {
  const { at } = replay(stream(same(12, true)));
  assert.deepEqual(at.map((x) => [x.verdict.kind, x.call]), [['flag', 5]]);
});

test('a paginated read (same tool, different input) never trips', () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({ name: 'Read', input: { file_path: '/repo/big.log', offset: i * 2000, limit: 2000 }, ok: true }));
  assert.deepEqual(replay(stream(pages)).at, []);
});

test('permission denials neither count nor break a streak', () => {
  const denied = (text: string) => ({ name: 'Bash', input: { command: 'npm test' }, ok: false, output: text });
  const calls = [
    ...same(4, false),
    denied('Permission to use Bash has been denied.'),
    denied(`[${BRAND.cli}] blocked: the full tier is the coordinator's`),
    denied("Claude requested permissions to use Bash, but you haven't granted it yet."),
    ...same(1, false),
  ];
  const { at } = replay(stream(calls));
  assert.deepEqual(at.map((x) => [x.verdict.kind, x.verdict.failures]), [['flag', 5]], 'the 5th real failure flags; the three denials did not count');
  const onlyDenials = Array.from({ length: 12 }, () => denied('Permission to use Bash has been denied.'));
  assert.deepEqual(replay(stream(onlyDenials)).at, []);
});

test('a different call breaks the streak; failures then success resets the failure count', () => {
  const calls = [...same(4, false), { name: 'Read', input: { file_path: '/repo/a' }, ok: true }, ...same(4, false), ...same(1, true), ...same(4, false)];
  assert.deepEqual(replay(stream(calls)).at.map((x) => x.verdict.kind), ['flag'], 'only the any-status run of 9 identical calls flags; no 8 failures in a row');
});

test('a recorded feed replays the same way (the scan uses it)', () => {
  const items = Array.from({ length: 9 }, (_, i) => [
    { kind: 'tool', id: `t${i}`, tool: 'Bash', input: '{"command":"make test-fast"}' },
    { kind: 'tool_result', id: `t${i}`, status: 'error', output: 'FAILED' },
  ]).flat();
  assert.deepEqual(replayFeed(items).verdicts.map((v) => v.kind), ['flag', 'stop']);
});

test('the scan counts how many recorded runs would have been flagged or stopped, and reads nothing else', () => {
  const state = mkdtempSync(join(tmpdir(), 'scan-'));
  const runs = join(state, 'runs');
  mkdirSync(runs, { recursive: true });
  const feed = (n: number, status: 'ok' | 'error', input = '{"command":"npm test"}') =>
    [{ kind: 'start', run: 'r', issue: 1, role: 'worker', model: 'm' }, ...Array.from({ length: n }, (_, i) => [{ kind: 'tool', id: `t${i}`, tool: 'Bash', input }, { kind: 'tool_result', id: `t${i}`, status, output: 'x' }]).flat()]
      .map((it, seq) => JSON.stringify({ seq, at: '2026-10-11T00:00:00Z', ...it }))
      .join('\n');
  writeFileSync(join(runs, 'a.feed.jsonl'), feed(3, 'error'));
  writeFileSync(join(runs, 'b.feed.jsonl'), feed(6, 'ok'));
  writeFileSync(join(runs, 'c.feed.jsonl'), feed(9, 'error'));
  writeFileSync(join(runs, 'd.json'), '{}'); // a run record without a feed: not scanned, counted as such
  const s = scanStuck(state);
  assert.deepEqual([s.scanned, s.flagged, s.stopped, s.noFeed], [3, 2, 1, 1]);
  assert.deepEqual(s.examples.map((e) => [e.run, e.kind]), [['b', 'flag'], ['c', 'stop']]);
});

test('dry-run logs every verdict and stops nothing; on stops at the stop verdict; off does nothing', () => {
  const verdicts = replay(stream(same(9, false))).at.map((x) => x.verdict);
  assert.deepEqual(verdicts.map((v) => stuckAction('dry-run', v)), ['log', 'log']);
  assert.deepEqual(verdicts.map((v) => stuckAction('on', v)), ['log', 'stop']);
  assert.deepEqual(verdicts.map((v) => stuckAction('off', v)), [null, null]);
});

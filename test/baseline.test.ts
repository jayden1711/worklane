import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineGate, latestBaseline, parseFailures, readBaseline, recordBaseline } from '../src/baseline.js';
import { EventLog } from '../src/events/log.js';

// A custom runner's summary (with colors), and node --test's spec reporter.
const SUITES = { section: 'suite\\(s\\) failed:', item: '^\\s+- (\\S+)' };
const NODE = { section: '^✖ failing tests:', item: '^✖ (.+?) \\(\\d' };
const suiteRun = (...failed: string[]) => `\x1b[1misolated\x1b[0m ...\n${'='.repeat(58)}\n\x1b[31m${failed.length} suite(s) failed:\x1b[0m\n${failed.map((f) => `  - ${f}`).join('\n')}\n`;
const base = { sha: 'abc1234def', failing: ['test/test-a.js', 'test/test-b.js'], recordedAt: '' };

test('parses failing names from a runner summary, colors and all', () => {
  assert.deepEqual(parseFailures(suiteRun('test/test-b.js', 'test/test-a.js'), SUITES), ['test/test-a.js', 'test/test-b.js']);
  assert.equal(parseFailures('All suites passed.', SUITES), null, 'no section: not "zero failures"');
  const node = 'ℹ fail 2\n\n✖ failing tests:\n\ntest at test/x.test.js:3:1\n✖ totals (0.4ms)\n  AssertionError\ntest at test/y.test.js:1:1\n✖ discounts (1.2ms)\n';
  assert.deepEqual(parseFailures(node, NODE), ['discounts', 'totals']);
});

test('gate: failures already on main pass; any new failure fails', () => {
  assert.equal(baselineGate(0, 'All suites passed.', SUITES, null).outcome, 'pass');
  const same = baselineGate(1, suiteRun('test/test-a.js'), SUITES, base);
  assert.equal(same.outcome, 'pass');
  assert.match(same.note, /no new failures; 1 already failing on main/);
  const fresh = baselineGate(1, suiteRun('test/test-a.js', 'test/test-c.js'), SUITES, base);
  assert.equal(fresh.outcome, 'fail');
  assert.deepEqual(fresh.outcome === 'fail' && fresh.newFailures, ['test/test-c.js']);
});

test('gate: unknown red is red', () => {
  assert.equal(baselineGate(1, 'Segmentation fault', SUITES, base).outcome, 'fail', 'exit 1 with nothing parsable');
  assert.equal(baselineGate(1, suiteRun(), SUITES, base).outcome, 'fail', 'a failure section listing nothing');
  assert.equal(baselineGate(null, '', SUITES, base).outcome, 'fail', 'did not finish');
  assert.equal(baselineGate(1, suiteRun('test/test-a.js'), undefined, base).outcome, 'fail', 'no format configured');
  assert.equal(baselineGate(1, suiteRun('test/test-a.js'), SUITES, null).outcome, 'fail', 'no baseline recorded');
});

test('recording: a red run records its failing set; an unparsable red run records nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-'));
  const log = new EventLog(join(dir, 'events.db'));
  assert.deepEqual(recordBaseline(log, 'me', 'abc1234def', 1, suiteRun('test/test-a.js'), SUITES), { ok: true, failing: ['test/test-a.js'] });
  assert.equal(recordBaseline(log, 'me', 'abc1234def', 1, 'crashed', SUITES).ok, false);
  assert.deepEqual(recordBaseline(log, 'me', 'def5678abc', 0, 'All suites passed.', SUITES), { ok: true, failing: [] });
  assert.equal(latestBaseline(log)!.sha, 'def5678abc');
  log.close();
  assert.deepEqual(readBaseline(join(dir, 'events.db'))!.failing, [], 'hooks read it read-only');
  assert.equal(readBaseline(join(dir, 'missing.db')), null);
});

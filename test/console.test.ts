import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { ConsoleError, liveRuns, MAX_MESSAGE, runFeed, sendMessage, stopRun, takeRequests, writeLive } from '../src/console.js';
import { FEED_MAX_LINES, readFeed, RunFeed, writeDiff } from '../src/run-feed.js';
import { readRun, RunRecorder } from '../src/run-record.js';
import { exampleProject } from './helpers.js';

const cfg = loadConfig(exampleProject().dir);
const owner = cfg.project.owners.default;
const state = () => mkdtempSync(join(tmpdir(), 'console-'));
const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const at = () => new Date('2026-10-10T12:00:00Z');

// A short session, as stream-json lines: thinking, text, a command with a secret in it, an edit, and their results.
const CWD = '/work/issue-7';
const SESSION = [
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Look at the totals first.' }, { type: 'text', text: 'Reading the code.' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `GITHUB_TOKEN=${TOKEN} npm test` } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `ok\nused ${TOKEN}\n`, is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${CWD}/src/price.js`, old_string: 'a * b', new_string: 'b > 0 ? a * b : 0' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'edited', is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm run lint' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'exit code 1', is_error: true }] } },
];

test('feed: thinking, text, each tool call with its input, capped outputs, and edits as diffs', () => {
  const s = state();
  const f = new RunFeed(s, { run: 'r1', issue: 7, role: 'worker', model: 'm', cwd: CWD }, undefined, at);
  for (const l of SESSION) f.line(l);
  f.end({ reason: 'succeeded', costUsd: 0.5, turns: 4 });
  const { items, ended } = readFeed(s, 'r1')!;
  assert.equal(ended, true);
  assert.deepEqual(items.map((i) => i.seq), items.map((_, n) => n), 'seq counts with no gaps');
  assert.deepEqual(items.map((i) => i.kind), ['start', 'thinking', 'text', 'tool', 'tool_result', 'tool', 'diff', 'tool_result', 'tool', 'tool_result', 'end']);
  assert.deepEqual(items[0], { seq: 0, at: '2026-10-10T12:00:00.000Z', kind: 'start', run: 'r1', issue: 7, role: 'worker', model: 'm' });
  const edit = items.find((i) => i.kind === 'diff') as { file: string; diff: string };
  assert.equal(edit.file, 'src/price.js', 'repo-relative, as in the run record');
  assert.equal(edit.diff, '--- a/src/price.js\n+++ b/src/price.js\n@@\n-a * b\n+b > 0 ? a * b : 0');
  const editCall = items.find((i) => i.kind === 'tool' && i.tool === 'Edit') as { input: string };
  assert.equal(editCall.input, JSON.stringify({ file_path: 'src/price.js' }), "a write's content is in its diff, not repeated in the call");
  assert.deepEqual(items.at(-1), { seq: 10, at: '2026-10-10T12:00:00.000Z', kind: 'end', reason: 'succeeded', costUsd: 0.5, turns: 4 });
});

test('feed: redacted with the event log patterns before it is written, never after', () => {
  const s = state();
  const f = new RunFeed(s, { run: 'r2', issue: 7, role: 'worker', model: 'm', cwd: CWD });
  for (const l of SESSION) f.line(l);
  f.end({ reason: 'succeeded', costUsd: 0, turns: 1 });
  const raw = readFileSync(join(s, 'runs', 'r2.feed.jsonl'), 'utf8');
  assert.ok(!raw.includes(TOKEN), 'the token never reaches the file');
  assert.match(raw, /gh\*_\[REDACTED\]/);
});

test('feed: capped per run in lines and bytes, with one truncation marker; the end item is always written', () => {
  const s = state();
  const f = new RunFeed(s, { run: 'r3', issue: null, role: 'worker', model: 'm', cwd: CWD }, { bytes: 1_000_000, lines: 6 });
  for (let i = 0; i < 20; i++) f.line({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${i}` }] } });
  f.end({ reason: 'succeeded', costUsd: 0, turns: 1 });
  const items = readFeed(s, 'r3')!.items;
  assert.equal(items.length, 6);
  assert.deepEqual(items.slice(-2).map((i) => i.kind), ['truncated', 'end']);
  assert.equal((items.at(-2) as { why: string }).why, 'lines');
  const b = state();
  const big = new RunFeed(b, { run: 'r4', issue: null, role: 'worker', model: 'm', cwd: CWD }, { bytes: 2000, lines: FEED_MAX_LINES });
  for (let i = 0; i < 50; i++) big.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } });
  big.end({ reason: 'succeeded', costUsd: 0, turns: 1 });
  assert.ok(readFileSync(join(b, 'runs', 'r4.feed.jsonl')).length <= 2000);
  const kinds = readFeed(b, 'r4')!.items.map((i) => i.kind);
  assert.deepEqual(kinds.slice(-2), ['truncated', 'end']);
  assert.equal(kinds.filter((k) => k === 'truncated').length, 1);
  // A long tool output is cut to its first lines, with a marker.
  const o = state();
  const out = new RunFeed(o, { run: 'r5', issue: null, role: 'worker', model: 'm', cwd: CWD });
  out.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') }] } });
  assert.match((readFeed(o, 'r5')!.items[1] as { output: string }).output, /line 59\n… \[40 more lines\]$/);
});

test('feed and record agree: every command and write the record lists is in the feed, with the same status', () => {
  const s = state();
  const rec = new RunRecorder(s, { role: 'worker', model: 'm', cwd: CWD }, at());
  const f = new RunFeed(s, { run: rec.id, issue: 7, role: 'worker', model: 'm', cwd: CWD });
  for (const l of SESSION) {
    rec.line(l);
    f.line(l);
  }
  rec.finish({ reason: 'succeeded', costUsd: 0.5, turns: 4, model: 'm' });
  f.end({ reason: 'succeeded', costUsd: 0.5, turns: 4 });
  const record = readRun(s, rec.id)!;
  const items = readFeed(s, rec.id)!.items;
  const calls = items.filter((i) => i.kind === 'tool' && i.tool !== 'Read') as { id: string; tool: string; input: string }[];
  const results = new Map((items.filter((i) => i.kind === 'tool_result') as { id: string; status: string }[]).map((r) => [r.id, r.status]));
  assert.deepEqual(record.steps.map((st) => [st.tool, st.status]), calls.map((c) => [c.tool, results.get(c.id)]));
  assert.deepEqual(record.files, (items.filter((i) => i.kind === 'diff') as { file: string }[]).map((d) => d.file));
  assert.equal(record.reason, (items.at(-1) as { reason: string }).reason);
  assert.ok(record.steps.every((st) => !JSON.stringify(st).includes(TOKEN)), 'both redacted');
});

test('diffs for each write tool', () => {
  assert.equal(writeDiff('Write', { content: 'a\nb\n' }, 'f'), '--- a/f\n+++ b/f\n+a\n+b');
  assert.equal(writeDiff('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: '' }] }, 'f'), '--- a/f\n+++ b/f\n@@\n-x\n+y\n@@\n-p');
});

test('readFeed: only after a seq; never a path outside the runs dir', () => {
  const s = state();
  const f = new RunFeed(s, { run: 'r6', issue: null, role: 'worker', model: 'm', cwd: CWD });
  f.line(SESSION[0]);
  assert.deepEqual(readFeed(s, 'r6', 1)!.items.map((i) => i.seq), [2]);
  assert.equal(readFeed(s, 'r6')!.ended, false, 'still live');
  assert.equal(readFeed(s, '../../etc/passwd'), null);
  assert.equal(readFeed(s, 'no-such-run'), null);
});

// ---- the console library

function live(s: string) {
  writeLive(s, [{ run: 'run-1', issue: 7, role: 'worker', model: 'm', startedAt: '2026-10-10T12:00:00Z', pending: [] }]);
}

test('console: only the owner may message, stop, or read a live feed', () => {
  const s = state();
  live(s);
  for (const call of [() => sendMessage({ stateDir: s, cfg, run: 'run-1', text: 'hi', by: 'someone' }), () => stopRun({ stateDir: s, cfg, run: 'run-1', by: 'someone' }), () => runFeed({ stateDir: s, cfg, run: 'run-1', by: '' })]) {
    assert.throws(call, (e: Error) => e instanceof ConsoleError && /only the owner/.test(e.message));
  }
  assert.deepEqual(takeRequests(s), [], 'nothing was requested');
});

test('console: a message is checked (live run, not empty, bounded) and handed to the coordinator as a request', () => {
  const s = state();
  live(s);
  assert.throws(() => sendMessage({ stateDir: s, cfg, run: 'run-1', text: '   ', by: owner }), /empty/);
  assert.throws(() => sendMessage({ stateDir: s, cfg, run: 'run-1', text: 'x'.repeat(MAX_MESSAGE + 1), by: owner }), /over 4000/);
  assert.throws(() => sendMessage({ stateDir: s, cfg, run: 'run-2', text: 'hi', by: owner }), /isn't live/);
  assert.throws(() => sendMessage({ stateDir: s, cfg, run: '../x', text: 'hi', by: owner }), /not a run id/);
  const { id } = sendMessage({ stateDir: s, cfg, run: 'run-1', text: '  use the cents helper  ', by: owner, now: at() });
  stopRun({ stateDir: s, cfg, run: 'run-1', by: owner, now: new Date('2026-10-10T12:00:01Z') });
  const reqs = takeRequests(s);
  assert.deepEqual(reqs.map((r) => [r.kind, r.run, r.by, 'text' in r ? r.text : null]), [['message', 'run-1', owner, 'use the cents helper'], ['stop', 'run-1', owner, null]]);
  assert.equal(reqs[0]!.id, id);
  assert.deepEqual(takeRequests(s), [], 'each request is taken once');
});

test('console: a malformed request file is dropped, not acted on', () => {
  const s = state();
  mkdirSync(join(s, 'console', 'requests'), { recursive: true });
  writeFileSync(join(s, 'console', 'requests', 'a.json'), '{ nope');
  writeFileSync(join(s, 'console', 'requests', 'b.json'), JSON.stringify({ v: 1, id: 'b', kind: 'rm -rf', run: 'r', by: owner }));
  assert.deepEqual(takeRequests(s), []);
  assert.deepEqual(readdirSync(join(s, 'console', 'requests')), []);
});

test('console: the live list round-trips; none written means none live', () => {
  const s = state();
  assert.deepEqual(liveRuns(s), []);
  live(s);
  assert.deepEqual(liveRuns(s).map((r) => r.run), ['run-1']);
  assert.ok(existsSync(join(s, 'console', 'live.json')));
});

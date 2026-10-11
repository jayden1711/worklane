import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFeed } from '../src/run-feed.js';
import { readRun } from '../src/run-record.js';
import { cliArgs, CliRunner, type RunControl, type RunRequest } from '../src/runner.js';

const posixOnly = process.platform === 'win32' && 'POSIX stand-in for claude';

/**
 * A stand-in claude on stream-json input: for each user message on stdin it logs the message (with the time),
 * answers after `holdMs` with an assistant text and a result, and keeps reading; it exits when stdin ends.
 */
function standIn(holdMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const log = (o) => fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'got.jsonl'), JSON.stringify(o) + '\\n');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
log({ argv: process.argv.slice(2) });
let buf = '', turn = 0, busy = Promise.resolve();
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    log({ at: Date.now(), message: m });
    busy = busy.then(() => new Promise((r) => setTimeout(() => {
      turn++;
      say({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer ' + turn }] } });
      say({ type: 'result', subtype: 'success', is_error: false, result: 'answer ' + turn, num_turns: turn, total_cost_usd: 0.01 * turn });
      log({ at: Date.now(), result: turn });
      r();
    }, ${holdMs})));
  }
});
process.stdin.on('end', () => busy.then(() => { log({ at: Date.now(), eof: true }); process.exit(0); }));
`,
  );
  chmodSync(bin, 0o755);
  const got = () => readFileSync(join(dir, 'got.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { at?: number; message?: { type: string; message: { content: string } }; result?: number; eof?: boolean; argv?: string[] });
  return { dir, bin, got };
}

const req = (cwd: string, stateDir: string, over: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'Fix the totals.', cwd, stateDir, model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, ...over });
const runner = (bin: string, dir: string) => new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(dir, 'cfg') }, bin);

test('the session reads stream-json input: the prompt is the first user message', () => {
  assert.ok(cliArgs({ role: 'w', prompt: 'p', cwd: '.', model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1 }).join(' ').includes('--input-format stream-json --output-format stream-json'));
});

test('without console messages the input closes at the first result and the run ends as before', { skip: posixOnly }, async () => {
  const s = standIn(50);
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const r = await runner(s.bin, s.dir).run(req(s.dir, state));
  assert.equal(r.reason, 'succeeded');
  assert.equal(r.detail, 'answer 1');
  const got = s.got();
  assert.deepEqual(got.filter((g) => g.message).map((g) => g.message), [{ type: 'user', message: { role: 'user', content: 'Fix the totals.' } }]);
  assert.ok(got.some((g) => g.eof), 'input closed');
});

test('a console message sent mid-turn is held until the turn ends, then delivered as the next turn', { skip: posixOnly }, async () => {
  const s = standIn(600);
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const states: string[] = [];
  const h: { c?: RunControl } = {};
  const run = runner(s.bin, s.dir).run(req(s.dir, state, { onControl: (c) => (h.c = c), onMessage: (m) => states.push(`${m.id}:${m.state}`) }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(h.c, 'the handle is given once the session is up');
  assert.deepEqual(h.c!.send('m1', 'Also update the docs.'), { queued: true });
  assert.deepEqual(states, ['m1:queued'], 'pending until the turn ends');
  const r = await run;
  assert.equal(r.reason, 'succeeded');
  assert.equal(r.detail, 'answer 2', 'the last turn is the run result');
  assert.deepEqual(states, ['m1:queued', 'm1:delivered']);
  const got = s.got();
  const firstResult = got.find((g) => g.result === 1)!.at!;
  const second = got.filter((g) => g.message)[1]!;
  assert.equal(second.message!.message.content, 'Also update the docs.');
  assert.ok(second.at! >= firstResult, 'it reached claude only after the first turn ended');
  assert.deepEqual(h.c!.send('m2', 'late'), { queued: false, why: 'the run is finishing; its input is closed' });
  // The live feed shows the message's progress and ends with the run, under the record's id.
  const id = h.c!.runId!;
  const feed = readFeed(state, id)!;
  assert.equal(feed.ended, true);
  assert.deepEqual(feed.items.filter((i) => i.kind === 'message').map((i) => [(i as { id: string }).id, (i as { state: string }).state]), [['m1', 'queued'], ['m1', 'delivered']]);
  assert.equal(readRun(state, id)!.reason, 'succeeded');
});

test('stop ends the run as stopped; a message still held is dropped', { skip: posixOnly }, async () => {
  const s = standIn(5_000);
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const states: string[] = [];
  const h: { c?: RunControl } = {};
  const run = runner(s.bin, s.dir).run(req(s.dir, state, { onControl: (c) => (h.c = c), onMessage: (m) => states.push(`${m.id}:${m.state}`) }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(h.c, 'the handle is given once the session is up');
  h.c!.send('m1', 'never mind');
  h.c!.stop();
  const r = await run;
  assert.equal(r.reason, 'stopped');
  assert.deepEqual(states, ['m1:queued', 'm1:dropped']);
  const feed = readFeed(state, h.c!.runId!)!;
  assert.deepEqual([feed.ended, (feed.items.at(-1) as { reason: string }).reason], [true, 'stopped']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { writeLive } from '../src/console.js';
import { consoleView, liveView, startDashboard } from '../src/dashboard.js';
import { startHub } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import { RunFeed } from '../src/run-feed.js';
import { exampleProject } from './helpers.js';

const RUN = '2026-01-01T00-00-00-000Z-worker-abc123';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-live-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  const log = new EventLog(eventsDb);
  writeLive(dir, [{ run: RUN, issue: 7, role: 'worker', model: 'sonnet', startedAt: new Date().toISOString(), pending: [{ id: 'm1', text: 'also update the README', by: 'example-owner', at: new Date().toISOString() }] }]);
  const feed = new RunFeed(dir, { run: RUN, issue: 7, role: 'worker', model: 'sonnet', cwd: join(dir, 'wt') });
  feed.line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'the total rounds down' }, { type: 'text', text: 'Looking at the totals.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
  feed.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'not ok 3 - rounds to the cent' }] } });
  log.append('console.message_queued', { run: RUN, issue: 7, role: 'worker', id: 'm1', by: 'example-owner', text: 'also update the README' }, 'c');
  return { dir, root, cfg, eventsDb, log, feed };
}

async function serve(s: ReturnType<typeof setup>, user = 'example-owner') {
  const d = await startDashboard({ root: s.root, cfg: s.cfg, eventsDb: s.eventsDb, stateDir: s.dir, user, slotsDir: join(s.dir, 'slots'), pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
  return { d, base, h };
}

/** Read an SSE stream until `until` is in it (or it ends). */
async function readStream(res: Response, until: string, ms = 5000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let got = '';
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += dec.decode(value);
      if (got.includes(until)) break;
    }
  })();
  await Promise.race([read, new Promise((_, rej) => setTimeout(() => rej(new Error(`no "${until}" within ${ms} ms:\n${got}`)), ms))]);
  await reader.cancel().catch(() => {});
  return got;
}

test('the live runs and a run\'s console: held messages, its events, and who may control it', () => {
  const s = setup();
  const mine = liveView({ stateDir: s.dir, cfg: s.cfg, user: 'example-owner' });
  assert.equal(mine.canControl, true);
  assert.deepEqual(mine.runs.map((r) => [r.run, r.issue, r.role, r.pending[0]!.text]), [[RUN, 7, 'worker', 'also update the README']]);
  const theirs = liveView({ stateDir: s.dir, cfg: s.cfg, user: 'example-collaborator' });
  assert.equal(theirs.canControl, false);
  assert.equal(theirs.runs[0]!.pending[0]!.text, '', 'held messages\' text is the owner\'s');
  const c = consoleView({ stateDir: s.dir, cfg: s.cfg, user: 'example-owner', eventsDb: s.eventsDb }, RUN);
  assert.equal(c.live, true);
  assert.deepEqual(c.held.map((h) => [h.id, h.text]), [['m1', 'also update the README']], 'queued, not yet delivered');
  s.log.append('console.message_delivered', { run: RUN, issue: 7, role: 'worker', id: 'm1' }, 'c');
  assert.deepEqual(consoleView({ stateDir: s.dir, cfg: s.cfg, user: 'example-owner', eventsDb: s.eventsDb }, RUN).held, [], 'delivered: no longer held');
  assert.equal(consoleView({ stateDir: s.dir, cfg: s.cfg, user: 'example-collaborator', eventsDb: s.eventsDb }, RUN).events.every((e) => e.text === null), true);
});

test('the owner follows a run over SSE: every feed item in order, live as it grows, then the end; others are refused', async () => {
  const s = setup();
  const x = await serve(s);
  try {
    assert.equal((await fetch(`${x.base}/api/runs/${RUN}/live`)).status, 401);
    const feed = (await (await fetch(`${x.base}/api/runs/${RUN}/feed?after=-1`, { headers: x.h })).json()) as { items: { seq: number; kind: string }[]; ended: boolean };
    assert.deepEqual(feed.items.map((i) => i.kind), ['start', 'thinking', 'text', 'tool', 'tool_result']);
    assert.equal(feed.ended, false);
    const stream = await fetch(`${x.base}/api/runs/${RUN}/live?t=${x.d.token}`);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    // The run writes more while it's watched, then ends.
    setTimeout(() => {
      s.feed.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: join(s.dir, 'wt', 'src', 'totals.js'), old_string: 'floor', new_string: 'round' } }] } });
      s.feed.end({ reason: 'succeeded', costUsd: 0.3, turns: 4 });
    }, 150);
    const got = await readStream(stream, 'event: end');
    const items = [...got.matchAll(/id: (\d+)\nevent: item\ndata: (.*)\n/g)].map((m) => [Number(m[1]), (JSON.parse(m[2]!) as { kind: string }).kind]);
    assert.deepEqual(items.map(([seq]) => seq), items.map((_, i) => i), 'every item once, in order, no gaps');
    assert.deepEqual(items.map(([, k]) => k), ['start', 'thinking', 'text', 'tool', 'tool_result', 'tool', 'diff', 'end']);
    assert.match(got, /"file":"src\/totals\.js"[\s\S]*-floor[\s\S]*\+round/, 'the diff as it was written');
    // Resuming from an id gives only what came after it.
    const resumed = await readStream(await fetch(`${x.base}/api/runs/${RUN}/live?t=${x.d.token}`, { headers: { 'last-event-id': '5' } }), 'event: end');
    assert.deepEqual([...resumed.matchAll(/id: (\d+)\n/g)].map((m) => Number(m[1])), [6, 7]);
    assert.equal((await fetch(`${x.base}/api/runs/nope/feed`, { headers: x.h })).status, 404);
    assert.equal((await fetch(`${x.base}/api/runs/..%2Fx/feed`, { headers: x.h })).status, 404);
  } finally {
    await x.d.close();
  }
  const other = await serve(s, 'example-collaborator');
  try {
    const r = await fetch(`${other.base}/api/runs/${RUN}/live?t=${other.d.token}`);
    assert.equal(r.status, 403, 'the live view is the owner\'s');
    assert.match(((await r.json()) as { error: string }).error, /only the owner/);
  } finally {
    await other.d.close();
  }
});

test('the owner messages and stops a live run through the console; a non-owner, an empty message or a run that isn\'t live is refused', async () => {
  const s = setup();
  const x = await serve(s);
  const requests = () => (existsSync(join(s.dir, 'console', 'requests')) ? readdirSync(join(s.dir, 'console', 'requests')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(s.dir, 'console', 'requests', f), 'utf8')) as { kind: string; text?: string; by: string }) : []);
  try {
    const post = (what: string, body: object) => fetch(`${x.base}/api/runs/${RUN}/${what}`, { method: 'POST', headers: x.h, body: JSON.stringify(body) });
    assert.equal((await post('message', { text: 'use the new rounding helper' })).status, 200);
    assert.equal((await post('stop', {})).status, 200);
    assert.deepEqual(requests().map((r) => [r.kind, r.text ?? null, r.by]).sort(), [['message', 'use the new rounding helper', 'example-owner'], ['stop', null, 'example-owner']], 'requests for the coordinator, from the owner');
    const empty = await post('message', { text: '   ' });
    assert.equal(empty.status, 400);
    assert.match(((await empty.json()) as { error: string }).error, /empty/);
    const gone = await fetch(`${x.base}/api/runs/2026-not-live/stop`, { method: 'POST', headers: x.h, body: '{}' });
    assert.equal(gone.status, 404);
  } finally {
    await x.d.close();
  }
  const other = await serve(s, 'example-collaborator');
  try {
    const r = await fetch(`${other.base}/api/runs/${RUN}/stop`, { method: 'POST', headers: other.h, body: '{}' });
    assert.equal(r.status, 403);
    assert.equal(requests().length, 2, 'nothing more requested');
  } finally {
    await other.d.close();
  }
});

test('through the hub, the live stream reaches the browser from the instance\'s own server', async () => {
  const s = setup();
  const x = await serve(s);
  const h = await startHub({ instances: [{ name: 'shop', port: Number(new URL(x.d.url).port), tokenFile: join(s.dir, 'dashboard-token') }], stateDir: mkdtempSync(join(tmpdir(), 'dash-live-hub-')) });
  try {
    setTimeout(() => s.feed.end({ reason: 'stopped', costUsd: 0.1, turns: 1 }), 100);
    const got = await readStream(await fetch(`${h.url.split('/?')[0]}/api/i/shop/runs/${RUN}/live?t=${h.token}`), 'event: end');
    assert.match(got, /"kind":"end","reason":"stopped"/);
  } finally {
    await h.close();
    await x.d.close();
  }
});

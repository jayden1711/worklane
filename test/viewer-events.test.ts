// What a viewer (read on the instance's repo) gets of the event log and the settings: an allowlist of event
// types and fields on /api/events, the Activity feed and the live stream; the project part of /api/settings.
// Writers and the owner get everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { EventSchemas, type StoredEvent } from '../src/events/types.js';
import { forViewer, stateForViewer, VIEWER_EVENTS } from '../src/viewer-events.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const seen = { issue: 1, title: 'Fix rounding', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' };
const asked = { id: 'd-1', kind: 'question' as const, issue: 1, owner: 'example-owner', question: 'Which rounding?', options: ['up', 'down'], recommendation: 'up', receipts: ['run 2026-x: secret-ish receipt'] };

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-events-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  log.append('issue.seen', seen, 'c');
  log.append('research.searched', { issue: 1, run: 'r-1', query: 'what the agent searched for' }, 'c');
  log.append('run.cost', { issue: 1, role: 'worker', model: 'sonnet', usd: 1.25, turns: 3 }, 'c');
  log.append('decision.asked', asked, 'c');
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  const get = async <T>(path: string, who: string) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).json() as Promise<T>;
  const status = async (path: string, who: string) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).status;
  return { d, log, base, get, status };
}

type Ev = { type: string; payload: Record<string, unknown> };

test('a viewer gets only the allowlisted events and fields on /api/events and in Activity; a writer and the owner get everything', async () => {
  const s = await serve();
  try {
    for (const path of ['/api/events', '/api/events?issue=1']) {
      const v = await s.get<Ev[]>(path, 'someone-else');
      assert.deepEqual(v.map((e) => e.type), ['issue.seen', 'decision.asked'], `${path}: no run or cost events for a viewer`);
      assert.deepEqual(Object.keys(v[1]!.payload).sort(), ['id', 'issue', 'kind', 'options', 'owner', 'question', 'recommendation'], 'only the allowlisted fields (no receipts)');
      for (const who of ['example-collaborator', 'example-owner']) {
        const full = await s.get<Ev[]>(path, who);
        assert.deepEqual(full.map((e) => e.type), ['issue.seen', 'research.searched', 'run.cost', 'decision.asked'], `${path}: everything for ${who}`);
        assert.deepEqual(full[3]!.payload.receipts, asked.receipts);
      }
    }
    const activity = async (who: string) => ((await s.get<{ activity: { type: string; summary: string }[] }>('/api/state', who)).activity);
    const va = await activity('someone-else');
    assert.deepEqual(va.map((a) => a.type), ['decision.asked', 'issue.seen'], "the viewer's Activity feed has the same allowlist");
    assert.ok(!va.some((a) => /cost|\$/.test(a.summary)), 'no costs');
    assert.ok((await activity('example-collaborator')).some((a) => a.type === 'run.cost'), 'a writer sees the costs');
  } finally {
    await s.d.close();
  }
});

test('a viewer gets the project part of /api/settings only; a writer and the owner get it all', async () => {
  const s = await serve();
  try {
    const v = await s.get<Record<string, unknown>>('/api/settings', 'someone-else');
    assert.deepEqual(Object.keys(v).sort(), ['configDir', 'forViewer', 'owners', 'project', 'reports']);
    for (const who of ['example-collaborator', 'example-owner']) {
      const full = await s.get<Record<string, unknown>>('/api/settings', who);
      assert.equal(full.forViewer, undefined);
      for (const k of ['agents', 'tests', 'guardrails', 'governor']) assert.ok(k in full, `${who} gets ${k}`);
    }
  } finally {
    await s.d.close();
  }
});

/** Collect a live stream's change events for `ms`. */
async function changes(base: string, token: string, who: string, during: () => void, ms = 700) {
  const res = await fetch(`${base}/api/stream?t=${token}`, { headers: asPerson(who) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let got = '';
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += dec.decode(value);
    }
  })().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  during();
  await new Promise((r) => setTimeout(r, ms));
  await reader.cancel().catch(() => {});
  await read;
  return [...got.matchAll(/event: change\ndata: (.+)\n/g)].map((m) => (JSON.parse(m[1]!) as { types: string[] }).types);
}

test('the live stream tells a viewer only of the event types it may see; a writer of all of them', async () => {
  const s = await serve();
  try {
    const hidden = () => s.log.append('run.cost', { issue: 1, role: 'evaluator', model: 'opus', usd: 0.5, turns: 1 }, 'c');
    assert.deepEqual(await changes(s.base, s.d.token, 'someone-else', hidden), [], 'a run cost is not even announced to a viewer');
    assert.deepEqual((await changes(s.base, s.d.token, 'example-collaborator', hidden)).flat(), ['run.cost'], 'a writer hears of it');
    const shown = () => {
      s.log.append('run.cost', { issue: 1, role: 'worker', model: 'sonnet', usd: 0.2, turns: 1 }, 'c');
      s.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L1', reasons: [] }, 'c');
    };
    assert.deepEqual((await changes(s.base, s.d.token, 'someone-else', shown)).flat(), ['review.level_set'], 'only the allowed type is named');
  } finally {
    await s.d.close();
  }
});

test('an event type not on the allowlist is hidden from viewers: every schema type off the list, and one added later', () => {
  const ev = (type: string, payload: Record<string, unknown>): StoredEvent => ({ id: 1, ts: '2026-10-12T00:00:00Z', type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
  for (const type of Object.keys(EventSchemas)) {
    if (!(type in VIEWER_EVENTS)) assert.equal(forViewer(ev(type, { issue: 1, text: 'x' })), null, `${type} is hidden`);
  }
  assert.equal(forViewer(ev('future.thing', { issue: 1, prompt: 'the whole prompt' })), null, 'a type added later is hidden until someone allows it');
  for (const t of ['run.started', 'run.finished', 'run.cost', 'research.fetched', 'chat.turn', 'console.message_queued', 'change.proposed']) assert.ok(!(t in VIEWER_EVENTS), `${t} is never a viewer's`);
  const kept = forViewer(ev('issue.seen', { ...seen, secret: 'not on the list' }))!;
  assert.deepEqual(Object.keys(kept.payload as object).sort(), ['actionable', 'author', 'issue', 'labels', 'owner', 'title', 'why'], 'a field added later is dropped too');
});

test('the service log and the machine settings are the writers\' and the owner\'s: a viewer gets 403, and the state tells the page', async () => {
  const s = await serve();
  try {
    for (const path of ['/api/logs', '/api/machine']) {
      assert.equal(await s.status(path, 'someone-else'), 403, `a viewer is refused ${path}`);
      for (const who of ['example-collaborator', 'example-owner']) assert.equal(await s.status(path, who), 200, `${who} reads ${path}`);
    }
    const flags = async (who: string) => s.get<{ canReadLogs: boolean; canReadMachine: boolean }>('/api/state', who);
    assert.deepEqual(await flags('someone-else'), { ...(await flags('someone-else')), canReadLogs: false, canReadMachine: false });
    const w = await flags('example-collaborator');
    assert.deepEqual([w.canReadLogs, w.canReadMachine], [true, true]);
  } finally {
    await s.d.close();
  }
});

test('a viewer\'s state has no costs, spend, budget or agent runs; a writer\'s and the owner\'s have them', async () => {
  const s = await serve();
  try {
    type St = Record<string, unknown> & { tasks: Record<string, unknown>[] };
    const v = await s.get<St>('/api/state', 'someone-else');
    for (const k of ['budget', 'spendToday', 'spendByRole', 'runs']) assert.ok(!(k in v), `no ${k} for a viewer`);
    assert.ok(v.tasks.length && v.tasks.every((t) => !('costUsd' in t)), "no task's cost");
    assert.equal(v.tasks[0]!.title, 'Fix rounding', 'the task itself is still there');
    assert.ok(!JSON.stringify(v).includes('1.25'), 'the run cost appears nowhere');
    for (const who of ['example-collaborator', 'example-owner']) {
      const full = await s.get<St>('/api/state', who);
      for (const k of ['budget', 'spendToday', 'spendByRole', 'runs']) assert.ok(k in full, `${who} has ${k}`);
      assert.equal(full.tasks[0]!.costUsd, 1.25);
    }
    // The health view's usage per day: the runs, never their estimated cost, for a viewer.
    type H = { usage: { days: Record<string, unknown>[] } };
    const vh = await s.get<H>('/api/health', 'someone-else');
    assert.ok(vh.usage.days.length && vh.usage.days.every((d) => !('estimatedUsd' in d) && typeof d.runs === 'number'));
    for (const who of ['example-collaborator', 'example-owner']) assert.equal((await s.get<H>('/api/health', who)).usage.days[0]!.estimatedUsd, 1.25);
  } finally {
    await s.d.close();
  }
});

test('a state key or task field added later is hidden from viewers until allowed', () => {
  const st = stateForViewer({ project: { name: 'x' }, futureSecret: 'hidden', runs: { active: [], recent: [] }, tasks: [{ issue: 1, title: 't', costUsd: 2, futureField: 'hidden' }], inbox: { decisions: [], blocked: [{ issue: 1, costUsd: 2 }], notify: [] } });
  assert.deepEqual(st, { project: { name: 'x' }, tasks: [{ issue: 1, title: 't' }], inbox: { decisions: [], blocked: [{ issue: 1 }], notify: [] } });
});

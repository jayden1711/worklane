import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeChatAnswer, type ChatAnswer } from '../src/chat.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { Backlog } from '../src/backlog/types.js';
import { exampleProject } from './helpers.js';

const BODY = 'Totals floor instead of rounding.\n\n```done_when\n- test: test/totals.test.js\n```\n';

function answer(extra: Partial<ChatAnswer> = {}): ChatAnswer {
  return {
    turn: 't1',
    instance: 'shop',
    answer: 'Issue #3 is waiting on your decision; the worker run failed its tests twice.',
    citations: [{ kind: 'issue', id: '3', instance: 'shop', label: 'issue #3', href: 'https://github.com/example-org/example-shop/issues/3' }],
    unknownCitations: [],
    issueDraft: { ok: true, title: 'Round totals to the cent', body: BODY, labels: ['ready'] },
    actions: [{ kind: 'settings', key: 'workers', value: 2, confirm: 'settings.change', why: 'two tasks wait' }],
    refusedActions: [],
    readOnly: false,
    costUsd: 0.12,
    ...extra,
  };
}

async function setup(user = 'example-owner', create: () => Promise<number> = async () => 57) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-chat-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const filed: { title: string; body: string; labels: string[] }[] = [];
  const backlog = {
    createIssue: async (title: string, body: string, labels: string[]) => {
      const n = await create();
      filed.push({ title, body, labels });
      return n;
    },
  } as unknown as Backlog;
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: dir, user, slotsDir: join(dir, 'slots'), backlog: () => backlog });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
  const ask = (question: string) => fetch(`${base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ question }) });
  const get = async (id: string) => (await fetch(`${base}/api/chat/${id}`, { headers: h })).json() as Promise<Record<string, unknown> & { state: string; answer?: ChatAnswer; owner: boolean; filed: { number: number } | null }>;
  const file = (id: string) => fetch(`${base}/api/chat/${id}/file-issue`, { method: 'POST', headers: h, body: '{}' });
  return { dir, d, base, h, ask, get, file, filed };
}

test('a question becomes a request the coordinator answers; the answer is polled until it is in', async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.base}/api/chat`, { method: 'POST', body: '{}' })).status, 401);
    const empty = await s.ask('   ');
    assert.equal(empty.status, 400);
    assert.match(((await empty.json()) as { error: string }).error, /empty/);
    const r = await s.ask('Why is issue 3 stuck?');
    assert.equal(r.status, 200);
    const { id } = (await r.json()) as { id: string };
    const request = JSON.parse(readFileSync(join(s.dir, 'chat', 'requests', `${id}.json`), 'utf8')) as { by: string; question: string };
    assert.deepEqual([request.by, request.question], ['example-owner', 'Why is issue 3 stuck?'], 'a request for the coordinator, from this dashboard\'s user');
    assert.equal((await s.get(id)).state, 'pending');
    writeChatAnswer(s.dir, id, { answer: answer() });
    const a = await s.get(id);
    assert.equal(a.state, 'answered');
    assert.equal(a.owner, true);
    assert.equal(a.answer!.issueDraft?.ok, true);
    assert.equal(a.answer!.actions.length, 1);
    assert.equal((await fetch(`${s.base}/api/chat/1-zz`, { headers: s.h })).status, 404);
    assert.equal((await fetch(`${s.base}/api/chat/999-abc`, { headers: s.h })).status, 404);
  } finally {
    await s.d.close();
  }
});

test('the owner files a draft once, through the instance\'s backlog with ready, re-validated from the stored answer', async () => {
  const s = await setup();
  try {
    const { id } = (await (await s.ask('File the rounding bug')).json()) as { id: string };
    writeChatAnswer(s.dir, id, { answer: answer() });
    const r = await s.file(id);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, number: 57 });
    assert.deepEqual(s.filed, [{ title: 'Round totals to the cent', body: BODY, labels: ['ready'] }]);
    assert.deepEqual((await s.get(id)).filed?.number, 57, 'the answer says it was filed');
    const again = await s.file(id);
    assert.equal(again.status, 409, 'never twice');
    assert.equal(s.filed.length, 1);
    // An answer file claiming a draft is fine when parseContract says it isn't: checked again, refused, not filed.
    const { id: bad } = (await (await s.ask('another')).json()) as { id: string };
    writeChatAnswer(s.dir, bad, { answer: answer({ issueDraft: { ok: true, title: 'No contract', body: 'just prose, no done_when', labels: ['ready'] } }) });
    const refused = await s.file(bad);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /isn't one the harness can take/);
    const { id: none } = (await (await s.ask('no draft')).json()) as { id: string };
    writeChatAnswer(s.dir, none, { answer: answer({ issueDraft: null }) });
    assert.equal((await s.file(none)).status, 400);
    assert.equal(s.filed.length, 1);
  } finally {
    await s.d.close();
  }
});

test('anyone but the owner gets the answer read-only: no draft, no proposals, and can\'t file', async () => {
  const s = await setup('example-collaborator');
  try {
    const { id } = (await (await s.ask('What is running?')).json()) as { id: string };
    writeChatAnswer(s.dir, id, { answer: answer() });
    const a = await s.get(id);
    assert.equal(a.owner, false);
    assert.equal(a.answer!.answer, answer().answer, 'the answer itself');
    assert.deepEqual(a.answer!.citations, answer().citations, 'and its citations');
    assert.equal(a.answer!.issueDraft, null);
    assert.deepEqual(a.answer!.actions, []);
    assert.equal(a.answer!.readOnly, true);
    const r = await s.file(id);
    assert.equal(r.status, 403);
    assert.equal(s.filed.length, 0);
    assert.equal(existsSync(join(s.dir, 'chat', 'filed')), false);
  } finally {
    await s.d.close();
  }
});

test('two confirms at once file the draft once; a filing that fails can be confirmed again', async () => {
  let fail = true;
  const s = await setup('example-owner', async () => {
    await new Promise((r) => setTimeout(r, 50));
    if (fail) throw new Error('the backlog said no');
    return 58;
  });
  try {
    const { id } = (await (await s.ask('File it')).json()) as { id: string };
    writeChatAnswer(s.dir, id, { answer: answer() });
    assert.notEqual((await s.file(id)).status, 200, 'the backlog failed');
    assert.equal((await s.get(id)).filed, null, 'and the draft is not marked filed');
    fail = false;
    const both = await Promise.all([s.file(id), s.file(id)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(s.filed.length, 1);
    assert.equal((await s.get(id)).filed?.number, 58);
  } finally {
    await s.d.close();
  }
});

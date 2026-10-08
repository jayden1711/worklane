import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { inbox, project } from '../src/projection.js';
import { exampleProject } from './helpers.js';

const seen = (issue: number, title = 't', author = 'example-owner') => ({ issue, title, labels: ['ready'], author, owner: null, actionable: true, why: 'opened by writer' });

function logWith() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  const log = new EventLog(join(dir, 'events.db'));
  return { dir, log, db: join(dir, 'events.db') };
}

test('projection: status follows the pipeline, cost and verdict accumulate, nothing is stored', () => {
  const { log } = logWith();
  log.append('issue.seen', seen(1, 'Fix totals'), 'c');
  log.append('issue.claimed', { issue: 1, instance: 'alice@box', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'example-owner' }, 'c');
  log.append('run.started', { issue: 1, role: 'worker', model: 'sonnet', worktree: '/w', pid: 1, pgid: 1, attempt: 1 }, 'c');
  log.append('run.cost', { issue: 1, role: 'worker', model: 'claude-sonnet', usd: 0.5, turns: 3 }, 'c');
  let t = project(log.read()).tasks[0]!;
  assert.equal(t.status, 'building');
  assert.deepEqual(t.delegate, { instance: 'alice@box', role: 'worker' });
  log.append('change.proposed', { issue: 1, branch: 'b', base: 'b'.repeat(40), head: 'c'.repeat(40), files: ['src/a.js'], lines: 3, patch_hash: 'h' }, 'c');
  log.append('eval.verdict', { issue: 1, head: 'c'.repeat(40), patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '' }, 'c');
  log.append('review.level_set', { issue: 1, head: 'c'.repeat(40), level: 'L3', reasons: ['money-path: src/a.js'] }, 'c');
  log.append('decision.asked', { id: 'd-1', kind: 'land', issue: 1, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'c');
  const p = project(log.read());
  t = p.tasks[0]!;
  assert.equal(t.status, 'awaiting_decision');
  assert.equal(t.level, 'L3');
  assert.equal(t.verdict?.confidence, 'high');
  assert.equal(t.costUsd, 0.5);
  assert.equal(inbox(p, 'example-owner').decisions.length, 1, 'the owner sees it in their inbox');
  assert.equal(inbox(p, 'someone-else').decisions.length, 0);
  log.append('decision.answered', { id: 'd-1', by: 'example-owner', answer: 'approve' }, 'h', 'human');
  log.append('land.queued', { issue: 1, head: 'c'.repeat(40), level: 'L3' }, 'c');
  log.append('land.result', { issue: 1, outcome: 'landed', landed: 'd'.repeat(40), detail: '' }, 'c');
  log.append('deploy.verified', { env: 'staging', sha: 'd'.repeat(40) }, 'c');
  log.append('issue.released', { issue: 1, instance: 'alice@box', why: 'landed' }, 'c');
  t = project(log.read()).tasks[0]!;
  assert.equal(t.status, 'done');
  assert.equal(t.deployed, 'staging');
  assert.equal(t.delegate, null);
});

test('projection: blocked is explicit and wins over release; a later claim clears it', () => {
  const { log } = logWith();
  log.append('issue.seen', seen(2), 'c');
  log.append('issue.claimed', { issue: 2, instance: 'a', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'example-owner' }, 'c');
  log.append('issue.blocked', { issue: 2, owner: 'example-owner', why: 'no passing change after 3 attempts' }, 'c');
  log.append('issue.released', { issue: 2, instance: 'a', why: 'no passing change after 3 attempts' }, 'c');
  let p = project(log.read());
  assert.equal(p.tasks[0]!.status, 'blocked');
  assert.equal(inbox(p, 'example-owner').blocked.length, 1);
  log.append('issue.claimed', { issue: 2, instance: 'a', lease: 'e'.repeat(40), base: 'b'.repeat(40), owner: 'example-owner' }, 'c');
  p = project(log.read());
  assert.equal(p.tasks[0]!.status, 'claimed');
  assert.equal(p.tasks[0]!.blockedReason, null);
});

async function server(withWeb = true) {
  const { dir, log, db } = logWith();
  const { dir: root } = exampleProject();
  const web = join(dir, 'web');
  if (withWeb) {
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>ok</title>');
  }
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: join(dir, 'state'), user: 'example-owner', webDir: web, pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  return { d, log, base, h: { authorization: `Bearer ${d.token}` } };
}

test('dashboard API needs the token, binds locally, and serves state from the log', async () => {
  const s = await server();
  try {
    assert.match(s.d.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { authorization: 'Bearer wrong-token-of-the-wrong-length-x' } })).status, 401);
    s.log.append('issue.seen', seen(5, 'From the log'), 'c');
    const st = (await (await fetch(`${s.base}/api/state`, { headers: s.h })).json()) as { tasks: { title: string }[]; user: string };
    assert.equal(st.tasks[0]!.title, 'From the log');
    assert.equal(st.user, 'example-owner');
    // Raw request: fetch would normalize "../" away before sending.
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((res, rej) => {
        const u = new URL(s.base);
        const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => res({ status: r.statusCode ?? 0, body }));
        });
        req.on('error', rej);
        req.end();
      });
    for (const path of ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/package.json', '/../../../../etc/hosts']) {
      const r = await raw(path);
      assert.ok(r.status === 403 || (r.status === 200 && r.body.includes('<title>ok')), `${path}: ${r.status}`);
      assert.doesNotMatch(r.body, /root:|localhost|"name"/, `${path} must not leak files`);
    }
    assert.match(await (await fetch(`${s.base}/issues/5`)).text(), /<title>ok/, 'client routes fall back to the app');
  } finally {
    await s.d.close();
  }
});

test('dashboard streams a change when the log grows (another process writing)', async () => {
  const s = await server();
  try {
    const res = await fetch(`${s.base}/api/stream?t=${s.d.token}`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = '';
    const read = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got += dec.decode(value);
        if (got.includes('event: change')) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    s.log.append('issue.seen', seen(9), 'c');
    await Promise.race([read, new Promise((_, rej) => setTimeout(() => rej(new Error('no change event within 5s')), 5000))]);
    assert.match(got, /event: hello[\s\S]*event: change[\s\S]*issue\.seen/);
    await reader.cancel();
  } finally {
    await s.d.close();
  }
});

test('answering a decision records a human event once, with a valid option only', async () => {
  const s = await server();
  try {
    s.log.append('decision.asked', { id: 'd-9', kind: 'land', issue: 9, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'c');
    const post = (body: object) => fetch(`${s.base}/api/decide`, { method: 'POST', headers: { ...s.h, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ id: 'd-9', answer: 'ship-it' })).status, 400);
    assert.equal((await post({ id: 'nope', answer: 'approve' })).status, 404);
    assert.equal((await post({ id: 'd-9', answer: 'approve' })).status, 200);
    assert.equal((await post({ id: 'd-9', answer: 'reject' })).status, 409, 'answered once');
    const answered = s.log.read(0, ['decision.answered']);
    assert.equal(answered.length, 1);
    assert.equal(answered[0]!.source, 'human');
    assert.deepEqual(answered[0]!.payload, { id: 'd-9', by: 'example-owner', answer: 'approve' });
  } finally {
    await s.d.close();
  }
});

test('saved views round-trip; without a built UI the server says how to build it', async () => {
  const s = await server(false);
  try {
    const views = [{ name: 'My L3s', filters: { owner: 'example-owner', level: 'L3' } }];
    assert.equal((await fetch(`${s.base}/api/views`, { method: 'PUT', headers: { ...s.h, 'content-type': 'application/json' }, body: JSON.stringify(views) })).status, 200);
    assert.deepEqual(await (await fetch(`${s.base}/api/views`, { headers: s.h })).json(), views);
    const r = await fetch(`${s.base}/`);
    assert.equal(r.status, 503);
    assert.match(await r.text(), /build:web/);
  } finally {
    await s.d.close();
  }
});

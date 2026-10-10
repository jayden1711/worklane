import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { mayAnswer, settingsView, startDashboard } from '../src/dashboard.js';
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

test('regression: a task blocked before any claim reaches its owner\'s inbox', () => {
  const { log } = logWith();
  log.append('issue.seen', { ...seen(4), owner: null }, 'c');
  log.append('issue.blocked', { issue: 4, owner: 'example-owner', why: 'investigation needs a decision' }, 'c');
  const p = project(log.read());
  assert.equal(p.tasks[0]!.owner, 'example-owner');
  assert.equal(inbox(p, 'example-owner').blocked.length, 1);
});

test('projection: agents in flight, the land queue (deferred stays queued), batches and governor', () => {
  const { log } = logWith();
  const sha = 'a'.repeat(40);
  log.append('issue.seen', seen(1, 'One'), 'c');
  log.append('issue.seen', seen(2, 'Two'), 'c');
  log.append('run.started', { issue: 1, role: 'worker', model: 'm', worktree: '/w', pid: 41, pgid: 41, attempt: 1 }, 'c');
  log.append('run.heartbeat', { issue: 1, role: 'worker', note: 'editing src/a.js' }, 'c');
  log.append('run.started', { issue: 2, role: 'worker', model: 'm', worktree: '/w2', pid: 42, pgid: 42, attempt: 1 }, 'c');
  log.append('run.finished', { issue: 2, role: 'worker', reason: 'succeeded', detail: '' }, 'c');
  log.append('run.cost', { issue: 2, role: 'worker', model: 'm', usd: 0.75, turns: 4 }, 'c');
  log.append('land.queued', { issue: 2, head: sha, level: 'L1' }, 'c');
  log.append('land.batch', { id: 'b1', issues: [2], tip: sha, outcome: 'started', detail: '' }, 'c');
  log.append('land.result', { issue: 2, outcome: 'deferred', landed: null, detail: 'full-run slot busy\nmore' }, 'c');
  log.append('land.batch', { id: 'b1', issues: [2], tip: sha, outcome: 'deferred', detail: 'slot busy' }, 'c');
  log.append('governor.hold', { reason: 'load 41 > 40', load: 41, free_disk_pct: 30 }, 'c');
  const p = project(log.read());
  assert.deepEqual(p.runs.active.map((r) => [r.issue, r.note]), [[1, 'editing src/a.js']]);
  assert.deepEqual(p.runs.recent.map((r) => [r.issue, r.reason, r.costUsd]), [[2, 'succeeded', 0.75]]);
  assert.deepEqual(p.landQueue.map((q) => [q.issue, q.title, q.deferred]), [[2, 'Two', 'full-run slot busy']]);
  assert.deepEqual(p.batches.map((b) => b.outcome), ['deferred'], 'one row per batch, latest outcome');
  assert.equal(p.governor?.held, true);
  log.append('land.result', { issue: 2, outcome: 'landed', landed: sha, detail: '' }, 'c');
  log.append('governor.release', { load: 10, free_disk_pct: 30 }, 'c');
  const q = project(log.read());
  assert.equal(q.landQueue.length, 0);
  assert.equal(q.governor?.held, false);
});

test('settings show choices, never commands, fingerprints or deploy details', () => {
  const { dir } = exampleProject();
  const cfg = loadConfig(dir);
  const shown = JSON.stringify(settingsView(cfg));
  const secrets = [
    cfg.tests.runner.full,
    cfg.tests.runner.changed,
    ...Object.values(cfg.guardrails.fingerprints ?? {}).flat().map(String),
    ...(cfg.deploy?.environments ?? []).flatMap((e) => [e.verify, e.trigger ?? '']),
    ...(cfg.tests.worktree?.setup ?? []),
  ].filter((x) => typeof x === 'string' && x.length > 6);
  assert.ok(secrets.length >= 3, 'the example config has commands to hide');
  for (const x of secrets) assert.ok(!shown.includes(x), `settings leak: ${x}`);
  assert.match(shown, /"landMode"/);
});

async function server(withWeb = true, user = 'example-owner') {
  const { dir, log, db } = logWith();
  const { dir: root } = exampleProject();
  const web = join(dir, 'web');
  if (withWeb) {
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>ok</title>');
  }
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: join(dir, 'state'), user, webDir: web, pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  return { d, log, base, h: { authorization: `Bearer ${d.token}` } };
}

test('dashboard API needs the token, binds locally, and serves state from the log', async () => {
  const s = await server();
  try {
    assert.match(s.d.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
    for (const p of ['/api/report', '/api/settings', '/api/events']) assert.equal((await fetch(`${s.base}${p}`)).status, 401, p);
    const rep = (await (await fetch(`${s.base}/api/report`, { headers: s.h })).json()) as { report: string };
    assert.match(rep.report, /report: /);
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


test('only the decision\'s owner or a writer can answer it from the dashboard', async () => {
  // The example project's writers are example-owner and example-collaborator.
  const asked = { kind: 'land' as const, issue: 9, question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] };
  const s = await server(true, 'someone-else');
  try {
    s.log.append('decision.asked', { ...asked, id: 'd-1', owner: 'example-owner' }, 'c');
    s.log.append('decision.asked', { ...asked, id: 'd-2', owner: 'someone-else' }, 'c');
    const post = (id: string) => fetch(`${s.base}/api/decide`, { method: 'POST', headers: { ...s.h, 'content-type': 'application/json' }, body: JSON.stringify({ id, answer: 'approve' }) });
    const refused = await post('d-1');
    assert.equal(refused.status, 403, 'not the owner and not a writer');
    assert.match(((await refused.json()) as { error: string }).error, /for @example-owner/);
    assert.equal(s.log.read(0, ['decision.answered']).length, 0, 'nothing recorded');
    assert.equal((await post('d-2')).status, 200, 'the owner can');
    const st = (await (await fetch(`${s.base}/api/state`, { headers: s.h })).json()) as { decisions: { id: string; canAnswer: boolean }[] };
    assert.deepEqual(Object.fromEntries(st.decisions.map((d) => [d.id, d.canAnswer])), { 'd-1': false, 'd-2': true }, 'the UI is told which it may answer');
  } finally {
    await s.d.close();
  }
  const w = await server(true, 'Example-Collaborator');
  try {
    w.log.append('decision.asked', { ...asked, id: 'd-3', owner: 'example-owner' }, 'c');
    const r = await fetch(`${w.base}/api/decide`, { method: 'POST', headers: { ...w.h, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'd-3', answer: 'reject' }) });
    assert.equal(r.status, 200, 'a writer can, whatever the case of the login');
  } finally {
    await w.d.close();
  }
  assert.equal(mayAnswer('example-owner', '', { writers: ['example-owner'] }), false, 'no user, no answer');
});

test('spend by role counts today only, like spend today; costs are labelled as estimates', async () => {
  const { log } = logWith();
  log.append('run.cost', { issue: 1, role: 'worker', model: 'm', usd: 2, turns: 1 }, 'c');
  log.append('run.cost', { issue: 1, role: 'evaluator', model: 'm', usd: 1, turns: 1 }, 'c');
  const events = log.read();
  const today = events[0]!.ts.slice(0, 10);
  const yesterday = project(events.map((e) => ({ ...e, ts: e.ts.replace(today, '2000-01-01') })), today);
  assert.equal(yesterday.spendToday, 0);
  assert.deepEqual(yesterday.spendByRole, {}, 'yesterday\'s runs are not today\'s spend by role');
  const now = project(events, today);
  assert.deepEqual(now.spendByRole, { worker: 2, evaluator: 1 });
  assert.equal(now.spendToday, 3);
  const s = await server();
  try {
    const st = (await (await fetch(`${s.base}/api/state`, { headers: s.h })).json()) as { costBasis: string };
    assert.equal(st.costBasis, 'estimate');
  } finally {
    await s.d.close();
  }
});

test('every cost the web UI shows goes through the estimate formatter', () => {
  const pages = fileURLToPath(new URL('../../web/src/', import.meta.url));
  const ui = readFileSync(join(pages, 'components', 'ui.tsx'), 'utf8');
  assert.match(ui, /export const estUsd = \(n: number\) => `~\$/, 'estimates render with a ~');
  for (const f of readdirSync(join(pages, 'pages'))) {
    const src = readFileSync(join(pages, 'pages', f), 'utf8');
    for (const m of src.matchAll(/\busd\(([^)]*)\)/g)) assert.doesNotMatch(m[1]!, /cost|spend|\bv\b/i, `${f}: ${m[0]} shows a cost without saying it's an estimate`);
  }
});

test('an issue\'s check results, newest first, with each failure\'s output; served per issue', async () => {
  const s = await server();
  try {
    const head = 'c'.repeat(40);
    s.log.append('check.result', { issue: 4, head, stage: 'verify', checks: [{ check: 'npm test', status: 'fail', exitCode: 1, tail: 'AssertionError: 2 !== 3' }, { check: 'npm run full', status: 'skipped', exitCode: null }] }, 'c');
    s.log.append('check.result', { issue: 5, head, stage: 'verify', checks: [{ check: 'other issue', status: 'pass', exitCode: 0 }] }, 'c');
    s.log.append('check.result', { issue: 4, head: 'd'.repeat(40), stage: 'verify', checks: [{ check: 'npm test', status: 'pass', exitCode: 0 }] }, 'c');
    s.log.append('issue.no_change', { issue: 4, owner: 'example-owner', base: 'e'.repeat(40), why: 'already fixed', checks: [{ check: 'npm test', status: 'pass', exitCode: 0 }] }, 'c');
    const r = await fetch(`${s.base}/api/checks?issue=4`, { headers: s.h });
    assert.equal(r.status, 200);
    const runs = (await r.json()) as { stage: string; head: string; checks: { check: string; status: string; exitCode: number | null; tail: string | null }[] }[];
    assert.deepEqual(runs.map((x) => [x.stage, x.head[0]]), [['no change', 'e'], ['verify', 'd'], ['verify', 'c']], 'newest first, this issue only');
    assert.deepEqual(runs[2]!.checks, [
      { check: 'npm test', status: 'fail', exitCode: 1, tail: 'AssertionError: 2 !== 3' },
      { check: 'npm run full', status: 'skipped', exitCode: null, tail: null },
    ]);
    assert.equal((await fetch(`${s.base}/api/checks?issue=4`)).status, 401, 'needs the token');
    assert.equal((await fetch(`${s.base}/api/checks?issue=x`, { headers: s.h })).status, 400);
  } finally {
    await s.d.close();
  }
});

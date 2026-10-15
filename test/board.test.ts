// The Board (src/board.ts, GET /api/board): one column per stage from what the coordinator recorded, each card's
// fields, the actions each role sees, and the server refusing what a role may not do from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardForViewer, boardView, checkState, columnOf, VIEWER_CARD_FIELDS, type BoardView } from '../src/board.js';
import { asks } from '../src/console/asks.js';
import { terminalRefusal } from '../src/console/terminal.js';
import { loadConfig } from '../src/config/load.js';
import { mayRequest, takeRequests, writeLive } from '../src/console.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { parseProcStat, processGroupUsage } from '../src/os/stats.js';
import { RunFeed } from '../src/run-feed.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const RUN = '2026-01-01T00-00-00-000Z-worker-board1';

/** One task per column, a running agent with a live run on #2, a question on #4, a high-risk landing on #5, a PR on #7. */
function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  const log = new EventLog(eventsDb);
  const seen = (issue: number, title: string) => log.append('issue.seen', { issue, title, labels: [], author: 'example-owner', owner: null, actionable: true, why: 'ok' }, 'c');
  const claim = (issue: number) => log.append('issue.claimed', { issue, instance: 'a', lease: A, base: A, owner: 'example-owner' }, 'c');
  seen(1, 'Plan the export');
  claim(1);
  seen(2, 'Fix the totals');
  claim(2);
  log.append('run.started', { issue: 2, role: 'worker', model: 'sonnet', worktree: '/w', pid: 4242, pgid: 4242, attempt: 1 }, 'c');
  log.append('run.heartbeat', { issue: 2, role: 'worker', note: 'editing totals.js' }, 'c');
  seen(3, 'Round the discounts');
  claim(3);
  log.append('change.proposed', { issue: 3, branch: 'x', base: A, head: B, files: ['a.js', 'b.js'], lines: 15, added: 12, removed: 3, patch_hash: 'h' }, 'c');
  log.append('check.result', { issue: 3, head: B, stage: 'verify', checks: [{ check: 'unit', status: 'pass', exitCode: 0 }, { check: 'lint', status: 'fail', exitCode: 1 }] }, 'c');
  seen(4, 'Free shipping');
  claim(4);
  log.append('decision.asked', { id: 'd-q', kind: 'question', issue: 4, owner: 'example-owner', question: 'Which threshold?', options: ['$50', '$75'], recommendation: '$50', receipts: [] }, 'c');
  seen(5, 'Orders table');
  claim(5);
  log.append('review.level_set', { issue: 5, head: B, level: 'L3', reasons: ['migrations'] }, 'c');
  log.append('decision.asked', { id: 'd-land', kind: 'land', issue: 5, owner: 'example-owner', question: 'Approve landing #5 (L3)?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'c');
  seen(6, 'Docs fix');
  claim(6);
  log.append('land.queued', { issue: 6, head: B, level: 'L1' }, 'c');
  seen(7, 'Rename the flag');
  claim(7);
  log.append('land.result', { issue: 7, outcome: 'pr_opened', landed: null, detail: '' }, 'c');
  log.append('pr.opened', { issue: 7, number: 70, url: 'https://example.test/pr/70', head: B, draft: true }, 'c');
  log.append('pr.status', { issue: 7, number: 70, head: B, ready: false, reasons: ['ci pending'], checks: [{ name: 'ci', outcome: 'pending' }, { name: 'lint', outcome: 'pass' }] }, 'c');
  log.append('pr.stats', { issue: 7, number: 70, head: B, additions: 40, deletions: 8, files: 3, comments: 5 }, 'c');
  seen(8, 'Done already');
  log.append('issue.claimed', { issue: 8, instance: 'a', lease: A, base: A, owner: 'example-owner' }, 'c');
  log.append('land.result', { issue: 8, outcome: 'landed', landed: B, detail: '' }, 'c');
  log.append('issue.released', { issue: 8, instance: 'a', why: 'landed' }, 'c');
  writeLive(dir, [{ run: RUN, issue: 2, role: 'worker', model: 'sonnet', startedAt: new Date().toISOString(), pending: [] }]);
  const feed = new RunFeed(dir, { run: RUN, issue: 2, role: 'worker', model: 'sonnet', cwd: join(dir, 'wt') });
  feed.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'SECRET-ISH reasoning about totals' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test -- totals' } }] } });
  feed.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok 1 - totals' }] } });
  return { dir, root, cfg, eventsDb, log };
}

const view = (s: ReturnType<typeof seed>, role: 'owner' | 'writer' | 'viewer') =>
  boardView({ events: s.log.read(0), instance: 'shop', role, canReadDigest: role !== 'viewer', live: [{ run: RUN, issue: 2, role: 'worker', model: 'sonnet', startedAt: '', pending: [] }], slots: { cap: 2, running: 1 }, usage: (g) => new Map(g.map((x) => [x, { rssBytes: 512e6, cpuSeconds: 90, processes: 3 }])) });
const card = (v: BoardView, issue: number) => v.cards.find((c) => c.issue === issue)!;

test('the board: a column per stage, from what the coordinator recorded; done work is off it', () => {
  const s = seed();
  const v = view(s, 'owner');
  assert.deepEqual(v.columns.map((c) => c.label), ['Planning', 'Building', 'Verifying', 'Waiting on you', 'Landing']);
  assert.deepEqual(Object.fromEntries(v.cards.map((c) => [c.issue, c.column])), { 1: 'planning', 2: 'building', 3: 'verifying', 4: 'waiting', 5: 'waiting', 6: 'landing', 7: 'verifying' });
  assert.ok(!v.cards.some((c) => c.issue === 8), 'landed and released: not on the board');
  assert.deepEqual(v.slots, { cap: 2, running: 1 });
  for (const c of v.cards) assert.equal(c.instance, 'shop');
});

test("a card's fields: diff +/− (the PR's, else the proposed change), comments, elapsed, checks, the run and its resource use", () => {
  const s = seed();
  const v = view(s, 'owner');
  assert.deepEqual(card(v, 3).diff, { added: 12, removed: 3, lines: 15, files: 2, source: 'change' });
  assert.equal(card(v, 3).comments, null, 'no PR: no comment count');
  assert.deepEqual(card(v, 3).checks, { state: 'failing', source: 'coordinator', items: [{ name: 'unit', outcome: 'pass' }, { name: 'lint', outcome: 'fail' }] });
  assert.deepEqual(card(v, 7).diff, { added: 40, removed: 8, lines: 48, files: 3, source: 'pr' });
  assert.equal(card(v, 7).comments, 5);
  assert.deepEqual(card(v, 7).pr, { number: 70, url: 'https://example.test/pr/70', phase: 'checks' });
  assert.equal(card(v, 7).checks.state, 'pending');
  assert.equal(card(v, 7).checks.source, 'pr');
  const run = card(v, 2).run!;
  assert.equal(run.role, 'worker');
  assert.equal(run.note, 'editing totals.js');
  assert.equal(run.live, RUN);
  assert.deepEqual(run.usage, { rssBytes: 512e6, cpuSeconds: 90, processes: 3 });
  assert.ok(Date.parse(card(v, 2).startedAt) > 0, 'elapsed counts from the claim');
  assert.equal(card(v, 5).highRisk, true);
  assert.equal(card(v, 5).waiting!.kind, 'awaiting_decision');
  // An older change.proposed (before added/removed were recorded) still has its line count.
  s.log.append('change.proposed', { issue: 1, branch: 'x', base: A, head: B, files: ['c.js'], lines: 9, patch_hash: 'h' }, 'c');
  assert.deepEqual(card(view(s, 'owner'), 1).diff, { added: null, removed: null, lines: 9, files: 1, source: 'change' });
});

test('the actions each role sees: viewers none; writers watch, steer and answer what the decision rules allow; only the owner approves', () => {
  const s = seed();
  const acts = (role: 'owner' | 'writer' | 'viewer') => Object.fromEntries(view(s, role).cards.map((c) => [c.issue, c.actions]));
  const owner = acts('owner');
  const writer = acts('writer');
  const viewer = acts('viewer');
  assert.deepEqual(owner[2], { watch: 'feed', steer: true, answer: false, approve: null });
  assert.deepEqual(writer[2], { watch: 'feed', steer: true, answer: false, approve: null });
  assert.deepEqual(viewer[2], { watch: null, steer: false, answer: false, approve: null });
  assert.equal(owner[4]!.answer, true);
  assert.equal(writer[4]!.answer, true, 'a question is a writer\'s to answer too');
  assert.equal(viewer[4]!.answer, false);
  assert.deepEqual(owner[5]!.approve, { decision: 'd-land', options: ['approve', 'reject'] });
  assert.equal(owner[5]!.answer, false, 'a landing decision is Approve, not Answer');
  assert.equal(writer[5]!.approve, null);
  assert.equal(writer[5]!.answer, false);
  assert.equal(viewer[5]!.approve, null);
  for (const a of Object.values(viewer)) assert.ok(!a.watch && !a.steer && !a.answer && !a.approve, 'a viewer does nothing');
  // The digest's reason is the owner's and writers' to read.
  assert.match(card(view(s, 'writer'), 4).waiting!.detail ?? '', /Which threshold/);
  assert.equal(card(view(s, 'viewer'), 4).waiting!.detail, null);
});

test('a high-risk PR left to the owner: Merge on GitHub, for the owner only; a pending check alone is not waiting on you', () => {
  const s = seed();
  s.log.append('review.level_set', { issue: 7, head: B, level: 'L3', reasons: ['migrations'] }, 'c');
  s.log.append('pr.status', { issue: 7, number: 70, head: B, ready: true, reasons: [], checks: [{ name: 'ci', outcome: 'pass' }] }, 'c');
  s.log.append('merge.decided', { issue: 7, number: 70, head: B, auto: false, reasons: ['touches migrations (L3)'] }, 'c');
  const c = card(view(s, 'owner'), 7);
  assert.equal(c.column, 'waiting');
  assert.equal(c.waiting!.kind, 'needs_owner');
  assert.deepEqual(c.actions.approve, { merge: 'https://example.test/pr/70' });
  assert.equal(card(view(s, 'writer'), 7).actions.approve, null);
  assert.equal(columnOf({ status: 'in_review' }, { waits: false, pr: { phase: 'checks', state: 'open' }, runRole: null }), 'verifying');
  assert.equal(columnOf({ status: 'in_review' }, { waits: false, pr: { phase: 'ready', state: 'open' }, runRole: null }), 'landing');
  assert.equal(columnOf({ status: 'building' }, { waits: false, pr: null, runRole: 'planner' }), 'planning');
  assert.equal(columnOf({ status: 'triage' }, { waits: false, pr: null, runRole: null }), null);
});

test("#471: a PR left to the owner carries each of the merge policy's reasons whole, for the owner and writers only", () => {
  const s = seed();
  const reasons = ['doubt: evaluator confidence medium: the zero-quantity case is not covered by any test', 'high-risk: migration (migrations/001_orders.sql)', 'big: 512 changed lines (over 400)'];
  s.log.append('pr.status', { issue: 7, number: 70, head: B, ready: true, reasons: [], checks: [{ name: 'ci', outcome: 'pass' }] }, 'c');
  s.log.append('merge.decided', { issue: 7, number: 70, head: B, auto: false, reasons }, 'c');
  for (const role of ['owner', 'writer'] as const) {
    const w = card(view(s, role), 7).waiting!;
    assert.deepEqual(w.reasons, reasons, `${role}: every reason, whole and separate`);
    assert.equal(w.detail, reasons.join('; '));
  }
  assert.deepEqual([card(view(s, 'viewer'), 7).waiting!.reasons, card(view(s, 'viewer'), 7).waiting!.detail], [null, null], 'a viewer gets why it waits by kind only');
  const forViewer = boardForViewer(view(s, 'owner')).cards as { issue: number; waiting: { reasons?: unknown; detail?: unknown } | null }[];
  assert.deepEqual([forViewer.find((c) => c.issue === 7)!.waiting!.reasons, forViewer.find((c) => c.issue === 7)!.waiting!.detail], [null, null], 'and the viewer allowlist drops them');
  assert.equal(card(view(s, 'owner'), 4).waiting!.reasons, null, 'a decision has its question, not merge reasons');
});

test('check state: any failure fails, then anything unfinished is pending', () => {
  assert.equal(checkState([]), 'none');
  assert.equal(checkState(['pass', 'fail', 'pending']), 'failing');
  assert.equal(checkState(['pass', 'missing']), 'pending');
  assert.equal(checkState(['pass', 'skipped']), 'passing');
});

test("resource use: one pass over /proc sums each process group's memory and CPU (Linux); elsewhere nothing is measured", () => {
  // The command name may hold spaces and parentheses: fields are counted from the last ')'.
  const stat = (pid: number, pgrp: number, ut: number, st: number, rss: number) => `${pid} (node (worker) x) S 1 ${pgrp} ${pgrp} 0 -1 0 0 0 0 0 ${ut} ${st} 0 0 20 0 1 0 100 1000 ${rss} 0`;
  assert.deepEqual(parseProcStat(stat(10, 10, 150, 50, 1000)), { pgrp: 10, ticks: 200, rssPages: 1000 });
  assert.equal(parseProcStat('garbage'), null);
  const files: Record<string, string> = { '/proc/10/stat': stat(10, 10, 100, 100, 1000), '/proc/11/stat': stat(11, 10, 50, 50, 500), '/proc/12/stat': stat(12, 99, 1, 1, 1) };
  const read = (p: string) => {
    if (!(p in files)) throw new Error('gone');
    return files[p]!;
  };
  const u = processGroupUsage([10, 20], { platform: 'linux', list: () => ['10', '11', '12', '13', 'self'], readFile: read });
  assert.deepEqual(u.get(10), { rssBytes: 1500 * 4096, cpuSeconds: 3, processes: 2 });
  assert.equal(u.has(20), false, 'no process in the group: not measured');
  assert.equal(processGroupUsage([10], { platform: 'darwin', list: () => ['10'], readFile: read }).size, 0);
  assert.equal(processGroupUsage([10], { platform: 'win32', list: () => ['10'], readFile: read }).size, 0);
});

test("the server: a viewer gets 403 on Watch and no run fields on the board; a writer's Steer is accepted and audited, a viewer's refused; a writer still can't Approve, use the terminal or answer root steps", async () => {
  const s = seed();
  const d = await startDashboard({ root: s.root, cfg: s.cfg, eventsDb: s.eventsDb, stateDir: s.dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(s.dir, 'slots'), instance: 'shop', processUsage: () => new Map([[4242, { rssBytes: 1, cpuSeconds: 1, processes: 1 }]]) });
  const base = d.url.split('/?')[0]!;
  const as = (login: string) => ({ authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(login) });
  const get = (login: string, path: string) => fetch(`${base}${path}`, { headers: as(login) });
  const post = (login: string, path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: as(login), body: JSON.stringify(body) });
  try {
    for (const [login, role] of [['example-owner', 'owner'], ['example-collaborator', 'writer'], ['someone-else', 'viewer']] as const) {
      const r = await get(login, '/api/board');
      assert.equal(r.status, 200, `${role} reads the board`);
      const b = (await r.json()) as BoardView;
      assert.equal(b.role, role);
      assert.equal(b.instance, 'shop');
      const running = b.cards.find((c) => c.issue === 2)!;
      assert.equal(running.actions.steer, role !== 'viewer');
      assert.equal(running.actions.watch, role === 'viewer' ? null : 'feed');
      if (role !== 'viewer') assert.equal(running.run!.live, RUN);
    }
    // A viewer's board: only the allowlisted fields, so no run id, resource use, feed link or anything of the agent's.
    const raw = await (await get('someone-else', '/api/board')).text();
    assert.doesNotMatch(raw, new RegExp(`${RUN}|rssBytes|cpuSeconds|"run"|"usage"|costUsd|"diff"|"checks"|"comments"|editing totals`));
    const viewerCards = (JSON.parse(raw) as { cards: Record<string, unknown>[] }).cards;
    for (const c of viewerCards) assert.deepEqual(Object.keys(c).filter((k) => !VIEWER_CARD_FIELDS.includes(k) && k !== 'actions'), [], 'nothing off the allowlist');
    assert.deepEqual(viewerCards.find((c) => c.issue === 2)!.actions, { watch: null, steer: false, answer: false, approve: null });

    // Watch: the run's feed, behind the runs gate.
    assert.equal((await get('someone-else', `/api/board/watch/${RUN}`)).status, 403, 'a viewer may not watch');
    const watched = (await (await get('example-collaborator', `/api/board/watch/${RUN}`)).json()) as { items: { kind: string }[] };
    assert.deepEqual(watched.items.map((i) => i.kind), ['start', 'text', 'tool', 'tool_result'], 'a writer watches the feed');
    assert.equal((await get('someone-else', `/api/runs/${RUN}/feed`)).status, 403);

    // Steer: the owner's and the writers', each audited as its sender; a viewer's refused.
    assert.equal((await post('someone-else', `/api/runs/${RUN}/message`, { text: 'go left' })).status, 403, "a viewer's Steer is refused");
    assert.equal((await post('example-collaborator', `/api/runs/${RUN}/message`, { text: 'go left' })).status, 200, "a writer's Steer is accepted");
    assert.equal((await post('example-owner', `/api/runs/${RUN}/message`, { text: 'go right' })).status, 200);
    const asked = takeRequests(s.dir);
    assert.deepEqual(asked.map((q) => [q.by, q.kind, q.owner ?? null, q.writer ?? null]), [['example-collaborator', 'message', null, true], ['example-owner', 'message', true, null]]);
    // Stop stays the owner's.
    assert.equal((await post('example-collaborator', `/api/runs/${RUN}/stop`, {})).status, 403, "a writer can't stop the run");

    // Approve: a high-risk landing, the owner's alone.
    const refused = await post('example-collaborator', '/api/decide', { id: 'd-land', answer: 'approve' });
    assert.equal(refused.status, 403, "a writer's Approve is refused");
    assert.match(((await refused.json()) as { error: string }).error, /high-risk merge is for the instance's owners/);
    assert.equal((await post('someone-else', '/api/decide', { id: 'd-q', answer: '$50' })).status, 403, "a viewer's Answer is refused");
    assert.equal((await post('example-collaborator', '/api/decide', { id: 'd-q', answer: '$50' })).status, 200, 'a writer answers a question');
    assert.equal((await post('example-owner', '/api/decide', { id: 'd-land', answer: 'approve' })).status, 200);

    // The rest of the console stays the owner's: root steps (run or answered) and the terminal.
    const step = asks(s.log).create({ instance: 'shop', kind: 'root_step', title: 'Four slots', detail: 'x', command: 'set-slots', args: ['4'] });
    assert.equal((await post('example-collaborator', `/api/asks/${step.id}/run`, {})).status, 403, "a writer can't run a root step");
    assert.equal((await post('example-collaborator', `/api/asks/${step.id}/answer`, { answer: 'declined' })).status, 403, "a writer can't answer a root step");
    assert.match(terminalRefusal({ login: 'example-collaborator', role: 'writer', csrfOk: true }, { consoleUser: 'console-admin', hubUser: 'hub-viewer' }) ?? '', /owner's alone/, "a writer can't open the terminal");

    const audit = s.log.read(0, ['dashboard.audit']).map((e) => e.payload as { login: string; role: string; action: string; instance: string | null });
    assert.deepEqual(audit.map((a) => [a.login, a.role, a.action, a.instance]), [
      ['example-collaborator', 'writer', 'console.message', 'shop'],
      ['example-owner', 'owner', 'console.message', 'shop'],
      ['example-collaborator', 'writer', 'decision.answered', 'shop'],
      ['example-owner', 'owner', 'decision.answered', 'shop'],
    ]);
    const after = (await (await get('example-owner', '/api/board')).json()) as BoardView;
    assert.equal(after.cards.find((c) => c.issue === 5)!.actions.approve, null, 'answered: nothing left to approve');
  } finally {
    await d.close();
  }
});

test("the console's one rule, which the dashboard and the coordinator both apply: a message from the owner or a writer, a stop from the owner", () => {
  const { cfg } = seed();
  assert.equal(mayRequest(cfg, { kind: 'message', by: 'example-owner' }), null, 'the default owner');
  assert.equal(mayRequest(cfg, { kind: 'message', by: 'alice', owner: true }), null, 'one the dashboard read as an owner');
  assert.equal(mayRequest(cfg, { kind: 'message', by: 'wendy', writer: true }), null, 'a writer may steer');
  assert.match(mayRequest(cfg, { kind: 'stop', by: 'wendy', writer: true }) ?? '', /only the owner \(@example-owner\) may stop a run/);
  assert.match(mayRequest(cfg, { kind: 'message', by: 'vic' }) ?? '', /only the owner \(@example-owner\) or a writer may message a run; @vic may not/);
  assert.match(mayRequest(cfg, { kind: 'message', by: '', writer: true }) ?? '', /may not/, 'nobody named: refused');
});

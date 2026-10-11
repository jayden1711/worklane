import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askChat, bundleFiles, chatAnswer, chatHistory, chatTurn, CHAT_HISTORY, CHAT_TOOLS, contextFromEvents, hubChat, recentRuns, takeChatRequests, validateDraft, writeChatAnswer, type ChatContext } from '../src/chat.js';
import { RunRecorder } from '../src/run-record.js';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { CHAT_SCHEMA } from '../src/roles.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';
import { exampleProject } from './helpers.js';

const cfg = loadConfig(exampleProject().dir);
const owner = cfg.project.owners.default;
const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const posix = process.platform === 'win32' && 'POSIX modes';
const gid = typeof process.getgid === 'function' ? process.getgid() : 0;

const ev = (id: number, type: string, payload: object): StoredEvent => ({ id, ts: '2026-10-10T12:00:00Z', type, actor: 'i', source: 'coordinator', payload }) as unknown as StoredEvent;
const EVENTS = [
  ev(1, 'issue.seen', { issue: 7, title: 'Totals count negative quantities', labels: ['ready'], author: owner, owner: null, actionable: true, why: '' }),
  ev(2, 'issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner }),
  ev(3, 'coordinator.error', { instance: 'i', where: 'x', kind: 'e', message: `token ${TOKEN} leaked` }),
  ev(4, 'pr.opened', { issue: 7, number: 9, url: 'https://github.com/o/r/pull/9', head: 'c'.repeat(40), draft: true }),
  ev(5, 'decision.asked', { id: 'd-7-abc', kind: 'land', issue: 7, owner, question: 'Approve landing #7?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }),
  ev(6, 'coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 }),
];

function context(over: Partial<ChatContext> = {}): ChatContext {
  return { instance: 'shop', repo: 'o/r', events: EVENTS, runs: [{ id: 'run-1', issue: 7, role: 'worker', model: 'm', startedAt: '', endedAt: '', reason: 'succeeded', costUsd: 0.5, turns: 3, files: ['src/price.js'], truncated: false, commands: 2, failedCommands: 0 }], health: { load: [1, 2, 3] }, ...contextFromEvents(EVENTS), ...over };
}

function setup(answer: (req: RunRequest) => object) {
  const base = mkdtempSync(join(tmpdir(), 'chat-'));
  const runner = new FakeRunner((req) => ({ structured: answer(req), costUsd: 0.12, turns: 2 }));
  const costs: number[] = [];
  const opts = { cfg, context: context(), runner, stateDir: join(base, 'home', 'state'), bundleRoot: join(base, 'srv', 'chat'), gid, repo: join(base, 'repo'), remainingUsd: 5, onCost: (r: { costUsd: number }) => costs.push(r.costUsd) };
  return { base, runner, costs, opts };
}

test('context: open issues, PRs and decisions from the event log', () => {
  const c = contextFromEvents(EVENTS);
  assert.deepEqual(c.issues, [{ number: 7, title: 'Totals count negative quantities', status: 'claimed', labels: ['ready'] }]);
  assert.deepEqual(c.prs, [{ number: 9, issue: 7, title: 'Totals count negative quantities', state: 'open', url: 'https://github.com/o/r/pull/9' }]);
  assert.deepEqual(c.decisions, [{ id: 'd-7-abc', question: 'Approve landing #7?', options: ['approve', 'reject'] }]);
});

test('the bundle holds only the context, redacted, citable by id; written 2750/0640 for the agents group', { skip: posix }, async () => {
  const files = bundleFiles(context());
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'decisions.md', 'events.md', 'health.json', 'issues.md', 'prs.md', 'runs.md']);
  assert.ok(!JSON.stringify(files).includes(TOKEN), 'secrets in events are redacted');
  assert.match(files['events.md']!, /^event:1 /m);
  assert.doesNotMatch(files['events.md']!, /coordinator\.tick/, 'ticks are noise');
  assert.match(files['runs.md']!, /^run:run-1 worker issue #7 succeeded/m);
  const s = setup(() => ({ answer: 'ok', citations: [] }));
  await chatTurn({ ...s.opts, question: 'how is it going?', by: owner });
  const dirs = readdirSync(s.opts.bundleRoot);
  assert.equal(dirs.length, 1);
  const dir = join(s.opts.bundleRoot, dirs[0]!);
  assert.equal(statSync(dir).mode & 0o7777, 0o2750);
  assert.equal(statSync(join(dir, 'events.md')).mode & 0o777, 0o640);
  assert.ok(!readFileSync(join(dir, 'events.md'), 'utf8').includes(TOKEN));
});

test('the chat runs read-only: file reading tools only, no shell, no network, no writes; never the private state', async () => {
  const s = setup(() => ({ answer: 'ok', citations: [] }));
  await chatTurn({ ...s.opts, question: 'q', by: owner });
  const req = s.runner.calls[0]!;
  assert.equal(req.role, 'chat');
  assert.deepEqual(req.allowedTools, CHAT_TOOLS);
  assert.deepEqual(CHAT_TOOLS, ['Read', 'Glob', 'Grep']);
  for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) assert.ok(req.disallowedTools!.includes(t), t);
  assert.equal(req.lane, undefined, "the default lane: its sandbox denies the instance home and every credential store");
  assert.deepEqual(req.jsonSchema, CHAT_SCHEMA);
  assert.match(req.prompt, new RegExp(s.opts.bundleRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!req.prompt.includes(s.opts.stateDir), 'the private state is never pointed at');
  // The history lives in the instance's state, under the home every lane's sandbox denies.
  const home = join(s.base, 'home');
  const deny = sandboxSettings({ lane: { allowedDomains: [] }, denyRead: [home] }).permissions.deny;
  assert.ok(deny.some((d) => join(s.opts.stateDir, CHAT_HISTORY).startsWith(d.slice('Read(/'.length, -'/**)'.length))));
});

test('answers cite events, runs, PRs and issues as links; citations to nothing are dropped', async () => {
  const s = setup(() => ({ answer: 'PR #9 waits on you.', citations: [{ kind: 'pr', id: '#9' }, { kind: 'event', id: '4' }, { kind: 'run', id: 'run-1' }, { kind: 'issue', id: '7' }, { kind: 'event', id: '999' }] }));
  const a = await chatTurn({ ...s.opts, question: 'what waits on me?', by: owner });
  assert.deepEqual(a.citations.map((c) => [c.kind, c.href]), [['pr', 'https://github.com/o/r/pull/9'], ['event', '/events/4'], ['run', '/runs/run-1'], ['issue', 'https://github.com/o/r/issues/7']]);
  assert.deepEqual(a.unknownCitations, ['event:999']);
});

test('issue drafts: validated with parseContract, commands as block scalars; a preview, never filed', async () => {
  const good = 'Totals skip zero quantities.\n\n```done_when\n- command: |\n    npm test -- --grep zero\n```\n';
  assert.deepEqual(validateDraft('Skip zero quantities', good), { ok: true, title: 'Skip zero quantities', body: good, labels: ['ready'] });
  const inline = validateDraft('t', '```done_when\n- command: npm test\n```\n');
  assert.ok(!inline.ok && /block scalars/.test(inline.why));
  const bad = validateDraft('t', 'no contract at all');
  assert.ok(!bad.ok && /done_when/.test(bad.why));
  assert.ok(!validateDraft('  ', good).ok);
  const s = setup(() => ({ answer: 'drafted', citations: [], issue_draft: { title: 'Skip zero quantities', body: good } }));
  const a = await chatTurn({ ...s.opts, question: 'draft an issue', by: owner });
  assert.equal(a.issueDraft?.ok, true);
  assert.ok(!s.runner.calls.some((r) => r.role !== 'chat'), 'nothing but the chat ran; nothing was filed');
});

test('actions are only references to confirm flows; anything else is refused', async () => {
  const s = setup(() => ({
    answer: 'two proposals',
    citations: [],
    actions: [
      { kind: 'settings', key: 'workers', value: 2, why: 'idle' },
      { kind: 'decision', id: 'd-7-abc', answer: 'approve' },
      { kind: 'pause' },
      { kind: 'settings', key: 'auto_merge', value: true },
      { kind: 'decision', id: 'd-7-abc', answer: 'merge it' },
      { kind: 'decision', id: 'd-nope', answer: 'approve' },
      { kind: 'merge', id: '9' },
    ],
  }));
  const a = await chatTurn({ ...s.opts, question: 'what should I do?', by: owner });
  assert.deepEqual(a.actions, [
    { kind: 'settings', key: 'workers', value: 2, confirm: 'settings.change', why: 'idle' },
    { kind: 'decision', id: 'd-7-abc', answer: 'approve', confirm: 'decision.answer' },
    { kind: 'pause', confirm: 'emergency.pause' },
  ]);
  assert.equal(a.refusedActions.length, 4);
  assert.match(a.refusedActions.join('\n'), /auto_merge: not a setting[\s\S]*"merge it" is not one of approve, reject[\s\S]*not an open decision[\s\S]*merge: not an action/);
});

test("someone who isn't the owner gets a read-only answer: no drafts, no proposals, told so in the prompt", async () => {
  const s = setup(() => ({ answer: 'here', citations: [], issue_draft: { title: 't', body: '```done_when\n- command: |\n    x\n```\n' }, actions: [{ kind: 'pause' }] }));
  const a = await chatTurn({ ...s.opts, question: 'pause everything', by: 'collaborator' });
  assert.deepEqual([a.readOnly, a.issueDraft, a.actions], [true, null, []]);
  assert.match(s.runner.calls[0]!.prompt, /@collaborator, who is not the owner: answer only/);
  assert.deepEqual(chatHistory(s.opts.stateDir), [], "not the owner's conversation");
});

test('history: the owner’s turns, redacted, 0600, fed into the next turn', async () => {
  const s = setup((req) => ({ answer: req.prompt.includes('Earlier in this conversation') ? 'again' : `first, with ${TOKEN}`, citations: [] }));
  await chatTurn({ ...s.opts, question: 'one', by: owner });
  await chatTurn({ ...s.opts, question: 'two', by: owner });
  const h = chatHistory(s.opts.stateDir);
  assert.deepEqual(h.map((x) => x.question), ['one', 'two']);
  assert.ok(!readFileSync(join(s.opts.stateDir, CHAT_HISTORY), 'utf8').includes(TOKEN), 'redacted');
  if (process.platform !== 'win32') assert.equal(statSync(join(s.opts.stateDir, CHAT_HISTORY)).mode & 0o777, 0o600);
  assert.match(s.runner.calls[1]!.prompt, /Q \(@[^)]+\): one\nA: first/);
});

test('spend: each turn reports its cost (run.cost role chat) and is capped by what is left of the day', async () => {
  const s = setup(() => ({ answer: 'ok', citations: [] }));
  await chatTurn({ ...s.opts, remainingUsd: 0.3, question: 'q', by: owner });
  assert.deepEqual(s.costs, [0.12]);
  assert.equal(s.runner.calls[0]!.maxBudgetUsd, 0.3);
});

test('request/answer files: a question is a request the coordinator takes once; the answer is pending until written', () => {
  const s = mkdtempSync(join(tmpdir(), 'chat-files-'));
  assert.throws(() => askChat({ stateDir: s, question: '  ', by: owner }), /empty/);
  assert.throws(() => askChat({ stateDir: s, question: 'x'.repeat(4001), by: owner }), /over 4000/);
  assert.throws(() => askChat({ stateDir: s, question: 'q', by: '' }), /unknown/);
  const { id } = askChat({ stateDir: s, question: ` what about ${TOKEN}? `, by: owner, now: new Date('2026-10-10T12:00:00Z') });
  assert.deepEqual(chatAnswer(s, id), { v: 1, id, at: '2026-10-10T12:00:00.000Z', state: 'pending' });
  const reqs = takeChatRequests(s);
  assert.deepEqual(reqs.map((r) => [r.id, r.by]), [[id, owner]]);
  assert.ok(!reqs[0]!.question.includes(TOKEN), 'redacted on the way in');
  assert.deepEqual(takeChatRequests(s), [], 'taken once');
  writeChatAnswer(s, id, { refused: 'chat is off' }, new Date('2026-10-10T12:00:05Z'));
  assert.deepEqual(chatAnswer(s, id), { v: 1, id, at: '2026-10-10T12:00:05.000Z', state: 'refused', why: 'chat is off' });
  assert.equal(chatAnswer(s, '../../etc/passwd'), null, 'never a path outside');
  if (process.platform !== 'win32') assert.equal(statSync(join(s, 'chat', 'answers', `${id}.json`)).mode & 0o777, 0o600);
});

test('recent runs: the newest run records as summaries, oldest first, no steps', () => {
  const s = mkdtempSync(join(tmpdir(), 'chat-runs-'));
  assert.deepEqual(recentRuns(s), []);
  for (const [i, role] of ['worker', 'evaluator-verdict', 'chat'].entries()) {
    const r = new RunRecorder(s, { role, model: 'm', cwd: '/w/issue-4' }, new Date(Date.UTC(2026, 9, 10, 12, i)));
    r.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] } });
    r.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'exit code 1', is_error: true }] } });
    r.finish({ reason: 'succeeded', costUsd: 0.1, turns: 1, model: 'm' });
  }
  const runs = recentRuns(s, 2);
  assert.deepEqual(runs.map((r) => [r.role, r.issue, r.commands, r.failedCommands]), [['evaluator-verdict', 4, 1, 1], ['chat', 4, 1, 1]]);
  assert.ok(runs.every((r) => !('steps' in r)));
});

test('hub: a cross-instance question is answered from each selected instance, each its own run and bundle', async () => {
  const a = setup(() => ({ answer: 'shop is busy', citations: [{ kind: 'pr', id: '9' }] }));
  const b = setup(() => ({ answer: 'site is idle', citations: [] }));
  const out = await hubChat('anything stuck?', owner, [{ ...a.opts }, { ...b.opts, context: context({ instance: 'site', repo: 'o/site', prs: [] }) }]);
  assert.deepEqual(out.map((x) => [x.instance, x.answer]), [['shop', 'shop is busy'], ['site', 'site is idle']]);
  assert.equal(a.runner.calls.length + b.runner.calls.length, 2);
  assert.ok(existsSync(a.opts.bundleRoot) && existsSync(b.opts.bundleRoot));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../src/events/log.js';
import { AskError, asks, asksFrom, mayAnswerAsk } from '../src/console/asks.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { SLOTS_MAX, SLOTS_MIN } from '../src/machine.js';

const base = { instance: 'demo', title: 'Needs a thing', detail: 'Because.' };
const err = (status: number) => (e: unknown) => e instanceof AskError && e.status === status;

test('an ask: created as an event, open, answered once with who and role recorded; a second answer is refused', () => {
  const log = new EventLog(':memory:');
  const a = asks(log);
  const q = a.create({ ...base, kind: 'question', options: ['yes', 'no'] });
  assert.equal(q.status, 'open');
  assert.equal(q.kind, 'question');
  const created = log.read(0, ['ask.created']);
  assert.equal(created.length, 1);
  assert.equal((created[0]!.payload as { id: string }).id, q.id);

  const done = a.answer(q.id, { by: 'alice', role: 'owner', answer: 'yes' });
  assert.equal(done.status, 'answered');
  assert.deepEqual({ by: done.answer!.by, role: done.answer!.role, answer: done.answer!.answer }, { by: 'alice', role: 'owner', answer: 'yes' });
  const answered = log.read(0, ['ask.answered']);
  assert.equal(answered.length, 1);
  assert.equal(answered[0]!.actor, 'alice');
  assert.equal(answered[0]!.source, 'human');

  assert.throws(() => a.answer(q.id, { by: 'alice', role: 'owner', answer: 'no' }), err(409));
  assert.equal(log.read(0, ['ask.answered']).length, 1, 'still one answer');
  assert.equal(a.get(q.id)!.answer!.answer, 'yes', 'the first answer stands');
});

test('an answer must be one the ask takes; a secret is never an answer', () => {
  const log = new EventLog(':memory:');
  const a = asks(log);
  const q = a.create({ ...base, kind: 'question', options: ['a', 'b'] });
  assert.throws(() => a.answer(q.id, { by: 'o', role: 'owner', answer: 'c' }), err(400));
  const l = a.create({ ...base, kind: 'approve_link', url: 'https://github.com/settings/apps/new' });
  assert.throws(() => a.answer(l.id, { by: 'o', role: 'owner', answer: 'yes' }), err(400));
  assert.equal(a.answer(l.id, { by: 'o', role: 'owner', answer: 'approved' }).status, 'answered');
  const s = a.create({ ...base, kind: 'paste_secret', credential: 'intake-discord', where: 'credentials.yaml intake.discord_token' });
  assert.throws(() => a.answer(s.id, { by: 'o', role: 'owner', answer: 'stored' }), err(400));
  assert.equal(a.get(s.id)!.status, 'open');
});

test('create refuses bad asks: a credential path, a non-https link, odd options', () => {
  const a = asks(new EventLog(':memory:'));
  assert.throws(() => a.create({ ...base, kind: 'paste_secret', credential: '../../etc/passwd', where: 'x' }), err(400));
  assert.throws(() => a.create({ ...base, kind: 'approve_link', url: 'http://example.com' }), err(400));
  assert.throws(() => a.create({ ...base, kind: 'approve_link', url: 'javascript:alert(1)' }), err(400));
  assert.throws(() => a.create({ ...base, kind: 'question', options: [] }), err(400));
  assert.throws(() => a.create({ ...base, instance: 'Not An Instance', kind: 'question', options: ['x'] }), err(400));
});

test('who answers: the owner any ask; a writer only a question that allows writers; a viewer none', () => {
  const log = new EventLog(':memory:');
  const a = asks(log);
  const owners = a.create({ ...base, kind: 'question', options: ['x'] });
  const open = a.create({ ...base, kind: 'question', options: ['x'], writersMayAnswer: true });
  const link = a.create({ ...base, kind: 'approve_link', url: 'https://github.com/apps/x/installations/new' });
  assert.throws(() => a.answer(owners.id, { by: 'wendy', role: 'writer', answer: 'x' }), err(403));
  assert.throws(() => a.answer(link.id, { by: 'wendy', role: 'writer', answer: 'approved' }), err(403));
  assert.throws(() => a.answer(open.id, { by: 'vic', role: 'viewer', answer: 'x' }), err(403));
  assert.throws(() => a.answer(open.id, { by: 'nobody', role: null, answer: 'x' }), err(403));
  assert.equal(log.read(0, ['ask.answered']).length, 0);
  assert.equal(a.answer(open.id, { by: 'wendy', role: 'writer', answer: 'x' }).answer!.role, 'writer');
  assert.equal(mayAnswerAsk({ kind: 'paste_secret' }, 'writer'), false);
  assert.equal(mayAnswerAsk({ kind: 'root_step' }, 'viewer'), false);
});

test('a cancelled ask takes no answer; the fold keeps the first outcome', () => {
  const log = new EventLog(':memory:');
  const a = asks(log);
  const q = a.create({ ...base, kind: 'question', options: ['x'] });
  assert.equal(a.cancel(q.id, 'coordinator', 'not needed').status, 'cancelled');
  assert.throws(() => a.answer(q.id, { by: 'o', role: 'owner', answer: 'x' }), err(409));
  // Even a stray later answer event (another writer) doesn't change it.
  log.append('ask.answered', { id: q.id, by: 'x', role: 'owner', answer: 'x', detail: '' }, 'x', 'human');
  assert.equal(asksFrom(log.read(0)).find((x) => x.id === q.id)!.status, 'cancelled');
});

test("a root step off the helper's allowlist is recorded as needing the helper extended, and is refused", () => {
  const a = asks(new EventLog(':memory:'));
  const ok = a.create({ ...base, kind: 'root_step', command: 'set-slots', args: ['4'] });
  assert.equal(ok.kind === 'root_step' && ok.allowed, true);
  const bad = a.create({ ...base, kind: 'root_step', command: 'apt-get', args: ['install', 'x'] });
  assert.ok(bad.kind === 'root_step' && !bad.allowed && /needs the helper extended/.test(bad.refusal!));
  for (const [c, args] of [['set-slots', ['17']], ['set-slots', ['4', '5']], ['set-slots', ['04']], ['set-updates', ['maybe']], ['bash', ['-c', 'id']]] as const) {
    const r = checkRootStep(c, args);
    assert.equal(r.allowed, false, `${c} ${args.join(' ')}`);
  }
  assert.equal(checkRootStep('set-updates', ['off']).allowed, true);
  // The bounds are machine.ts's, not a copy.
  assert.equal(checkRootStep('set-slots', [String(SLOTS_MIN)]).allowed, true);
  assert.equal(checkRootStep('set-slots', [String(SLOTS_MAX)]).allowed, true);
  assert.equal(checkRootStep('set-slots', [String(SLOTS_MAX + 1)]).allowed, false);
  assert.equal(checkRootStep('set-slots', [String(SLOTS_MIN - 1)]).allowed, false);
});

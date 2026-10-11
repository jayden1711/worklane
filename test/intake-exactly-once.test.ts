// Exactly-once intake and chat: a redelivered message is never a second report, each conversation goes in arrival
// order, and a restart ends a cut-off report, reply or chat turn once, without running anything again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileBacklog } from '../src/backlog/file.js';
import { askChat, chatAnswer, takeChatRequests } from '../src/chat.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { pullBugReports } from '../src/intake/bug-store.js';
import { DiscordIntake, type Socket } from '../src/intake/discord.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { relaySignature, SmsIntake } from '../src/intake/sms.js';
import { purgeRaw, reportId, storeRaw } from '../src/intake/store.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DRAFT = { title: 'Totals ignore discounts', body: 'Totals are wrong when a discount applies.\n\n```done_when\n- command: |\n    npm test -- --grep "discount: applied"\n```\n' };
const OWNER_ID = '123456789012';
const STRANGER_ID = '987654321098';
const CONFIG = IntakeConfig.parse({ version: 1, trusted: { discord: [OWNER_ID], sms: ['+15550001111'] }, discord: { enabled: true }, sms: { enabled: true }, 'bug-store': { enabled: true } });

let seq = 0;
function report(o: { from?: string; text?: string; sourceId?: string; thread?: string; at?: string } = {}): IncomingReport {
  return {
    source: 'discord',
    sourceId: o.sourceId ?? `m${++seq}`,
    sender: { source: 'discord', id: o.from ?? OWNER_ID },
    text: o.text ?? 'bug: the checkout total ignores my discount code',
    receivedAt: o.at ?? '2026-10-01T10:00:00.000Z',
    thread: { kind: 'dm', id: o.thread ?? 'thread-1' },
  };
}

/** A source that hands out one batch per pull and records every reply and ack. */
function fakeSource(name: 'discord' | 'sms', batches: IncomingReport[][], reply?: () => Promise<boolean>) {
  const replies: { thread: string; text: string }[] = [];
  const acked: string[][] = [];
  const src: IntakeSource & { replies: typeof replies; acked: string[][] } = {
    name,
    replies,
    acked,
    take: async () => batches.shift() ?? [],
    reply: async (thread, text) => {
      replies.push({ thread: thread.id, text });
      return reply ? reply() : true;
    },
    ack: async (ids) => void acked.push(ids),
  };
  return src;
}

/** An instance's lasting state (checkout, backlog, log, state dir), so a test can "restart" its coordinator. */
function instance() {
  const base = mkdtempSync(join(tmpdir(), 'exactly-once-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  return { base, repo, stateDir, slotsDir, cfg: loadConfig(repo), backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), eventsDb: join(base, 'events.db'), log: new EventLog(join(base, 'events.db')) };
}
type Instance = ReturnType<typeof instance>;

function coordinator(i: Instance, o: { runner?: FakeRunner; sources?: IntakeSource[]; backlog?: FileBacklog } = {}) {
  const runner = o.runner ?? new FakeRunner(() => ({ structured: { kind: 'bug', draft: DRAFT } }));
  const sources = o.sources ?? [];
  const c = new Coordinator({
    cfg: i.cfg,
    log: i.log,
    backlog: o.backlog ?? i.backlog,
    runner,
    repo: i.repo,
    instance: 'example',
    stateDir: i.stateDir,
    slotsDir: i.slotsDir,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => CONFIG, sources, pullMs: 0 },
  });
  return { c, runner };
}

const payloads = (log: EventLog, type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
const flush = () => new Promise((r) => setImmediate(r));

// ---------- (1) deduped by the provider's message id ----------

const relayUrl = pathToFileURL(join(repoRoot, 'relay', 'worker.mjs')).href;
type Relay = { default: { fetch(req: Request, env: object): Promise<Response> }; twilioSignature(token: string, url: string, params: Record<string, string>): Promise<string> };
function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    put: async (k: string, v: string) => void m.set(k, v),
    get: async (k: string) => m.get(k) ?? null,
    delete: async (k: string) => void m.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }),
  };
}
async function relayWith() {
  const relay = (await import(relayUrl)) as Relay;
  const kv = fakeKv();
  const env = { INTAKE: kv, TWILIO_AUTH_TOKEN: 'tw-token', RELAY_SECRET: 'rs', PREFIXES: '["bug:"]' };
  const hook = 'https://relay.example.invalid/twilio';
  const post = async (params: Record<string, string>) =>
    relay.default.fetch(new Request(hook, { method: 'POST', headers: { 'x-twilio-signature': await relay.twilioSignature('tw-token', hook, params), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }), env);
  const pull = async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await relay.default.fetch(new Request('https://relay.example.invalid/pull', { method: 'GET', headers: { 'x-relay-ts': ts, 'x-relay-sig': relaySignature('rs', ts, 'GET', '/pull') } }), env);
    return ((await r.json()) as { messages: { id: string; received_at: string }[] }).messages;
  };
  return { kv, post, pull };
}

test('relay: the same webhook delivered twice is one stored message, pulled once, keeping its first arrival time', async () => {
  const r = await relayWith();
  const msg = { MessageSid: 'SMaaaaaaaaaa1', From: '+15550001111', Body: 'total wrong' };
  assert.equal((await r.post(msg)).status, 200);
  const first = JSON.parse(r.kv.m.get('msg:SMaaaaaaaaaa1')!).received_at as string;
  await new Promise((res) => setTimeout(res, 5));
  assert.equal((await r.post(msg)).status, 200, 'the retry is answered as usual');
  assert.equal(r.kv.m.size, 1);
  const pulled = await r.pull();
  assert.deepEqual(pulled.map((m) => m.id), ['SMaaaaaaaaaa1']);
  assert.equal(pulled[0]!.received_at, first, 'a retry does not move it in the order');
});

test('relay and adapters: two texts in one thread delivered in reverse id order are handed over in arrival order', async () => {
  const r = await relayWith();
  await r.post({ MessageSid: 'SMzzzzzzzzzz9', From: '+15550001111', Body: 'first: the total is wrong' });
  await new Promise((res) => setTimeout(res, 5));
  await r.post({ MessageSid: 'SMaaaaaaaaaa1', From: '+15550001111', Body: 'second: and the discount too' });
  assert.deepEqual((await r.pull()).map((m) => m.id), ['SMzzzzzzzzzz9', 'SMaaaaaaaaaa1'], 'the store lists by key; the relay sorts by arrival');
  // The adapter sorts again (a relay can't reorder what the coordinator takes), as does the bug-store pull.
  const messages = [
    { id: 'SMaaaaaaaaaa1', from: '+15550001111', body: 'second', received_at: '2026-10-01T10:00:02.000Z' },
    { id: 'SMzzzzzzzzzz9', from: '+15550001111', body: 'first', received_at: '2026-10-01T10:00:01.000Z' },
  ];
  const sms = new SmsIntake({ relayUrl: 'https://relay.example.invalid', secret: 's', prefixes: ['bug:'], accountSid: 'AC1', authToken: 't', number: '+15559990000', fetch: (async () => ({ ok: true, json: async () => ({ messages }) })) as unknown as typeof fetch });
  assert.deepEqual((await sms.pull()).map((m) => m.text), ['first', 'second']);
  const dir = mkdtempSync(join(tmpdir(), 'bugstore-'));
  const rows = [
    { id: 10, reporter: 'u1', text: 'later', created_at: '2026-10-01T10:00:02.000Z' },
    { id: 9, reporter: 'u1', text: 'earlier', created_at: '2026-10-01T10:00:01.000Z' },
  ];
  assert.deepEqual(pullBugReports(dir, 'SELECT * FROM r WHERE id > :after', () => ({ ok: true, output: JSON.stringify({ rows }) })).map((x) => x.text), ['earlier', 'later']);
});

test('intake: a message redelivered after its raw text was purged is still deduped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seen-'));
  const r = report({ sourceId: 'SMaaaaaaaaaa1' });
  assert.equal(storeRaw(dir, r), true);
  const old = (Date.now() - 30 * 86_400_000) / 1000;
  utimesSync(join(dir, 'intake', 'raw', `${reportId(r)}.json`), old, old);
  assert.equal(purgeRaw(dir, 14), 1);
  assert.deepEqual(readdirSync(join(dir, 'intake', 'raw')), [], 'the text is gone');
  assert.equal(storeRaw(dir, r), false, 'the id is still known');
  assert.deepEqual(readdirSync(join(dir, 'intake', 'raw')), [], 'and nothing is stored again');
});

class FakeSocket implements Socket {
  private fns: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  send() {}
  close() {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    (this.fns[type] ??= []).push(fn);
  }
  frame(f: object) {
    for (const fn of this.fns.message ?? []) fn({ data: JSON.stringify(f) });
  }
}

test('end to end: the relay returns a message on two pulls and the gateway sends one twice: one run, one issue, one reply each; SMS acked once recorded', async () => {
  const i = instance();
  const posts: string[] = [];
  const net = (async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/pull')) return { ok: true, json: async () => ({ messages: [{ id: 'SMaaaaaaaaaa1', from: '+15550001111', body: 'bug: the checkout total ignores my discount', received_at: '2026-10-01T10:00:00.000Z' }] }) };
    posts.push(`${u} ${String(init?.body ?? '')}`);
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const sms = new SmsIntake({ relayUrl: 'https://relay.example.invalid', secret: 's', prefixes: ['bug:'], accountSid: 'AC1', authToken: 't', number: '+15559990000', fetch: net });
  const sock = new FakeSocket();
  const discord = new DiscordIntake({ token: 'tok', channels: [], dms: true, prefixes: ['bug:'], connect: () => sock, fetch: net, setInterval: () => 1, clearInterval: () => {} });
  discord.start();
  sock.frame({ op: 0, s: 1, t: 'READY', d: { user: { id: '999999' } } });
  const create = () => sock.frame({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: 'm-dup', channel_id: 'dm1', content: 'the export button does nothing', author: { id: OWNER_ID, username: 'sam' } } });
  create();
  create();
  const sources: IntakeSource[] = [
    { name: 'discord', take: async () => discord.take(), reply: (t, x) => discord.reply(t.id, x) },
    { name: 'sms', take: () => sms.pull(), reply: (t, x) => sms.reply(t as { kind: 'sms' | 'group'; id: string }, x), ack: (ids) => sms.ack(ids) },
  ];
  const { c, runner } = coordinator(i, { sources });
  await c.checkIntake();
  create();
  await c.checkIntake();
  assert.equal(runner.calls.length, 2, 'one triage run per message, however often it came');
  assert.equal((await i.backlog.list('ready')).length, 2, 'one issue each');
  assert.equal(payloads(i.log, 'intake.replied').length, 2, 'one reply each');
  assert.equal(posts.filter((p) => /\/channels\/dm1\/messages/.test(p)).length, 1);
  assert.equal(posts.filter((p) => /Messages\.json/.test(p)).length, 1);
  const acks = posts.filter((p) => p.includes('/ack'));
  assert.equal(acks.length, 2, 'acked after each pull: once recorded, and again when redelivered (already seen)');
  assert.ok(acks.every((a) => a.includes('"ids":["SMaaaaaaaaaa1"]')));
});

test('intake: an SMS is acknowledged only after it is recorded: a crash before that redelivers it', async () => {
  const i = instance();
  const src = fakeSource('sms', [[{ ...report({ sourceId: 'SMaaaaaaaaaa1' }), source: 'sms', sender: { source: 'sms', id: '+15550001111' } }]]);
  let release!: () => void;
  const runner = new FakeRunner(() => new Promise((r) => (release = () => r({ structured: { kind: 'bug', draft: DRAFT } }))));
  const { c } = coordinator(i, { sources: [src], runner });
  void c.checkIntake();
  for (let n = 0; n < 50 && !release; n++) await flush();
  assert.ok(release, 'the run started');
  assert.deepEqual(src.acked, [], 'not acknowledged while it is being handled');
  release();
  await c.checkIntake();
  assert.deepEqual(src.acked, [['SMaaaaaaaaaa1']]);
});

// ---------- (2) one at a time, in arrival order ----------

test('intake: reports in one conversation are handled in arrival order, whatever order the source gave them', async () => {
  const i = instance();
  const later = report({ sourceId: 'a-later', text: 'bug: second message', at: '2026-10-01T10:00:02.000Z' });
  const earlier = report({ sourceId: 'z-earlier', text: 'bug: first message', at: '2026-10-01T10:00:01.000Z' });
  const order: string[] = [];
  const runner = new FakeRunner((req: RunRequest) => {
    order.push(req.cwd);
    return { structured: { kind: 'needs_info' } };
  });
  const { c } = coordinator(i, { sources: [fakeSource('discord', [[later, earlier]])], runner });
  await c.checkIntake();
  assert.deepEqual(order.map((d) => d.slice(-20)), [reportId(earlier), reportId(later)]);
});

// ---------- (3) a restart ends a cut-off turn exactly once ----------

test('intake: a crash mid-triage ends the report once as interrupted, asks the sender to resend, runs nothing; a second restart does nothing', async () => {
  const i = instance();
  const hung = new FakeRunner(() => new Promise(() => {}));
  const src = fakeSource('discord', [[report()]]);
  const first = coordinator(i, { sources: [src], runner: hung });
  void first.c.checkIntake();
  for (let n = 0; n < 50 && !payloads(i.log, 'intake.started').length; n++) await flush();
  assert.equal(payloads(i.log, 'intake.started').length, 1, 'the run started');
  // The process dies here. A new coordinator on the same state:
  const src2 = fakeSource('discord', []);
  const second = coordinator(i, { sources: [src2] });
  await second.c.recover();
  assert.deepEqual(payloads(i.log, 'intake.dropped').map((p) => p.reason), ['interrupted']);
  assert.equal(second.runner.calls.length, 0, 'the agent is never run again');
  assert.deepEqual(src2.replies.map((r) => r.text), ["Sorry, we couldn't finish handling your message. Could you send it again?"]);
  const third = coordinator(i, { sources: [fakeSource('discord', [])] });
  const before = i.log.read().length;
  await third.c.recover();
  assert.equal(i.log.read().length, before, 'nothing more on a second restart');
  assert.equal(third.runner.calls.length, 0);
});

test('intake: a crash between filing an issue and recording it files no second issue, and the sender still hears', async () => {
  const i = instance();
  // The filed path: the issue is created, then the process dies before intake.filed.
  const crashing = Object.create(i.backlog) as FileBacklog;
  crashing.createIssue = async (t, b, l) => {
    await i.backlog.createIssue(t, b, l);
    throw new Error('crash');
  };
  const first = coordinator(i, { sources: [fakeSource('discord', [[report()]])], backlog: crashing });
  await first.c.checkIntake();
  assert.equal(payloads(i.log, 'intake.filed').length, 0);
  const src = fakeSource('discord', []);
  const second = coordinator(i, { sources: [src] });
  await second.c.recover();
  await second.c.checkIntake();
  assert.equal((await i.backlog.list('ready')).length, 1, 'one issue total');
  assert.equal(payloads(i.log, 'intake.filed').length, 1, 'recorded on restart, found by its marker');
  assert.equal(payloads(i.log, 'intake.dropped').length, 0);
  assert.equal(src.replies.length, 1, 'told once');
  // The decision path: approved, the issue created, then the process dies before intake.decided.
  const third = coordinator(i, { sources: [fakeSource('discord', [[report({ from: STRANGER_ID, text: 'bug: the search box loses focus' })]])], backlog: crashing });
  await third.c.checkIntake();
  const [q] = payloads(i.log, 'decision.asked');
  i.log.append('decision.answered', { id: q!.id as string, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  await third.c.checkIntake();
  assert.equal(payloads(i.log, 'intake.decided').length, 0);
  const fourth = coordinator(i, { sources: [fakeSource('discord', [])] });
  await fourth.c.recover();
  await fourth.c.checkIntake();
  assert.equal((await i.backlog.list('ready')).length, 2, 'one issue for the approved draft, not two');
  assert.equal(payloads(i.log, 'intake.decided').length, 1);
});

test('intake: a crash mid-reply is recorded as unknown and never resent', async () => {
  const i = instance();
  const src = fakeSource('discord', [[report({ text: 'bug: something vague' })]], () => new Promise(() => {}));
  const first = coordinator(i, { sources: [src], runner: new FakeRunner(() => ({ structured: { kind: 'needs_info' } })) });
  void first.c.checkIntake();
  for (let n = 0; n < 50 && !src.replies.length; n++) await flush();
  assert.equal(src.replies.length, 1, 'the reply went out (or may have)');
  const src2 = fakeSource('discord', []);
  const second = coordinator(i, { sources: [src2] });
  await second.c.recover();
  assert.deepEqual(payloads(i.log, 'intake.replied'), [{ id: payloads(i.log, 'intake.received')[0]!.id, stage: 'info', ok: false, unknown: true }]);
  assert.deepEqual(src2.replies, [], 'not sent again');
  assert.deepEqual(payloads(i.log, 'intake.dropped'), [], 'the report was answered: not ended again as interrupted');
});

/** Request keys: plain words, not key-shaped strings a secret scanner would flag. */
const RETRY = 'same-question-retry';
const OTHER = 'another-question';

test('chat: the same POST with the same key twice is one question, one turn, one cost', async () => {
  const i = instance();
  const d = await startDashboard({ root: i.repo, cfg: i.cfg, eventsDb: i.eventsDb, stateDir: i.stateDir, user: 'example-owner' });
  const base = d.url.split('/?')[0]!;
  const post = (key: string) => fetch(`${base}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'what is waiting?', key }) });
  let first = '';
  try {
    const a = (await (await post(RETRY)).json()) as { id: string };
    const b = (await (await post(RETRY)).json()) as { id: string };
    assert.equal(a.id, b.id, 'the retry is the same question');
    first = a.id;
    const other = (await (await post(OTHER)).json()) as { id: string };
    assert.notEqual(other.id, a.id, 'a new key is a new question');
    assert.equal((await post('bad key!')).status, 400);
  } finally {
    await d.close();
  }
  const runner = new FakeRunner((req) => (req.role === 'chat' ? { structured: { answer: 'Nothing.', citations: [] }, costUsd: 0.2 } : {}));
  const { c } = coordinator(i, { runner });
  await c.checkChat();
  assert.equal(runner.calls.length, 2, 'two questions, two turns: the retry ran none');
  assert.equal(payloads(i.log, 'run.cost').length, 2);
  assert.equal(askChat({ stateDir: i.stateDir, question: 'what is waiting?', by: 'Example-Owner', key: RETRY }).id, first, 'a retry after the answer is still the same question (logins ignore case)');
  await c.checkChat();
  assert.equal(runner.calls.length, 2);
});

test('chat: a crash mid-turn refuses that question once at start-up and never reruns it', async () => {
  const i = instance();
  const { id } = askChat({ stateDir: i.stateDir, question: 'what is waiting?', by: 'example-owner' });
  const waiting = askChat({ stateDir: i.stateDir, question: 'and now?', by: 'example-owner' });
  // The coordinator took the first request and died during its turn; the second was never taken.
  const taken = takeChatRequests(i.stateDir);
  assert.equal(taken.length, 2);
  const fresh = askChat({ stateDir: i.stateDir, question: 'one more', by: 'example-owner' });
  const first = coordinator(i);
  await first.c.recover();
  const a = chatAnswer(i.stateDir, id)!;
  assert.equal(a.state, 'refused');
  assert.match((a as { why: string }).why, /interrupted.*ask again/);
  assert.equal(chatAnswer(i.stateDir, waiting.id)!.state, 'refused', 'its request was taken too, so it is ended the same way');
  assert.equal(chatAnswer(i.stateDir, fresh.id)!.state, 'pending', 'a question not yet taken waits for its turn');
  const at = (a as { at: string }).at;
  const second = coordinator(i);
  await second.c.recover();
  assert.equal((chatAnswer(i.stateDir, id) as { at: string }).at, at, 'refused once: a second restart changes nothing');
  assert.equal(first.runner.calls.length + second.runner.calls.length, 0, 'never rerun');
});

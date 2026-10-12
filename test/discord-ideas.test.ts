// Ideas in conversation (src/coordinator/conversation.ts): an idea posted in the chat channel gets a thread,
// questions (one message per turn), a five-part draft, and is filed ready only on an explicit yes from its poster
// or an admin; then the thread gets the issue's progress. Discord is a fake; the triage run is a FakeRunner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { CONFIRM_TEXT, readConfirm, VAGUE_TEXT } from '../src/intake/channel.js';
import { mayFileReady } from '../src/intake/people.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Placeholder ids and logins only.
const OWNER_ID = '100000000001';
const COFOUNDER_ID = '100000000002';
const WRITER_ID = '100000000003';
const WRITER2_ID = '100000000006';
const VIEWER_ID = '100000000007';
const UNMAPPED_ID = '100000000004';
const IDEAS = '111111';
const SHA = 'a'.repeat(40);

const CONFIG = IntakeConfig.parse({
  version: 1,
  // A trusted sender's report would be filed ready at once by plain intake; in conversation it waits for a yes.
  trusted: { discord: [OWNER_ID] },
  discord: {
    enabled: true,
    guild: '555555',
    channels: [IDEAS],
    allowed_senders: [OWNER_ID, COFOUNDER_ID, WRITER_ID, WRITER2_ID, VIEWER_ID, UNMAPPED_ID],
    people: { [OWNER_ID]: 'example-owner', [COFOUNDER_ID]: 'example-cofounder', [WRITER_ID]: 'example-collaborator', [WRITER2_ID]: 'example-writer2', [VIEWER_ID]: 'example-viewer' },
    conversation: true,
  },
});
const ROLES: Record<string, 'owner' | 'writer' | 'viewer'> = { 'example-owner': 'owner', 'example-cofounder': 'owner', 'example-collaborator': 'writer', 'example-writer2': 'writer', 'example-viewer': 'viewer' };
const roleOf = async (login: string) => ROLES[login.toLowerCase()] ?? null;

const DRAFT = {
  title: 'Cart totals apply discounts before tax',
  body: '**Outcome:** The cart total applies discount codes before tax.\n**Sources:** the cart totals code.\n**Constraints:** leave invoice totals alone.\n**Deliverable:**\n```done_when\n- command: |\n    npm test -- --grep "cart discount before tax"\n```\n**Review point:** L1; waits for an admin if it changes pricing rules.\n',
};

function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const threads: { channel: string; text: string; name: string; id: string; from?: string }[] = [];
  const batches: IncomingReport[][] = [];
  const src: IntakeSource & { posts: typeof posts; threads: typeof threads; batches: typeof batches } = {
    name: 'discord',
    posts,
    threads,
    batches,
    take: async () => batches.shift() ?? [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async (channel, text, name, from) => {
      const id = String(900000 + threads.length);
      threads.push({ channel, text, name, id, ...(from ? { from } : {}) });
      return id;
    },
    watch: () => {},
  };
  return src;
}

function setup(outputs: object[]) {
  const base = mkdtempSync(join(tmpdir(), 'chat-ideas-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  mkdirSync(join(base, 'slots'));
  const chat = fakeChat();
  const runner = new FakeRunner(() => ({ structured: outputs.shift() ?? { kind: 'needs_info' } }));
  const c = new Coordinator({
    cfg: loadConfig(repo),
    log,
    backlog,
    runner,
    repo,
    instance: 'example',
    stateDir,
    slotsDir: join(base, 'slots'),
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => CONFIG, sources: [chat], pullMs: 0, roleOf },
  });
  const pass = async (...msgs: IncomingReport[]) => {
    chat.batches.push(msgs);
    await c.checkIntake();
  };
  return { log, backlog, stateDir, chat, runner, c, pass, outputs };
}

let seq = 0;
const msg = (from: string, text: string, thread?: string): IncomingReport => ({
  source: 'discord',
  sourceId: `4000000000${++seq}`,
  sender: { source: 'discord', id: from },
  text,
  receivedAt: '2026-10-01T10:00:00.000Z',
  thread: thread ? { kind: 'thread', id: thread } : { kind: 'channel', id: IDEAS },
});
const ready = async (b: FileBacklog) => b.list('ready');
const inThread = (t: ReturnType<typeof setup>, thread: string) => t.chat.posts.filter((p) => p.where === thread).map((p) => p.text);
const ideaStages = (log: EventLog) => log.read(0, ['discord.idea']).map((e) => (e.payload as { stage: string }).stage);
const bundleOf = (req: RunRequest) => Object.fromEntries(readdirSync(req.cwd).map((f) => [f, readFileSync(join(req.cwd, f), 'utf8')]));

test("ideas: the owner's idea gets a thread, one message of questions, a draft, and is filed ready only on their explicit yes; then progress posts", async () => {
  const t = setup([{ kind: 'needs_info', reply: 'Which total: the cart or the invoice? And do discounts apply before or after tax?' }, { kind: 'bug', draft: DRAFT }]);
  t.log.append('decision.asked', { id: 'd-1', kind: 'question', issue: null, owner: 'example-owner', question: 'Do discounts stack?', options: ['yes', 'no'], recommendation: 'no', receipts: [] }, 'c');
  t.log.append('decision.answered', { id: 'd-1', by: 'example-owner', answer: 'no' }, 'example-owner', 'human');
  const idea = msg(OWNER_ID, 'bug: the totals ignore my discount code');
  await t.pass(idea);
  assert.equal(t.chat.threads.length, 1);
  assert.equal(t.chat.threads[0]!.from, idea.sourceId, 'the thread is opened on their message');
  const thread = t.chat.threads[0]!.id;
  assert.deepEqual(inThread(t, thread), ['Which total: the cart or the invoice? And do discounts apply before or after tax?'], 'its questions, all in one message');
  // The run: the intake role, with the conversation and the decisions already made, told to ask only what's left.
  const first = bundleOf(t.runner.calls[0]!);
  assert.match(first['report.md']!, /They said:.*totals ignore my discount code/);
  assert.match(first['decisions.md']!, /Do discounts stack\? -> no/);
  assert.match(t.runner.calls[0]!.appendSystemPrompt!, /ask only what none of them settles/);
  assert.equal(t.runner.calls[0]!.role, 'intake');

  await t.pass(msg(OWNER_ID, 'The cart, before tax.', thread));
  assert.match(bundleOf(t.runner.calls[1]!)['report.md']!, /You asked:.*Which total[\s\S]*They said:.*The cart, before tax/);
  const shown = inThread(t, thread).slice(1);
  assert.match(shown[0]!, /Draft issue: \*\*Cart totals apply discounts before tax\*\*/);
  assert.equal(shown.at(-1), CONFIRM_TEXT);
  assert.ok(shown.every((s) => s.length <= 500));
  assert.deepEqual(await ready(t.backlog), [], 'shown, not filed');
  assert.ok(existsSync(join(t.stateDir, 'intake', 'drafts', `idea-${(t.log.read(0, ['discord.idea'])[0]!.payload as { id: string }).id}.json`)), 'only a draft in the private store');

  await t.pass(msg(OWNER_ID, 'sounds good', thread));
  assert.deepEqual(await ready(t.backlog), [], 'a vague reply files nothing');
  assert.equal(inThread(t, thread).at(-1), VAGUE_TEXT);

  await t.pass(msg(OWNER_ID, 'yes', thread));
  const filed = await ready(t.backlog);
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, DRAFT.title);
  assert.deepEqual(filed[0]!.labels, ['ready', 'bug']);
  assert.match(inThread(t, thread).at(-1)!, /Filed as ready: #1/);
  assert.equal(t.runner.calls.length, 2, 'the yes runs no agent');

  // Progress, from the events, once each and in order.
  const n = filed[0]!.number;
  t.log.append('plan.posted', { issue: n, plan: {}, held: false, reasons: [], comments_at: 0, decision: null }, 'c');
  t.log.append('pr.opened', { issue: n, number: 12, url: 'https://github.com/example/shop/pull/12', head: SHA, draft: false }, 'c');
  t.log.append('merge.done', { issue: n, number: 12, head: SHA, sha: SHA, url: 'https://github.com/example/shop/pull/12', title: DRAFT.title }, 'c');
  t.log.append('deploy.verified', { env: 'production', sha: SHA }, 'c');
  await t.pass();
  await t.pass();
  const progress = inThread(t, thread).slice(-4);
  assert.match(progress[0]!, /^Planned: the plan for #1/);
  assert.match(progress[1]!, /^PR opened for #1: https:\/\/github.com\/example\/shop\/pull\/12/);
  assert.match(progress[2]!, /^Merged: #1/);
  assert.match(progress[3]!, /^Live: the change for #1 is deployed \(production\)/);
  assert.equal(inThread(t, thread).filter((x) => /^(Planned|PR opened|Merged|Live):?/.test(x)).length, 4, 'each once');
});

test("ideas: nothing is filed ready without an explicit yes from its poster or an admin: not a vague reply, another writer's yes, a viewer's, or an unmapped person's", async () => {
  const t = setup([{ kind: 'feature', draft: DRAFT }]);
  await t.pass(msg(WRITER_ID, 'bug: discounts should apply before tax in the cart'));
  const thread = t.chat.threads[0]!.id;
  for (const [who, text] of [[WRITER_ID, 'ok'], [WRITER_ID, 'lgtm'], [WRITER_ID, '👍'], [WRITER2_ID, 'yes'], [VIEWER_ID, 'yes'], [UNMAPPED_ID, 'yes']] as const) {
    await t.pass(msg(who, text, thread));
    assert.deepEqual(await ready(t.backlog), [], `${text} from ${who} files nothing`);
  }
  assert.deepEqual(ideaStages(t.log), ['opened', 'said', 'drafted'], 'still only a draft');
  const said = inThread(t, thread);
  assert.match(said.at(-1)!, /Only @example-collaborator or an admin can file this one/, "the viewer's yes is a comment");
  assert.deepEqual(t.log.read(0, ['discord.reply']).map((e) => (e.payload as { by: string }).by), ['example-writer2', 'example-viewer'], 'the unmapped yes left no trace');
  assert.equal(t.runner.calls.length, 1, 'none of it ran the agent again');
  // The writer who posted it files it with their own yes.
  await t.pass(msg(WRITER_ID, 'Yes, file it.', thread));
  assert.deepEqual((await ready(t.backlog)).map((i) => i.labels), [['ready', 'enhancement']]);
  assert.equal((t.log.read(0, ['discord.idea']).at(-1)!.payload as { by: string }).by, 'example-collaborator');
});

test("ideas: an admin's yes files a writer's idea; a viewer or an unmapped person can't open one; a no drops the draft", async () => {
  const t = setup([{ kind: 'bug', draft: DRAFT }, { kind: 'bug', draft: DRAFT }]);
  await t.pass(msg(VIEWER_ID, 'bug: an idea from a viewer'), msg(UNMAPPED_ID, 'bug: an idea from someone unmapped'));
  assert.equal(t.chat.threads.length, 0, 'neither opens a thread');
  assert.deepEqual(t.log.read(0, ['discord.idea']), []);
  assert.equal(t.runner.calls.length, 0);
  assert.ok(!existsSync(join(t.stateDir, 'intake', 'raw')) || readdirSync(join(t.stateDir, 'intake', 'raw')).length === 0, 'nothing of theirs is stored');

  await t.pass(msg(WRITER_ID, 'bug: discounts should apply before tax'));
  await t.pass(msg(COFOUNDER_ID, 'yes', t.chat.threads[0]!.id));
  assert.equal((await ready(t.backlog)).length, 1, "an admin's yes files it");

  await t.pass(msg(OWNER_ID, 'bug: another idea'));
  await t.pass(msg(OWNER_ID, 'no', t.chat.threads[1]!.id));
  assert.equal((await ready(t.backlog)).length, 1, 'the second idea is dropped, not filed');
  assert.equal(ideaStages(t.log).at(-1), 'dropped');
});

test('ideas: the confirm reading and the filing rule', () => {
  for (const s of ['yes', 'Yes!', 'yes, file it', 'YES.']) assert.equal(readConfirm(s), 'yes', s);
  for (const s of ['ok', 'sure', 'sounds good', 'LGTM', 'yep', 'y', '👍']) assert.equal(readConfirm(s), 'vague', s);
  for (const s of ['no', 'cancel', 'drop it']) assert.equal(readConfirm(s), 'no', s);
  for (const s of ['yes but make it the invoice too', 'make the title shorter']) assert.equal(readConfirm(s), 'change', s);
  assert.equal(mayFileReady('owner', false), true, 'any admin');
  assert.equal(mayFileReady('writer', true), true, 'the writer who posted it');
  assert.equal(mayFileReady('writer', false), false, 'another writer');
  assert.equal(mayFileReady('viewer', true), false, 'a viewer, even their own');
  assert.equal(mayFileReady(null, true), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const DRAFT = [
  '**Outcome:** Handlers can no longer import the payments client.',
  '**Sources:** src/handlers/ and the lint config.',
  '**Constraints:** Leave the queue worker alone.',
  '**Deliverable:**',
  '```done_when',
  '- command: |',
  '    node --test',
  '```',
  '**Review point:** L2; waits for the owner if it touches CI config.',
].join('\n');
const FILE = { same_as: '', fix_kind: 'check', why_not_stronger: 'imports are legal outside handlers', title: 'Lint: no payments client in handlers', body: DRAFT, why: 'the lint fails on it' };

function fixture(answer: (req: RunRequest) => object = () => FILE) {
  const base = mkdtempSync(join(tmpdir(), 'corrections-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const cfg = loadConfig(repo);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const stateDir = join(base, 'state');
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const runner = new FakeRunner((req) => ({ structured: answer(req) }));
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir, slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  const check = async () => {
    await c.checkCorrections();
    await c.idle();
  };
  const runs = () => runner.calls.filter((r) => r.role === 'corrections');
  const chat = (by: string, question: string, answerText = '...') => {
    mkdirSync(join(stateDir, 'chat'), { recursive: true });
    appendFileSync(join(stateDir, 'chat', 'history.jsonl'), `${JSON.stringify({ at: new Date().toISOString() + Math.random(), by, question, answer: answerText })}\n`);
  };
  const of = (type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
  return { cfg, log, backlog, c, check, runs, chat, of, runner };
}

test('a revised plan is recorded once, a read-only run proposes the strongest fix, and it is filed ready as a five-part issue', async () => {
  const t = fixture();
  t.log.append('plan.posted', { issue: 7, plan: { approach: 'Charge on submit' }, held: true, reasons: ['x'], comments_at: 0, decision: 'd-1' }, 'test');
  t.log.append('plan.decided', { issue: 7, decision: 'd-1', answer: 'revise', by: 'example-owner', note: 'never call payments from a handler' }, 'test');
  await t.check();
  assert.deepEqual(t.of('correction.recorded').map((p) => [p.key, p.kind, p.by]), [['plan:d-1', 'plan_revised', 'example-owner']]);
  const run = t.runs()[0]!;
  assert.ok(run, 'a corrections run');
  assert.ok(run.disallowedTools?.includes('Edit') && run.disallowedTools.includes('Write') && !run.allowedTools.includes('Bash'), 'read-only');
  assert.match(run.prompt, /<correction>\n.*asked for a revised plan for #7\.[\s\S]*never call payments from a handler\n<\/correction>/);
  const proposed = t.of('correction.proposed')[0]!;
  assert.deepEqual([proposed.key, proposed.fix_kind, proposed.title], ['plan:d-1', 'check', FILE.title]);
  const filed = (await t.backlog.list('correction'))[0]!;
  assert.equal(filed.number, proposed.issue);
  assert.deepEqual(filed.labels.sort(), ['correction', 'ready']);
  assert.match(filed.body, /\*\*Outcome:\*\*[\s\S]*<!-- correction:plan:d-1 -->/);
  await t.check();
  assert.equal(t.runs().length, 1, 'never proposed twice');
  assert.equal(t.of('correction.recorded').length, 1, 'recorded once');
});

test("reviews requesting changes and a PR a writer closed unmerged are corrections; others' reviews, approvals and merged PRs are not", async () => {
  const t = fixture();
  const open = await t.backlog.openPr('worklane/issue-4', 'main', 'Charge on submit', 'b');
  const closed = await t.backlog.openPr('worklane/issue-5', 'main', 'Retry uploads', 'b');
  const merged = await t.backlog.openPr('worklane/issue-6', 'main', 'Docs', 'b');
  for (const [issue, pr] of [[4, open.number], [5, closed.number], [6, merged.number]] as const) t.log.append('pr.opened', { issue, number: pr, url: 'u', head: 'abcdef1', draft: false }, 'test');
  t.backlog.addReview(open.number, { author: 'example-owner', state: 'CHANGES_REQUESTED', body: 'Do not log request bodies.' });
  t.backlog.addReview(open.number, { author: 'drive-by', state: 'CHANGES_REQUESTED', body: 'meh' });
  t.backlog.addReview(open.number, { author: 'example-collaborator', state: 'APPROVED', body: '' });
  t.backlog.humanComment(closed.number, 'example-owner', 'Retries belong in the client, not here.');
  t.backlog.setPr(closed.number, { state: 'closed', closedBy: 'example-owner' });
  t.log.append('pr.closed', { issue: 5, number: closed.number, merged: false }, 'test');
  t.backlog.setPr(merged.number, { merged: true, closedBy: 'example-owner' });
  t.log.append('pr.closed', { issue: 6, number: merged.number, merged: true }, 'test');
  await t.check();
  const rec = t.of('correction.recorded');
  assert.deepEqual(rec.map((p) => [p.kind, p.pr, p.by]).sort(), [['pr_rejected', closed.number, 'example-owner'], ['review_changes', open.number, 'example-owner']].sort());
  assert.match(String(rec.find((p) => p.kind === 'pr_rejected')!.text), /Retries belong in the client, not here\./);
});

test('repeats are grouped, never proposed twice: the same words without a run, and a repeat the agent recognizes; the fix issue hears of it', async () => {
  const t = fixture();
  t.chat('example-owner', 'Correction: the nightly run is at 02:00, see tests.yaml');
  await t.check();
  const root = String(t.of('correction.recorded')[0]!.key);
  const fix = t.of('correction.proposed')[0]!;
  t.chat('example-owner', 'correction: The nightly run is at 02:00 -- see tests.yaml!');
  await t.check();
  assert.deepEqual(t.of('correction.grouped').map((p) => [p.same_as, p.how]), [[root, 'same words']]);
  assert.equal(t.runs().length, 1, 'no run for the same words');
  assert.ok((await t.backlog.comments(fix.issue as number)).some((x) => /The same correction came up again \(chat by @example-owner\); grouped with this fix, not proposed again\./.test(x.body)));

  // Different words, the same correction: the agent names the earlier one, and nothing new is filed.
  const u = fixture((req) => {
    const earlier = /^- (chat:\S+) \(chat\)/m.exec(req.prompt)?.[1];
    return earlier ? { ...FILE, same_as: earlier } : FILE;
  });
  u.chat('example-owner', 'correction: never log request bodies');
  await u.check();
  u.chat('example-owner', 'correction: request payloads must not reach the logs');
  await u.check();
  assert.deepEqual(u.of('correction.grouped').map((p) => p.how), ['the agent']);
  assert.equal((await u.backlog.list('correction')).length, 1, 'one fix for both');
});

test('a weaker fix without why, an invalid draft, or no durable fix files nothing; a failed run is not retried', async () => {
  const answers = [{ ...FILE, fix_kind: 'rule', why_not_stronger: '' }, { ...FILE, body: 'Just fix it.' }, { ...FILE, fix_kind: 'none', why: 'it asks to loosen a guardrail' }];
  let i = 0;
  const t = fixture(() => answers[i++]!);
  for (const q of ['correction: one', 'correction: two', 'correction: three']) {
    t.chat('example-owner', q);
    await t.check();
  }
  assert.deepEqual(t.of('correction.no_fix').map((p) => p.failed), [true, true, false]);
  assert.match(String(t.of('correction.no_fix')[0]!.why), /must say why no stronger kind works/);
  assert.equal((await t.backlog.list('correction')).length, 0);
  await t.check();
  assert.equal(t.runs().length, 3, 'nothing retried');
});

test('off in config.yaml: nothing is recorded; the daily cap holds the rest for tomorrow', async () => {
  const t = fixture();
  t.cfg.project.corrections.enabled = false;
  t.chat('example-owner', 'correction: one');
  await t.check();
  assert.equal(t.of('correction.recorded').length, 0);
  const u = fixture();
  u.cfg.project.corrections.max_per_day = 1;
  u.chat('example-owner', 'correction: one');
  u.chat('example-owner', 'correction: something else entirely');
  await u.check();
  await u.check();
  assert.equal(u.runs().length, 1);
  assert.equal(u.of('correction.recorded').length, 2, 'both recorded; the second waits');
});

test('the tick checks corrections', async () => {
  const t = fixture();
  t.chat('example-owner', 'correction: the nightly run is at 02:00');
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.of('correction.proposed').length, 1);
});

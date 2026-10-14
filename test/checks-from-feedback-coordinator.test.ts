import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { CHECKS_LABEL } from '../src/checks-from-feedback.js';
import { loadConfig } from '../src/config/load.js';
import { reviewCorrections } from '../src/corrections.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { FEEDBACK_CHECK_BRANCH_PREFIX, neverAutoMerge } from '../src/merge-policy.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const WRITERS = ['example-owner', 'example-collaborator'];

/** A run that writes a test file and says so. */
const writesTest = (req: RunRequest) => {
  mkdirSync(join(req.cwd, 'test'), { recursive: true });
  writeFileSync(join(req.cwd, 'test', 'no-payments-in-handlers.test.js'), "import { test } from 'node:test';\ntest('handlers never import the payments client', () => {});\n");
  return { title: 'Test: handlers never call the payments client', summary: 'A test that fails when a handler imports the payments client.', not_checkable: '' };
};

function fixture(answer: (req: RunRequest) => object = writesTest, o: { enabled?: boolean; maxPerWeek?: number; sgconfig?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'feedback-checks-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  if (o.sgconfig) writeFileSync(join(seed, 'sgconfig.yml'), o.sgconfig);
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const cfg = loadConfig(repo);
  cfg.project.checks_from_feedback = { enabled: o.enabled ?? true, min_sightings: 2, max_proposals_per_week: o.maxPerWeek ?? 3 };
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const clock = { now: new Date() };
  const runner = new FakeRunner((req) => ({ structured: answer(req), costUsd: 0.3 }));
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, now: () => clock.now, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  const check = async () => {
    await c.checkFeedbackChecks();
    await c.idle();
  };
  const runs = () => runner.calls.filter((r) => r.role === 'feedback-checks');
  const of = (type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
  /** A writer's review requesting changes on a harness PR, as the corrections pipeline records it. */
  const review = (pr: number, body: string) => {
    const r = reviewCorrections({ pr, issue: pr - 10, title: `Task ${pr - 10}`, reviews: [{ id: pr * 100, author: 'example-owner', state: 'CHANGES_REQUESTED', body, at: new Date().toISOString() }], writers: WRITERS })[0]!;
    log.append('correction.recorded', { key: r.key, kind: r.kind, issue: r.issue, pr: r.pr, by: r.by, text: r.text }, 'coordinator');
  };
  return { base, remote, cfg, log, backlog, c, check, runs, of, review, clock };
}

test('two similar review comments: one constraint with 2 sightings, one draft PR with a test, quoting both; never the harness\'s to merge', async () => {
  const t = fixture();
  t.review(11, "Don't call the payments client from a request handler; it goes through the queue.");
  await t.check();
  assert.equal(t.runs().length, 0, 'one sighting: nothing yet');
  t.review(12, 'Never call the payments client directly in a handler. Use the queue.');
  await t.check();
  assert.equal(t.runs().length, 1);
  const run = t.runs()[0]!;
  assert.ok(!run.allowedTools.includes('Bash'), 'no open shell');
  assert.match(run.prompt, /<evidence>[\s\S]*PR #11[\s\S]*PR #12[\s\S]*<\/evidence>/);
  assert.match(run.prompt, /Write one test/);
  const proposed = t.of('feedback_check.proposed');
  assert.equal(proposed.length, 1);
  assert.deepEqual([proposed[0]!.kind, proposed[0]!.mode, (proposed[0]!.keys as string[]).length], ['pr', 'test', 2]);
  const pr = await t.backlog.pullRequest(proposed[0]!.number as number);
  assert.ok(pr.draft, 'a draft');
  assert.ok(pr.head.startsWith(FEEDBACK_CHECK_BRANCH_PREFIX), pr.head);
  assert.ok(neverAutoMerge({ branch: pr.head, openedByHarness: true }).length > 0, 'its branch never auto-merges');
  assert.equal(t.of('pr.opened').length, 0, 'not recorded as the harness\'s PR: never watched or merged by it');
  const body = (await t.backlog.get(pr.number)).body;
  assert.match(body, /came up 2 times/);
  assert.match(body, /> Don't call the payments client from a request handler/);
  assert.match(body, /> Never call the payments client directly in a handler/);
  assert.deepEqual((await t.backlog.get(pr.number)).labels, [CHECKS_LABEL]);
  // The branch holds the test, signed off, on main.
  assert.equal(git(t.remote, 'show', `${pr.headSha}:test/no-payments-in-handlers.test.js`).includes('handlers never import'), true);
  assert.match(git(t.remote, 'log', '-1', '--format=%B', pr.headSha), /Signed-off-by: /);
  assert.deepEqual(git(t.remote, 'diff', '--name-only', 'main', pr.headSha).split('\n'), ['test/no-payments-in-handlers.test.js']);
  await t.check();
  assert.equal(t.runs().length, 1, 'one proposal per constraint');
});

test('a single sighting makes no proposal', async () => {
  const t = fixture();
  t.review(11, "Don't call the payments client from a request handler; it goes through the queue.");
  t.review(12, 'Add a test for the rounding helper before changing it.');
  await t.check();
  assert.equal(t.runs().length, 0);
  assert.equal(t.of('feedback_check.proposed').length, 0);
  assert.equal((await t.backlog.list(CHECKS_LABEL)).length, 0);
});

test('a constraint about a protected area makes an issue, not a PR, and runs nothing', async () => {
  const t = fixture();
  t.review(11, 'Never edit an applied migration in migrations/001_init.sql; add a new migration file.');
  t.review(12, 'Applied migrations are never edited (migrations/002_users.sql); add a new migration.');
  await t.check();
  assert.equal(t.runs().length, 0);
  const p = t.of('feedback_check.proposed');
  assert.deepEqual([p.length, p[0]!.kind, p[0]!.mode], [1, 'issue', 'issue']);
  const issue = await t.backlog.get(p[0]!.number as number);
  assert.ok(!('pr' in issue && (issue as { pr?: unknown }).pr), 'an issue');
  assert.deepEqual(issue.labels, [CHECKS_LABEL], 'never ready: no agent builds it');
  assert.match(issue.body, /concerns a protected area \(the evidence is about migrations\/001_init\.sql/);
  assert.match(issue.body, /> Never edit an applied migration/);
});

test('a constraint whose PR changed protected files makes an issue too (the evidence\'s files, not just its words)', async () => {
  const t = fixture();
  t.log.append('change.proposed', { issue: 1, branch: 'b', base: 'a'.repeat(40), head: 'b'.repeat(40), files: ['db/migrations/003.sql'], lines: 3, patch_hash: 'h' }, 'coordinator');
  t.review(11, 'Keep every schema change backwards compatible for one release.');
  t.review(12, 'Schema changes stay backwards compatible for a release.');
  await t.check();
  assert.equal(t.runs().length, 0);
  assert.equal(t.of('feedback_check.proposed')[0]!.kind, 'issue');
});

test('the weekly cap holds: at most max_proposals_per_week, the rest next week', async () => {
  const t = fixture(writesTest, { maxPerWeek: 1 });
  t.review(11, "Don't call the payments client from a request handler.");
  t.review(12, 'Never call the payments client from a handler.');
  t.review(13, 'Rounding goes through the money helper, never Math.round.');
  t.review(14, 'Use the money helper for rounding, not Math.round.');
  await t.check();
  await t.check();
  await t.check();
  assert.equal(t.of('feedback_check.proposed').length, 1);
  t.clock.now = new Date(Date.now() + 8 * 24 * 3600_000);
  await t.check();
  assert.equal(t.of('feedback_check.proposed').length, 2, 'the next week');
  await t.check();
  assert.equal(t.of('feedback_check.proposed').length, 2);
});

test('nothing happens when it is off (the default), not even from the tick', async () => {
  const t = fixture(writesTest, { enabled: false });
  t.review(11, "Don't call the payments client from a request handler.");
  t.review(12, 'Never call the payments client from a handler.');
  await t.check();
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.runs().length, 0);
  assert.equal(t.of('feedback_check.proposed').length + t.of('feedback_check.dropped').length, 0);
  assert.equal(loadConfig(join(t.base, 'clone')).project.checks_from_feedback.enabled, false, 'off by default');
});

test('the tick proposes when it is on', async () => {
  const t = fixture();
  t.review(11, "Don't call the payments client from a request handler.");
  t.review(12, 'Never call the payments client from a handler.');
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.of('feedback_check.proposed').length, 1);
});

test('ast-grep configured: a draft rule in its rule dir with test cases from the evidence; a draft outside them is refused', async () => {
  const sgconfig = 'ruleDirs:\n  - rules\ntestConfigs:\n  - testDir: rule-tests\n';
  const t = fixture((req) => {
    mkdirSync(join(req.cwd, 'rules'), { recursive: true });
    mkdirSync(join(req.cwd, 'rule-tests'), { recursive: true });
    writeFileSync(join(req.cwd, 'rules', 'no-payments-in-handlers.yml'), 'id: no-payments-in-handlers\nlanguage: typescript\nseverity: error\nrule:\n  pattern: payments.charge($$$)\n  inside:\n    kind: function_declaration\n    stopBy: end\nmessage: Handlers go through the queue, never the payments client.\n');
    writeFileSync(join(req.cwd, 'rule-tests', 'no-payments-in-handlers-test.yml'), 'id: no-payments-in-handlers\nvalid:\n  - "function h() { queue.push(x) }"\ninvalid:\n  - "function h() { payments.charge(x) }"\n');
    return { title: 'ast-grep: no payments client in handlers', summary: 'Matches payments.charge inside a handler.', not_checkable: '' };
  }, { sgconfig });
  t.review(11, "Don't call the payments client from a request handler.");
  t.review(12, 'Never call the payments client from a handler.');
  await t.check();
  assert.match(t.runs()[0]!.prompt, /This repository uses ast-grep \(sgconfig\.yml\)\. Write one rule YAML in rules\/[\s\S]*test file in rule-tests\//);
  const p = t.of('feedback_check.proposed')[0]!;
  assert.deepEqual([p.kind, p.mode], ['pr', 'ast-grep']);
  const pr = await t.backlog.pullRequest(p.number as number);
  assert.deepEqual(git(t.remote, 'diff', '--name-only', 'main', pr.headSha).split('\n').sort(), ['rule-tests/no-payments-in-handlers-test.yml', 'rules/no-payments-in-handlers.yml']);
  assert.match((await t.backlog.get(pr.number)).body, /a draft ast-grep rule in `rules\/` with its test cases in `rule-tests\/`/);

  const u = fixture((req) => {
    mkdirSync(join(req.cwd, 'src'), { recursive: true });
    writeFileSync(join(req.cwd, 'src', 'handler.js'), 'export {}\n');
    return { title: 'x', summary: 'y', not_checkable: '' };
  }, { sgconfig });
  u.review(11, "Don't call the payments client from a request handler.");
  u.review(12, 'Never call the payments client from a handler.');
  await u.check();
  assert.equal(u.of('feedback_check.proposed').length, 0);
  const d = u.of('feedback_check.dropped')[0]!;
  assert.equal(d.failed, true);
  assert.match(d.why as string, /the draft was refused: only rules\/ and rule-tests\/ may change; it changed src\/handler\.js/);
  await u.check();
  assert.equal(u.runs().length, 1, 'not retried on the same sightings');
});

test('no check fits: dropped with the reason, nothing opened', async () => {
  const t = fixture(() => ({ title: '', summary: '', not_checkable: 'it is about the tone of PR descriptions' }));
  t.review(11, 'PR descriptions should explain the user impact first.');
  t.review(12, 'Explain the user impact first in PR descriptions.');
  await t.check();
  const d = t.of('feedback_check.dropped')[0]!;
  assert.deepEqual([d.failed, d.why], [false, 'no check fits: it is about the tone of PR descriptions']);
  assert.equal((await t.backlog.list(CHECKS_LABEL)).length, 0);
});

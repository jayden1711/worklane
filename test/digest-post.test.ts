// #121: the coordinator posts the "waiting on you" digest once a day, to one issue, as a comment; each digest's
// "merged since" starts at the previous post.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { DIGEST_LABEL, digestTime, maybePostDigest } from '../src/coordinator/digest.js';
import { EventLog } from '../src/events/log.js';
import { FakeRunner } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (c: string) => c.repeat(40);

function setup(times: string[]) {
  const base = mkdtempSync(join(tmpdir(), 'digest-'));
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  cfg.project.reports.times = times;
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const post = (now: Date) => maybePostDigest({ log, backlog, project: cfg.project, now, emit: (p) => log.append('digest.posted', p, 'coordinator') });
  return { base, cfg, log, backlog, post };
}

const merged = (log: EventLog, issue: number, number: number, title: string) => {
  log.append('issue.seen', { issue, title, labels: [], author: 'example-owner', owner: null, actionable: true, why: '' }, 'coordinator');
  log.append('merge.done', { issue, number, head: sha('a'), sha: sha('b'), url: `https://example.invalid/pull/${number}`, title }, 'coordinator');
};

test('digest: posted once a day after the first report time, to one labelled issue, mentioning who reports go to', async () => {
  assert.equal(digestTime(['18:00', '08:00']), '08:00');
  assert.equal(digestTime([]), '08:00');
  const t = setup(['23:59']);
  assert.equal(await t.post(new Date(2026, 9, 12, 0, 30)), null, 'not before the time');
  assert.deepEqual(await t.backlog.list(DIGEST_LABEL), []);

  const a = setup(['00:00']);
  a.log.append('decision.asked', { id: 'd-7-abc', kind: 'question', issue: 7, owner: 'example-owner', question: 'Which unit?', options: ['cents', 'dollars'], recommendation: 'cents', receipts: [] }, 'coordinator');
  const now = new Date(Date.now() + 3_600_000);
  const issue = await a.post(now);
  assert.ok(issue !== null);
  const issues = await a.backlog.list(DIGEST_LABEL);
  assert.deepEqual(issues.map((i) => i.number), [issue]);
  const body = (await a.backlog.comments(issue!)).at(-1)!.body;
  assert.match(body, /^## Waiting on you/);
  assert.match(body, /#7: .*Which unit\?/);
  assert.match(body, new RegExp(`@${a.cfg.project.owners.default}\\b`));
  assert.equal(await a.post(now), null, 'once a day');
  assert.equal((await a.backlog.comments(issue!)).length, 1);
  assert.deepEqual(a.log.read(0, ['digest.posted']).map((e) => (e.payload as { issue: number; items: number }).items), [1]);
});

test('digest: the next day goes to the same issue, and its "merged since" starts at the previous post', async () => {
  const t = setup(['00:00']);
  merged(t.log, 3, 30, 'Before the first digest');
  const first = await t.post(new Date(Date.now() + 3_600_000));
  assert.match((await t.backlog.comments(first!)).at(-1)!.body, /#30 for #3 Before the first digest/);
  await new Promise((r) => setTimeout(r, 5));
  merged(t.log, 4, 40, 'After the first digest');
  const second = await t.post(new Date(Date.now() + 25 * 3_600_000));
  assert.equal(second, first, 'one issue');
  const body = (await t.backlog.comments(second!)).at(-1)!.body;
  assert.match(body, /#40 for #4 After the first digest/);
  assert.doesNotMatch(body, /#30/, 'already in the previous digest');
});

test('digest: the coordinator posts it on its tick', async () => {
  const base = mkdtempSync(join(tmpdir(), 'digest-tick-'));
  const repo = join(base, 'repo');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  cfg.project.reports.times = ['00:00'];
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 1 }));
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const c = new Coordinator({ cfg, log, backlog, runner: new FakeRunner(() => ({})), repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  await c.tick();
  assert.equal(log.read(0, ['digest.posted']).length, 1);
  const [issue] = await backlog.list(DIGEST_LABEL);
  assert.ok(issue);
  assert.match((await backlog.comments(issue.number)).at(-1)!.body, /^## Waiting on you/);
});

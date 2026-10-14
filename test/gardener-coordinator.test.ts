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
import { EventLog } from '../src/events/log.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DRAFT = ['**Outcome:** One rounding helper.', '**Sources:** src/money.js and its callers.', '**Constraints:** No behavior change.', '**Deliverable:**', '```done_when', '- command: |', '    node --test', '```', '**Review point:** L1; waits for the owner if it touches money paths.'].join('\n');
const finding = (pattern: string, where: string[], fix = true) => ({ pattern, kind: 'duplication', where, detail: `${pattern} detail`, fix_title: fix ? `Fix ${pattern}` : '', fix_body: fix ? DRAFT : '' });

function fixture(answer: (req: RunRequest) => object, edit: (cfg: ReturnType<typeof loadConfig>) => void = () => {}) {
  const base = mkdtempSync(join(tmpdir(), 'gardener-'));
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
  cfg.project.gardener = { enabled: true, every_days: 7, at: '03:00', max_usd: 2, max_prs: 1 };
  edit(cfg);
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const clock = { now: new Date(2026, 9, 12, 3, 30) };
  const runner = new FakeRunner((req) => ({ structured: answer(req), costUsd: 0.4 }));
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, now: () => clock.now, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  const check = async () => {
    await c.checkGardener();
    await c.idle();
  };
  const runs = () => runner.calls.filter((r) => r.role === 'gardener');
  const of = (type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never) => log.read(0, [type]).map((e) => e.payload as Record<string, unknown>);
  return { cfg, log, backlog, c, check, runs, of, clock };
}

test('a due run is read-only and capped; every finding goes to one log issue; a fix is filed only for a pattern seen 3+ times, never in a protected path, at most max_prs', async () => {
  const t = fixture(() => ({
    findings: [
      finding('hand-rolled-rounding', ['src/cart.js', 'src/invoice.js', 'src/refund.js']),
      finding('copy-paste-retry', ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']),
      finding('once', ['src/x.js']),
      finding('migration-dup', ['migrations/1.sql', 'migrations/2.sql', 'migrations/3.sql']),
    ],
  }));
  await t.check();
  const run = t.runs()[0]!;
  assert.ok(run.disallowedTools?.includes('Edit') && !run.allowedTools.includes('Bash'), 'read-only');
  assert.ok(run.maxBudgetUsd <= 2, `capped at max_usd: ${run.maxBudgetUsd}`);
  assert.deepEqual(t.of('gardener.filed').map((p) => p.pattern), ['copy-paste-retry'], 'the most-seen one, within max_prs 1');
  const fix = await t.backlog.get(t.of('gardener.filed')[0]!.issue as number);
  assert.deepEqual(fix.labels, ['gardener'], 'never ready: the owner chooses what gets built');
  const done = t.of('gardener.run')[0]!;
  assert.deepEqual([done.outcome, done.findings, done.filed], ['done', 4, [fix.number]]);
  const log = await t.backlog.get(done.log_issue as number);
  assert.deepEqual(log.labels, ['gardener-log']);
  const entry = (await t.backlog.comments(log.number)).at(-1)!.body;
  assert.match(entry, /\*\*copy-paste-retry\*\*.* → fix filed as #/);
  assert.match(entry, /\*\*once\*\*.*seen 1 time\(s\); a fix is filed from 3/);
  assert.match(entry, /\*\*migration-dup\*\*.*high-risk or safety-floor path: logged only/);
  assert.match(entry, /\*\*hand-rolled-rounding\*\*.*over this run's limit of 1/);
});

test("the next week's run counts sightings across runs, files each pattern once, and appends to the same log issue", async () => {
  let n = 0;
  const t = fixture(() => (++n === 1 ? { findings: [finding('slow-path', ['src/a.js', 'src/b.js'])] } : { findings: [finding('slow-path', ['src/c.js']), finding('copy-paste-retry', ['1', '2', '3'])] }), (cfg) => void (cfg.project.gardener.max_prs = 5));
  await t.check();
  assert.equal(t.of('gardener.filed').length, 0, 'seen twice');
  await t.check();
  assert.equal(t.runs().length, 1, 'not due again the same week');
  t.clock.now = new Date(2026, 9, 19, 3, 20);
  await t.check();
  assert.deepEqual(t.of('gardener.filed').map((p) => p.pattern).sort(), ['copy-paste-retry', 'slow-path'], 'a third place next week makes it 3');
  const [first, second] = t.of('gardener.run');
  assert.equal(first!.log_issue, second!.log_issue, 'one log issue');
  assert.equal((await t.backlog.list('gardener-log')).length, 1);
  t.clock.now = new Date(2026, 9, 26, 3, 20);
  await t.check();
  assert.equal(t.of('gardener.filed').length, 2, 'never filed twice');
});

test('off by default, and never outside its off-hours slot', async () => {
  const t = fixture(() => ({ findings: [] }), (cfg) => void (cfg.project.gardener.enabled = false));
  await t.check();
  const u = fixture(() => ({ findings: [] }));
  u.clock.now = new Date(2026, 9, 12, 14, 0);
  await u.check();
  assert.equal(t.runs().length + u.runs().length, 0);
});

test('the tick starts the gardener', async () => {
  const t = fixture(() => ({ findings: [] }));
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.of('gardener.run').length, 1);
});

test("the owner chooses which gardener fixes get built (filed without ready), while a correction's fix is filed ready", async () => {
  const t = fixture(() => ({ findings: [finding('copy-paste-retry', ['src/a.js', 'src/b.js', 'src/c.js'])] }));
  await t.check();
  const filed = await t.backlog.get(t.of('gardener.filed')[0]!.issue as number);
  assert.ok(!filed.labels.includes('ready'), JSON.stringify(filed.labels));
  assert.deepEqual(await t.backlog.list('ready'), [], 'nothing the dispatcher would pick up');
  // A correction on the same instance: its fix is still filed ready.
  const c = fixture((req) => (req.role === 'corrections' ? { same_as: '', fix_kind: 'check', why_not_stronger: 'a lint is the strongest that fits', title: 'Lint: no payments client in handlers', body: DRAFT, why: 'the lint fails on it' } : { findings: [] }), (cfg) => void (cfg.project.gardener.enabled = false));
  c.log.append('plan.decided', { issue: 7, decision: 'd-1', answer: 'reject', by: 'example-owner', note: 'never call payments from a handler' }, 'test');
  await c.c.checkCorrections();
  await c.c.idle();
  const fix = (await c.backlog.list('correction'))[0]!;
  assert.deepEqual(fix.labels.sort(), ['correction', 'ready']);
});

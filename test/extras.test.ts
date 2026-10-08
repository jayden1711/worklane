import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { runExtras, securityReview, type ExtraCtx } from '../src/extras.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function fixture(script: (req: RunRequest) => object = () => ({})) {
  const { dir } = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'extras-'));
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  const cfg = loadConfig(dir);
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const runner = new FakeRunner((req) => ({ structured: script(req) }));
  let held: string | null = null;
  let now = new Date('2026-10-08T12:00:00Z');
  const prs: { branch: string; file: string; content: string }[] = [];
  const ctx: ExtraCtx = {
    cfg,
    log,
    backlog,
    runner,
    repo: dir,
    stateDir: join(base, 'state'),
    branch: 'main',
    remote: 'origin',
    emit: (type, payload) => log.append(type, payload, 'coordinator'),
    git,
    sh: async (command, cwd) => {
      try {
        execFileSync('sh', ['-c', command], { cwd, stdio: 'ignore' });
        return { code: 0, tail: '' };
      } catch (e) {
        return { code: (e as { status?: number }).status ?? 1, tail: 'check failed' };
      }
    },
    hold: () => held,
    budgetLeft: () => 10,
    now: () => now,
  };
  const pr = async (branch: string, file: string, content: string) => (prs.push({ branch, file, content }), `file://pr/${prs.length}`);
  const enable = (role: string, extra: object = {}) => {
    cfg.agents.roles[role as 'security'] = { enabled: true, model: 'sonnet', ...extra };
  };
  return { dir, cfg, log, backlog, runner, ctx, pr, prs, enable, hold: (h: string | null) => (held = h), at: (iso: string) => (now = new Date(iso)) };
}

const commit = (dir: string, file: string, msg: string) => {
  writeFileSync(join(dir, file), msg);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

test('every optional role is off by default: a pass runs no agent', async () => {
  const f = fixture();
  for (const r of ['security', 'red_attributor', 'ci_repair', 'qa_playtester', 'monitor', 'release_prep'] as const) assert.notEqual(f.cfg.agents.roles[r]?.enabled, true, `${r} must default off`);
  await runExtras(f.ctx, f.pr);
  const head = git(f.dir, 'rev-parse', 'HEAD');
  assert.deepEqual(await securityReview(f.ctx, { issue: 1, path: f.dir, base: head, head, categories: ['money-path'] }), { requested: null, receipts: [] });
  assert.equal(f.runner.calls.length, 0);
});

test('security: reviews only its categories, read-only; findings set the floor; a reviewer that writes is a block', async () => {
  let behave: 'clear-but-high' | 'concerns' | 'tamper' = 'clear-but-high';
  const f = fixture((req) => {
    if (behave === 'tamper') writeFileSync(join(req.cwd, 'sneaky.txt'), 'x');
    if (behave === 'concerns') return { verdict: 'concerns', findings: [{ severity: 'medium', file: 'src/pay.js', issue: 'no rate limit', evidence: 'src/pay.js:4' }] };
    return { verdict: 'clear', findings: [{ severity: 'high', file: 'src/pay.js', issue: 'missing ownership check', evidence: 'src/pay.js:9' }] };
  });
  f.enable('security', { applies_to: ['money-path'] });
  const base = git(f.dir, 'rev-parse', 'HEAD');
  const head = commit(f.dir, 'pay.txt', 'pay');
  const t = { issue: 3, path: f.dir, base, head };
  assert.equal((await securityReview(f.ctx, { ...t, categories: ['ui'] })).requested, null, 'not its category: no run');
  assert.equal(f.runner.calls.length, 0);
  const r1 = await securityReview(f.ctx, { ...t, categories: ['money-path'] });
  assert.equal(r1.requested, 'L3', 'a high finding blocks even if the verdict says clear');
  assert.ok(r1.receipts.some((x) => /missing ownership check/.test(x)));
  assert.deepEqual(f.runner.calls[0]!.disallowedTools, ['Edit', 'Write', 'NotebookEdit']);
  assert.ok(!f.runner.calls[0]!.allowedTools.some((x) => x === 'Bash' || /^(Edit|Write)/.test(x)), 'read-only tools only');
  behave = 'concerns';
  assert.equal((await securityReview(f.ctx, { ...t, categories: ['money-path'] })).requested, 'L2');
  behave = 'tamper';
  const r3 = await securityReview(f.ctx, { ...t, categories: ['money-path'] });
  assert.equal(r3.requested, 'L3');
  assert.match(r3.receipts.join(), /changed the worktree/);
  f.hold('machine load 50 > 40');
  assert.equal((await securityReview(f.ctx, { ...t, categories: ['money-path'] })).requested, 'L3', 'no review possible: a human decides');
});

test('red attributor: one landing in the window is blamed without an agent; owner told, red issue filed, once', async () => {
  const f = fixture();
  f.enable('red_attributor');
  const a = git(f.dir, 'rev-parse', 'HEAD');
  const b = commit(f.dir, 'x.txt', 'break things');
  f.log.append('baseline.recorded', { sha: a, failing: ['old flake'] }, 'c');
  const n = f.backlog.open({ title: 'Change totals', body: '', author: 'example-owner', labels: [] });
  f.log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base: a, owner: 'example-collaborator' }, 'c');
  f.log.append('land.result', { issue: n, outcome: 'landed', landed: b, detail: '' }, 'c');
  f.log.append('baseline.recorded', { sha: b, failing: ['old flake', 'checkout totals'] }, 'c');
  await runExtras(f.ctx, f.pr);
  await runExtras(f.ctx, f.pr);
  assert.equal(f.runner.calls.length, 0, 'single candidate: no agent run');
  assert.match((await f.backlog.comments(n))[0]!.body, /@example-collaborator main has new failures[\s\S]*checkout totals/);
  const red = await f.backlog.list('red');
  assert.equal(red.length, 1, 'filed once');
  assert.ok(red[0]!.labels.includes('triage'), 'a writer decides whether to work it');
});

test('red attributor: several landings go to the agent, which may say unknown', async () => {
  const f = fixture(() => ({ attributions: [{ failure: 'checkout totals', commit: 'unknown', confidence: 'low', evidence: 'no overlap' }] }));
  f.enable('red_attributor');
  const a = git(f.dir, 'rev-parse', 'HEAD');
  const b = commit(f.dir, 'x.txt', 'one');
  const c = commit(f.dir, 'y.txt', 'two');
  f.log.append('baseline.recorded', { sha: a, failing: [] }, 'c');
  f.log.append('land.result', { issue: 1, outcome: 'landed', landed: b, detail: '' }, 'c');
  f.log.append('land.result', { issue: 2, outcome: 'landed', landed: c, detail: '' }, 'c');
  f.log.append('baseline.recorded', { sha: c, failing: ['checkout totals'] }, 'c');
  await runExtras(f.ctx, f.pr);
  assert.equal(f.runner.calls.length, 1);
  assert.match(f.runner.calls[0]!.prompt, /one\n|two/);
  assert.equal((await f.backlog.list('red'))[0]!.title, 'New failures on main (cause unknown)');
});

test('CI repair: a red tip gets one diagnosed triage issue with a contract; pending and green get nothing', async () => {
  const f = fixture(() => ({ title: 'Lint fails on main', body: 'eslint: no-unused-vars in src/a.js:3', done_when: ['command: npm run lint'] }));
  f.enable('ci_repair', { max_fixes_per_pr: 1 });
  const tip = git(f.dir, 'rev-parse', 'HEAD');
  f.backlog.setCi(tip, { state: 'pending', failing: [] });
  await runExtras(f.ctx, f.pr);
  assert.equal(f.runner.calls.length, 0);
  f.backlog.setCi(tip, { state: 'failure', failing: [{ name: 'lint', url: 'https://ci.example/1' }] });
  await runExtras(f.ctx, f.pr);
  await runExtras(f.ctx, f.pr);
  const ci = await f.backlog.list('ci');
  assert.equal(ci.length, 1, 'one issue per failing tip');
  assert.match(ci[0]!.body, /```done_when\n- command: npm run lint\n```/);
  assert.ok(!ci[0]!.labels.includes('ready'), 'never self-approved');
  // A new red tip while one CI issue is open: capped.
  commit(f.dir, 'z.txt', 'more');
  git(f.dir, 'push', '-q', 'origin', 'main');
  f.backlog.setCi(git(f.dir, 'rev-parse', 'HEAD'), { state: 'failure', failing: [{ name: 'lint', url: 'u' }] });
  await runExtras(f.ctx, f.pr);
  assert.equal((await f.backlog.list('ci')).length, 1);
  assert.equal(f.runner.calls.length, 1);
});

test('QA playtester: plays each verified test deployment once, never production; repeat bugs are not re-filed', async () => {
  const f = fixture(() => ({ bugs: [{ title: 'Cart total wrong after removing an item', steps: '1. add 2. remove', expected: '$5', actual: '$10', severity: 'high', evidence: 'shot.png' }] }));
  f.enable('qa_playtester', { max_per_day: 5 });
  f.cfg.deploy = { version: 1, environments: [{ name: 'staging', verify: 'true', production: false }, { name: 'prod', verify: 'true', production: true }] };
  f.log.append('deploy.verified', { env: 'prod', sha: 'f'.repeat(40) }, 'c');
  await runExtras(f.ctx, f.pr);
  assert.equal(f.runner.calls.length, 0, 'production is never playtested');
  f.log.append('deploy.verified', { env: 'staging', sha: 'a'.repeat(40) }, 'c');
  await runExtras(f.ctx, f.pr);
  await runExtras(f.ctx, f.pr);
  f.log.append('deploy.verified', { env: 'staging', sha: 'b'.repeat(40) }, 'c');
  await runExtras(f.ctx, f.pr);
  assert.equal(f.runner.calls.length, 2, 'once per verified commit');
  assert.equal((await f.backlog.list('qa')).length, 1, 'same bug, filed once');
});

test('monitor: on schedule, a failing check opens an incident with a diagnosis; recovery is noted', async () => {
  const f = fixture(() => ({ diagnosis: 'the health endpoint returns 502', check_first: 'the web service logs' }));
  f.enable('monitor', { every_minutes: 30 });
  const flag = join(f.dir, 'healthy');
  writeFileSync(flag, '');
  f.cfg.deploy = { version: 1, environments: [{ name: 'staging', verify: `test -f ${flag}`, production: false }] };
  f.log.append('deploy.verified', { env: 'staging', sha: 'a'.repeat(40) }, 'c');
  await runExtras(f.ctx, f.pr);
  assert.equal((await f.backlog.list('incident')).length, 0);
  execFileSync('rm', [flag]);
  f.at('2026-10-08T12:10:00Z');
  await runExtras(f.ctx, f.pr);
  assert.equal((await f.backlog.list('incident')).length, 0, 'not due yet');
  f.at('2026-10-08T12:31:00Z');
  await runExtras(f.ctx, f.pr);
  const inc = await f.backlog.list('incident');
  assert.equal(inc.length, 1);
  assert.match(inc[0]!.body, /health endpoint returns 502/);
  f.at('2026-10-08T13:05:00Z');
  await runExtras(f.ctx, f.pr);
  assert.equal((await f.backlog.list('incident')).length, 1, 'still failing: no second incident');
  writeFileSync(flag, '');
  f.at('2026-10-08T13:40:00Z');
  await runExtras(f.ctx, f.pr);
  assert.match((await f.backlog.comments(inc[0]!.number)).at(-1)!.body, /passes again/);
});

test('release prep: notes for changes since the last tag, as a PR, once a day; never tags', async () => {
  const f = fixture(() => ({ notes: '### Fixed\n- Totals ignore negative quantities (#1)' }));
  f.enable('release_prep');
  git(f.dir, 'tag', 'v1.0.0');
  git(f.dir, 'push', '-q', 'origin', 'v1.0.0');
  await runExtras(f.ctx, f.pr);
  assert.equal(f.prs.length, 0, 'nothing since the tag');
  commit(f.dir, 'fix.txt', 'Fix totals');
  git(f.dir, 'push', '-q', 'origin', 'main');
  await runExtras(f.ctx, f.pr);
  await runExtras(f.ctx, f.pr);
  assert.equal(f.prs.length, 1);
  assert.match(f.prs[0]!.content, /since v1\.0\.0[\s\S]*Totals ignore negative/);
  assert.match(f.runner.calls[0]!.prompt, /Fix totals/);
  assert.deepEqual(git(f.dir, 'tag').split('\n'), ['v1.0.0'], 'no tag created');
});

test('governor hold: a held role does not run and is retried later, not marked done', async () => {
  const f = fixture(() => ({ title: 't', body: 'b', done_when: [] }));
  f.enable('ci_repair');
  const tip = git(f.dir, 'rev-parse', 'HEAD');
  f.backlog.setCi(tip, { state: 'failure', failing: [{ name: 'test', url: 'u' }] });
  f.hold('daily budget $40 reached');
  await runExtras(f.ctx, f.pr);
  assert.equal(f.runner.calls.length, 0);
  assert.equal((await f.backlog.list('ci')).length, 0);
  f.hold(null);
  await runExtras(f.ctx, f.pr);
  assert.equal((await f.backlog.list('ci')).length, 1);
});

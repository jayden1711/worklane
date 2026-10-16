// Research on demand, wired: a worker or evaluator that returns a research request gets the researcher's cited
// answer (within the day's caps and the per-task limit) and its task resumes with it; the asking agent never
// gets web access, and a resumed run is not another attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { researchUsageToday } from '../src/research.js';
import { defaultRolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from '../src/roles.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type FakeResult, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { stageOf } from '../src/throughput.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
const QUESTION = 'What does the payments API return for an order line with quantity zero?';
const ASK = { question: QUESTION, why: 'the fix depends on whether zero lines are billed' };
const DOCS = 'https://docs.example.com/payments/lines';
const REPORT = { report: `Zero-quantity lines are accepted and billed at nothing ([docs](${DOCS})).`, sources: [{ url: DOCS, title: 'Order lines' }] };

const fix = (cwd: string) => {
  const p = join(cwd, 'src', 'price.js');
  writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
  git(cwd, 'add', '-A');
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
};
const answered = (req: RunRequest) => req.prompt.includes('## Research you asked for');
const pass = (req: RunRequest): FakeResult => {
  const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)![1]!;
  return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean), design_change: false } };
};

/** Scripted agents: `worker` and `verdict` decide per call; the researcher always reports with a source. */
function agents(o: { worker?: (req: RunRequest) => FakeResult; verdict?: (req: RunRequest) => FakeResult; researcher?: () => FakeResult } = {}) {
  return new FakeRunner((req) => {
    if (req.role === 'researcher') return o.researcher?.() ?? { structured: REPORT };
    if (req.role === 'evaluator-repro') return { structured: { test_path: '', explanation: '', not_reproducible: 'covered by the existing test' } };
    if (req.role === 'worker') {
      if (o.worker) return o.worker(req);
      fix(req.cwd);
      return { structured: { summary: 'fixed' } };
    }
    return (o.verdict ?? pass)(req);
  });
}

async function run(runner: FakeRunner, o: { before?: (log: EventLog) => void } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'research-od-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'pr';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const log = new EventLog(join(base, 'events.db'));
  o.before?.(log);
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const n = backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg, log, backlog, runner, repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await c.idle();
  const roles = (role: string) => runner.calls.filter((r) => r.role === role);
  const requested = log.read(0, ['research.requested']).map((e) => e.payload as { role: string; question: string; held: string | null });
  const costs = log.read(0, ['run.cost']).map((e) => (e.payload as { role: string }).role);
  return { log, backlog, n, roles, requested, costs };
}

test('worker: a research request gets the cited answer and the same attempt resumes with it; no attempt is spent', { skip }, async () => {
  const t = await run(agents({ worker: (req) => (answered(req) ? (fix(req.cwd), { structured: { summary: 'fixed, per the docs' } }) : { structured: { summary: 'need the API behavior', research_request: ASK } }) }));
  assert.deepEqual(t.requested.map((r) => [r.role, r.question, r.held]), [['worker', QUESTION, null]]);
  assert.equal(t.roles('researcher').length, 1);
  const [first, resumed] = t.roles('worker');
  assert.ok(first && resumed, 'resumed');
  assert.ok(!first.allowedTools?.some((x) => /^Web/.test(x)) && !resumed.allowedTools?.some((x) => /^Web/.test(x)), 'the worker never gets web tools');
  assert.match(resumed.prompt, /## Research you asked for/);
  assert.match(resumed.prompt, /web data/);
  assert.ok(resumed.prompt.includes(QUESTION) && resumed.prompt.includes(DOCS), 'the question and its cited source');
  assert.ok(t.costs.includes('research-on-demand'));
  const started = t.log.read(0, ['run.started']).map((e) => e.payload as { role: string; resumed?: string }).filter((p) => p.role === 'worker');
  assert.deepEqual(started.map((p) => p.resumed ?? null), [null, 'research']);
  assert.equal(t.log.read(0, ['eval.verdict']).length, 1, 'with one attempt allowed, the resumed run still went on to evaluation');
  assert.ok((await t.backlog.comments(t.n)).some((c) => c.body.includes('Research report') && c.body.includes(DOCS)), 'the answer and its sources are on the issue');
});

test('worker: a request held by the day\'s research cap is not run; the worker resumes told why, to go on without it', { skip }, async () => {
  const t = await run(agents({ worker: (req) => (answered(req) ? (fix(req.cwd), { structured: { summary: 'fixed' } }) : { structured: { summary: 'need docs', research_request: ASK } }) }), {
    before: (log) => log.append('run.cost', { issue: null, role: 'research-on-demand', model: 'sonnet', usd: 5, turns: 1 }, 'coordinator'),
  });
  assert.equal(t.roles('researcher').length, 0);
  assert.match(t.requested[0]!.held ?? '', /spent today reaches the cap/);
  assert.match(t.roles('worker')[1]!.prompt, /Not answered: research: \$5\.00 spent today/);
});

test('worker: a request that looks like it carries a secret never reaches the web', { skip }, async () => {
  const leaky = { question: `Why does the API reject token ghp_${'a'.repeat(36)} for line totals?`, why: 'the fix depends on it' };
  const t = await run(agents({ worker: (req) => (answered(req) ? (fix(req.cwd), { structured: { summary: 'fixed' } }) : { structured: { summary: 'need docs', research_request: leaky } }) }));
  assert.equal(t.roles('researcher').length, 0);
  assert.match(t.requested[0]!.held ?? '', /looks like a secret/);
  assert.doesNotMatch(JSON.stringify(t.requested), /ghp_a{36}/, 'not even in the log');
});

test('worker: at most two requests per task; a third is not answered and the output stands', { skip }, async () => {
  let calls = 0;
  const t = await run(agents({ worker: () => ({ structured: { summary: `still unsure ${++calls}`, research_request: ASK } }) }));
  assert.equal(t.roles('researcher').length, 2);
  assert.equal(t.roles('worker').length, 3);
});

test('evaluator: a research request is answered and the evaluator judges again with the answer', { skip }, async () => {
  const t = await run(agents({ verdict: (req) => (answered(req) ? pass(req) : { structured: { ...(pass(req).structured as object), research_request: ASK } }) }));
  assert.deepEqual(t.requested.map((r) => [r.role, r.held]), [['evaluator', null]]);
  const verdicts = t.roles('evaluator-verdict');
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts[1]!.prompt.includes(DOCS));
  assert.ok(!verdicts.some((r) => r.allowedTools?.some((x) => /^Web/.test(x))), 'the evaluator never gets web tools');
});

test('on-demand research counts against the daily research spend, books to the research stage, and both agents may ask', () => {
  const day = new Date().toISOString().slice(0, 10);
  const ts = `${day}T10:00:00.000Z`;
  assert.equal(researchUsageToday([{ type: 'run.cost', ts, payload: { role: 'research-on-demand', usd: 1.5 } }, { type: 'run.cost', ts, payload: { role: 'researcher', usd: 0.5 } }], day).usd, 2);
  assert.equal(stageOf('research-on-demand'), 'research');
  for (const schema of [WORKER_SCHEMA, VERDICT_SCHEMA]) assert.deepEqual((schema.properties as unknown as Record<string, { required?: string[] }>).research_request?.required, ['question', 'why']);
  for (const role of ['worker', 'evaluator-verdict']) assert.match(defaultRolePrompt(role), /set "research_request" with one precise question/);
});

// The pre-deploy gate (src/deploy-gate/, docs/deploy-gate.md): a deploy branch fast-forwarded only to default-branch
// commits green on every gate tier, never forced; refused (with an incident) when it moved off the default branch's
// line; off by default; and an owner's `deploy <sha>` override from Discord, confirmed first, fast-forward only,
// audited. Real git (a bare remote and a clone); GitHub and Discord are fakes.
import { passGate } from '../src/testrun/gate.js';
import { GATE_MODES, guardGate } from './gate-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { TestsConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { parseDeployCommand } from '../src/coordinator/deploy-commands.js';
import { DeployGateConfig, DEPLOY_GATE_INCIDENT } from '../src/deploy-gate/config.js';
import { DeployGate, deployGateView, refUpdateBody, type DeployRefs, type RefResult } from '../src/deploy-gate/gate.js';
import { gateGit, githubDeployRefs, setupDeployGate } from '../src/deploy-gate/wire.js';
import { EventLog } from '../src/events/log.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { FakeRunner } from '../src/runner.js';
import { tiersFor, type TestRunRequest, type TestRunResult } from '../src/testrun/index.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

/** A bare remote with main (c1 <- c2) and deploy at c1, and the coordinator's clone of it. */
function repos() {
  const base = mkdtempSync(join(tmpdir(), 'deploy-gate-'));
  const work = join(base, 'work');
  const bare = join(base, 'origin.git');
  const clone = join(base, 'clone');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  const commit = (name: string) => {
    writeFileSync(join(work, name), name);
    git(work, 'add', name);
    git(work, ...ID, 'commit', '-q', '-m', name);
    return git(work, 'rev-parse', 'HEAD');
  };
  const c1 = commit('one');
  const c2 = commit('two');
  git(base, 'clone', '-q', '--bare', work, bare);
  git(bare, 'update-ref', 'refs/heads/deploy', c1);
  git(base, 'clone', '-q', bare, clone);
  const push = () => git(work, 'push', '-q', bare, 'main');
  return { base, work, bare, clone, c1, c2, commit, push };
}

/** The deploy branch's writes, applied to the bare remote the way GitHub would: a fast-forward only. */
function fakeRefs(bare: string) {
  const calls: { kind: 'ff' | 'create'; sha: string; body: unknown }[] = [];
  const refs: DeployRefs & { calls: typeof calls } = {
    calls,
    fastForward: async (sha): Promise<RefResult> => {
      const body = refUpdateBody(sha);
      calls.push({ kind: 'ff', sha, body });
      const cur = git(bare, 'rev-parse', 'refs/heads/deploy');
      try {
        git(bare, 'merge-base', '--is-ancestor', cur, sha);
      } catch {
        return { ok: false, status: 422, message: 'Update is not a fast forward' };
      }
      git(bare, 'update-ref', 'refs/heads/deploy', sha, cur);
      return { ok: true };
    },
    create: async (sha): Promise<RefResult> => {
      calls.push({ kind: 'create', sha, body: { ref: 'refs/heads/deploy', sha } });
      git(bare, 'update-ref', 'refs/heads/deploy', sha, '');
      return { ok: true };
    },
  };
  return refs;
}

/** The gate's config, on (parsed per use, so a schema change fails the tests that use it, not the whole file). */
const GATE = () => DeployGateConfig.parse({ enabled: true, branch: 'deploy', tiers: ['chain', 'suite'] });

/** A test run's result: each named tier passes unless it is in `red`. */
const result = (req: TestRunRequest, red: string[] = []): TestRunResult => ({
  id: `full-${req.sha.slice(0, 8)}`,
  sha: req.sha,
  kind: req.kind,
  ok: !(req.tiers ?? []).some((t) => red.includes(t)),
  outcome: 'done',
  tiers: (req.tiers ?? []).map((t) => ({ tier: t, ok: !red.includes(t), durationMs: 10, summary: '', logRef: '' })),
});

function gate(o: { red?: string[]; config?: DeployGateConfig; gated?: boolean } = {}) {
  const r = repos();
  const log = new EventLog(join(r.base, 'events.db'));
  const stateDir = join(r.base, 'state');
  mkdirSync(stateDir);
  const refs = fakeRefs(r.bare);
  const incidents: { op: 'raise' | 'resolve'; kind: string; key: string; detail?: string }[] = [];
  const runs: TestRunRequest[] = [];
  const posted: { sha: string; ok: boolean }[] = [];
  const g = new DeployGate({
    config: o.config ?? GATE(),
    defaultBranch: 'main',
    git: gateGit(r.clone, 'origin', 'main', 'deploy'),
    refs,
    log,
    actor: 'coordinator',
    stateDir,
    repo: r.clone,
    // WHY: gated, the run goes through the start gate first, as runTestRun (the only start of a run) does.
    start: async (req) => (o.gated ? passGate() : undefined, runs.push(req), result(req, o.red)),
    post: async (sha, res) => void posted.push({ sha, ok: res.ok }),
    incidents: { raiseIncident: (kind, key, detail) => void incidents.push({ op: 'raise', kind, key, detail }), resolveIncident: (kind, key) => void incidents.push({ op: 'resolve', kind, key }) },
    pollMs: 0,
  });
  const deployAt = () => git(r.bare, 'rev-parse', 'refs/heads/deploy');
  const of = (type: string) => log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);
  return { ...r, log, stateDir, refs, incidents, runs, posted, g, deployAt, of };
}

// ---------------------------------------------------------------- the gate

test('deploy gate: every tier green on the exact main commit fast-forwards deploy to it (force false)', async () => {
  const t = gate();
  await t.g.step();
  await t.g.idle();
  assert.deepEqual(t.runs.map((r) => [r.sha, r.tiers, r.kind, r.prs]), [[t.c2, ['chain', 'suite'], 'full', []]], 'one run of the gate tiers on main\'s tip');
  assert.deepEqual(t.posted, [{ sha: t.c2, ok: true }], 'its checks posted on that commit');
  assert.deepEqual(t.refs.calls, [{ kind: 'ff', sha: t.c2, body: { sha: t.c2, force: false } }]);
  assert.equal(t.deployAt(), t.c2);
  assert.deepEqual(t.of('deploy_gate.moved'), [{ branch: 'deploy', from: t.c1, to: t.c2, by: 'gate', override: false, gate: 'green' }]);
  // The same tip isn't run again.
  await t.g.step();
  await t.g.idle();
  assert.equal(t.runs.length, 1);
  const view = deployGateView(t.stateDir, t.log.read(0), 'example/repo', 'deploy');
  assert.equal(view.deployed?.sha, t.c2);
  assert.equal(view.held, null);
});

test('deploy gate: one tier red holds deploy where it is, and records why', async () => {
  const t = gate({ red: ['suite'] });
  await t.g.step();
  await t.g.idle();
  assert.deepEqual(t.refs.calls, [], 'no ref update at all');
  assert.equal(t.deployAt(), t.c1);
  assert.deepEqual(t.of('deploy_gate.held'), [{ branch: 'deploy', sha: t.c2, deployed: t.c1, reason: 'failed: suite' }]);
  assert.deepEqual(t.posted, [{ sha: t.c2, ok: false }], 'the red checks are posted too');
  const view = deployGateView(t.stateDir, t.log.read(0), 'example/repo', 'deploy');
  assert.equal(view.held?.sha, t.c2);
  assert.equal(view.held?.reason, 'failed: suite');
  assert.equal(view.deployed?.sha, t.c1);
});

test('deploy gate: a green commit not descending from deploy (deploy pushed off main) is refused with an incident', async () => {
  const t = gate();
  // Someone pushes a commit that isn't on main to deploy.
  git(t.work, 'checkout', '-q', '-b', 'side', t.c1);
  writeFileSync(join(t.work, 'side'), 'side');
  git(t.work, 'add', 'side');
  git(t.work, ...ID, 'commit', '-q', '-m', 'side');
  const side = git(t.work, 'rev-parse', 'HEAD');
  git(t.work, 'push', '-q', '--force', t.bare, 'side:deploy');
  await t.g.step();
  await t.g.idle();
  assert.equal(t.deployAt(), side, 'deploy not moved');
  assert.deepEqual(t.refs.calls, [], 'no ref update was even tried');
  assert.ok(t.incidents.some((i) => i.op === 'raise' && i.kind === DEPLOY_GATE_INCIDENT && i.key === 'deploy'), 'a watchdog incident');
  assert.ok(t.of('deploy_gate.refused').length >= 1);
  assert.deepEqual(t.of('deploy_gate.moved'), []);
});

test('deploy gate: never a force update; skipped intermediate commits are fine', async () => {
  assert.deepEqual(refUpdateBody('a'.repeat(40)), { sha: 'a'.repeat(40), force: false });
  assert.throws(() => refUpdateBody('abc'), /full commit/);
  // The real GitHub call: PATCH git/refs/heads/<branch> with force false, and creation by POST (which can't overwrite).
  const seen: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ method: String(init.method), url, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const refs = githubDeployRefs('example/repo', 'deploy', async () => 'token', f, 'https://api.example.test');
  await refs.fastForward('b'.repeat(40));
  await refs.create('c'.repeat(40));
  assert.deepEqual(seen, [
    { method: 'PATCH', url: 'https://api.example.test/repos/example/repo/git/refs/heads/deploy', body: { sha: 'b'.repeat(40), force: false } },
    { method: 'POST', url: 'https://api.example.test/repos/example/repo/git/refs', body: { ref: 'refs/heads/deploy', sha: 'c'.repeat(40) } },
  ]);
  // Two merges while nothing ran: the gate tests the newest tip only and moves straight to it.
  const t = gate();
  t.commit('three');
  const c4 = t.commit('four');
  t.push();
  await t.g.step();
  await t.g.idle();
  assert.deepEqual(t.runs.map((r) => r.sha), [c4]);
  assert.equal(t.deployAt(), c4);
  assert.ok(t.refs.calls.every((c) => (c.body as { force?: unknown }).force === false));
});

test('deploy gate: off by default; when set, it needs test_run and names only its tiers', () => {
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  assert.equal(cfg.tests.deploy_gate, undefined, 'no deploy_gate unless a project sets one');
  const tests = { version: 1, runner: { kind: 'command', changed: 'npm test', full: 'npm test' } };
  const testRun = { tiers: [{ name: 'chain', command: 'npm run chain', kind: 'fast' }, { name: 'suite', command: 'npm test', kind: 'full' }] };
  // Even with test runs set up, no deploy_gate: no gate is built.
  cfg.tests.test_run = TestRunConfig.parse(testRun);
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'deploy-gate-off-')), 'events.db'));
  assert.equal(setupDeployGate(cfg, { repo: 'example/repo', token: async () => 't' }, { log, actor: 'c', root: '/nonexistent', stateDir: '/nonexistent', testRunsReady: true }), undefined, 'no gate is built');
  assert.equal(TestsConfig.safeParse({ ...tests, deploy_gate: { tiers: ['suite'] } }).success, false, 'without test_run: refused');
  const bad = TestsConfig.safeParse({ ...tests, test_run: testRun, deploy_gate: { tiers: ['suite', 'nope'] } });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /no test_run tier named nope/);
  const ok = TestsConfig.parse({ ...tests, test_run: testRun, deploy_gate: { tiers: ['chain', 'suite'] } });
  assert.deepEqual(ok.deploy_gate, { enabled: false, branch: 'deploy', tiers: ['chain', 'suite'], notify: 'ops' });
  assert.equal(DeployGateConfig.safeParse({ branch: '../main', tiers: ['suite'] }).success, false);
  // A run of named tiers runs those, of either kind, and nothing else.
  const tr = TestRunConfig.parse(testRun);
  assert.deepEqual(tiersFor(tr, { kind: 'full', tiers: ['chain', 'suite'] }).map((x) => x.name), ['chain', 'suite']);
  assert.deepEqual(tiersFor(tr, { kind: 'full' }).map((x) => x.name), ['suite']);
});

// ---------------------------------------------------------------- the owner's override from Discord

const OWNER_ID = '100000000001';
const WRITER_ID = '100000000003';
const CHANNEL = '111111';
const OPS = '222222';
const CONFIG = IntakeConfig.parse({
  version: 1,
  discord: {
    enabled: true,
    guild: '300000000001',
    channels: [CHANNEL],
    allowed_senders: [OWNER_ID, WRITER_ID],
    people: { [OWNER_ID]: 'example-owner', [WRITER_ID]: 'example-collaborator' },
    owners: [OWNER_ID],
    ops_channel: OPS,
    dashboard_url: 'https://dashboard.example.test',
  },
});
const ROLES: Record<string, 'owner' | 'writer'> = { 'example-owner': 'owner', 'example-collaborator': 'writer' };

function chat() {
  const posts: { where: string; text: string }[] = [];
  const threads: { channel: string; text: string; name: string; id: string }[] = [];
  const batches: IncomingReport[][] = [];
  const src: IntakeSource & { posts: typeof posts; threads: typeof threads; batches: typeof batches } = {
    name: 'discord',
    posts,
    threads,
    batches,
    take: async () => batches.shift() ?? [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async (channel, text, name) => {
      const id = String(900000 + threads.length);
      threads.push({ channel, text, name, id });
      return id;
    },
    watch: () => {},
  };
  return src;
}

let seq = 0;
const msg = (from: string, where: { kind: 'channel' | 'thread'; id: string }, text: string): IncomingReport => ({
  source: 'discord',
  sourceId: `4000000000${++seq}`,
  sender: { source: 'discord', id: from },
  text,
  receivedAt: '2026-10-01T10:00:00.000Z',
  thread: where,
});

function overrideSetup(o: { red?: string[]; config?: DeployGateConfig; noGate?: boolean } = {}) {
  const t = gate(o);
  const repo = join(t.base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, ...ID, 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(repo);
  cfg.tests.deploy_gate = o.config ?? GATE();
  const slotsDir = join(t.base, 'slots');
  mkdirSync(slotsDir);
  const src = chat();
  const c = new Coordinator({
    cfg,
    log: t.log,
    backlog: new FileBacklog(join(t.base, 'backlog.json'), 'coordinator'),
    runner: new FakeRunner(() => ({ structured: { kind: 'needs_info' } })),
    repo,
    instance: 'example',
    stateDir: t.stateDir,
    slotsDir,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => CONFIG, sources: [src], pullMs: 0, roleOf: async (l) => ROLES[l] ?? 'viewer', name: 'example' },
    ...(o.noGate ? {} : { deployGate: t.g }),
  });
  const pass = async (...m: IncomingReport[]) => {
    src.batches.push(m);
    await c.checkIntake();
  };
  return { ...t, c, src, pass };
}

test('deploy override: refused for a non-owner; nothing moves', async () => {
  const t = overrideSetup();
  await t.pass(msg(WRITER_ID, { kind: 'channel', id: CHANNEL }, `deploy ${t.c2}`));
  assert.equal(t.src.threads.length, 0, 'no confirm thread');
  assert.deepEqual(t.refs.calls, []);
  assert.equal(t.deployAt(), t.c1);
  assert.deepEqual(t.of('deploy_gate.override').map((p) => [p.by, p.stage]), [['example-collaborator', 'refused']]);
  assert.match(t.src.posts.filter((p) => p.where === CHANNEL).at(-1)!.text, /Not deployed: only an owner/);
});

test('deploy override: refused for a sha not on main\'s first-parent line', async () => {
  const t = overrideSetup();
  git(t.work, 'checkout', '-q', '-b', 'side', t.c1);
  writeFileSync(join(t.work, 'side'), 'side');
  git(t.work, 'add', 'side');
  git(t.work, ...ID, 'commit', '-q', '-m', 'side');
  const side = git(t.work, 'rev-parse', 'HEAD');
  git(t.work, 'push', '-q', t.bare, 'side');
  git(t.clone, 'fetch', '-q', 'origin', 'side');
  await t.pass(msg(OWNER_ID, { kind: 'channel', id: CHANNEL }, `deploy ${side.slice(0, 10)}`));
  assert.equal(t.src.threads.length, 0);
  assert.deepEqual(t.refs.calls, []);
  assert.match(t.src.posts.filter((p) => p.where === CHANNEL).at(-1)!.text, /not on the default branch's first-parent line/);
});

test('deploy override: nothing until the same owner confirms; then fast-forward only, posted to ops, audited', async () => {
  const t = overrideSetup({ red: ['suite'] });
  // The gate held c2 (red); the owner overrides.
  await t.g.step();
  await t.g.idle();
  assert.equal(t.deployAt(), t.c1);
  await t.pass(msg(OWNER_ID, { kind: 'channel', id: CHANNEL }, `deploy ${t.c2.slice(0, 12)}`));
  const th = t.src.threads.at(-1)!;
  assert.match(th.text, /reply \*\*confirm\*\*/);
  assert.match(th.text, /\*\*red\*\*/);
  assert.deepEqual(t.refs.calls, [], 'asked, not moved');
  // A writer's "confirm", and the owner's vague reply: still nothing.
  await t.pass(msg(WRITER_ID, { kind: 'thread', id: th.id }, 'confirm'));
  await t.pass(msg(OWNER_ID, { kind: 'thread', id: th.id }, 'yes'));
  assert.deepEqual(t.refs.calls, []);
  assert.equal(t.deployAt(), t.c1);
  await t.pass(msg(OWNER_ID, { kind: 'thread', id: th.id }, 'confirm'));
  assert.deepEqual(t.refs.calls, [{ kind: 'ff', sha: t.c2, body: { sha: t.c2, force: false } }]);
  assert.equal(t.deployAt(), t.c2);
  const audit = t.of('dashboard.audit').filter((p) => p.action === 'deploy_gate.override');
  assert.deepEqual(audit.map((p) => [p.login, p.via, (p.detail as Record<string, unknown>).sha, (p.detail as Record<string, unknown>).gate]), [['example-owner', 'discord', t.c2, 'override while red']]);
  assert.deepEqual(t.of('deploy_gate.moved').map((p) => [p.to, p.by, p.override, p.gate]), [[t.c2, 'example-owner', true, 'override while red']]);
  const ops = t.src.posts.filter((p) => p.where === OPS).map((p) => p.text);
  assert.ok(ops.some((x) => /Deploy held/.test(x)), 'the hold went to ops');
  assert.ok(ops.some((x) => /Deploy override\*\* by @example-owner/.test(x)), 'the override went to ops');
  // A second confirm changes nothing.
  await t.pass(msg(OWNER_ID, { kind: 'thread', id: th.id }, 'confirm'));
  assert.equal(t.refs.calls.length, 1);
});

test('deploy override: fast-forward only, never back past where deploy is', async () => {
  const t = overrideSetup();
  await t.g.step();
  await t.g.idle();
  assert.equal(t.deployAt(), t.c2, 'the gate moved it to c2');
  await t.pass(msg(OWNER_ID, { kind: 'channel', id: CHANNEL }, `deploy ${t.c1}`));
  const th = t.src.threads.at(-1)!;
  await t.pass(msg(OWNER_ID, { kind: 'thread', id: th.id }, 'confirm'));
  assert.equal(t.deployAt(), t.c2, 'never moved back');
  assert.equal(t.refs.calls.length, 1, 'only the gate\'s own move');
  assert.match(t.src.posts.filter((p) => p.where === th.id).at(-1)!.text, /Not moved: .*never moved back/);
  assert.equal(parseDeployCommand('deploy abc1234'), 'abc1234');
  assert.equal(parseDeployCommand('please deploy abc1234'), null);
  assert.equal(parseDeployCommand('deploy main'), null);
});

// ---------------------------------------------------------------- the off switch (deploy_gate.enabled)

const OFF = () => DeployGateConfig.parse({ enabled: false, branch: 'deploy', tiers: ['chain', 'suite'] });
const TESTS = { version: 1, runner: { kind: 'command', changed: 'npm test', full: 'npm test' }, test_run: { tiers: [{ name: 'chain', command: 'npm run chain', kind: 'fast' }, { name: 'suite', command: 'npm test', kind: 'full' }] } };
const POST_DEPLOY = {
  host: 'railway',
  project: '00000000-0000-4000-8000-000000000001',
  environment: '00000000-0000-4000-8000-000000000002',
  services: [{ name: 'web', id: '00000000-0000-4000-8000-000000000003' }],
  origin: 'https://app.example.com',
  checks: [
    { name: 'health', kind: 'health', url: 'https://app.example.com/api/health', expect_status: 200 },
    { name: 'sign-in', kind: 'sign_in', url: 'https://app.example.com/sign-in', expect_status: 200 },
    { name: 'api', kind: 'api', url: 'https://app.example.com/api/status', expect_status: 200 },
  ],
};

/** A coordinator config with test runs set up, and `gate` as its deploy_gate. */
function cfgWith(gate: unknown) {
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  cfg.tests = TestsConfig.parse({ ...TESTS, deploy_gate: gate });
  return cfg;
}

test('deploy gate off: a present block with enabled: false runs nothing, moves nothing, builds no gate and no post-deploy check', async () => {
  const t = gate({ config: OFF() });
  t.push();
  await t.g.step();
  await t.g.idle();
  assert.deepEqual(t.runs, [], 'no test run on main for the gate');
  assert.deepEqual(t.posted, [], 'no checks posted');
  assert.deepEqual(t.refs.calls, [], 'no ref write');
  assert.equal(t.deployAt(), t.c1, 'deploy stays');
  const moved = await t.g.advance(t.c2, { by: 'gate', override: false, gate: 'green' });
  assert.equal(moved.ok, false);
  assert.match((moved as { reason: string }).reason, /the deploy gate is off/);
  assert.deepEqual(t.refs.calls, [], 'not even a direct advance writes the ref');
  assert.deepEqual(t.log.read(0).map((e) => e.type), [], 'no event at all');
  // Wired up the way the coordinator starts it: no gate, so no post-deploy check (and no ask for the host token).
  const cfg = cfgWith({ enabled: false, tiers: ['chain', 'suite'], post_deploy: POST_DEPLOY });
  assert.equal(cfg.tests.deploy_gate?.enabled, false);
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'deploy-gate-off-')), 'events.db'));
  assert.equal(setupDeployGate(cfg, { repo: 'example/repo', token: async () => 't', instance: 'example', secretsHome: mkdtempSync(join(tmpdir(), 'deploy-gate-home-')) }, { log, actor: 'c', root: '/nonexistent', stateDir: '/nonexistent', testRunsReady: true }), undefined, 'no gate is built');
  assert.deepEqual(log.read(0).map((e) => e.type), [], 'nothing logged, no paste_secret ask');
});

test('deploy gate off: an absent enabled is off', async () => {
  const absent = DeployGateConfig.parse({ branch: 'deploy', tiers: ['chain', 'suite'] });
  assert.equal(absent.enabled, false);
  assert.equal(cfgWith({ tiers: ['suite'] }).tests.deploy_gate?.enabled, false);
  const t = gate({ config: absent });
  await t.g.step();
  await t.g.idle();
  assert.deepEqual(t.runs, []);
  assert.deepEqual(t.refs.calls, []);
  assert.equal(t.deployAt(), t.c1);
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'deploy-gate-off-')), 'events.db'));
  assert.equal(setupDeployGate(cfgWith({ tiers: ['chain', 'suite'] }), { repo: 'example/repo', token: async () => 't' }, { log, actor: 'c', root: '/nonexistent', stateDir: '/nonexistent', testRunsReady: true }), undefined);
});

test('deploy gate on: enabled: true builds the gate and it runs and moves as before', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'deploy-gate-on-')), 'events.db'));
  const built = setupDeployGate(cfgWith({ enabled: true, tiers: ['chain', 'suite'] }), { repo: 'example/repo', token: async () => 't' }, { log, actor: 'c', root: '/nonexistent', stateDir: '/nonexistent', testRunsReady: true });
  assert.ok(built instanceof DeployGate, 'the gate is built');
  const t = gate({ config: DeployGateConfig.parse({ enabled: true, branch: 'deploy', tiers: ['chain', 'suite'] }) });
  await t.g.step();
  await t.g.idle();
  assert.deepEqual(t.runs.map((r) => r.sha), [t.c2]);
  assert.equal(t.deployAt(), t.c2, 'moved to the green tip');
});

test('deploy gate off: the config is still fully validated, an invalid post_deploy is refused', () => {
  assert.equal(TestsConfig.safeParse({ ...TESTS, deploy_gate: { enabled: false, tiers: ['suite'], post_deploy: POST_DEPLOY } }).success, true, 'a valid block, off');
  const bad = TestsConfig.safeParse({ ...TESTS, deploy_gate: { enabled: false, tiers: ['suite'], post_deploy: { ...POST_DEPLOY, origin: 'http://app.example.com' } } });
  assert.equal(bad.success, false);
  const issues = bad.error!.issues;
  assert.deepEqual(issues.map((i) => i.path.join('.')), ['deploy_gate.post_deploy.origin'], 'only the post_deploy mistake');
  assert.match(issues[0]!.message, /https only/);
  const noApi = TestsConfig.safeParse({ ...TESTS, deploy_gate: { tiers: ['suite'], post_deploy: { ...POST_DEPLOY, checks: POST_DEPLOY.checks.slice(0, 2).concat([{ ...POST_DEPLOY.checks[0]!, name: 'health2' }]) } } });
  assert.equal(noApi.success, false, 'enabled absent (off): still refused');
  assert.match(JSON.stringify(noApi.error?.issues), /needs a api check/);
  assert.equal(TestsConfig.safeParse({ ...TESTS, deploy_gate: { enabled: false, tiers: ['nope'] } }).success, false, 'an unknown tier, off: refused');
  assert.equal(TestsConfig.safeParse({ ...TESTS, deploy_gate: { enabled: 'yes', tiers: ['suite'] } }).success, false, 'enabled is a boolean');
});

test('deploy override: refused while the gate is off, saying so; nothing moves', async () => {
  // As the coordinator runs it: the block is present, off, so no gate was built.
  const t = overrideSetup({ config: OFF(), noGate: true });
  await t.pass(msg(OWNER_ID, { kind: 'channel', id: CHANNEL }, `deploy ${t.c2}`));
  assert.equal(t.src.threads.length, 0, 'no confirm thread');
  assert.deepEqual(t.refs.calls, []);
  assert.equal(t.deployAt(), t.c1);
  assert.deepEqual(t.of('deploy_gate.override').map((p) => [p.by, p.stage]), [['example-owner', 'refused']]);
  assert.match(t.src.posts.filter((p) => p.where === CHANNEL).at(-1)!.text, /Not deployed: the deploy gate is off/);
  // And a gate object handed an off config refuses on its own.
  const u = overrideSetup({ config: OFF() });
  const own = gate({ config: OFF() });
  assert.deepEqual(own.g.checkOverride(own.c2), { ok: false, reason: 'the deploy gate is off (tests.yaml deploy_gate.enabled is not true); the owner turns it on in a reviewed PR' });
  await u.pass(msg(OWNER_ID, { kind: 'channel', id: CHANNEL }, `deploy ${u.c2}`));
  assert.equal(u.src.threads.length, 0);
  assert.deepEqual(u.refs.calls, []);
  assert.match(u.src.posts.filter((p) => p.where === CHANNEL).at(-1)!.text, /Not deployed: the deploy gate is off/);
});

for (const mode of GATE_MODES) {
  test(`deploy gate: a run held at the start gate (${mode}) is no verdict: deploy stays, nothing is red, and the same commit runs once there is room`, async () => {
    const g = guardGate();
    try {
      const t = gate({ gated: true });
      g.close(mode);
      await t.g.step();
      await t.g.idle();
      await t.g.step();
      await t.g.idle();
      assert.equal(t.runs.length, 0, 'nothing ran');
      assert.deepEqual(t.of('deploy_gate.verdict'), [], 'no verdict');
      assert.deepEqual(t.of('deploy_gate.held'), [], 'not held as red');
      assert.equal(t.deployAt(), t.c1);
      g.open();
      await t.g.step();
      await t.g.idle();
      assert.deepEqual(t.runs.map((r) => r.sha), [t.c2], 'the same commit runs');
      assert.equal(t.deployAt(), t.c2, 'and deploy moves on it');
    } finally {
      g.done();
    }
  });
}

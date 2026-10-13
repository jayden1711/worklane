// The post-deploy check (src/deploy-gate/post-deploy.ts, docs/deploy-gate.md): after the gate moves the deploy branch,
// wait for the host's deploy of that commit, smoke-test production, and on a failed check roll the host back to the
// previous deploy-branch commit's deployment, raise an incident, post to ops, and never move to that commit again.
// Real git (a bare remote and a clone); the host's GraphQL API and production are fake HTTP servers on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { TestsConfig } from '../src/config/schema.js';
import { asks } from '../src/console/asks.js';
import { Coordinator } from '../src/coordinator.js';
import { DeployGateConfig, HOST_TOKEN_CREDENTIAL, POST_DEPLOY_INCIDENT, POST_DEPLOY_WAIT_INCIDENT, PostDeployConfig } from '../src/deploy-gate/config.js';
import { DeployGate, refUpdateBody, type DeployRefs, type RefResult } from '../src/deploy-gate/gate.js';
import { snippet } from '../src/deploy-gate/post-deploy.js';
import { RAILWAY_QUERIES } from '../src/deploy-gate/railway.js';
import { gateGit, hostTokenFile, postDeployFor } from '../src/deploy-gate/wire.js';
import { EventLog } from '../src/events/log.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { FakeRunner } from '../src/runner.js';
import type { TestRunRequest, TestRunResult } from '../src/testrun/index.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ENV = '00000000-0000-4000-8000-000000000002';
const WEB = '00000000-0000-4000-8000-000000000003';
const WORKER = '00000000-0000-4000-8000-000000000004';
const TOKEN = 'host-token-value-never-shown-0123456789';

/** A bare remote with main (c1 <- c2) and deploy at c1, and the coordinator's clone of it. */
function repos() {
  const base = mkdtempSync(join(tmpdir(), 'post-deploy-'));
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
  return { base, work, bare, clone, c1, c2 };
}

function fakeRefs(bare: string): DeployRefs {
  return {
    fastForward: async (sha): Promise<RefResult> => {
      refUpdateBody(sha);
      const cur = git(bare, 'rev-parse', 'refs/heads/deploy');
      git(bare, 'update-ref', 'refs/heads/deploy', sha, cur);
      return { ok: true };
    },
    create: async (sha): Promise<RefResult> => (git(bare, 'update-ref', 'refs/heads/deploy', sha, ''), { ok: true }),
  };
}

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

interface Dep {
  id: string;
  status: string;
  createdAt: string;
  canRollback: boolean;
  meta: { commitHash: string };
}

/** The host's GraphQL API: each service's deployments (newest first), and every request it got. */
async function fakeHost(deps: Record<string, Dep[]>) {
  const calls: { auth: string | undefined; query: string; variables: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      calls.push({ auth: req.headers.authorization, query: j.query, variables: j.variables });
      const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }));
      if (j.query === RAILWAY_QUERIES.LIST) {
        const i = j.variables.i as { projectId: string; environmentId: string; serviceId: string };
        assert.equal(i.projectId, PROJECT);
        assert.equal(i.environmentId, ENV);
        return send({ deployments: { edges: (deps[i.serviceId] ?? []).map((node) => ({ node })) } });
      }
      if (j.query === RAILWAY_QUERIES.ROLLBACK) return send({ deploymentRollback: true });
      if (j.query === RAILWAY_QUERIES.REDEPLOY) return send({ deploymentRedeploy: { id: `re-${String(j.variables.id)}`, status: 'BUILDING' } });
      res.writeHead(400).end('{}');
    });
  });
  const url = await listen(server);
  return { url: `${url}/graphql/v2`, calls, server, deps };
}

/** Production: each path's status and body, and the headers of every request it got. */
async function fakeProd(routes: Record<string, { status: number; body: string }>) {
  const seen: { path: string; method: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers });
    const r = routes[req.url ?? ''] ?? { status: 404, body: 'not found' };
    res.writeHead(r.status, { 'content-type': 'text/html', 'set-cookie': 'sid=prod-session-cookie-value; HttpOnly' }).end(r.body);
  });
  const origin = await listen(server);
  return { origin, seen, server, routes };
}

const config = (origin: string, o: Partial<{ wait: number }> = {}) =>
  PostDeployConfig.parse({
    host: 'railway',
    project: PROJECT,
    environment: ENV,
    services: [
      { name: 'web', id: WEB },
      { name: 'worker', id: WORKER },
    ],
    origin,
    checks: [
      { name: 'health', kind: 'health', url: `${origin}/api/health`, expect_status: 200, expect_text: 'ok' },
      { name: 'sign-in', kind: 'sign_in', url: `${origin}/sign-in`, expect_status: 200, expect_text: 'Sign in' },
      { name: 'status-api', kind: 'api', url: `${origin}/api/status`, expect_status: 200 },
    ],
    wait_for_deploy_s: o.wait ?? 600,
    timeout_s: 2,
  });

const dep = (id: string, commit: string, status: string, at: string, canRollback = true): Dep => ({ id, status, createdAt: at, canRollback, meta: { commitHash: commit } });

const OPS = '222222';
const INTAKE = IntakeConfig.parse({
  version: 1,
  discord: { enabled: true, guild: '300000000001', channels: ['111111'], allowed_senders: ['100000000001'], people: { '100000000001': 'example-owner' }, owners: ['100000000001'], ops_channel: OPS, dashboard_url: 'https://dashboard.example.test' },
});

/**
 * The gate (green on every tier) with the post-deploy check wired as the coordinator wires it, a coordinator for the
 * ops posts, and the fakes. `token`: whether the host's token is stored. `deployed`: whether the host deploys c2.
 */
async function setup(o: { token: boolean; deployed: boolean; prodOk: boolean; wait?: number; github?: { total: number; success: number } | null }) {
  const r = repos();
  const log = new EventLog(join(r.base, 'events.db'));
  const stateDir = join(r.base, 'state');
  mkdirSync(stateDir);
  const home = join(r.base, 'home');
  if (o.token) {
    const file = hostTokenFile('example', home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o400 });
  }
  const host = await fakeHost({
    [WEB]: [...(o.deployed ? [dep('web-new', r.c2, 'SUCCESS', '2026-10-13T10:05:00Z')] : []), dep('web-old', r.c1, o.deployed ? 'REMOVED' : 'SUCCESS', '2026-10-13T09:00:00Z')],
    [WORKER]: [...(o.deployed ? [dep('worker-new', r.c2, 'SUCCESS', '2026-10-13T10:06:00Z')] : []), dep('worker-old', r.c1, o.deployed ? 'REMOVED' : 'SUCCESS', '2026-10-13T09:01:00Z', false)],
  });
  const prod = await fakeProd({
    '/api/health': { status: 200, body: 'ok' },
    '/sign-in': { status: 200, body: '<h1>Sign in</h1>' },
    '/api/status': o.prodOk ? { status: 200, body: '{"up":true}' } : { status: 502, body: 'Bad gateway session=abc123secret token: zzz-very-secret Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' },
  });
  const incidents: { op: 'raise' | 'resolve'; kind: string; key: string; detail?: string }[] = [];
  const sink = { raiseIncident: (kind: string, key: string, detail: string) => void incidents.push({ op: 'raise', kind, key, detail }), resolveIncident: (kind: string, key: string) => void incidents.push({ op: 'resolve', kind, key }) };
  let clock = 1_000_000;
  let g: DeployGate | null = null;
  const pd = postDeployFor(
    config(prod.origin, o.wait !== undefined ? { wait: o.wait } : {}),
    'deploy',
    { repo: 'example/repo', token: async () => 'gh-token', instance: 'example', secretsHome: home, hostApi: host.url, postDeployPollMs: 0, postDeployRetryMs: 0, postDeployNow: () => clock, github: async () => (o.github === undefined ? { total: 2, success: o.deployed ? 2 : 0 } : o.github) },
    { log, actor: 'coordinator', stateDir, incidents: sink },
    (sha, reason) => g?.markFailed(sha, reason),
  );
  g = new DeployGate({
    config: DeployGateConfig.parse({ enabled: true, branch: 'deploy', tiers: ['suite'] }),
    defaultBranch: 'main',
    git: gateGit(r.clone, 'origin', 'main', 'deploy'),
    refs: fakeRefs(r.bare),
    log,
    actor: 'coordinator',
    stateDir,
    repo: r.clone,
    start: async (req: TestRunRequest): Promise<TestRunResult> => ({ id: 'run', sha: req.sha, kind: req.kind, ok: true, outcome: 'done', tiers: [{ tier: 'suite', ok: true, durationMs: 1, summary: '', logRef: '' }] }),
    post: async () => {},
    incidents: sink,
    pollMs: 0,
    postDeploy: pd,
  });
  // A coordinator, for the ops posts.
  const checkout = join(r.base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), checkout, { recursive: true });
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'add', '-A');
  git(checkout, ...ID, 'commit', '-q', '-m', 'init');
  const cfg = loadConfig(checkout);
  cfg.tests.deploy_gate = DeployGateConfig.parse({ enabled: true, branch: 'deploy', tiers: ['suite'] });
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource = { name: 'discord', take: async () => [], reply: async (t, text) => (posts.push({ where: t.id, text }), true), openThread: async () => '1', watch: () => {} };
  const slotsDir = join(r.base, 'slots');
  mkdirSync(slotsDir);
  const c = new Coordinator({
    cfg,
    log,
    backlog: new FileBacklog(join(r.base, 'backlog.json'), 'coordinator'),
    runner: new FakeRunner(() => ({ structured: { kind: 'needs_info' } })),
    repo: checkout,
    instance: 'example',
    stateDir,
    slotsDir,
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => INTAKE, sources: [src], pullMs: 0, roleOf: async () => 'owner', name: 'example' },
    deployGate: g,
  });
  /** One gate pass, and the post-deploy pass it starts, to the end. */
  const pass = async () => {
    await g!.step();
    await g!.idle();
  };
  const of = (type: string) => log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);
  const done = () => {
    host.server.close();
    prod.server.close();
  };
  return { ...r, log, g, pd, c, host, prod, posts, incidents, pass, of, done, tick: (ms: number) => (clock += ms), deployAt: () => git(r.bare, 'rev-parse', 'refs/heads/deploy') };
}

test('post-deploy: the host deploys the commit, every smoke check passes, and nothing else happens', async () => {
  const t = await setup({ token: true, deployed: true, prodOk: true });
  try {
    await t.pass(); // the gate moves deploy to c2: the check starts
    assert.equal(t.deployAt(), t.c2);
    assert.equal(t.pd.pending?.sha, t.c2);
    await t.pass(); // the host has it: smoke
    const [e] = t.of('deploy_gate.post_deploy');
    assert.equal(e?.outcome, 'passed');
    assert.equal(e?.sha, t.c2);
    assert.equal(e?.prev, t.c1);
    assert.deepEqual((e?.checks as { name: string; ok: boolean }[]).map((c) => [c.name, c.ok]), [['health', true], ['sign-in', true], ['status-api', true]]);
    assert.equal(e?.rollback, null);
    assert.deepEqual(e?.github, { total: 2, success: 2 }, 'GitHub is the cross-check');
    // The host was asked with the token, and only listed: no rollback, no redeploy.
    assert.ok(t.host.calls.length >= 2);
    assert.ok(t.host.calls.every((c) => c.auth === `Bearer ${TOKEN}` && c.query === RAILWAY_QUERIES.LIST));
    // Production got plain GETs: no cookie, no credential.
    assert.deepEqual(t.prod.seen.map((s) => [s.method, s.path]), [['GET', '/api/health'], ['GET', '/sign-in'], ['GET', '/api/status']]);
    assert.ok(t.prod.seen.every((s) => !s.headers.cookie && !s.headers.authorization));
    assert.equal(t.incidents.filter((i) => i.op === 'raise').length, 0);
    assert.equal(t.pd.pending, null);
    assert.equal(t.deployAt(), t.c2);
    await t.c.checkIntake();
    assert.equal(t.posts.filter((p) => p.where === OPS && /Post-deploy/.test(p.text)).length, 0, 'no ops post for a pass');
  } finally {
    t.done();
  }
});

test('post-deploy: a failed smoke check rolls each service back to the previous good deployment, raises an incident, posts to ops, and the gate never moves to it again', async () => {
  const t = await setup({ token: true, deployed: true, prodOk: false });
  try {
    await t.pass();
    await t.pass();
    const [e] = t.of('deploy_gate.post_deploy') as { outcome: string; checks: { name: string; ok: boolean; status: number; snippet: string }[]; rollback: { attempted: boolean; ok: boolean; services: { service: string; to: string; via: string; ok: boolean }[] } }[];
    assert.equal(e?.outcome, 'failed');
    const bad = e!.checks.find((c) => !c.ok)!;
    assert.equal(bad.name, 'status-api');
    assert.equal(bad.status, 502);
    assert.match(bad.snippet, /Bad gateway/);
    assert.doesNotMatch(bad.snippet, /abc123secret|zzz-very-secret|abcdefghijklmnopqrstuvwxyz0123|prod-session-cookie-value/, 'the snippet is redacted');
    // One retry: the failing check was asked twice.
    assert.equal(t.prod.seen.filter((s) => s.path === '/api/status').length, 2);
    // web: the host's rollback to its c1 deployment; worker (rollback not offered): a redeploy of its c1 deployment.
    assert.deepEqual(
      e!.rollback.services.map((s) => [s.service, s.to, s.via, s.ok]),
      [
        ['web', 'web-old', 'rollback', true],
        ['worker', 'worker-old', 'redeploy', true],
      ],
    );
    assert.equal(e!.rollback.ok, true);
    const mutations = t.host.calls.filter((c) => c.query !== RAILWAY_QUERIES.LIST).map((c) => [c.query === RAILWAY_QUERIES.ROLLBACK ? 'rollback' : 'redeploy', c.variables.id]);
    assert.deepEqual(mutations, [['rollback', 'web-old'], ['redeploy', 'worker-old']]);
    // Nothing moved on git; the commit is marked; a red incident.
    assert.equal(t.deployAt(), t.c2);
    assert.equal(t.g.failedPostDeploy(t.c2), true);
    assert.deepEqual(t.incidents.filter((i) => i.op === 'raise').map((i) => i.kind), [POST_DEPLOY_INCIDENT]);
    assert.match(t.incidents.find((i) => i.op === 'raise')!.detail!, /status-api/);
    // The ops post: the failing check, its status, the redacted snippet, and the rollback.
    await t.c.checkIntake();
    const ops = t.posts.filter((p) => p.where === OPS && /Post-deploy check failed/.test(p.text));
    assert.equal(ops.length, 1);
    assert.match(ops[0]!.text, /`status-api`: expected 200, got 502 \(status 502\)/);
    assert.match(ops[0]!.text, /rolled back to `[0-9a-f]{8}`: web rollback ok, worker redeploy ok/);
    assert.doesNotMatch(ops[0]!.text, new RegExp(`${TOKEN}|abc123secret|prod-session-cookie-value`));
    await t.c.checkIntake();
    assert.equal(t.posts.filter((p) => p.where === OPS && /Post-deploy check failed/.test(p.text)).length, 1, 'posted once');
    // The gate never moves deploy to c2 again, by itself or by an override.
    git(t.bare, 'update-ref', 'refs/heads/deploy', t.c1);
    const again = await t.g.advance(t.c2, { by: 'gate', override: false, gate: 'green' });
    assert.equal(again.ok, false);
    assert.match((again as { reason: string }).reason, /failed its post-deploy check/);
    assert.equal(t.deployAt(), t.c1);
    const o = t.g.checkOverride(t.c2);
    assert.equal(o.ok, false);
    // The token never reached an event.
    assert.doesNotMatch(JSON.stringify(t.log.read(0)), new RegExp(TOKEN));
  } finally {
    t.done();
  }
});

test('post-deploy: no host token: smoke still runs and alerts, says rollback needs the token, rolls nothing back, and asks for the token', async () => {
  const t = await setup({ token: false, deployed: true, prodOk: false });
  try {
    const ask = asks(t.log).list({ instance: 'example', status: 'open' }).find((a) => a.kind === 'paste_secret');
    assert.ok(ask, 'the owner is asked for the token');
    assert.equal((ask as { credential: string }).credential, HOST_TOKEN_CREDENTIAL);
    await t.pass();
    await t.pass();
    const [e] = t.of('deploy_gate.post_deploy') as { outcome: string; token: boolean; rollback: { attempted: boolean; detail: string } }[];
    assert.equal(e?.outcome, 'failed', 'GitHub showed the deploy; the smoke check failed');
    assert.equal(e?.token, false);
    assert.deepEqual((e as unknown as { github: unknown }).github, { total: 2, success: 2 }, 'GitHub was the signal');
    assert.equal(e?.rollback.attempted, false);
    assert.match(e!.rollback.detail, /needs the host's API token/);
    assert.equal(t.host.calls.length, 0, 'the host was never called');
    assert.equal(t.g.failedPostDeploy(t.c2), true);
    assert.deepEqual(t.incidents.filter((i) => i.op === 'raise').map((i) => i.kind), [POST_DEPLOY_INCIDENT]);
    await t.c.checkIntake();
    const ops = t.posts.filter((p) => p.where === OPS && /Post-deploy check failed/.test(p.text));
    assert.equal(ops.length, 1);
    assert.match(ops[0]!.text, /\*\*not rolled back\*\*: rollback needs the host's API token/);
    assert.match(ops[0]!.text, /Store the token from the dashboard/);
  } finally {
    t.done();
  }
});

test('post-deploy: the host never deploys the commit: an alert after wait_for_deploy_s, no smoke, no rollback', async () => {
  const t = await setup({ token: true, deployed: false, prodOk: true, wait: 600 });
  try {
    await t.pass();
    await t.pass(); // still waiting
    assert.equal(t.of('deploy_gate.post_deploy').length, 0, 'waiting, within the time');
    t.tick(601_000);
    await t.pass();
    const [e] = t.of('deploy_gate.post_deploy') as { outcome: string; detail: string; rollback: unknown; checks: unknown[] }[];
    assert.equal(e?.outcome, 'timed_out');
    assert.match(e!.detail, /didn't deploy [0-9a-f]{8} within 600 s \(web: latest is [0-9a-f]{8} SUCCESS; worker: latest is/);
    assert.equal(e!.rollback, null);
    assert.deepEqual(e!.checks, []);
    assert.equal(t.prod.seen.length, 0, 'production was never smoke-tested');
    assert.ok(t.host.calls.every((c) => c.query === RAILWAY_QUERIES.LIST), 'no rollback, no redeploy');
    assert.equal(t.g.failedPostDeploy(t.c2), false, 'not marked: it never ran');
    assert.deepEqual(t.incidents.filter((i) => i.op === 'raise').map((i) => i.kind), [POST_DEPLOY_WAIT_INCIDENT]);
    await t.c.checkIntake();
    assert.equal(t.posts.filter((p) => p.where === OPS && /Post-deploy check: not deployed/.test(p.text)).length, 1);
    assert.equal(t.pd.pending, null);
  } finally {
    t.done();
  }
});

test('post-deploy config: off by default; a check URL off the production origin, with credentials, or not GET is refused', () => {
  const tests = { version: 1, runner: { kind: 'command', changed: 'npm test', full: 'npm test' }, test_run: { tiers: [{ name: 'suite', command: 'npm test', kind: 'full' }] } };
  assert.equal(TestsConfig.parse({ ...tests, deploy_gate: { tiers: ['suite'] } }).deploy_gate?.post_deploy, undefined, 'off unless set');
  const origin = 'https://app.example.com';
  const good = {
    host: 'railway',
    project: PROJECT,
    environment: ENV,
    services: [{ name: 'web', id: WEB }],
    origin,
    checks: [
      { name: 'health', kind: 'health', url: `${origin}/api/health`, expect_status: 200 },
      { name: 'sign-in', kind: 'sign_in', url: `${origin}/sign-in`, expect_status: 200, expect_text: 'Sign in' },
      { name: 'api', kind: 'api', url: `${origin}/api/status`, expect_status: 200 },
    ],
  };
  const ok = TestsConfig.parse({ ...tests, deploy_gate: { tiers: ['suite'], post_deploy: good } });
  assert.equal(ok.deploy_gate?.post_deploy?.checks[0]?.method, 'GET');
  assert.equal(ok.deploy_gate?.post_deploy?.wait_for_deploy_s, 1200);
  const refused = (pd: unknown, why: RegExp) => {
    const r = TestsConfig.safeParse({ ...tests, deploy_gate: { tiers: ['suite'], post_deploy: pd } });
    assert.equal(r.success, false, `refused: ${why}`);
    assert.match(JSON.stringify(r.error?.issues), why);
  };
  const check = (c: Record<string, unknown>) => ({ ...good, checks: [good.checks[0], good.checks[1], { ...good.checks[2], ...c }] });
  refused(check({ url: 'https://elsewhere.example.net/api/status' }), /not on the production origin https:\/\/app\.example\.com/);
  refused(check({ url: 'http://app.example.com/api/status' }), /not on the production origin/);
  refused(check({ url: 'https://app.example.com:8443/api/status' }), /not on the production origin/);
  refused(check({ url: 'https://user:pw@app.example.com/api/status' }), /no credentials in a check URL/);
  refused(check({ method: 'POST' }), /GET/);
  refused({ ...good, origin: 'https://app.example.com/base' }, /an origin only/);
  refused({ ...good, origin: 'http://app.example.com' }, /https only/);
  refused({ ...good, checks: [good.checks[0], good.checks[1], { ...good.checks[2], kind: 'health' }] }, /needs a api check/);
  refused({ ...good, project: 'not-an-id' }, /a Railway id/);
});

test('post-deploy snippet: no cookie, session or token value survives', () => {
  const s = snippet('<p>error</p>\n set-cookie: sid=abc; session_id=xyz123 api_key="k-123" Bearer abcdefghijklmnopqrstuvwxyz');
  assert.doesNotMatch(s, /sid=abc|xyz123|k-123|abcdefghijklmnopqrstuvwxyz/);
  assert.match(s, /error/);
});

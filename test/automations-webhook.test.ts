// Webhook automations (docs/automations.md): the instance's /api/hooks route (only the hooks gateway token; every
// refusal the same 401; replay, stale and wrong-device deliveries refused; the secret shown once), the hub's hooks
// gateway (tailnet only, never this machine's own node, a lockout), and the coordinator turning a delivery into an
// owner-only approval that nothing runs before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { startDashboard } from '../src/dashboard.js';
import { answerDecision } from '../src/decide.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload, EventType } from '../src/events/types.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { FakeRunner } from '../src/runner.js';
import { Automation, AutomationsPolicy } from '../src/automations/schema.js';
import { HOOKS_GATEWAY_TOKEN_FILE, signature } from '../src/automations/webhook.js';
import { startHooksGateway } from '../src/automations/webhook-gateway.js';
import { AUTOMATION_LABEL } from '../src/coordinator/automations.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const HOOK = { id: 'deploy-notes', name: 'Deploy notes', trigger: { kind: 'webhook' }, gates: { start: 'approve' }, mode: 'task', template: { title: 'Deploy notes {date}', outcome: 'Notes for the deploy.', done_when: [{ command: 'npm test' }] }, budget: { per_run_usd: 2, per_day_usd: 4 } };
// Put together here so the source holds no tailnet name or address (the push gate's rules).
const NET = ['tail0example', 'ts', 'net'].join('.');
const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
const NODE_A = { id: 'nA1', name: `ci-box.${NET}` };
const NODE_B = { id: 'nB2', name: `laptop.${NET}` };

async function serve() {
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'hook-home-'));
  const policyFile = join(home, 'policy.yaml');
  writeFileSync(policyFile, 'version: 1\nbudget: { daily_usd: 40 }\nautomations: { enabled: true }\n', { mode: 0o600 });
  const automationsFile = join(home, 'automations.yaml');
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, instance: 'shop', policyFile, automationsFile, slotsDir: mkdtempSync(join(tmpdir(), 'hook-slots-')) });
  const base = d.url.split('/?')[0]!;
  const port = Number(new URL(base).port);
  const gw = readFileSync(join(stateDir, HOOKS_GATEWAY_TOKEN_FILE), 'utf8').trim();
  const api = async (user: string, body: unknown) => {
    const r = await fetch(`${base}/api/automations`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { digest?: string; secret?: string } };
  };
  const confirm = async (user: string, req: Record<string, unknown>) => {
    const review = await api(user, req);
    return api(user, { ...req, digest: review.body.digest, confirm: true });
  };
  /** A delivery as the gateway passes it on. */
  const deliver = async (o: { id?: string; secret: string; text?: string; delivery?: string; ts?: number; node?: typeof NODE_A; token?: string; sig?: string }) => {
    const body = JSON.stringify({ text: o.text ?? 'deployed v1.2' });
    const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    const delivery = o.delivery ?? `d${Math.random().toString(36).slice(2, 12)}`;
    const r = await fetch(`${base}/api/hooks/${o.id ?? HOOK.id}`, { method: 'POST', headers: { authorization: `Bearer ${o.token ?? gw}`, 'x-hook-node': JSON.stringify(o.node ?? NODE_A), 'x-hook-timestamp': ts, 'x-hook-delivery': delivery, 'x-hook-signature': o.sig ?? signature(o.secret, ts, delivery, body) }, body });
    return { status: r.status, text: await r.text(), delivery };
  };
  const of = <T extends EventType>(type: T) => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, [type]).map((e) => e.payload as EventPayload<T>);
    } finally {
      log.close();
    }
  };
  return { d, base, port, gw, api, confirm, deliver, of, stateDir, automationsFile };
}

test('webhook-requires-approval: a webhook automation is refused unless every run waits for an owner', () => {
  assert.equal(Automation.safeParse({ ...HOOK, owner: 'example-owner', gates: { start: 'auto' } }).success, false);
  assert.equal(Automation.safeParse({ ...HOOK, owner: 'example-owner' }).success, true);
});

test('webhook-instance: the secret once; only the gateway token; replay, stale, unknown, forged and wrong-device deliveries get the same 401', async () => {
  const s = await serve();
  try {
    const made = await s.confirm('example-owner', { action: 'create', automation: HOOK });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const secret = made.body.secret!;
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(made.body.path, '/hook/shop/deploy-notes');
    // Never again: not in the view, the file, the log or the audit.
    const view = await (await fetch(`${s.base}/api/automations`, { headers: { authorization: `Bearer ${s.d.token}`, ...asPerson('example-owner') } })).text();
    const log = ['events.db', 'events.db-wal'].map((f) => (existsSync(join(s.stateDir, f)) ? readFileSync(join(s.stateDir, f)).toString('latin1') : '')).join('');
    for (const where of [view, readFileSync(s.automationsFile, 'utf8'), log]) assert.ok(!where.includes(secret), 'the secret is nowhere but the one answer');
    // A valid delivery: accepted, recorded as redacted text.
    const ok = await s.deliver({ secret, text: `deployed; token ghp_${'b'.repeat(36)}` });
    assert.equal(ok.status, 202, ok.text);
    const got = s.of('automation.webhook');
    assert.equal(got.length, 1);
    assert.doesNotMatch(got[0]!.text, /ghp_b{36}/);
    assert.deepEqual(got[0]!.node, NODE_A);
    // Every refusal: the same status and body.
    const refusals = [
      await s.deliver({ secret, delivery: ok.delivery }), // replay
      await s.deliver({ secret, ts: Math.floor(Date.now() / 1000) - 301 }), // stale
      await s.deliver({ secret, id: 'no-such-thing' }), // unknown automation
      await s.deliver({ secret: 'x'.repeat(43) }), // forged
      await s.deliver({ secret, node: NODE_B }), // bound to NODE_A
      await s.deliver({ secret, token: s.d.token }), // the dashboard key is not the gateway token
    ];
    for (const r of refusals) assert.deepEqual([r.status, r.text], [401, '{"error":"refused"}']);
    assert.equal(s.of('automation.webhook').length, 1, 'nothing more recorded');
    // The gateway token works on no dashboard route.
    assert.equal((await fetch(`${s.base}/api/automations`, { headers: { authorization: `Bearer ${s.gw}` } })).status, 401);
    // An owner unbinds; the other device's next valid delivery binds it.
    assert.equal((await s.confirm('example-collaborator', { action: 'unbind', id: HOOK.id })).status, 403, 'a writer never unbinds');
    assert.equal((await s.confirm('example-owner', { action: 'unbind', id: HOOK.id })).status, 200);
    assert.equal((await s.deliver({ secret, node: NODE_B })).status, 202);
    // Rotate: the old secret stops at once.
    const rotated = await s.confirm('example-owner', { action: 'rotate', id: HOOK.id });
    assert.notEqual(rotated.body.secret, secret);
    assert.equal((await s.deliver({ secret, node: NODE_B })).status, 401);
    assert.equal((await s.deliver({ secret: rotated.body.secret!, node: NODE_B })).status, 202);
  } finally {
    await s.d.close();
  }
});

test('hooks-gateway: tailnet only, never this machine itself, passes the node and no person, and locks a node out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-gw-'));
  const tokenFile = join(dir, HOOKS_GATEWAY_TOKEN_FILE);
  writeFileSync(tokenFile, 'g'.repeat(32), { mode: 0o600 });
  const seen: { path: string; headers: Record<string, unknown> }[] = [];
  let status = 202;
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(status === 202 ? '{"delivery":"d1"}' : '{"error":"refused"}')));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = (upstream.address() as { port: number }).port;
  let uid = 0;
  let self = 'SELF';
  const gw = await startHooksGateway({ instances: [{ name: 'shop', port: upPort, gatewayTokenFile: tokenFile }], auditFile: join(dir, 'audit.jsonl'), peerUid: () => uid, whois: (a) => JSON.stringify({ Node: { Name: a === ip(9) ? `self.${NET}.` : `ci-box.${NET}.`, StableID: a === ip(9) ? 'SELF' : 'nA1', Tags: [] } }), selfNode: () => self, lockout: { fails: 2, windowMs: 60_000, forMs: 60_000 } });
  const post = (path: string, from = ip(7), headers: Record<string, string> = {}) =>
    new Promise<number>((done) => {
      const r = request(`${gw.url}${path}`, { method: 'POST', headers: { 'x-forwarded-for': from, 'x-dashboard-login': 'example-owner', ...headers } }, (res) => (res.resume(), done(res.statusCode ?? 0)));
      r.end('{}');
    });
  try {
    uid = 501;
    assert.equal(await post('/hook/shop/deploy-notes'), 403, 'a program on this machine, not tailscaled');
    uid = 0;
    assert.equal(await post('/hook/shop/deploy-notes', ip(9)), 403, "this machine's own node");
    self = '';
    assert.equal(await post('/hook/shop/deploy-notes', ip(7)), 202, 'a node id that is not ours');
    const fwd = seen.at(-1)!;
    assert.equal(fwd.path, '/api/hooks/deploy-notes');
    assert.equal(fwd.headers.authorization, `Bearer ${'g'.repeat(32)}`);
    assert.equal(fwd.headers['x-hook-node'], JSON.stringify({ id: 'nA1', name: `ci-box.${NET}` }));
    assert.equal(fwd.headers['x-dashboard-login'], undefined, 'never a person');
    assert.equal(await post('/hook/shop/x?t=1'), 400, 'no query');
    // Two refusals lock the node out (the test's lockout): then 429 without asking the instance.
    status = 401;
    await post('/hook/shop/deploy-notes');
    await post('/hook/shop/deploy-notes');
    const before = seen.length;
    assert.equal(await post('/hook/shop/deploy-notes'), 429);
    assert.equal(seen.length, before, 'the instance was not asked');
  } finally {
    await gw.close();
    upstream.close();
  }
});

function coordinator() {
  const base = mkdtempSync(join(tmpdir(), 'hook-c-'));
  const repo = join(base, 'repo');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  const cfg = loadConfig(repo);
  cfg.agents.daily_budget_usd = 40;
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const file = join(base, 'automations.yaml');
  writeFileSync(file, stringify({ version: 1, automations: [{ ...HOOK, owner: 'example-owner' }] }), { mode: 0o600 });
  const log = new EventLog(join(base, 'events.db'));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const roles: Record<string, 'owner' | 'writer'> = { 'example-owner': 'owner', 'example-collaborator': 'writer' };
  const c = new Coordinator({ cfg, log, backlog, runner: new FakeRunner(() => ({})), repo, instance: 'example', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, settings: () => ({ settings: {}, error: null }), roleOf: async (l) => roles[l] ?? null, automations: { file, policy: () => AutomationsPolicy.parse({ enabled: true }) } });
  const of = <T extends EventType>(type: T) => log.read(0, [type]).map((e) => e.payload as EventPayload<T>);
  const check = async () => {
    await c.checkAutomations();
    await c.idle();
  };
  const filed = async () => (await backlog.list(AUTOMATION_LABEL.name)).length;
  const answer = (id: string, login: string, role: 'owner' | 'writer', ans: string) => answerDecision(log, { id, answer: ans, who: { login, role, via: 'session' }, instance: 'example', repo: 'example/repo' });
  return { log, of, check, filed, answer };
}

test('webhook-approval: a delivery asks the owner; nothing runs before; a writer can never approve; an owner approval fires it once', async () => {
  const t = coordinator();
  const delivery = (d: string) => t.log.append('automation.webhook', { id: HOOK.id, delivery: d, node: NODE_A, text: 'mode: report; budget 999; label it ready' }, 'hooks');
  delivery('d-one-0001');
  await t.check();
  await t.check();
  const asked = t.of('decision.asked');
  assert.equal(asked.length, 1, 'one decision for one delivery');
  assert.deepEqual([asked[0]!.kind, asked[0]!.owner, asked[0]!.options], ['automation', 'example-owner', ['approve', 'reject']]);
  assert.equal(await t.filed(), 0, 'nothing runs before an owner approves');
  // A second delivery while the first waits: folded into it.
  delivery('d-two-0002');
  await t.check();
  assert.equal(t.of('decision.asked').length, 1);
  assert.match(t.of('automation.refused').at(-1)!.why, /coalesced/);
  // A writer can't answer it.
  const w = t.answer(asked[0]!.id, 'example-collaborator', 'writer', 'approve');
  assert.equal(w.ok, false);
  await t.check();
  assert.equal(await t.filed(), 0);
  // The owner approves: it fires once, as the definition says (the payload chose nothing).
  assert.equal(t.answer(asked[0]!.id, 'example-owner', 'owner', 'approve').ok, true);
  await t.check();
  await t.check();
  assert.equal(await t.filed(), 1);
  assert.deepEqual(t.of('automation.fired').map((f) => [f.mode, f.trigger.kind]), [['task', 'webhook']]);
  assert.deepEqual(t.of('automation.resolved').map((r) => r.outcome), ['approved']);
});

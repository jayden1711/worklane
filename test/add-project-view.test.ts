// The setup console's Add project, on the server (src/console/add-project.ts, POST /api/machine/add-project): who
// may submit, what is checked, that a submit only records a machine request (and the audit), and that the view
// follows the real run: the coordinator's add_project.step events and asks, in the script's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { runningAddProjects } from '../src/coordinator/add-project.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_EVENTS, machineRequests } from '../src/machine-requests.js';
import { asFreshPerson, exampleProject, exampleRoles, machineOwnersFile } from './helpers.js';

const posix = process.platform !== 'win32';

interface View {
  allowed: boolean;
  why: string | null;
  machineOwners: string[];
  runs: { id: string; status: string; steps: { step: string; state: string; detail: string; retry: string | null }[]; failedStep: string | null; asks: { id: string; kind: string; status: string; canAnswer: boolean; url?: string }[] }[];
}

async function dashboard(owners: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'add-project-view-'));
  const home = join(dir, 'home');
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  const ownersFile = machineOwnersFile(...owners);
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: ownersFile, secretsHome: home, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const headers = (h: Record<string, string>) => ({ authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...h });
  const post = async (body: unknown, h: Record<string, string> = asFreshPerson('example-owner'), path = '/api/machine/add-project') => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: headers(h), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string; request?: { id: string; args: string[] } } };
  };
  const get = async (h: Record<string, string> = asFreshPerson('example-owner')) => (await fetch(`${base}/api/add-project`, { headers: headers(h) })).json() as Promise<View>;
  const events = () => {
    const log = new EventLog(eventsDb);
    try {
      return log.read(0);
    } finally {
      log.close();
    }
  };
  return { d, post, get, events, eventsDb, ownersFile, home };
}

test("the server refuses an Add project submit from an instance owner who isn't a machine owner, and records only the refusal", async () => {
  const s = await dashboard(['ada']);
  try {
    // example-owner owns this instance (admin on its repo) but isn't one of the machine's owners.
    const view = await s.get();
    assert.deepEqual([view.allowed, view.machineOwners], [false, ['ada']]);
    const r = await s.post({ name: 'shop', repo: 'acme/shop' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error!, /machine owners: @ada\); @example-owner isn't one/);
    const owner = await dashboard(['example-owner', 'example-collaborator']);
    try {
      assert.equal((await owner.get()).allowed, true, 'a machine owner, fresh, on an allowed device');
      // A machine owner who only writes on this instance's repo isn't an owner here: refused too.
      const writer = await owner.post({ name: 'shop', repo: 'acme/shop' }, asFreshPerson('example-collaborator'));
      assert.equal(writer.status, 403);
      assert.match(writer.body.error!, /only the instance's owners/);
      const stale = await owner.post({ name: 'shop', repo: 'acme/shop' }, asFreshPerson('example-owner', Date.now() - 6 * 60_000));
      assert.equal(stale.status, 403);
      assert.match(stale.body.error!, /sign-in within the last 5 minutes/);
      const elsewhere = await owner.post({ name: 'shop', repo: 'acme/shop' }, { ...asFreshPerson('example-owner'), 'x-dashboard-console-device': '0' });
      assert.equal(elsewhere.status, 403);
      assert.match(elsewhere.body.error!, /allowed devices/);
      // The name and the repo are checked on the server too, whatever the page checked.
      for (const body of [{ name: 'Shop', repo: 'acme/shop' }, { name: 'shop;id', repo: 'acme/shop' }, { name: 'shop', repo: 'acme' }, { name: 'shop', repo: 'acme/..' }, { name: 'shop', repo: 'acme/shop --x' }]) {
        assert.equal((await owner.post(body)).status, 400, JSON.stringify(body));
      }
      assert.deepEqual(machineRequests(owner.events().filter((e) => (MACHINE_EVENTS as readonly string[]).includes(e.type))), [], 'nothing recorded for the coordinator');
      // The view's own path takes no submit: one way in.
      assert.equal((await owner.post({ name: 'shop', repo: 'acme/shop' }, asFreshPerson('example-owner'), '/api/add-project')).status, 404);
    } finally {
      await owner.d.close();
    }
    const events = s.events();
    assert.deepEqual(machineRequests(events), [], 'no machine request');
    const audit = events.filter((e) => e.type === 'dashboard.audit').map((e) => e.payload as unknown as { login: string; action: string; detail: { name: string } });
    assert.deepEqual(audit.map((a) => [a.login, a.action, a.detail.name]), [['example-owner', 'machine.add_project_refused', 'shop']], 'the refusal is audited');
  } finally {
    await s.d.close();
  }
});

/** add-project.sh as the helper runs it, played by a script: its progress lines, then the token on stdin. */
const FAKE_HELPER = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ step: 'instance', state: 'started', detail: '' });
out({ step: 'instance', state: 'done', detail: 'users there' });
out({ step: 'app', state: 'started', detail: '' });
out({ step: 'app', state: 'ask', detail: 'create the App', ask: { kind: 'approve_link', title: 'Create shop-app on GitHub', detail: 'Approve it.', url: 'https://hub.example.test/setup/app-manifest/start/amf-1' } });
out({ step: 'app', state: 'ask', detail: 'install the App', ask: { kind: 'approve_link', title: 'Install shop-app on acme/shop only', detail: 'Only that repo.', url: 'https://github.com/apps/shop-app/installations/new' } });
out({ step: 'app', state: 'done', detail: 'the App is set up' });
out({ step: 'claude-token', state: 'ask', detail: 'token', ask: { kind: 'paste_secret', credential: 'claude-token', title: "The Claude login for shop's agents", detail: 'Paste it.' } });
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  out({ step: 'claude-token', state: 'done', detail: 'stored' });
  out({ step: 'checkout', state: 'failed', detail: 'the clone was refused', retry: 'sudo bash add-project.sh shop acme/shop' });
  process.exit(1);
});
`;

test('a machine owner submit is accepted, and the view follows the coordinator: its steps in order, both GitHub links and the token ask', { skip: !posix && 'a stand-in helper' }, async () => {
  const s = await dashboard(['example-owner']);
  try {
    const ok = await s.post({ name: 'shop', repo: 'acme/shop' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.request!.args, ['add-project', 'shop', 'acme/shop']);
    let v = await s.get();
    assert.deepEqual([v.allowed, v.runs.length, v.runs[0]!.status], [false, 1, 'pending']);
    assert.match(v.why!, /one project at a time/);
    assert.equal((await s.post({ name: 'blog', repo: 'acme/blog' })).status, 409, 'one at a time, on the server too');

    // The coordinator takes it and runs the (stand-in) helper.
    const log = new EventLog(s.eventsDb);
    try {
      const helper = () => spawn(process.execPath, ['-e', FAKE_HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
      assert.equal(runMachineRequests({ log, ownersFile: s.ownersFile, instance: 'demo', spawn: helper, home: s.home, pollMs: 20 }), 1);
      const run = runningAddProjects.get(ok.body.request!.id)!;
      let secret: View['runs'][0]['asks'][0] | undefined;
      for (let i = 0; i < 300 && !secret; i++) {
        v = await s.get();
        secret = v.runs[0]!.asks.find((a) => a.kind === 'paste_secret' && a.status === 'open');
        if (!secret) await new Promise((res) => setTimeout(res, 10));
      }
      assert.ok(secret, 'the token ask shows in the view');
      assert.equal(v.runs[0]!.status, 'running');
      assert.deepEqual(v.runs[0]!.steps.slice(0, 4).map((x) => `${x.step}:${x.state}`), ['instance:done', 'app:done', 'claude-token:ask', 'checkout:pending']);
      assert.deepEqual(v.runs[0]!.asks.filter((a) => a.kind === 'approve_link').map((a) => a.url), ['https://hub.example.test/setup/app-manifest/start/amf-1', 'https://github.com/apps/shop-app/installations/new'], 'both GitHub links, in order');
      assert.ok(secret.canAnswer, 'the owner may paste it');
      // The owner pastes the token through the dashboard's paste box; the coordinator hands it to the script.
      const pasted = await fetch(`${s.d.url.split('/?')[0]}/api/asks/${secret.id}/secret`, { method: 'POST', headers: { authorization: `Bearer ${s.d.token}`, 'content-type': 'application/json', ...asFreshPerson('example-owner') }, body: JSON.stringify({ value: `sk-ant-oat01-${'Z'.repeat(40)}` }) });
      assert.equal(pasted.status, 200, await pasted.text());
      await run;
    } finally {
      log.close();
    }
    v = await s.get();
    const r = v.runs[0]!;
    assert.deepEqual(r.steps.map((x) => `${x.step}:${x.state}`), ['instance:done', 'app:done', 'claude-token:done', 'checkout:failed', 'policy:pending', 'service:pending', 'test-user:pending', 'machine-helper:pending', 'dashboards:pending']);
    assert.deepEqual([r.status, r.failedStep, r.steps[3]!.retry], ['failed', 'checkout', 'sudo bash add-project.sh shop acme/shop']);
    assert.equal(r.asks.length, 3);
    assert.equal(v.allowed, true, 'the next one may start');
    const audit = s.events().filter((e) => e.type === 'dashboard.audit').map((e) => (e.payload as unknown as { action: string }).action);
    assert.ok(audit.includes('machine.add_project'), 'the submit is audited');
  } finally {
    await s.d.close();
  }
});

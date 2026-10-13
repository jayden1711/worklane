// The setup console's Add project, on the server (src/console/add-project.ts): who may submit, what is checked,
// and that a submit only records a machine request (and the audit), never runs anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_EVENTS, machineRequests } from '../src/machine-requests.js';
import { addProjectRefusal } from '../src/console/add-project.js';
import { asFreshPerson, exampleProject, exampleRoles, machineOwnersFile } from './helpers.js';

async function dashboard(owners: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'add-project-view-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: machineOwnersFile(...owners), slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const post = async (body: unknown, headers: Record<string, string> = asFreshPerson('example-owner')) => {
    const r = await fetch(`${base}/api/add-project`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string } };
  };
  const get = async (headers: Record<string, string>) => (await fetch(`${base}/api/add-project`, { headers: { authorization: `Bearer ${d.token}`, ...headers } })).json() as Promise<{ allowed: boolean; why: string | null; machineOwners: string[] }>;
  const events = () => {
    const log = new EventLog(eventsDb);
    try {
      return log.read(0);
    } finally {
      log.close();
    }
  };
  return { d, post, get, events };
}

test("the server refuses an Add project submit from an instance owner who isn't a machine owner, and records only the refusal", async () => {
  const s = await dashboard(['ada']);
  try {
    // example-owner owns this instance (admin on its repo) but isn't one of the machine's owners.
    const view = await s.get(asFreshPerson('example-owner'));
    assert.deepEqual([view.allowed, view.machineOwners], [false, ['ada']]);
    const r = await s.post({ name: 'shop', repo: 'acme/shop' });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error!, /machine owners: @ada\); @example-owner isn't one/);
    // A stale sign-in and a device off the list are refused the same way (a machine owner this time).
    const owner = await dashboard(['example-owner', 'example-collaborator']);
    try {
      // A machine owner who only writes on this instance's repo isn't an owner here: refused too.
      const writer = await owner.post({ name: 'shop', repo: 'acme/shop' }, asFreshPerson('example-collaborator'));
      assert.equal(writer.status, 403);
      assert.match(writer.body.error!, /only an owner of this instance who is one of the machine's owners/);
      assert.equal((await owner.get(asFreshPerson('example-owner'))).allowed, true, 'a machine owner, fresh, on an allowed device');
      const stale = await owner.post({ name: 'shop', repo: 'acme/shop' }, asFreshPerson('example-owner', Date.now() - 6 * 60_000));
      assert.equal(stale.status, 403);
      assert.match(stale.body.error!, /sign-in within the last 5 minutes/);
      const elsewhere = await owner.post({ name: 'shop', repo: 'acme/shop' }, { ...asFreshPerson('example-owner'), 'x-dashboard-console-device': '0' });
      assert.equal(elsewhere.status, 403);
      assert.match(elsewhere.body.error!, /allowed devices/);
      // The name and the repo are checked on the server too, whatever the page checked.
      for (const body of [{ name: 'Shop', repo: 'acme/shop' }, { name: 'shop;id', repo: 'acme/shop' }, { name: 'shop', repo: 'acme' }, { name: 'shop', repo: 'acme/../x' }, { name: 'shop', repo: 'acme/shop --x' }]) {
        assert.equal((await owner.post(body)).status, 400, JSON.stringify(body));
      }
      assert.deepEqual(machineRequests(owner.events().filter((e) => (MACHINE_EVENTS as readonly string[]).includes(e.type))), [], 'nothing recorded for the coordinator');
    } finally {
      await owner.d.close();
    }
    const events = s.events();
    assert.deepEqual(machineRequests(events), [], 'no machine request');
    const audit = events.filter((e) => e.type === 'dashboard.audit').map((e) => e.payload as unknown as { login: string; action: string; detail: { name: string } });
    assert.deepEqual(audit.map((a) => [a.login, a.action, a.detail.name]), [['example-owner', 'add_project.refused', 'shop']], 'the refusal is audited');
  } finally {
    await s.d.close();
  }
});

test("add-project's name and repo: the helper's rules, and nothing else", () => {
  for (const [name, repo] of [['shop', 'acme/shop'], ['a', 'a/b'], ['site-2', 'Acme-Co/site.web_2']]) assert.equal(addProjectRefusal(name, repo), null, `${name} ${repo}`);
  for (const [name, repo] of [['', 'a/b'], ['2shop', 'a/b'], ['shop_x', 'a/b'], ['a'.repeat(22), 'a/b'], ['shop', 'a/b/c'], ['shop', '/b'], ['shop', 'a/..'], ['shop', 'a/b c'], ['shop', 'a/b\n']]) assert.notEqual(addProjectRefusal(name, repo), null, `${name} ${repo}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { instanceSettingsView, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { exampleProject } from './helpers.js';

const POLICY = 'version: 1\nbudget: { daily_usd: 30 }\nagents: { max_workers: 3 }\nland_mode: pr\nsettings:\n  daily_budget_usd: 12\n';

function setup(user = 'example-owner', limits = { workers: { min: 1, max: 4 }, daily_budget_usd: { max: 20 }, max_fixes_per_pr: { max: 3 } }) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-settings-'));
  const { dir: root } = exampleProject();
  const policyFile = join(dir, 'policy.yaml');
  writeFileSync(policyFile, POLICY);
  const limitsPath = join(dir, 'limits.json');
  writeFileSync(limitsPath, JSON.stringify(limits));
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  return { dir, root, cfg: loadConfig(root), policyFile, limitsPath, eventsDb, user };
}

async function serve(s: ReturnType<typeof setup>, policyFile: string | null = s.policyFile) {
  const d = await startDashboard({ root: s.root, cfg: s.cfg, eventsDb: s.eventsDb, stateDir: s.dir, user: s.user, policyFile, limitsPath: s.limitsPath, slotsDir: join(s.dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
  const get = async () => (await (await fetch(`${base}/api/instance-settings`, { headers: h })).json()) as Record<string, unknown> & { settings: { key: string; value: unknown; source: string }[]; canChange: boolean };
  const post = (key: string, value: unknown) => fetch(`${base}/api/instance-settings`, { method: 'POST', headers: h, body: JSON.stringify({ key, value }) });
  return { d, base, h, get, post };
}

test('the instance settings: each value in effect and where it comes from, the bounds, and who may change them', async () => {
  const s = setup();
  const v = instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: s.user, limitsPath: s.limitsPath });
  assert.equal(v.available, true);
  assert.equal(v.canChange, true, 'the owner');
  assert.deepEqual(v.ceilings, { max_workers: 3, daily_usd: 30 });
  assert.deepEqual(v.limits, { workers: { min: 1, max: 4 }, daily_budget_usd: { max: 20 }, max_fixes_per_pr: { max: 3 }, research: { max_searches_per_day: 200, max_fetches_per_day: 500, max_usd_per_day: 20 } });
  const by = Object.fromEntries((v.settings ?? []).map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(by), ['workers', 'daily_budget_usd', 'ci_repair.enabled', 'ci_repair.max_fixes_per_pr', 'run_windows', 'research.max_searches_per_day', 'research.max_fetches_per_day', 'research.max_usd_per_day', 'research.repo_access']);
  assert.equal(by['research.repo_access']!.value, false, 'research has no repo access unless the owner turns it on');
  assert.deepEqual(by.daily_budget_usd, { key: 'daily_budget_usd', value: 12, source: 'instance' });
  assert.equal(by.workers!.source, 'repo', 'not set on the instance: the repo default');
  assert.equal(instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: 'example-collaborator', limitsPath: s.limitsPath }).canChange, false, 'a writer is not the owner');
  assert.equal(instanceSettingsView({ policyFile: null, cfg: s.cfg, user: s.user }).available, false, 'a checkout has no instance settings');
  writeFileSync(s.limitsPath, '{not json');
  const broken = instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: s.user, limitsPath: s.limitsPath });
  assert.equal(broken.canChange, false, 'unreadable machine limits: no changes');
  assert.match(String('limitsError' in broken ? broken.limitsError : ''), /unreadable/);
});

test('the owner changes a setting through the instance\'s own server: written, recorded as settings.changed, shown on Activity', async () => {
  const s = setup();
  const x = await serve(s);
  try {
    assert.equal((await fetch(`${x.base}/api/instance-settings`)).status, 401);
    const r = await x.post('workers', 2);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { ok: true, from: 1, to: 2 });
    assert.match(readFileSync(s.policyFile, 'utf8'), /workers: 2/);
    const v = await x.get();
    assert.deepEqual(v.settings.find((y) => y.key === 'workers'), { key: 'workers', value: 2, source: 'instance' });
    assert.equal((await x.post('run_windows', [{ from: '22:00', to: '06:00' }])).status, 200);
    const changed = new EventLog(s.eventsDb).read(0, ['settings.changed']);
    assert.deepEqual(changed.map((e) => [(e.payload as { key: string }).key, (e.payload as { by: string }).by, e.source]), [['workers', 'example-owner', 'human'], ['run_windows', 'example-owner', 'human']]);
    const st = (await (await fetch(`${x.base}/api/state`, { headers: x.h })).json()) as { activity: { summary: string; type: string }[] };
    assert.ok(st.activity.some((a) => a.type === 'settings.changed' && a.summary === 'setting workers: 1 → 2, by @example-owner'), 'on Activity');
    assert.ok(st.activity.some((a) => a.summary === 'setting run_windows: any time → 22:00-06:00, by @example-owner'));
  } finally {
    await x.d.close();
  }
});

test('a change outside the bounds, of an unknown setting, or by anyone but the owner is refused and changes nothing', async () => {
  const s = setup();
  const x = await serve(s);
  try {
    for (const [key, value, why] of [
      ['workers', 4, /over the policy's max_workers 3/],
      ['workers', 0, /outside 1-4/],
      ['daily_budget_usd', 25, /over 20 \(machine limits\)/],
      ['ci_repair.max_fixes_per_pr', 9, /over 3/],
      ['budget', 1, /unknown setting/],
    ] as [string, unknown, RegExp][]) {
      const r = await x.post(key, value);
      assert.equal(r.status, 400, `${key}=${value}`);
      assert.match(((await r.json()) as { error: string }).error, why);
    }
    assert.equal(readFileSync(s.policyFile, 'utf8'), POLICY, 'nothing written');
    assert.equal(new EventLog(s.eventsDb).read(0, ['settings.changed']).length, 0);
  } finally {
    await x.d.close();
  }
  const other = setup('example-collaborator');
  const y = await serve(other);
  try {
    assert.equal((await y.get()).canChange, false);
    const r = await y.post('workers', 2);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /only the owner \(@example-owner\)/);
    assert.equal(readFileSync(other.policyFile, 'utf8'), POLICY);
  } finally {
    await y.d.close();
  }
  const checkout = setup();
  const z = await serve(checkout, null);
  try {
    assert.equal((await z.post('workers', 2)).status, 400, 'a checkout has no instance settings to change');
  } finally {
    await z.d.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { instanceSettingsView, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRole, exampleRoles } from './helpers.js';

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
  const d = await startDashboard({ root: s.root, cfg: s.cfg, eventsDb: s.eventsDb, stateDir: s.dir, user: 'example-owner', roleOf: exampleRoles, policyFile, limitsPath: s.limitsPath, slotsDir: join(s.dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(s.user) };
  const get = async () => (await (await fetch(`${base}/api/instance-settings`, { headers: h })).json()) as Record<string, unknown> & { settings: { key: string; value: unknown; source: string }[]; canChange: boolean };
  const post = (key: string, value: unknown) => fetch(`${base}/api/instance-settings`, { method: 'POST', headers: h, body: JSON.stringify({ key, value }) });
  return { d, base, h, get, post };
}

test('the instance settings: each value in effect and where it comes from, the bounds, and who may change them', async () => {
  const s = setup();
  const v = instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: s.user, role: exampleRole(s.user), limitsPath: s.limitsPath });
  assert.equal(v.available, true);
  assert.equal(v.canChange, true, 'the owner');
  assert.deepEqual(v.ceilings, { max_workers: 3, daily_usd: 30 });
  assert.deepEqual(v.limits, {
    workers: { min: 1, max: 4 },
    daily_budget_usd: { max: 20 },
    max_fixes_per_pr: { max: 3 },
    research: { max_searches_per_day: 200, max_fetches_per_day: 500, max_usd_per_day: 20 },
    intake: { reports_per_sender_per_day: 100, drafts_per_day: 200, max_usd_per_day: 20 },
  });
  const by = Object.fromEntries((v.settings ?? []).map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(by), [
    'workers',
    'daily_budget_usd',
    'ci_repair.enabled',
    'ci_repair.max_fixes_per_pr',
    'run_windows',
    'research.max_searches_per_day',
    'research.max_fetches_per_day',
    'research.max_usd_per_day',
    'research.repo_access',
    'intake.reports_per_sender_per_day',
    'intake.drafts_per_day',
    'intake.max_usd_per_day',
    'stuck_guard',
    'chat_attachments.max_file_mb',
    'chat_attachments.max_message_mb',
    'chat_attachments.retention_days',
  ]);
  assert.deepEqual([by['chat_attachments.max_file_mb']!.value, by['chat_attachments.max_message_mb']!.value, by['chat_attachments.retention_days']!.value], [10, 25, 30], 'the chat attachments defaults');
  assert.equal(by.stuck_guard!.value, 'dry-run', 'the stuck-run guard only logs unless the owner turns it on');
  assert.equal(by['research.repo_access']!.value, false, 'research has no repo access unless the owner turns it on');
  assert.deepEqual(by.daily_budget_usd, { key: 'daily_budget_usd', value: 12, source: 'instance' });
  assert.equal(by.workers!.source, 'repo', 'not set on the instance: the repo default');
  assert.equal(instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: 'example-collaborator', role: 'writer', limitsPath: s.limitsPath }).canChange, false, 'a writer is not the owner');
  assert.equal(instanceSettingsView({ policyFile: null, cfg: s.cfg, user: s.user, role: exampleRole(s.user) }).available, false, 'a checkout has no instance settings');
  writeFileSync(s.limitsPath, '{not json');
  const broken = instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: s.user, role: exampleRole(s.user), limitsPath: s.limitsPath });
  assert.equal(broken.canChange, false, 'unreadable machine limits: no changes');
  assert.match(String('limitsError' in broken ? broken.limitsError : ''), /unreadable/);
});

test('where a value comes from: the instance\'s policy, else the repo\'s config only where it defines the key, else the engine\'s default', () => {
  const s = setup();
  writeFileSync(s.policyFile, `${POLICY}  research: { max_usd_per_day: 3 }\n`);
  const sources = () => {
    const v = instanceSettingsView({ policyFile: s.policyFile, cfg: s.cfg, user: s.user, role: exampleRole(s.user), limitsPath: s.limitsPath });
    assert.ok(v.available);
    return Object.fromEntries((v.settings ?? []).map((x) => [x.key, x.source]));
  };
  assert.deepEqual(sources(), {
    workers: 'repo', // agents.yaml: roles.workers.count
    daily_budget_usd: 'instance', // the policy sets it
    'ci_repair.enabled': 'engine', // the example's agents.yaml has no ci_repair role
    'ci_repair.max_fixes_per_pr': 'engine',
    run_windows: 'repo', // config.yaml: agent_runtime.run_windows: [] is defined, if empty
    'research.max_searches_per_day': 'engine', // the repo's config can't set research caps
    'research.max_fetches_per_day': 'engine',
    'research.max_usd_per_day': 'instance',
    'research.repo_access': 'engine',
    'intake.reports_per_sender_per_day': 'engine', // intake caps default from intake.yaml, never the repo's config
    'intake.drafts_per_day': 'engine',
    'intake.max_usd_per_day': 'engine',
    stuck_guard: 'engine', // only the instance's policy sets the guard's mode
    'chat_attachments.max_file_mb': 'engine', // only the instance's policy sets the chat attachments' caps
    'chat_attachments.max_message_mb': 'engine',
    'chat_attachments.retention_days': 'engine',
  });
  // The repo's config as written, not as loaded with defaults: drop a key from the file and it's the engine's.
  const agents = join(s.cfg.dir, 'agents.yaml');
  writeFileSync(agents, readFileSync(agents, 'utf8').replace('count: 1, ', ''));
  const config = join(s.cfg.dir, 'config.yaml');
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^\s*run_windows:.*\n/m, ''));
  const after = sources();
  assert.equal(after.workers, 'engine');
  assert.equal(after.run_windows, 'engine');
  // Every setting key gets one of the three, and the page labels each.
  assert.ok(Object.values(after).every((x) => ['instance', 'repo', 'engine'].includes(x)));
});

test('the owner changes a setting through the instance\'s own server: written, recorded as settings.changed, shown on Activity', async () => {
  const s = setup();
  const x = await serve(s);
  try {
    assert.equal((await fetch(`${x.base}/api/instance-settings`)).status, 401);
    // Round 11 (the owner's decision of 2026-10-19): the dashboard only tightens, so a raise is refused, naming the
    // admin's route; until then this raised workers 1 → 2 here. A lowering goes as before.
    const up = await x.post('workers', 2);
    assert.equal(up.status, 400);
    assert.match(await up.text(), /settings\.workers 2 would loosen it \(now 1\)/);
    const r = await x.post('chat_attachments.retention_days', 7);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { ok: true, from: 30, to: 7 });
    assert.match(readFileSync(s.policyFile, 'utf8'), /retention_days: 7/);
    const v = await x.get();
    assert.deepEqual(v.settings.find((y) => y.key === 'chat_attachments.retention_days'), { key: 'chat_attachments.retention_days', value: 7, source: 'instance' });
    assert.equal((await x.post('run_windows', [{ from: '22:00', to: '06:00' }])).status, 200);
    const changed = new EventLog(s.eventsDb).read(0, ['settings.changed']);
    assert.deepEqual(changed.map((e) => [(e.payload as { key: string }).key, (e.payload as { by: string }).by, e.source]), [['chat_attachments.retention_days', 'example-owner', 'human'], ['run_windows', 'example-owner', 'human']]);
    const st = (await (await fetch(`${x.base}/api/state`, { headers: x.h })).json()) as { activity: { summary: string; type: string }[] };
    assert.ok(st.activity.some((a) => a.type === 'settings.changed' && a.summary === 'setting chat_attachments.retention_days: 30 → 7, by @example-owner'), 'on Activity');
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

test("#882: a change refused on the machine's limits file or the policy file answers the engine's own words; the file's path and the parser's text are in the dashboard's log only", async () => {
  const s = setup();
  writeFileSync(s.limitsPath, '{not json');
  const x = await serve(s);
  const lines: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    const r = await x.post('workers', 2);
    const body = (await r.json()) as { error: string };
    writeFileSync(s.policyFile, 'version: 1\nbudget: { daily_usd: lots }\n');
    const policy = await fetch(`${x.base}/api/first-run/policy`, { method: 'POST', headers: x.h, body: JSON.stringify({ values: { auto_merge: false } }) });
    const policyBody = (await policy.json()) as { error: string };
    console.error = was;
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(body, { error: "the machine's limits file is unreadable; the detail is in the dashboard's log on the machine" });
    assert.equal(policy.status, 400, JSON.stringify(policyBody));
    assert.match(policyBody.error, /^this instance's policy\.yaml is invalid: budget\.daily_usd: .+; the detail is in the dashboard's log on the machine$/);
    for (const text of [body.error, policyBody.error]) for (const leak of [s.dir, tmpdir(), 'JSON']) assert.ok(!text.includes(leak), `${leak} in ${text}`);
    assert.ok(lines.some((l) => l.includes('POST /api/instance-settings') && l.includes(s.limitsPath) && l.includes('JSON')), `the limits file's path and the parser's text are logged: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes('POST /api/first-run/policy') && l.includes(s.policyFile)), `the policy file's path is logged: ${JSON.stringify(lines)}`);
  } finally {
    console.error = was;
    await x.d.close();
  }
});

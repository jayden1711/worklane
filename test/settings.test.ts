import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { PolicyFile } from '../src/instance.js';
import { buildReport } from '../src/reports.js';
import { applySettings, changeSetting, inRunWindow, loadLimits, settingsProblems, settingsReader, SettingsError } from '../src/settings.js';
import { parse as parseYaml } from 'yaml';
import { exampleProject } from './helpers.js';

const cfg = loadConfig(exampleProject().dir);
const owner = cfg.project.owners.default;
const dir = () => mkdtempSync(join(tmpdir(), 'settings-'));
const POLICY = `version: 1
# the operator's notes stay
budget: { daily_usd: 50 }
agents: { max_workers: 4 }
land_mode: pr
`;

function instance(policy = POLICY) {
  const d = dir();
  const policyPath = join(d, 'policy.yaml');
  writeFileSync(policyPath, policy, { mode: 0o600 });
  return { d, policyPath, eventsDb: join(d, 'events.db'), limitsPath: join(d, 'limits.json') };
}

test('limits: the engine defaults without a limits file; a broken one is an error, never a silent default', () => {
  const d = dir();
  assert.deepEqual(loadLimits(join(d, 'none.json')), { workers: { min: 1, max: 8 }, daily_budget_usd: { max: 100 }, max_fixes_per_pr: { max: 5 } });
  writeFileSync(join(d, 'l.json'), JSON.stringify({ workers: { min: 1, max: 2 } }));
  assert.deepEqual(loadLimits(join(d, 'l.json')).workers, { min: 1, max: 2 });
  writeFileSync(join(d, 'bad.json'), '{ nope');
  assert.throws(() => loadLimits(join(d, 'bad.json')), /unreadable/);
  writeFileSync(join(d, 'odd.json'), JSON.stringify({ workers: { max: 'lots' } }));
  assert.throws(() => loadLimits(join(d, 'odd.json')), /invalid/);
});

test('bounds: outside the machine limits or over the policy ceilings is a problem; inside is not', () => {
  const limits = loadLimits(join(dir(), 'none.json'));
  const policy = { budget: { daily_usd: 50 }, agents: { max_workers: 4 } };
  assert.deepEqual(settingsProblems({ workers: 3, daily_budget_usd: 30, ci_repair: { max_fixes_per_pr: 2 }, run_windows: [{ from: '08:00', to: '23:00' }] }, limits, policy), []);
  assert.match(settingsProblems({ workers: 0 }, limits).join(), /workers 0 is outside 1-8/);
  assert.match(settingsProblems({ workers: 9 }, limits).join(), /workers 9 is outside 1-8/);
  assert.match(settingsProblems({ workers: 5 }, limits, policy).join(), /over the policy's max_workers 4/);
  assert.match(settingsProblems({ daily_budget_usd: 101 }, limits).join(), /over 100 \(machine limits\)/);
  assert.match(settingsProblems({ daily_budget_usd: 60 }, limits, policy).join(), /over the policy's budget 50/);
  assert.match(settingsProblems({ ci_repair: { max_fixes_per_pr: 6 } }, limits).join(), /max_fixes_per_pr 6 is over 5/);
  assert.match(settingsProblems({ run_windows: [{ from: '09:00', to: '09:00' }] }, limits).join(), /is empty/);
});

test("the instance's settings win over the repo's; what isn't set keeps the repo's value", () => {
  assert.deepEqual(applySettings(cfg, {}), cfg, 'nothing set: the repo config as is');
  const eff = applySettings(cfg, { workers: 3, daily_budget_usd: 12, ci_repair: { enabled: true, max_fixes_per_pr: 1 }, run_windows: [{ from: '08:00', to: '20:00' }] });
  assert.equal(eff.agents.roles.workers!.count, 3);
  assert.equal(eff.agents.roles.workers!.model, cfg.agents.roles.workers!.model);
  assert.equal(eff.agents.daily_budget_usd, 12);
  assert.deepEqual(eff.agents.roles.ci_repair, { enabled: true, model: cfg.agents.roles.workers!.model, max_fixes_per_pr: 1 });
  assert.deepEqual(eff.project.agent_runtime.run_windows, [{ from: '08:00', to: '20:00' }]);
  assert.equal(cfg.agents.daily_budget_usd, 40, 'the repo config itself is untouched');
  assert.equal(applySettings(cfg, { ci_repair: { enabled: false } }).agents.roles.ci_repair!.enabled, false);
});

test('run windows: inside, outside, across midnight, and none means always', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 10, h, m);
  assert.equal(inRunWindow([], at(3, 0)), true);
  assert.equal(inRunWindow([{ from: '08:00', to: '23:00' }], at(8, 0)), true);
  assert.equal(inRunWindow([{ from: '08:00', to: '23:00' }], at(23, 0)), false);
  assert.equal(inRunWindow([{ from: '08:00', to: '23:00' }], at(7, 59)), false);
  assert.equal(inRunWindow([{ from: '22:00', to: '06:00' }], at(2, 0)), true);
  assert.equal(inRunWindow([{ from: '22:00', to: '06:00' }], at(12, 0)), false);
  assert.equal(inRunWindow([{ from: '08:00', to: '09:00' }, { from: '20:00', to: '21:00' }], at(20, 30)), true);
});

test("a policy without settings is still valid (they're optional)", () => {
  assert.deepEqual(PolicyFile.parse({ version: 1, budget: { daily_usd: 5 } }).settings, {});
});

test('the reader picks up a changed policy without a restart, and refuses bad settings (the repo values apply)', () => {
  const i = instance(`${POLICY}settings: { workers: 2 }\n`);
  const read = settingsReader(i.policyPath, i.limitsPath);
  assert.deepEqual(read(), { settings: { workers: 2 }, error: null });
  const bump = (text: string) => {
    writeFileSync(i.policyPath, text);
    const t = statSync(i.policyPath).mtimeMs / 1000 + 5;
    utimesSync(i.policyPath, t, t);
  };
  bump(`${POLICY}settings: { workers: 3 }\n`);
  assert.deepEqual(read(), { settings: { workers: 3 }, error: null });
  bump(`${POLICY}settings: { workers: 7 }\n`);
  const over = read();
  assert.deepEqual(over.settings, {});
  assert.match(String(over.error), /settings refused: workers 7 is over the policy's max_workers 4/);
  bump(`${POLICY}settings: { workers: two }\n`);
  assert.match(String(read().error), /unusable/);
  writeFileSync(i.limitsPath, JSON.stringify({ workers: { min: 1, max: 1 } }));
  bump(`${POLICY}settings: { workers: 2 }\n`);
  assert.match(String(read().error), /outside 1-1/, 'the machine limits apply too');
});

test('changing a setting: owner only; checked, written atomically (0600, comments kept), recorded as settings.changed', () => {
  const i = instance();
  const base = { policyPath: i.policyPath, cfg, eventsDb: i.eventsDb, limitsPath: i.limitsPath, now: () => new Date('2026-10-10T12:00:00Z') };
  assert.throws(() => changeSetting({ ...base, key: 'workers', value: 2, by: 'someone-else' }), (e: Error) => e instanceof SettingsError && /only the owner/.test(e.message));
  assert.throws(() => changeSetting({ ...base, key: 'workers', value: 2, by: '' }), /only the owner/);
  assert.throws(() => changeSetting({ ...base, key: 'land_mode', value: 'direct', by: owner }), /unknown setting land_mode/);
  assert.throws(() => changeSetting({ ...base, key: 'workers', value: 9, by: owner }), /refused: workers 9 is outside 1-8/);
  assert.throws(() => changeSetting({ ...base, key: 'workers', value: 'many', by: owner }), /refused: settings\.workers/);
  assert.equal(readFileSync(i.policyPath, 'utf8'), POLICY, 'a refused change writes nothing');

  const r = changeSetting({ ...base, key: 'workers', value: 3, by: owner.toUpperCase() });
  assert.deepEqual(r, { from: cfg.agents.roles.workers!.count ?? 1, to: 3 });
  const text = readFileSync(i.policyPath, 'utf8');
  assert.match(text, /# the operator's notes stay/);
  assert.match(text, /settings:\s*\n\s+workers: 3/);
  assert.deepEqual(PolicyFile.parse(parseYaml(text)).settings, { workers: 3 });
  if (process.platform !== 'win32') assert.equal(statSync(i.policyPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(i.d).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  changeSetting({ ...base, key: 'ci_repair.max_fixes_per_pr', value: 1, by: owner });
  const log = new EventLog(i.eventsDb);
  const events = log.read(0, ['settings.changed']);
  log.close();
  assert.deepEqual(events.map((e) => [e.payload, e.source]), [
    [{ key: 'workers', from: cfg.agents.roles.workers!.count ?? 1, to: 3, by: owner.toUpperCase(), at: '2026-10-10T12:00:00.000Z' }, 'human'],
    [{ key: 'ci_repair.max_fixes_per_pr', from: 2, to: 1, by: owner, at: '2026-10-10T12:00:00.000Z' }, 'human'],
  ]);
});

test('report: settings changed since the last report are listed', () => {
  const ev = { id: 1, ts: '2026-10-10T12:00:00Z', type: 'settings.changed', actor: owner, source: 'human', payload: { key: 'workers', from: 1, to: 3, by: owner, at: '2026-10-10T12:00:00Z' } };
  const md = buildReport([ev as never], cfg, { since: new Date('2026-10-10T08:00:00Z'), now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown;
  assert.match(md, new RegExp(`\\*\\*Settings changed\\*\\* \\(1\\)\\n- workers: 1 → 3 \\(@${owner}\\)`));
  assert.doesNotMatch(buildReport([], cfg, { since: new Date('2026-10-10T08:00:00Z'), now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown, /Settings changed/);
});

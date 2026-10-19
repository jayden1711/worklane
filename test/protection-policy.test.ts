// WHY: wizard screens 6 and 8 change what guards the default branch and the instance's merge policy, so each is
// checked end to end through the dashboard: the change shown first, owners only, confirmed, audited, and refused
// whenever it would replace protection, loosen past the machine's limits, or break the repo's config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard, type DashboardOptions } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install } from '../src/install.js';
import { setPolicyRootUid } from '../src/policy-gate.js';
import { ownPolicy } from '../src/policy-root.js';
import { protectionBody, type ActionPlan } from '../src/setup-actions.js';
import type { RunResult, SetupProbe, SetupView } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'protection-policy-state-'));

function fixture(checks = true) {
  const { dir } = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  if (checks) appendFileSync(join(dir, BRAND.configDir, 'config.yaml'), '\nrequired_checks: [ci/test, ci/lint]\n');
  git('remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git');
  if (checks) git('commit', '-qam', 'checks');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  install({ root: dir });
  return { dir };
}

const probe = (protectedNow: () => boolean): SetupProbe => ({
  which: (c) => `/stand-in/${c}`,
  run: (cmd, args) => (cmd === 'gh' && args.join(' ').endsWith('/protection --silent') ? (protectedNow() ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' }) : { status: 1, stdout: '', stderr: 'no stand-in' }),
  serviceRunning: () => false,
  systemUnitActive: () => false,
  linger: () => null,
});

/** GitHub as gh sees it: whether main is protected, what a PUT does, and every call. */
function github(o: { protectedNow?: boolean; refuse?: string } = {}) {
  const state = { protected: !!o.protectedNow, calls: [] as { args: string[]; input?: string }[] };
  const gh = (args: string[], input?: string): RunResult => {
    state.calls.push({ args, ...(input !== undefined ? { input } : {}) });
    if (args.includes('PUT')) {
      if (o.refuse) return { status: 1, stdout: '', stderr: o.refuse };
      state.protected = true;
      return { status: 0, stdout: '{}', stderr: '' };
    }
    return state.protected ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
  };
  return { state, gh };
}

async function dashboard(dir: string, over: Partial<DashboardOptions> & { protectedNow?: () => boolean } = {}) {
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const { protectedNow, ...rest } = over;
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'pp-slots-')), limitsPath: join(mkdtempSync(join(tmpdir(), 'pp-limits-')), 'none.json'), setupProbe: probe(protectedNow ?? (() => false)), ...rest });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (user = 'example-owner') => (await (await fetch(`${base}/api/first-run?fresh=1`, { headers: h(user) })).json()) as { setup: SetupView; actions: Record<string, ActionPlan>; policy: { fields: { key: string; value: unknown; max?: number; only?: unknown; root?: string }[]; fixed: { key: string }[]; error: string | null } | null };
  const post = async (path: string, user: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { ok?: boolean; detail?: string; error?: string; changes?: { key: string; from: unknown; to: unknown }[]; confirmed?: boolean; queued?: boolean; requested?: string } };
  };
  const events = (types: ('settings.changed' | 'dashboard.audit' | 'machine.requested')[]) => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, types).map((e) => e.payload as unknown as Record<string, unknown>);
    } finally {
      log.close();
    }
  };
  return { d, get, post, events, stateDir };
}

test('Protect the default branch: the exact request shown first; confirmed by an owner, GitHub requires the named checks and nothing else; audited; the step turns done', async () => {
  const { dir } = fixture();
  const gh = github();
  const s = await dashboard(dir, { setupActions: { gh: gh.gh }, protectedNow: () => gh.state.protected });
  try {
    const v = await s.get();
    const plan = v.actions.protection!;
    assert.equal(plan.available, true);
    assert.match(plan.changes[0]!, /example-org\/example-shop's main: a PR's checks ci\/test, ci\/lint must pass before it merges, not strict/);
    assert.match(plan.changes[1]!, /no required reviews, no push restrictions, admins not bound; .*never replaced/);
    assert.match(plan.commands[0]!, /^gh api --method PUT repos\/example-org\/example-shop\/branches\/main\/protection --input - <<'JSON'\n\{"required_status_checks":\{"strict":false,"contexts":\["ci\/test","ci\/lint"\]\},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null\}\nJSON$/);
    assert.equal((await s.post('/api/first-run/actions/protection', 'example-collaborator', { confirm: true })).status, 403);
    assert.equal((await s.post('/api/first-run/actions/protection', 'example-owner', {})).status, 400);
    assert.equal(gh.state.calls.length, 0, 'GitHub not asked by a refusal');
    const r = await s.post('/api/first-run/actions/protection', 'example-owner', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const put = gh.state.calls.find((c) => c.args.includes('PUT'))!;
    assert.deepEqual(put.args, ['api', '--method', 'PUT', 'repos/example-org/example-shop/branches/main/protection', '--input', '-']);
    assert.deepEqual(JSON.parse(put.input!), protectionBody(loadConfig(dir)));
    assert.equal((await s.get()).setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'protection')!.done, true);
    assert.deepEqual(s.events(['dashboard.audit']).map((a) => a.action), ['first_run.action_refused', 'first_run.action_refused', 'first_run.action']);
  } finally {
    await s.d.close();
  }
});

test('Protect the default branch: protection that exists is never replaced; GitHub refusing (not an admin) says so', async () => {
  const { dir } = fixture();
  const already = github({ protectedNow: true });
  const s = await dashboard(dir, { setupActions: { gh: already.gh } });
  try {
    const r = await s.post('/api/first-run/actions/protection', 'example-owner', { confirm: true });
    assert.equal(r.status, 500);
    assert.match(r.body.error!, /main is protected already; not replaced/);
    assert.equal(already.state.calls.some((c) => c.args.includes('PUT')), false, 'no PUT');
  } finally {
    await s.d.close();
  }
  const refusing = github({ refuse: 'gh: Must have admin rights to Repository. (HTTP 404)' });
  const s2 = await dashboard(dir, { setupActions: { gh: refusing.gh } });
  try {
    const r = await s2.post('/api/first-run/actions/protection', 'example-owner', { confirm: true });
    assert.equal(r.status, 500);
    assert.match(r.body.error!, /^GitHub refused: gh: Must have admin rights/);
  } finally {
    await s2.d.close();
  }
});

test('Protect the default branch: not offered without required checks, nor on a server instance (its App has no admin rights)', async () => {
  const none = fixture(false);
  const s = await dashboard(none.dir, { setupActions: { gh: github().gh } });
  try {
    const plan = (await s.get()).actions.protection!;
    assert.equal(plan.available, false);
    assert.match(plan.why!, /name the required checks first/);
    assert.equal((await s.post('/api/first-run/actions/protection', 'example-owner', { confirm: true })).status, 409);
  } finally {
    await s.d.close();
  }
  const { dir } = fixture();
  const s2 = await dashboard(dir, { instance: 'shop', setupContext: { instanceFacts: () => ({ error: 'not here' }) }, setupActions: { gh: github().gh } });
  try {
    assert.match((await s2.get()).actions.protection!.why!, /no administration permission\); a repo admin sets it at https:\/\/github\.com\/example-org\/example-shop\/settings\/branches/);
  } finally {
    await s2.d.close();
  }
});

function policyFixture() {
  const { dir } = fixture();
  const home = mkdtempSync(join(tmpdir(), 'pp-instance-'));
  const policyFile = join(home, 'policy.yaml');
  writeFileSync(policyFile, 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\n# kept: a person wrote this\nauto_merge: false\n', { mode: 0o600 });
  return { dir, policyFile };
}

test('the Policy form: each key with its bounds; Review shows the change and writes nothing; Confirm writes exactly it, keeps the comments, logs and audits it', async () => {
  const { dir, policyFile } = policyFixture();
  // Automations on, so one confirm can tighten two keys (round 12: the form wrote and logged two until round 11).
  appendFileSync(policyFile, 'automations: { enabled: true }\n');
  const s = await dashboard(dir, { instance: 'shop', policyFile, setupContext: { instanceFacts: () => ({ error: 'not here' }) } });
  try {
    const p = (await s.get()).policy!;
    assert.deepEqual(p.fields.map((f) => [f.key, f.value]), [['budget.daily_usd', 50], ['agents.max_workers', 4], ['land_mode', 'pr'], ['auto_merge', false], ['main_watch', 'auto'], ['automations.enabled', true]]);
    assert.equal(p.fields[0]!.max, 100, "the machine's limit");
    assert.deepEqual(p.fixed.map((f) => f.key), ['sandbox', 'allow_same_user', 'lanes', 'network_allow', 'pre_approved']);
    const before = readFileSync(policyFile, 'utf8');
    // Round 11 (the owner's decision of 2026-10-19): the form only tightens, on this unrecorded install too; until
    // then this test raised the budget to 60 and turned automations on. A lowering is reviewed and written as before.
    const preview = await s.post('/api/first-run/policy', 'example-owner', { values: { 'budget.daily_usd': 45, 'automations.enabled': false, land_mode: 'pr' } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.confirmed, false);
    assert.deepEqual(preview.body.changes, [{ key: 'budget.daily_usd', from: 50, to: 45 }, { key: 'automations.enabled', from: true, to: false }]);
    assert.equal(readFileSync(policyFile, 'utf8'), before, 'Review writes nothing');
    assert.equal((await s.post('/api/first-run/policy', 'example-collaborator', { values: { auto_merge: true }, confirm: true })).status, 403);
    // auto_merge on is an admin's alone on every install, this unrecorded one too (#770): refused, nothing written.
    const on = await s.post('/api/first-run/policy', 'example-owner', { values: { auto_merge: true }, confirm: true });
    assert.equal(on.status, 400);
    assert.match(on.body.error!, /auto_merge true: that is an admin's alone, never this form's/);
    assert.equal(readFileSync(policyFile, 'utf8'), before);
    const raise = await s.post('/api/first-run/policy', 'example-owner', { values: { 'budget.daily_usd': 60, 'agents.max_workers': 5 }, confirm: true });
    assert.equal(raise.status, 400);
    assert.match(raise.body.error!, /budget\.daily_usd 60 would loosen it \(now 50\).*agents\.max_workers 5 would loosen it \(now 4\)/);
    assert.equal(readFileSync(policyFile, 'utf8'), before);
    const ok = await s.post('/api/first-run/policy', 'example-owner', { values: { 'budget.daily_usd': 45, 'automations.enabled': false }, confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = readFileSync(policyFile, 'utf8');
    assert.match(after, /daily_usd: 45/);
    assert.match(after, /enabled: false/);
    assert.match(after, /auto_merge: false/);
    assert.match(after, /# kept: a person wrote this/);
    assert.deepEqual(s.events(['settings.changed']).map((e) => [e.key, e.to, e.by]), [['policy.budget.daily_usd', 45, 'example-owner'], ['policy.automations.enabled', false, 'example-owner']]);
    assert.deepEqual(s.events(['dashboard.audit']).map((a) => a.action), ['first_run.policy_refused', 'first_run.policy_refused', 'first_run.policy_refused', 'first_run.policy']);
  } finally {
    await s.d.close();
  }
});

test("the Policy form refuses, writing nothing: an isolation key, over the machine's limits, below what the repo's config asks (it would stop the instance loading), and a checkout", async () => {
  const { dir, policyFile } = policyFixture();
  const s = await dashboard(dir, { instance: 'shop', policyFile, setupContext: { instanceFacts: () => ({ error: 'not here' }) } });
  const before = readFileSync(policyFile, 'utf8');
  try {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ sandbox: false }, /not editable here: sandbox/],
      [{ allow_same_user: true }, /not editable here: allow_same_user/],
      [{ 'budget.daily_usd': 150 }, /budget\.daily_usd 150 is over 100 \(machine limits\)/],
      [{ 'budget.daily_usd': 30 }, /agents\.yaml daily_budget_usd: 40 exceeds the policy budget 30/],
      [{ 'agents.max_workers': 2 }, /roles\.workers\.max: 4 exceeds the policy's max_workers 2/],
      [{ land_mode: 'sideways' }, /refused: land_mode/],
      [{ auto_merge: false }, /nothing to change/],
    ];
    for (const [values, why] of cases) {
      for (const confirm of [false, true]) {
        const r = await s.post('/api/first-run/policy', 'example-owner', { values, confirm });
        assert.equal(r.status, 400, JSON.stringify(values));
        assert.match(r.body.error!, why);
      }
    }
    assert.equal(readFileSync(policyFile, 'utf8'), before);
    assert.equal(s.events(['settings.changed']).length, 0);
  } finally {
    await s.d.close();
  }
  const local = await dashboard(dir);
  try {
    assert.equal((await local.get()).policy, null);
    assert.equal((await local.post('/api/first-run/policy', 'example-owner', { values: { auto_merge: true }, confirm: true })).status, 400);
  } finally {
    await local.d.close();
  }
});

test("a root policy.yaml (#726): the Policy form and Settings only queue a change for the coordinator and say so, in the answer and the audit; auto_merge on is root's alone and never asked; an old sudo is refused up front", { skip: process.platform !== 'linux' && 'a Linux machine install' }, async () => {
  const { dir } = fixture();
  // A machine instance whose policy.yaml setup made root's ("root" here: this test's own uid, a stand-in).
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'pp-root-')));
  const home = join(T, 'wl-shop');
  const inst = join(home, '.local', 'state', BRAND.cli, 'instances', 'shop');
  mkdirSync(inst, { recursive: true });
  const policyFile = join(inst, 'policy.yaml');
  writeFileSync(policyFile, 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n', { mode: 0o600 });
  const me = process.getuid!();
  ownPolicy('shop', { home: () => home, uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'none.json') });
  setPolicyRootUid(me);
  const rules = join(T, 'helper-rules.json');
  const s = await dashboard(dir, { instance: 'shop', policyFile, machine: { helperRulesPath: rules }, setupContext: { instanceFacts: () => ({ error: 'not here' }) } });
  const before = readFileSync(policyFile, 'utf8');
  try {
    const am = (await s.get()).policy!.fields.find((f) => f.key === 'auto_merge')!;
    assert.deepEqual([am.only, am.root], [false, `sudo ${BRAND.cli} policy set shop auto_merge on`], 'the form offers only off, and names the root command');
    for (const confirm of [false, true]) {
      const r = await s.post('/api/first-run/policy', 'example-owner', { values: { auto_merge: true }, confirm });
      assert.equal(r.status, 400);
      assert.match(r.body.error!, new RegExp(`auto_merge true: loosening it is an admin's, at a root shell \\(sudo ${BRAND.cli} policy set shop auto_merge on\\)`));
    }
    assert.equal(s.events(['machine.requested']).length, 0, 'nothing asked');
    // A change the helper takes: queued, and said so; the dashboard writes nothing.
    // (A lowering: round 10 refuses a raise past root's value up front, #726.)
    const form = await s.post('/api/first-run/policy', 'example-owner', { values: { 'budget.daily_usd': 40 }, confirm: true });
    assert.equal(form.status, 200, JSON.stringify(form.body));
    assert.equal(form.body.queued, true);
    // (A lowering: round 11 refuses a raise from the dashboard, workers 1 → 3 here until then.)
    const set = await s.post('/api/instance-settings', 'example-owner', { key: 'chat_attachments.retention_days', value: 7 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.queued, true);
    assert.equal(readFileSync(policyFile, 'utf8'), before);
    assert.deepEqual(s.events(['machine.requested']).map((e) => e.args), [['set-policy', 'budget.daily_usd', '40'], ['set-policy', 'settings.chat_attachments.retention_days', '7']]);
    assert.equal(s.events(['settings.changed']).length, 0, 'changed only once the helper ran it (the coordinator logs that)');
    const audits = s.events(['dashboard.audit']).map((a) => [a.action, (a.detail as { note?: string }).note]);
    assert.deepEqual(audits.filter(([a]) => a === 'first_run.policy' || a === 'settings.queued' || a === 'settings.changed'), [['first_run.policy', 'queued for the coordinator'], ['settings.queued', 'queued for the coordinator']]);
    // A sudo older than 1.9.10: refused up front, naming the root command, and nothing more asked.
    writeFileSync(rules, JSON.stringify({ sudo: '1.9.9', patterns_min: '1.9.10', left_out: ['add-project', 'stage-update-signer', 'discard-update-signer', 'claude-account-profiles', 'plugins', 'set-policy'] }));
    // (A lowering, as above: a raise is refused before the sudo is looked at.)
    const old = await s.post('/api/instance-settings', 'example-owner', { key: 'chat_attachments.retention_days', value: 6 });
    assert.equal(old.status, 400);
    assert.match(old.body.error!, new RegExp(`older than 1\\.9\\.10.*sudo ${BRAND.cli} policy set shop settings\\.chat_attachments\\.retention_days 6`));
    assert.equal(s.events(['machine.requested']).length, 2);
  } finally {
    setPolicyRootUid(0);
    await s.d.close();
  }
});

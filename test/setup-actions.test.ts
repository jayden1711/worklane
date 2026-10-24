// WHY: the first-run page's Fix actions (src/setup-actions.ts) change the machine, so each is checked end to end
// through the dashboard: its plan shown first, refused without a confirmation or for anyone but the owners, audited,
// and the step it fixes turns done on the next check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard, type DashboardOptions } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { GIT_HOOK_MARKER, install } from '../src/install.js';
import { ACTIONS, isActionId, type ActionPlan } from '../src/setup-actions.js';
import { SETUP_STEPS, type SetupProbe, type SetupView } from '../src/setup-steps.js';
import type { Download, ToolInstall } from '../src/tool-install.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'setup-actions-state-'));

test('every action Fix in the registry names an action, and that action fixes that step', () => {
  const withAction = SETUP_STEPS.filter((s) => s.fix.kind === 'action');
  assert.ok(withAction.length >= 3);
  for (const s of withAction) {
    const id = s.fix.kind === 'action' ? s.fix.action : '';
    assert.ok(isActionId(id), `${s.id}: ${id} is an action`);
    assert.equal(ACTIONS[id as keyof typeof ACTIONS].step, s.id, `${id} fixes ${s.id}`);
  }
});

/** A checkout with the example config, an origin and its hooks for local runs; tools as `tools` says. */
function fixture() {
  const { dir } = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  install({ root: dir });
  return { dir };
}

function probe(tools: Set<string>): SetupProbe {
  return {
    which: (c) => (tools.has(c) ? `/stand-in/${c}` : null),
    serviceManagerEnv: () => ({ env: {} }),
    run: (cmd, args, o = {}) => {
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      return { status: 1, stdout: '', stderr: 'no stand-in' };
    },
    serviceRunning: () => false,
    systemUnitActive: () => false,
    linger: () => null,
  };
}

/** A gh "release": a tar.gz holding one executable, and the plan that names it with its sha256. */
function fakeRelease(prefix: string) {
  const work = mkdtempSync(join(tmpdir(), 'fake-release-'));
  writeFileSync(join(work, 'gh'), '#!/bin/sh\necho stand-in gh\n', { mode: 0o755 });
  const archive = join(work, 'gh_9.9.9.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', work, 'gh']);
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const plan: ToolInstall = { tool: 'gh', version: '9.9.9', url: 'https://example.invalid/gh_9.9.9.tar.gz', checksum: { algo: 'sha256', value: sha }, archive: 'tar.gz', member: 'gh', dest: join(prefix, 'bin', 'gh'), prefix };
  const download: Download = async (_url, file) => writeFileSync(file, readFileSync(archive));
  return { plan, download };
}

async function dashboard(dir: string, tools: Set<string>, over: Partial<DashboardOptions> = {}) {
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'setup-actions-slots-')), setupProbe: probe(tools), ...over });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user) });
  const get = async (user = 'example-owner') => {
    const r = await fetch(`${base}/api/first-run?fresh=1`, { headers: h(user) });
    return (await r.json()) as { setup: SetupView; actions: Record<string, ActionPlan>; canAct: boolean };
  };
  const act = async (id: string, user: string, body: unknown) => {
    const r = await fetch(`${base}/api/first-run/actions/${id}`, { method: 'POST', headers: { ...h(user), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { ok?: boolean; detail?: string; error?: string } };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => e.payload as unknown as { login: string; action: string; detail: Record<string, unknown> }).filter((a) => a.action.startsWith('first_run.action'));
    } finally {
      log.close();
    }
  };
  return { d, get, act, audit };
}

const step = (v: SetupView, id: string) => v.groups.flatMap((g) => g.steps).find((s) => s.id === id)!;

/** console.error's lines while `f` runs: where the dashboard logs a failure's detail. */
async function logged<T>(f: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { result: await f(), lines };
  } finally {
    console.error = was;
  }
}

test('Install the missing tools: the pinned plan shown first; confirmed by an owner, installed and checked against its checksum; a writer and an unconfirmed click change nothing; audited', async () => {
  const { dir } = fixture();
  const prefix = mkdtempSync(join(tmpdir(), 'setup-actions-prefix-'));
  const tools = new Set(['git', 'gitleaks', 'claude']);
  const rel = fakeRelease(prefix);
  const s = await dashboard(dir, tools, { setupActions: { which: (c) => (tools.has(c) ? `/stand-in/${c}` : null), prefix, plan: () => rel.plan, download: rel.download } });
  try {
    const v = await s.get();
    assert.equal(step(v.setup, 'tools').done, false);
    const plan = v.actions['install-tools']!;
    assert.equal(plan.available, true);
    assert.match(plan.changes.join('\n'), new RegExp(`gh 9\\.9\\.9: https://example\\.invalid/gh_9\\.9\\.9\\.tar\\.gz \\(sha256 ${rel.plan.checksum.value}\\) -> ${prefix}/bin/gh; checked against the pinned checksum`));
    assert.equal(v.canAct, true);
    assert.equal((await s.get('example-collaborator')).canAct, false);
    assert.equal((await s.act('install-tools', 'example-owner', {})).status, 400);
    const writer = await s.act('install-tools', 'example-collaborator', { confirm: true });
    assert.equal(writer.status, 403);
    assert.match(writer.body.error!, /only the instance's owners/);
    assert.equal((await s.act('install-tools', 'someone-else', { confirm: true })).status, 403, "a viewer: the dashboard's read-only gate");
    assert.equal(existsSync(join(prefix, 'bin', 'gh')), false, 'nothing installed by a refusal');
    const ok = await s.act('install-tools', 'example-owner', { confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.detail!, /installed gh 9\.9\.9/);
    assert.match(readFileSync(join(prefix, 'bin', 'gh'), 'utf8'), /stand-in gh/);
    assert.deepEqual(s.audit().map((a) => [a.login, a.action]), [
      ['example-owner', 'first_run.action_refused'],
      ['example-collaborator', 'first_run.action_refused'],
      ['example-owner', 'first_run.action'],
    ]);
  } finally {
    await s.d.close();
  }
});

test('Install the missing tools: a download whose checksum differs installs nothing, says so, and is audited as failed', async () => {
  const { dir } = fixture();
  const prefix = mkdtempSync(join(tmpdir(), 'setup-actions-prefix-'));
  const tools = new Set(['git', 'gitleaks', 'claude']);
  const rel = fakeRelease(prefix);
  const tampered: Download = async (_url, file) => writeFileSync(file, 'not the release');
  const s = await dashboard(dir, tools, { setupActions: { which: (c) => (tools.has(c) ? `/stand-in/${c}` : null), prefix, plan: () => rel.plan, download: tampered } });
  // #882: the checksum detail goes to the dashboard's log; the page gets the engine's own words.
  const { result: r, lines } = await logged(() => s.act('install-tools', 'example-owner', { confirm: true }));
  try {
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "installing gh 9.9.9 failed; the detail is in the dashboard's log on the machine" });
    assert.ok(lines.some((l) => /POST \/api\/first-run\/actions\/install-tools failed: checksum mismatch .*nothing was installed/.test(l)), `the detail is logged: ${JSON.stringify(lines)}`);
    assert.equal(existsSync(join(prefix, 'bin', 'gh')), false);
    assert.equal(s.audit()[0]!.detail.ok, false);
  } finally {
    await s.d.close();
  }
});

test('#882: a Fix that throws an OS error answers 500 with a fixed text, never the error; the detail is in the log', async () => {
  const { dir } = fixture();
  // The settings file the hooks merge into is a directory: reading it throws EISDIR, a raw OS error.
  const settings = join(dir, '.claude', 'settings.json');
  rmSync(settings, { force: true });
  mkdirSync(settings);
  const s = await dashboard(dir, new Set(['git', 'gitleaks', 'claude', 'gh']));
  const { result: r, lines } = await logged(() => s.act('local-hooks', 'example-owner', { confirm: true }));
  try {
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.deepEqual(r.body, { error: "Install the hooks: not done; the detail is in the dashboard's log on the machine" });
    const text = JSON.stringify(r.body);
    for (const leak of [dir, tmpdir(), 'EISDIR', 'settings.json', '/']) assert.ok(!text.includes(leak), `${leak} in ${text}`);
    assert.ok(lines.some((l) => l.includes('POST /api/first-run/actions/local-hooks failed') && l.includes('EISDIR')), `the detail is logged: ${JSON.stringify(lines)}`);
    assert.doesNotMatch(JSON.stringify(s.audit()), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'nor in the audit');
  } finally {
    await s.d.close();
  }
});

test('one Fix at a time: a second click while one runs is refused', async () => {
  const { dir } = fixture();
  const prefix = mkdtempSync(join(tmpdir(), 'setup-actions-prefix-'));
  const tools = new Set(['git', 'gitleaks', 'claude']);
  const rel = fakeRelease(prefix);
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const slow: Download = async (url, file) => {
    await held;
    await rel.download(url, file);
  };
  const s = await dashboard(dir, tools, { setupActions: { which: (c) => (tools.has(c) ? `/stand-in/${c}` : null), prefix, plan: () => rel.plan, download: slow } });
  try {
    const first = s.act('install-tools', 'example-owner', { confirm: true });
    await new Promise((r) => setTimeout(r, 200));
    // Released after a second either way, so a regression fails here instead of hanging.
    const timer = setTimeout(release, 1000);
    const second = await s.act('install-tools', 'example-owner', { confirm: true });
    assert.equal(second.status, 409);
    assert.match(second.body.error!, /install-tools is running: one fix at a time/);
    clearTimeout(timer);
    release();
    assert.equal((await first).status, 200);
  } finally {
    await s.d.close();
  }
});

test("on a server instance, installing tools is the owner's root step: the plan says so and a click is refused", async () => {
  const { dir } = fixture();
  const tools = new Set(['git']);
  const s = await dashboard(dir, tools, { instance: 'shop', setupContext: { instanceFacts: () => ({ error: 'not here' }) }, setupActions: { which: (c) => (tools.has(c) ? `/stand-in/${c}` : null) } });
  try {
    const v = await s.get();
    assert.equal(v.actions['install-tools']!.available, false);
    assert.match(v.actions['install-tools']!.why!, /owner's root step \(scripts\/setup\/tools\.sh/);
    const r = await s.act('install-tools', 'example-owner', { confirm: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error!, /^not run: on a server/);
  } finally {
    await s.d.close();
  }
});

test('Install the git hooks: the hook files shown first; confirmed, the pre-commit scan and the pre-push guard are installed, and the step turns done', async () => {
  const { dir } = fixture();
  const s = await dashboard(dir, new Set(['git', 'gitleaks', 'claude', 'gh']));
  try {
    const v = await s.get();
    assert.equal(step(v.setup, 'pre-commit').done, false);
    const plan = v.actions['git-hooks']!;
    assert.match(plan.changes[0]!, /\.git\/hooks\/pre-commit: a gitleaks secret scan on every commit/);
    assert.match(plan.changes[1]!, /\.git\/hooks\/pre-push: refuses a push to main/);
    const r = await s.act('git-hooks', 'example-owner', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8').includes(GIT_HOOK_MARKER));
    assert.ok(existsSync(join(dir, '.git', 'hooks', 'pre-push')));
    assert.equal(step((await s.get()).setup, 'pre-commit').done, true);
    assert.equal((await s.get()).actions['git-hooks']!.available, true, 'a done step keeps its plan: it can be run again');
  } finally {
    await s.d.close();
  }
});

test("Install the hooks for local runs: the settings file shown first; confirmed, the guard hooks are merged in, the checkout's own settings kept, and the step turns done", async () => {
  const { dir } = fixture();
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'mine' }));
  const s = await dashboard(dir, new Set(['git', 'gitleaks', 'claude', 'gh']));
  try {
    const v = await s.get();
    assert.equal(step(v.setup, 'hooks').done, false);
    assert.match(v.actions['local-hooks']!.changes[0]!, /\.claude\/settings\.json: the guardrail hooks and rules for agent runs/);
    const r = await s.act('local-hooks', 'example-owner', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(step((await s.get()).setup, 'hooks').done, true);
    assert.equal((JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as { model?: string }).model, 'mine');
  } finally {
    await s.d.close();
  }
});

test('Fetch the fingerprints: the commands shown first; confirmed, only hashes are stored and the step turns done', async () => {
  const { dir } = fixture();
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'print-prod-env.mjs'), 'console.log(JSON.stringify({ DATABASE_URL: "postgres://app:s3cret@db.example.com:5432/shop" }));\n');
  const s = await dashboard(dir, new Set(['git', 'gitleaks', 'claude', 'gh']));
  try {
    const v = await s.get();
    assert.equal(step(v.setup, 'fingerprints').done, false);
    assert.deepEqual(v.actions.fingerprints!.commands, ['node scripts/print-prod-env.mjs    (prod-db: reads DATABASE_URL)']);
    const r = await s.act('fingerprints', 'example-owner', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.detail!, /prod-db: 1 stored/);
    assert.equal(step((await s.get()).setup, 'fingerprints').done, true);
    const stored = readFileSync(join(projectStateDir(dir), 'fingerprints.json'), 'utf8');
    assert.doesNotMatch(stored, /s3cret/, 'never the secret itself');
  } finally {
    await s.d.close();
  }
});

test('an unknown action is refused and audited', async () => {
  const { dir } = fixture();
  const s = await dashboard(dir, new Set(['git']));
  try {
    const r = await s.act('rm-rf', 'example-owner', { confirm: true });
    assert.equal(r.status, 404);
    assert.equal(s.audit()[0]!.action, 'first_run.action_refused');
  } finally {
    await s.d.close();
  }
});

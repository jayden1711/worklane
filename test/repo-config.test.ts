// WHY: wizard screen 4's Repo config form proposes config changes as a PR. Checked end to end against a real git
// origin (a bare repo) with a stand-in gh: the change is shown first, refused when the config wouldn't load, pushed
// only to a branch of its own, and the checkout itself is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install } from '../src/install.js';
import type { RunResult, SetupProbe, SetupView } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'repo-config-state-'));

function fixture() {
  const { dir } = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  const origin = join(mkdtempSync(join(tmpdir(), 'repo-config-origin-')), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', dir, origin]);
  git('remote', 'add', 'origin', origin);
  git('fetch', '-q', 'origin');
  install({ root: dir });
  return { dir, origin, git, remote: (...a: string[]) => execFileSync('git', a, { cwd: origin, encoding: 'utf8' }) };
}

const probe: SetupProbe = {
  which: (c) => `/stand-in/${c}`,
  serviceManagerEnv: () => ({ env: {} }),
  run: (cmd, args, o = {}) => {
    if (cmd === 'git') {
      try {
        return { status: 0, stdout: execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (e) {
        return { status: 1, stdout: '', stderr: String((e as { stderr?: string }).stderr ?? '') };
      }
    }
    return { status: 1, stdout: '', stderr: 'no stand-in' };
  },
  serviceRunning: () => false,
  systemUnitActive: () => false,
  linger: () => null,
};

function ghStandIn() {
  const calls: string[][] = [];
  const gh = (args: string[]): RunResult => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'create') return { status: 0, stdout: 'https://github.com/example-org/example-shop/pull/7\n', stderr: '' };
    if (args[0] === 'api' && args[1]!.endsWith('/check-runs')) return { status: 0, stdout: 'test\nlint\n', stderr: '' };
    if (args[0] === 'api' && args[1]!.endsWith('/status')) return { status: 0, stdout: 'ci/legacy\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'no stand-in' };
  };
  return { calls, gh };
}

async function dashboard(dir: string, gh: (args: string[]) => RunResult) {
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'rc-slots-')), setupProbe: probe, setupActions: { gh } });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (path = '/api/first-run?fresh=1', user = 'example-owner') => (await (await fetch(`${base}${path}`, { headers: h(user) })).json()) as Record<string, unknown> & { setup: SetupView };
  const post = async (path: string, user: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string; changes?: { file: string; key: string; from: unknown; to: unknown }[]; url?: string; branch?: string; confirmed?: boolean } };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => (e.payload as { action: string }).action);
    } finally {
      log.close();
    }
  };
  return { d, get, post, audit };
}

const branches = (remote: (...a: string[]) => string) => remote('for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n').sort();

test("the Repo config form: values from the default branch's config; Review shows the change and pushes nothing; Propose pushes a branch of its own with that change (comments kept) and opens a PR; the checkout is untouched", async () => {
  const f = fixture();
  const gh = ghStandIn();
  const s = await dashboard(f.dir, gh.gh);
  const before = readFileSync(join(f.dir, BRAND.configDir, 'config.yaml'), 'utf8');
  try {
    const v = await s.get();
    assert.deepEqual(v.repoConfig, { values: { writers: ['example-owner', 'example-collaborator'], required_checks: [], daily_budget_usd: 40, workers_count: 1, workers_model: 'sonnet', ci: 'github' }, owner: 'example-owner', branch: 'main', repo: 'example-org/example-shop', models: ['haiku', 'sonnet', 'opus'], defaultModel: 'sonnet', modelListed: true });
    assert.deepEqual((await s.get('/api/first-run/checks-seen')).checks, ['ci/legacy', 'lint', 'test']);
    const values = { writers: ['example-owner', 'example-collaborator', 'ada-l'], required_checks: ['test', 'lint'], daily_budget_usd: 25 };
    const preview = await s.post('/api/first-run/repo-config', 'example-owner', { values });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.changes, [
      { file: `${BRAND.configDir}/config.yaml`, key: 'owners.writers', from: ['example-owner', 'example-collaborator'], to: ['example-owner', 'example-collaborator', 'ada-l'] },
      { file: `${BRAND.configDir}/config.yaml`, key: 'required_checks', from: undefined, to: ['test', 'lint'] },
      { file: `${BRAND.configDir}/agents.yaml`, key: 'daily_budget_usd', from: 40, to: 25 },
    ].map((c) => (c.from === undefined ? { file: c.file, key: c.key, to: c.to } : c)));
    assert.deepEqual(branches(f.remote), ['main'], 'Review pushes nothing');
    assert.equal((await s.post('/api/first-run/repo-config', 'example-collaborator', { values, confirm: true })).status, 403);
    const r = await s.post('/api/first-run/repo-config', 'example-owner', { values, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, 'https://github.com/example-org/example-shop/pull/7');
    assert.match(r.body.branch!, new RegExp(`^${BRAND.cli}/config-\\d{8}-\\d{6}$`));
    assert.deepEqual(branches(f.remote), ['main', r.body.branch!].sort(), 'one new branch on origin, main untouched');
    const pushed = f.remote('show', `${r.body.branch}:${BRAND.configDir}/config.yaml`);
    assert.match(pushed, /writers:\s*\[?[\s\S]*ada-l/);
    assert.match(pushed, /required_checks:[\s\S]*- test[\s\S]*- lint|required_checks: \[ test, lint \]/);
    assert.match(pushed, /# owns anything no area matches/, "the file's comments kept");
    assert.match(f.remote('show', `${r.body.branch}:${BRAND.configDir}/agents.yaml`), /daily_budget_usd: 25/);
    assert.equal(f.remote('rev-parse', 'main').trim(), f.git('rev-parse', 'origin/main').trim(), 'main not moved');
    const create = gh.calls.find((c) => c[0] === 'pr' && c[1] === 'create')!;
    assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--repo', 'example-org/example-shop', '--base', 'main', '--head', r.body.branch]);
    assert.equal(readFileSync(join(f.dir, BRAND.configDir, 'config.yaml'), 'utf8'), before, "the checkout's own config untouched");
    assert.equal(f.git('branch', '--list', `${BRAND.cli}/config-*`).trim(), '', 'no local branch left');
    const wts = join(projectStateDir(f.dir), 'worktrees');
    assert.deepEqual(existsSync(wts) ? readdirSync(wts) : [], [], 'no scratch worktree left');
    assert.deepEqual(s.audit(), ['first_run.config_refused', 'first_run.config_proposed']);
  } finally {
    await s.d.close();
  }
});

test('the Repo config form refuses, pushing nothing: a value the config would reject, a bad login, a key it does not edit, no change', async () => {
  const f = fixture();
  const gh = ghStandIn();
  const s = await dashboard(f.dir, gh.gh);
  try {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ writers: ['example-collaborator'] }, /default owner must be one of owners\.writers/],
      [{ writers: ['not a login!'] }, /writers: not valid: not a login!/],
      [{ required_checks: ['two\nlines'] }, /required checks: not valid/],
      [{ daily_budget_usd: -5 }, /daily_budget_usd/],
      [{ land_mode: 'direct' }, /not editable here: land_mode/],
      [{ daily_budget_usd: 40 }, /nothing to change/],
      // #468: only a model the engine lists, named with the list
      [{ workers_model: 'gpt-something' }, /worker model: not one the engine supports: gpt-something \(one of haiku, sonnet, opus, or a full Anthropic model id\)/],
    ];
    for (const [values, why] of cases) {
      for (const confirm of [false, true]) {
        const r = await s.post('/api/first-run/repo-config', 'example-owner', { values, confirm });
        assert.equal(r.status, 400, JSON.stringify(values));
        assert.match(r.body.error!, why);
      }
    }
    assert.deepEqual(branches(f.remote), ['main']);
    assert.equal(gh.calls.filter((c) => c[0] === 'pr').length, 0);
  } finally {
    await s.d.close();
  }
});

test('#468: the worker model is one of the engine\'s own list (MODEL_TIERS), its default the routing default; a hand-edited one is kept unless changed', async () => {
  const { MODEL_TIERS } = await import('../src/model-routing.js');
  const { ROUTING } = await import('../src/routing.js');
  const { WORKER_MODELS, DEFAULT_WORKER_MODEL, repoConfigForm } = await import('../src/config-change.js');
  assert.deepEqual(WORKER_MODELS, MODEL_TIERS);
  assert.equal(DEFAULT_WORKER_MODEL, ROUTING.build.default);
  const f = fixture();
  // A hand-edited model the list doesn't have, on the default branch: shown as it is, and a change to anything else keeps it.
  const agents = join(f.dir, BRAND.configDir, 'agents.yaml');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(agents, readFileSync(agents, 'utf8').replace(/model: sonnet/, 'model: claude-sonnet-4-5'));
  f.git('commit', '-qam', 'hand-edited model');
  f.git('push', '-q', 'origin', 'HEAD:main');
  f.git('fetch', '-q', 'origin');
  assert.equal(repoConfigForm(loadConfig(f.dir)).values.workers_model, 'claude-sonnet-4-5');
  const gh = ghStandIn();
  const s = await dashboard(f.dir, gh.gh);
  try {
    const kept = await s.post('/api/first-run/repo-config', 'example-owner', { values: { workers_model: 'claude-sonnet-4-5', daily_budget_usd: 30 } });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual(kept.body.changes!.map((c) => c.key), ['daily_budget_usd'], 'the unknown model, unchanged, is not refused nor touched');
    // #468 (the owner): a full Anthropic model id counts as listed.
    const full = await s.post('/api/first-run/repo-config', 'example-owner', { values: { workers_model: 'claude-opus-4-1' } });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    const picked = await s.post('/api/first-run/repo-config', 'example-owner', { values: { workers_model: 'opus' } });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.deepEqual(picked.body.changes, [{ file: `${BRAND.configDir}/agents.yaml`, key: 'roles.workers.model', from: 'claude-sonnet-4-5', to: 'opus' }]);
  } finally {
    await s.d.close();
  }
});

test('Fetch the default branch: origin/main not fetched here is fetched (no local branch moves), and the step turns done', async () => {
  const f = fixture();
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  const head = f.git('rev-parse', 'HEAD').trim();
  const s = await dashboard(f.dir, ghStandIn().gh);
  try {
    const v = (await s.get()) as unknown as { setup: SetupView; actions: Record<string, { commands: string[] }> };
    assert.equal(v.setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'default-branch')!.done, false);
    assert.deepEqual(v.actions['default-branch']!.commands, ['git fetch -q origin main', 'git remote set-head origin --auto']);
    const r = await s.post('/api/first-run/actions/default-branch', 'example-owner', { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(f.git('rev-parse', 'origin/main').trim(), head);
    assert.equal(f.git('rev-parse', 'HEAD').trim(), head);
    assert.equal((await s.get()).setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'default-branch')!.done, true);
  } finally {
    await s.d.close();
  }
});

test("#468 a model the engine doesn't list is a config warning, never a refusal: the config loads, doctor warns, the first-run step stays done and says so; full Anthropic ids are listed", async () => {
  const { listedModel, modelWarnings } = await import('../src/model-routing.js');
  const { doctor } = await import('../src/doctor.js');
  const { writeFileSync } = await import('node:fs');
  for (const m of ['haiku', 'sonnet', 'opus', 'claude-sonnet-4-5', 'claude-opus-4-1-20250805', 'claude-3-5-haiku-20241022']) assert.ok(listedModel(m), m);
  for (const m of ['gpt-5', 'claude-instant', 'sonnet-ish', 'claude-', 'local']) assert.equal(listedModel(m), false, m);
  const f = fixture();
  const agents = join(f.dir, BRAND.configDir, 'agents.yaml');
  writeFileSync(agents, readFileSync(agents, 'utf8').replace(/model: sonnet, hard_issues_model: opus/, 'model: gpt-5, hard_issues_model: claude-opus-4-1'));
  const cfg = loadConfig(f.dir);
  assert.equal(cfg.agents.roles.workers!.model, 'gpt-5', 'it loads as written');
  assert.deepEqual(modelWarnings(cfg.agents), [`agents.yaml roles.workers.model: gpt-5 isn't a model the engine lists (haiku, sonnet, opus, or a full Anthropic model id such as claude-sonnet-4-5); it is used as written`]);
  const d = doctor(f.dir).find((c) => c.name === 'config models')!;
  assert.equal(d.level, 'warn');
  assert.match(d.detail, /roles\.workers\.model: gpt-5/);
  assert.equal(doctor(f.dir).find((c) => c.name === 'config')!.level, 'ok', 'never a refusal');
  const s = await dashboard(f.dir, ghStandIn().gh);
  try {
    const step = (await s.get()).setup.groups.flatMap((g) => g.steps).find((x) => x.id === 'agents-config')!;
    assert.equal(step.done, true);
    assert.match(step.detail, /; warning: agents\.yaml roles\.workers\.model: gpt-5 isn't a model the engine lists/);
  } finally {
    await s.d.close();
  }
});

test('the Repo config form, No CI (#469): ci: none is refused where tests.yaml has no test_run (the fix: the starter CI); with test_run it is proposed as config.yaml ci: none, nothing else', async () => {
  const f = fixture();
  const gh = ghStandIn();
  const s = await dashboard(f.dir, gh.gh);
  try {
    const refused = await s.post('/api/first-run/repo-config', 'example-owner', { values: { ci: 'none' } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error!, /refused: .*ci: none judges PRs by this machine's test runs .*add the starter CI/);
    assert.equal((await s.post('/api/first-run/repo-config', 'example-owner', { values: { ci: 'maybe' } })).status, 400);
    // The default branch gets a test_run: now it is offered, and proposed as one key.
    const tests = join(f.dir, BRAND.configDir, 'tests.yaml');
    execFileSync('sh', ['-c', `printf '\\ntest_run:\\n  tiers:\\n    - { name: unit, command: "npm test", kind: fast }\\n' >> "$1"`, 'sh', tests]);
    f.git('-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'test runs');
    f.git('push', '-q', 'origin', 'main');
    f.git('fetch', '-q', 'origin');
    const preview = await s.post('/api/first-run/repo-config', 'example-owner', { values: { ci: 'none' } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.changes, [{ file: `${BRAND.configDir}/config.yaml`, key: 'ci', to: 'none' }]);
  } finally {
    await s.d.close();
  }
});

// Onboarding's parts: the App's permissions, stack detection and the config it writes, staged secrets, the
// dashboard's routes, and the files the coordinator-side commands edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asks, AskError } from '../src/console/asks.js';
import { loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { answerSecret, runRootStep, stagedSecrets, stageSecret } from '../src/onboard/answer.js';
import { setAgentApiKey, setInstanceBudget } from '../src/onboard/budget.js';
import { BOT_PERMISSION_BITS, discordApi, inviteUrl } from '../src/onboard/discord.js';
import { fixFor, onboardDoctor, parseDoctor } from '../src/onboard/doctor.js';
import { appPermissionRules, ENGINE_LABELS, instanceNameFor } from '../src/onboard/flow.js';
import { proposedRuleset } from '../src/onboard/github.js';
import { onboardService } from '../src/onboard/http.js';
import { appManifest, appName, APP_PERMISSIONS, installUrl, manifestPage, startManifestServer } from '../src/onboard/manifest.js';
import { detectStack, writeProjectConfig } from '../src/onboard/stack.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("the App's manifest asks for exactly what app-permissions.mjs checks: no errors, no warnings, nothing refused", async () => {
  const rules = await appPermissionRules(repoRoot);
  assert.deepEqual(rules.permissionProblems({ ...APP_PERMISSIONS }), { errors: [], warnings: [] });
  const m = appManifest({ repo: 'acme/shop', shared: false, redirectUrl: 'http://127.0.0.1:1/cb' });
  for (const k of ['workflows', 'administration']) assert.ok(!(k in m.default_permissions), k);
  assert.equal(m.default_permissions.actions, 'read');
  assert.equal(m.hook_attributes.active, false);
  assert.deepEqual(m.default_events, []);
  assert.equal(m.public, false);
  assert.ok(appName('acme/a-very-long-repository-name-indeed-yes', false).length <= 34);
  assert.equal(appName('Acme/shop', true), 'worklane-acme');
  assert.match(manifestPage(m, 'https://github.com/settings/apps/new?state=s'), /<form method="post" action="https:\/\/github\.com\/settings\/apps\/new\?state=s">/);
  assert.equal(installUrl('x', { ownerId: 1, repoId: 2 }), 'https://github.com/apps/x/installations/new/permissions?suggested_target_id=1&repository_ids[]=2');
});

test('the manifest callback takes only the state it posted, once', async () => {
  const s = await startManifestServer({ repo: 'acme/shop', shared: false, owner: 'acme', ownerType: 'Organization' });
  try {
    const page = await (await fetch(s.url)).text();
    assert.match(page, /action="https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{32}"/);
    const state = /state=([0-9a-f]{32})/.exec(page)![1];
    assert.equal((await fetch(`${s.redirectUrl}?code=abc&state=wrong`)).status, 400);
    assert.equal((await fetch(s.url.replace(/manifest\/[0-9a-f]+/, 'manifest/guess'))).status, 404);
    assert.equal((await fetch(`${s.redirectUrl}?code=abc&state=${state}`)).status, 200);
    assert.equal(await s.code, 'abc');
  } finally {
    await s.close();
  }
});

test("an approve link is https, or http on this machine's loopback only", () => {
  const a = asks(new EventLog(':memory:'));
  const base = { instance: 'shop', title: 't', detail: 'd', kind: 'approve_link' as const };
  for (const url of ['http://127.0.0.1:4000/manifest/x', 'http://localhost:9/x', 'https://github.com/x']) assert.equal(a.create({ ...base, url }).kind, 'approve_link');
  for (const url of ['http://127.0.0.1.evil.example/x', 'http://example.com', 'http://192.0.2.1/x', 'file:///etc/passwd']) assert.throws(() => a.create({ ...base, url }), AskError, url);
});

function project(files: Record<string, string>): string {
  const d = tmp('stack-');
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  return d;
}

test('stack detection: lockfile, runner, commands, and the pull-request check names GitHub shows', () => {
  const pnpm = detectStack(
    project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }),
      'pnpm-lock.yaml': '',
      '.github/workflows/ci.yml': 'on: [pull_request]\njobs:\n  unit:\n    name: Unit\n    strategy: { matrix: { os: [ubuntu-latest, macos-latest] } }\n    runs-on: x\n  e2e:\n    runs-on: x\n',
      '.github/workflows/nightly.yml': 'on: { schedule: [{ cron: "0 0 * * *" }] }\njobs: { full: { runs-on: x } }\n',
      '.github/workflows/dyn.yml': 'on: pull_request\njobs:\n  d:\n    strategy: { matrix: "${{ fromJSON(needs.x.outputs.m) }}" }\n    runs-on: x\n',
    }),
  );
  assert.deepEqual([pnpm.packageManager, pnpm.lockfile, pnpm.testRunner], ['pnpm', 'pnpm-lock.yaml', 'vitest']);
  assert.deepEqual(pnpm.commands, { install: 'pnpm install --frozen-lockfile', test: 'pnpm run test', one: 'npx vitest run {file}' });
  assert.deepEqual(pnpm.checks, ['Unit (ubuntu-latest)', 'Unit (macos-latest)', 'e2e'], 'only pull-request workflows; a computed matrix is not guessed');
  assert.ok(pnpm.notes.some((n) => /computed matrix/.test(n)));
  const py = detectStack(project({ 'pyproject.toml': '[project]\nname="x"\n', 'uv.lock': '' }));
  assert.deepEqual([py.ecosystem, py.commands.install, py.commands.test], ['python', 'uv sync --frozen', 'uv run pytest']);
  assert.equal(detectStack(project({ 'go.mod': 'module x' })).commands.test, 'go test ./...');
  const none = detectStack(project({ 'README.md': 'x' }));
  assert.equal(none.ecosystem, 'unknown');
  assert.ok(none.notes.some((n) => /by hand/.test(n)));
});

test('the config it writes has the real values, keeps the comments, and loads', () => {
  const d = project({ 'package.json': JSON.stringify({ scripts: { test: 'node --test test/' } }), 'package-lock.json': '{}', '.github/workflows/ci.yml': 'on: pull_request\njobs: { test: { runs-on: x } }\n' });
  const notes = writeProjectConfig(d, detectStack(d), { name: 'shop', repo: 'acme/shop', defaultBranch: 'trunk', owner: 'ada', dailyBudgetUsd: 10 });
  assert.ok(Array.isArray(notes));
  const cfg = loadConfig(d);
  assert.equal(cfg.project.project.repo, 'acme/shop');
  assert.equal(cfg.project.project.default_branch, 'trunk');
  assert.deepEqual(cfg.project.required_checks, ['test']);
  assert.equal(cfg.project.owners.default, 'ada');
  assert.deepEqual(cfg.project.owners.writers, ['ada']);
  assert.equal(cfg.agents.daily_budget_usd, 10);
  assert.equal(cfg.tests.runner.one, 'node --test {file}');
  assert.deepEqual(cfg.tests.worktree.setup, ['npm ci']);
  assert.match(readFileSync(join(d, '.worklane', 'config.yaml'), 'utf8'), /# PR mode: PRs open as drafts/);
  assert.doesNotMatch(readFileSync(join(d, '.worklane', 'config.yaml'), 'utf8'), /your-github-handle|\{\{/);
  assert.throws(() => writeProjectConfig(d, detectStack(d), { name: 'shop', repo: 'acme/shop', defaultBranch: 'main', owner: 'ada', dailyBudgetUsd: 10 }), /already exists/);
});

test('the labels are every one the engine uses', () => {
  const names = ENGINE_LABELS.map((l) => l.name);
  for (const l of ['ready', 'triage', 'agent:working', 'in-review', 'blocked', 'merge-ready', 'needs-owner', 'type:research', 'type:investigation', 'digest']) assert.ok(names.includes(l), l);
  assert.equal(new Set(names).size, names.length);
});

test('the ruleset: the checks required and up to date, on the default branch; nothing else loosened', () => {
  const r = proposedRuleset(['test', 'lint'], 'X: main');
  assert.deepEqual(r.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  const c = r.rules[0] as { type: string; parameters: { strict_required_status_checks_policy: boolean; required_status_checks: { context: string }[] } };
  assert.equal(c.parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(c.parameters.required_status_checks, [{ context: 'test' }, { context: 'lint' }]);
  assert.deepEqual(r.rules.map((x) => x.type), ['required_status_checks', 'non_fast_forward', 'deletion']);
});

test('secrets: checked for their shape, staged owner-only, never in an event; a root step needs its secret staged', () => {
  const dir = tmp('stage-');
  const log = new EventLog(':memory:');
  const a = asks(log);
  const ask = a.create({ instance: 'shop', title: 't', detail: 'd', kind: 'paste_secret', credential: 'intake-discord', where: 'w' });
  assert.throws(() => answerSecret(log, dir, ask.id, 'ada', 'not a token'), /isn't a Discord bot token/);
  assert.equal(a.get(ask.id)!.status, 'open', 'a bad paste answers nothing');
  const token = 'MTIz.' + 'q'.repeat(60);
  assert.equal(answerSecret(log, dir, ask.id, 'ada', `  ${token}\n`).answer!.answer, 'stored');
  assert.deepEqual(stagedSecrets(dir), ['intake-discord']);
  if (posix) assert.equal(statSync(join(dir, 'secrets', 'intake-discord')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(log.read()).includes(token));
  assert.throws(() => stageSecret(dir, '../x', 'y'), AskError);
  const step = a.create({ instance: 'shop', title: 't', detail: 'd', kind: 'root_step', command: 'install-api-key', args: ['shop'] });
  assert.throws(() => runRootStep(log, dir, step.id, 'ada', () => 'never'), /needs claude-api-key, and none is staged/);
  const off = a.create({ instance: 'shop', title: 't', detail: 'd', kind: 'root_step', command: 'apt-get', args: ['install', 'x'] });
  assert.throws(() => runRootStep(log, dir, off.id, 'ada', () => 'never'), /needs the helper extended/);
  stageSecret(dir, 'claude-api-key', 'sk-ant-api03-' + 'k'.repeat(30));
  const seen: (string | undefined)[] = [];
  const r = runRootStep(log, dir, step.id, 'ada', (_f, _a, input) => (seen.push(input), 'installed'));
  assert.equal(r.answer!.answer, 'ran');
  assert.deepEqual(stagedSecrets(dir), ['intake-discord'], 'the staged key is deleted once its step ran');
  assert.ok(seen[0]!.startsWith('sk-ant-api03-'));
});

test('the instance doctor, with a fix for each failure; staged secrets left over fail it', () => {
  assert.equal(parseDoctor('nothing'), null);
  assert.equal(parseDoctor('[{"name":"x"}]'), null);
  const dir = tmp('doc-');
  const view = { name: 'shop', repo: 'acme/shop', dir, steps: () => [] };
  const checks = onboardDoctor({ instanceDoctor: JSON.stringify([{ name: 'config', level: 'fail', detail: 'bad' }, { name: 'node', level: 'ok', detail: '24' }]), onboarding: view });
  assert.match(checks.find((c) => c.name === 'config')!.fix, /\.worklane\/ in a PR/);
  assert.equal(checks.find((c) => c.name === 'node')!.fix, '');
  stageSecret(dir, 'github-manifest-code', 'abc');
  assert.equal(onboardDoctor({ instanceDoctor: '[]', onboarding: view }).find((c) => c.name === 'staged secrets')!.level, 'fail');
  assert.equal(onboardDoctor({ instanceDoctor: 'oops', onboarding: view })[0]!.level, 'fail');
  assert.match(fixFor({ name: 'gitleaks', level: 'fail', detail: '' }, 'shop', 'acme/shop'), /tools\.sh/);
});

test("Discord: the invite asks for view, send, send in threads and read history only; the check sends nothing", async () => {
  assert.equal(BOT_PERMISSION_BITS, (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 38n));
  assert.equal(new URL(inviteUrl('9')).searchParams.get('scope'), 'bot');
  const calls: string[] = [];
  const d = discordApi((async (u: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(u)).pathname}`);
    return new Response(JSON.stringify(String(u).endsWith('/users/@me') ? { id: '9', username: 'b', bot: true } : { id: '9', flags: 1 << 18 }), { status: 200 });
  }) as typeof fetch, 'https://d.example/api');
  const c = await d.check('t');
  assert.equal(c.ok, true);
  assert.deepEqual(calls, ['GET /api/users/@me', 'GET /api/applications/@me']);
  const user = discordApi((async () => new Response(JSON.stringify({ id: '1', username: 'u' }), { status: 200 })) as typeof fetch);
  assert.match((await user.check('t')).problem!, /user's token/);
});

test('instance names from repos', () => {
  assert.equal(instanceNameFor('acme/My_Shop.web'), 'my-shop-web');
  assert.equal(instanceNameFor('acme/123'), 'project');
  assert.equal(instanceNameFor('acme/dash'), 'project');
  assert.equal(instanceNameFor('acme/build-agent'), 'build');
  assert.ok(instanceNameFor(`acme/${'x'.repeat(60)}`).length <= 21);
});

test("the coordinator-side commands: the policy's budget within the machine's limits; credentials.yaml's agent_api_key", () => {
  const dir = tmp('inst-');
  mkdirSync(join(dir, 'shop'));
  writeFileSync(join(dir, 'shop', 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 20 }\n# keep me\n');
  writeFileSync(join(dir, 'shop', 'instance.yaml'), 'version: 1\nname: shop\nrepos:\n  - path: /x\n    repo: acme/shop\nrun_as:\n  agent_user: wl-shop-agent\n  agent_home: /var/users/wl-shop-agent\n');
  writeFileSync(join(dir, 'shop', 'credentials.yaml'), 'version: 1\ngithub: { kind: app, app_id: 1, installation_id: 2, key_path: /k }\n');
  const limits = join(dir, 'limits.json');
  writeFileSync(limits, JSON.stringify({ daily_budget_usd: { max: 50 } }));
  assert.deepEqual(setInstanceBudget('shop', 40, { dir, limitsPath: limits }), { from: 20, to: 40 });
  assert.match(readFileSync(join(dir, 'shop', 'policy.yaml'), 'utf8'), /daily_usd: 40[\s\S]*# keep me/);
  assert.throws(() => setInstanceBudget('shop', 60, { dir, limitsPath: limits }), /at most \$50/);
  assert.throws(() => setInstanceBudget('shop', 0, { dir, limitsPath: limits }));
  assert.equal(setAgentApiKey('shop', { dir }), '/var/users/wl-shop-agent/.config/shop-claude-key/api_key', "from the agent's own home, where credentials.sh api-key puts it");
  assert.match(readFileSync(join(dir, 'shop', 'credentials.yaml'), 'utf8'), /agent_api_key: \/var\/users\/wl-shop-agent\/\.config\/shop-claude-key\/api_key/);
  if (posix) assert.equal(statSync(join(dir, 'shop', 'credentials.yaml')).mode & 0o777, 0o600);
});

function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(t || '{}') }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

test("the dashboard's routes: start an onboarding, show its steps and asks, answer them; a secret is never echoed", async () => {
  const root = tmp('onb-http-');
  const { createServer } = await import('node:http');
  const svc = onboardService({
    by: 'ada',
    root,
    pollMs: 5,
    deps: () => ({
      github: { ownerType: async () => 'User' } as never,
      owner: {} as never,
      discord: {} as never,
      anthropic: async () => null,
      probe: { exists: () => false, userExists: () => false, helperReady: () => false, instances: () => [] },
      engineRef: () => null,
      rules: () => appPermissionRules(repoRoot),
      manifest: startManifestServer,
      git: () => '',
    }),
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const body = () => new Promise<unknown>((r) => {
      let t = '';
      req.on('data', (c) => (t += c));
      req.on('end', () => r(t ? JSON.parse(t) : {}));
    });
    void svc.handle(req, res, u, body).then((h) => h || res.writeHead(404).end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await call(port, 'POST', '/api/onboard', { repo: '../etc' })).status, 400);
    assert.equal((await call(port, 'POST', '/api/onboard', { repo: 'acme/shop' })).status, 202);
    let view: { steps: { id: string; status: string }[]; asks: { id: string; kind: string; status: string; options?: string[] }[] } | undefined;
    for (let i = 0; i < 100 && !view?.asks.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      view = ((await call(port, 'GET', '/api/onboard')).json.runs as (typeof view)[])[0];
    }
    assert.equal(view!.steps[0]!.id, 'app');
    const q = view!.asks[0]!;
    assert.deepEqual([q.kind, q.options], ['question', ['per-project', 'shared']]);
    assert.equal((await call(port, 'POST', '/api/onboard/answer', { repo: 'acme/shop', id: q.id, answer: 'maybe' })).status, 400);
    assert.equal((await call(port, 'POST', '/api/onboard/answer', { repo: 'acme/shop', id: q.id, answer: 'per-project' })).status, 200);
    let link: { id: string; kind: string } | undefined;
    for (let i = 0; i < 100 && !link; i++) {
      await new Promise((r) => setTimeout(r, 20));
      link = (((await call(port, 'GET', '/api/onboard')).json.runs as { asks: { id: string; kind: string; status: string }[] }[])[0]!.asks).find((a) => a.kind === 'approve_link' && a.status === 'open');
    }
    assert.ok(link, 'the manifest link is asked next');
    const secret = await call(port, 'POST', '/api/onboard/secret', { repo: 'acme/shop', id: link!.id, value: 'x' });
    assert.equal(secret.status, 400, "a link doesn't take a secret");
    assert.ok(!JSON.stringify(secret.json).includes('"x"'));
  } finally {
    svc.close();
    server.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { credentialProblems, initInstance, listInstances, loadInstance } from '../src/instance.js';
import { childEnv } from '../src/os/index.js';
import { agentEnv } from '../src/runner.js';
import { instanceEnv } from '../src/service.js';
import { exampleProject, repoRoot } from './helpers.js';

function setup(policy = 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4, max_stage: 1 }\nland_mode: pr\n') {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  writeFileSync(join(home, 'policy.yaml'), policy);
  return { dir, repo, home };
}

const errorsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigInvalid, String(e));
    return e.errors.map((x) => `${x.path}: ${x.message}`);
  }
  assert.fail('expected ConfigInvalid');
};

test('an instance loads with its repo config when the repo stays within policy', () => {
  const { dir, home } = setup();
  const i = loadInstance('shop', dir);
  assert.equal(i.repo.repo, 'example-org/example-shop');
  assert.equal(i.stateDir, join(home, 'state'));
  assert.equal(i.policy.budget.daily_usd, 40);
  assert.deepEqual(listInstances(dir), ['shop']);
});

test('acceptance: a repo config that loosens the instance policy is rejected, every violation listed', () => {
  const { dir, repo } = setup('version: 1\nbudget: { daily_usd: 10 }\nagents: { max_workers: 0, max_stage: 1 }\nland_mode: pr\nnetwork_allow: [docs.github.com]\npre_approved: []\n');
  const cfg = join(repo, BRAND.configDir);
  writeFileSync(join(cfg, 'config.yaml'), readFileSync(join(cfg, 'config.yaml'), 'utf8').replace(/^land_mode: pr/m, 'land_mode: direct'));
  writeFileSync(join(cfg, 'agents.yaml'), readFileSync(join(cfg, 'agents.yaml'), 'utf8').replace(/^stage: 1/m, 'stage: 2'));
  const errs = errorsOf(() => loadInstance('shop', dir)).join('\n');
  for (const want of [/daily_budget_usd: 40 exceeds the policy budget 10/, /roles\.workers\.count: 1 exceeds the policy's max_workers 0/, /stage: stage 2 exceeds the policy's max_stage 1/, /land_mode: direct landing, but the policy requires pr/, /network\.allow: nodejs\.org is not in the policy's network_allow/, /pre_approved: .* is not in the policy's pre_approved/]) {
    assert.match(errs, want);
  }
  assert.match(errs, /a repo can only tighten the instance policy/);
});

test('an instance must point at the repo its config names, and its directory must match its name', () => {
  const { dir, home } = setup();
  writeFileSync(join(home, 'instance.yaml'), readFileSync(join(home, 'instance.yaml'), 'utf8').replace('example-org/example-shop', 'example-org/other'));
  assert.match(errorsOf(() => loadInstance('shop', dir)).join('\n'), /example-org\/example-shop is not the instance's repo example-org\/other/);
  writeFileSync(join(home, 'instance.yaml'), readFileSync(join(home, 'instance.yaml'), 'utf8').replace('name: shop', 'name: elsewhere'));
  assert.match(errorsOf(() => loadInstance('shop', dir)).join('\n'), /"elsewhere" does not match the directory "shop"/);
  assert.match(errorsOf(() => loadInstance('nope', dir)).join('\n'), /no instance "nope"/);
});

test('credentials are references that must exist; there is no fallback login', () => {
  const { dir, home } = setup();
  const i = loadInstance('shop', dir);
  assert.deepEqual(credentialProblems(i.credentials).map((p) => p.split(' not found')[0]), ['GitHub: gh config dir', 'Claude: config dir']);
  mkdirSync(join(home, 'gh'));
  mkdirSync(join(home, 'claude'));
  assert.deepEqual(credentialProblems(i.credentials), []);
  writeFileSync(join(home, 'credentials.yaml'), 'version: 1\ngithub: { kind: gh-config-dir }\nclaude: { config_dir: x }\n');
  assert.match(errorsOf(() => loadInstance('shop', dir)).join('\n'), /github/);
});

test('an instance home is private to its owner', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const { home } = setup();
  assert.equal(statSync(home).mode & 0o777, 0o700);
  for (const f of ['instance.yaml', 'policy.yaml', 'credentials.yaml']) assert.equal(statSync(join(home, f)).mode & 0o777, 0o600, f);
  assert.throws(() => initInstance('shop', '.', 'a/b', join(home, '..')), /already exists/);
  assert.throws(() => initInstance('Bad Name', '.', 'a/b', join(home, '..')), /lowercase/);
});

const cli = join(repoRoot, 'dist', 'src', 'cli.js');

/** Two instances over two copies of the example project, each with a file backlog and its own (empty) login dirs. */
function two() {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const made = ['alpha', 'beta'].map((n, k) => {
    const { dir: repo } = exampleProject();
    const cfg = join(repo, BRAND.configDir);
    writeFileSync(join(cfg, 'config.yaml'), readFileSync(join(cfg, 'config.yaml'), 'utf8').replace(/^backlog: github/m, 'backlog: file'));
    writeFileSync(join(cfg, 'agents.yaml'), readFileSync(join(cfg, 'agents.yaml'), 'utf8').replace(/^daily_budget_usd: 40/m, `daily_budget_usd: ${k ? 10 : 40}`));
    const home = initInstance(n, repo, 'example-org/example-shop', dir);
    writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\n');
    mkdirSync(join(home, 'gh'));
    mkdirSync(join(home, 'claude'));
    return { name: n, home };
  });
  return { dir, made };
}

/** A stand-in gh that prints the token kept in its config dir, and a local GitHub API listing what each token reaches. */
async function fakeGitHub(reach: Record<string, string[]>) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && cat "$GH_CONFIG_DIR/token"\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    seen.push(token);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify((reach[token] ?? []).map((full_name) => ({ full_name }))));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { bin, api, seen, close: () => new Promise((r) => server.close(r)) };
}

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stderr: string }>((res) => {
    const p = spawn(process.execPath, [cli, ...args], { env, cwd: tmpdir() });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += String(d)));
    p.on('exit', (status) => res({ status, stderr }));
  });

test('acceptance: two instances keep separate logs, budgets and environments', { skip: process.platform === 'win32' && 'POSIX stand-in gh' }, async () => {
  const { dir, made } = two();
  const gh = await fakeGitHub({ github_pat_alpha: ['example-org/example-shop'], github_pat_beta: ['example-org/example-shop'] });
  for (const m of made) writeFileSync(join(m.home, 'gh', 'token'), `github_pat_${m.name}\n`);
  const env = { ...childEnv(), PATH: `${gh.bin}${delimiter}${process.env.PATH}`, [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir, [`${BRAND.envPrefix}_GITHUB_API`]: gh.api, GH_TOKEN: 'inherited-token-must-not-be-used', ANTHROPIC_API_KEY: 'inherited-key' };
  try {
    for (const m of made) {
      const r = await run(['coordinator', 'run', '--instance', m.name, '--once'], env);
      assert.equal(r.status, 0, r.stderr);
      const log = new EventLog(join(m.home, 'state', 'events.db'));
      try {
        assert.ok(log.read(0, ['coordinator.started']).length === 1, `${m.name} logged to its own state`);
      } finally {
        log.close();
      }
    }
    assert.deepEqual([...new Set(gh.seen)].sort(), ['github_pat_alpha', 'github_pat_beta'], 'each coordinator used its own login, never the inherited token');
  } finally {
    await gh.close();
  }
  const [a, b] = made.map((m) => loadInstance(m.name, dir));
  assert.equal(a!.config.agents.daily_budget_usd, 40);
  assert.equal(b!.config.agents.daily_budget_usd, 10);
  const ea = instanceEnv(a!, env);
  const eb = instanceEnv(b!, env);
  assert.equal(ea.GH_CONFIG_DIR, join(made[0]!.home, 'gh'));
  assert.equal(eb.GH_CONFIG_DIR, join(made[1]!.home, 'gh'));
  assert.equal(ea.CLAUDE_CONFIG_DIR, join(made[0]!.home, 'claude'));
  assert.equal(eb.CLAUDE_CONFIG_DIR, join(made[1]!.home, 'claude'));
  for (const e of [ea, eb]) {
    assert.equal(e.GH_TOKEN, undefined, 'an inherited token never stands in for the instance login');
    assert.equal(e.ANTHROPIC_API_KEY, undefined);
  }
});

test('acceptance: a coordinator refuses a GitHub token that can see repos outside its instance', { skip: process.platform === 'win32' && 'POSIX stand-in gh' }, async () => {
  const { dir, made } = two();
  const gh = await fakeGitHub({ github_pat_wide: ['example-org/example-shop', 'example-org/payroll'] });
  const env = { ...childEnv(), PATH: `${gh.bin}${delimiter}${process.env.PATH}`, [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir, [`${BRAND.envPrefix}_GITHUB_API`]: gh.api };
  try {
    for (const [token, why] of [
      ['github_pat_wide', /can reach 1 repo\(s\) outside this instance/],
      ['gho_personal_login', /personal login or classic token/],
    ] as const) {
      writeFileSync(join(made[0]!.home, 'gh', 'token'), `${token}\n`);
      const r = await run(['coordinator', 'run', '--instance', 'alpha', '--once'], env);
      assert.equal(r.status, 1);
      assert.match(r.stderr, why);
      assert.doesNotMatch(r.stderr, /payroll|gho_personal/, 'never names other repos or prints the token');
    }
    assert.equal(existsSync(join(made[0]!.home, 'state', 'events.db')), false, 'nothing ran');
  } finally {
    await gh.close();
  }
});

test('an instance coordinator refuses to start without its own credentials, or with ones not supported yet', () => {
  const { dir, made } = two();
  const env = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir };
  rmSync(join(made[0]!.home, 'claude'), { recursive: true });
  const r = spawnSync(process.execPath, [cli, 'coordinator', 'run', '--instance', 'alpha', '--once'], { encoding: 'utf8', env, timeout: 120_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /credentials missing:[\s\S]*Claude: config dir/);
  assert.equal(existsSync(join(made[0]!.home, 'state', 'events.db')), false, 'nothing ran');
  writeFileSync(join(made[1]!.home, 'credentials.yaml'), 'version: 1\ngithub: { kind: app, app_id: 1, installation_id: 2, key_path: /dev/null }\nclaude: { config_dir: /tmp }\n');
  assert.throws(() => instanceEnv(loadInstance('beta', dir)), /GitHub App credentials are not supported yet/);
});

test('agents get the instance\'s Claude config dir, and still no tokens', () => {
  const env = agentEnv({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/inst/claude', GH_TOKEN: 't', GH_CONFIG_DIR: '/inst/gh' }, 'cli');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/inst/claude');
  assert.equal(env.GH_TOKEN, undefined);
  assert.notEqual(env.GH_CONFIG_DIR, '/inst/gh', 'agents never see the coordinator\'s gh login');
});

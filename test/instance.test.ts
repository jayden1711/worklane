import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { credentialProblems, initInstance, instanceProblems, listInstances, loadInstance, type Instance } from '../src/instance.js';
import { childEnv } from '../src/os/index.js';
import { agentEnv } from '../src/runner.js';
import { instanceEnv } from '../src/service.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

function setup(policy = 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n') {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
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
  const { dir, repo } = setup('version: 1\nbudget: { daily_usd: 10 }\nagents: { max_workers: 0 }\nland_mode: pr\nnetwork_allow: [docs.github.com]\npre_approved: []\n');
  const cfg = join(repo, BRAND.configDir);
  writeFileSync(join(cfg, 'config.yaml'), readFileSync(join(cfg, 'config.yaml'), 'utf8').replace(/^land_mode: pr/m, 'land_mode: direct'));
  const errs = errorsOf(() => loadInstance('shop', dir)).join('\n');
  for (const want of [/daily_budget_usd: 40 exceeds the policy budget 10/, /roles\.workers\.count: 1 exceeds the policy's max_workers 0/, /land_mode: direct landing, but the policy requires pr/, /network\.allow: nodejs\.org is not in the policy's network_allow/, /pre_approved: .* is not in the policy's pre_approved/]) {
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
  // Agents run as their own user (the default), so only the coordinator's GitHub login is referenced.
  assert.deepEqual(credentialProblems(i.credentials).map((p) => p.split(' not found')[0]), ['GitHub: gh config dir']);
  mkdirSync(join(home, 'gh'));
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
    agentIsSelf(home);
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
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/user') return res.end(JSON.stringify({ login: 'repo-bot' }));
    if (path.startsWith('/repos/')) return res.end(JSON.stringify({ permissions: { admin: false, push: true } }));
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
  assert.equal(ea.CLAUDE_CONFIG_DIR, undefined, 'agents sign in as their own users; the coordinator holds no Claude login');
  assert.equal(eb.CLAUDE_CONFIG_DIR, undefined);
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

test('an instance coordinator refuses to start without its own credentials', () => {
  const { dir, made } = two();
  const env = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir };
  rmSync(join(made[0]!.home, 'gh'), { recursive: true });
  const r = spawnSync(process.execPath, [cli, 'coordinator', 'run', '--instance', 'alpha', '--once'], { encoding: 'utf8', env, timeout: 120_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not started:[\s\S]*GitHub: gh config dir/);
  assert.equal(existsSync(join(made[0]!.home, 'state', 'events.db')), false, 'nothing ran');
});

test('agents get the instance\'s Claude config dir, and still no tokens', () => {
  const env = agentEnv({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/inst/claude', GH_TOKEN: 't', GH_CONFIG_DIR: '/inst/gh' }, 'cli');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/inst/claude');
  assert.equal(env.GH_TOKEN, undefined);
  assert.notEqual(env.GH_CONFIG_DIR, '/inst/gh', 'agents never see the coordinator\'s gh login');
});

test('instance init names the agent user the setup scripts create', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const home = initInstance('site', '.', 'example-org/example-shop', dir, 'wl-site-agent');
  assert.match(readFileSync(join(home, 'instance.yaml'), 'utf8'), /^ {2}agent_user: wl-site-agent\n {2}agent_home: \/home\/wl-site-agent$/m);
});

test('regression: an instance whose agent user does not exist on this machine is refused before it starts', { skip: process.platform === 'win32' && 'POSIX users' }, () => {
  const credentials = { version: 1, github: { kind: 'gh-config-dir', path: tmpdir() } };
  const problems = (runAs: Instance['runAs']) => instanceProblems({ credentials, runAs, evalAs: null } as unknown as Instance);
  assert.deepEqual(problems({ user: 'wl-no-such-agent-user', home: '/home/wl-no-such-agent-user' }), ['agent user wl-no-such-agent-user (instance.yaml run_as) does not exist on this machine']);
  assert.deepEqual(problems({ user: userInfo().username, home: join(tmpdir(), 'no-such-home') }), [`agent user ${userInfo().username}'s home ${join(tmpdir(), 'no-such-home')} not found`]);
  assert.deepEqual(problems({ user: userInfo().username, home: homedir() }), []);
});

const cliRun = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), ...args], { encoding: 'utf8', env });

test('regression: doctor checks a repo config against the instance policy that will run it, before it merges', () => {
  // The repo config allows 4 workers; the instance policy allows 2: the coordinator would refuse to start.
  const { dir, repo, home } = setup('version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 2 }\nland_mode: pr\n');
  const agents = join(repo, BRAND.configDir, 'agents.yaml');
  writeFileSync(agents, readFileSync(agents, 'utf8').replace(/count: \d+, max: \d+/, 'count: 1, max: 4'));
  const local = cliRun(['doctor', '--root', repo], { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir });
  assert.equal(local.status, 1);
  assert.match(local.stdout, /FAIL {2}policy shop: \.\w+\/agents\.yaml at roles\.workers\.max: 4 exceeds the policy's max_workers 2/);
  // On another machine (no instance there), against a copy of the policy.
  const none = mkdtempSync(join(tmpdir(), 'no-instances-'));
  const elsewhere = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: none };
  const copy = cliRun(['doctor', '--root', repo, '--policy', join(home, 'policy.yaml')], elsewhere);
  assert.match(copy.stdout, /FAIL {2}policy \S+policy\.yaml: [\s\S]*roles\.workers\.max: 4 exceeds/);
  const unchecked = cliRun(['doctor', '--root', repo], elsewhere);
  assert.match(unchecked.stdout, /ok {4}policy: no instance on this machine runs example-org\/example-shop; to check against one, pass --policy/);
  writeFileSync(agents, readFileSync(agents, 'utf8').replace(/count: 1, max: 4/, 'count: 1, max: 1'));
  assert.match(cliRun(['doctor', '--root', repo], { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir }).stdout, /ok {4}policy shop: within the policy/);
});

test('install scaffolds a repo that a local instance runs within that instance policy, not at the template defaults', () => {
  const { dir } = setup('version: 1\nbudget: { daily_usd: 15 }\nagents: { max_workers: 2 }\nland_mode: pr\n');
  // A fresh checkout of the same repo, with no config yet.
  const fresh = mkdtempSync(join(tmpdir(), 'fresh-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: fresh });
  const env = { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir };
  const r = cliRun(['install', '--root', fresh], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /starts within this machine's instance policy for example-org\/example-shop \(budget \$15\/day, at most 2 workers\)/);
  const agents = readFileSync(join(fresh, BRAND.configDir, 'agents.yaml'), 'utf8');
  assert.match(agents, /^daily_budget_usd: 15\b/m);
  assert.match(agents, /workers:.*count: 1, max: 2,/);
  assert.match(cliRun(['doctor', '--root', fresh], env).stdout, /ok {4}policy shop: within the policy/);
});

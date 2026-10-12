// A fresh machine, end to end: `add` against fakes for GitHub (its REST API and a bare git remote), Discord
// and the root helper (each root step checked against the real helper's argument rules), answered the way the
// owner would, ending with the real doctor green on the checkout the coordinator would have. Then: a re-run
// does nothing more, and a run stopped half-way continues where it stopped without asking again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { doctor } from '../src/doctor.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { MACHINE_HELPER, type Exec } from '../src/machine.js';
import { runRootStep, answerSecret } from '../src/onboard/answer.js';
import { BOT_PERMISSION_BITS, discordApi } from '../src/onboard/discord.js';
import { appPermissionRules, Onboarding, onboardingLog, SETUP_BRANCH, type MachineProbe, type OnboardDeps } from '../src/onboard/flow.js';
import { restGitHub, type OwnerGitHub, type Ruleset } from '../src/onboard/github.js';
import { APP_PERMISSIONS, startManifestServer } from '../src/onboard/manifest.js';
import { repoRoot } from './helpers.js';

const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parseSetup: (a: string[]) => unknown };
const posix = process.platform !== 'win32';

/** A clean machine: its own state dir, and on PATH only the tools a set-up machine has (shims). */
function cleanMachine() {
  const root = mkdtempSync(join(tmpdir(), 'fresh-machine-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [tool, out] of [
    ['claude', '2.1.282 (Claude Code)'],
    ['gitleaks', '8.30.1'],
  ] as const) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho '${out}'\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const gitDir = execFileSync('sh', ['-c', 'dirname "$(command -v git)"'], { encoding: 'utf8' }).trim();
  const nodeDir = join(process.execPath, '..');
  return { root, env: { PATH: [bin, gitDir, nodeDir, '/usr/bin', '/bin'].join(delimiter), STATE: join(root, 'state') } };
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

/** The project on "GitHub": a bare repo with a node project, its tests and a CI workflow. */
function remoteRepo(root: string): string {
  const work = join(root, 'seed');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'test'));
  mkdirSync(join(work, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node --test test/' } }, null, 2));
  writeFileSync(join(work, 'package-lock.json'), JSON.stringify({ name: 'shop', lockfileVersion: 3, packages: {} }));
  writeFileSync(join(work, 'src', 'cart.js'), 'export const total = (xs) => xs.reduce((a, b) => a + b, 0);\n');
  writeFileSync(join(work, 'test', 'cart.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { total } from '../src/cart.js';\ntest('total', () => assert.equal(total([1, 2]), 3));\n");
  writeFileSync(
    join(work, '.github', 'workflows', 'ci.yml'),
    'name: ci\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        node: [22, 24]\n    runs-on: ${{ matrix.os }}\n    steps: [{ run: npm test }]\n  lint:\n    name: lint\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n',
  );
  writeFileSync(join(work, '.github', 'workflows', 'release.yml'), 'on:\n  push:\n    tags: ["v*"]\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n');
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const bare = join(root, 'github', 'acme', 'shop.git');
  mkdirSync(join(root, 'github', 'acme'), { recursive: true });
  git(root, 'clone', '-q', '--bare', work, bare);
  return bare;
}

interface World {
  bare: string;
  pem: string;
  installed: boolean;
  messageContent: boolean;
  labels: string[];
  prs: { head: string; base: string; title: string; body: string }[];
  rulesets: Ruleset[];
  manifests: { default_permissions: Record<string, string>; hook_attributes: { active: boolean } }[];
  helperRuns: string[][];
  helperInputs: Record<string, string>;
  probe: { files: Set<string>; users: Set<string>; ready: boolean; instances: string[] };
  srv: string;
  conversions: number;
}

const BOT_TOKEN = 'MTIz.' + 'b'.repeat(60);

function fakes(root: string, bare: string): { world: World; deps: OnboardDeps } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const world: World = { bare, pem, installed: false, messageContent: false, labels: [], prs: [], rulesets: [], manifests: [], helperRuns: [], helperInputs: {}, probe: { files: new Set(), users: new Set(), ready: false, instances: [] }, srv: join(root, 'srv'), conversions: 0 };
  const res = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const jwtOk = (h: string | null) => {
    const [head, body, sig] = (h ?? '').replace(/^Bearer /, '').split('.');
    if (!head || !body || !sig) return false;
    const v = createVerify('RSA-SHA256');
    v.update(`${head}.${body}`);
    return v.verify(publicKey, Buffer.from(sig, 'base64url')) && JSON.parse(Buffer.from(body, 'base64url').toString()).iss === '4242';
  };
  const ghFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const m = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    const p = u.pathname;
    if (p === '/users/acme') return res(200, { type: 'User' });
    if (m === 'POST' && p === '/app-manifests/one-time-code/conversions') return (world.conversions++, res(201, { id: 4242, slug: 'worklane-shop', pem, owner: { login: 'acme' }, html_url: 'https://github.example/apps/worklane-shop' }));
    if (p === '/app') return jwtOk(auth) ? res(200, { slug: 'worklane-shop' }) : res(401, { message: 'bad JWT' });
    if (p === '/repos/acme/shop/installation') return !jwtOk(auth) ? res(401, {}) : world.installed ? res(200, { id: 99 }) : res(404, { message: 'Not Found' });
    if (m === 'POST' && p === '/app/installations/99/access_tokens') return jwtOk(auth) ? res(201, { token: 'ghs_' + 'T'.repeat(36), permissions: world.manifests.at(-1)?.default_permissions ?? {} }) : res(401, {});
    const tok = auth === `Bearer ghs_${'T'.repeat(36)}`;
    if (!tok) return res(401, { message: 'no token' });
    if (p === '/installation/repositories') return res(200, { repositories: [{ full_name: 'acme/shop' }] });
    if (p === '/repos/acme/shop') return res(200, { default_branch: 'main' });
    if (p === '/repos/acme/shop/labels' && m === 'GET') return res(200, world.labels.map((name) => ({ name })));
    if (p === '/repos/acme/shop/labels' && m === 'POST') return (world.labels.push((JSON.parse(String(init!.body)) as { name: string }).name), res(201, {}));
    if (p === '/repos/acme/shop/pulls' && m === 'GET') return res(200, world.prs.map((_, i) => ({ number: i + 1, html_url: `https://github.example/acme/shop/pull/${i + 1}` })));
    if (p === '/repos/acme/shop/pulls' && m === 'POST') return (world.prs.push(JSON.parse(String(init!.body))), res(201, { number: world.prs.length, html_url: `https://github.example/acme/shop/pull/${world.prs.length}` }));
    return res(404, { message: `fake GitHub has no ${m} ${p}` });
  }) as typeof fetch;
  const discordFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    assert.equal(init?.method ?? 'GET', 'GET', 'Discord is only read');
    if (new Headers(init?.headers).get('authorization') !== `Bot ${BOT_TOKEN}`) return res(401, {});
    if (u.pathname.endsWith('/users/@me')) return res(200, { id: '777', username: 'intake-bot', bot: true });
    if (u.pathname.endsWith('/applications/@me')) return res(200, { id: '777', flags: world.messageContent ? 1 << 19 : 0 });
    return res(404, {});
  }) as typeof fetch;
  const owner: OwnerGitHub = {
    login: async () => 'ada',
    repoIds: async () => ({ ownerId: 1, repoId: 2 }),
    applyRuleset: async (_r, rs) => (world.rulesets.push(rs), { id: 7, created: world.rulesets.length === 1 }),
  };
  const probe: MachineProbe = {
    exists: (f) => world.probe.files.has(f),
    userExists: (u) => world.probe.users.has(u),
    helperReady: () => world.probe.ready,
    instances: () => world.probe.instances,
  };
  const deps: OnboardDeps = {
    github: { ...restGitHub(ghFetch, 'https://api.github.example', 'https://github.example'), gitUrl: () => bare },
    owner,
    discord: discordApi(discordFetch, 'https://discord.example/api/v10'),
    anthropic: async () => null,
    probe,
    engineRef: () => 'c'.repeat(40),
    rules: () => appPermissionRules(repoRoot),
    manifest: (o) => startManifestServer({ ...o, web: 'https://github.example' }),
    git: (args, cwd, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  };
  return { world, deps };
}

/** The root helper, faked: refuses anything the real helper refuses, then does what the script would, here. */
function fakeHelper(world: World, cleanEnv: Record<string, string>): Exec {
  return (file, args, input) => {
    assert.equal(file, 'sudo');
    assert.deepEqual(args.slice(0, 2), ['-n', MACHINE_HELPER], 'only ever the helper, with sudo -n');
    const [cmd, ...rest] = args.slice(2);
    assert.ok(helper.parseSetup([cmd!, ...rest]), `the real helper refuses ${args.slice(2).join(' ')}`);
    world.helperRuns.push([cmd!, ...rest]);
    if (input !== undefined) world.helperInputs[cmd!] = input;
    const n = rest[0]!;
    switch (cmd) {
      case 'setup-machine':
        world.probe.files.add('/etc/worklane/slots.json').add('/var/lib/worklane/agent-slots');
        return 'slots.json {"max_agents":2}';
      case 'add-instance':
        world.probe.users.add(`wl-${n}`).add(`wl-${n}-agent`);
        return `created user wl-${n}`;
      case 'checkout': {
        const dest = join(world.srv, n, 'shop');
        if (!existsSync(join(dest, '.git'))) git(join(world.srv, '..'), 'clone', '-q', world.bare, dest);
        else git(dest, 'pull', '-q', '--ff-only');
        return `checkout at ${git(dest, 'rev-parse', '--short', 'HEAD')}`;
      }
      case 'install-service':
      case 'install-dashboards':
        if (!world.probe.instances.includes(cmd === 'install-service' ? n : rest[1]!)) world.probe.instances.push(cmd === 'install-service' ? n : rest[1]!);
        return 'installed';
      case 'claude-status':
        return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });
      case 'tailscale-serve':
        return 'https://node.example/ serves the dashboard hub (127.0.0.1:4399) on the tailnet';
      case 'instance-doctor': {
        const saved = process.env.PATH;
        process.env.PATH = cleanEnv.PATH;
        try {
          const checks = doctor(join(world.srv, n, 'shop'));
          const out = JSON.stringify(checks);
          if (checks.some((c) => c.level === 'fail')) throw Object.assign(new Error('exit 1'), { stdout: out, stderr: '' });
          return out;
        } finally {
          process.env.PATH = saved;
        }
      }
      default:
        return 'ok';
    }
  };
}

/** The owner, answering each ask as it comes; `stopAt`: decline that root step (to stop the run there). */
function owner(onb: Onboarding, world: World, exec: Exec, o: { stopAt?: string } = {}) {
  const keyOf = (id: string) =>
    onb.log
      .read(0, ['onboard.ask'])
      .map((e) => e.payload as EventPayload<'onboard.ask'>)
      .find((p) => p.id === id)?.key ?? '';
  const seen = new Set<string>();
  const asked: string[] = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      for (const a of onb.asks.list({ status: 'open' })) {
        if (seen.has(a.id)) continue;
        const key = keyOf(a.id);
        if (!key) continue;
        seen.add(a.id);
        asked.push(key);
        const say = (answer: string) => onb.asks.answer(a.id, { by: 'ada', role: 'owner', answer });
        if (a.kind === 'question') {
          const pick: Record<string, string> = { 'app-mode': 'per-project', budget: '20', ruleset: 'apply', 'claude-auth': 'subscription', discord: 'set-up', tailscale: 'tailscale', 'tailscale-port': '8443' };
          if (key.startsWith('helper')) world.probe.ready = true;
          if (key === 'merge') {
            const w = mkdtempSync(join(tmpdir(), 'merge-'));
            git(w, 'clone', '-q', world.bare, 'c');
            git(join(w, 'c'), 'merge', '-q', '--ff-only', `origin/${SETUP_BRANCH}`);
            git(join(w, 'c'), 'push', '-q', 'origin', 'HEAD:main');
          }
          say(pick[key] ?? a.options[0]!);
        } else if (a.kind === 'approve_link') {
          if (key === 'app-create') {
            // The owner's browser: open the page, check the manifest, "create" it on GitHub, which redirects back.
            const page = await (await fetch(a.url)).text();
            const manifest = JSON.parse(page.match(/name="manifest" value="([^"]+)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
            world.manifests.push(manifest);
            const state = new URL(page.match(/action="([^"]+)"/)![1]!.replace(/&amp;/g, '&')).searchParams.get('state')!;
            const back = await fetch(`${manifest.redirect_url}?code=one-time-code&state=${state}`);
            assert.equal(back.status, 200);
            continue; // setup answers it itself once the code is back
          }
          if (key.startsWith('app-install')) world.installed = true;
          if (key.startsWith('discord-intent')) world.messageContent = true;
          if (key === 'discord-invite') assert.equal(new URL(a.url).searchParams.get('permissions'), BOT_PERMISSION_BITS.toString());
          say('approved');
        } else if (a.kind === 'paste_secret') {
          assert.equal(a.credential, 'intake-discord');
          answerSecret(onb.log, onb.dir, a.id, 'ada', BOT_TOKEN);
        } else if (a.kind === 'root_step') {
          if (key === o.stopAt) say('declined');
          else runRootStep(onb.log, onb.dir, a.id, 'ada', exec);
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return { asked, done: async () => ((stop = true), await loop) };
}

test('fresh machine: add sets a project up end to end against fakes, and ends with doctor green', { skip: !posix && 'machine setup is Linux; the fakes use sh shims' }, async () => {
  const m = cleanMachine();
  const bare = remoteRepo(m.root);
  const mainBefore = git(bare, 'rev-parse', 'main');
  const { world, deps } = fakes(m.root, bare);
  const exec = fakeHelper(world, m.env);
  const dir = join(m.env.STATE, 'onboarding', 'acme--shop');
  const onb = new Onboarding({ repo: 'acme/shop', by: 'ada', dir, pollMs: 5 }, deps);
  const o = owner(onb, world, exec);
  const r = await onb.run();
  await o.done();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.report.length > 5 && r.report.every((c) => c.level !== 'fail'), JSON.stringify(r.report.filter((c) => c.level === 'fail')));
  assert.ok(r.report.some((c) => c.name === 'config' && c.level === 'ok'), 'the real doctor checked the config the PR added');

  // The App: exactly the permissions app-permissions.mjs checks, no webhook; created once.
  assert.deepEqual(world.manifests[0]!.default_permissions, APP_PERMISSIONS);
  assert.equal(world.manifests[0]!.hook_attributes.active, false);
  assert.equal(world.conversions, 1);
  // Labels, the setup PR on its own branch, and main untouched by setup (only the owner's merge moved it).
  for (const l of ['ready', 'triage', 'agent:working', 'merge-ready', 'type:research', 'digest']) assert.ok(world.labels.includes(l), l);
  assert.deepEqual(world.prs.map((p) => [p.head, p.base]), [[SETUP_BRANCH, 'main']]);
  assert.equal(git(bare, 'rev-parse', 'main'), git(bare, 'rev-parse', SETUP_BRANCH), 'main is where the owner merged the setup branch');
  assert.equal(git(bare, 'rev-parse', `${SETUP_BRANCH}~1`), mainBefore, 'the setup branch is one commit on the old main');
  const config = git(bare, 'show', `${SETUP_BRANCH}:.worklane/config.yaml`);
  assert.match(config, /required_checks: \[ "test \(ubuntu-latest, 22\)", "test \(ubuntu-latest, 24\)", lint \]/);
  assert.match(config, /default: ada/);
  assert.match(git(bare, 'show', `${SETUP_BRANCH}:.worklane/tests.yaml`), /setup: \[ npm ci \]/);
  assert.match(git(bare, 'show', `${SETUP_BRANCH}:.worklane/agents.yaml`), /daily_budget_usd: 20/);
  // The ruleset: the detected checks, up to date before merging; applied with the owner's login, once approved.
  assert.equal(world.rulesets.length, 1);
  const checks = world.rulesets[0]!.rules.find((x) => x.type === 'required_status_checks') as { parameters: { strict_required_status_checks_policy: boolean; required_status_checks: { context: string }[] } };
  assert.equal(checks.parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(checks.parameters.required_status_checks.map((c) => c.context), ['test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)', 'lint']);
  // Root work: only helper setup commands, in order, the secrets on stdin.
  assert.deepEqual(world.helperRuns.map((x) => x[0]), ['setup-machine', 'add-instance', 'install-engine', 'install-app-key', 'set-budget', 'checkout', 'install-service', 'install-dashboards', 'claude-status', 'install-discord-token', 'tailscale-serve', 'instance-doctor']);
  assert.deepEqual(world.helperRuns.find((x) => x[0] === 'install-app-key'), ['install-app-key', 'shop', '4242', '99', 'acme/shop', 'per-repo']);
  assert.equal(world.helperInputs['install-app-key']!.trim(), world.pem.trim());
  assert.equal(world.helperInputs['install-discord-token'], `${BOT_TOKEN}\n`, 'on stdin, its line ended for read');
  assert.deepEqual(world.helperRuns.find((x) => x[0] === 'install-dashboards'), ['install-dashboards', 'ada', 'shop']);
  assert.deepEqual(world.helperRuns.find((x) => x[0] === 'tailscale-serve'), ['tailscale-serve', '8443'], 'the HTTPS port the owner chose');
  // No secret anywhere in the log, and none left staged.
  const text = readFileSync(onboardingLog(dir)).toString('latin1');
  for (const s of [BOT_TOKEN, world.pem.split('\n')[1]!, 'one-time-code', 'ghs_TTTT']) assert.ok(!text.includes(s), `the log holds ${s.slice(0, 12)}`);
  assert.ok(!existsSync(join(dir, 'secrets', 'github-app-key')) && !existsSync(join(dir, 'secrets', 'intake-discord')));

  // A re-run: everything is done, nothing is asked or run again.
  const runs = world.helperRuns.length;
  const again = new Onboarding({ repo: 'acme/shop', by: 'ada', dir, pollMs: 5 }, deps);
  const before = again.asks.list().length;
  const r2 = await again.run();
  assert.equal(r2.ok, true);
  assert.equal(again.asks.list().length, before, 'no new asks');
  assert.equal(world.helperRuns.length, runs, 'no root step again');
  again.close();
  onb.close();
});

test('stopped half-way (a root step declined), a re-run continues there: nothing done before is asked or done again', { skip: !posix && 'machine setup is Linux; the fakes use sh shims' }, async () => {
  const m = cleanMachine();
  const bare = remoteRepo(m.root);
  const { world, deps } = fakes(m.root, bare);
  const exec = fakeHelper(world, m.env);
  const dir = join(m.env.STATE, 'onboarding', 'acme--shop');
  const first = new Onboarding({ repo: 'acme/shop', by: 'ada', dir, pollMs: 5 }, deps);
  const o1 = owner(first, world, exec, { stopAt: 'instance' });
  const r1 = await first.run();
  await o1.done();
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /Coordinator and agent users: .*declined/);
  assert.ok(existsSync(join(dir, 'secrets', 'github-app-key')), "the App's key stays staged until its root step");
  first.close();

  const second = new Onboarding({ repo: 'acme/shop', by: 'ada', dir, pollMs: 5 }, deps);
  const o2 = owner(second, world, exec);
  const r2 = await second.run();
  await o2.done();
  assert.equal(r2.ok, true, r2.error);
  assert.equal(world.conversions, 1, 'the App was created once');
  assert.equal(world.prs.length, 1, 'one setup PR');
  assert.equal(world.rulesets.length, 1);
  for (const k of ['app-mode', 'app-create', 'budget', 'ruleset', 'machine']) assert.ok(!o2.asked.includes(k), `asked ${k} again`);
  assert.ok(o2.asked.includes('instance'), 'the declined step is asked again');
  assert.equal(world.helperRuns.filter((x) => x[0] === 'setup-machine').length, 1);
  second.close();
});

test('a failing doctor stops the run with each failure and its fix; the run is not green', { skip: !posix && 'sh shims' }, async () => {
  const m = cleanMachine();
  const bare = remoteRepo(m.root);
  const { world, deps } = fakes(m.root, bare);
  // A machine without Claude Code: the coordinator's doctor fails on it.
  const env = { ...m.env, PATH: m.env.PATH.split(delimiter).slice(1).join(delimiter) };
  const shims = join(m.root, 'bin2');
  mkdirSync(shims);
  writeFileSync(join(shims, 'gitleaks'), "#!/bin/sh\necho '8.30.1'\n");
  chmodSync(join(shims, 'gitleaks'), 0o755);
  env.PATH = [shims, env.PATH].join(delimiter);
  const exec = fakeHelper(world, env);
  const dir = join(m.env.STATE, 'onboarding', 'acme--shop');
  const onb = new Onboarding({ repo: 'acme/shop', by: 'ada', dir, pollMs: 5 }, deps);
  const o = owner(onb, world, exec);
  const r = await onb.run();
  await o.done();
  assert.equal(r.ok, false);
  const claude = r.report.find((c) => c.name === 'claude');
  assert.equal(claude?.level, 'fail');
  assert.match(claude!.fix, /tools\.sh/);
  assert.match(r.error!, /Doctor: doctor: \d+ failing[\s\S]*FAIL claude[\s\S]*fix: install Claude Code/);
  onb.close();
});

test('the log a run keeps: steps as onboard.step events, readable by the dashboard', { skip: !posix && 'sh shims' }, () => {
  const log = new EventLog(':memory:');
  log.append('onboard.step', { repo: 'acme/shop', instance: 'shop', step: 'labels', status: 'done', detail: 'created ready', data: { created: 1 } }, 'onboarding', 'coordinator');
  assert.throws(() => log.append('onboard.step', { repo: 'acme/shop', instance: 'shop', step: 'labels', status: 'maybe' as never, detail: '', data: {} }, 'onboarding'));
  log.close();
});

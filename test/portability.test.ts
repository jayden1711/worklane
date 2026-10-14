// Setup assumptions, detected or configurable: the agent user's PATH, homes from the user database, the command
// timeout, the template's worker count and doctor's Node check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { TestsConfig } from '../src/config/schema.js';
import { doctor } from '../src/doctor.js';
import { initInstance, loadInstance, setResolveHome } from '../src/instance.js';
import { defaultAgentPath, homesRoot, projectCommand } from '../src/os/index.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

const posix = process.platform === 'win32' && 'POSIX shell and sudo';
const setup = join(repoRoot, 'scripts', 'setup');
const lib = join(setup, 'lib.sh');
/** Run a lib.sh function in bash with PATH set to `path` (plus what bash itself needs). */
const sh = (script: string, args: string[] = [], path?: string) =>
  spawnSync('/bin/bash', ['-c', `source "$1"; shift; ${script}`, '_', lib, ...args], { encoding: 'utf8', env: { ...process.env, ...(path ? { PATH: path } : {}) } });
/** A directory of fake commands, each printing `out`. */
function fakeBin(cmds: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  for (const [name, out] of Object.entries(cmds)) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(out)}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}
const basePath = (extra: string) => `${extra}:/usr/bin:/bin`;

test('project commands run as the agent user with the PATH instance.yaml gives (a per-platform default), never one from tests.yaml', { skip: posix }, () => {
  assert.equal(defaultAgentPath('linux'), '/usr/local/bin:/usr/bin:/bin');
  assert.equal(defaultAgentPath('darwin'), '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin');
  const pathArg = (runAs: { user: string; home: string; path?: string }, env: Record<string, string> = {}) => projectCommand('npm test', runAs, env).args.filter((a) => a.startsWith('PATH='));
  assert.deepEqual(pathArg({ user: 'wl-x-agent', home: '/var/agents/x', path: '/opt/tools/bin:/usr/bin:/bin' }), ['PATH=/opt/tools/bin:/usr/bin:/bin']);
  assert.deepEqual(pathArg({ user: 'wl-x-agent', home: '/var/agents/x' }), [`PATH=${defaultAgentPath()}`]);
  assert.deepEqual(pathArg({ user: 'wl-x-agent', home: '/var/agents/x', path: '/usr/bin:/bin' }, { PATH: '/tmp/evil' }), ['PATH=/usr/bin:/bin'], "the repo's PATH is refused");
});

test("instance.yaml run_as.path reaches the agent users, and a bad one is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir, 'shop-agent', '/var/agents/shop');
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n');
  const f = join(home, 'instance.yaml');
  const yaml = readFileSync(f, 'utf8');
  assert.equal(loadInstance('shop', dir).runAs!.path, defaultAgentPath(), 'the default');
  writeFileSync(f, yaml.replace(/^ {2}agent_home: .*$/m, (l) => `${l}\n  path: /opt/tools/bin:/usr/bin:/bin`));
  assert.equal(loadInstance('shop', dir).runAs!.path, '/opt/tools/bin:/usr/bin:/bin');
  writeFileSync(f, yaml.replace(/^ {2}agent_home: .*$/m, (l) => `${l}\n  path: "relative/bin:/usr/bin"`));
  assert.throws(() => loadInstance('shop', dir), ConfigInvalid);
});

test("homes come from the user database: init writes the agent's real home, eval_home is resolved or required", () => {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const { dir: repo } = exampleProject();
  setResolveHome((u) => (u === 'shop-agent' ? '/var/agents/shop-agent' : u === 'shop-eval' ? '/var/agents/shop-eval' : null));
  // (the user database is replaced here: these users don't exist)
  try {
    const home = initInstance('shop', repo, 'example-org/example-shop', dir);
    assert.match(readFileSync(join(home, 'instance.yaml'), 'utf8'), /^ {2}agent_home: "\/var\/agents\/shop-agent"$/m);
    agentIsSelf(home);
    writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\nlanes:\n  default: { allowed_domains: [] }\n  eval: { allowed_domains: [], run_as: eval }\n');
    const f = join(home, 'instance.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^ {2}agent_home: .*$/m, (l) => `${l}\n  eval_user: shop-eval`));
    assert.equal(loadInstance('shop', dir).evalAs!.home, '/var/agents/shop-eval', 'resolved from the user database, not assumed');
    setResolveHome(() => null);
    assert.throws(() => loadInstance('shop', dir), (e: unknown) => e instanceof ConfigInvalid && e.errors.some((x) => x.path === 'run_as.eval_home' && /set eval_home/.test(x.message)));
    assert.match(readFileSync(join(initInstance('other', repo, 'example-org/other', dir), 'instance.yaml'), 'utf8'), new RegExp(`agent_home: "${homesRoot()}/other-agent"`), 'a user not made yet: the platform\'s usual root');
  } finally {
    setResolveHome(() => null);
  }
});

test('home_of reads the passwd database (getent), not /home/<user>', { skip: posix }, () => {
  const bin = fakeBin({ getent: 'wl-shop:x:1001:1001::/var/lib/wl-shop:/bin/bash' });
  const r = sh('home_of wl-shop', [], basePath(bin));
  assert.equal(r.stdout.trim(), '/var/lib/wl-shop', r.stderr);
  // Every file under scripts/setup, the ones in its subdirectories (installed beside a script) too.
  for (const f of readdirSync(setup, { recursive: true, encoding: 'utf8' })) {
    if (!statSync(join(setup, f)).isFile()) continue;
    assert.doesNotMatch(readFileSync(join(setup, f), 'utf8').replace(/^\s*#.*$/gm, ''), /\/home\/\$/, `${f} assumes /home/<user>`);
  }
});

test('tests.yaml command_timeout_s (default 2 hours) bounds project commands and agent runs', () => {
  const cfg = loadConfig(exampleProject().dir);
  assert.equal(cfg.tests.command_timeout_s, 7200);
  assert.equal(TestsConfig.safeParse({ ...cfg.tests, command_timeout_s: 10 }).success, false, 'at least a minute');
  assert.equal(TestsConfig.safeParse({ ...cfg.tests, command_timeout_s: 600 }).success, true);
  const src = (f: string) => readFileSync(join(repoRoot, 'src', f), 'utf8');
  for (const f of ['coordinator.ts', 'coordinator/fix-runs.ts', 'coordinator/corrections.ts', 'coordinator/decisions.ts', 'coordinator/research.ts', 'coordinator/gardener.ts', 'coordinator/base.ts']) assert.doesNotMatch(src(f), /\bCOMMAND_TIMEOUT_MS\b/, `${f} uses tests.yaml command_timeout_s`);
  assert.match(src('coordinator/base.ts'), /return this\.d\.cfg\.tests\.command_timeout_s \* 1000;/);
});

test("the template's worker count is {cores}, and doctor asks for the engine's own Node (>= 22.13), nothing more", () => {
  assert.match(readFileSync(join(repoRoot, 'templates', 'project', 'tests.yaml'), 'utf8'), /PYTEST_XDIST_AUTO_NUM_WORKERS: "\{cores\}"/);
  const node = doctor(exampleProject().dir).find((c) => c.name === 'node')!;
  assert.equal(node.level, 'ok', node.detail);
  assert.doesNotMatch(readFileSync(join(repoRoot, 'src', 'doctor.ts'), 'utf8'), />= 24/);
  mkdirSync(join(tmpdir(), 'unused'), { recursive: true });
});

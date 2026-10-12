// Hardware and setup assumptions, detected or configurable: the agent user's PATH, homes from the user database,
// the package manager, the command timeout, the slot ceiling and the checkout root from one machine file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { TestsConfig } from '../src/config/schema.js';
import { doctor } from '../src/doctor.js';
import { initInstance, loadInstance, setResolveHome } from '../src/instance.js';
import { DEFAULT_MAX_CAP, SLOTS_MAX, setSlotCap } from '../src/machine.js';
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
/** Only the few tools lib.sh's helpers use (no package manager among them). */
function coreBin(): string {
  const dir = fakeBin({});
  for (const tool of ['sed', 'tr', 'head', 'cut']) {
    const at = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (at) symlinkSync(at, join(dir, tool));
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
  for (const f of readdirSync(setup)) assert.doesNotMatch(readFileSync(join(setup, f), 'utf8').replace(/^\s*#.*$/gm, ''), /\/home\/\$/, `${f} assumes /home/<user>`);
});

test('pkg_install detects apt-get, dnf, zypper, pacman or apk, maps package names, and says what it found when none', { skip: posix }, () => {
  // Only the fake manager on PATH (a real apt-get in /usr/bin would be found first).
  for (const m of ['apt-get', 'dnf', 'zypper', 'pacman', 'apk']) assert.equal(sh('pkg_manager', [], `${fakeBin({ [m]: '' })}:${coreBin()}`).stdout.trim(), m);
  const cmd = (m: string, ...p: string[]) => sh('pkg_command "$@"', [m, ...p]).stdout.trim().split('\n');
  assert.deepEqual(cmd('apt-get', 'gh', 'acl'), ['apt-get', 'install', '-y', 'gh', 'acl']);
  assert.deepEqual(cmd('dnf', 'bubblewrap'), ['dnf', 'install', '-y', 'bubblewrap']);
  assert.deepEqual(cmd('zypper', 'socat'), ['zypper', '--non-interactive', 'install', 'socat']);
  assert.deepEqual(cmd('pacman', 'gh', 'socat'), ['pacman', '-S', '--needed', '--noconfirm', 'github-cli', 'socat']);
  assert.deepEqual(cmd('apk', 'gh'), ['apk', 'add', 'github-cli']);
  const osr = join(mkdtempSync(join(tmpdir(), 'os-')), 'os-release');
  writeFileSync(osr, 'NAME="Void"\nID="void"\n');
  const none = spawnSync('/bin/bash', ['-c', 'source "$1"; pkg_manager "$2"', '_', lib, osr], { encoding: 'utf8', env: { PATH: coreBin() } });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no supported package manager \(apt-get, dnf, zypper, pacman, apk\) on this machine \(void\)/);
  for (const f of ['machine.sh', 'tools.sh']) assert.doesNotMatch(readFileSync(join(setup, f), 'utf8'), /apt-get install/, `${f} uses pkg_install`);
});

test('the setup scripts stop early, saying why, anywhere but Linux with systemd', { skip: posix }, () => {
  const runtime = mkdtempSync(join(tmpdir(), 'systemd-'));
  assert.equal(sh('require_linux_systemd "$@"', ['Linux', runtime]).status, 0);
  const mac = sh('require_linux_systemd "$@"', ['Darwin', runtime]);
  assert.notEqual(mac.status, 0);
  assert.match(mac.stderr, /need Linux with systemd; this is Darwin/);
  const noSystemd = sh('require_linux_systemd "$@"', ['Linux', join(runtime, 'missing')]);
  assert.match(noSystemd.stderr, /need systemd as the init system/);
  assert.match(readFileSync(lib, 'utf8'), /as_root\(\) \{\n {2}require_linux_systemd \|\| exit 1/, 'before sudo, before anything changes');
});

test('machine.json holds the checkout root and the slot ceiling; every script reads the root from it', { skip: posix }, () => {
  const conf = join(mkdtempSync(join(tmpdir(), 'etc-')), 'machine.json');
  assert.deepEqual([sh('checkouts_root "$@"', [conf]).stdout.trim(), sh('max_cap "$@"', [conf]).stdout.trim()], ['/srv/worklane', '16'], 'defaults without the file');
  writeFileSync(conf, '{"max_cap":32,"checkouts":"/data/worklane"}\n');
  assert.deepEqual([sh('checkouts_root "$@"', [conf]).stdout.trim(), sh('max_cap "$@"', [conf]).stdout.trim()], ['/data/worklane', '32']);
  for (const f of readdirSync(setup).filter((x) => x !== 'lib.sh')) assert.doesNotMatch(readFileSync(join(setup, f), 'utf8').replace(/^\s*#.*$/gm, ''), /\/srv\/worklane/, `${f} names /srv/worklane`);
  const m = readFileSync(join(setup, 'machine.sh'), 'utf8');
  assert.match(m, /--max-cap\) max=/);
  assert.match(m, /--checkouts\) checkouts=/);
  assert.match(m, /printf '\{"max_cap":%s,"checkouts":"%s"\}\\n' "\$max" "\$checkouts" > "\$tmp"/);
});

test('one slot ceiling: machine.json max_cap, read by TS, the helper and the sudoers rule (all default 16)', { skip: posix }, () => {
  const conf = join(mkdtempSync(join(tmpdir(), 'etc-')), 'machine.json');
  assert.equal(SLOTS_MAX(conf), 16);
  writeFileSync(conf, '{"max_cap":24,"checkouts":"/srv/worklane"}\n');
  assert.equal(SLOTS_MAX(conf), 24);
  writeFileSync(conf, '{"max_cap":500}\n');
  assert.equal(SLOTS_MAX(conf), DEFAULT_MAX_CAP, 'out of range: the default');
  const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parse: (a: string[], max?: number) => unknown; maxCap: (f: string) => number; DEFAULT_MAX_CAP: number };
  assert.equal(helper.DEFAULT_MAX_CAP, DEFAULT_MAX_CAP);
  assert.match(readFileSync(lib, 'utf8'), new RegExp(`^DEFAULT_MAX_CAP=${DEFAULT_MAX_CAP}$`, 'm'));
  writeFileSync(conf, '{"max_cap":24}\n');
  assert.equal(helper.maxCap(conf), 24);
  assert.ok(helper.parse(['set-slots', '20'], 24));
  assert.equal(helper.parse(['set-slots', '25'], 24), null);
  assert.equal(helper.parse(['set-slots', '17']), null, 'the default ceiling is 16');
  const rule = spawnSync('bash', ['-c', 'source "$1"; shift; machine_sudoers "$@"', '_', lib, 'wl-shop'], { encoding: 'utf8', env: { ...process.env, MAX_CAP: '4' } }).stdout;
  assert.match(rule, /set-slots 4\b/);
  assert.doesNotMatch(rule, /set-slots 5\b/);
  assert.equal(setSlotCap(SLOTS_MAX() + 1, () => 'ran').ok, false, 'TS refuses above the ceiling before asking the helper');
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

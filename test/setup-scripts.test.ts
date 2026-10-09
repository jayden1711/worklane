import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot } from './helpers.js';

const dir = join(repoRoot, 'scripts', 'setup');
const scripts = readdirSync(dir).filter((f) => f.endsWith('.sh'));

test('setup scripts parse, stop at the first error, and only install sudoers rules that visudo accepted', { skip: process.platform === 'win32' && 'bash scripts' }, () => {
  assert.ok(scripts.length >= 5);
  for (const f of scripts) {
    const r = spawnSync('bash', ['-n', join(dir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    const text = readFileSync(join(dir, f), 'utf8');
    if (f !== 'lib.sh') assert.match(text, /source "\$\(dirname "\$0"\)\/lib\.sh"/, `${f} uses the shared strict-mode helpers`);
    // Any write into /etc/sudoers.d goes through install_sudoers: a dotted temp name, visudo -cf, then mv.
    for (const line of text.split('\n')) if (/\/etc\/sudoers\.d\//.test(line) && f !== 'lib.sh' && f !== 'check.sh') assert.fail(`${f} writes sudoers directly: ${line.trim()}`);
  }
  const lib = readFileSync(join(dir, 'lib.sh'), 'utf8');
  assert.match(lib, /set -euo pipefail/);
  const install = lib.slice(lib.indexOf('install_sudoers()'));
  assert.ok(install.indexOf('/etc/sudoers.d/.$1.tmp') < install.indexOf('visudo -cf') && install.indexOf('visudo -cf') < install.indexOf('mv -f'), 'temp name, then validate, then move');
});

test('no setup script hands a shell script to sudo -i (its login-shell quoting mangles multi-line scripts)', () => {
  for (const f of scripts) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (/sudo\s+(-\S+\s+)*-i\S*\s.*\b(ba)?sh\b.*\s-c\b/.test(line)) assert.fail(`${f}: use run_as, not sudo -i ... -c: ${line.trim()}`);
    }
  }
});

/** Each `run_as "$coord" '<script>' args` section of a setup script. */
const sections = (f: string) => [...readFileSync(join(dir, f), 'utf8').matchAll(/run_as "\$coord" '\n([\s\S]*?)\n\s*' /g)].map((m) => m[1]!);

// A real other user, which passwordless sudo can switch to (CI runners; skipped where sudo asks for a password).
const other = 'nobody';
const canSwitch = process.platform !== 'win32' && spawnSync('sudo', ['-n', '-u', other, 'true']).status === 0;

test('acceptance: every run_as section of the setup scripts runs as a real other user with its arguments intact', { skip: !canSwitch && 'needs passwordless sudo to another user' }, () => {
  // Stub the tools so only the scripts' own shell (quoting, arguments, control flow) is under test.
  const stubs = 'worklane() { echo "worklane $*"; }\ngit() { echo "git $*"; case "$1" in rev-parse) echo main;; esac; }\n';
  const runAs = (body: string, args: string[]) =>
    spawnSync('bash', ['-c', `source "${join(dir, 'lib.sh')}"; run_as ${other} "$@"`, '_', stubs + body, ...args], { encoding: 'utf8' });
  const engine = sections('engine.sh');
  const checkout = sections('checkout.sh');
  const service = sections('service.sh');
  assert.equal(engine.length, 1);
  assert.equal(checkout.length, 2);
  assert.equal(service.length, 1);
  const dest = mkdtempSync('/tmp/wl-setup-');
  chmodSync(dest, 0o777);
  try {
    const repo = 'example-org/example shop';
    let r = runAs(engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane instance init site --repo \/srv\/worklane\/site\/example shop --github example-org\/example shop --agent-user wl-site-agent$/m);
    // Re-running after the instance exists (e.g. made by hand, naming another agent user) points it at wl-site-agent, once.
    const instDir = join(dest, '.local', 'state', 'worklane', 'instances', 'site');
    mkdirSync(instDir, { recursive: true, mode: 0o777 });
    for (let d = instDir; d !== dest; d = dirname(d)) chmodSync(d, 0o777);
    const yaml = join(instDir, 'instance.yaml');
    writeFileSync(yaml, 'version: 1\nname: site\nrun_as:\n  agent_user: site-agent\n  agent_home: /home/site-agent\n', { mode: 0o666 });
    chmodSync(yaml, 0o666);
    const listed = `HOME=${dest}\nworklane() { if [ "$2" = list ]; then echo site; else echo "worklane $*"; fi; }\n`;
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'instance site exists; run_as now wl-site-agent\n');
    assert.match(readFileSync(yaml, 'utf8'), /^ {2}agent_user: wl-site-agent\n {2}agent_home: \/home\/wl-site-agent$/m);
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo]);
    assert.equal(r.stdout, 'instance site exists; agents run as wl-site-agent\n');
    r = runAs(checkout[0]!, ['site', dest, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^git -c credential.helper= -c credential.helper=!\/usr\/local\/bin\/worklane git-credential clone -q https:\/\/github.com\/example-org\/example shop.git /m);
    assert.match(r.stdout, /^git config core.sharedRepository group$/m);
    assert.match(r.stdout, /^git -c core.hooksPath=\/dev\/null pull -q --ff-only$/m);
    assert.match(r.stdout, /^worklane install --root \. --git-hooks-only$/m);
    r = runAs(checkout[1]!, ['site', dest, repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane install --root \. --engine \/opt\/worklane\/current\/dist\/src\/cli.js$/m);
    assert.match(r.stdout, /^git push -q origin HEAD:refs\/heads\/worklane\/setup$/m);
    assert.match(r.stdout, /compare\/worklane\/setup/);
    r = runAs(service[0]!, ['site']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'worklane instance show site\n');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('the coordinator service unit runs as the coordinator user, can still sudo to agents, and stops them with it', { skip: process.platform === 'win32' && 'bash scripts' }, () => {
  const r = spawnSync('bash', [join(dir, 'service.sh'), 'site', '--print'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const unit = r.stdout;
  assert.match(unit, /^User=wl-site$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/worklane coordinator run --instance site$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.doesNotMatch(unit, /NoNewPrivileges=(yes|true)/, 'agents are started through sudo');
  const install = readFileSync(join(dir, 'service.sh'), 'utf8');
  assert.ok(install.indexOf('systemd-analyze verify') < install.indexOf('mv -f'), 'validated before it is moved into place');
});

test('the service yields to other work: a low-weight top-level slice, a hard memory cap without swap, per-instance limits', { skip: process.platform === 'win32' && 'bash scripts' }, () => {
  const print = (...opts: string[]) => spawnSync('bash', [join(dir, 'service.sh'), 'site', ...opts, '--print'], { encoding: 'utf8' });
  const d = print().stdout;
  // Beside system.slice and user.slice (where rootless containers run), not inside system.slice.
  assert.match(d, /# \/etc\/systemd\/system\/worklane\.slice\n\[Unit\][\s\S]*\[Slice\]\nCPUWeight=20\nIOWeight=20\n/);
  for (const line of ['Slice=worklane.slice', 'MemoryHigh=infinity', 'MemoryMax=35%', 'MemorySwapMax=0', 'CPUWeight=100', 'TasksMax=2048', 'OOMPolicy=continue']) assert.match(d, new RegExp(`^${line}$`, 'm'), line);
  const custom = print('--memory-max', '16G', '--memory-high', '12G', '--cpu-weight', '50', '--tasks-max', '512', '--slice-cpu-weight', '10', '--slice-io-weight', '5');
  assert.equal(custom.status, 0, custom.stderr);
  for (const line of ['MemoryMax=16G', 'MemoryHigh=12G', 'CPUWeight=50', 'TasksMax=512', 'CPUWeight=10', 'IOWeight=5']) assert.match(custom.stdout, new RegExp(`^${line}$`, 'm'), line);
  for (const [opts, err] of [
    [['--memory-max', '150%'], /--memory-max: a size/],
    [['--memory-max', '8 G'], /unknown option|a size/],
    [['--memory-high', '20G', '--memory-max', '16G'], /must not exceed/],
    [['--memory-high', '40%', '--memory-max', '30%'], /must not exceed/],
    [['--cpu-weight', '0'], /a weight from 1 to 10000/],
    [['--tasks-max', 'x'], /a positive number/],
    [['--bogus'], /unknown option --bogus/],
  ] as const) {
    const r = print(...opts);
    assert.equal(r.status, 2, `${opts.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, err);
  }
  // Options survive the re-run as root.
  assert.match(readFileSync(join(dir, 'service.sh'), 'utf8'), /all_args=\("\$@"\)[\s\S]*as_root "\$\{all_args\[@\]\}"/);
});

test('gitleaks is installed at a pinned version only when its download matches a pinned sha256', () => {
  const tools = readFileSync(join(dir, 'tools.sh'), 'utf8');
  assert.match(tools, /^gitleaks_version=\d+\.\d+\.\d+$/m);
  for (const arch of ['x64', 'arm64']) assert.match(tools, new RegExp(`^gitleaks_sha256_${arch}=[0-9a-f]{64}$`, 'm'));
  // Verified before it is unpacked or installed, and installed root-owned where agents' PATH finds it.
  const at = (s: string) => tools.indexOf(s);
  assert.ok(at('sha256sum -c') > at('curl -fsSL') && at('sha256sum -c') < at('tar -xzf') && at('tar -xzf') < at('install -o root'), 'download, verify, then unpack and install');
  assert.match(tools, /install -o root -g root -m 0755 "\$work\/gitleaks" \/usr\/local\/bin\/gitleaks/);
});

// Creates OS users and runs systemd units: only on disposable CI runners (GitHub's Linux runners have systemd and passwordless sudo).
const systemCi = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' && spawnSync('sudo', ['-n', 'systemctl', '--version']).status === 0;

test('acceptance: two instances\' agent users each get their own /tmp, so a fixed path like /tmp/cc-socks locks neither out', { skip: !systemCi && 'needs a disposable Linux CI runner with systemd' }, () => {
  const sudo = (...a: string[]) => spawnSync('sudo', ['-n', ...a], { encoding: 'utf8' });
  const unit = spawnSync('bash', [join(dir, 'service.sh'), 'site', '--print'], { encoding: 'utf8' }).stdout;
  const props = unit.split('\n').filter((l) => /^PrivateTmp=/.test(l));
  assert.deepEqual(props, ['PrivateTmp=yes'], 'each coordinator service, and the agents it starts, get a private /tmp');
  // What Claude Code does at start: make /tmp/cc-socks (0700) if it isn't there, and bind its socket inside.
  const claudeLike = 'import os,socket\nd="/tmp/cc-socks"\ntry: os.mkdir(d,0o700)\nexcept FileExistsError: pass\ns=socket.socket(socket.AF_UNIX)\ns.bind(f"{d}/{os.getpid()}.sock")\nprint("socket ok")';
  const agents = ['wl-tmpa-agent', 'wl-tmpb-agent'];
  for (const u of agents) if (spawnSync('id', ['-u', u]).status !== 0) assert.equal(sudo('useradd', '--create-home', u).status, 0);
  const start = (user: string, extra: string[]) => sudo('systemd-run', '--quiet', '--wait', '--pipe', '--collect', '-p', `User=${user}`, ...extra, 'python3', '-c', claudeLike);
  sudo('rm', '-rf', '/tmp/cc-socks');
  try {
    for (const u of agents) {
      const r = start(u, props.flatMap((p) => ['-p', p]));
      assert.equal(r.stdout.trim(), 'socket ok', `${u}: ${r.stderr}`);
    }
    // Control: with a shared /tmp, the second agent user is locked out by the first one's directory.
    const first = start(agents[0]!, []);
    assert.equal(first.stdout.trim(), 'socket ok', first.stderr);
    const second = start(agents[1]!, []);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /PermissionError/);
  } finally {
    sudo('rm', '-rf', '/tmp/cc-socks');
  }
});

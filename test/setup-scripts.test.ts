import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Each `run_as "$coord" '<script>' args` section of a setup script (in lib.sh's helpers, `run_as "wl-$name" ...`). */
const sections = (f: string) => [...readFileSync(join(dir, f), 'utf8').matchAll(/run_as "(?:\$coord|wl-\$name)" '\n([\s\S]*?)\n\s*' /g)].map((m) => m[1]!);

// A real other user, which passwordless sudo can switch to (CI runners; skipped where sudo asks for a password).
const other = 'nobody';
const canSwitch = process.platform !== 'win32' && spawnSync('sudo', ['-n', '-u', other, 'true']).status === 0;

test('acceptance: every run_as section of the setup scripts runs as a real other user with its arguments intact', { skip: !canSwitch && 'needs passwordless sudo to another user' }, () => {
  // Stub the tools so only the scripts' own shell (quoting, arguments, control flow) is under test.
  const stubs = 'worklane() { echo "worklane $*"; }\ngit() { echo "git $*"; case "$1" in rev-parse) echo main;; esac; }\n';
  const runAs = (body: string, args: string[]) =>
    spawnSync('bash', ['-c', `source "${join(dir, 'lib.sh')}"; run_as ${other} "$@"`, '_', stubs + body, ...args], { encoding: 'utf8' });
  // The instance home (engine.sh and add-project.sh, through lib.sh's ensure_instance_home).
  const engine = sections('lib.sh');
  const checkout = sections('checkout.sh');
  const service = sections('service.sh');
  assert.equal(engine.length, 1);
  assert.match(readFileSync(join(dir, 'engine.sh'), 'utf8'), /^ {2}ensure_instance_home "\$name" "\$repo"$/m, 'engine.sh makes the instance home with it');
  assert.equal(checkout.length, 2);
  assert.equal(service.length, 1);
  const dest = mkdtempSync('/tmp/wl-setup-');
  chmodSync(dest, 0o777);
  try {
    const repo = 'example-org/example shop';
    let r = runAs(engine[0]!, ['site', `/srv/worklane/site/example shop`, repo, '/var/lib/wl-site-agent']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^worklane instance init site --repo \/srv\/worklane\/site\/example shop --github example-org\/example shop --agent-user wl-site-agent --agent-home \/var\/lib\/wl-site-agent$/m);
    // Re-running after the instance exists (e.g. made by hand, naming another agent user) points it at wl-site-agent, once.
    const instDir = join(dest, '.local', 'state', 'worklane', 'instances', 'site');
    mkdirSync(instDir, { recursive: true, mode: 0o777 });
    for (let d = instDir; d !== dest; d = dirname(d)) chmodSync(d, 0o777);
    const yaml = join(instDir, 'instance.yaml');
    writeFileSync(yaml, 'version: 1\nname: site\nrun_as:\n  agent_user: site-agent\n  agent_home: /home/site-agent\n', { mode: 0o666 });
    chmodSync(yaml, 0o666);
    const listed = `HOME=${dest}\nworklane() { if [ "$2" = list ]; then echo site; else echo "worklane $*"; fi; }\n`;
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo, '/var/lib/wl-site-agent']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'instance site exists; run_as now wl-site-agent\n');
    assert.match(readFileSync(yaml, 'utf8'), /^ {2}agent_user: wl-site-agent\n {2}agent_home: \/var\/lib\/wl-site-agent$/m);
    r = runAs(listed + engine[0]!, ['site', `/srv/worklane/site/example shop`, repo, '/var/lib/wl-site-agent']);
    assert.equal(r.stdout, 'instance site exists; agents run as wl-site-agent\n');
    r = runAs(checkout[0]!, ['site', dest, repo, 'https://github.com']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^git -c credential.helper= -c credential.helper=!\/usr\/local\/bin\/worklane git-credential --instance site clone -q https:\/\/github.com\/example-org\/example shop.git /m);
    assert.match(r.stdout, /^git config core.sharedRepository group$/m);
    assert.match(r.stdout, /^git -c core.hooksPath=\/dev\/null pull -q --ff-only$/m);
    assert.match(r.stdout, /^worklane install --root \. --git-hooks-only$/m);
    // No config yet: auto-config, as the coordinator, with the API it is given; nothing branched or pushed here.
    const proposed = `worklane() { echo "args: $* api=\${WORKLANE_GITHUB_API:-}" >&2; echo '{"kind":"proposed","detail":"x","pr":"https://github.com/example-org/example shop/pull/1","questions":[]}'; }\n`;
    r = runAs(proposed + checkout[1]!, ['site', dest, 'http://127.0.0.1:8999']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^args: instance auto-config site api=http:\/\/127\.0\.0\.1:8999$/m);
    assert.match(r.stdout, /^auto-config: \{"kind":"proposed"/m);
    assert.doesNotMatch(r.stdout, /git (switch|add|commit|push)/);
    r = runAs(service[0]!, ['site']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'worklane instance show site\n');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("checkout.sh: with the config, the agent runs' guardrail hooks; without it, auto-config's setup PR (audit B4), and never a branch in the checkout, so a rerun can't trip on one (audit B5)", { skip: process.platform === 'win32' && 'bash scripts' }, () => {
  const config = sections('checkout.sh')[1]!;
  const stubs = (answer: string) => `worklane() { case "$1 $2" in "instance auto-config") echo "worklane $*" >&2; echo '${answer}';; *) echo "worklane $*";; esac; }\ngit() { echo "git $*"; case "$1" in rev-parse) echo main;; esac; }\n`;
  const run = (dest: string, answer = '{"kind":"proposed","detail":"proposed in PR #1","pr":"https://github.com/example-org/shop/pull/1","questions":[]}') =>
    spawnSync('bash', ['-euo', 'pipefail', '-c', stubs(answer) + config, '_', 'site', dest, ''], { encoding: 'utf8' });
  const install = /^worklane install --root \. --instance site --engine \/opt\/worklane\/current\/dist\/src\/cli.js$/m;
  const withConfig = mkdtempSync(join(tmpdir(), 'wl-checkout-'));
  const without = mkdtempSync(join(tmpdir(), 'wl-checkout-'));
  try {
    mkdirSync(join(withConfig, '.worklane'));
    let r = run(withConfig);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, install, 'a repo that already has .worklane/ gets the hooks');
    assert.doesNotMatch(r.stdout, /git (switch|add|commit|push)/, 'and nothing is committed or pushed');
    // Without: auto-config drafts and proposes the config; the checkout gets no branch, commit or scaffold.
    for (let i = 0; i < 2; i++) {
      r = run(without);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /^worklane instance auto-config site$/m);
      assert.match(r.stdout, /the config is proposed in its setup PR: review and merge it/);
      assert.doesNotMatch(r.stdout, /git (switch|checkout|branch|add|commit|push)|worklane install/, 'a rerun finds the PR, never a branch here');
    }
    assert.ok(!existsSync(join(without, '.worklane')));
    r = run(without, '{"kind":"questions","detail":"1 question to answer","pr":null,"questions":["one-test-file"]}');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /auto-config has questions to answer/);
    r = run(without, '{"kind":"failed","detail":"pushing worklane/setup failed: denied","pr":null,"questions":[]}');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /auto-config failed/);
  } finally {
    rmSync(withConfig, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
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

test('regression (audit B3): credentials.sh github-app writes credentials.yaml itself, through the engine, after its check; never "set it by hand"', () => {
  const text = readFileSync(join(dir, 'credentials.sh'), 'utf8');
  const app = text.slice(text.indexOf('  github-app)'), text.indexOf('  verify-app)'));
  assert.doesNotMatch(app, /then set in credentials\.yaml/, 'no hand edit');
  assert.doesNotMatch(app, /printf "%s\\n" "version: 1" "github:/, 'no hand-rolled file that drops its other settings');
  const verify = app.indexOf('verify_app "$key"');
  const home = app.indexOf('ensure_instance_home "$name" "$repo"');
  const write = app.indexOf(`run_as "$coord" 'worklane instance set-github-app "$1" --app-id "$2" --installation-id "$3" --key "$4"' "$name" "$app_id" "$inst_id" "$key"`);
  assert.ok(verify > 0 && home > verify && write > home, 'checked first; the instance home made when missing; then written as the coordinator, by the engine');
});

test('a repo whose setup PR has not merged: service.sh starts nothing and exits 3 ("waiting", naming the PR); bootstrap passes that on as waiting, never success', () => {
  const service = readFileSync(join(dir, 'service.sh'), 'utf8');
  const waiting = service.indexOf(`run_as "$coord" 'worklane instance setup-status "$1"' "$name"`);
  assert.ok(waiting > 0 && waiting < service.indexOf('worklane instance show'), 'checked before anything is installed');
  assert.match(service, /echo "waiting for the setup PR \$pr: the coordinator starts once it has merged[^"]*"\n[\s\S]*?exit 3/);
  const boot = readFileSync(join(repoRoot, 'scripts', 'bootstrap.sh'), 'utf8');
  assert.match(boot, /if \[ "\$rc" = 3 \]; then[\s\S]*?exit 3\n {4}fi\n {4}\[ "\$rc" = 0 \] \|\| exit "\$rc"/);
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

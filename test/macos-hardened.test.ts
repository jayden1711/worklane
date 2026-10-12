import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolationCheck, osCredentialStores, sandboxMechanism, serviceDefinitionPath, type IsolationFacts } from '../src/os/isolation.js';
import { homeCredentialStores } from '../src/sandbox.js';
import { repoRoot } from './helpers.js';

const setup = join(repoRoot, 'scripts', 'setup');
const mac = join(setup, 'macos');
const read = (f: string) => readFileSync(join(mac, f), 'utf8');
const posix = process.platform !== 'win32';
const darwin = process.platform === 'darwin';
const MAC_SCRIPTS = ['lib.sh', 'machine.sh', 'instance.sh', 'service.sh', 'dashboards.sh', 'check.sh'];

const facts = (over: Partial<IsolationFacts> = {}): IsolationFacts => ({
  os: 'macos',
  instance: 'alpha',
  coordinatorUser: 'wl-alpha',
  agentUser: 'wl-alpha-agent',
  agentUserExists: true,
  sandbox: 'Seatbelt',
  service: '/Library/LaunchDaemons/com.worklane.coordinator.alpha.plist',
  ...over,
});

test('doctor: hardened macOS says what keeps agents apart and what macOS can\'t limit', () => {
  const r = isolationCheck(facts());
  assert.equal(r.level, 'ok');
  assert.match(r.detail, /^hardened macOS: agents run as wl-alpha-agent, a separate OS user from wl-alpha/);
  assert.match(r.detail, /Claude Code's sandbox \(Seatbelt\)/);
  assert.match(r.detail, /network only through its proxy to the lane's allowed hosts/);
  assert.match(r.detail, /launchd daemon .*com\.worklane\.coordinator\.alpha\.plist.*can't cap its memory or CPU \(no cgroups\)/);
  const linux = isolationCheck(facts({ os: 'linux', sandbox: 'bubblewrap', service: '/etc/systemd/system/worklane-alpha.service' }));
  assert.match(linux.detail, /^hardened Linux: .*\(bubblewrap\).*memory, CPU and task limits/);
});

test('doctor: each way an instance isn\'t hardened is a failure, a missing daemon a warning', () => {
  const cases: [Partial<IsolationFacts>, string, RegExp][] = [
    [{ agentUser: null }, 'fail', /not hardened: alpha's agents run as wl-alpha, the user holding its credentials.*macos\/instance\.sh/],
    [{ agentUser: 'wl-alpha' }, 'fail', /agent user is wl-alpha itself/],
    [{ agentUserExists: false }, 'fail', /wl-alpha-agent doesn't exist on this machine \(scripts\/setup\/macos\/instance\.sh alpha\)/],
    [{ sandbox: null }, 'fail', /\/usr\/bin\/sandbox-exec \(Seatbelt\) is missing, so agent runs refuse to start/],
    [{ service: null }, 'warn', /^hardened macOS: .*isn't a root-owned launchd daemon \(scripts\/setup\/macos\/service\.sh alpha\)/],
    [{ os: 'windows' }, 'warn', /native Windows/],
  ];
  for (const [over, level, why] of cases) {
    const r = isolationCheck(facts(over));
    assert.equal(r.level, level, why.source);
    assert.match(r.detail, why);
  }
});

test('the sandbox and service each OS uses, by path', () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  assert.equal(sandboxMechanism('macos', has('/usr/bin/sandbox-exec')), 'Seatbelt');
  assert.equal(sandboxMechanism('macos', has('/usr/bin/bwrap')), null, 'bubblewrap means nothing on macOS');
  assert.equal(sandboxMechanism('linux', has('/usr/bin/bwrap')), 'bubblewrap');
  assert.equal(sandboxMechanism('windows', has('/usr/bin/bwrap', '/usr/bin/sandbox-exec')), null);
  assert.equal(serviceDefinitionPath('macos', 'alpha'), '/Library/LaunchDaemons/com.worklane.coordinator.alpha.plist');
  assert.match(read('service.sh'), /^label="com\.worklane\.coordinator\.\$name"$/m, 'doctor looks where service.sh installs');
  assert.equal(serviceDefinitionPath('linux', 'alpha'), '/etc/systemd/system/worklane-alpha.service');
});

test('on macOS an agent\'s keychain files are a denied credential store too', () => {
  assert.ok(homeCredentialStores('/Users/u', osCredentialStores('darwin')).includes('/Users/u/Library/Keychains'));
  assert.ok(!homeCredentialStores('/home/u', osCredentialStores('linux')).some((p) => p.includes('Keychains')));
  assert.ok(homeCredentialStores('/Users/u/', osCredentialStores('darwin')).includes('/Users/u/.ssh'), 'the common stores stay');
});

test('the macOS scripts use nothing Linux-only', () => {
  for (const f of MAC_SCRIPTS) {
    const s = read(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const bad of [/\buseradd\b/, /\bgroupadd\b/, /\busermod\b/, /\bloginctl\b/, /\bsystemctl\b/, /\bsystemd-analyze\b/, /\bsetfacl\b/, /\bapt-get\b/, /\bbwrap\b/, /root:root/, /-g root\b/, /\/srv\//, /\/home\//, /\bstat -c\b/, /\bmapfile\b/, /\breadarray\b/, /local -n\b/]) {
      assert.doesNotMatch(s, bad, `${f}: ${bad.source}`);
    }
  }
  for (const f of MAC_SCRIPTS.filter((f) => f !== 'lib.sh')) {
    const s = read(f);
    assert.match(s, /^source "\$\(dirname "\$0"\)\/lib\.sh"$/m, `${f} uses the macOS helpers`);
    assert.match(s, /^require_macos$/m, `${f} refuses to run on Linux`);
  }
});

test('the macOS scripts parse', { skip: !posix && 'bash' }, () => {
  for (const f of MAC_SCRIPTS) {
    const r = spawnSync('bash', ['-n', join(mac, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('instance.sh on macOS: the same users, groups, sticky checkout and sudoers rule as on Linux', () => {
  const m = read('instance.sh');
  const l = readFileSync(join(setup, 'instance.sh'), 'utf8');
  const rules = (s: string) => s.slice(s.indexOf('runas="$agent"'), s.indexOf('install_sudoers "worklane-$name" "$rules"'));
  assert.ok(rules(m).length > 50);
  assert.equal(rules(m), rules(l), 'the sudoers rule is word for word the Linux one');
  for (const line of ['coord="wl-$name" agent="wl-$name-agent" work="wl-$name-work"', 'ensure_user "$coord"', 'ensure_user "$agent"', 'ensure_group "$work"', 'ensure_member "$coord" agent-slots', 'for u in "$coord" "$agent" $eval_user; do ensure_member "$u" "$work"; done']) {
    assert.ok(m.includes(line), line);
    assert.ok(l.includes(line), `Linux has ${line} too`);
  }
  assert.match(m, /install -d -o "\$coord" -g "\$work" -m 3770 "\$\(checkouts_root\)\/\$name"/);
  assert.match(m, /\[ "\$name" != dash \]/, 'never the dashboard viewer');
});

/** Run a macOS lib.sh function in bash, with dscl and the other Directory Services tools stubbed on PATH. */
function mkStubs(stubs: Record<string, string>, log = '/dev/null'): string {
  const dir = mkdtempSync(join(tmpdir(), 'stubs-'));
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function libWith(stubs: Record<string, string>, script: string) {
  const log = join(mkdtempSync(join(tmpdir(), 'log-')), 'calls.log');
  const dir = mkStubs(stubs, log);
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(join(mac, 'lib.sh'))}; ${script}`], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    // nothing called
  }
  return { ...r, calls };
}

const dscl = (users: string, groups: string) => `
case "$*" in
  ". -list /Users UniqueID") printf '%s\\n' ${JSON.stringify(users)} | tr ',' '\\n' ;;
  ". -list /Groups PrimaryGroupID") printf '%s\\n' ${JSON.stringify(groups)} | tr ',' '\\n' ;;
  ". -read /Users/user NFSHomeDirectory") echo "NFSHomeDirectory: /Users/user" ;;
  ". -read /Groups/"*) exit 56 ;;
  ". -read /Users/"*) exit 56 ;;
esac
exit 0`;

test('free ids: the lowest from 400 to 499 that no user or group has', { skip: !posix && 'bash' }, () => {
  const r = libWith({ dscl: dscl('root 0,runner 501,a 400,b 402', 'wheel 0,staff 20,g 401,h 403') }, 'free_id');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '404', '400-403 are taken by users or groups');
  const all = Array.from({ length: 100 }, (_, i) => `u${i} ${400 + i}`).join(',');
  const full = libWith({ dscl: dscl(all, 'staff 20') }, 'free_id');
  assert.notEqual(full.status, 0);
  assert.match(full.stderr, /no free id from 400 to 499/);
});

test('a new service account: hidden, no password, bash as on Linux, its own primary group, never staff', { skip: !posix && 'bash' }, () => {
  const r = libWith(
    {
      dscl: dscl('root 0,runner 501', 'wheel 0,staff 20'),
      dseditgroup: 'exit 0',
      dscacheutil: 'exit 0',
      id: 'case "$1" in -u) exit 1 ;; -gn) echo user ;; esac',
      install: 'exit 0',
      chmod: 'exit 0',
    },
    'ensure_user user',
  );
  assert.equal(r.status, 0, r.stderr);
  const want = ['dseditgroup -o create -i 400 -r worklane user user', 'dscl . -create /Users/user UniqueID 400', 'dscl . -create /Users/user PrimaryGroupID 400', 'dscl . -create /Users/user UserShell /bin/bash', 'dscl . -create /Users/user Password *', 'dscl . -create /Users/user IsHidden 1', 'dscl . -create /Users/user NFSHomeDirectory /Users/user', 'install -d -o user -g user -m 0700 /Users/user', 'chmod 0700 /Users/user'];
  for (const w of want) assert.ok(r.calls.includes(w), `${w}\n${r.calls.join('\n')}`);
  assert.ok(!r.calls.some((c) => / PrimaryGroupID 20$/.test(c)), 'not staff');
  assert.ok(r.calls.indexOf('dseditgroup -o create -i 400 -r worklane user user') < r.calls.indexOf('dscl . -create /Users/user'), 'its group first');
});

test('home_of reads Directory Services, and refuses a user it doesn\'t know', { skip: !posix && 'bash' }, () => {
  const ok = libWith({ dscl: dscl('', '') }, 'home_of user; state_root_of user');
  assert.deepEqual(ok.stdout.trim().split('\n'), ['/Users/user', '/Users/user/Library/Application Support/worklane']);
  const none = libWith({ dscl: dscl('', '') }, 'home_of nobody-here');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no home for nobody-here/);
});

test('service.sh on macOS: a root-owned daemon as the coordinator, with the limits launchd has', { skip: !posix && 'bash' }, () => {
  const r = spawnSync('bash', [join(mac, 'service.sh'), 'alpha', '--print'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plist = r.stdout.split('\n').slice(1).join('\n');
  for (const want of [
    '<key>Label</key><string>com.worklane.coordinator.alpha</string>',
    '<key>UserName</key><string>wl-alpha</string>',
    '<key>GroupName</key><string>wl-alpha</string>',
    '<array><string>/usr/local/bin/worklane</string><string>coordinator</string><string>run</string><string>--instance</string><string>alpha</string></array>',
    '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '<key>Umask</key><integer>7</integer>',
    '<key>Nice</key><integer>10</integer>',
    '<key>LowPriorityIO</key><true/>',
    '<key>ProcessType</key><string>Standard</string>',
    '<key>TMPDIR</key><string>/var/tmp/worklane/alpha</string>',
    '<dict><key>NumberOfProcesses</key><integer>2048</integer><key>NumberOfFiles</key><integer>8192</integer></dict>',
    '<key>StandardOutPath</key><string>/var/log/worklane/alpha.log</string>',
  ]) assert.ok(plist.includes(want), want);
  assert.doesNotMatch(plist, /ResidentSetSize|<string>Background<\/string>/, 'no RSS limit macOS ignores, and not pinned to efficiency cores');
  const custom = spawnSync('bash', [join(mac, 'service.sh'), 'alpha', '--nice', '5', '--max-procs', '512', '--max-files', '4096', '--low-priority-io', 'no', '--print'], { encoding: 'utf8' }).stdout;
  assert.ok(custom.includes('<key>Nice</key><integer>5</integer>') && custom.includes('<integer>512</integer>') && custom.includes('<integer>4096</integer>') && custom.includes('<key>LowPriorityIO</key><false/>'));
  for (const bad of [['--nice', '20'], ['--max-procs', '0'], ['--max-files', 'x'], ['--low-priority-io', 'maybe'], ['--bogus', '1']]) {
    assert.equal(spawnSync('bash', [join(mac, 'service.sh'), 'alpha', ...bad, '--print'], { encoding: 'utf8' }).status, 2, bad.join(' '));
  }
  const mem = spawnSync('bash', [join(mac, 'service.sh'), 'alpha', '--memory-max', '35%', '--print'], { encoding: 'utf8' });
  assert.equal(mem.status, 2);
  assert.match(mem.stderr, /macOS has no cgroups, so there's no memory cap or CPU weight/);
  assert.equal(spawnSync('bash', [join(mac, 'service.sh'), 'Bad_Name', '--print'], { encoding: 'utf8' }).status, 2);
  if (darwin) {
    const f = join(mkdtempSync(join(tmpdir(), 'plist-')), 'c.plist');
    writeFileSync(f, plist);
    const lint = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const json = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }).stdout) as Record<string, unknown>;
    assert.equal(json.UserName, 'wl-alpha');
    assert.equal(json.Umask, 7);
    assert.deepEqual(json.HardResourceLimits, { NumberOfProcesses: 2048, NumberOfFiles: 8192 });
  }
});

test('the script writes plists, sudoers and units by temp name, check, then move', () => {
  const lib = read('lib.sh');
  assert.match(lib, /tmp="\$LAUNCH_DAEMONS\/\.\$1\.plist\.tmp"/, 'a dotted name launchd never loads');
  assert.match(lib, /if ! plutil -lint -s "\$tmp"; then rm -f "\$tmp"/);
  assert.match(lib, /chown "root:\$ROOT_GROUP" "\$tmp"/);
  assert.ok(lib.indexOf('plutil -lint') < lib.indexOf('mv -f "$tmp" "$LAUNCH_DAEMONS/$label.plist"'));
  assert.match(lib, /^ROOT_GROUP=wheel$/m);
  // Sudoers through the shared install_sudoers: dotted temp, visudo -cf, then mv.
  assert.match(read('instance.sh'), /install_sudoers "worklane-\$name" "\$rules"/);
});

test('dashboards.sh on macOS: the viewer gets traverse and one read through chmod +a, and nothing else', () => {
  const d = read('dashboards.sh');
  const lib = read('lib.sh');
  assert.match(lib, /acl_traverse\(\) \{ chmod -a "group:\$1 allow search" "\$2" 2>\/dev\/null \|\| true; chmod \+a "group:\$1 allow search" "\$2"; \}/);
  assert.match(lib, /acl_read\(\) \{ chmod -a "group:\$1 allow read" "\$2" 2>\/dev\/null \|\| true; chmod \+a "group:\$1 allow read" "\$2"; \}/);
  assert.match(d, /acl_traverse "\$viewer" "\$d"/);
  assert.match(d, /acl_read "\$viewer" "\$state\/dashboard-token"/);
  assert.match(d, /refuse_if_open "\$state" "grant \$viewer any access"/);
  assert.doesNotMatch(d, /allow (read|write|list|add_file|delete)[^"]*" "\$d"/, 'no listing or writing on the way');
  for (const c of ['can\'t read $name\'s token', 'can read $name\'s state beyond its token', 'can write $name\'s state']) assert.ok(d.includes(c), c);
});

test('ACLs: traverse and read for one group, once each however often they\'re set', { skip: !darwin && 'chmod +a is macOS' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'acl-'));
  mkdirSync(join(dir, 'd'));
  writeFileSync(join(dir, 'd', 'token'), 'x');
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(join(mac, 'lib.sh'))}; for i in 1 2; do acl_traverse staff "$1/d"; acl_read staff "$1/d/token"; done; ls -lde "$1/d"; ls -le "$1/d/token"`, '_', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/group:staff allow search/g) ?? []).length, 1, r.stdout);
  assert.equal((r.stdout.match(/group:staff allow read/g) ?? []).length, 1, r.stdout);
});

test('check.sh on macOS checks what the agent must never reach', () => {
  const c = read('check.sh');
  for (const label of [
    '$coord can run as $agent',
    '$agent can\'t run anything as root',
    '$agent can\'t list $coord\'s home ($home)',
    '$agent can\'t read $name\'s $f',
    '$agent can\'t list $h',
    '$agent can\'t rename or remove what $coord owns in the checkout',
    '$agent can\'t write $p',
    '$coord can\'t run as wl-$other-agent',
    '$agent can\'t list $other\'s checkout',
    'in the sandbox, $agent reaches a proxy on localhost',
    'in the sandbox, $agent reaches nothing else',
    'sudoers file is valid',
  ]) assert.ok(c.includes(`label="${label}"`), label);
  for (const f of ['credentials.yaml', 'agent-settings.json']) assert.ok(c.includes(f), f);
});

/** The network rule check.sh uses, read from the script itself. */
const profileOf = () => /^profile='([^']+)'$/m.exec(read('check.sh'))![1]!;

test('the Seatbelt rule check.sh uses lets a command reach a local proxy and nothing else', { skip: !darwin && 'Seatbelt is macOS' }, async (t) => {
  const profile = profileOf();
  assert.equal(profile, '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))');
  const server = createServer((c) => c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((res) => {
      const p = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => res({ code, out, err }));
    });
  try {
    const local = await run(['/usr/bin/sandbox-exec', '-p', profile, '/usr/bin/curl', '-sf', '--max-time', '5', `http://127.0.0.1:${port}/`]);
    assert.equal(local.code, 0, local.err);
    assert.equal(local.out, 'ok');
    const control = await run(['/usr/bin/curl', '-sS', '--max-time', '8', '-o', '/dev/null', 'https://example.com']);
    if (control.code !== 0) return t.skip('no network here to compare against');
    const remote = await run(['/usr/bin/sandbox-exec', '-p', profile, '/usr/bin/curl', '-sS', '--max-time', '8', '-o', '/dev/null', 'https://example.com']);
    assert.notEqual(remote.code, 0, 'the sandbox let it out');
  } finally {
    server.close();
  }
});

test('the machine helper\'s setup runs on macOS: its helpers, and root\'s group wheel', () => {
  const h = readFileSync(join(setup, 'machine-helper.sh'), 'utf8');
  assert.match(h, /^if \[ "\$\(uname -s\)" = Darwin \]; then source "\$\(dirname "\$0"\)\/macos\/lib\.sh"; else source "\$\(dirname "\$0"\)\/lib\.sh"; fi$/m);
  assert.match(h, /^rootgrp="\$\(id -gn root\)"$/m);
  assert.doesNotMatch(h, /-g root\b|root:root|systemctl|getent/);
});

test('engine.sh, credentials.sh and checkout.sh run on macOS: its helpers, root\'s group, its state folder', () => {
  for (const f of ['engine.sh', 'credentials.sh', 'checkout.sh', 'machine-helper.sh']) {
    const s = readFileSync(join(setup, f), 'utf8');
    assert.match(s, /^if \[ "\$\(uname -s\)" = Darwin \]; then source "\$\(dirname "\$0"\)\/macos\/lib\.sh"; else source "\$\(dirname "\$0"\)\/lib\.sh"; fi$/m, f);
    assert.doesNotMatch(s, /\.local\/state|root:root|-g root\b/, `${f}: the state folder and root's group come from the OS`);
  }
  assert.match(readFileSync(join(setup, 'credentials.sh'), 'utf8'), /if command -v shred >\/dev\/null; then shred -u "\$src"; else rm -f "\$src"; fi/);
  assert.match(readFileSync(join(setup, 'lib.sh'), 'utf8'), /^state_root_of\(\) \{ printf '%s\/\.local\/state\/worklane\\n' "\$\(home_of "\$1"\)"; \}$/m);
  // The scripts that use systemd stay Linux-only: they stop on macOS before anything changes.
  for (const f of ['service.sh', 'dashboards.sh', 'updates.sh', 'instance.sh', 'machine.sh', 'journal.sh']) {
    assert.doesNotMatch(readFileSync(join(setup, f), 'utf8'), /macos\/lib\.sh/, `${f} has a macOS counterpart or none`);
  }
});

test('the macOS helpers replace what ../lib.sh does only on Linux: as_root\'s check and getent', { skip: !posix && 'bash' }, () => {
  const stubs = { uname: 'echo Darwin', id: 'case "$1" in -u) echo 0 ;; *) exit 1 ;; esac', dscl: dscl('', ''), getent: 'echo "getent was used" >&2; exit 2' };
  const r = libWith(stubs, 'as_root; echo reached; home_of user; checkouts_root /nonexistent/machine.json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['reached', '/Users/user', '/var/worklane']);
  assert.ok(!r.calls.some((c) => c.startsWith('getent')), 'no getent on macOS');
  // ../lib.sh alone stops on macOS before anything changes: why the macOS scripts have their own entry points.
  const linux = spawnSync('bash', ['-c', `source ${JSON.stringify(join(setup, 'lib.sh'))}; as_root; echo reached`], { encoding: 'utf8', env: { ...process.env, PATH: `${mkStubs({ uname: 'echo Darwin' })}:${process.env.PATH}` } });
  assert.notEqual(linux.status, 0);
  assert.match(linux.stderr, /On macOS use the scripts in scripts\/setup\/macos\//);
  const f = join(mkdtempSync(join(tmpdir(), 'mj-')), 'machine.json');
  writeFileSync(f, '{"max_cap":8,"checkouts":"/Volumes/Work/wl"}\n');
  assert.equal(libWith(stubs, `checkouts_root ${JSON.stringify(f)}`).stdout.trim(), '/Volumes/Work/wl');
});

test('machine.sh on macOS: checkouts outside the read-only system volume, the cap root-owned, the sandbox checked', () => {
  const m = read('machine.sh');
  assert.match(read('lib.sh'), /^CHECKOUTS_DEFAULT=\/var\/worklane$/m);
  // The same machine.json as ../machine.sh writes, which the shared helpers read.
  const linux = readFileSync(join(setup, 'machine.sh'), 'utf8');
  const record = `printf '{"max_cap":%s,"checkouts":"%s"}\\n' "$max" "$checkouts" > "$tmp"`;
  assert.ok(m.includes(record) && linux.includes(record), 'the same record on both');
  assert.match(m, /chown "root:\$ROOT_GROUP" "\$tmp"/);
  assert.match(m, /chown "root:\$ROOT_GROUP" \/etc\/worklane\/slots\.json/);
  assert.match(m, /chmod 0644 \/etc\/worklane\/slots\.json/);
  assert.match(m, /install -d -o root -g agent-slots -m 2770 \/var\/lib\/worklane\/agent-slots/);
  assert.match(m, /\/usr\/bin\/sandbox-exec -p '\(version 1\)\(allow default\)\(deny network-outbound\)' \/usr\/bin\/true/);
});

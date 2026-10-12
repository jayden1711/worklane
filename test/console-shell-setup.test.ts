import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSOLE_SHELL } from '../src/console/terminal.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');
const sudoers = (...a: string[]) => spawnSync('bash', ['-c', 'source "$1"; shift; console_sudoers "$@"', '_', join(setup, 'lib.sh'), ...a], { encoding: 'utf8' });

test('the console sudoers rule: the viewer may run exactly the console shell check and shell, as the admin, never root', { skip: !posix && 'bash' }, () => {
  const r = sudoers('wl-dash', 'adminx');
  assert.equal(r.status, 0, r.stderr);
  const rules = r.stdout.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(rules, [`wl-dash ALL=(adminx) NOPASSWD: ${CONSOLE_SHELL} check, ${CONSOLE_SHELL} shell`]);
  for (const bad of [['wl-dash', 'root'], ['wl-dash', 'wl-dash'], ['adminx', 'adminx'], ['wl-dash', 'ALL'], ['wl-dash', 'a b'], ['wl-dash']]) assert.notEqual(sudoers(...bad).status, 0, JSON.stringify(bad));
  if (spawnSync('visudo', ['--version']).status === 0) {
    const f = join(mkdtempSync(join(tmpdir(), 'sudoers-')), 'rule');
    writeFileSync(f, r.stdout);
    assert.equal(spawnSync('visudo', ['-cf', f]).status, 0, 'visudo accepts it');
  }
});

test('console-shell.sh: refuses a NOPASSWD admin, installs the shell root-owned and the rule through visudo -cf, then checks', () => {
  const sh = readFileSync(join(setup, 'console-shell.sh'), 'utf8');
  assert.match(sh, /NOPASSWD'; then\n\s+echo "refusing/);
  assert.match(sh, /install -o root -g root -m 0755 "\$src" "\$tmp"\nbash -n "\$tmp"/);
  assert.match(sh, /install_sudoers worklane-console "\$\(console_sudoers "\$viewer" "\$admin"\)"/);
  assert.match(sh, /\[ "\$admin" != root \]/);
  assert.match(sh, /FAIL: \$viewer may run bash as \$admin/);
  assert.match(sh, /FAIL: \$viewer may run the console shell as root/);
  const lib = readFileSync(join(setup, 'lib.sh'), 'utf8');
  assert.match(lib, /tmp="\/etc\/sudoers\.d\/\.\$1\.tmp"[\s\S]*visudo -cf "\$tmp"[\s\S]*mv -f "\$tmp"/, 'a dotted temp name, validated, then moved');
  assert.match(lib, new RegExp(`^CONSOLE_SHELL=${CONSOLE_SHELL.replace(/[/.]/g, '\\$&')}$`, 'm'), 'the scripts and the engine name the same shell');
});

test('dashboards.sh: the hub gets --console-user only when set, and only then drops its sandbox', () => {
  const sh = readFileSync(join(setup, 'dashboards.sh'), 'utf8');
  // Each flag exactly once, at the end of the line.
  assert.match(sh, /ExecStart=\/usr\/local\/bin\/worklane dashboard --hub \$hub_arg --service .*\$\{console_user:\+ --console-user \$console_user\}\$\{console_devices:\+ --console-devices \$console_devices\}\n/);
  assert.equal((sh.match(/--console-devices \$console_devices/g) ?? []).length, 1);
  assert.match(sh, /if \[ -n "\$console_user" \]; then\n\s+echo "NoNewPrivileges=no"\n\s+return\n\s+fi\n\s+cat <<EOF\nNoNewPrivileges=yes/);
  assert.match(sh, /"\$console_user" != root && "\$console_user" != wl-\*/);
});

test('the console shell: check says whether sudo -n true succeeds; shell refuses then, else forgets sudo credentials first', { skip: !posix && 'bash' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'console-shell-'));
  const log = join(dir, 'sudo.log');
  const fake = join(dir, 'sudo');
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = -n ] && exit "\${FAKE_SUDO_N:-1}"\nexit 0\n`);
  chmodSync(fake, 0o755);
  // The real shell pins PATH; the copy puts the fake sudo first.
  const src = readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-console-shell.sh'), 'utf8');
  assert.match(src, /^export PATH=\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  const shell = join(dir, 'console-shell');
  writeFileSync(shell, src.replace(/^export PATH=.*$/m, `export PATH=${dir}:/usr/bin:/bin`));
  const run = (arg: string, n: string) => spawnSync('bash', [shell, arg], { encoding: 'utf8', input: '', env: { HOME: dir, FAKE_SUDO_N: n } });
  assert.deepEqual([run('check', '0').status, run('check', '0').stdout.trim()], [3, 'passwordless']);
  assert.deepEqual([run('check', '1').status, run('check', '1').stdout.trim()], [0, 'password-required']);
  writeFileSync(log, '');
  const refused = run('shell', '0');
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /would be root without a password/);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /^-k$/m, 'no shell started');
  writeFileSync(log, '');
  // The login shell starts, reads the empty input and ends (its status is the profile's business).
  const ok = run('shell', '1');
  assert.notEqual(ok.status, 3, ok.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['-n true', '-k'], 'checked, then sudo -k, before the login shell');
  assert.equal(run('anything', '1').status, 2);
});

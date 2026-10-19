// #742: doctor's rerun command for an install that had the owner terminal is built from the installed hub unit's own
// ExecStart, so that pasting it keeps every setting the hub has: its machine devices (an older --console-devices
// list too), its sign-in App and URL, its Siri and hooks gateways, its instances. A unit it can't read exactly gives
// no command at all: doctor still fails, with the placeholder version and why. The command is pasted into bash and
// runs the real dashboards.sh in a temporary root (test/dashboards-root.ts: stand-ins for systemd, sudo and setfacl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_TERMINAL_RERUN } from '../src/console/owner-terminal-removed.js';
import { ownerTerminalCheck } from '../src/doctor.js';
import { machine } from './dashboards-root.js';

const posix = process.platform !== 'win32';
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const RERUN = '/opt/worklane/current/scripts/setup/dashboards.sh';
const SIGNIN = '--client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x';
/** A hub unit as dashboards.sh writes it, with this ExecStart tail after --hub. */
const unit = (hub: string, rest: string) => `[Unit]\nDescription=hub\n\n[Service]\nUser=wl-dash\nExecStart=/usr/local/bin/worklane dashboard --hub ${hub} --service ${rest}\nNoNewPrivileges=no\n`;
/** As main's dashboards.sh:243 wrote it with --siri, --hooks, --console-user and --console-devices. */
const SIRI_HOOKS_UNIT = unit('alpha=/s', `${SIGNIN} --siri-port 4397 --hooks-port 4396 --console-user admin --console-devices tag:owner-laptop,box`);

/** doctor's check on a temporary machine with this unit (root's here: the test's own uid) and the console shell. */
function doctorOn(text: string | null, o: { mode?: number; shell?: boolean; rootUid?: number } = {}) {
  const m = machine();
  if (text !== null) {
    writeFileSync(m.paths.unit, text);
    chmodSync(m.paths.unit, o.mode ?? 0o644);
  }
  if (o.shell ?? true) writeFileSync(m.paths.shell, '#!/bin/bash\nexit 3\n', { mode: 0o755 });
  // A variable, not a literal: the same call compiles against an engine without rootUid (the fail-without run).
  const paths = { hubUnitFile: m.paths.unit, consoleShell: m.paths.shell, rootUid: o.rootUid ?? uid };
  const check = ownerTerminalCheck(paths);
  const first = check?.detail.split('\n')[0] ?? '';
  return { m, check, first, command: first.slice(first.indexOf('sudo bash ')) };
}

test('doctor: a hub with Siri, hooks and the old --console-devices gets the exact rerun that keeps them, every value quoted', () => {
  const { check, command } = doctorOn(SIRI_HOOKS_UNIT);
  assert.equal(check?.level, 'fail');
  assert.equal(command, `sudo bash ${RERUN} --machine-devices 'tag:owner-laptop,box' --client-id 'Iv1.signin0001' --public-url 'https://hub.example.test' --siri --hooks -- 'alpha'`);
  // Several instances, in the hub's order.
  assert.equal(doctorOn(unit('alpha=/s,beta-2=/t', `${SIGNIN} --siri-port 4397 --console-user admin --console-devices box`)).command, `sudo bash ${RERUN} --machine-devices 'box' --client-id 'Iv1.signin0001' --public-url 'https://hub.example.test' --siri -- 'alpha' 'beta-2'`);
});

test('doctor: a hub without Siri or hooks gets no --siri or --hooks; a device list under either name; none when it has none', () => {
  // The old name, read as the machine devices, with no device added.
  assert.equal(doctorOn(unit('alpha=/s', `${SIGNIN} --console-user admin --console-devices tag:owner-laptop,box`)).command, `sudo bash ${RERUN} --machine-devices 'tag:owner-laptop,box' --client-id 'Iv1.signin0001' --public-url 'https://hub.example.test' -- 'alpha'`);
  // A unit already rewritten (only the console shell left): its --machine-devices.
  assert.equal(doctorOn(unit('alpha=/s', `${SIGNIN} --machine-devices box`)).command, `sudo bash ${RERUN} --machine-devices 'box' --client-id 'Iv1.signin0001' --public-url 'https://hub.example.test' -- 'alpha'`);
  // Both names: the hub reads --machine-devices alone (never merged), and so does the command.
  assert.equal(doctorOn(unit('alpha=/s', `${SIGNIN} --console-devices tag:owner-laptop,box --machine-devices box`)).command, `sudo bash ${RERUN} --machine-devices 'box' --client-id 'Iv1.signin0001' --public-url 'https://hub.example.test' -- 'alpha'`);
  // No devices (every device refused, as now) and no instance yet.
  assert.equal(doctorOn(unit('-', `${SIGNIN} --console-user admin`)).command, `sudo bash ${RERUN} --client-id 'Iv1.signin0001' --public-url 'https://hub.example.test' --no-instances`);
});

test("doctor: a hub unit it can't read or parse exactly gives no command, only the placeholder version and why, and still fails", { skip: !posix && 'POSIX file modes' }, () => {
  const cases: [string, ReturnType<typeof doctorOn>, RegExp][] = [
    ['missing', doctorOn(null), /there is no hub unit/],
    ["not root's", doctorOn(SIRI_HOOKS_UNIT, { rootUid: uid + 1 }), /isn't root's alone \(owner uid \d+, mode 0644\)/],
    ['group-writable', doctorOn(SIRI_HOOKS_UNIT, { mode: 0o664 }), /isn't root's alone .*mode 0664/],
    ['an option dashboards.sh never writes', doctorOn(unit('alpha=/s', `${SIGNIN} --siri-port 4397 --console-user admin --extra on`)), /has --extra, which dashboards\.sh doesn't write/],
    ['an expansion', doctorOn(unit('alpha=/s', `${SIGNIN} --console-user admin --console-devices $(id)`)), /quotes, escapes, expansions/],
    ['a quoted word', doctorOn(unit('alpha=/s', `${SIGNIN} --console-user "a b"`)), /quotes, escapes, expansions/],
    ['another Siri port', doctorOn(unit('alpha=/s', `${SIGNIN} --siri-port 5000 --console-user admin`)), /--siri-port is 5000, not the 4397/],
    ['two ExecStart lines', doctorOn(`${SIRI_HOOKS_UNIT}ExecStart=/bin/true\n`), /2 ExecStart lines/],
    ['no client id', doctorOn(unit('alpha=/s', '--public-url https://hub.example.test --console-user admin')), /lacks --hub, --service, --client-id or --public-url/],
    ['a --hub item without a state', doctorOn(unit('alpha', `${SIGNIN} --console-user admin`)), /--hub has alpha, not <name>=<state>/],
  ];
  if (uid !== 0) cases.push(['unreadable', doctorOn(SIRI_HOOKS_UNIT, { mode: 0o000 }), /can't be read here \(permission denied\)/]);
  // A symlink to a well-formed unit: refused, not followed.
  const link = doctorOn(null);
  writeFileSync(join(link.m.T, 'real.service'), SIRI_HOOKS_UNIT, { mode: 0o644 });
  symlinkSync(join(link.m.T, 'real.service'), link.m.paths.unit);
  const paths = { hubUnitFile: link.m.paths.unit, consoleShell: link.m.paths.shell, rootUid: uid };
  const viaLink = ownerTerminalCheck(paths);
  cases.push(['a symlink', { ...link, check: viaLink, first: viaLink?.detail.split('\n')[0] ?? '' }, /it is a symlink/]);
  for (const [what, { check, first }, why] of cases) {
    assert.equal(check?.level, 'fail', `${what}: doctor still fails`);
    assert.ok(first.startsWith('run as root, once, with each <...> and [...] filled in from the ExecStart of /etc/systemd/system/'), `${what}: ${first}`);
    assert.ok(first.endsWith(`): ${OWNER_TERMINAL_RERUN}`), `${what}: the placeholder version, whole`);
    assert.match(first, why, what);
    assert.doesNotMatch(check!.detail, /--client-id '|--machine-devices '/, `${what}: no part of an exact command`);
  }
});

test('the rerun doctor prints, pasted into a root shell, runs dashboards.sh with the Siri and hooks gateways and the device list kept', { skip: !posix && 'bash' }, () => {
  const { m, check, command } = doctorOn(SIRI_HOOKS_UNIT);
  writeFileSync(m.paths.sudoers, 'wl-dash ALL=(admin) NOPASSWD: /usr/local/libexec/worklane-console-shell check\n', { mode: 0o440 });
  assert.equal(check?.level, 'fail');
  const out = m.paste(command);
  assert.equal(out.status, 0, `${command}\n${out.stdout}\n${out.stderr}`);
  const execStart = readFileSync(m.paths.unit, 'utf8').split('\n').find((l) => l.startsWith('ExecStart='));
  assert.match(execStart ?? '', / --hub alpha=\S+\/instances\/alpha\/state --service /, 'its instance');
  assert.match(execStart ?? '', / --client-id Iv1\.signin0001 --public-url https:\/\/hub\.example\.test /);
  assert.match(execStart ?? '', / --siri-port 4397 --hooks-port 4396 --machine-devices tag:owner-laptop,box$/, 'the gateways and the devices kept');
  const calls = readFileSync(m.paths.calls, 'utf8');
  for (const t of ['siri-gateway-token', 'hooks-gateway-token']) {
    assert.ok(calls.includes(`setfacl -m g:wl-dash:r-- ${join(m.paths.state, t)}\n`), `the viewer still reads ${t}`);
    assert.ok(!calls.includes(`setfacl -x g:wl-dash ${join(m.paths.state, t)}`), `${t}'s read not removed`);
  }
  // And the rerun did its job: nothing of the terminal left, so doctor has nothing to say.
  const after = { hubUnitFile: m.paths.unit, consoleShell: m.paths.shell, rootUid: uid };
  assert.equal(ownerTerminalCheck(after), null);
});

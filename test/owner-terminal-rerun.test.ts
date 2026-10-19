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
import { repoRoot } from './helpers.js';

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
  // One command to run: the notice under it points at it and holds no second, placeholder one.
  const notice = check!.detail.split('\n').slice(1).join('\n');
  assert.match(notice, /run dashboards\.sh again once, with the exact command on the line above/);
  assert.ok(!notice.includes(OWNER_TERMINAL_RERUN) && !notice.includes('sudo bash'), notice);
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
    ['an option dashboards.sh never writes', doctorOn(unit('alpha=/s', `${SIGNIN} --siri-port 4397 --console-user admin --extra on`)), /has an option dashboards\.sh doesn't write/],
    ['an expansion', doctorOn(unit('alpha=/s', `${SIGNIN} --console-user admin --console-devices $(id)`)), /quotes, escapes, expansions/],
    ['a quoted word', doctorOn(unit('alpha=/s', `${SIGNIN} --console-user "a b"`)), /quotes, escapes, expansions/],
    ['another Siri port', doctorOn(unit('alpha=/s', `${SIGNIN} --siri-port 5000 --console-user admin`)), /--siri-port isn't the 4397/],
    ['two ExecStart lines', doctorOn(`${SIRI_HOOKS_UNIT}ExecStart=/bin/true\n`), /2 ExecStart lines/],
    ['no client id', doctorOn(unit('alpha=/s', '--public-url https://hub.example.test --console-user admin')), /lacks --hub, --service, --client-id or --public-url/],
    ['a --hub item without a state', doctorOn(unit('alpha', `${SIGNIN} --console-user admin`)), /--hub has an item that isn't <name>=<state>/],
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

/** What doctor may never print from a unit: a C0 control (but its own newline), DEL, a C1 control, a backtick, non-ASCII. */
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f`]|[^\u0000-\u007f]/;
/** The marker each hostile stand-in value carries, so any raw unit text reaching doctor's output is seen. */
const MARK = 'zqmark';

test("doctor: a value dashboards.sh would refuse gives only the placeholder, and doctor prints nothing of it", { skip: !posix && 'POSIX file modes' }, () => {
  // C0 controls (SOH, ENQ, ESC), DEL, a C1 control (CSI) and a right-to-left override.
  const CTL = ['\u0001', '\u0005', '\u001b', '\u007f', '\u009b', String.fromCodePoint(0x202e)];
  const ctl = (i: number) => CTL[i % CTL.length]!;
  const id = 'Iv1.signin0001';
  const url = 'https://hub.example.test';
  /** A unit with these fields (the defaults: a well-formed one, which gives the exact command). */
  const with_ = (f: { exe?: string; hub?: string; id?: string; url?: string; dir?: string; user?: string; devices?: string; machine?: string; siri?: string; extra?: string }) =>
    `[Service]\nExecStart=${f.exe ?? '/usr/local/bin/worklane'} dashboard --hub ${f.hub ?? 'alpha=/s'} --service --client-id ${f.id ?? id} --public-url ${f.url ?? url} --signin-dir ${f.dir ?? '/x'} --siri-port ${f.siri ?? '4397'} --console-user ${f.user ?? 'admin'}${f.devices ? ` --console-devices ${f.devices}` : ''}${f.machine ? ` --machine-devices ${f.machine}` : ''}${f.extra ? ` ${f.extra}` : ''}\n`;
  // The well-formed control: the exact command, so each case below differs from it only in its one field.
  assert.match(doctorOn(with_({ devices: 'box' })).first, /^run as root, once \(built from/);
  const cases: [string, string][] = [];
  // A control character (and a C1 control, and a bidi override) in each field, the reviewer's C-a/C-e one included.
  const fields = ['exe', 'hub', 'hubState', 'id', 'url', 'dir', 'user', 'devices', 'machine', 'siri', 'extra'] as const;
  fields.forEach((field, i) => {
    const c = ctl(i);
    const v: Record<(typeof fields)[number], () => string> = {
      exe: () => with_({ exe: `/usr/local/bin/${MARK}${c}` }),
      hub: () => with_({ hub: `al${c}${MARK}=/s` }),
      hubState: () => with_({ hub: `alpha=/s${c}${MARK}` }),
      id: () => with_({ id: `Iv1.${MARK}${c}01` }),
      url: () => with_({ url: `https://${MARK}${c}.example.test` }),
      dir: () => with_({ dir: `/x${c}${MARK}` }),
      user: () => with_({ user: `admin${c}${MARK}` }),
      devices: () => with_({ devices: `\u0001\`id>${MARK}\`\u0005` }),
      machine: () => with_({ machine: `box${c}${MARK}` }),
      siri: () => with_({ siri: `4397${c}${MARK}` }),
      extra: () => with_({ extra: `--${MARK}${c} on` }),
    };
    cases.push([`a control character (U+${c.codePointAt(0)!.toString(16).padStart(4, '0')}) in ${field}`, v[field]()]);
  });
  // A backtick, with no space or quote, in each printed field.
  cases.push(
    ['a backtick in --client-id', with_({ id: `Iv1.\`${MARK}\`01` })],
    ['a backtick in --console-devices', with_({ devices: `box,\`${MARK}\`` })],
    ['a backtick in --machine-devices', with_({ machine: `\`${MARK}\`` })],
    ['a backtick in an instance name', with_({ hub: `a\`${MARK}\`=/s` })],
  );
  // A URL that isn't https://[a-z0-9.-]+ (dashboards.sh url_ok), each made of characters a unit word may hold.
  for (const u of [`http://${MARK}.example.test`, `https://${MARK}.Example.test`, `https://${MARK}.example.test/path`, `https://${MARK}.example.test:443`, `https://user@${MARK}.example.test`, `https://${MARK}_x.example.test`, `ftp://${MARK}`]) cases.push([`the URL ${u}`, with_({ url: u })]);
  // A client id dashboards.sh refuses: over 64, under 8, or another character.
  cases.push(
    ['an over-long client id (65)', with_({ id: `${MARK}${'a'.repeat(65 - MARK.length)}` })],
    ['a short client id (7)', with_({ id: `${MARK}a` })],
    ['a client id with ~', with_({ id: `Iv1.${MARK}~01` })],
    ['a device list with an uppercase name', with_({ devices: `Box,${MARK}` })],
    ['a device list with /', with_({ machine: `tag:${MARK}/x` })],
    ['a reserved instance name (wl-test-<x> is a test user)', with_({ hub: `test-${MARK}=/s` })],
    ['an option that is an Object prototype key', with_({ extra: 'constructor x' })],
  );
  for (const [what, text] of cases) {
    const { check, first } = doctorOn(text);
    assert.equal(check?.level, 'fail', `${what}: doctor still fails`);
    assert.ok(first.startsWith('run as root, once, with each <...> and [...] filled in from the ExecStart of /etc/systemd/system/'), `${what}: ${JSON.stringify(first)}`);
    assert.ok(first.endsWith(`): ${OWNER_TERMINAL_RERUN}`), `${what}: the placeholder version, whole`);
    assert.doesNotMatch(check!.detail, /--client-id '|--machine-devices '|-- '/, `${what}: no part of an exact command`);
    assert.ok(!check!.detail.includes(MARK), `${what}: no unit text in doctor's output: ${JSON.stringify(check!.detail)}`);
    assert.doesNotMatch(check!.detail, UNSAFE, `${what}: no control, backtick or non-ASCII character in doctor's output`);
  }
});

test("the patterns doctor holds each printed value to are dashboards.sh's own, read from it", async () => {
  // A namespace import, so this file also compiles against an engine without them (the fail-without run).
  const mod: Record<string, unknown> = await import('../src/console/owner-terminal-removed.js');
  const p = mod.HUB_VALUE_PATTERNS as Record<'clientId' | 'publicUrl' | 'machineDevices', RegExp> | undefined;
  assert.ok(p, 'owner-terminal-removed.ts exports HUB_VALUE_PATTERNS');
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'dashboards.sh'), 'utf8');
  const src = (r: RegExp) => r.source.replaceAll('\\/', '/');
  assert.ok(sh.includes(`[[ "$client_id" =~ ${src(p.clientId)} ]]`), `dashboards.sh holds --client-id to ${src(p.clientId)}`);
  assert.ok(sh.includes(`url_ok() { [[ "$1" =~ ${src(p.publicUrl)} ]]`), `dashboards.sh holds --public-url to ${src(p.publicUrl)}`);
  assert.ok(sh.includes(`[[ "$machine_devices" =~ ${src(p.machineDevices)} ]]`), `dashboards.sh holds --machine-devices to ${src(p.machineDevices)}`);
  // Instance names: dashboards.sh refuses each with need_instance_name (lib.sh instance_name_problem), which
  // test/instance-name.test.ts holds equal to src/instance-name.ts instanceNameOk, the rule parseHubUnit uses.
  assert.match(sh, /for name in "\$@"; do\n\s+need_instance_name "\$name"/);
});

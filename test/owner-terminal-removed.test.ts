// #742: the browser owner terminal is removed, with its sudoers rule and its root console shell. What an existing
// install relies on stays: the machine devices (an older --console-devices list, read as them, never more) still gate
// machine changes from the page, and the break-glass stays. While an install still has the terminal's root files or
// a hub unit without its sandbox, the Setup page (an owner's) says so and doctor fails, with how to remove them; a
// rerun of dashboards.sh, run here in a temporary root with stand-ins for systemd, sudo and setfacl (no real sudo),
// removes them and gives the hub its sandbox back. Before that rerun, an engine update replaces the live console shell
// with a stub that refuses everything.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import * as hub from '../src/dashboard-hub.js';
import { deviceRefusal } from '../src/console/terminal-devices.js';
import { CONSOLE_SHELL, OWNER_TERMINAL_RERUN, ownerTerminalLeftovers } from '../src/console/owner-terminal-removed.js';
import { doctor } from '../src/doctor.js';
import { MACHINE_PATHS } from '../src/setup-steps.js';
import type { Role } from '../src/console/asks.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
// Fake tailnet fixtures, built here so no address or node name is spelled out (the push gate's rules).
const NET = ['tail1234', 'ts', 'net'].join('.');
const ip = (n: number) => [100, 101, 102, 100 + n].join('.');

/** A hub unit as dashboards.sh wrote it for an install with the owner terminal (before #742). */
const OLD_HUB_UNIT = `[Service]\nUser=wl-dash\nExecStart=/usr/local/bin/worklane dashboard --hub alpha=/s --service --client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x --console-user admin --console-devices tag:owner-laptop,box\nNoNewPrivileges=no\n`;

/** This test machine's own hub unit and console shell (src/os/system-paths.ts puts them under the test's root). */
function oldInstall(on: boolean) {
  for (const f of [MACHINE_PATHS.hubUnitFile, CONSOLE_SHELL]) rmSync(f, { force: true });
  if (!on) return;
  mkdirSync(dirname(MACHINE_PATHS.hubUnitFile), { recursive: true });
  writeFileSync(MACHINE_PATHS.hubUnitFile, OLD_HUB_UNIT);
  mkdirSync(dirname(CONSOLE_SHELL), { recursive: true });
  writeFileSync(CONSOLE_SHELL, '#!/bin/bash\n', { mode: 0o755 });
}

let r: { renderSetup(data: unknown): string };
before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'owner-terminal-web-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as typeof r;
});

test('removal: the hub serves no /api/terminal: no upgrade handler, and an upgrade from its own origin is never switched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-no-terminal-'));
  const h = await hub.startHub({ instances: [{ name: 'demo', port: 1, tokenFile: join(dir, 'none') }], stateDir: dir });
  try {
    assert.equal(h.server.listenerCount('upgrade'), 0, 'nothing on the hub takes a WebSocket upgrade');
    const { port } = new URL(h.url);
    const host = `127.0.0.1:${port}`;
    // What the page sent: same origin, the terminal's subprotocol. Before #742 the hub switched protocols (101) here.
    const answer = await new Promise<string>((done, fail) => {
      const q = request({ host: '127.0.0.1', port, path: '/api/terminal?instance=demo&cols=120&rows=32', headers: { host, origin: `http://${host}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-protocol': 'terminal.v1' } });
      q.on('upgrade', (_res, socket) => (socket.destroy(), done('101')));
      q.on('response', (res) => (res.resume(), done(String(res.statusCode))));
      q.on('error', fail);
      q.end();
    });
    assert.notEqual(answer, '101', 'never upgraded');
  } finally {
    await h.close();
  }
});

test('removal: the Setup page has no terminal panel: no file of the page opens a WebSocket or names /api/terminal', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(join(repoRoot, 'web', 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(files.some((f) => f.endsWith(join('pages', 'Setup.tsx'))), 'the Setup page is read');
  const hits = files.filter((f) => /\/api\/terminal|new WebSocket\(|data-testid="owner-terminal"|terminalProtocols/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
  // And the setup console an owner sees renders no terminal, with or without a notice.
  for (const notices of [undefined, [], ['x']]) {
    const html = r.renderSetup({ role: 'owner', login: 'olive', asks: [], ...(notices ? { notices } : {}) });
    assert.doesNotMatch(html, /owner-terminal|terminal-open|Owner terminal/);
  }
});

async function site(roles: Record<string, Role>) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-terminal-'));
  const { dir: root } = exampleProject();
  const d = await startDashboard({
    root,
    cfg: loadConfig(root),
    eventsDb: join(dir, 'events.db'),
    stateDir: join(dir, 'state'),
    user: 'olive',
    instance: 'demo',
    webDir: join(dir, 'web'),
    slotsDir: join(dir, 'slots'),
    machine: {},
    session: (req) => {
      const login = String(req.headers['x-login'] ?? '');
      return login ? { login, role: roles[login] ?? null, csrfOk: true } : null;
    },
  });
  const base = d.url.split('/?')[0]!;
  const asks = async (login: string) => (await (await fetch(`${base}/api/asks`, { headers: { authorization: `Bearer ${d.token}`, 'x-login': login } })).json()) as { notices?: string[] };
  return { d, asks };
}

test('deprecation: on an install with a console user, the Setup page shows its owner the notice, and doctor fails with the rerun first; none once it is gone', async () => {
  const s = await site({ olive: 'owner', wendy: 'writer' });
  const { dir: root } = exampleProject();
  try {
    oldInstall(true);
    const [notice] = (await s.asks('olive')).notices ?? [];
    assert.match(notice ?? '', /The owner terminal has been removed/);
    assert.match(notice!, /still names a console user and runs without its sandbox/);
    assert.match(notice!, /console shell .* is still installed/);
    assert.match(notice!, /run dashboards\.sh again .* --machine-devices/);
    assert.deepEqual((await s.asks('wendy')).notices ?? [], [], "a writer isn't shown the machine's root files");
    const html = r.renderSetup({ role: 'owner', login: 'olive', asks: [], notices: [notice] });
    assert.match(html, /data-testid="setup-notice"[^>]*>[\s\S]*The owner terminal has been removed/);
    // Loud: doctor fails (exit 1, src/cli.ts) while the sudoers rule may still be there, and the rerun comes first.
    const check = doctor(root).find((c) => c.name === 'owner terminal');
    assert.equal(check?.level, 'fail', 'doctor fails, not warns');
    assert.equal(check?.detail, `run as root, once: ${OWNER_TERMINAL_RERUN}\n${notice}`);
    assert.match(OWNER_TERMINAL_RERUN, /^sudo bash \/opt\/\S+\/current\/scripts\/setup\/dashboards\.sh --machine-devices /);
    // Only the unit left (the shell already removed by hand): still said, since the hub runs without its sandbox.
    rmSync(CONSOLE_SHELL);
    assert.match((await s.asks('olive')).notices?.[0] ?? '', /still names a console user/);
    oldInstall(false);
    assert.deepEqual((await s.asks('olive')).notices, []);
    assert.doesNotMatch(r.renderSetup({ role: 'owner', login: 'olive', asks: [], notices: [] }), /setup-notice/);
    assert.equal(doctor(root).find((c) => c.name === 'owner terminal'), undefined);
  } finally {
    oldInstall(false);
    await s.d.close();
  }
});

test('an existing --console-devices list still gates machine changes from the page, with no device added', () => {
  const argv = (a: string[]) => (name: string) => {
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : undefined;
  };
  // The hub's options from an older unit: its console devices are the machine devices, exactly.
  const old = ['--hub', 'alpha=/s', '--console-user', 'admin', '--console-devices', 'tag:owner-laptop,box'];
  const allow = hub.hubMachineDevices(argv(old));
  assert.deepEqual(allow, ['tag:owner-laptop', 'box']);
  assert.deepEqual(hub.hubMachineDevices(argv(['--machine-devices', 'tag:owner-laptop', '--console-devices', 'tag:owner-laptop,box'])), ['tag:owner-laptop'], 'never merged with an older list');
  assert.deepEqual(hub.hubMachineDevices(argv(['--console-user', 'admin'])), [], 'none: every device refused');
  // That list gates as before: a device on it passes, any other is refused.
  const nodes: Record<string, unknown> = { [ip(3)]: { Node: { Name: `box.${NET}.`, Tags: [] } }, [ip(4)]: { Node: { Name: `phone.${NET}.`, Tags: ['tag:owner-laptop'] } }, [ip(5)]: { Node: { Name: `someone-else.${NET}.`, Tags: ['tag:guest'] } } };
  const req = (n: number) => ({ headers: { 'x-forwarded-for': ip(n) }, socket: { remoteAddress: '127.0.0.1', remotePort: 51000, localPort: 4399 } }) as unknown as IncomingMessage;
  const check = (n: number, list: string[]) => deviceRefusal(req(n), { allow: list, whois: (a) => JSON.stringify(nodes[a]), peerUid: () => 0 }).why;
  assert.equal(check(3, allow), null, 'a listed node');
  assert.equal(check(4, allow), null, 'a listed tag');
  assert.match(check(5, allow) ?? '', /isn't one of the allowed devices/);
  assert.match(check(3, hub.hubMachineDevices(argv(['--console-user', 'admin']))) ?? '', /machine devices are empty/);
});

/**
 * dashboards.sh in a temporary root: its lib.sh sources the real one, then points the machine's paths into the root
 * and stands in for what needs root (users, ACLs, systemd, sudo). One instance, alpha, is ready for it.
 */
function machine() {
  const T = mkdtempSync(join(tmpdir(), 'dash-root-'));
  const s = join(T, 'scripts', 'setup');
  for (const d of ['scripts/setup', 'bin', 'units', 'libexec', 'sudoers.d']) mkdirSync(join(T, d), { recursive: true });
  copyFileSync(join(setupDir, 'dashboards.sh'), join(s, 'dashboards.sh'));
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
PATH="$T/bin:$PATH"
as_root() { :; }
home_of() { echo "$T/home/$1"; }
ensure_user() { echo "user $1 exists"; }
refuse_if_open() { :; }
HUB_UNIT="$T/units/worklane-dashboard-hub.service" ENGINE_CLI="$T/bin/engine-cli" MACHINE_OWNERS="$T/machine-owners.json"
CONSOLE_SHELL="$T/libexec/worklane-console-shell" CONSOLE_SUDOERS="$T/sudoers.d/worklane-console"
`,
  );
  const exe = (name: string, body: string) => {
    writeFileSync(join(T, 'bin', name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(T, 'bin', name), 0o755);
  };
  for (const c of ['systemctl', 'systemd-analyze', 'setfacl', 'engine-cli']) exe(c, `echo "${c} $*" >> ${JSON.stringify(join(T, 'calls'))}`);
  exe('id', 'echo 1000');
  // The viewer may read each token and nothing else, as the real ACLs give it.
  exe('sudo', '[ "$1" = -u ] && shift 2\ncase "$*" in "test -r "*/dashboard-token) exit 0 ;; *) exit 1 ;; esac');
  const state = join(T, 'home', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha', 'state');
  mkdirSync(state, { recursive: true });
  for (const f of ['dashboard-token', 'siri-gateway-token', 'hooks-gateway-token']) writeFileSync(join(state, f), 'x');
  const signin = join(T, 'home', 'wl-dash', '.config', 'dashboard-signin');
  const hubState = join(T, 'home', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub');
  for (const d of [signin, hubState]) mkdirSync(d, { recursive: true });
  for (const f of ['client-secret', 'session-secret']) writeFileSync(join(signin, f), 'x');
  writeFileSync(join(hubState, 'dashboard-token'), 'x');
  const paths = { unit: join(T, 'units', 'worklane-dashboard-hub.service'), shell: join(T, 'libexec', 'worklane-console-shell'), sudoers: join(T, 'sudoers.d', 'worklane-console') };
  const run = (args: string[]) => spawnSync('bash', [join(s, 'dashboards.sh'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T }, timeout: 60_000 });
  /** What lib.sh's hub_keep_args (add-project, instance-remove, instance-rename) forwards from the unit now. */
  const kept = () => spawnSync('bash', ['-c', 'source "$1"; HUB_UNIT="$2"; hub_keep_args', '_', join(setupDir, 'lib.sh'), paths.unit], { encoding: 'utf8' }).stdout.trim().split('\n');
  return { T, paths, run, kept };
}

test('a dashboards.sh rerun on an install that had a console user: the console shell and its sudoers rule are removed, and the hub unit gets NoNewPrivileges=yes, ProtectSystem=strict and ProtectHome=read-only', { skip: !posix && 'bash' }, () => {
  for (const how of ['the same command line as before', "the hub's own settings (hub_keep_args, as add-project reruns it)"]) {
    const m = machine();
    writeFileSync(m.paths.unit, OLD_HUB_UNIT);
    writeFileSync(m.paths.shell, '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(m.paths.sudoers, 'wl-dash ALL=(admin) NOPASSWD: /usr/local/libexec/worklane-console-shell check, /usr/local/libexec/worklane-console-shell shell\n', { mode: 0o440 });
    assert.equal(ownerTerminalLeftovers({ hubUnitFile: m.paths.unit, consoleShell: m.paths.shell }).length, 2, 'the notice has both to say');
    const args = how.startsWith('the same') ? ['--client-id', 'Iv1.signin0001', '--public-url', 'https://hub.example.test', '--console-user', 'admin', '--console-devices', 'tag:owner-laptop,box'] : m.kept();
    const out = m.run([...args, 'alpha']);
    assert.equal(out.status, 0, `${how}:\n${out.stdout}\n${out.stderr}`);
    const unit = readFileSync(m.paths.unit, 'utf8');
    for (const line of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=yes']) assert.match(unit, new RegExp(`^${line}$`, 'm'), `${how}: ${line}`);
    assert.doesNotMatch(unit, /NoNewPrivileges=no|--console-user|--console-devices/, how);
    assert.match(unit, /^ExecStart=.* --machine-devices tag:owner-laptop,box$/m, `${how}: the same devices, none added`);
    assert.equal(existsSync(m.paths.sudoers), false, `${how}: no console sudoers file`);
    assert.equal(existsSync(m.paths.shell), false, `${how}: no console shell`);
    assert.match(out.stdout, /removed .*worklane-console\b/);
    assert.deepEqual(ownerTerminalLeftovers({ hubUnitFile: m.paths.unit, consoleShell: m.paths.shell }), [], `${how}: nothing left for the notice`);
    // Its next rerun, through the forwarders, keeps the same devices and the sandbox.
    assert.deepEqual(m.kept(), ['--client-id', 'Iv1.signin0001', '--public-url', 'https://hub.example.test', '--machine-devices', 'tag:owner-laptop,box']);
    const again = m.run([...m.kept(), 'alpha']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(m.paths.unit, 'utf8'), unit, 'the same unit again');
  }
  // --console-user alone is accepted and ignored: it turns nothing on.
  // (The stub an engine update leaves in the console shell's place is deleted the same way: the next test.)
  const m = machine();
  const out = m.run(['--client-id', 'Iv1.signin0001', '--public-url', 'https://hub.example.test', '--console-user', 'admin', 'alpha']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /--console-user is ignored: the owner terminal is removed/);
  assert.match(readFileSync(m.paths.unit, 'utf8'), /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(readFileSync(m.paths.unit, 'utf8'), /--console-user|--machine-devices/);
});

type Helper = { dest: string; src: string; check: 'bash' | 'node' };
/**
 * The console shell's entry in HELPERS as v0.5.0 to v0.5.2's updater has it (worklane-update.cjs before #742). That
 * installed updater, not this engine's, runs the first upgrade to this engine: the updater never updates itself.
 */
const OLD_UPDATER_ENTRY: Helper = { dest: '/usr/local/libexec/worklane-console-shell', src: 'scripts/machine/worklane-console-shell.sh', check: 'bash' };
/** The live console shell's behaviour, as console-shell.sh installed it: `check` says password-required when sudo asks. */
const OLD_SHELL = '#!/bin/bash\ncase "${1:-}" in\n  check) if sudo -n true; then echo passwordless; exit 3; fi; echo password-required ;;\n  shell) sudo -k; exec /bin/bash --login -i ;;\n  *) exit 2 ;;\nesac\n';

test('upgrade: the updater replaces a live console shell with a stub that refuses every subcommand, with no root step; a dashboards.sh rerun still deletes it and its sudoers rule, and no update puts it back', { skip: !posix && 'bash' }, () => {
  const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as { syncHelpers(engineDir: string, helpers: Helper[]): { path: string; state: string }[]; HELPERS: Helper[] };
  const m = machine();
  writeFileSync(m.paths.unit, OLD_HUB_UNIT);
  writeFileSync(m.paths.shell, OLD_SHELL);
  chmodSync(m.paths.shell, 0o755);
  writeFileSync(m.paths.sudoers, 'wl-dash ALL=(admin) NOPASSWD: /usr/local/libexec/worklane-console-shell check, /usr/local/libexec/worklane-console-shell shell\n', { mode: 0o440 });
  const before = statSync(m.paths.shell);
  // The old updater's step: its own entry, with this engine as the new tree (/opt/<cli>/<sha> is a clone of this
  // checkout), and syncHelpers as #742 leaves it (only HELPERS changes in that file). Only the destination is moved
  // into the temporary root.
  const sync = (entry: Helper) => updater.syncHelpers(repoRoot, [{ ...entry, dest: m.paths.shell }]);
  assert.deepEqual(sync(OLD_UPDATER_ENTRY), [{ path: m.paths.shell, state: 'updated' }], 'the old updater replaces it');
  const after = statSync(m.paths.shell);
  assert.equal(readFileSync(m.paths.shell, 'utf8'), readFileSync(join(repoRoot, OLD_UPDATER_ENTRY.src), 'utf8'), 'with the stub');
  assert.equal(after.mode & 0o7777, 0o755, "the installed file's mode");
  assert.deepEqual([after.uid, after.gid], [before.uid, before.gid], "the installed file's owner");
  // This engine's updater keeps the same entry, so the stub stays in step whichever updater runs.
  assert.deepEqual(updater.HELPERS.find((h) => h.src === OLD_UPDATER_ENTRY.src), OLD_UPDATER_ENTRY);
  assert.deepEqual(sync(OLD_UPDATER_ENTRY), [{ path: m.paths.shell, state: 'same' }]);

  // The stub, run as the sudoers rule allowed (and with anything else): refused, nothing on stdout (the old hub opened
  // its terminal only on "password-required"), the rerun named, and nothing run: a stand-in sudo and bash log any call.
  const bin = join(m.T, 'stub-bin');
  const log = join(m.T, 'stub-calls');
  mkdirSync(bin);
  for (const c of ['sudo', 'bash', 'id']) {
    writeFileSync(join(bin, c), `#!/bin/sh\necho "${c} $*" >> ${JSON.stringify(log)}\nexit 1\n`);
    chmodSync(join(bin, c), 0o755);
  }
  for (const args of [['check'], ['shell'], [], ['--help'], ['check', 'extra'], ['shell', '-c', 'id']]) {
    const r = spawnSync(m.paths.shell, args, { encoding: 'utf8', input: 'id\n', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: m.T }, timeout: 10_000 });
    assert.equal(r.status, 3, `${args.join(' ') || '(none)'}: refused`);
    assert.equal(r.stdout, '', `${args.join(' ') || '(none)'}: nothing on stdout`);
    assert.match(r.stderr, /^refusing: the owner terminal is removed .*rerun dashboards\.sh .*sudo bash \/opt\/\S+\/current\/scripts\/setup\/dashboards\.sh --machine-devices /);
  }
  assert.equal(existsSync(log), false, 'the stub runs nothing');

  // The rerun deletes the stub and the sudoers rule, as it deleted the live shell; no updater installs it again.
  const out = m.run(['--client-id', 'Iv1.signin0001', '--public-url', 'https://hub.example.test', '--console-user', 'admin', '--console-devices', 'tag:owner-laptop,box', 'alpha']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(existsSync(m.paths.shell), false, 'no stub');
  assert.equal(existsSync(m.paths.sudoers), false, 'no console sudoers file');
  assert.deepEqual(sync(OLD_UPDATER_ENTRY), [{ path: m.paths.shell, state: 'absent' }], 'an absent helper is never installed');
  assert.equal(existsSync(m.paths.shell), false);
  assert.deepEqual(ownerTerminalLeftovers({ hubUnitFile: m.paths.unit, consoleShell: m.paths.shell }), []);
});

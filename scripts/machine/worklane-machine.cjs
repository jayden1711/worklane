#!/usr/bin/env node
// The one root-owned way to change machine-wide settings from an instance, installed as
// /usr/local/libexec/worklane-machine by scripts/setup/machine-helper.sh. sudoers lets each
// coordinator user run exactly these, and nothing else:
//
//   worklane-machine set-slots <1..16>     the machine's agent slot cap (slots.json max_agents)
//   worklane-machine set-updates on|off    automatic engine updates (updates.json enabled)
//
// Each change is written atomically (a temp file in the same directory, then a rename), appended
// as one JSON line to the machine change log (who, what, from, to, when; nothing secret), and
// logged to the journal. Any other argument list is refused before anything is read or written.
//
// Setup commands, for onboarding a project (`worklane add`, the dashboard's Add project): each runs
// one existing setup script (root-owned copies in /usr/local/libexec/worklane-setup, put there by
// machine-helper.sh) or one fixed command, with every argument checked here against its exact shape.
// A secret comes on stdin, never as an argument, and goes only to the script. sudoers lets only the
// setup user named with `machine-helper.sh --setup-user <user>` run them; no coordinator ever can.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Fixed paths: the installed helper takes none from its caller (environment or arguments).
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';
const SETUP = '/usr/local/libexec/worklane-setup';
const CLI = '/usr/local/bin/worklane';
const CLAUDE = '/usr/local/bin/claude';
const TAILSCALE = '/usr/bin/tailscale';
const TLS = '/var/lib/worklane/tls';
const SRV = '/srv/worklane';
// The dashboard hub's loopback port (src/dashboard-hub.ts HUB_PORT): what tailscale serve exposes.
const HUB_PORT = 4399;
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const USAGE = 'usage: worklane-machine set-slots <1..16> | set-updates on|off | <setup command> <args> (the list is in the helper\'s source)';

/** The change an argument list asks for, or null when it is anything but the exact allowed forms. */
function parse(args) {
  if (args.length !== 2) return null;
  const [cmd, arg] = args;
  if (cmd === 'set-slots' && /^([1-9]|1[0-6])$/.test(arg)) return { what: 'slots.max_agents', file: 'slots.json', key: 'max_agents', value: Number(arg) };
  if (cmd === 'set-updates' && (arg === 'on' || arg === 'off')) return { what: 'updates.enabled', file: 'updates.json', key: 'enabled', value: arg === 'on' };
  return null;
}

// Each setup argument's exact shape.
const NAME = (s) => /^[a-z][a-z0-9-]{0,20}$/.test(s) && s !== 'dash' && !/-(agent|eval|work)$/.test(s);
const REPO = (s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(s) && !s.includes('..');
const ID = (s) => /^[1-9][0-9]{0,11}$/.test(s);
const REF = (s) => /^[0-9a-f]{40}$/.test(s);
const LOGIN = (s) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s);
const USD = (s) => /^[1-9][0-9]{0,3}$/.test(s) && Number(s) <= 1000;
const MODE = (s) => s === 'per-repo' || s === 'shared';

const script = (file, ...args) => ['bash', [path.join(SETUP, file), ...args]];
const asUser = (user, ...cmd) => ['runuser', ['-u', user, '--', ...cmd]];

/**
 * The setup commands: their arguments' checks (`rest`: more of one kind, up to 19) and what runs.
 * `stdin`: the command reads one secret on stdin.
 */
const SETUP_COMMANDS = {
  'setup-machine': { args: [], run: () => script('machine.sh') },
  'add-instance': { args: [NAME], run: ([n]) => script('instance.sh', n) },
  'install-engine': { args: [REF, NAME, REPO], run: ([ref, n, r]) => script('engine.sh', ref, n, r) },
  'install-app-key': { args: [NAME, ID, ID, REPO, MODE], stdin: true, run: ([n, app, inst, r, mode]) => script('credentials.sh', n, 'github-app', app, inst, '-', r, ...(mode === 'shared' ? ['--shared'] : [])) },
  checkout: { args: [NAME, REPO], run: ([n, r]) => script('checkout.sh', n, r) },
  'install-service': { args: [NAME], run: ([n]) => script('service.sh', n) },
  'install-dashboards': { args: [LOGIN, NAME], rest: NAME, run: ([login, ...names]) => script('dashboards.sh', login, ...names) },
  'install-claude-key': { args: [NAME], stdin: true, run: ([n]) => script('credentials.sh', n, 'claude-key') },
  'install-discord-token': { args: [NAME], stdin: true, run: ([n]) => script('credentials.sh', n, 'intake-discord') },
  'set-budget': { args: [NAME, USD], run: ([n, usd]) => asUser(`wl-${n}`, CLI, 'instance', 'set-budget', n, usd) },
  'claude-status': { args: [NAME], run: ([n]) => asUser(`wl-${n}-agent`, CLAUDE, 'auth', 'status', '--json') },
  'instance-doctor': { args: [NAME, REPO], run: ([n, r]) => asUser(`wl-${n}`, CLI, 'doctor', '--json', '--instance', n, '--root', `${SRV}/${n}/${r.split('/')[1]}`) },
  'tailscale-serve': { args: [], run: () => null },
};

/** A setup command and what it runs, or null when the argument list is anything but its exact form. */
function parseSetup(args) {
  const [cmd, ...rest] = args;
  if (typeof cmd !== 'string' || !Object.prototype.hasOwnProperty.call(SETUP_COMMANDS, cmd)) return null;
  const c = SETUP_COMMANDS[cmd];
  const fits = c.rest ? rest.length >= c.args.length && rest.length <= c.args.length + 19 : rest.length === c.args.length;
  if (!fits) return null;
  for (let i = 0; i < rest.length; i++) {
    const check = c.args[i] || c.rest;
    if (typeof rest[i] !== 'string' || !check(rest[i])) return null;
  }
  if (c.rest && new Set(rest.slice(1)).size !== rest.length - 1) return null;
  return { cmd, args: rest, stdin: Boolean(c.stdin), run: c.run(rest) };
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function logLine(what, from, to) {
  const by = process.env.SUDO_USER || 'root';
  const line = { at: new Date().toISOString(), by, what, from, to };
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(line)}\n`, { mode: 0o644 });
  try {
    execFileSync('logger', ['-t', 'worklane-machine', `${by} set ${what} from ${JSON.stringify(from)} to ${JSON.stringify(to)}`], { stdio: 'ignore' });
  } catch {
    // no journal here (a test, or a machine without logger): the change log still has it
  }
  return by;
}

/** tailscale cert for this node's own name (into a root-only directory), then serve the hub over HTTPS on the tailnet. */
function tailscaleServe() {
  const env = { PATH: PATH_ENV };
  const status = JSON.parse(execFileSync(TAILSCALE, ['status', '--json'], { encoding: 'utf8', env }));
  const host = String((status.Self && status.Self.DNSName) || '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error(`tailscale gave no usable name for this node (${JSON.stringify(host)}); is it logged in?`);
  fs.mkdirSync(TLS, { recursive: true, mode: 0o700 });
  fs.chmodSync(TLS, 0o700);
  execFileSync(TAILSCALE, ['cert', '--cert-file', path.join(TLS, `${host}.crt`), '--key-file', path.join(TLS, `${host}.key`), host], { stdio: 'inherit', env });
  execFileSync(TAILSCALE, ['serve', '--bg', '--https=443', `http://127.0.0.1:${HUB_PORT}`], { stdio: 'inherit', env });
  return host;
}

/** Run one setup command. Its arguments (never a secret) are logged; a secret on stdin goes only to the script. */
function runSetup(s) {
  if (s.cmd === 'tailscale-serve') {
    const host = tailscaleServe();
    logLine('setup.tailscale-serve', null, host);
    process.stdout.write(`https://${host}/ serves the dashboard hub (127.0.0.1:${HUB_PORT}) on the tailnet\n`);
    return 0;
  }
  let input;
  if (s.stdin) {
    input = fs.readFileSync(0);
    if (!input.length || input.length > 16384) {
      process.stderr.write(`${s.cmd} reads one secret on stdin (at most 16 KiB); got ${input.length} bytes\n`);
      return 2;
    }
  }
  const [file, args] = s.run;
  const r = spawnSync(file, args, { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' }, stdio: [s.stdin ? 'pipe' : 'ignore', 'inherit', 'inherit'], ...(input ? { input } : {}) });
  logLine(`setup.${s.cmd}`, null, s.args.join(' '));
  if (r.error) {
    process.stderr.write(`${s.cmd}: ${r.error.message}\n`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

function main(args) {
  const setup = parseSetup(args);
  if (setup) return runSetup(setup);
  const change = parse(args);
  if (!change) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const file = path.join(ETC, change.file);
  const current = readJson(file);
  const from = current[change.key] === undefined ? null : current[change.key];
  const next = { ...current, [change.key]: change.value };
  const tmp = path.join(ETC, `.${change.file}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
  logLine(change.what, from, change.value);
  process.stdout.write(`${change.what}: ${JSON.stringify(from)} -> ${JSON.stringify(change.value)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, parseSetup, SETUP_COMMANDS: Object.keys(SETUP_COMMANDS), HUB_PORT };

#!/usr/bin/env node
// The one root-owned way to change machine-wide settings from an instance, installed as
// /usr/local/libexec/worklane-machine by scripts/setup/machine-helper.sh. sudoers lets each
// coordinator user run exactly these, and nothing else:
//
//   worklane-machine set-slots <1..16>     the machine's agent slot cap (slots.json max_agents)
//   worklane-machine set-updates on|off    automatic engine updates (updates.json enabled)
//   worklane-machine set-test-slots <1..8> how many test runs go at once (slots.json max_test_runs)
//
// Each change is written atomically (a temp file in the same directory, then a rename), appended
// as one JSON line to the machine change log (who, what, from, to, when; nothing secret), and
// logged to the journal. Any other argument list is refused before anything is read or written.
//
//   worklane-machine add-project <name> <owner/repo>
//
// runs the installed engine's scripts/setup/add-project.sh as root with exactly those two arguments, once each is
// checked here against its exact shape (an instance name; a GitHub owner/name), and only when the script and every
// directory above it are root's and nobody else may write them. Its stdin (the agent's Claude token, which the
// script asks for) and its output (one JSON line per step) pass straight through; the change log gets the name and
// the repo, never what came on stdin.
//
//   worklane-machine claude-account status
//   worklane-machine claude-account switch
//
// run the installed engine's scripts/setup/claude-account.sh, under the same root-owned check. status runs it here
// (`status --json`: each agent user's account and expiry, written to /var/lib/worklane/claude-account/status.json).
// switch starts it as its own transient unit, worklane-claude-account.service, outside the asking coordinator's
// cgroup, because the switch stops every coordinator, that one included; it takes the token from the asking
// instance's dashboard (--token-from <the instance whose coordinator asked>: from SUDO_USER, never an argument). An
// admin switches from a terminal with claude-account.sh itself.
//
//   worklane-machine tailscale install
//   worklane-machine tailscale up
//   worklane-machine tailscale serve
//   worklane-machine tailscale public-url
//
// start the installed engine's scripts/setup/tailscale.sh with that one word, under the same root-owned check, as a
// transient unit of its own (worklane-tailscale.service: one at a time; an install or a login outlasts the asking
// coordinator's 30 seconds). Exactly these four lists and nothing after them: no auth key, no flag, no URL, no port.
// What each does is fixed in that script: install is Tailscale's signed apt repository, with its signing key and the
// version pinned there; up is `tailscale up` with no auth key, its login link going only to a file the asking
// coordinator's user alone reads (--for <the instance whose coordinator asked>: from SUDO_USER, never an argument);
// serve forwards https 443 to the hub's sign-in port and nothing else; public-url sets the hub's URL to this
// machine's own tailnet name through dashboards.sh. An admin runs tailscale.sh from a terminal instead.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Fixed paths: the installed helper takes none from its caller (environment or arguments).
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';
const ADD_PROJECT = '/opt/worklane/current/scripts/setup/add-project.sh';
const CLAUDE_ACCOUNT = '/opt/worklane/current/scripts/setup/claude-account.sh';
const CLAUDE_ACCOUNT_UNIT = 'worklane-claude-account';
const TAILSCALE = '/opt/worklane/current/scripts/setup/tailscale.sh';
const TAILSCALE_UNIT = 'worklane-tailscale';
const TAILSCALE_ACTIONS = ['install', 'up', 'serve', 'public-url'];
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const USAGE = 'usage: worklane-machine set-slots <1..16> | set-updates on|off | set-test-slots <1..8> | add-project <name> <owner/repo> | claude-account status|switch | tailscale install|up|serve|public-url';

/** An instance name: instance.sh's shape, never the viewer's (dash) or one whose users are another instance's. */
const instanceName = (s) => typeof s === 'string' && /^[a-z][a-z0-9-]{0,20}$/.test(s) && s !== 'dash' && !/-(agent|eval|work)$/.test(s);
/** A GitHub repo, owner/name: the owner a GitHub login (letters, digits, single inner dashes, at most 39), the name letters, digits, ., _ and -. */
const githubRepo = (s) => {
  if (typeof s !== 'string') return false;
  const m = /^([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(s);
  return !!m && m[1].length <= 39 && m[2] !== '.' && m[2] !== '..';
};

/** The add-project a list asks for, or null when it is anything but `add-project <name> <owner/repo>`. */
function parseAddProject(args) {
  if (args.length !== 3 || args[0] !== 'add-project' || !instanceName(args[1]) || !githubRepo(args[2])) return null;
  return { name: args[1], repo: args[2] };
}

/** Why a file can't be run as root: it, or a directory above it, isn't root's or may be written by others. Null: it can. */
function notRootOwned(file) {
  let p = file;
  for (;;) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return `${p} is missing`;
    }
    if (st.uid !== 0 || st.mode & 0o022) return `${p} isn't root's alone (owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`;
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
}

function logLine(what, from, to) {
  const by = process.env.SUDO_USER || 'root';
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), by, what, from, to })}\n`, { mode: 0o644 });
  try {
    execFileSync('logger', ['-t', 'worklane-machine', `${by} ${what}: ${JSON.stringify(to)}`], { stdio: 'ignore' });
  } catch {
    // no journal here (a test, or a machine without logger): the change log still has it
  }
  return by;
}

/** A setup script's whole path, resolved (current is a link to the engine's directory), when every part is root's alone; else null, having said why. */
function rootScript(file) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    process.stderr.write(`${file} is missing: install the engine (engine.sh) first\n`);
    return null;
  }
  const why = notRootOwned(real);
  if (why) {
    process.stderr.write(`not running ${real}: ${why}\n`);
    return null;
  }
  return real;
}

/** The claude-account action a list asks for (status or switch), or null when it is anything else. */
function parseClaudeAccount(args) {
  return args.length === 2 && args[0] === 'claude-account' && (args[1] === 'status' || args[1] === 'switch') ? args[1] : null;
}

/** The instance whose coordinator user this is (wl-<name>), or null for anyone else. */
const coordinatorInstance = (user) => {
  const m = /^wl-(.+)$/.exec(user || '');
  return m && instanceName(m[1]) ? m[1] : null;
};

function claudeAccount(action) {
  const real = rootScript(CLAUDE_ACCOUNT);
  if (!real) return 1;
  const env = { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' };
  if (action === 'status') {
    logLine('claude-account', null, 'status');
    const r = spawnSync('bash', [real, 'status', '--json'], { cwd: '/', env, stdio: 'inherit' });
    return r.error ? 1 : r.status === null ? 1 : r.status;
  }
  // switch: for the asking coordinator's dashboard, in a unit of its own (it stops that coordinator too).
  const instance = coordinatorInstance(process.env.SUDO_USER);
  if (!instance) {
    process.stderr.write('claude-account switch here is for a coordinator, through sudo; an admin runs scripts/setup/claude-account.sh switch\n');
    return 2;
  }
  logLine('claude-account', null, `switch (token from ${instance}'s dashboard)`);
  const r = spawnSync('systemd-run', ['--unit', CLAUDE_ACCOUNT_UNIT, '--collect', '--no-block', '--quiet', '--description', 'worklane Claude account switch', '--property', `Environment=PATH=${PATH_ENV} LANG=C.UTF-8`, '/bin/bash', real, 'switch', '--json', '--token-from', instance], { cwd: '/', env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const text = `${r.stderr || ''}${r.error ? r.error.message : ''}`.trim();
    process.stderr.write(/already (exists|loaded|active)/i.test(text) ? 'a Claude account switch is already running (worklane-claude-account.service)\n' : `couldn't start the switch: ${text.split('\n')[0]}\n`);
    return 1;
  }
  process.stdout.write(`started the Claude account switch as ${CLAUDE_ACCOUNT_UNIT}.service; it waits for the token in ${instance}'s dashboard\n`);
  return 0;
}

/** The tailscale step a list asks for (install, up, serve or public-url), or null when it is anything else: exactly two words. */
function parseTailscale(args) {
  return args.length === 2 && args[0] === 'tailscale' && typeof args[1] === 'string' && TAILSCALE_ACTIONS.includes(args[1]) ? args[1] : null;
}

/** What the unit runs for a tailscale step: the script, the one word and, for up, whose dashboard gets the login link. Nothing of the caller's but that word. */
function tailscaleCommand(real, action, instance) {
  return ['/bin/bash', real, action, ...(action === 'up' ? ['--for', instance] : [])];
}

function tailscale(action) {
  const real = rootScript(TAILSCALE);
  if (!real) return 1;
  const instance = coordinatorInstance(process.env.SUDO_USER);
  if (!instance) {
    process.stderr.write('tailscale here is for a coordinator, through sudo; an admin runs scripts/setup/tailscale.sh\n');
    return 2;
  }
  logLine('tailscale', null, action);
  const env = { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' };
  const r = spawnSync('systemd-run', ['--unit', TAILSCALE_UNIT, '--collect', '--no-block', '--quiet', '--description', `worklane tailscale ${action}`, '--property', `Environment=PATH=${PATH_ENV} LANG=C.UTF-8 HOME=/root`, ...tailscaleCommand(real, action, instance)], { cwd: '/', env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const text = `${r.stderr || ''}${r.error ? r.error.message : ''}`.trim();
    process.stderr.write(/already (exists|loaded|active)/i.test(text) ? 'a tailscale step is already running (worklane-tailscale.service); wait for it to finish\n' : `couldn't start tailscale ${action}: ${text.split('\n')[0]}\n`);
    return 1;
  }
  process.stdout.write(`started tailscale ${action} as ${TAILSCALE_UNIT}.service\n`);
  return 0;
}

function addProject(p) {
  const real = rootScript(ADD_PROJECT);
  if (!real) return 1;
  logLine('add-project', null, `${p.name} ${p.repo}`);
  const r = spawnSync('bash', [real, p.name, p.repo], { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' }, stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`add-project: ${r.error.message}\n`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

/** The change an argument list asks for, or null when it is anything but the exact allowed forms. */
function parse(args) {
  if (args.length !== 2) return null;
  const [cmd, arg] = args;
  if (cmd === 'set-slots' && /^([1-9]|1[0-6])$/.test(arg)) return { what: 'slots.max_agents', file: 'slots.json', key: 'max_agents', value: Number(arg) };
  if (cmd === 'set-test-slots' && /^[1-8]$/.test(arg)) return { what: 'slots.max_test_runs', file: 'slots.json', key: 'max_test_runs', value: Number(arg) };
  if (cmd === 'set-updates' && (arg === 'on' || arg === 'off')) return { what: 'updates.enabled', file: 'updates.json', key: 'enabled', value: arg === 'on' };
  return null;
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function main(args) {
  const add = parseAddProject(args);
  if (add) return addProject(add);
  const account = parseClaudeAccount(args);
  if (account) return claudeAccount(account);
  const ts = parseTailscale(args);
  if (ts) return tailscale(ts);
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
  const by = process.env.SUDO_USER || 'root';
  const line = { at: new Date().toISOString(), by, what: change.what, from, to: change.value };
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(line)}\n`, { mode: 0o644 });
  try {
    execFileSync('logger', ['-t', 'worklane-machine', `${by} set ${change.what} from ${JSON.stringify(from)} to ${JSON.stringify(change.value)}`], { stdio: 'ignore' });
  } catch {
    // no journal here (a test, or a machine without logger): the change log still has it
  }
  process.stdout.write(`${change.what}: ${JSON.stringify(from)} -> ${JSON.stringify(change.value)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, parseAddProject, parseClaudeAccount, parseTailscale, tailscaleCommand, coordinatorInstance };

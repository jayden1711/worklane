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
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Fixed paths: the installed helper takes none from its caller (environment or arguments).
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';
const ADD_PROJECT = '/opt/worklane/current/scripts/setup/add-project.sh';
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const USAGE = 'usage: worklane-machine set-slots <1..16> | set-updates on|off | set-test-slots <1..8> | add-project <name> <owner/repo>';

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

function addProject(p) {
  // The script's whole path, resolved (current is a link to the engine's directory): every part root's alone.
  let real;
  try {
    real = fs.realpathSync(ADD_PROJECT);
  } catch {
    process.stderr.write(`${ADD_PROJECT} is missing: install the engine (engine.sh) first\n`);
    return 1;
  }
  const why = notRootOwned(real);
  if (why) {
    process.stderr.write(`not running ${real}: ${why}\n`);
    return 1;
  }
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
module.exports = { parse, parseAddProject };

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
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Fixed paths: the installed helper takes none from its caller (environment or arguments).
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';

const USAGE = 'usage: worklane-machine set-slots <1..16> | set-updates on|off';

/** The change an argument list asks for, or null when it is anything but the exact allowed forms. */
function parse(args) {
  if (args.length !== 2) return null;
  const [cmd, arg] = args;
  if (cmd === 'set-slots' && /^([1-9]|1[0-6])$/.test(arg)) return { what: 'slots.max_agents', file: 'slots.json', key: 'max_agents', value: Number(arg) };
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
module.exports = { parse };

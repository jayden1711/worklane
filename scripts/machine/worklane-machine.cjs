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
// directory above it are root's and nobody else may write them. Its output (one JSON line per step) passes straight
// through; its stdin is never passed on (issue #711: a dashboard never takes a Claude credential, so the script's
// claude-token step waits for root to install the login instead). The change log gets the name and the repo.
//
//   worklane-machine claude-account status
//
// runs the installed engine's scripts/setup/claude-account.sh status, under the same root-owned check (`status
// --json`: each agent user's account and expiry, written to /var/lib/worklane/claude-account/status.json). Nothing
// here takes a Claude credential (issue #711). The account profile steps (use, remove) and the failover setting were
// removed (#736): refused like any unknown command, nothing run or logged. The sudoers rule lists claude-account
// status alone (#758).
//
// The engine updater (scripts/setup/updates.sh, scripts/machine/worklane-update.cjs):
//
//   worklane-machine install-updater
//   worklane-machine set-update-channel release
//   worklane-machine stage-update-signer <principal> ssh-ed25519 <public key>
//   worklane-machine discard-update-signer <principal> ssh-ed25519 <public key>
//
// install-updater runs the installed engine's scripts/setup/updates.sh with no arguments, under the same root-owned
// check: the updater, its timer and its config, off, an existing config kept as it is. set-update-channel writes
// updates.json's "channel" and nothing else, only once the updater is installed, and only to "release" (signed
// release tags): following main instead is an admin's, at a root shell (updates.sh --channel main).
//
// The keys a release tag's signature is checked against (the updater's allowed signers file, in /etc/worklane) are
// the root of trust for the release channel, and nothing in this helper writes that file. A coordinator can only
// STAGE a signer: stage-update-signer records one principal (an email's shape: no wildcard, list or option) and one
// ed25519 public key (its exact encoding, decoded here) in /var/lib/worklane/pending-signers.json, a root-owned list of
// at most 4, each dropped 24 hours after it was staged. A staged signer is trusted for nothing. It becomes a signer
// only when an admin, at a root shell on the machine, runs updates.sh --confirm-signer <its SHA256 fingerprint>.
// discard-update-signer takes one back out of the pending list.
//
// Tailscale for the dashboard hub (scripts/setup/tailscale.sh):
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
// None of the four can turn on Tailscale Funnel or reach beyond the tailnet: there is no funnel command here, serve's
// target is the script's fixed loopback port, `up` takes no flag, and the script does nothing while Funnel is on.
//
// Where each step runs: every step that writes outside /var/lib or runs a setup script as root (set-slots,
// set-test-slots, set-updates, set-update-channel, install-updater, add-project, stage/discard-update-signer,
// claude-account status) runs in a transient unit of its own, started with systemd-run once its arguments have
// passed, because the coordinator's own sandbox (ProtectSystem=full) would make those paths read-only. See main().
// Plugins for an instance's agents (scripts/setup/plugins.sh, src/plugins/), for the asking coordinator's instance
// alone (from SUDO_USER, never an argument):
//
//   worklane-machine plugin-fetch <id> <https git URL> <40-hex commit> [<subdirectory>]
//   worklane-machine plugin-stage <id> sha256:<64 hex> <role+role...>
//   worklane-machine plugin-withdraw <id>
//   worklane-machine plugin-remove <id>
//
// plugin-fetch starts plugins.sh fetch as its own unit (worklane-plugin-fetch-<instance>.service: one at a time per
// instance, and at most 10 an hour): a throwaway user (DynamicUser) fetches that exact commit; root inspects it without
// running any of it and leaves a preview. plugin-stage records an approval in /var/lib/worklane/plugins/pending.json,
// only when the digest is what that preview and those roles make now; a staged approval is trusted for nothing.
// Nothing in this helper adds or changes an entry in an instance's allowlist (/etc/worklane/plugins/<instance>.json):
// an admin confirms a staged approval at a root shell (plugins.sh confirm, which refuses a coordinator's sudo).
// plugin-remove only deletes an entry; plugin-withdraw takes a staged one back out.
//
//   worklane-machine mcp-fetch <id> <npm package> <x.y.z>
//   worklane-machine mcp-preview <id> <plugin id> <server name>
//   worklane-machine mcp-snapshot <id>
//   worklane-machine mcp-stage <id> sha256:<64 hex> <role+role...> <host+host...|none> <SECRET+SECRET...|none>
//
// MCP servers, the same way (src/mcp/): mcp-fetch, mcp-preview and mcp-snapshot start plugins.sh as the same per-instance
// unit (a pinned npm package fetched by a throwaway user; a server inside an approved plugin; the second snapshot, with
// the server's secrets and approved network). Each starts the server in quarantine as the instance's broker user, in its
// sandbox, with no agent connected. mcp-stage stages its approval with the hosts it may reach and its secrets' names.
//
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Fixed paths: the installed helper takes none from its caller (environment or arguments).
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';
const ADD_PROJECT = '/opt/worklane/current/scripts/setup/add-project.sh';
const CLAUDE_ACCOUNT = '/opt/worklane/current/scripts/setup/claude-account.sh';
const UPDATES = '/opt/worklane/current/scripts/setup/updates.sh';
const PENDING = '/var/lib/worklane/pending-signers.json'; // staged signers: trusted for nothing until an admin confirms one
const PENDING_MAX = 4;
const PENDING_TTL_MS = 24 * 60 * 60_000;
const TAILSCALE = '/opt/worklane/current/scripts/setup/tailscale.sh';
const TAILSCALE_UNIT = 'worklane-tailscale';
const TAILSCALE_ACTIONS = ['install', 'up', 'serve', 'public-url'];
const PATH_ENV = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const ENGINE_CLI = '/opt/worklane/current/dist/src/cli.js';
const PLUGINS_SH = '/opt/worklane/current/scripts/setup/plugins.sh';
const PLUGIN_FETCH_UNIT = 'worklane-plugin-fetch';

const USAGE = 'usage: worklane-machine set-slots <1..16> | set-updates on|off | set-test-slots <1..8> | add-project <name> <owner/repo> | claude-account status | install-updater | set-update-channel release | stage-update-signer <principal> ssh-ed25519 <public key> | discard-update-signer <principal> ssh-ed25519 <public key> | tailscale install|up|serve|public-url | plugin-fetch <id> <https url> <sha> [<path>] | plugin-stage <id> sha256:<hex> <role+role> | plugin-withdraw <id> | plugin-remove <id> | mcp-fetch <id> <npm package> <x.y.z> | mcp-preview <id> <plugin> <server> | mcp-snapshot <id> | mcp-stage <id> sha256:<hex> <role+role> <host+host|none> <SECRET+SECRET|none> | set-policy <key> <value>';

/**
 * Why a name can't be an instance's, or null: instance.sh's shape, never a name whose users, group or units are already
 * another's. Word for word src/instance-name.ts instanceNameProblem and scripts/setup/lib.sh instance_name_problem
 * (test/instance-name.test.ts holds the three equal).
 */
function instanceNameProblem(s) {
  if (typeof s !== 'string' || !/^[a-z][a-z0-9-]{0,20}$/.test(s)) return 'lowercase letters, digits and dashes, starting with a letter, at most 21';
  if (s === 'dash') return 'wl-dash is the dashboard viewer';
  if (s === 'hub' || s === 'hub-setup') return `worklane-dashboard-${s}.service is the dashboard hub's`;
  if (s === 'update' || s === 'tailscale' || s === 'claude-account' || s === 'egress') return `worklane-${s}.service is the machine's own`;
  if (s === 'machine' || s === 'console') return `/etc/sudoers.d/worklane-${s} is the machine's own sudoers file`;
  if (s === 'agent' || s === 'eval' || s === 'work' || s === 'mcp' || s === 'mcpc' || s === 'mcpctl') return `its test user wl-test-${s} would be instance test's ${s} name, and wl-ci-${s} the ${s} name of instance ci`;
  if (s.startsWith('test-')) return `wl-${s} is the test user of instance ${s.slice(5)}`;
  if (s.startsWith('ci-')) return `wl-${s} is the user of CI runner ${s.slice(3)}`;
  if (s.startsWith('exp-')) return `wl-${s} is the experiment job user of instance ${s.slice(4)}`;
  if (s.startsWith('score-')) return `wl-${s} is the experiment scorer user of instance ${s.slice(6)}`;
  if (s.startsWith('dashboard-')) return `worklane-${s}.service is the dashboard of instance ${s.slice(10)}`;
  if (s.startsWith('plugin-fetch-')) return `worklane-${s}.service is the plugin fetch of instance ${s.slice(13)}`;
  const m = /^(.+)-(agent|eval|work|mcp|mcpc|mcpctl)$/.exec(s);
  if (m) return `wl-${s} is instance ${m[1]}'s ${m[2]} name`;
  return null;
}
/** An instance name the helper acts for. */
const instanceName = (s) => instanceNameProblem(s) === null;
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

/**
 * Run a step that changes the machine, then record it: the change log is the audit of what changed, so a step is
 * recorded only once it has run, as done (`to`) when it exited 0 and as `failed: <to>: exit <n>` otherwise, never as
 * a change before it happened. Returns the step's status.
 */
function runLogged(what, to, run, opts = {}) {
  let status;
  try {
    status = run();
  } catch (e) {
    process.stderr.write(`${what}: ${(e && e.message) || e}\n`);
    status = 1;
  }
  try {
    logLine(what, null, status === 0 ? to : `failed: ${to}: exit ${status}`);
  } catch (e) {
    // opts.statusOverLog (set-policy): a change that went through is never reported as failed because its log line
    // couldn't be written (a full /var/lib): said on stderr, and the step's own status kept (#726: OFF is never
    // reported failed once done).
    if (!opts.statusOverLog) throw e;
    process.stderr.write(`${what}: ${status === 0 ? 'done' : 'failed'}, but the change log (${LOG}) couldn't be written: ${(e && e.message) || e}\n`);
  }
  return status;
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

/**
 * The claude-account action a list asks for (status), or null when it is anything else. Never switch: a switch takes
 * a Claude credential, a root admin's at a root shell (issue #711).
 */
function parseClaudeAccount(args) {
  return args.length === 2 && args[0] === 'claude-account' && args[1] === 'status' ? args[1] : null;
}

/**
 * The account profile steps (claude-account use|remove <profile>) and the failover setting were removed (#736): no
 * list is one, so each is refused like any unknown command, and no sudoers rule names one (#758). Both names stay only
 * in the export list, which test/claude-accounts-retired.test.ts checks refuses each; neither ever returns a step.
 */
function parseClaudeProfile(_args) {
  return null;
}
function parseClaudeFailover(_args) {
  return null;
}

/** The instance whose coordinator user this is (wl-<name>), or null for anyone else. */
const coordinatorInstance = (user) => {
  const m = /^wl-(.+)$/.exec(user || '');
  return m && instanceName(m[1]) ? m[1] : null;
};
/**
 * The instance a coordinator's set-policy is for (#902 round 9): any name in the shape every instance name has had, so
 * an instance made before its name was reserved (machine, console) can still turn things off. set-policy only
 * tightens: parsePolicySet takes land_mode, main_watch and auto_merge only toward pr, auto and off, and root's policy
 * set checks every other key a coordinator sends against the value in effect (src/policy-root.ts setPolicy). Every
 * other step keeps coordinatorInstance.
 */
const policyInstance = (user) => {
  const m = /^wl-([a-z][a-z0-9-]{0,20})$/.exec(user || '');
  return m ? m[1] : null;
};

/** claude-account.sh status, here: the only claude-account action (parseClaudeAccount takes no other). */
function claudeAccount() {
  const real = rootScript(CLAUDE_ACCOUNT);
  if (!real) return 1;
  const env = { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' };
  return runLogged('claude-account', 'status', () => {
    const r = spawnSync('bash', [real, 'status', '--json'], { cwd: '/', env, stdio: 'inherit' });
    if (r.error) throw r.error;
    return r.status === null ? 1 : r.status;
  });
}

// An ed25519 public key's encoding never varies: the key type's name, then 32 bytes, 51 bytes in all, 68 characters.
const ED25519_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32])]);
/** A signer's principal: one email-shaped name. Never a pattern (*, ?, !), a list (,) or anything quoted or spaced. */
const signerPrincipal = (s) => typeof s === 'string' && s.length <= 254 && /^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(s);
/** An ed25519 public key as ssh writes it (base64, 68 characters), decoding to exactly that key type and 32 bytes. */
function ed25519Key(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]{68}$/.test(s)) return false;
  const blob = Buffer.from(s, 'base64');
  return blob.length === 51 && blob.subarray(0, ED25519_HEAD.length).equals(ED25519_HEAD) && blob.toString('base64') === s;
}
/** A key's fingerprint as `ssh-keygen -l` prints it. */
const fingerprint = (key) => `SHA256:${require('node:crypto').createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`;

/** The signer a list names, or null when it is anything but `<command> <principal> ssh-ed25519 <key>`. */
function parseSigner(command, args) {
  if (args.length !== 4 || args[0] !== command || !signerPrincipal(args[1]) || args[2] !== 'ssh-ed25519' || !ed25519Key(args[3])) return null;
  return { principal: args[1], key: args[3] };
}

/**
 * The staged signers that still count: well-formed (a file is never trusted for more than its own checks pass) and
 * staged less than PENDING_TTL_MS ago. Each is { principal, key, fingerprint, by, at }.
 */
function readPending(file = PENDING, now = Date.now()) {
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.pending)) list = j.pending;
  } catch {
    // none staged
  }
  return list
    .filter((e) => e && signerPrincipal(e.principal) && ed25519Key(e.key) && typeof e.at === 'string' && now - Date.parse(e.at) >= 0 && now - Date.parse(e.at) < PENDING_TTL_MS)
    .slice(0, PENDING_MAX)
    .map((e) => ({ principal: e.principal, key: e.key, fingerprint: fingerprint(e.key), by: typeof e.by === 'string' ? e.by.slice(0, 64) : 'unknown', instance: instanceName(e.instance) ? e.instance : null, at: e.at }));
}

/** The pending list, whole: a temp file beside it, then a rename. */
function writePending(list, file = PENDING) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ pending: list })}\n`, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
}

/** Stage one signer for an admin to confirm at a root shell. Only the pending list is written. */
function stageSigner(s) {
  const pending = readPending();
  const fp = fingerprint(s.key);
  if (pending.some((e) => e.principal === s.principal && e.key === s.key)) {
    process.stdout.write(`${s.principal} ssh-ed25519 ${s.key} (${fp}) is already staged; nothing changed\n`);
    return 0;
  }
  if (pending.length >= PENDING_MAX) {
    process.stderr.write(`${PENDING_MAX} signers are already staged: confirm or discard one first\n`);
    return 1;
  }
  // Who staged it: the coordinator user that ran this through sudo, and so the instance whose dashboard asked.
  const by = process.env.SUDO_USER || 'root';
  writePending([...pending, { principal: s.principal, key: s.key, fingerprint: fp, by, instance: coordinatorInstance(by), at: new Date().toISOString() }]);
  logLine('updates.pending_signer', null, `staged ${s.principal} ssh-ed25519 ${s.key} (${fp})`);
  process.stdout.write(`staged ${s.principal} ssh-ed25519 ${s.key} (${fp}): not a signer until an admin confirms it on this machine, within 24 hours, with: sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer ${fp}\n`);
  return 0;
}

/** Take one staged signer back out of the pending list. */
function discardSigner(s) {
  const pending = readPending();
  const rest = pending.filter((e) => !(e.principal === s.principal && e.key === s.key));
  if (rest.length === pending.length) {
    process.stderr.write(`${s.principal} with that key isn't staged (or its 24 hours have passed)\n`);
    return 1;
  }
  writePending(rest);
  logLine('updates.pending_signer', `staged ${s.principal} ssh-ed25519 ${s.key} (${fingerprint(s.key)})`, 'discarded');
  process.stdout.write(`discarded the staged signer ${s.principal} (${fingerprint(s.key)})\n`);
  return 0;
}

/** updates.sh from the installed engine, as root, with no arguments: the updater, its timer and its config (off). */
function installUpdater() {
  const real = rootScript(UPDATES);
  if (!real) return 1;
  return runLogged('install-updater', 'updates.sh', () => {
    const r = spawnSync('bash', [real], { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' }, stdio: 'inherit' });
    if (r.error) throw r.error;
    return r.status === null ? 1 : r.status;
  });
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
  const env = { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' };
  const r = spawnSync('systemd-run', ['--unit', TAILSCALE_UNIT, '--collect', '--no-block', '--quiet', '--description', `worklane tailscale ${action}`, '--property', `Environment=PATH=${PATH_ENV} LANG=C.UTF-8 HOME=/root`, ...tailscaleCommand(real, action, instance)], { cwd: '/', env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const text = `${r.stderr || ''}${r.error ? r.error.message : ''}`.trim();
    process.stderr.write(/already (exists|loaded|active)/i.test(text) ? 'a tailscale step is already running (worklane-tailscale.service); wait for it to finish\n' : `couldn't start tailscale ${action}: ${text.split('\n')[0]}\n`);
    logLine('tailscale', null, `failed: ${action}: not started`);
    return 1;
  }
  logLine('tailscale', null, action);
  process.stdout.write(`started tailscale ${action} as ${TAILSCALE_UNIT}.service\n`);
  return 0;
}

function addProject(p) {
  const real = rootScript(ADD_PROJECT);
  if (!real) return 1;
  return runLogged('add-project', `${p.name} ${p.repo}`, () => {
    // stdin is never passed on (issue #711): nothing a coordinator writes can reach the script as a Claude token.
    const r = spawnSync('bash', [real, p.name, p.repo], { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' }, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.error) throw r.error;
    return r.status === null ? 1 : r.status;
  });
}

/** The change an argument list asks for, or null when it is anything but the exact allowed forms. */
function parse(args) {
  if (args.length !== 2) return null;
  const [cmd, arg] = args;
  if (cmd === 'set-slots' && /^([1-9]|1[0-6])$/.test(arg)) return { what: 'slots.max_agents', file: 'slots.json', key: 'max_agents', value: Number(arg) };
  if (cmd === 'set-test-slots' && /^[1-8]$/.test(arg)) return { what: 'slots.max_test_runs', file: 'slots.json', key: 'max_test_runs', value: Number(arg) };
  if (cmd === 'set-updates' && (arg === 'on' || arg === 'off')) return { what: 'updates.enabled', file: 'updates.json', key: 'enabled', value: arg === 'on' };
  // The channel of an updater that is installed: a config holding only a channel would read as one that is set up.
  if (cmd === 'set-update-channel' && arg === 'release') return { what: 'updates.channel', file: 'updates.json', key: 'channel', value: arg, existing: true };
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

// ---------- plugins ----------

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
// An https git URL with no credentials, port, query or fragment (sudo's pattern allows the same, src/plugins/fetch.ts more).
const PLUGIN_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+$/;
const PLUGIN_SHA = /^[0-9a-f]{40}$/;
const PLUGIN_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const PLUGIN_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLUGIN_ROLES = /^[a-z][a-z0-9-]{0,30}(?:\+[a-z][a-z0-9-]{0,30})*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const MCP_HOSTS = new RegExp(`^(?:none|(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})+(?:\\+(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})+)*)$`);
const MCP_SECRETS = /^(?:none|[A-Z][A-Z0-9_]{1,63}(?:\+[A-Z][A-Z0-9_]{1,63})*)$/;
// Root's allowlist of hosts plugins may come from (scripts/setup/plugins.sh hosts): root:root, not writable by others.
// Absent: github.com alone. Present but not root's, writable by others or malformed: no host at all.
const PLUGIN_HOSTS_FILE = '/etc/worklane/plugin-hosts.json';
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function pluginHosts(file = PLUGIN_HOSTS_FILE, ownerUid = 0) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return ['github.com'];
  }
  if (!st.isFile() || st.uid !== ownerUid || (st.mode & 0o022) !== 0) return [];
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v.hosts) && v.hosts.every((h) => typeof h === 'string' && HOST_NAME.test(h) && require('node:net').isIP(h) === 0) ? v.hosts : [];
  } catch {
    return [];
  }
}

/** Why a plugin's URL may not be fetched (null when it may): exactly https://, one allowed host by name, no address. */
function pluginUrlProblem(url, hosts) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return 'the source must start with https://';
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'the source is not a URL';
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return 'the source must be https://<host>/<path>, with no user, port, query or fragment';
  const host = u.hostname;
  // WHATWG URL already turned decimal, octal and hex IPv4 spellings into dotted form; IPv6 comes bracketed.
  if (host.startsWith('[') || require('node:net').isIP(host) !== 0) return `the source names an address (${host}), not a host`;
  if (!hosts.includes(host)) return `${host} is not a host plugins may come from`;
  return null;
}

// Root's allowlist of npm registries MCP servers may come from (plugins.sh registries): root:root, not writable by
// others. Absent: registry.npmjs.org alone. Present but not root's, writable by others or malformed: none.
const MCP_REGISTRIES_FILE = '/etc/worklane/mcp-registries.json';
function mcpRegistries(file = MCP_REGISTRIES_FILE, ownerUid = 0) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return ['registry.npmjs.org'];
  }
  if (!st.isFile() || st.uid !== ownerUid || (st.mode & 0o022) !== 0) return [];
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v.registries) && v.registries.every((h) => typeof h === 'string' && HOST_NAME.test(h) && require('node:net').isIP(h) === 0) ? v.registries : [];
  } catch {
    return [];
  }
}

/** Why a subdirectory may not be fetched (null when it may): plain relative segments, never absolute or "..". */
function pluginPathProblem(p) {
  if (typeof p !== 'string' || !p) return 'no subdirectory';
  if (p.startsWith('/') || p.includes('\\')) return 'the subdirectory must be relative';
  if (p.split('/').some((x) => x === '..' || x === '.' || x === '')) return 'the subdirectory may not hold "..", "." or empty segments';
  return PLUGIN_PATH.test(p) ? null : 'the subdirectory holds characters outside A-Z a-z 0-9 . _ -';
}

/** The plugin step a list asks for, or null when it is anything else. */
function parsePlugin(args, hosts = pluginHosts(), registries = mcpRegistries()) {
  const [cmd, id] = args;
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) return null;
  if (cmd === 'plugin-fetch' && (args.length === 4 || args.length === 5)) {
    const [, , url, sha, sub] = args;
    if (!PLUGIN_URL.test(url) || pluginUrlProblem(url, hosts) || !PLUGIN_SHA.test(sha)) return null;
    if (sub !== undefined && pluginPathProblem(sub)) return null;
    return { action: 'fetch', id, url, sha, ...(sub !== undefined ? { path: sub } : {}) };
  }
  if (cmd === 'plugin-stage' && args.length === 4 && PLUGIN_DIGEST.test(args[2]) && PLUGIN_ROLES.test(args[3])) return { action: 'stage', id, digest: args[2], roles: args[3] };
  if (cmd === 'plugin-withdraw' && args.length === 2) return { action: 'withdraw', id };
  if (cmd === 'mcp-fetch' && (args.length === 4 || args.length === 5) && NPM_NAME.test(args[2]) && NPM_VERSION.test(args[3])) {
    // Only a registry on root's list; none named: the first on it.
    const registry = args.length === 5 ? args[4] : registries[0];
    if (typeof registry !== 'string' || !registries.includes(registry)) return null;
    return { action: 'mcp-fetch', id, pkg: args[2], version: args[3], registry };
  }
  if (cmd === 'mcp-preview' && args.length === 4 && PLUGIN_ID.test(args[2]) && MCP_SERVER_NAME.test(args[3])) return { action: 'mcp-preview', id, plugin: args[2], server: args[3] };
  if (cmd === 'mcp-snapshot' && args.length === 2) return { action: 'mcp-snapshot', id };
  if (cmd === 'mcp-stage' && args.length === 6 && PLUGIN_DIGEST.test(args[2]) && PLUGIN_ROLES.test(args[3]) && MCP_HOSTS.test(args[4]) && MCP_SECRETS.test(args[5])) return { action: 'stage', id, digest: args[2], roles: args[3], network: args[4], secrets: args[5] };
  if (cmd === 'plugin-remove' && args.length === 2) return { action: 'remove', id };
  return null;
}

function plugin(p) {
  const instance = coordinatorInstance(process.env.SUDO_USER);
  if (!instance) {
    process.stderr.write(`plugin-${p.action} here is for a coordinator, through sudo; an admin runs scripts/setup/plugins.sh\n`);
    return 2;
  }
  if (p.action === 'fetch' || p.action.startsWith('mcp-')) {
    const real = rootScript(PLUGINS_SH);
    if (!real) return 1;
    const what = `plugins.${instance}.${p.action}`;
    const args = p.action === 'fetch' ? [real, 'fetch', instance, p.id, p.url, p.sha, ...(p.path ? [p.path] : [])]
      : p.action === 'mcp-fetch' ? [real, 'mcp-fetch', instance, p.id, p.pkg, p.version, p.registry]
      : p.action === 'mcp-preview' ? [real, 'mcp-preview', instance, p.id, p.plugin, p.server]
      : [real, 'mcp-snapshot', instance, p.id];
    const r = spawnSync('systemd-run', ['--unit', `${PLUGIN_FETCH_UNIT}-${instance}`, '--collect', '--no-block', '--quiet', '--description', `worklane plugin fetch for ${instance}`, '--property', `Environment=PATH=${PATH_ENV} LANG=C.UTF-8 HOME=/root`, '/bin/bash', ...args], { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8' }, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      const text = `${r.stderr || ''}${r.error ? r.error.message : ''}`.trim();
      process.stderr.write(/already (exists|loaded|active)/i.test(text) ? `a plugin fetch for ${instance} is already running\n` : `couldn't start the fetch: ${text.split('\n')[0]}\n`);
      logLine(what, null, `failed: ${args.slice(2).join(' ')}: not started`);
      return 1;
    }
    logLine(what, null, args.slice(3).join(' '));
    process.stdout.write(`started ${p.action} of ${p.id} as ${PLUGIN_FETCH_UNIT}-${instance}.service\n`);
    return 0;
  }
  const cli = rootScript(ENGINE_CLI);
  if (!cli) return 1;
  const args = p.action === 'stage' ? ['--id', p.id, '--roles', p.roles, '--digest', p.digest, ...(p.network !== undefined ? ['--network', p.network, '--secrets', p.secrets] : [])] : ['--id', p.id];
  // The engine's own root operations: the instance from sudo, `by` from SUDO_USER (kept in the environment).
  const r = spawnSync(process.execPath, [cli, 'plugins', p.action, '--instance', instance, ...args], { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8', SUDO_USER: process.env.SUDO_USER }, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

// ---------- the asking instance's root policy.yaml (issue #726) ----------
//
//   worklane-machine set-policy <key> <value>
//
// One key of the asking coordinator's own instance's policy.yaml (from SUDO_USER, never an argument), which setup made
// root's: the installed engine's `policy set` runs as root, checks it against the schema and the machine's limits, and
// writes it root's, 0644. Only these keys, each in its shape (src/policy-gate.ts holds the same table; a test holds them
// equal); never sandbox, allow_same_user, lanes or an allowlist; land_mode only to pr, main_watch only to auto, and
// auto_merge only off (POLICY_ONLY, held equal to the engine's HELPER_ONLY). Loosening any of those is an admin's, at a
// root shell (sudo <cli> policy set <instance> <key> <value>).
const POLICY_SET_KEYS = {
  'budget.daily_usd': 'number', 'agents.max_workers': 'number', land_mode: 'word', auto_merge: 'bool', main_watch: 'word', 'automations.enabled': 'bool',
  'settings.workers': 'number', 'settings.daily_budget_usd': 'number', 'settings.ci_repair.enabled': 'bool', 'settings.ci_repair.max_fixes_per_pr': 'number', 'settings.run_windows': 'windows',
  'settings.research.max_searches_per_day': 'number', 'settings.research.max_fetches_per_day': 'number', 'settings.research.max_usd_per_day': 'number', 'settings.research.repo_access': 'bool',
  'settings.intake.reports_per_sender_per_day': 'number', 'settings.intake.drafts_per_day': 'number', 'settings.intake.max_usd_per_day': 'number', 'settings.stuck_guard': 'word',
  'settings.chat_attachments.max_file_mb': 'number', 'settings.chat_attachments.max_message_mb': 'number', 'settings.chat_attachments.retention_days': 'number',
};
// check-table: never-shrink
const POLICY_ONLY = { land_mode: 'pr', main_watch: 'auto', auto_merge: 'off' };
const POLICY_SHAPES = {
  number: /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/,
  bool: /^(on|off)$/,
  word: /^[a-z][a-z-]{0,15}$/,
  windows: /^(none|[0-2][0-9][0-5][0-9]-[0-2][0-9][0-5][0-9](\+[0-2][0-9][0-5][0-9]-[0-2][0-9][0-5][0-9]){0,7})$/,
};

/** The policy change a list asks for, or null when it is anything but `set-policy <key> <value>` in its exact shape. */
function parsePolicySet(args) {
  if (args.length !== 3 || args[0] !== 'set-policy' || typeof args[1] !== 'string' || typeof args[2] !== 'string') return null;
  const [, key, value] = args;
  if (!Object.prototype.hasOwnProperty.call(POLICY_SET_KEYS, key) || !POLICY_SHAPES[POLICY_SET_KEYS[key]].test(value)) return null;
  if (Object.prototype.hasOwnProperty.call(POLICY_ONLY, key) && POLICY_ONLY[key] !== value) return null;
  return { key, value };
}

function policySet(p) {
  const instance = policyInstance(process.env.SUDO_USER);
  if (!instance) {
    process.stderr.write(`set-policy here is for a coordinator, through sudo; an admin runs: ${ENGINE_CLI} policy set <instance> ${p.key} ${p.value}\n`);
    return 2;
  }
  const cli = rootScript(ENGINE_CLI);
  if (!cli) return 1;
  return runLogged(`policy.${instance}`, `${p.key} ${p.value}`, () => {
    // Its last line, {key, from, to}, is what the coordinator records as settings.changed.
    const r = spawnSync(process.execPath, [cli, 'policy', 'set', instance, p.key, p.value], { cwd: '/', env: { PATH: PATH_ENV, HOME: '/root', LANG: 'C.UTF-8', SUDO_USER: process.env.SUDO_USER }, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.error) throw r.error;
    return r.status === null ? 1 : r.status;
  }, { statusOverLog: true });
}

// ---------- where a step runs ----------
//
// The coordinator calls this helper through sudo from inside its own unit, whose sandbox (ProtectSystem=full) makes
// /usr, /boot and /etc read-only for everything it starts, sudo and this helper included. So every step here that
// writes outside /var/lib, or runs a setup script as root, is not done in that process: once its arguments have passed
// the same checks as always, the helper starts itself again in a transient unit of its own (systemd-run, outside the
// coordinator's cgroup and sandbox), with the same arguments, waits for it and passes its output and exit status back.
// The started copy checks the arguments again before it does anything. A step that only reads, or only writes under
// /var/lib, still runs here; the tailscale steps already start units of their own.
const IN_UNIT = '--in-unit'; // the copy started in its own unit: only root, which sudo's rule never lets a coordinator pass
const UNIT_PREFIX = 'worklane-machine';

/** Whether these (already valid) arguments are a step that runs in a unit of its own: anything that writes system paths. */
function needsUnit(args) {
  if (parse(args) || parseAddProject(args)) return true; // updates.json, slots.json (in /etc); add-project.sh
  if (args.length === 1 && args[0] === 'install-updater') return true; // /usr/local/libexec, /etc/systemd, /etc/worklane
  if (parseSigner('stage-update-signer', args) || parseSigner('discard-update-signer', args)) return true; // its pending list, kept with the rest
  if (parseClaudeAccount(args) === 'status') return true; // claude-account.sh as root
  if (parseClaudeFailover(args)) return true; // claude-account.sh as root
  if (parsePolicySet(args)) return true; // the engine as root, writing in the instance home (outside the coordinator's sandbox)
  const pl = parsePlugin(args);
  if (pl && pl.action === 'remove') return true; // /etc/worklane/plugins
  return false;
}

/** systemd-run's arguments for one step: this same helper, the same arguments, waited for, its output piped back. */
function unitCommand(args, user, self = __filename, node = process.execPath, pid = process.pid) {
  const env = [`PATH=${PATH_ENV}`, 'LANG=C.UTF-8', 'HOME=/root', ...(user && /^[a-z_][a-z0-9_-]{0,31}$/.test(user) ? [`SUDO_USER=${user}`] : [])];
  return ['--unit', `${UNIT_PREFIX}-${args[0]}-${pid}`, '--wait', '--pipe', '--collect', '--quiet', '--service-type=exec', '--description', `worklane-machine ${args[0]}`, '--property', `Environment=${env.join(' ')}`, node, self, IN_UNIT, ...args];
}

function inUnit(args) {
  const r = spawnSync('systemd-run', unitCommand(args, process.env.SUDO_USER), { cwd: '/', stdio: 'inherit', env: { PATH: PATH_ENV, LANG: 'C.UTF-8' } });
  if (r.error) {
    process.stderr.write(`couldn't start ${args[0]} in a unit of its own (systemd-run): ${r.error.message}\n`);
    return 1;
  }
  return r.status === null ? 1 : r.status;
}

function main(argv) {
  // The copy started in its own unit (below): root only, and its arguments checked again from the start.
  const inner = argv[0] === IN_UNIT;
  const args = inner ? argv.slice(1) : argv;
  if (inner && !(process.getuid && process.getuid() === 0)) {
    process.stderr.write(`${IN_UNIT} is the helper's own, as root\n`);
    return 2;
  }
  // As root (through sudo, or an admin), a step that writes system paths goes to a unit of its own; never from a
  // test's copy (not root), which runs it here against its own paths.
  if (!inner && process.getuid && process.getuid() === 0 && needsUnit(args)) return inUnit(args);
  const add = parseAddProject(args);
  if (add) return addProject(add);
  const account = parseClaudeAccount(args);
  if (account) return claudeAccount();
  if (args.length === 1 && args[0] === 'install-updater') return installUpdater();
  const stage = parseSigner('stage-update-signer', args);
  if (stage) return stageSigner(stage);
  const discard = parseSigner('discard-update-signer', args);
  if (discard) return discardSigner(discard);
  const ts = parseTailscale(args);
  if (ts) return tailscale(ts);
  const pl = parsePlugin(args);
  if (pl) return plugin(pl);
  const pol = parsePolicySet(args);
  if (pol) return policySet(pol);
  const change = parse(args);
  if (!change) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const file = path.join(ETC, change.file);
  if (change.existing && !fs.existsSync(file)) {
    process.stderr.write(`${file} is missing: install the updater first (install-updater)\n`);
    return 1;
  }
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
module.exports = { parsePolicySet, POLICY_SET_KEYS, POLICY_ONLY, parsePlugin, pluginHosts, mcpRegistries, pluginUrlProblem, pluginPathProblem, runLogged, needsUnit, unitCommand, IN_UNIT, parse, instanceNameProblem, parseAddProject, parseClaudeAccount, parseClaudeProfile, parseClaudeFailover, parseTailscale, tailscaleCommand, coordinatorInstance, policyInstance, parseSigner, fingerprint, readPending, writePending, PENDING, PENDING_MAX, PENDING_TTL_MS };

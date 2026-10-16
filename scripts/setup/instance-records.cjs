#!/usr/bin/env node
// Every place outside an instance's own users' homes that holds its name: the registry instance-remove.sh removes
// from, and that a test keeps whole (test/instance-records.test.ts fails on a setup or machine script, or src/, that
// names a per-instance root path, or a file under /etc/worklane or /var/lib/worklane, this file doesn't list).
// A feature that adds a per-instance root record adds it here, with how it goes, and instance-remove.sh removes it.
//
//   node instance-records.cjs items <name>              every item, one a line: <kind> <what> (exists or not)
//   node instance-records.cjs plan <name>               the shared files' records <name> has, one a line (changes nothing)
//   node instance-records.cjs remove <name> <archive>   take <name>'s records out of the shared files, keeping what was
//                                                       taken in <archive> (root's, 0600) first
// As root, from instance-remove.sh only: no sudoers rule and no helper command names this file.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME = /^[a-z][a-z0-9-]{0,20}$/;

// The kinds of item, and how instance-remove.sh takes each away:
//   via      run a script's own remove first (it knows its parts): `script args...`, when any of `when` exists
//   unit     stop, disable, delete the unit file (and its drop-in directory)
//   sudoers  remove_sudoers (lib.sh)
//   path     rm -rf --one-file-system
//   user     userdel -r, after loginctl disable-linger
//   group    groupdel
//   shared   a record inside a shared root file, taken out by `remove` here
// <name> stands for the instance's name. Order is the order of removal: users and the state go last, after the export.
const ITEMS = [
  { kind: 'via', what: 'test-user.sh remove <name>', when: ['user:wl-test-<name>', 'path:/var/lib/worklane-test/<name>', 'unit:worklane-test-<name>-docker.service', 'sudoers:worklane-test-<name>'], by: 'test-user.sh install' },
  { kind: 'via', what: 'testrun-gpu.sh disable <name>', when: ['shared:gpu'], by: 'testrun-gpu.sh enable' },
  { kind: 'unit', what: 'worklane-dashboard-<name>.service', by: 'dashboards.sh' },
  { kind: 'unit', what: 'worklane-<name>.service', by: 'service.sh' },
  { kind: 'unit', what: 'worklane-test-<name>-docker.service', by: 'test-user.sh install' },
  { kind: 'shared', what: 'gpu', by: 'testrun-gpu.sh enable' },
  { kind: 'shared', what: 'claude-profiles', by: 'claude-account.sh profile-add|use|failover' },
  { kind: 'shared', what: 'claude-status', by: 'claude-account.sh status|switch, add-project.sh' },
  { kind: 'shared', what: 'claude-paused', by: 'claude-account.sh switch' },
  { kind: 'shared', what: 'canary', by: 'docs/canary.md (an admin, in updates.json)' },
  { kind: 'shared', what: 'incidents', by: 'the coordinator and the watchdog (src/watchdog/incidents.ts)' },
  { kind: 'shared', what: 'pending-signers', by: "the machine helper's stage-update-signer" },
  { kind: 'path', what: '/var/lib/worklane/agent-slots/discord-claim-<name>.json', by: 'the coordinator (src/intake/discord-claims.ts)' },
  { kind: 'path', what: '/var/lib/worklane/init/<name>.json', by: 'init --mode server (src/init.ts serverInitFile)' },
  { kind: 'sudoers', what: 'worklane-test-<name>', by: 'test-user.sh install' },
  { kind: 'sudoers', what: 'worklane-<name>', by: 'instance.sh' },
  { kind: 'path', what: '/var/lib/worklane-test/<name>', by: 'test-user.sh install' },
  { kind: 'path', what: '/srv/worklane/<name>', by: 'instance.sh, checkout.sh' },
  { kind: 'user', what: 'wl-test-<name>', by: 'test-user.sh install' },
  { kind: 'user', what: 'wl-<name>-eval', by: 'instance.sh --eval' },
  { kind: 'user', what: 'wl-<name>-agent', by: 'instance.sh' },
  { kind: 'user', what: 'wl-<name>', by: 'instance.sh (its home: the instance state, its App key and credentials)' },
  { kind: 'group', what: 'wl-<name>-work', by: 'instance.sh' },
];

// What names an instance in the scripts and src/ without being a record of its own: each is part of an item above
// (its runtime directory, a home path, a unit-name prefix), or not an instance at all. The registry test accepts a
// name found in the code when it is part of an item's `what`, or listed here.
const NOT_RECORDS = [
  { what: '/run/worklane-test-<name>-docker', why: "the test Docker unit's RuntimeDirectory: systemd removes it with the unit" },
  { what: 'worklane-test-<name>-', why: "a test run's transient unit (worklane-test-<name>-<id>-<pid>): gone when the run ends; a run in flight refuses the removal" },
  { what: '/.local/state/worklane/instances/<name>', why: "the instance's state, in wl-<name>'s home: exported, then removed with the user" },
  { what: 'worklane-ci-<name>', why: "ci-runner.sh's self-hosted CI runner: a runner's name, not an instance" },
  { what: '/etc/worklane-ci/', why: "ci-runner.sh's runner files: a runner's name, not an instance" },
  { what: '/var/lib/worklane-ci/<name>', why: "ci-runner.sh's runner state: a runner's name, not an instance" },
  { what: '/run/worklane-ci-<name>', why: "ci-runner.sh's runner Docker: a runner's name, not an instance" },
  { what: 'worklane_ci_', why: "ci-runner.sh's nftables names: a runner's name, not an instance" },
  { what: 'wl-ci-<name>', why: "ci-runner.sh's runner user: a runner's name, not an instance" },
  { what: '<name>-worklane', why: "the instance's GitHub App's name (src/setup/app-manifest.ts): GitHub's, never removed here; instance-remove.sh prints what to do there" },
  { what: '/run/worklane/gpu/<name>.lock', why: "a GPU's lock, by its index: not an instance" },
];

// Every file and directory directly under /etc/worklane and /var/lib/worklane (and the /var/lib/worklane-* roots):
// either it names instances inside (the item that takes an instance's out), or it is the machine's (why).
const SHARED_FILES = [
  { at: '/etc/worklane/testrun-gpu.json', item: 'gpu' },
  { at: '/etc/worklane/updates.json', item: 'canary' },
  { at: '/var/lib/worklane/claude-account', item: 'claude-profiles, claude-status, claude-paused (switch.jsonl, profile-ops.jsonl: logs, kept)' },
  { at: '/var/lib/worklane/agent-slots', item: 'incidents, discord-claim-<name>.json (the slot locks name no instance)' },
  { at: '/var/lib/worklane/pending-signers.json', item: 'pending-signers' },
  { at: '/var/lib/worklane/init', item: '/var/lib/worklane/init/<name>.json' },
  { at: '/var/lib/worklane/canary.json', item: "canary (the canary run in progress: taken with updates.json's canary)" },
  { at: '/var/lib/worklane-test', item: '/var/lib/worklane-test/<name>' },
  { at: '/etc/worklane/allowed_signers', why: 'release signers: the machine updater' },
  { at: '/etc/worklane/slots.json', why: 'the machine slot cap' },
  { at: '/etc/worklane/machine-owners.json', why: 'the machine owners: GitHub logins' },
  { at: '/etc/worklane/helper-rules.json', why: "which helper rules this machine's sudo can take" },
  { at: '/etc/worklane/limits.json', why: "the machine's bounds on every instance's settings" },
  { at: '/etc/worklane/network.json', why: "the machine's proxy and CA" },
  { at: '/etc/worklane/watchdog.json', why: "the machine watchdog's settings" },
  { at: '/var/lib/worklane/machine-changes.jsonl', why: 'the machine change log: history, kept (a removal adds its own line)' },
  { at: '/var/lib/worklane/updates.jsonl', why: "the updater's log: history, kept" },
  { at: '/var/lib/worklane/update-state.json', why: "the updater's state: no instance" },
  { at: '/var/lib/worklane/update-held.json', why: "the updater's hold: an engine commit" },
  { at: '/var/lib/worklane/update-held.released.json', why: "the updater's released hold: an engine commit" },
  { at: '/var/lib/worklane/update-drain.json', why: "the updater's drain flag" },
  { at: '/var/lib/worklane/update-stuck.json', why: "the updater's stuck watch" },
  { at: '/var/lib/worklane/update-verdicts.json', why: "the updater's verdicts on engine commits" },
  { at: '/var/lib/worklane/signers-state.json', why: "the updater's record of the signers file's hash" },
  { at: '/var/lib/worklane/verify.git', why: "the updater's verification clone of the engine" },
  { at: '/var/lib/worklane/tailscale', why: "tailscale.sh's steps for the hub: the asking coordinator's login link only while `up` waits" },
  { at: '/var/lib/worklane/removed', why: "instance-remove.sh's archive of removed instances' history (root's 0700)" },
  { at: '/var/lib/worklane-ci', why: "ci-runner.sh's runners: no instance" },
  { at: '/var/lib/worklane-build', why: "the updater's build directory: no instance" },
];

const ARCHIVE_DIR = '/var/lib/worklane/removed';
const P = {
  gpu: '/etc/worklane/testrun-gpu.json',
  updates: '/etc/worklane/updates.json',
  canaryState: '/var/lib/worklane/canary.json',
  profiles: '/var/lib/worklane/claude-account/profiles.json',
  status: '/var/lib/worklane/claude-account/status.json',
  paused: '/var/lib/worklane/claude-account/paused',
  slots: '/var/lib/worklane/agent-slots',
  pending: '/var/lib/worklane/pending-signers.json',
};
const INCIDENTS = 'incidents.json';
const INCIDENTS_LOCK = 'incidents.lock';

/** The items for one instance: <name> filled in. */
function items(name) {
  return ITEMS.map((i) => ({ ...i, what: i.what.split('<name>').join(name), ...(i.when ? { when: i.when.map((w) => w.split('<name>').join(name)) } : {}) }));
}

const at = (prefix, p) => (prefix ? path.join(prefix, p) : p);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw new Error(`${file} is not JSON (${e.message}); fix or remove it, then run this again`);
  }
}

/** Write a file whole, keeping the owner, group and mode of the one it replaces (a temp name beside it, then a rename). */
function writeKeeping(file, text, fallbackMode = 0o644) {
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    // a new file: root's, fallbackMode
  }
  if (st && !st.isFile()) throw new Error(`${file} is not a regular file; nothing written`);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: st ? st.mode & 0o7777 : fallbackMode });
    if (st) {
      if (typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(tmp, st.uid, st.gid);
      fs.chmodSync(tmp, st.mode & 0o7777);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The incident store's lock, as src/locks.ts takes it (a file hard-linked into place, holding the owner's pid; a dead
 * owner's lock is taken over only after claiming that exact stale lock), so the coordinators writing the store now
 * and this never write it at once.
 */
function withLock(lockPath, fn) {
  const info = JSON.stringify({ pid: process.pid, owner: `instance-records ${process.pid}`, acquiredAt: new Date().toISOString() });
  const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, info);
  try {
    for (let i = 0; i < 500; i++) {
      try {
        fs.linkSync(tmp, lockPath);
        try {
          return fn();
        } finally {
          try {
            if (fs.readFileSync(lockPath, 'utf8') === info) fs.unlinkSync(lockPath);
          } catch {
            // gone already
          }
        }
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let seen = null;
      try {
        seen = fs.readFileSync(lockPath, 'utf8');
      } catch {
        continue; // released in between
      }
      let holder = null;
      try {
        holder = JSON.parse(seen);
      } catch {
        // unreadable: stale
      }
      if (holder && Number.isInteger(holder.pid) && pidAlive(holder.pid)) {
        pause(20);
        continue;
      }
      const claim = `${lockPath}.${crypto.createHash('sha256').update(seen).digest('hex').slice(0, 16)}.claim`;
      const mine = `${tmp}.claim`;
      fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now() }));
      try {
        fs.linkSync(mine, claim);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        pause(20);
        continue;
      } finally {
        fs.rmSync(mine, { force: true });
      }
      try {
        if (fs.readFileSync(lockPath, 'utf8') === seen) fs.unlinkSync(lockPath);
      } catch {
        // gone already
      } finally {
        fs.rmSync(claim, { force: true });
      }
    }
    throw new Error(`the lock ${lockPath} stayed held for 10 s; run this again`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Each shared file's records for one instance: { get(prefix) -> the records (null: none), drop(prefix) -> what was
 * taken out (null: nothing) }. Exact matches only: another instance's name is never a prefix or a pattern here.
 */
const SHARED = {
  gpu: {
    file: P.gpu,
    // Written and changed only by testrun-gpu.sh (its strict form); instance-remove.sh runs its disable.
    get: (prefix, name) => {
      const j = readJson(at(prefix, P.gpu));
      const v = j && j.instances && Object.prototype.hasOwnProperty.call(j.instances, name) ? j.instances[name] : null;
      return v ? { devices: v.devices } : null;
    },
  },
  'claude-profiles': {
    file: P.profiles,
    get: (prefix, name) => profileRecords(readJson(at(prefix, P.profiles)), name),
    drop: (prefix, name) => {
      const f = at(prefix, P.profiles);
      const p = readJson(f);
      const taken = profileRecords(p, name);
      if (!taken) return null;
      if (p.active) delete p.active[name];
      if (p.switched_at) delete p.switched_at[name];
      if (p.failover && p.failover.instances) delete p.failover.instances[name];
      for (const [pname, e] of Object.entries(p.profiles || {})) {
        if (!e || typeof e !== 'object') continue;
        for (const [u, r] of Object.entries(e.users || {})) if (r && r.instance === name) delete e.users[u];
        // A profile added for this instance alone (from its dashboard), or one no user is left on, goes with it.
        if (e.instance === name || (e.kind !== 'existing' && e.users && !Object.keys(e.users).length && taken.profiles.includes(pname))) delete p.profiles[pname];
      }
      writeKeeping(f, JSON.stringify(p) + '\n');
      return taken;
    },
  },
  'claude-status': {
    file: P.status,
    get: (prefix, name) => {
      const s = readJson(at(prefix, P.status));
      const mine = s && Array.isArray(s.users) ? s.users.filter((u) => u && u.instance === name) : [];
      return mine.length ? mine : null;
    },
    drop: (prefix, name) => {
      const f = at(prefix, P.status);
      const s = readJson(f);
      const mine = s && Array.isArray(s.users) ? s.users.filter((u) => u && u.instance === name) : [];
      if (!mine.length) return null;
      s.users = s.users.filter((u) => !(u && u.instance === name));
      writeKeeping(f, JSON.stringify(s) + '\n');
      return mine;
    },
  },
  'claude-paused': {
    file: P.paused,
    get: (prefix, name) => (pausedLines(at(prefix, P.paused)).includes(name) ? [name] : null),
    drop: (prefix, name) => {
      const f = at(prefix, P.paused);
      const lines = pausedLines(f);
      if (!lines.includes(name)) return null;
      const rest = lines.filter((l) => l !== name);
      writeKeeping(f, rest.length ? rest.join('\n') + '\n' : '');
      return [name];
    },
  },
  canary: {
    file: P.updates,
    get: (prefix, name) => {
      const u = readJson(at(prefix, P.updates));
      return u && u.canary && u.canary.instance === name ? { canary: u.canary } : null;
    },
    drop: (prefix, name) => {
      const f = at(prefix, P.updates);
      const u = readJson(f);
      if (!(u && u.canary && u.canary.instance === name)) return null;
      const taken = { canary: u.canary, state: readJson(at(prefix, P.canaryState)) ?? null };
      delete u.canary;
      writeKeeping(f, JSON.stringify(u, null, 2) + '\n');
      // The canary run in progress, if any, was this instance's: with no canary configured nothing would ever finish it.
      fs.rmSync(at(prefix, P.canaryState), { force: true });
      return taken;
    },
  },
  incidents: {
    file: `${P.slots}/${INCIDENTS}`,
    get: (prefix, name) => {
      const j = readJson(path.join(at(prefix, P.slots), INCIDENTS));
      const mine = j && Array.isArray(j.incidents) ? j.incidents.filter((x) => x && x.instance === name) : [];
      return mine.length ? mine : null;
    },
    drop: (prefix, name) => {
      const dir = at(prefix, P.slots);
      const f = path.join(dir, INCIDENTS);
      if (!fs.existsSync(f)) return null;
      return withLock(path.join(dir, INCIDENTS_LOCK), () => {
        const j = readJson(f);
        const mine = j && Array.isArray(j.incidents) ? j.incidents.filter((x) => x && x.instance === name) : [];
        if (!mine.length) return null;
        j.incidents = j.incidents.filter((x) => !(x && x.instance === name));
        writeKeeping(f, JSON.stringify(j), 0o660);
        return mine;
      });
    },
  },
  'pending-signers': {
    file: P.pending,
    get: (prefix, name) => {
      const j = readJson(at(prefix, P.pending));
      const mine = j && Array.isArray(j.pending) ? j.pending.filter((e) => e && e.instance === name) : [];
      return mine.length ? mine : null;
    },
    drop: (prefix, name) => {
      const f = at(prefix, P.pending);
      const j = readJson(f);
      const mine = j && Array.isArray(j.pending) ? j.pending.filter((e) => e && e.instance === name) : [];
      if (!mine.length) return null;
      j.pending = j.pending.filter((e) => !(e && e.instance === name));
      writeKeeping(f, JSON.stringify(j) + '\n');
      return mine;
    },
  },
};

function pausedLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** An instance's records in profiles.json: its active profile, switch time, failover, its users' records, and the profiles added for it alone. */
function profileRecords(p, name) {
  if (!p || typeof p !== 'object') return null;
  const out = { active: p.active && p.active[name] ? p.active[name] : null, switched_at: p.switched_at && p.switched_at[name] ? p.switched_at[name] : null, failover: p.failover && p.failover.instances && p.failover.instances[name] ? p.failover.instances[name] : null, users: {}, profiles: [] };
  for (const [pname, e] of Object.entries(p.profiles || {})) {
    if (!e || typeof e !== 'object') continue;
    let has = e.instance === name;
    for (const [u, r] of Object.entries(e.users || {})) {
      if (r && r.instance === name) {
        out.users[`${pname}/${u}`] = r;
        has = true;
      }
    }
    if (has) out.profiles.push(pname);
  }
  return out.active || out.switched_at || out.failover || out.profiles.length ? out : null;
}

/** What <name> has in each shared file: { item: records } for the ones it has. */
function plan(name, prefix = '') {
  if (!NAME.test(name)) throw new Error(`not an instance name: ${name}`);
  const out = {};
  for (const [id, s] of Object.entries(SHARED)) {
    const r = s.get(prefix, name);
    if (r) out[id] = r;
  }
  return out;
}

/**
 * Take <name>'s records out of every shared file but the GPU file (testrun-gpu.sh's own disable does that), keeping
 * what is taken in <archive> first: written root's 0600 before anything is changed, and again with what each step took.
 */
function remove(name, archive, prefix = '') {
  if (!NAME.test(name)) throw new Error(`not an instance name: ${name}`);
  const before = plan(name, prefix);
  const kept = { instance: name, at: new Date().toISOString(), records: before };
  writeArchive(archive, kept);
  const taken = {};
  for (const [id, s] of Object.entries(SHARED)) {
    if (!s.drop) continue;
    const r = s.drop(prefix, name);
    if (r) taken[id] = r;
  }
  writeArchive(archive, { ...kept, taken });
  return taken;
}

function writeArchive(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function main(argv) {
  const [cmd, name, archive] = argv;
  const usage = 'usage: instance-records.cjs items <name> | plan <name> | remove <name> <archive file>';
  if (!NAME.test(name || '')) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  if (cmd === 'items') {
    for (const i of items(name)) process.stdout.write(`${i.kind}\t${i.what}${i.when ? `\t${i.when.join(' ')}` : ''}\n`);
    return 0;
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    process.stderr.write('instance-records.cjs reads and changes root\'s files: run it as root (instance-remove.sh does)\n');
    return 1;
  }
  if (cmd === 'plan') {
    for (const [id, r] of Object.entries(plan(name))) process.stdout.write(`${id}\t${SHARED[id].file}\t${JSON.stringify(r)}\n`);
    return 0;
  }
  if (cmd === 'remove' && archive && path.isAbsolute(archive)) {
    const taken = remove(name, archive);
    for (const id of Object.keys(taken)) process.stdout.write(`removed ${name}'s ${id} records from ${SHARED[id].file}\n`);
    if (!Object.keys(taken).length) process.stdout.write(`no ${name} records left in the shared files\n`);
    return 0;
  }
  process.stderr.write(`${usage}\n`);
  return 2;
}

module.exports = { ITEMS, NOT_RECORDS, SHARED_FILES, SHARED, ARCHIVE_DIR, items, plan, remove, withLock, writeKeeping };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`instance-records: ${e.message}\n`);
    process.exitCode = 1;
  }
}

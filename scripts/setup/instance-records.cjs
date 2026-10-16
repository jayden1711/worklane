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
//   node instance-records.cjs rekey <old> <new> <archive>   move <old>'s records in the shared files to <new> (and its
//                                                       init record), keeping what they were in <archive> first
//   node instance-records.cjs carry <old> <new> <from dir> <to dir> <old home> <new home> <old agent home> <new agent home> [<old eval home> <new eval home>]
//                                                       the old instance home's files (never its state) into the new
//                                                       one, every path and user in them moved to the new name's;
//                                                       prints each file they name outside it, "<from>\t<to>", to copy
// As root, from instance-remove.sh and instance-rename.sh only: no sudoers rule and no helper command names this file.
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
// And what instance-rename.sh does with each, `rename`:
//   new     the new name gets its own, from the script that makes it (instance.sh, service.sh, ...); the old one goes
//           with the old name's removal
//   rekey   the old name's records become the new name's, in place (`rekey` here; the GPU grant: testrun-gpu.sh)
//   move    the file itself moves to the new name (`rekey` here)
//   drop    the old one goes, and the new name gets none until it makes its own
const ITEMS = [
  { kind: 'via', rename: 'new', what: 'test-user.sh remove <name>', when: ['user:wl-test-<name>', 'path:/var/lib/worklane-test/<name>', 'unit:worklane-test-<name>-docker.service', 'sudoers:worklane-test-<name>'], by: 'test-user.sh install' },
  { kind: 'via', rename: 'rekey', what: 'testrun-gpu.sh disable <name>', when: ['shared:gpu'], by: 'testrun-gpu.sh enable' },
  { kind: 'unit', rename: 'new', what: 'worklane-dashboard-<name>.service', by: 'dashboards.sh' },
  { kind: 'unit', rename: 'new', what: 'worklane-<name>.service', by: 'service.sh' },
  { kind: 'unit', rename: 'new', what: 'worklane-test-<name>-docker.service', by: 'test-user.sh install' },
  { kind: 'shared', rename: 'rekey', what: 'gpu', by: 'testrun-gpu.sh enable' },
  { kind: 'shared', rename: 'rekey', what: 'claude-profiles', by: 'claude-account.sh profile-add|use|failover' },
  { kind: 'shared', rename: 'rekey', what: 'claude-status', by: 'claude-account.sh status|switch, add-project.sh' },
  { kind: 'shared', rename: 'rekey', what: 'claude-paused', by: 'claude-account.sh switch' },
  { kind: 'shared', rename: 'rekey', what: 'canary', by: 'docs/canary.md (an admin, in updates.json)' },
  { kind: 'shared', rename: 'rekey', what: 'incidents', by: 'the coordinator and the watchdog (src/watchdog/incidents.ts)' },
  { kind: 'shared', rename: 'rekey', what: 'pending-signers', by: "the machine helper's stage-update-signer" },
  { kind: 'path', rename: 'drop', what: '/var/lib/worklane/agent-slots/discord-claim-<name>.json', by: 'the coordinator (src/intake/discord-claims.ts)' },
  { kind: 'path', rename: 'move', what: '/var/lib/worklane/init/<name>.json', by: 'init --mode server (src/init.ts serverInitFile)' },
  { kind: 'sudoers', rename: 'new', what: 'worklane-test-<name>', by: 'test-user.sh install' },
  { kind: 'sudoers', rename: 'new', what: 'worklane-<name>', by: 'instance.sh' },
  { kind: 'path', rename: 'new', what: '/var/lib/worklane-test/<name>', by: 'test-user.sh install' },
  { kind: 'path', rename: 'new', what: '/srv/worklane/<name>', by: 'instance.sh, checkout.sh' },
  { kind: 'user', rename: 'new', what: 'wl-test-<name>', by: 'test-user.sh install' },
  { kind: 'user', rename: 'new', what: 'wl-<name>-eval', by: 'instance.sh --eval' },
  { kind: 'user', rename: 'new', what: 'wl-<name>-agent', by: 'instance.sh' },
  { kind: 'user', rename: 'new', what: 'wl-<name>', by: 'instance.sh (its home: the instance state, its App key and credentials)' },
  { kind: 'group', rename: 'new', what: 'wl-<name>-work', by: 'instance.sh' },
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
  { at: '/var/lib/worklane/renames', why: "instance-rename.sh's progress and the parked coordinator unit of a rename under way (root's 0700)" },
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

/** One of <old>'s users or unit names as <new>'s; anything else as it was. */
function userAs(u, old, nu) {
  for (const [a, b] of [[`wl-${old}`, `wl-${nu}`], [`wl-${old}-agent`, `wl-${nu}-agent`], [`wl-${old}-eval`, `wl-${nu}-eval`], [`wl-test-${old}`, `wl-test-${nu}`]]) if (u === a) return b;
  return u;
}
/** An incident's key, when it names <old>: its name alone, <old>#<issue>, its units or its users. */
function keyAs(k, old, nu) {
  if (k === old) return nu;
  if (typeof k === 'string' && k.startsWith(`${old}#`)) return `${nu}${k.slice(old.length)}`;
  for (const [a, b] of [[`worklane-${old}.service`, `worklane-${nu}.service`], [`worklane-dashboard-${old}.service`, `worklane-dashboard-${nu}.service`], [`worklane-test-${old}-docker.service`, `worklane-test-${nu}-docker.service`]]) if (k === a) return b;
  return userAs(k, old, nu);
}

/** Each shared file's records of <old> made <new>'s, in place: { file, rekey(prefix, old, new) -> what changed (null: nothing) }. */
const REKEY = {
  'claude-profiles': (prefix, old, nu) => {
    const f = at(prefix, P.profiles);
    const p = readJson(f);
    if (!profileRecords(p, old)) return null;
    for (const k of ['active', 'switched_at']) if (p[k] && Object.prototype.hasOwnProperty.call(p[k], old)) { p[k][nu] = p[k][old]; delete p[k][old]; }
    if (p.failover && p.failover.instances && p.failover.instances[old]) { p.failover.instances[nu] = p.failover.instances[old]; delete p.failover.instances[old]; }
    for (const e of Object.values(p.profiles || {})) {
      if (!e || typeof e !== 'object') continue;
      if (e.instance === old) e.instance = nu;
      const users = {};
      for (const [u, r] of Object.entries(e.users || {})) {
        if (r && r.instance === old) users[userAs(u, old, nu)] = { ...r, instance: nu, user: userAs(r.user, old, nu) };
        else users[u] = r;
      }
      if (e.users) e.users = users;
    }
    writeKeeping(f, JSON.stringify(p) + '\n');
    return true;
  },
  'claude-status': (prefix, old, nu) => {
    const f = at(prefix, P.status);
    const s = readJson(f);
    if (!(s && Array.isArray(s.users) && s.users.some((u) => u && u.instance === old))) return null;
    s.users = s.users.map((u) => (u && u.instance === old ? { ...u, instance: nu, user: userAs(u.user, old, nu) } : u));
    writeKeeping(f, JSON.stringify(s) + '\n');
    return true;
  },
  'claude-paused': (prefix, old, nu) => {
    const f = at(prefix, P.paused);
    const lines = pausedLines(f);
    if (!lines.includes(old)) return null;
    const next = [...new Set(lines.map((l) => (l === old ? nu : l)))];
    writeKeeping(f, next.join('\n') + '\n');
    return true;
  },
  canary: (prefix, old, nu) => {
    const f = at(prefix, P.updates);
    const u = readJson(f);
    if (!(u && u.canary && u.canary.instance === old)) return null;
    u.canary.instance = nu;
    writeKeeping(f, JSON.stringify(u, null, 2) + '\n');
    return true;
  },
  incidents: (prefix, old, nu) => {
    const dir = at(prefix, P.slots);
    const f = path.join(dir, INCIDENTS);
    if (!fs.existsSync(f)) return null;
    return withLock(path.join(dir, INCIDENTS_LOCK), () => {
      const j = readJson(f);
      if (!(j && Array.isArray(j.incidents) && j.incidents.some((x) => x && x.instance === old))) return null;
      j.incidents = j.incidents.map((x) => (x && x.instance === old ? { ...x, instance: nu, key: keyAs(x.key, old, nu) } : x));
      writeKeeping(f, JSON.stringify(j), 0o660);
      return true;
    });
  },
  'pending-signers': (prefix, old, nu) => {
    const f = at(prefix, P.pending);
    const j = readJson(f);
    if (!(j && Array.isArray(j.pending) && j.pending.some((e) => e && e.instance === old))) return null;
    j.pending = j.pending.map((e) => (e && e.instance === old ? { ...e, instance: nu, by: userAs(e.by, old, nu) } : e));
    writeKeeping(f, JSON.stringify(j) + '\n');
    return true;
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

/**
 * Move <old>'s records in the shared files to <new> (never the GPU grant: testrun-gpu.sh's own disable and enable do
 * that, in its strict form), its init record to <new>.json, and drop its Discord claim (<new>'s coordinator makes its
 * own). What <old> had is kept in <archive> first.
 */
function rekey(old, nu, archive, prefix = '') {
  if (!NAME.test(old) || !NAME.test(nu) || old === nu) throw new Error('rekey: two different instance names');
  // Two instances' records are never merged: a file where both have some stops it. (A file where only <new> has some
  // was moved by an earlier run that stopped part way.)
  const before = plan(old, prefix);
  const both = Object.keys(plan(nu, prefix)).filter((id) => id !== 'gpu' && before[id]);
  if (both.length) throw new Error(`${old} and ${nu} both have records in ${both.join(', ')}: nothing moved`);
  writeArchive(archive, { instance: old, renamed_to: nu, at: new Date().toISOString(), records: before });
  const moved = [];
  for (const [id, f] of Object.entries(REKEY)) if (f(prefix, old, nu)) moved.push(id);
  const init = (n) => at(prefix, `/var/lib/worklane/init/${n}.json`);
  if (fs.existsSync(init(old))) {
    const j = readJson(init(old)) || {};
    if (j.instance === old) j.instance = nu;
    writeKeeping(init(old), JSON.stringify(j, null, 2) + '\n', 0o640);
    fs.renameSync(init(old), init(nu));
    moved.push('init');
  }
  fs.rmSync(at(prefix, `${P.slots}/discord-claim-${old}.json`), { force: true });
  return moved;
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name or path as a whole: not followed by a character that would make it a longer one. */
const whole = (x) => new RegExp(`${esc(x)}(?![A-Za-z0-9_.-])`, 'g');

/**
 * The text with every path and user of <old> made <new>'s: its homes, its config dirs, its state, its checkout root,
 * its users, and instance.yaml's name. Throws, naming what is left, when anything of <old>'s would remain.
 */
function moveText(text, h) {
  const { old, nu } = h;
  const pairs = [
    [`${h.oldHome}/.config/${old}-`, `${h.newHome}/.config/${nu}-`],
    [`${h.oldHome}/.local/state/worklane/instances/${old}`, `${h.newHome}/.local/state/worklane/instances/${nu}`],
    ...(h.oldEval ? [[h.oldEval, h.newEval]] : []),
    [h.oldAgent, h.newAgent],
    [h.oldHome, h.newHome],
    [`/srv/worklane/${old}`, `/srv/worklane/${nu}`],
    [`wl-${old}-agent`, `wl-${nu}-agent`],
    [`wl-${old}-eval`, `wl-${nu}-eval`],
    [`wl-${old}`, `wl-${nu}`],
  ];
  let out = text;
  for (const [a, b] of pairs) out = out.replace(a.endsWith('-') ? new RegExp(esc(a), 'g') : whole(a), b);
  out = out.replace(new RegExp(`^name: *${esc(old)} *$`, 'm'), `name: ${nu}`);
  const left = [h.oldHome, h.oldAgent, ...(h.oldEval ? [h.oldEval] : []), `/srv/worklane/${old}`, `wl-${old}`].filter((x) => whole(x).test(out));
  if (new RegExp(`^name: *${esc(old)} *$`, 'm').test(out)) left.push(`name: ${old}`);
  if (left.length) throw new Error(`still names ${left.join(', ')} after the move`);
  return out;
}

/**
 * The old instance home's files (never its state/) into the new one: each regular file, its text moved to the new
 * name's (moveText), its mode kept; the new home's own instance.yaml replaced by the old one's, moved. Everything is
 * worked out before anything is written. Returns the files they name outside the instance home, to copy: [from, to].
 */
function carry(h, fromDir, toDir) {
  const out = [];
  const plan = [];
  for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (e.name === 'state') continue;
    const src = path.join(fromDir, e.name);
    if (!e.isFile()) {
      out.push({ skipped: src });
      continue;
    }
    const text = fs.readFileSync(src, 'utf8');
    let moved;
    try {
      moved = moveText(text, h);
    } catch (err) {
      throw new Error(`${src}: ${err.message}; nothing carried`);
    }
    plan.push([path.join(toDir, e.name), moved, fs.statSync(src).mode & 0o777]);
    for (const m of text.matchAll(new RegExp(`(?:${[h.oldHome, h.oldAgent, ...(h.oldEval ? [h.oldEval] : [])].map(esc).join('|')})/[^\\s"'#,}\\]]+`, 'g'))) {
      const from = m[0];
      if (from.startsWith(`${h.oldHome}/.local/state/worklane/instances/${h.old}/`) || from.startsWith(`${h.oldHome}/.config/${h.old}-`)) continue; // the state, and the config dirs: carried whole
      if (fs.existsSync(from) && !out.some((x) => x.from === from)) out.push({ from, to: moveText(from, h) });
    }
  }
  for (const [file, text, mode] of plan) {
    fs.writeFileSync(`${file}.carry.tmp`, text, { mode });
    fs.chmodSync(`${file}.carry.tmp`, mode);
    fs.renameSync(`${file}.carry.tmp`, file);
  }
  return out;
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
  const usage = 'usage: instance-records.cjs items <name> | plan <name> | remove <name> <archive file> | rekey <old> <new> <archive file> | carry <old> <new> <from dir> <to dir> <old home> <new home> <old agent home> <new agent home> [<old eval home> <new eval home>]';
  if (!NAME.test(name || '')) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  if (cmd === 'items') {
    for (const i of items(name)) process.stdout.write(`${i.kind}\t${i.what}\t${i.when ? i.when.join(' ') : '-'}\t${i.rename}\n`);
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
  if (cmd === 'carry' && NAME.test(archive || '') && argv.length >= 9) {
    const [, old, nu, from, to, oldHome, newHome, oldAgent, newAgent, oldEval, newEval] = argv;
    if (![from, to, oldHome, newHome, oldAgent, newAgent].every((x) => path.isAbsolute(x) && x !== '/')) throw new Error('carry: absolute directories');
    for (const x of carry({ old, nu, oldHome, newHome, oldAgent, newAgent, ...(oldEval && newEval ? { oldEval, newEval } : {}) }, from, to)) {
      if (x.skipped) process.stderr.write(`not carried (not a file): ${x.skipped}\n`);
      else process.stdout.write(`${x.from}\t${x.to}\n`);
    }
    return 0;
  }
  if (cmd === 'rekey' && NAME.test(archive || '') && argv[3] && path.isAbsolute(argv[3])) {
    const moved = rekey(name, archive, argv[3]);
    process.stdout.write(moved.length ? `moved ${name}'s records to ${archive}: ${moved.join(', ')}\n` : `no ${name} records in the shared files\n`);
    return 0;
  }
  process.stderr.write(`${usage}\n`);
  return 2;
}

module.exports = { ITEMS, NOT_RECORDS, SHARED_FILES, SHARED, REKEY, ARCHIVE_DIR, items, plan, remove, rekey, carry, moveText, withLock, writeKeeping };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`instance-records: ${e.message}\n`);
    process.exitCode = 1;
  }
}

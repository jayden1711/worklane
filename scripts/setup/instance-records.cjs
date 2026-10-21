#!/usr/bin/env node
// Every place outside an instance's own users' homes that holds its name: the registry instance-remove.sh removes
// from, and that a test keeps whole (test/instance-records.test.ts fails on a setup or machine script, or src/, that
// names a per-instance root path, or a file under /etc/worklane or /var/lib/worklane, this file doesn't list).
// A feature that adds a per-instance root record adds it here, with how it goes, and instance-remove.sh removes it.
//
//   node instance-records.cjs items <name>              every item, one a line: <kind> <what> (exists or not)
//   node instance-records.cjs engine-places x           the engine's own places a removal re-owns orphaned files in
//   node instance-records.cjs rechown x <uids> <gids>   give the paths on stdin (NUL-separated) to root, one fd each
//   node instance-records.cjs root-ids x                the ids rechown gives files to, "<uid>:<gid>" (root's: 0:0)
//   node instance-records.cjs hold-slot x <pid> <name>   an agent slot held for <pid>: the updater waits (prints its path)
//   node instance-records.cjs release-slot x <path> <pid>
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
//   glob     rm -f of each file named <what> followed by anything (the name then a dot: never another instance's)
//   shared   a record inside a shared root file, taken out by `remove` here
// And, last, the egress rule (egress-firewall.sh) applied again when it names a uid of a user that went: it is
// rebuilt from the users there are, so no other instance's entry changes. An experiment job's output volume left
// mounted (its job cut off) is unmounted first, when it is positively the engine's (lib.sh instance_mounts).
// <name> stands for the instance's name. Order is the order of removal: users and the state go last, after the export.
// And what instance-rename.sh does with each, `rename`:
//   new     the new name gets its own, from the script that makes it (instance.sh, service.sh, ...); the old one goes
//           with the old name's removal
//   rekey   the old name's records become the new name's, in place (`rekey` here; the GPU grant: testrun-gpu.sh)
//   move    the file itself moves to the new name (`rekey` here)
//   drop    the old one goes, and the new name gets none until it makes its own: instance-rename.sh says so, with the
//           item's `note` (every drop has one)
const ITEMS = [
  { kind: 'via', rename: 'new', what: 'test-user.sh remove <name>', when: ['user:wl-test-<name>', 'path:/var/lib/worklane-test/<name>', 'unit:worklane-test-<name>-docker.service', 'sudoers:worklane-test-<name>'], by: 'test-user.sh install' },
  { kind: 'via', rename: 'drop', note: "experiments aren't moved: install them for the new name (experiments.sh install, set, data add); the old jobs' records are archived first", what: 'experiments.sh remove <name>', when: ['user:wl-exp-<name>', 'user:wl-score-<name>', 'path:/var/lib/worklane-exp/<name>', 'path:/etc/worklane/experiments/<name>.json', 'sudoers:worklane-exp-<name>'], by: 'experiments.sh install' },
  { kind: 'via', rename: 'rekey', what: 'testrun-network.sh disable <name>', when: ['shared:testrun-net'], by: 'testrun-network.sh enable' },
  { kind: 'via', rename: 'rekey', what: 'testrun-gpu.sh disable <name>', when: ['shared:gpu'], by: 'testrun-gpu.sh enable' },
  { kind: 'unit', rename: 'new', what: 'worklane-dashboard-<name>.service', by: 'dashboards.sh' },
  { kind: 'unit', rename: 'new', what: 'worklane-<name>.service', by: 'service.sh' },
  { kind: 'unit', rename: 'new', what: 'worklane-test-<name>-docker.service', by: 'test-user.sh install' },
  { kind: 'unit', rename: 'drop', note: "its MCP broker isn't moved: mcp-broker.sh <new>, then install its servers' secrets again", what: 'worklane-mcp@<name>.service', by: 'mcp-broker.sh (an instance of the machine-wide template worklane-mcp@.service, which stays)' },
  { kind: 'shared', rename: 'rekey', what: 'gpu', by: 'testrun-gpu.sh enable' },
  { kind: 'shared', rename: 'rekey', what: 'testrun-net', by: 'testrun-network.sh enable' },
  { kind: 'shared', rename: 'rekey', what: 'claude-profiles', by: 'claude-account.sh profile-add|use|failover' },
  { kind: 'shared', rename: 'rekey', what: 'claude-status', by: 'claude-account.sh status|switch, add-project.sh' },
  { kind: 'shared', rename: 'rekey', what: 'claude-paused', by: 'claude-account.sh switch' },
  { kind: 'shared', rename: 'rekey', what: 'canary', by: 'docs/canary.md (an admin, in updates.json)' },
  { kind: 'shared', rename: 'rekey', what: 'incidents', by: 'the coordinator and the watchdog (src/watchdog/incidents.ts)' },
  { kind: 'shared', rename: 'rekey', what: 'pending-signers', by: "the machine helper's stage-update-signer" },
  { kind: 'shared', rename: 'drop', note: "staged plugin approvals aren't moved: stage them again for the new name", what: 'plugin-pending', by: "the machine helper's plugin-stage" },
  { kind: 'shared', rename: 'drop', note: 'the new name is no instance add-project is creating: the rename adds its coordinator to the machine helper\'s rule itself', what: 'add-project-new', by: 'instance.sh, as it makes the coordinator (#898); machine-helper.sh takes it off' },
  { kind: 'shared', rename: 'drop', note: "root's word that its repo is a managed app isn't moved: every self-modification lock applies to the new name until root runs managed-apps.sh add <new> <owner/repo>", what: 'managed-apps', by: 'managed-apps.sh add' },
  { kind: 'path', rename: 'drop', note: "the new name's coordinator writes its own when its chat bot connects", what: '/var/lib/worklane/agent-slots/discord-claim-<name>.json', by: 'the coordinator (src/intake/discord-claims.ts)' },
  { kind: 'path', rename: 'drop', note: "plugins aren't moved: approve them again for the new name (plugins.sh confirm); its MCP broker and secrets aren't either (mcp-broker.sh <new>, then its secrets)", what: '/etc/worklane/plugins/<name>.json', by: 'plugins.sh confirm (the allowlist)' },
  { kind: 'path', rename: 'drop', note: "plugins aren't moved: approve them again for the new name (plugins.sh confirm); its MCP broker and secrets aren't either (mcp-broker.sh <new>, then its secrets)", what: '/var/lib/worklane/plugins/previews/<name>', by: "the machine helper's plugin-fetch" },
  { kind: 'path', rename: 'drop', note: "plugins aren't moved: approve them again for the new name (plugins.sh confirm); its MCP broker and secrets aren't either (mcp-broker.sh <new>, then its secrets)", what: '/var/lib/worklane/plugins/store/<name>', by: 'plugins.sh confirm (approved plugins, and the empty root)' },
  { kind: 'path', rename: 'drop', note: "plugins aren't moved: approve them again for the new name (plugins.sh confirm); its MCP broker and secrets aren't either (mcp-broker.sh <new>, then its secrets)", what: '/var/lib/worklane/plugins/fetch-status/<name>.json', by: 'plugins.sh fetch' },
  { kind: 'path', rename: 'drop', note: "its MCP broker isn't moved: mcp-broker.sh <new>, then install its servers' secrets again", what: '/var/lib/worklane-mcp-<name>', by: "worklane-mcp@<name>.service's StateDirectory" },
  { kind: 'path', rename: 'move', what: '/var/lib/worklane/init/<name>.json', by: 'init --mode server (src/init.ts serverInitFile)' },
  { kind: 'path', rename: 'new', what: '/etc/worklane/policy-root/<name>', by: "add-project.sh's policy step (worklane policy own: its policy.yaml is root's); instance-rename.sh makes the new name's when the old one's was" },
  { kind: 'sudoers', rename: 'drop', note: 'goes with the experiments', what: 'worklane-exp-<name>', by: 'experiments.sh install' },
  { kind: 'path', rename: 'drop', note: 'goes with the experiments (archived first)', what: '/etc/worklane/experiments/<name>.json', by: 'experiments.sh install, set, data' },
  { kind: 'path', rename: 'drop', note: 'goes with the experiments (job records archived first)', what: '/var/lib/worklane-exp/<name>', by: 'experiments.sh install; the experiment helper' },
  { kind: 'glob', rename: 'drop', note: "a job's runtime environment file: none outlives its job", what: '/run/worklane-exp-env/<name>.', by: 'the experiment helper (a job runtime environment file)' },
  { kind: 'sudoers', rename: 'new', what: 'worklane-test-<name>', by: 'test-user.sh install' },
  { kind: 'sudoers', rename: 'new', what: 'worklane-<name>', by: 'instance.sh' },
  { kind: 'path', rename: 'new', what: '/var/lib/worklane-test/<name>', by: 'test-user.sh install' },
  { kind: 'path', rename: 'new', what: '/srv/worklane/<name>', by: 'instance.sh, checkout.sh' },
  { kind: 'user', rename: 'drop', note: 'goes with the experiments', what: 'wl-exp-<name>', by: 'experiments.sh install' },
  { kind: 'user', rename: 'drop', note: 'goes with the experiments', what: 'wl-score-<name>', by: 'experiments.sh install' },
  { kind: 'user', rename: 'new', what: 'wl-test-<name>', by: 'test-user.sh install' },
  { kind: 'user', rename: 'drop', note: "its MCP broker isn't moved: mcp-broker.sh <new>, then install its servers' secrets again", what: 'wl-<name>-mcp', by: 'mcp-broker.sh (its home: the MCP servers\' secrets)' },
  { kind: 'user', rename: 'new', what: 'wl-<name>-eval', by: 'instance.sh --eval' },
  { kind: 'user', rename: 'new', what: 'wl-<name>-agent', by: 'instance.sh' },
  { kind: 'user', rename: 'new', what: 'wl-<name>', by: 'instance.sh (its home: the instance state, its App key and credentials)' },
  // After the instance's users (#726): while wl-<name> is there it can still start, so an auto_merge off for it must
  // still find its id. Its id's switches (policy-root/by_id/<id>/) go at the removal's end, once no name points at them.
  { kind: 'path', rename: 'new', what: '/etc/worklane/policy-root/<name>.id', by: "worklane policy own, or the first auto_merge off (root's pointer to the instance's id: its kill switches live in policy-root/by_id/<id>/); instance-rename.sh points the new name at the same id at its start (policy alias), so no switch is ever carried" },
  { kind: 'group', rename: 'new', what: 'wl-<name>-work', by: 'instance.sh' },
  { kind: 'group', rename: 'drop', note: "its MCP broker isn't moved: mcp-broker.sh <new>, then install its servers' secrets again", what: 'wl-<name>-mcpc', by: "mcp-broker.sh (the broker's client socket)" },
  { kind: 'group', rename: 'drop', note: "its MCP broker isn't moved: mcp-broker.sh <new>, then install its servers' secrets again", what: 'wl-<name>-mcpctl', by: "mcp-broker.sh (the broker's control socket)" },
];

// What names an instance in the scripts and src/ without being a record of its own: each is part of an item above
// (its runtime directory, a home path, a unit-name prefix), or not an instance at all. The registry test accepts a
// name found in the code when it is part of an item's `what`, or listed here.
const NOT_RECORDS = [
  { what: '/run/worklane-test-<name>-docker', why: "the test Docker unit's RuntimeDirectory: systemd removes it with the unit" },
  { what: 'worklane-test-<name>_', why: "a test run's transient units since the helper's protocol 9 (worklane-test-<name>_<id>_<pid>, its _fetch_ and _net_ units): gone when the run ends; a run in flight refuses the removal, and the kill step stops any left whose User= is the instance's" },
  { what: 'worklane-test-<name>-', why: "a test run's transient unit (worklane-test-<name>-<id>-<pid>): gone when the run ends; a run in flight refuses the removal" },
  { what: '/.local/state/worklane/instances/<name>', why: "the instance's state, in wl-<name>'s home: exported, then removed with the user" },
  { what: 'worklane-ci-<name>', why: "ci-runner.sh's self-hosted CI runner: a runner's name, not an instance" },
  { what: '/etc/worklane-ci/', why: "ci-runner.sh's runner files: a runner's name, not an instance" },
  { what: '/var/lib/worklane-ci/<name>', why: "ci-runner.sh's runner state: a runner's name, not an instance" },
  { what: '/run/worklane-ci-<name>', why: "ci-runner.sh's runner Docker: a runner's name, not an instance" },
  { what: 'worklane_ci_', why: "ci-runner.sh's nftables names: a runner's name, not an instance" },
  { what: 'wl-ci-<name>', why: "ci-runner.sh's runner user: a runner's name, not an instance" },
  { what: '<name>-worklane', why: "the instance's GitHub App's name (src/setup/app-manifest.ts): GitHub's, never removed here; instance-remove.sh prints what to do there" },
  { what: '/run/worklane-mcp-<name>', why: "worklane-mcp@<name>.service's RuntimeDirectory (its sockets): systemd removes it with the unit" },
  { what: 'worklane-exp-<name>_', why: "an experiment job's transient unit (worklane-exp-<name>_<job>_<step>_<pid>): gone when the job ends; a job in flight (its users' processes) refuses the removal" },
  { what: '/run/worklane/gpu/<name>.lock', why: "a GPU's lock, by its index, machine-wide: held (flock) only by a live test-run or job helper, which a run in flight refuses the removal for; another instance's hold is never touched" },
];

// Every file and directory directly under /etc/worklane and /var/lib/worklane (and the /var/lib/worklane-* roots):
// either it names instances inside (the item that takes an instance's out), or it is the machine's (why).
const SHARED_FILES = [
  { at: '/etc/worklane/testrun-gpu.json', item: 'gpu' },
  { at: '/etc/worklane/testrun-network.json', item: 'testrun-net' },
  { at: '/etc/worklane/updates.json', item: 'canary' },
  { at: '/var/lib/worklane/claude-account', item: 'claude-profiles, claude-status, claude-paused (switch.jsonl, profile-ops.jsonl: logs, kept)' },
  { at: '/var/lib/worklane/agent-slots', item: 'incidents, discord-claim-<name>.json (the slot locks name no instance)' },
  { at: '/var/lib/worklane/pending-signers.json', item: 'pending-signers' },
  { at: '/var/lib/worklane/add-project-new', item: 'add-project-new' },
  { at: '/var/lib/worklane/init', item: '/var/lib/worklane/init/<name>.json' },
  { at: '/var/lib/worklane/canary.json', item: "canary (the canary run in progress: taken with updates.json's canary)" },
  { at: '/var/lib/worklane-test', item: '/var/lib/worklane-test/<name>' },
  { at: '/etc/worklane/plugins', item: '/etc/worklane/plugins/<name>.json' },
  { at: '/etc/worklane/policy-root', item: '/etc/worklane/policy-root/<name>' },
  { at: '/var/lib/worklane/plugins', item: 'plugin-pending (pending.json), previews/<name>, store/<name>, fetch-status/<name>.json (fetches.jsonl: a log, kept)' },
  { at: '/etc/worklane/managed-apps.json', item: 'managed-apps' },
  { at: '/etc/worklane/plugin-hosts.json', why: 'the hosts any plugin may come from: the machine\'s, no instance in it' },
  { at: '/etc/worklane/mcp-registries.json', why: 'the npm registries any MCP server may come from: the machine\'s, no instance in it' },
  { at: '/var/lib/worklane-mcp', item: "/var/lib/worklane-mcp-<name>: each instance's MCP broker's StateDirectory" },
  { at: '/var/lib/worklane-exp', item: '/var/lib/worklane-exp/<name> (experiments.sh remove)' },
  { at: '/etc/worklane/experiments', item: '/etc/worklane/experiments/<name>.json (experiments.sh remove)' },
  { at: '/etc/worklane/egress.nft', item: "egress: the sandbox users' uids, rebuilt by egress-firewall.sh apply once an instance's are gone" },
  { at: '/etc/worklane/egress.users', item: 'egress: the uids the rule covers, as egress-firewall.sh apply last wrote them' },
  { at: '/etc/worklane/allowed_signers', why: 'release signers: the machine updater' },
  { at: '/etc/worklane/slots.json', why: 'the machine slot cap' },
  { at: '/etc/worklane/machine-owners.json', why: 'the machine owners: GitHub logins' },
  { at: '/etc/worklane/helper-rules.json', why: "which helper rules this machine's sudo can take" },
  { at: '/etc/worklane/limits.json', why: "the machine's bounds on every instance's settings" },
  { at: '/etc/worklane/network.json', why: "the machine's proxy and CA" },
  { at: '/etc/worklane/providers.json', why: "the provider hosts any instance's provider runs may use: the machine's, no instance in it" },
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
  { at: '/var/lib/worklane/updater.json', why: "the installed updater's release version and sha256: no instance" },
  { at: '/etc/worklane/updater-no-self-update', why: "root's switch that turns the updater's self-update off: no instance" },
  { at: '/var/lib/worklane/tailscale', why: "tailscale.sh's steps for the hub: the asking coordinator's login link only while `up` waits" },
  { at: '/var/lib/worklane/renames', why: "instance-rename.sh's progress and the parked coordinator unit of a rename under way (root's 0700)" },
  { at: '/var/lib/worklane/removed', why: "instance-remove.sh's archive of removed instances' history (root's 0700)" },
  { at: '/var/lib/worklane-ci', why: "ci-runner.sh's runners: no instance" },
  { at: '/var/lib/worklane-build', why: "the updater's build directory: no instance" },
];

// The engine's own places, where a removed instance's users may have left a file another instance still uses (the
// incident store, a slot's lock): instance-remove.sh gives what they own there to root:root, never following a link
// and never crossing into another mount. Only these: the engine's state and config trees, and in /run/lock (the
// system's directory) only the engine's own lock files, by name. Anything else they own is listed, never changed.
const ENGINE_OWNED = { trees: ['/var/lib/worklane', '/etc/worklane'], locks: { dir: '/run/lock', name: 'worklane-*.lock' } };

const ARCHIVE_DIR = '/var/lib/worklane/removed';

// What a removal does to each file its users left there (lib.sh rechown_orphans walks them, find -P -xdev -uid):
// root's, on ONE fd opened without following a link (O_NOFOLLOW), so nothing renamed over the path mid-walk (the slot
// directory is 2770 with no sticky bit: any agent-slots member can rename there) is ever followed out of it. The fd's
// own fstat decides everything: still a removed uid's (else left as it is: another's now), its group (root when it was
// the instance's, else kept), its mode (a regular file: setuid and setgid off, and in a shared engine group (kept, not
// root) group write off too: the engine only puts a copy over its files there, never writes one in place). A link or
// a socket (no fd to open without following): lchown, which never follows; whatever is at that name is changed in
// place, never anything a link points at. Each listed, "<owner>:<group> <old mode> -> <new mode> <path>[ (g+w kept:
// <why>)]", or "left <path>: <why>", or "FAILED <path>: <why>" (the step fails).
function idNames(file) {
  const m = new Map();
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      const f = l.split(':');
      if (f.length > 2 && /^\d+$/.test(f[2]) && !m.has(Number(f[2]))) m.set(Number(f[2]), f[0]);
    }
  } catch {
    // unreadable: numbers
  }
  return m;
}

/** root's ids, or (a test, never as root) the ones INSTANCE_REMOVE_TEST_ROOT_IDS names, "<uid>:<gid>". */
function rootIds() {
  const t = process.env.INSTANCE_REMOVE_TEST_ROOT_IDS;
  if (t && typeof process.getuid === 'function' && process.getuid() !== 0 && /^\d+:\d+$/.test(t)) return t.split(':').map(Number);
  return [0, 0];
}

// A path is bytes, never text: a name that isn't UTF-8 is opened, changed and listed by its own bytes (decoded, it
// would name another path, or none). <p> is a Buffer; the result is the listing line around it: [before, after].
function rechownOne(p, uids, gids, [rootUid, rootGid], names) {
  const O = fs.constants;
  const owner = (st) => `${names.users.get(st.uid) ?? st.uid}:${names.groups.get(st.gid) ?? st.gid}`;
  const oct = (m) => (m & 0o7777).toString(8);
  let fd = null;
  try {
    try {
      fd = fs.openSync(p, O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK | O.O_NOCTTY);
    } catch (e) {
      if (e.code === 'ENOENT') return { line: ['left ', ': gone since the walk'] };
      if (e.code !== 'ELOOP' && e.code !== 'ENXIO') throw e;
      // A link (ELOOP) or a socket (ENXIO): the entry itself, by name, never followed.
      const st = fs.lstatSync(p);
      if (!uids.has(st.uid)) return { line: ['left ', ": not a removed user's now"] };
      fs.lchownSync(p, rootUid, gids.has(st.gid) ? rootGid : st.gid);
      const now = fs.lstatSync(p);
      return { line: [`${owner(now)} ${oct(st.mode)} -> ${oct(now.mode)} `, ''] };
    }
    const st = fs.fstatSync(fd);
    if (!uids.has(st.uid)) return { line: ['left ', ": not a removed user's now"] };
    const shared = !gids.has(st.gid) && st.gid !== 0;
    fs.fchownSync(fd, rootUid, gids.has(st.gid) ? rootGid : st.gid);
    let why = '';
    if (st.isFile()) fs.fchmodSync(fd, st.mode & 0o7777 & ~0o6000 & (shared ? ~0o020 : 0o7777));
    else if (st.isDirectory() && shared && st.mode & 0o020) why = ` (g+w kept: a directory: ${names.groups.get(st.gid) ?? st.gid}'s members add and replace the engine's files in it)`;
    const now = fs.fstatSync(fd);
    return { line: [`${owner(now)} ${oct(st.mode)} -> ${oct(now.mode)} `, why] };
  } catch (e) {
    // The code and the call only: the message names the path decoded, which may not be it.
    return { failed: true, line: ['FAILED ', `: ${e.code || 'error'} ${e.syscall || ''}`.trimEnd()] };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The paths (a Buffer, NUL-separated) given to root, as above: the listing (bytes), and whether any failed. */
function rechown(input, uidList, gidList, ids = rootIds()) {
  const nums = (s) => new Set(String(s).split(',').filter((x) => /^\d+$/.test(x)).map(Number));
  const uids = nums(uidList);
  const gids = nums(gidList);
  const names = { users: idNames('/etc/passwd'), groups: idNames('/etc/group') };
  const out = [];
  let failed = false;
  for (let at = 0; at < input.length; ) {
    let end = input.indexOf(0, at);
    if (end < 0) end = input.length;
    const p = input.subarray(at, end);
    at = end + 1;
    if (!p.length) continue;
    const r = rechownOne(p, uids, gids, ids, names);
    if (r.failed) failed = true;
    out.push(Buffer.from(r.line[0]), p, Buffer.from(`${r.line[1]}\n`));
  }
  return { out: Buffer.concat(out), failed };
}

// The engine updater waits while the machine isn't quiet: a live agent slot (agent-<n>.lock in the slot directory,
// its pid alive) is busy to it (scripts/machine/worklane-update.cjs quiet()). instance-remove.sh holds one for its
// whole run, with its own pid, so no update restarts the services mid-removal; a crashed run's is stale by that same
// rule (its pid dead). Indexes from 900: never one a coordinator takes (src/slots.ts takes 0-63).
const SLOTS_DIR = '/var/lib/worklane/agent-slots';
const HOLD_FROM = 900;
const HOLD_COUNT = 64;

/** Take an agent slot for <pid>, the src/locks.ts way (a file linked into place; a dead holder's taken over). Returns its path. */
function holdSlot(pid, owner, dir = SLOTS_DIR) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('hold: a pid');
  fs.mkdirSync(dir, { recursive: true });
  const info = JSON.stringify({ pid, owner, acquiredAt: new Date().toISOString() });
  for (let i = HOLD_FROM; i < HOLD_FROM + HOLD_COUNT; i++) {
    const f = path.join(dir, `agent-${i}.lock`);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, info, { mode: 0o644 });
    try {
      fs.linkSync(tmp, f);
      return f;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try {
        held = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        // unreadable: another index
      }
      if (held && Number.isInteger(held.pid) && !pidAlive(held.pid) && typeof held.owner === 'string' && held.owner.startsWith('instance-remove ')) {
        // One of ours from a run that died: taken over in place.
        fs.renameSync(tmp, f);
        return f;
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error(`no free agent slot to hold in ${dir}`);
}

/** Let go of a slot holdSlot took: only while it still holds <pid>. */
function releaseSlot(f, pid) {
  try {
    if (JSON.parse(fs.readFileSync(f, 'utf8')).pid === pid) fs.unlinkSync(f);
  } catch {
    // gone already
  }
}

/** The updater's own answer: is this machine quiet (it would update) with the slots there are now? */
function updaterQuiet(dir = SLOTS_DIR) {
  const upd = require('../machine/worklane-update.cjs');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // no slots: quiet
  }
  const entries = names.map((name) => {
    let j = {};
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) || {};
    } catch {
      // not a slot
    }
    return { name, pid: upd.slotPid(j.pid) };
  });
  return upd.quiet(entries, (p) => upd.slotPid(p) !== null && pidAlive(p));
}
const P = {
  net: '/etc/worklane/testrun-network.json',
  pluginPending: '/var/lib/worklane/plugins/pending.json',
  gpu: '/etc/worklane/testrun-gpu.json',
  updates: '/etc/worklane/updates.json',
  canaryState: '/var/lib/worklane/canary.json',
  profiles: '/var/lib/worklane/claude-account/profiles.json',
  status: '/var/lib/worklane/claude-account/status.json',
  paused: '/var/lib/worklane/claude-account/paused',
  slots: '/var/lib/worklane/agent-slots',
  pending: '/var/lib/worklane/pending-signers.json',
  addProjectNew: '/var/lib/worklane/add-project-new',
  managedApps: '/etc/worklane/managed-apps.json',
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
  'testrun-net': {
    file: P.net,
    // Written and changed only by testrun-network.sh (its strict form); instance-remove.sh runs its disable.
    get: (prefix, name) => {
      const j = readJson(at(prefix, P.net));
      const v = j && j.instances && Object.prototype.hasOwnProperty.call(j.instances, name) ? j.instances[name] : null;
      return v ? { tiers: v.tiers } : null;
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
  // Root's list of the instances being created (lib.sh ADD_PROJECT_NEW), one name a line: this one's.
  'add-project-new': {
    file: P.addProjectNew,
    get: (prefix, name) => (pausedLines(at(prefix, P.addProjectNew)).includes(name) ? [name] : null),
    drop: (prefix, name) => {
      const f = at(prefix, P.addProjectNew);
      const lines = pausedLines(f);
      if (!lines.includes(name)) return null;
      const rest = lines.filter((l) => l !== name);
      writeKeeping(f, rest.length ? rest.join('\n') + '\n' : '', 0o600);
      return [name];
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
  'plugin-pending': {
    file: P.pluginPending,
    get: (prefix, name) => {
      const j = readJson(at(prefix, P.pluginPending));
      const mine = j && Array.isArray(j.entries) ? j.entries.filter((e) => e && e.instance === name) : [];
      return mine.length ? mine : null;
    },
    drop: (prefix, name) => {
      const f = at(prefix, P.pluginPending);
      const j = readJson(f);
      const mine = j && Array.isArray(j.entries) ? j.entries.filter((e) => e && e.instance === name) : [];
      if (!mine.length) return null;
      j.entries = j.entries.filter((e) => !(e && e.instance === name));
      writeKeeping(f, JSON.stringify(j) + '\n');
      return mine;
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
  // Root's word on which instances' repos are managed apps (managed-apps.sh): this instance's entry, its repo.
  'managed-apps': {
    file: P.managedApps,
    get: (prefix, name) => {
      const j = readJson(at(prefix, P.managedApps));
      return j && j.apps && typeof j.apps === 'object' && Object.hasOwn(j.apps, name) ? { [name]: j.apps[name] } : null;
    },
    drop: (prefix, name) => {
      const f = at(prefix, P.managedApps);
      const j = readJson(f);
      if (!(j && j.apps && typeof j.apps === 'object' && Object.hasOwn(j.apps, name))) return null;
      const mine = { [name]: j.apps[name] };
      delete j.apps[name];
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
    const raw = fs.readFileSync(src);
    // A binary file is carried as it is: only text names paths and users.
    if (raw.includes(0)) {
      plan.push([path.join(toDir, e.name), raw, fs.statSync(src).mode & 0o777]);
      continue;
    }
    const text = raw.toString('utf8');
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
  if (cmd === 'hold-slot') {
    const f = holdSlot(Number(argv[2]), `instance-remove ${argv[3] || '?'}`);
    const q = updaterQuiet();
    if (q.quiet) {
      releaseSlot(f, Number(argv[2]));
      throw new Error(`held ${f}, but the updater would still call this machine quiet: nothing removed`);
    }
    process.stdout.write(`${f}\n`);
    return 0;
  }
  if (cmd === 'release-slot') {
    releaseSlot(argv[2], Number(argv[3]));
    return 0;
  }
  if (cmd === 'engine-places') {
    for (const t of ENGINE_OWNED.trees) process.stdout.write(`tree\t${t}\n`);
    process.stdout.write(`locks\t${ENGINE_OWNED.locks.dir}\t${ENGINE_OWNED.locks.name}\n`);
    return 0;
  }
  if (cmd === 'rechown') {
    // The walk's paths on stdin, NUL-separated; argv: the removed uids and the instance's gids, comma-separated.
    const r = rechown(fs.readFileSync(0), argv[2] || '', argv[3] || '');
    for (let o = 0; o < r.out.length; ) o += fs.writeSync(1, r.out, o);
    return r.failed ? 1 : 0;
  }
  if (cmd === 'root-ids') {
    process.stdout.write(`${rootIds().join(':')}\n`);
    return 0;
  }
  if (cmd === 'items') {
    for (const i of items(name)) process.stdout.write(`${i.kind}\t${i.what}\t${i.when ? i.when.join(' ') : '-'}\t${i.rename}\t${i.note || '-'}\n`);
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

module.exports = { holdSlot, releaseSlot, updaterQuiet, ENGINE_OWNED, ITEMS, NOT_RECORDS, SHARED_FILES, SHARED, REKEY, ARCHIVE_DIR, items, plan, remove, rekey, carry, moveText, withLock, writeKeeping };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`instance-records: ${e.message}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// CI only (the "add-project (real systemd)" job in .github/workflows/ci-slow.yml), on a real host with real sudo and
// real systemd: the engine updater set up through the machine helper, the way a dashboard asks for it. Each helper
// command is run as the coordinator through sudo (its real sudoers rule, from machine-helper.sh); everything else
// here runs as root, to look at what it left.
//   - install-updater: the installed engine's updates.sh. The updater root's, its timer active, its config off.
//   - add-update-signer: one line added to /etc/worklane/allowed_signers, root's, and nothing ever taken out of it.
//     A release tag signed with that key then verifies with the installed updater's own check (`git verify-tag`,
//     real ssh signatures); a tag signed with a key nobody added is refused, before and after.
//   - set-update-channel: the channel and nothing else.
//   - Any other argument list is refused by sudo itself, and changes nothing.
//
//   sudo node updater-setup-root.mjs <coordinator user>
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

assert.equal(process.getuid(), 0, 'run this as root');
const coordinator = process.argv[2];
assert.match(coordinator ?? '', /^wl-[a-z][a-z0-9-]*$/, 'usage: updater-setup-root.mjs <coordinator user>');
const HELPER = '/usr/local/libexec/worklane-machine';
const UPDATER = '/usr/local/libexec/worklane-update';
const CONFIG = '/etc/worklane/updates.json';
const SIGNERS = '/etc/worklane/allowed_signers';
const CHANGES = '/var/lib/worklane/machine-changes.jsonl';

/** The helper, as the coordinator, through sudo: exactly how its unit runs it. */
const helper = (...args) => spawnSync('sudo', ['-u', coordinator, 'sudo', '-n', HELPER, ...args], { encoding: 'utf8', cwd: '/' });
const ok = (...args) => {
  const r = helper(...args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stdout;
};
const owner = (f) => {
  const st = statSync(f);
  return `${st.uid}:${st.gid} ${(st.mode & 0o777).toString(8)}`;
};
const sha = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
const changes = () => readFileSync(CHANGES, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sh = (file, args, cwd = '/') => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- before: no updater on this machine
for (const f of [UPDATER, CONFIG, SIGNERS]) assert.ok(!existsSync(f), `${f} is already there`);
const early = helper('set-update-channel', 'main');
assert.equal(early.status, 1, 'a channel before the updater is installed');
assert.match(early.stderr, /updates\.json is missing: install the updater first/);
assert.ok(!existsSync(CONFIG), 'and no config appeared');

// ---- install-updater
const installed = ok('install-updater');
console.log(installed);
assert.equal(owner(UPDATER), '0:0 755');
assert.ok(readFileSync(UPDATER).equals(readFileSync('/opt/worklane/current/scripts/machine/worklane-update.cjs')), 'the installed engine\'s updater');
assert.equal(owner(CONFIG), '0:0 644');
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
assert.equal(cfg.enabled, false, 'installed off');
assert.equal(cfg.channel, 'release');
assert.equal(cfg.allowed_signers, SIGNERS);
assert.ok(Array.isArray(cfg.required_checks) && cfg.required_checks.length > 0, 'its required checks');
assert.equal(sh('systemctl', ['is-active', 'worklane-update.timer']), 'active');
assert.equal(sh('systemctl', ['is-enabled', 'worklane-update.timer']), 'enabled');
assert.ok(!existsSync(SIGNERS), 'installing lists no signer');
assert.deepEqual(changes().filter((c) => c.what === 'install-updater').map((c) => [c.by, c.to]), [[coordinator, 'updates.sh']]);
// The updater as installed runs, as its unit runs it, and does nothing while off.
sh('systemctl', ['start', 'worklane-update.service']);
assert.equal(sh('systemctl', ['show', '-p', 'Result', '--value', 'worklane-update.service']), 'success');
assert.equal(sh(UPDATER, []), 'disabled');
// A second install changes nothing it had.
ok('install-updater');
assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), cfg);

// ---- a repo with release tags: v1.0.1 signed by the owner's key, v1.0.2 by a key nobody adds until the end
const work = mkdtempSync('/var/lib/wl-updater-setup-');
const key = (name) => {
  const f = join(work, name);
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', f]);
  return { file: f, pub: readFileSync(`${f}.pub`, 'utf8').trim().split(' ')[1] };
};
const [mine, other] = [key('owner'), key('other')];
const origin = join(work, 'origin');
mkdirSync(origin);
const git = (...a) => sh('git', a, origin);
git('init', '-q', '-b', 'main');
for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['gpg.format', 'ssh']]) git('config', k, v);
writeFileSync(join(origin, 'package.json'), '{"version":"1.0.0"}\n');
git('add', 'package.json');
git('commit', '-q', '-m', 'main');
const main = git('rev-parse', 'HEAD');
const release = (tag, signedBy) => {
  git('checkout', '-q', '--detach', main);
  mkdirSync(join(origin, 'dist'), { recursive: true });
  writeFileSync(join(origin, 'dist', 'cli.js'), `// ${tag}\n`);
  git('add', '-f', 'dist');
  git('commit', '-q', '-m', `Release ${tag}`);
  git('-c', `user.signingkey=${signedBy}`, 'tag', '-s', tag, '-m', tag);
  git('checkout', '-q', 'main');
};
release('v1.0.1', mine.file);
release('v1.0.2', other.file);
// The installed updater's own check, as root, against the machine's signers file.
const updater = createRequire(import.meta.url)(UPDATER);
let n = 0;
const verify = (tag) => updater.verifyRelease(origin, tag, SIGNERS, (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), join(work, `verify-${++n}.git`));
assert.match(verify('v1.0.1').reason ?? '', /no allowed signers file/, 'before any signer, nothing verifies');

// ---- every other argument list: refused, and nothing changes
const k = other.pub;
const refused = [
  ['install-updater', 'x'],
  ['install-updater', '--check', 'none'],
  ['set-update-channel'],
  ['set-update-channel', 'beta'],
  ['set-update-channel', 'main', 'x'],
  ['add-update-signer'],
  ['add-update-signer', 'other@example.com'],
  ['add-update-signer', 'other@example.com', 'ssh-ed25519', k, 'extra'],
  ['add-update-signer', 'other@example.com', 'ssh-ed25519', `${k}A`],
  ['add-update-signer', 'other@example.com', 'ssh-ed25519', k.slice(0, -1)],
  ['add-update-signer', 'other@example.com', 'ssh-rsa', k],
  ['add-update-signer', '*', 'ssh-ed25519', k],
  ['add-update-signer', '*@example.com', 'ssh-ed25519', k],
  ['add-update-signer', 'other@example.com,owner@example.com', 'ssh-ed25519', k],
  ['add-update-signer', 'other@example.com', 'cert-authority', 'ssh-ed25519', k],
  ['add-update-signer', 'other@example.com cert-authority', 'ssh-ed25519', k],
  ['add-update-signer', 'other@example.com', 'namespaces="file"', 'ssh-ed25519', k],
  ['add-update-signer', `other@example.com ssh-ed25519 ${k}`],
  ['remove-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub],
  ['set-update-signers', '/tmp/allowed_signers'],
  ['set-update-verify', 'off'],
  ['set-update-checks', 'none'],
];
const tryRefused = (when) => {
  const before = [sha(CONFIG), sha(SIGNERS), changes().length];
  for (const a of refused) {
    const r = helper(...a);
    assert.notEqual(r.status, 0, `${when}: ${JSON.stringify(a)} ran: ${r.stdout}`);
    // sudo's own refusal, but for the one list that reads the same to sudo once joined: there the helper counts the arguments.
    if (a.length === 2 && a[1].includes(' ssh-ed25519 ')) assert.match(r.stderr, /^usage: worklane-machine /, JSON.stringify(a));
    else assert.match(r.stderr, /a password is required|not allowed to execute/, `${JSON.stringify(a)}: ${r.stderr}`);
  }
  assert.deepEqual([sha(CONFIG), sha(SIGNERS), changes().length], before, `${when}: a refused command changed something`);
};
tryRefused('with no signers file');

// ---- add-update-signer
const out = ok('add-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub);
console.log(out);
const fingerprint = sh('ssh-keygen', ['-l', '-f', `${mine.file}.pub`]).split(' ')[1];
assert.ok(out.includes(`added owner@example.com ssh-ed25519 ${mine.pub} (${fingerprint})`), 'it says the principal, the key and ssh-keygen\'s fingerprint');
assert.equal(owner(SIGNERS), '0:0 644');
const first = `owner@example.com ssh-ed25519 ${mine.pub}\n`;
assert.equal(readFileSync(SIGNERS, 'utf8'), first);
assert.deepEqual(verify('v1.0.1'), { ok: true, base: main });
const no = verify('v1.0.2');
assert.equal(no.ok, false, 'a tag signed by a key nobody added');
assert.match(no.reason, /v1\.0\.2's signature doesn't verify against \/etc\/worklane\/allowed_signers/);
tryRefused('with one signer');
assert.equal(verify('v1.0.2').ok, false, 'and none of the refused commands let it through');
// The coordinator can't write the file itself: only the helper's one command can.
assert.notEqual(spawnSync('sudo', ['-u', coordinator, 'sh', '-c', `echo x >> ${SIGNERS}`], { cwd: '/' }).status, 0);
assert.equal(readFileSync(SIGNERS, 'utf8'), first);
// The same signer again: nothing changes.
assert.match(ok('add-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub), /is already listed; nothing changed/);
assert.equal(readFileSync(SIGNERS, 'utf8'), first);
// A second signer is added after the first, which stays as it was; now its tag verifies too.
ok('add-update-signer', 'second@example.com', 'ssh-ed25519', other.pub);
assert.equal(readFileSync(SIGNERS, 'utf8'), `${first}second@example.com ssh-ed25519 ${other.pub}\n`);
assert.equal(verify('v1.0.2').ok, true);
assert.equal(verify('v1.0.1').ok, true);
assert.deepEqual(changes().filter((c) => c.what === 'updates.allowed_signers').map((c) => c.by), [coordinator, coordinator]);

// ---- set-update-channel: the channel alone
for (const to of ['main', 'release']) {
  ok('set-update-channel', to);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), { ...cfg, channel: to });
  assert.equal(owner(CONFIG), '0:0 644');
}
// Nothing here turned updates on, moved the signers file, or dropped a required check.
const end = JSON.parse(readFileSync(CONFIG, 'utf8'));
assert.deepEqual([end.enabled, end.allowed_signers, end.required_checks], [false, SIGNERS, cfg.required_checks]);
// The dashboard viewer gets none of it.
if (spawnSync('id', ['-u', 'wl-dash']).status === 0) {
  for (const a of [['install-updater'], ['set-update-channel', 'main'], ['add-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub]]) {
    assert.notEqual(spawnSync('sudo', ['-n', '-l', '-U', 'wl-dash', HELPER, ...a]).status, 0, `wl-dash may run ${a.join(' ')}`);
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`OK: as ${coordinator} through sudo: the updater installed (off, timer active), 2 signers added and none replaced, a tag verified only against an added key, the channel set; every other argument list refused`);

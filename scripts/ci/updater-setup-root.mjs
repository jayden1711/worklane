#!/usr/bin/env node
// CI only (the "add-project (real systemd)" job in .github/workflows/ci-slow.yml), on a real host with real sudo and
// real systemd: the engine updater set up through the machine helper, the way a dashboard asks for it. Each helper
// command is run as the coordinator through sudo (its real sudoers rule, from machine-helper.sh); everything else
// here runs as root, to look at what it left.
//   - install-updater: the installed engine's updates.sh. The updater root's, its timer active, its config off.
//   - set-update-channel release: the channel and nothing else; main is refused by sudo.
//   - stage-update-signer: one entry in the root-owned pending list, at most 4, and nothing else. The updater's
//     allowed signers file is never created or changed by it, so a release tag signed with a staged key is refused
//     by the installed updater's own check (`git verify-tag`, real ssh signatures), exactly as before it was staged.
//   - discard-update-signer takes one back out.
//   - Any other argument list (adding or confirming a signer among them) is refused by sudo itself, and changes nothing.
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
const PENDING = '/var/lib/worklane/pending-signers.json';
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
const pending = () => JSON.parse(readFileSync(PENDING, 'utf8')).pending;
const sh = (file, args, cwd = '/') => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- before: no updater on this machine
for (const f of [UPDATER, CONFIG, SIGNERS, PENDING]) assert.ok(!existsSync(f), `${f} is already there`);
const early = helper('set-update-channel', 'release');
assert.equal(early.status, 1, 'a channel before the updater is installed');
assert.match(early.stderr, /updates\.json is missing: install the updater first/);
assert.ok(!existsSync(CONFIG), 'and no config appeared');

// ---- install-updater
console.log(ok('install-updater'));
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

// ---- set-update-channel: to release only. A machine an admin put on main (as root, here) can be moved back; never the other way.
writeFileSync(CONFIG, `${JSON.stringify({ ...cfg, channel: 'main' })}\n`);
ok('set-update-channel', 'release');
assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), cfg, 'the channel alone, back to release');
assert.equal(owner(CONFIG), '0:0 644');

// ---- a repo with release tags: v1.0.1 signed by a key an admin listed (as root, here), v1.0.2 by a key that is only ever staged
const work = mkdtempSync('/var/lib/wl-updater-setup-');
const key = (name) => {
  const f = join(work, name);
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', f]);
  return { file: f, pub: readFileSync(`${f}.pub`, 'utf8').trim().split(' ')[1], fingerprint: sh('ssh-keygen', ['-l', '-f', `${f}.pub`]).split(' ')[1] };
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

// ---- every other argument list: refused, and nothing changes
const k = other.pub;
const refused = [
  ['install-updater', 'x'],
  ['install-updater', '--check', 'none'],
  ['set-update-channel'],
  ['set-update-channel', 'main'],
  ['set-update-channel', 'beta'],
  ['set-update-channel', 'release', 'x'],
  ['stage-update-signer'],
  ['stage-update-signer', 'other@example.com'],
  ['stage-update-signer', 'other@example.com', 'ssh-ed25519', k, 'extra'],
  ['stage-update-signer', 'other@example.com', 'ssh-ed25519', `${k}A`],
  ['stage-update-signer', 'other@example.com', 'ssh-ed25519', k.slice(0, -1)],
  ['stage-update-signer', 'other@example.com', 'ssh-rsa', k],
  ['stage-update-signer', '*', 'ssh-ed25519', k],
  ['stage-update-signer', '*@example.com', 'ssh-ed25519', k],
  ['stage-update-signer', 'other@example.com,owner@example.com', 'ssh-ed25519', k],
  ['stage-update-signer', 'other@example.com', 'cert-authority', 'ssh-ed25519', k],
  ['stage-update-signer', 'other@example.com cert-authority', 'ssh-ed25519', k],
  ['stage-update-signer', 'other@example.com', 'namespaces="file"', 'ssh-ed25519', k],
  ['stage-update-signer', `other@example.com ssh-ed25519 ${k}`],
  // A coordinator has no command that adds or confirms a signer, removes one, or loosens the updater.
  ['add-update-signer', 'other@example.com', 'ssh-ed25519', k],
  ['confirm-update-signer', 'other@example.com', 'ssh-ed25519', k],
  ['confirm-update-signer', other.fingerprint],
  ['remove-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub],
  ['set-update-signers', '/tmp/allowed_signers'],
  ['set-update-verify', 'off'],
  ['set-update-checks', 'none'],
];
const tryRefused = (when) => {
  const before = [sha(CONFIG), sha(SIGNERS), sha(PENDING), changes().length];
  for (const a of refused) {
    const r = helper(...a);
    assert.notEqual(r.status, 0, `${when}: ${JSON.stringify(a)} ran: ${r.stdout}`);
    // sudo's own refusal, but for the one list that reads the same to sudo once joined: there the helper counts the arguments.
    if (a.length === 2 && a[1].includes(' ssh-ed25519 ')) assert.match(r.stderr, /^usage: worklane-machine /, JSON.stringify(a));
    else assert.match(r.stderr, /a password is required|not allowed to execute/, `${JSON.stringify(a)}: ${r.stderr}`);
  }
  assert.deepEqual([sha(CONFIG), sha(SIGNERS), sha(PENDING), changes().length], before, `${when}: a refused command changed something`);
};
tryRefused('with nothing staged');

// ---- stage-update-signer, with no signers file: the pending list only
assert.match(verify('v1.0.2').reason ?? '', /no allowed signers file/);
const out = ok('stage-update-signer', 'other@example.com', 'ssh-ed25519', other.pub);
console.log(out);
assert.ok(out.includes(`staged other@example.com ssh-ed25519 ${other.pub} (${other.fingerprint})`), 'it says the principal, the key and ssh-keygen\'s fingerprint');
assert.ok(out.includes(`sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer ${other.fingerprint}`), 'and the root command that would confirm it');
assert.equal(owner(PENDING), '0:0 644');
assert.deepEqual(pending().map((e) => [e.principal, e.key, e.fingerprint, e.by]), [['other@example.com', other.pub, other.fingerprint, coordinator]]);
assert.ok(!existsSync(SIGNERS), 'staging didn\'t start the signers file');
assert.match(verify('v1.0.2').reason ?? '', /no allowed signers file/, 'a staged key is trusted for nothing');

// ---- with a signers file an admin wrote: staging leaves every byte of it, and the staged key still verifies nothing
const first = `owner@example.com ssh-ed25519 ${mine.pub}\n`;
writeFileSync(SIGNERS, first, { mode: 0o644 });
assert.deepEqual(verify('v1.0.1'), { ok: true, base: main });
ok('discard-update-signer', 'other@example.com', 'ssh-ed25519', other.pub);
assert.deepEqual(pending(), []);
ok('stage-update-signer', 'other@example.com', 'ssh-ed25519', other.pub);
assert.equal(readFileSync(SIGNERS, 'utf8'), first);
assert.equal(owner(SIGNERS), '0:0 644');
const no = verify('v1.0.2');
assert.equal(no.ok, false, 'a tag signed by a key that is only staged');
assert.match(no.reason, /v1\.0\.2's signature doesn't verify against \/etc\/worklane\/allowed_signers/);
tryRefused('with one staged');
assert.equal(verify('v1.0.2').ok, false, 'and none of the refused commands let it through');
// The coordinator can write neither file itself.
for (const f of [SIGNERS, PENDING]) assert.notEqual(spawnSync('sudo', ['-u', coordinator, 'sh', '-c', `echo x >> ${f}`], { cwd: '/' }).status, 0, `${coordinator} can write ${f}`);
assert.equal(readFileSync(SIGNERS, 'utf8'), first);
// Staged again: nothing changes. At most 4 wait at once.
const one = readFileSync(PENDING, 'utf8');
assert.match(ok('stage-update-signer', 'other@example.com', 'ssh-ed25519', other.pub), /is already staged; nothing changed/);
assert.equal(readFileSync(PENDING, 'utf8'), one);
const more = [key('k2'), key('k3'), key('k4'), key('k5')];
for (const [i, m] of more.slice(0, 3).entries()) ok('stage-update-signer', `s${i}@example.com`, 'ssh-ed25519', m.pub);
const full = helper('stage-update-signer', 's3@example.com', 'ssh-ed25519', more[3].pub);
assert.equal(full.status, 1);
assert.match(full.stderr, /4 signers are already staged/);
assert.equal(pending().length, 4);
for (const [i, m] of more.slice(0, 3).entries()) ok('discard-update-signer', `s${i}@example.com`, 'ssh-ed25519', m.pub);
assert.deepEqual(pending().map((e) => e.principal), ['other@example.com']);
assert.equal(readFileSync(SIGNERS, 'utf8'), first, 'through all of it, the signers file is as the admin wrote it');
assert.ok(changes().filter((c) => c.what === 'updates.pending_signer').every((c) => c.by === coordinator));
assert.deepEqual(changes().filter((c) => c.what === 'updates.allowed_signers'), [], 'no signer was added by anything here');

// Nothing here turned updates on, moved the signers file, left the release channel or dropped a required check.
assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), cfg);
// The dashboard viewer gets none of it.
if (spawnSync('id', ['-u', 'wl-dash']).status === 0) {
  for (const a of [['install-updater'], ['set-update-channel', 'release'], ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub]]) {
    assert.notEqual(spawnSync('sudo', ['-n', '-l', '-U', 'wl-dash', HELPER, ...a]).status, 0, `wl-dash may run ${a.join(' ')}`);
  }
}
// Left for the next step of the job: the signers file with the admin's key, and other@example.com staged.
rmSync(work, { recursive: true, force: true });
console.log(`OK: as ${coordinator} through sudo: the updater installed (off, timer active), the channel set to release and never to main, a signer staged in the root-owned pending list (at most 4) with the signers file untouched and its tag still refused; adding or confirming a signer, and every other argument list, refused`);

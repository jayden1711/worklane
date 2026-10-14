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
//   - Then an admin at a root shell, with the installed engine's updates.sh: --confirm-signer <fingerprint> adds the
//     staged signer whose fingerprint that is, after the ones there, and clears it; any other fingerprint, and one
//     staged over 24 hours ago, add nothing. --signer adds one directly; --channel main is set here and nowhere else.
//     Each signer added is in the machine change log, which the installed engine's watchdog probe reads as an alert.
//   - The installed updater watches the signers file: a file written by hand is reported once (the update log, the
//     unit's journal, a red incident in the machine's store) and held until --acknowledge-signers; the appends that
//     --confirm-signer and --signer make are not reported; a later hand edit is.
//
//   sudo node updater-setup-root.mjs <coordinator user>
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
/** One run of the updater's unit, as its timer starts it; when it fails, its own journal says why. */
const updaterRun = () => {
  const r = spawnSync('systemctl', ['start', 'worklane-update.service'], { encoding: 'utf8', cwd: '/' });
  if (r.status !== 0) {
    const journal = spawnSync('journalctl', ['-u', 'worklane-update.service', '-n', '80', '--no-pager', '-o', 'cat'], { encoding: 'utf8' }).stdout;
    assert.fail(`worklane-update.service failed (${r.stderr.trim()}); its journal:\n${journal}`);
  }
};

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
updaterRun();
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
// ---- the updater's watch on the signers file. Its runs above recorded "no file", silently (the first look).
const STATE = '/var/lib/worklane/signers-state.json';
const signersState = () => JSON.parse(readFileSync(STATE, 'utf8'));
const reported = () => readFileSync('/var/lib/worklane/updates.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'signers_changed');
const { readIncidents } = await import(pathToFileURL('/opt/worklane/current/dist/src/watchdog/incidents.js').href);
const signersIncidents = () => readIncidents().incidents.filter((i) => i.kind === 'update_signers_changed' && !i.resolvedAt);
assert.equal(owner(STATE), '0:0 644');
assert.deepEqual([signersState().hash, signersState().hold, reported(), signersIncidents()], ['absent', null, [], []]);
// A signers file written by hand (root, here), not by updates.sh: the next run of the unit reports it, once.
writeFileSync(SIGNERS, first, { mode: 0o644 });
updaterRun();
assert.equal(reported().length, 1);
assert.deepEqual([reported()[0].signers.from, reported()[0].signers.linesBefore, reported()[0].signers.linesAfter, reported()[0].signers.added, reported()[0].signers.removed], ['absent', 0, 1, [mine.fingerprint], []]);
assert.match(reported()[0].signers.to, /^sha256:[0-9a-f]{64}$/);
// On the unit's journal, with no dashboard or coordinator needed to see it.
let journal = '';
for (let i = 0; i < 20 && !journal.includes('signers_changed: '); i++) {
  journal = sh('journalctl', ['-u', 'worklane-update.service', '-n', '60', '--no-pager', '-o', 'cat']);
  if (!journal.includes('signers_changed: ')) await new Promise((r) => setTimeout(r, 250));
}
assert.ok(journal.includes(`signers_changed: ${SIGNERS} appeared outside updates.sh --signer or --confirm-signer`) && journal.includes(mine.fingerprint), `the journal:\n${journal}`);
// A red incident in the machine's store, written by the updater itself, which coordinators can still write.
for (let i = 0; i < 20 && !signersIncidents().length; i++) await new Promise((r) => setTimeout(r, 250));
assert.deepEqual(signersIncidents().map((i) => [i.severity, i.title, i.key]), [['red', 'The release signers file changed outside updates.sh', 'allowed_signers']]);
assert.ok(signersIncidents()[0].detail.includes(mine.fingerprint));
// The store is replaced whole on every write (a temp file renamed over it), so root having written it doesn't lock a
// coordinator out: as the coordinator, raise and resolve an incident of its own, with the installed engine.
const probe = spawnSync('sudo', ['-u', coordinator, 'node', '--input-type=module', '-e', 'const m = await import("file:///opt/worklane/current/dist/src/watchdog/incidents.js"); m.raiseIncident("disk_full", "ci-probe", "a probe", "nothing"); m.resolveIncident("disk_full", "ci-probe");'], { encoding: 'utf8', cwd: '/' });
assert.equal(probe.status, 0, `the coordinator can still write the incident store: ${probe.stderr}`);
assert.equal(signersIncidents().length, 1, 'and the updater\'s incident is still in it');
assert.equal(signersState().hold.to, reported()[0].signers.to, 'held');
// Not again on the next runs.
for (let i = 0; i < 2; i++) updaterRun();
assert.equal(reported().length, 1);
// Acknowledged at a root shell: it prints what is trusted now, lifts the hold, and the next run closes the incident.
const acked = sh('bash', ['/opt/worklane/current/scripts/setup/updates.sh', '--acknowledge-signers']);
assert.ok(acked.includes(mine.fingerprint) && acked.includes('release installs are no longer held'), acked);
assert.equal(signersState().hold, null);
assert.equal(owner(STATE), '0:0 644');
updaterRun();
for (let i = 0; i < 20 && signersIncidents().length; i++) await new Promise((r) => setTimeout(r, 250));
assert.deepEqual(signersIncidents(), []);
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

// ---- an admin at a root shell: the installed engine's updates.sh, by the path the page prints
const engine = '/opt/worklane/current';
const script = `${engine}/scripts/setup/updates.sh`;
const state = () => [sha(CONFIG), sha(SIGNERS), sha(PENDING), sha(UPDATER), changes().length];
const untouched = state();
const refusedAsRoot = (args, where = '/') => {
  const r = spawnSync('bash', [where === '/' ? script : 'scripts/setup/updates.sh', ...args], { encoding: 'utf8', cwd: where });
  assert.equal(r.status, 2, `updates.sh ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stderr;
};
// A fingerprint that isn't the staged signer's (here: a real key's, the admin's own, which nobody staged), or not a fingerprint: nothing.
assert.match(refusedAsRoot(['--confirm-signer', mine.fingerprint]), /no staged signer has the fingerprint/);
for (const bad of [['--confirm-signer', 'SHA256:x'], ['--confirm-signer', other.pub], ['--confirm-signer'], ['--signer', '*', 'ssh-ed25519', other.pub], ['--signer', 'third@example.com', 'ssh-rsa', other.pub], ['--signer', 'third@example.com', 'ssh-ed25519'], ['--channel', 'beta']]) refusedAsRoot(bad, engine);
assert.deepEqual(state(), untouched, 'a refused updates.sh changed something');
assert.equal(verify('v1.0.2').ok, false);
// The staged signer's own fingerprint: shown, then added after the admin's line, then cleared.
const confirmed = sh('bash', [script, '--confirm-signer', other.fingerprint]);
console.log(confirmed);
const shown = confirmed.indexOf(`  principal:   other@example.com\n  public key:  ssh-ed25519 ${other.pub}\n  fingerprint: ${other.fingerprint}`);
assert.ok(shown > 0 && shown < confirmed.indexOf('allowed_signers: added other@example.com'), 'the principal and key are printed before the signer is added');
const two = `${first}other@example.com ssh-ed25519 ${other.pub}\n`;
assert.equal(readFileSync(SIGNERS, 'utf8'), two, 'appended: the line that was there is as it was');
assert.equal(owner(SIGNERS), '0:0 644');
assert.deepEqual(pending(), [], 'and it is no longer staged');
assert.equal(verify('v1.0.2').ok, true, 'now its tag verifies');
assert.equal(verify('v1.0.1').ok, true);
assert.match(refusedAsRoot(['--confirm-signer', other.fingerprint]), /no staged signer has the fingerprint/, 'the same command again finds nothing');
assert.equal(readFileSync(SIGNERS, 'utf8'), two);
// A staged signer left for over 24 hours (root moves its time back): its command adds nothing.
const late = key('late');
ok('stage-update-signer', 'late@example.com', 'ssh-ed25519', late.pub);
writeFileSync(PENDING, `${JSON.stringify({ pending: pending().map((e) => ({ ...e, at: new Date(Date.now() - 25 * 3_600_000).toISOString() })) })}\n`);
assert.match(refusedAsRoot(['--confirm-signer', late.fingerprint]), /no staged signer has the fingerprint/);
assert.equal(readFileSync(SIGNERS, 'utf8'), two);
// --signer, directly, and --channel main: by the relative path from the checkout, the way the docs spell it.
const third = key('third');
release('v1.0.3', third.file);
assert.equal(verify('v1.0.3').ok, false);
console.log(sh('bash', ['scripts/setup/updates.sh', '--channel', 'main', '--signer', 'third@example.com', 'ssh-ed25519', third.pub], engine));
assert.equal(readFileSync(SIGNERS, 'utf8'), `${two}third@example.com ssh-ed25519 ${third.pub}\n`, 'added after the two there, which stay as they were');
assert.equal(owner(SIGNERS), '0:0 644');
assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), { ...cfg, channel: 'main' }, 'the channel alone');
assert.equal(owner(CONFIG), '0:0 644');
assert.equal(verify('v1.0.3').ok, true);
// Both signers added are in the change log, by the admin and never by the coordinator; and the installed engine's
// watchdog probe turns each into an alert naming its principal and fingerprint.
const added = changes().filter((c) => c.what === 'updates.allowed_signers');
assert.deepEqual(added.map((c) => c.to), [`added other@example.com ssh-ed25519 ${other.pub} (${other.fingerprint})`, `added third@example.com ssh-ed25519 ${third.pub} (${third.fingerprint})`]);
assert.ok(added.every((c) => c.by !== coordinator));
const { signerFindings } = await import(pathToFileURL(`${engine}/dist/src/watchdog/probes.js`).href);
const { machineChanges } = await import(pathToFileURL(`${engine}/dist/src/machine.js`).href);
// Neither append (--confirm-signer, --signer) was a change the updater reports: it was told of each as it was made.
updaterRun();
assert.equal(reported().length, 1, 'no signers_changed for a signer added through updates.sh');
assert.equal(signersState().hold, null);
// A line appended by hand afterwards is.
const intruder = key('intruder');
writeFileSync(SIGNERS, `${readFileSync(SIGNERS, 'utf8')}intruder@example.com ssh-ed25519 ${intruder.pub}\n`);
updaterRun();
assert.equal(reported().length, 2);
assert.deepEqual([reported()[1].signers.linesBefore, reported()[1].signers.linesAfter, reported()[1].signers.added, reported()[1].signers.removed], [3, 4, [intruder.fingerprint], []]);
assert.equal(signersState().hold.added[0], intruder.fingerprint, 'release installs are held again');
const alerts = signerFindings(machineChanges(), Date.now());
assert.deepEqual(alerts.map((f) => [f.kind, f.key]), [['update_signer_added', `other@example.com ${other.fingerprint}`], ['update_signer_added', `third@example.com ${third.fingerprint}`]]);
console.log(alerts.map((f) => `alert: ${f.detail}`).join('\n'));

// Nothing here turned updates on, moved the signers file or dropped a required check; main was set by root alone.
assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), { ...cfg, channel: 'main' });
// The dashboard viewer gets none of it.
if (spawnSync('id', ['-u', 'wl-dash']).status === 0) {
  for (const a of [['install-updater'], ['set-update-channel', 'release'], ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', mine.pub]]) {
    assert.notEqual(spawnSync('sudo', ['-n', '-l', '-U', 'wl-dash', HELPER, ...a]).status, 0, `wl-dash may run ${a.join(' ')}`);
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`OK: as ${coordinator} through sudo: the updater installed (off, timer active), the channel set to release and never to main, a signer staged in the root-owned pending list (at most 4) with the signers file untouched and its tag still refused; adding or confirming a signer, and every other argument list, refused. As root: updates.sh --confirm-signer added only the staged signer with the matching fingerprint, appended, and cleared it; an expired one and a wrong fingerprint added nothing; --signer and --channel main worked; each signer added reads as a watchdog alert. The updater's watch: a signers file written by hand was reported once (update log, journal, a red incident) and held until --acknowledge-signers; the appends through updates.sh were not reported; a later hand-added line was`);

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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

// The coordinator calls the helper through sudo from INSIDE its own unit (ProtectSystem=full: /usr, /boot and /etc
// read-only, for sudo and the helper too), never from a plain shell. So every call here is made from a transient unit
// with the coordinator unit's own settings, read from the unit service.sh generates (coordinator-unit-props.sh).
const props = execFileSync('bash', ['/opt/worklane/current/scripts/ci/coordinator-unit-props.sh', coordinator.slice(3)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const want of ['ProtectSystem=full', 'PrivateTmp=yes', `User=${coordinator}`]) assert.ok(props.includes(want), `the coordinator unit sets ${want}: ${props.join(' ')}`);
const asUnit = (propsUsed, argv, input) => spawnSync('systemd-run', ['--wait', '--pipe', '--collect', '--quiet', ...propsUsed.flatMap((x) => ['-p', x]), ...argv], { encoding: 'utf8', cwd: '/', ...(input === undefined ? {} : { input }) });
/** The helper, as the coordinator, through sudo, from inside the coordinator's sandbox: exactly how its unit runs it. */
const helper = (...args) => asUnit(props, ['sudo', '-n', HELPER, ...args]);
console.log(`OK: every helper call below is made from inside a transient unit with the coordinator unit's settings: ${props.join(' ')}`);
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
  // This proof starts the unit many times in a few seconds, past systemd's default start limit (5 in 10 s); its timer
  // starts it every 10 minutes. Clear the count first, so only the updater's own result decides.
  spawnSync('systemctl', ['reset-failed', 'worklane-update.service'], { cwd: '/' });
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

// ---- the old way, for comparison: a step run inline, in the process sudo started inside the coordinator's sandbox.
// (The helper's own --in-unit form is that inline run; only root may use it, so this is root with the same sandbox.)
{
  const rootSandbox = [...props.filter((x) => !/^(User|Group)=/.test(x)), 'User=root'];
  const old = asUnit(rootSandbox, [process.execPath, HELPER, '--in-unit', 'install-updater']);
  assert.notEqual(old.status, 0, 'the inline install-updater must fail in the sandbox');
  assert.match(`${old.stdout}${old.stderr}`, /Read-only file system/, `${old.stdout}${old.stderr}`);
  const oldSlots = asUnit(rootSandbox, [process.execPath, HELPER, '--in-unit', 'set-slots', '3']);
  assert.notEqual(oldSlots.status, 0);
  assert.match(`${oldSlots.stdout}${oldSlots.stderr}`, /EROFS|read-only file system/i);
  assert.ok(!existsSync(UPDATER) && !existsSync(CONFIG), 'nothing was installed by the inline attempt');
  console.log(`OK: inline, inside the coordinator's sandbox (the old way), install-updater fails: ${`${old.stderr}${old.stdout}`.split('\n').find((l) => /Read-only file system/.test(l)).trim()}; and set-slots fails with EROFS`);
}

// ---- install-updater, the new way: the helper starts it in a unit of its own
const installed = ok('install-updater');
console.log(installed);
console.log('OK: install-updater, called by the coordinator from inside its sandbox, ran in a unit of its own and installed the updater');
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
// The inline attempt above (root, in the sandbox) logged its try before it failed; the coordinator's install is the one after it.
assert.deepEqual(changes().filter((c) => c.what === 'install-updater').map((c) => [c.by, c.to]), [['root', 'updates.sh'], [coordinator, 'updates.sh']]);
// The updater as installed runs, as its unit runs it, and does nothing while off.
updaterRun();
assert.equal(sh('systemctl', ['show', '-p', 'Result', '--value', 'worklane-update.service']), 'success');
assert.equal(sh(UPDATER, []), 'disabled');
// A second install changes nothing it had.
ok('install-updater');
assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), cfg);

// ---- set-slots, the new way: /etc/worklane/slots.json changes though the caller's /etc is read-only.
{
  const before = existsSync('/etc/worklane/slots.json') ? readFileSync('/etc/worklane/slots.json', 'utf8') : null;
  assert.match(ok('set-slots', '3'), /slots\.max_agents: .* -> 3/);
  assert.equal(JSON.parse(readFileSync('/etc/worklane/slots.json', 'utf8')).max_agents, 3);
  if (before !== null) writeFileSync('/etc/worklane/slots.json', before);
  console.log('OK: set-slots, called from inside the coordinator\'s sandbox, wrote /etc/worklane/slots.json from a unit of its own');
}

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
assert.deepEqual(pending().map((e) => [e.principal, e.key, e.fingerprint, e.by, e.instance]), [['other@example.com', other.pub, other.fingerprint, coordinator, coordinator.slice(3)]]);
// Staging raises its own alert, through the installed engine's watchdog probe: the principal, the fingerprint, who staged it and from which instance.
{
  const { stagedSignerFindings } = await import(pathToFileURL('/opt/worklane/current/dist/src/watchdog/probes.js').href);
  const { machineChanges } = await import(pathToFileURL('/opt/worklane/current/dist/src/machine.js').href);
  const staged = stagedSignerFindings(machineChanges(), Date.now()).filter((f) => f.key === `other@example.com ${other.fingerprint}`);
  assert.deepEqual(staged.map((f) => [f.kind, f.instance]), [['update_signer_staged', coordinator.slice(3)]]);
  assert.ok(staged[0].detail.includes(`by ${coordinator} (instance ${coordinator.slice(3)})`), staged[0].detail);
  console.log(`OK: staging raised update_signer_staged: ${staged[0].detail}`);
}
assert.ok(!existsSync(SIGNERS), 'staging didn\'t start the signers file');
assert.match(verify('v1.0.2').reason ?? '', /no allowed signers file/, 'a staged key is trusted for nothing');

// ---- with a signers file an admin wrote: staging leaves every byte of it, and the staged key still verifies nothing
const first = `owner@example.com ssh-ed25519 ${mine.pub}\n`;
// ---- the updater's watch on the signers file. Its runs above recorded "no file", silently (the first look).
const STATE = '/var/lib/worklane/signers-state.json';
const signersState = () => JSON.parse(readFileSync(STATE, 'utf8'));
const reported = () => readFileSync('/var/lib/worklane/updates.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'signers_changed');
const { readIncidents, raiseIncident } = await import(pathToFileURL('/opt/worklane/current/dist/src/watchdog/incidents.js').href);
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
// The staged signer's own fingerprint, with the wrong principal typed (or none): nothing is added, and it stays staged.
for (const typed of ['owner@example.com\n', '\n', '']) {
  const r = spawnSync('bash', [script, '--confirm-signer', other.fingerprint], { encoding: 'utf8', cwd: '/', input: typed });
  assert.notEqual(r.status, 0, `typed ${JSON.stringify(typed)}`);
  assert.match(r.stderr, /isn't the staged signer's \(other@example\.com\): nothing was added/);
  assert.match(r.stdout, new RegExp(`the staged signer, staged by ${coordinator} \\(instance ${coordinator.slice(3)}\\) at `));
}
assert.deepEqual(state(), untouched, 'a wrong principal changed something');
console.log('OK: --confirm-signer with the right fingerprint but a wrong or missing typed principal added nothing');
// Then shown, the principal typed, added after the admin's line, cleared.
const confirmed = execFileSync('bash', [script, '--confirm-signer', other.fingerprint], { encoding: 'utf8', cwd: '/', input: 'other@example.com\n', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
console.log('OK: the appends by --confirm-signer and --signer raised no signers_changed report');
assert.equal(signersState().hold, null);
// A line appended by hand afterwards is.
const intruder = key('intruder');
writeFileSync(SIGNERS, `${readFileSync(SIGNERS, 'utf8')}intruder@example.com ssh-ed25519 ${intruder.pub}\n`);
updaterRun();
assert.equal(reported().length, 2);
assert.deepEqual([reported()[1].signers.linesBefore, reported()[1].signers.linesAfter, reported()[1].signers.added, reported()[1].signers.removed], [3, 4, [intruder.fingerprint], []]);
assert.equal(signersState().hold.added[0], intruder.fingerprint, 'release installs are held again');

// ---- the whole hand-edit path, in order, with a release in reach: held, acknowledged, then installed.
// The installed updater's own run(), as root, on this machine's real signers file, record and incident store, and its
// real release check (git verify-tag, real ssh signatures) against the local repo. GitHub's check runs and the build
// are stand-ins, as in updater-lookback-root.mjs: no network here, and a real build would replace this job's engine.
console.log(`OK 1/5: a hand edit of ${SIGNERS} (intruder@example.com, ${intruder.fingerprint}) was reported by the updater's unit as signers_changed`);
const { resolveIncident } = await import(pathToFileURL('/opt/worklane/current/dist/src/watchdog/incidents.js').href);
for (let i = 0; i < 20 && !signersIncidents().some((x) => x.detail.includes(intruder.fingerprint)); i++) await new Promise((r) => setTimeout(r, 250));
const red = signersIncidents().filter((x) => x.detail.includes(intruder.fingerprint));
assert.deepEqual(red.map((x) => [x.kind, x.severity, x.title]), [['update_signers_changed', 'red', 'The release signers file changed outside updates.sh']]);
console.log(`OK 2/5: the incident store holds the open red incident "${red[0].title}" (${red[0].kind}, id ${red[0].id}), naming ${intruder.fingerprint}`);
const newest = git('rev-parse', 'v1.0.3^{commit}');
const opt = mkdtempSync('/var/lib/wl-updater-opt-');
const runLogs = [];
let clock = Date.now();
let installedSha = 'a'.repeat(40);
const deps = {
  config: () => ({ enabled: true, channel: 'release', repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], allowed_signers: SIGNERS }),
  // The updater's own signers watch, on this machine's file and record.
  signersCheck: (file) => updater.checkSigners(file),
  signersHold: () => updater.signersHold(),
  signersAcknowledged: () => updater.takeAcknowledged(),
  warn: (line) => runLogs.push({ warn: line }),
  // The machine's incident store, through the installed engine.
  raiseIncident: (kind, key, detail, fix) => raiseIncident(kind, key, detail, fix),
  resolveIncident: (kind, key) => resolveIncident(kind, key),
  installed: () => installedSha,
  installedVersion: () => '1.0.2',
  // The release tags and their check: real, against the local repo, as root.
  verifyRelease: (_url, tag, signers) => updater.verifyRelease(origin, tag, signers, (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), join(work, `run-verify-${++n}.git`)),
  exec: (file, args) => {
    if (file === 'git' && args[0] === 'ls-remote') return execFileSync('git', ['ls-remote', '--tags', origin, 'refs/tags/v*'], { encoding: 'utf8' });
    if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-ci-standin.service loaded active running x\n';
    if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
    runLogs.push({ exec: [file, ...args].join(' ').slice(0, 80) });
    return '';
  },
  fetchJson: async () => ({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
  slots: () => [],
  alive: () => false,
  installTree: (sha) => mkdirSync(join(opt, sha), { recursive: true }),
  syncHelpers: () => [],
  switchTo: (sha) => {
    rmSync(join(opt, 'current'), { force: true });
    symlinkSync(join(opt, sha), join(opt, 'current'));
    installedSha = sha;
  },
  now: () => clock,
  sleep: async (ms) => void (clock += ms),
  log: (e) => runLogs.push(e),
  held: () => null,
  hold: () => {},
  configChangedAt: () => 0,
  note: (event, sha, reason) => (runLogs.push({ event, to: sha, reason }), event),
};
const verified = verify('v1.0.3');
assert.equal(verified.ok, true, 'the newest release is signed by a listed key and would install');
const heldRun = await updater.run(deps);
assert.equal(heldRun, 'held');
const heldLine = runLogs.find((e) => e.event === 'held');
assert.match(heldLine.reason, /the signers file changed outside updates\.sh at .* hasn't been acknowledged .*no release is installed until an admin runs: sudo bash \/opt\/worklane\/current\/scripts\/setup\/updates\.sh --acknowledge-signers/);
assert.ok(!existsSync(join(opt, 'current')) && !existsSync(join(opt, newest)) && installedSha === 'a'.repeat(40), 'nothing built, installed or switched');
console.log(`OK 3/5: release v1.0.3 (${newest.slice(0, 12)}, signed by a listed key, checks green) was not installed: run() returned held: ${heldLine.reason.slice(0, 160)}`);
// Before the acknowledgement: nothing a coordinator can run through the helper lifts this hold. Each command really
// rewrites updates.json (the channel, the switch); the file is put back as it was afterwards.
{
  const holdBytes = sha(STATE);
  const cfgNow = readFileSync(CONFIG, 'utf8');
  for (const args of [['set-update-channel', 'release'], ['set-updates', 'off'], ['set-updates', 'on'], ['set-update-channel', 'release']]) {
    ok(...args);
    assert.equal(sha(STATE), holdBytes, `${args.join(' ')} left signers-state.json as it was`);
    assert.ok(updater.signersHold(), `still held after ${args.join(' ')}`);
  }
  assert.equal(await updater.run(deps), 'held', 'and a run is still held');
  // --release-hold is for a rolled-back commit: it leaves the signers hold alone too.
  sh('bash', ['/opt/worklane/current/scripts/setup/updates.sh', '--release-hold']);
  assert.equal(sha(STATE), holdBytes);
  writeFileSync(CONFIG, cfgNow);
  console.log(`OK: the signers hold stayed through set-update-channel release and set-updates off/on as ${coordinator} through sudo, and through --release-hold; only --acknowledge-signers is left to lift it`);
}
const ack = sh('bash', ['/opt/worklane/current/scripts/setup/updates.sh', '--acknowledge-signers']);
assert.ok(ack.includes(intruder.fingerprint) && ack.includes('release installs are no longer held'), ack);
assert.equal(signersState().hold, null);
console.log(`OK 4/5: sudo bash /opt/worklane/current/scripts/setup/updates.sh --acknowledge-signers printed the ${signersState().lines} keys now trusted and lifted the hold`);
const installedRun = await updater.run(deps);
assert.equal(installedRun, 'installed', JSON.stringify(runLogs.slice(-3)));
assert.equal(readlinkSync(join(opt, 'current')), join(opt, newest), 'current points to the release');
for (let i = 0; i < 20 && signersIncidents().length; i++) await new Promise((r) => setTimeout(r, 250));
assert.deepEqual(signersIncidents(), [], 'the incident is closed');
assert.ok(readIncidents().incidents.some((x) => x.id === red[0].id && x.resolvedAt), 'resolved, not deleted');
console.log(`OK 5/5: the next run installed v1.0.3: current -> ${readlinkSync(join(opt, 'current'))}; incident ${red[0].id} resolved at ${readIncidents().incidents.find((x) => x.id === red[0].id).resolvedAt}`);
rmSync(opt, { recursive: true, force: true });
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
// ---- a hold on a rolled-back commit: what the updater writes after a rollback (root, here). Nothing a coordinator
// runs through the helper releases it; only updates.sh --release-hold does, at a root shell.
const HELD = '/var/lib/worklane/update-held.json';
const rollbackSha = 'b'.repeat(40);
writeFileSync(HELD, `${JSON.stringify({ sha: rollbackSha, at: new Date(Date.now() - 60_000).toISOString(), failed: ['worklane-ci.service: failed'] })}\n`, { mode: 0o644 });
const rollbackBytes = sha(HELD);
const rollbackNotes = [];
const rollbackSwitched = [];
let rollbackCurrent = 'a'.repeat(40);
const rollbackRun = async () => {
  let current = 'a'.repeat(40);
  let clock = 0;
  return updater.run({
    config: () => JSON.parse(readFileSync(CONFIG, 'utf8')),
    held: () => (existsSync(HELD) ? JSON.parse(readFileSync(HELD, 'utf8')) : null),
    installed: () => current,
    installedVersion: () => '1.0.0',
    verifyRelease: () => ({ ok: true, base: 'c'.repeat(40) }),
    exec: (file, args) => (file === 'git' && args.includes('--tags') ? `${'3'.repeat(40)}\trefs/tags/v1.0.9\n${rollbackSha}\trefs/tags/v1.0.9^{}\n` : file === 'git' ? `${rollbackSha}\trefs/heads/main\n` : file === 'systemctl' && args[0] === 'list-units' ? 'worklane-ci-standin.service loaded active running x\n' : file === 'systemctl' && args[0] === 'show' ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : ''),
    fetchJson: async (url) => (url.includes('/compare/') ? { status: 'ahead', behind_by: 0, ahead_by: 1, total_commits: 1, commits: [{ sha: rollbackSha, parents: [{ sha: current }], commit: { committer: { date: new Date(0).toISOString() } } }] } : { check_runs: (JSON.parse(readFileSync(CONFIG, 'utf8')).required_checks || []).map((name, id) => ({ name, status: 'completed', conclusion: 'success', started_at: '1', id })) }),
    slots: () => [],
    alive: () => false,
    installTree: () => {},
    syncHelpers: () => [],
    switchTo: (s) => (rollbackSwitched.push(s), (current = s), (rollbackCurrent = s)),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    log: () => {},
    hold: () => {},
    note: (event, s, reason) => (rollbackNotes.push({ event, to: s, reason }), event),
  });
};
// Updates on (as root, here), so the run gets as far as the hold.
writeFileSync(CONFIG, `${JSON.stringify({ ...JSON.parse(readFileSync(CONFIG, 'utf8')), enabled: true })}\n`);
assert.equal(await rollbackRun(), 'held');
for (const args of [['set-update-channel', 'release'], ['set-updates', 'off'], ['set-updates', 'on'], ['set-update-channel', 'release']]) {
  ok(...args);
  assert.equal(sha(HELD), rollbackBytes, `${args.join(' ')} left the hold file as it was`);
  assert.equal(await rollbackRun(), args[1] === 'off' ? 'disabled' : 'held', `still held after ${args.join(' ')}`);
}
console.log(`OK: a rolled-back commit stayed held through set-update-channel release and set-updates off/on, run as ${coordinator} through sudo`);
const releasedOut = sh('bash', [script, '--release-hold']);
assert.ok(releasedOut.includes(`held: ${rollbackSha.slice(0, 12)}`) && releasedOut.includes('released:'), releasedOut);
assert.ok(!existsSync(HELD) && existsSync('/var/lib/worklane/update-held.released.json'));
// The next run installs the released commit: every required check green on it (the stand-in answers for each name
// updates.json requires), switched to it, the result 'installed'.
rollbackNotes.length = 0;
const afterRollbackRelease = await rollbackRun();
assert.equal(afterRollbackRelease, 'installed', JSON.stringify(rollbackNotes));
assert.deepEqual(rollbackSwitched, [rollbackSha], 'switchTo was called with the released commit');
assert.equal(rollbackCurrent, rollbackSha, 'current is the released commit');
console.log(`OK: sudo bash /opt/worklane/current/scripts/setup/updates.sh --release-hold released it; the next run installed ${rollbackSha.slice(0, 12)} (run() returned ${afterRollbackRelease}; switchTo ${rollbackSwitched[0].slice(0, 12)}; current ${rollbackCurrent.slice(0, 12)})`);
writeFileSync(CONFIG, `${JSON.stringify({ ...JSON.parse(readFileSync(CONFIG, 'utf8')), enabled: false })}\n`);

// ---- the signer rules and this runner's sudo
const sudoV = sh('sudo', ['-V']).split('\n')[0];
const rule = readFileSync('/etc/sudoers.d/worklane-machine', 'utf8');
assert.ok(rule.includes('^stage-update-signer ') && rule.includes('^discard-update-signer ') && rule.includes('^add-project '), 'the pattern rules are installed');
const recorded = JSON.parse(readFileSync('/etc/worklane/helper-rules.json', 'utf8'));
assert.deepEqual(recorded.left_out, [], 'helper-rules.json records nothing left out');
assert.equal(owner('/etc/worklane/helper-rules.json'), '0:0 644');
console.log(`OK: ${sudoV} on this runner (1.9.10 or later): the add-project, stage-update-signer and discard-update-signer rules are installed; helper-rules.json: ${JSON.stringify(recorded)}`);
// The same rule, made with a stand-in sudo reporting 1.9.9: those two left out, the rest there, and visudo accepts it.
const fake = mkdtempSync('/var/lib/wl-fake-sudo-');
writeFileSync(join(fake, 'sudo'), '#!/bin/sh\n[ "$1" = -V ] && echo "Sudo version 1.9.9" && exit 0\nexit 1\n', { mode: 0o755 });
const older = execFileSync('bash', ['-c', 'source "$1"; machine_sudoers wl-ci', '_', '/opt/worklane/current/scripts/setup/lib.sh'], { encoding: 'utf8', env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
assert.ok(!older.includes('^stage-update-signer ') && !older.includes('^discard-update-signer ') && !older.includes('^add-project ') && older.includes('# Not here: add-project, stage-update-signer and discard-update-signer. This sudo (1.9.9)') && older.includes('install-updater') && older.includes('tailscale public-url'), older);
writeFileSync(join(fake, 'rule'), older);
assert.equal(spawnSync('visudo', ['-cf', join(fake, 'rule')]).status, 0, 'visudo accepts the rule without them');
rmSync(fake, { recursive: true, force: true });
console.log('OK: with a stand-in sudo reporting 1.9.9, the rule leaves out add-project, stage-update-signer and discard-update-signer, keeps the rest, and visudo accepts it');

rmSync(work, { recursive: true, force: true });
console.log(`OK: as ${coordinator} through sudo: the updater installed (off, timer active), the channel set to release and never to main, a signer staged in the root-owned pending list (at most 4) with the signers file untouched and its tag still refused; adding or confirming a signer, and every other argument list, refused. As root: updates.sh --confirm-signer added only the staged signer with the matching fingerprint, appended, and cleared it; an expired one and a wrong fingerprint added nothing; --signer and --channel main worked; each signer added reads as a watchdog alert. The updater's watch: a signers file written by hand was reported once (update log, journal, a red incident) and held until --acknowledge-signers; the appends through updates.sh were not reported; a later hand-added line was`);

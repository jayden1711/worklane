// The first-run wizard's Updater screen (server mode; the Machine page's "Updater setup"): install the engine
// updater, keep it on the release channel, and stage a release signer for an admin to confirm at a root shell.
// The signers file is the root of trust for release updates, so most of this is what a dashboard session can't do:
// add a signer (it can only stage one; scripts/setup/updates.sh --confirm-signer adds it, as root), follow main, or
// weaken how the updater verifies (its signature check and its exact-commit build, each with a guard test here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER, machineChanges, signerFingerprint, signerKeyOk, signerPrincipalOk } from '../src/machine.js';
import { machineRefusal } from '../src/machine-requests.js';
import { SETUP_STEPS } from '../src/setup-steps.js';
import { ALLOWED_SIGNERS, confirmCommand, listedSigners, PENDING_MAX, PENDING_SIGNERS, PENDING_TTL_MS, pendingSigners, signerInput, updaterPlan, updaterSetup } from '../src/updater-setup.js';
import { openIncidents, readIncidents } from '../src/watchdog/incidents.js';
import { SIGNER_NOTICE_MS, signerFindings, stagedSignerFindings } from '../src/watchdog/probes.js';
import { Watchdog, type WatchdogDeps } from '../src/watchdog/watchdog.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

const require_ = createRequire(import.meta.url);
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const rootSrc = join(repoRoot, 'scripts', 'setup', 'updates-root.cjs');
const helper = require_(helperSrc) as { parse(a: string[]): unknown; parseSigner(c: string, a: string[]): unknown; fingerprint(k: string): string; PENDING: string; PENDING_MAX: number; PENDING_TTL_MS: number };
const posix = process.platform !== 'win32';

/** A new ed25519 public key as ssh writes it. */
function ed25519() {
  const raw = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]).toString('base64');
}

test('the engine allows exactly what the helper takes: install-updater, the release channel, staging or discarding one signer; never main, never adding one', () => {
  const k = ed25519();
  const lists: string[][] = [
    ['install-updater'],
    ['install-updater', 'x'],
    ['set-update-channel', 'release'],
    ['set-update-channel', 'main'],
    ['set-update-channel', 'beta'],
    ['set-update-channel'],
    ['set-update-channel', 'release', 'x'],
    ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['discard-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['stage-update-signer', 'release+signing@example.com', 'ssh-ed25519', k],
    ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k, 'extra'],
    ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', `${k}A`],
    ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k.slice(0, -1)],
    ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', `AAAAB3NzaC1yc2E${k.slice(15)}`],
    ['stage-update-signer', 'owner@example.com', 'ssh-rsa', k],
    ['stage-update-signer', '*', 'ssh-ed25519', k],
    ['stage-update-signer', '*@example.com', 'ssh-ed25519', k],
    ['stage-update-signer', 'a@example.com,b@example.com', 'ssh-ed25519', k],
    ['stage-update-signer', '!owner@example.com', 'ssh-ed25519', k],
    ['stage-update-signer', 'owner@example.com cert-authority', 'ssh-ed25519', k],
    ['stage-update-signer', 'owner@example.com', 'cert-authority', 'ssh-ed25519', k],
    ['stage-update-signer', `owner@example.com ssh-ed25519 ${k}`],
    ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['confirm-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['confirm-signer', signerFingerprint(k)],
    ['add-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['remove-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['set-update-signers', '/tmp/allowed_signers'],
    ['set-update-verify', 'off'],
  ];
  const helperTakes = (a: string[]) => (a[0] === 'install-updater' ? a.length === 1 : !!helper.parseSigner('stage-update-signer', a) || !!helper.parseSigner('discard-update-signer', a) || (a[0] === 'set-update-channel' && !!helper.parse(a)));
  const allowed = lists.filter((a) => checkRootStep(a[0]!, a.slice(1)).allowed);
  assert.deepEqual(allowed, lists.filter(helperTakes), 'the engine and the helper agree on every list');
  assert.deepEqual(allowed.map((a) => a.slice(0, 2).join(' ')), ['install-updater', 'set-update-channel release', 'stage-update-signer owner@example.com', 'discard-update-signer owner@example.com', 'stage-update-signer release+signing@example.com']);
  for (const a of lists) assert.equal(machineRefusal(a) === null, allowed.includes(a), `a machine request for ${JSON.stringify(a)}`);
  assert.ok(signerPrincipalOk('owner@example.com') && signerKeyOk(k));
  assert.equal(signerFingerprint(k), helper.fingerprint(k), 'the page and the helper name a key the same way');
  assert.deepEqual([PENDING_SIGNERS, PENDING_MAX, PENDING_TTL_MS], [helper.PENDING, helper.PENDING_MAX, helper.PENDING_TTL_MS], 'and read the same pending list, with the same limits');
});

test('what an owner types becomes one exact signer: a .pub line loses only its comment; anything else is refused with why', () => {
  const k = ed25519();
  const want = { principal: 'owner@example.com', key: k, fingerprint: signerFingerprint(k), line: `owner@example.com ssh-ed25519 ${k}`, confirm: `sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer ${signerFingerprint(k)}` };
  assert.deepEqual(signerInput('owner@example.com', `ssh-ed25519 ${k} owner@laptop`), want);
  assert.deepEqual(signerInput('  owner@example.com ', `  ssh-ed25519 ${k}\n`), want);
  assert.deepEqual(signerInput('owner@example.com', k), want);
  for (const [p, key, why] of [
    ['owner@example.com', `ssh-rsa ${k}`, /stages ssh-ed25519 keys only, not ssh-rsa/],
    ['owner@example.com', `ecdsa-sha2-nistp256 ${k}`, /not ecdsa-sha2-nistp256/],
    ['owner@example.com', `ssh-ed25519 ${k.slice(0, -2)}`, /one ssh-ed25519 key/],
    ['owner@example.com', `${k} ${k}`, /one ssh-ed25519 key/],
    ['owner@example.com', `cert-authority ssh-ed25519 ${k}`, /one ssh-ed25519 key/],
    ['owner@example.com', '', /one ssh-ed25519 key/],
    ['*', k, /principal is one name/],
    ['a@example.com,b@example.com', k, /principal is one name/],
    ['owner@example.com cert-authority', k, /principal is one name/],
    ['', k, /principal is one name/],
    [undefined, k, /principal is one name/],
  ] as [unknown, unknown, RegExp][]) {
    const r = signerInput(p, key);
    assert.ok('error' in r && why.test(r.error), `${JSON.stringify([p, key])}: ${JSON.stringify(r)}`);
  }
});

function machineFiles(o: { config?: Record<string, unknown> | null; signers?: string | null; pending?: unknown[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'updater-setup-'));
  const updatesConfigPath = join(dir, 'updates.json');
  const signersPath = join(dir, 'allowed_signers');
  const pendingSignersPath = join(dir, 'pending-signers.json');
  if (o.config !== null) writeFileSync(updatesConfigPath, JSON.stringify(o.config ?? { enabled: false, channel: 'release', allowed_signers: ALLOWED_SIGNERS, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }));
  if (o.signers != null) writeFileSync(signersPath, o.signers);
  if (o.pending) writeFileSync(pendingSignersPath, JSON.stringify({ pending: o.pending }));
  return { dir, updatesConfigPath, signersPath, pendingSignersPath, pendingPath: pendingSignersPath };
}

test('the setup as the page shows it: installed or not, the channel, each signer with its fingerprint, each staged signer with its confirming command, and the script', () => {
  const [a, b, c] = [ed25519(), ed25519(), ed25519()];
  const bare = updaterSetup(machineFiles({ config: null }));
  assert.deepEqual([bare.installed, bare.enabled, bare.channel, bare.signers, bare.pending], [false, null, null, null, []]);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const f = machineFiles({
    signers: `# release keys\n\nfirst@example.com namespaces="git" ssh-ed25519 ${a} laptop\nrsa@example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7\nnot a signer line\n`,
    pending: [{ principal: 'second@example.com', key: b, by: 'wl-site', at }, { principal: 'old@example.com', key: c, by: 'wl-site', at: new Date(Date.now() - PENDING_TTL_MS - 1000).toISOString() }, { principal: '*', key: c, at }],
  });
  const v = updaterSetup(f);
  assert.deepEqual([v.installed, v.enabled, v.channel, v.updaterReads], [true, false, 'release', null]);
  assert.deepEqual(v.signers, [
    { principal: 'first@example.com', options: 'namespaces="git"', keyType: 'ssh-ed25519', key: a, fingerprint: signerFingerprint(a) },
    { principal: 'rsa@example.com', options: '', keyType: 'ssh-rsa', key: 'AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7', fingerprint: signerFingerprint('AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7') },
  ]);
  assert.deepEqual(listedSigners(join(f.dir, 'nope')), null);
  // The staged one that still counts: with when it expires and the exact root command that confirms it. The expired and the malformed are not shown.
  assert.deepEqual(v.pending, [{ principal: 'second@example.com', key: b, fingerprint: signerFingerprint(b), by: 'wl-site', instance: null, at, expiresAt: new Date(Date.parse(at) + PENDING_TTL_MS).toISOString(), confirm: `sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer ${signerFingerprint(b)}` }]);
  assert.equal(v.pending[0]!.confirm, confirmCommand(signerFingerprint(b)));
  assert.deepEqual(pendingSigners(f.pendingPath, Date.parse(at) + PENDING_TTL_MS), [], 'gone 24 hours after it was staged');
  assert.equal(pendingSigners(f.pendingPath, Date.parse(at) + PENDING_TTL_MS - 1).length, 1);
  assert.deepEqual(v.script, {
    install: 'sudo bash scripts/setup/updates.sh',
    signer: 'sudo bash scripts/setup/updates.sh --signer <principal> ssh-ed25519 <public key>',
    confirm: 'sudo bash scripts/setup/updates.sh --confirm-signer <SHA256 fingerprint of a staged signer>',
    release: 'sudo bash scripts/setup/updates.sh --channel release',
    main: 'sudo bash scripts/setup/updates.sh --channel main',
    releaseHold: 'sudo bash scripts/setup/updates.sh --release-hold',
  });
  // An existing install without a channel follows main; one whose config names another signers file says so.
  const old = updaterSetup(machineFiles({ config: { enabled: true, allowed_signers: '/root/signers' } }));
  assert.deepEqual([old.channel, old.enabled, old.updaterReads], ['main', true, '/root/signers']);
  assert.match(old.channelWhat!, /no tag signature is checked/, 'main says what it gives up');
  // The first-run step opens this screen, and names the script.
  const step = SETUP_STEPS.find((s) => s.id === 'updater')!;
  assert.deepEqual(step.fix, { kind: 'screen', path: '/machine', label: "the Machine page's Updater setup" });
  assert.match(step.today, /sudo bash scripts\/setup\/updates\.sh.*--signer <principal> ssh-ed25519 <public key>.*--confirm-signer <fingerprint>.*--channel release\|main/);
});

test('a plan says exactly what runs and changes; there is no plan that adds a signer or follows main', () => {
  const [k, k2, k3] = [ed25519(), ed25519(), ed25519()];
  const none = updaterSetup(machineFiles({ config: null }));
  const install = updaterPlan({ step: 'install' }, none);
  assert.ok(!('error' in install));
  assert.deepEqual([install.args, install.command, install.script], [['install-updater'], `${MACHINE_HELPER} install-updater`, 'sudo bash scripts/setup/updates.sh']);
  assert.match(install.changes.join('\n'), /with updates off and the channel "release"[\s\S]*doesn't touch \/etc\/worklane\/allowed_signers/);
  assert.deepEqual(updaterPlan({ step: 'release' }, none), { error: "the updater isn't installed on this machine yet: install it first" });
  const at = new Date().toISOString();
  const f = machineFiles({ signers: `owner@example.com ssh-ed25519 ${k}\n`, pending: [{ principal: 'staged@example.com', key: k3, by: 'wl-site', at }] });
  const now = updaterSetup(f);
  assert.match((updaterPlan({ step: 'install' }, now) as { changes: string[] }).changes.join('\n'), /keeps .*updates\.json as it is/);
  assert.deepEqual(updaterPlan({ step: 'release' }, now), { error: 'the updater already follows releases', status: 409 });
  const onMain = updaterSetup(machineFiles({ config: { enabled: false, channel: 'main' } }));
  const toRelease = updaterPlan({ step: 'release' }, onMain);
  assert.ok(!('error' in toRelease));
  assert.deepEqual([toRelease.args, toRelease.script], [['set-update-channel', 'release'], 'sudo bash scripts/setup/updates.sh --channel release']);
  // Staging: the helper's stage command, never an add; what it says it changes is the pending list alone.
  const stage = updaterPlan({ step: 'stage', principal: 'second@example.com', key: `ssh-ed25519 ${k2} me@laptop` }, now);
  assert.ok(!('error' in stage));
  assert.deepEqual(stage.args, ['stage-update-signer', 'second@example.com', 'ssh-ed25519', k2]);
  const confirm = `sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer ${signerFingerprint(k2)}`;
  assert.deepEqual(stage.signer, { principal: 'second@example.com', key: k2, fingerprint: signerFingerprint(k2), line: `second@example.com ssh-ed25519 ${k2}`, confirm, file: ALLOWED_SIGNERS });
  assert.equal(stage.script, `sudo bash scripts/setup/updates.sh --signer second@example.com ssh-ed25519 ${k2}`);
  assert.match(stage.changes.join('\n'), /stages this principal and key in \/var\/lib\/worklane\/pending-signers\.json, for 24 hours[\s\S]*changes nothing in \/etc\/worklane\/allowed_signers: a staged key is trusted for nothing[\s\S]*only when an admin runs, as root on this machine: sudo bash/);
  assert.deepEqual(updaterPlan({ step: 'stage', principal: 'owner@example.com', key: k }, now), { error: `owner@example.com with this key (${signerFingerprint(k)}) is already a signer, listed in ${f.signersPath}`, status: 409 });
  assert.match((updaterPlan({ step: 'stage', principal: 'staged@example.com', key: k3 }, now) as { error: string }).error, /is already staged: it waits for sudo bash/);
  const full = updaterSetup(machineFiles({ pending: Array.from({ length: 4 }, (_, i) => ({ principal: `s${i}@example.com`, key: ed25519(), by: 'wl-site', at })) }));
  assert.deepEqual(updaterPlan({ step: 'stage', principal: 'second@example.com', key: k2 }, full), { error: '4 signers are already staged: confirm or discard one first', status: 409 });
  // Discarding: only one that is staged.
  const discard = updaterPlan({ step: 'discard', principal: 'staged@example.com', key: k3 }, now);
  assert.ok(!('error' in discard));
  assert.deepEqual(discard.args, ['discard-update-signer', 'staged@example.com', 'ssh-ed25519', k3]);
  assert.deepEqual(updaterPlan({ step: 'discard', principal: 'second@example.com', key: k2 }, now), { error: "that signer isn't staged (or its 24 hours have passed)", status: 409 });
  // No step adds a signer, confirms one, follows main, removes or replaces anything, or turns anything off.
  for (const step of ['signer', 'add', 'confirm', 'channel', 'main', 'remove', 'replace', 'verify', undefined]) assert.deepEqual(updaterPlan({ step, principal: 'owner@example.com', key: k, channel: 'main' } as never, onMain), { error: 'step is install, release, stage or discard' });
  for (const p of [install, toRelease, stage, discard]) assert.doesNotMatch(p.args.join(' '), /add-update-signer|confirm|main/);
});

async function serve(f: ReturnType<typeof machineFiles>, user: string, owners = ['example-owner']) {
  const eventsDb = join(f.dir, 'events.db');
  new EventLog(eventsDb).close();
  const { dir: root } = exampleProject();
  const slotsDir = join(f.dir, 'slots');
  mkdirSync(slotsDir, { recursive: true });
  const ownersFile = machineOwnersFile(...owners);
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: f.dir, user: 'example-owner', roleOf: exampleRoles, slotsDir, machine: { updatesConfigPath: f.updatesConfigPath, signersPath: f.signersPath, pendingSignersPath: f.pendingSignersPath, changesPath: join(f.dir, 'changes.jsonl'), updatesLogPath: join(f.dir, 'updates.jsonl') }, machineOwnersFile: ownersFile });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson(user) };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/api/machine/updater${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string; plan?: { args: string[]; command: string; signer?: { principal: string; key: string; fingerprint: string; line: string; confirm: string } }; pending?: boolean; machine?: { requests: { args: string[]; status: string }[] } } };
  };
  const events = (type: string) => {
    const log = new EventLog(eventsDb);
    try {
      return log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);
    } finally {
      log.close();
    }
  };
  const tick = (exec: (file: string, args: string[]) => string) => {
    const log = new EventLog(eventsDb);
    try {
      return runMachineRequests({ log, instance: 'site', exec, ownersFile });
    } finally {
      log.close();
    }
  };
  const machine = async () => (await (await fetch(`${base}/api/machine`, { headers: h })).json()) as { updater: { installed: boolean; channel: string; signers: { principal: string }[] | null; pending: { principal: string; confirm: string }[] } };
  return { d, post, events, tick, machine };
}

test('looking and reviewing change nothing: no request, no audit line, the files as they were (a skipped screen is a machine left alone)', async () => {
  const [k, staged] = [ed25519(), ed25519()];
  const f = machineFiles({ config: { enabled: false, channel: 'main' }, signers: `owner@example.com ssh-ed25519 ${ed25519()}\n`, pending: [{ principal: 'staged@example.com', key: staged, by: 'wl-site', at: new Date().toISOString() }] });
  const before = [f.updatesConfigPath, f.signersPath, f.pendingSignersPath].map((p) => readFileSync(p, 'utf8'));
  const x = await serve(f, 'example-owner');
  try {
    const m = await x.machine();
    assert.deepEqual([m.updater.installed, m.updater.channel, m.updater.signers?.map((s) => s.principal), m.updater.pending.map((p) => p.principal)], [true, 'main', ['owner@example.com'], ['staged@example.com']]);
    for (const body of [{ step: 'install' }, { step: 'release' }, { step: 'stage', principal: 'second@example.com', key: k }, { step: 'discard', principal: 'staged@example.com', key: staged }]) {
      const r = await x.post('/review', body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.plan!.command, /^\/usr\/local\/libexec\/worklane-machine (install-updater|set-update-channel release|stage-update-signer second@example\.com ssh-ed25519 |discard-update-signer staged@example\.com ssh-ed25519 )/);
      // And the change itself, sent without the confirming click: refused.
      const unconfirmed = await x.post('', body);
      assert.equal(unconfirmed.status, 400);
      assert.match(unconfirmed.body.error!, /review what it shows .* then confirm it/);
      assert.equal((await x.post('', { ...body, confirm: 'yes' })).status, 400);
    }
    assert.deepEqual(x.events('machine.requested'), [], 'nothing was asked of the coordinator');
    assert.deepEqual(x.events('dashboard.audit').filter((a) => a.action === 'machine.updater'), []);
    assert.equal(x.tick(() => assert.fail('nothing to run')), 0);
    assert.deepEqual([f.updatesConfigPath, f.signersPath, f.pendingSignersPath].map((p) => readFileSync(p, 'utf8')), before);
  } finally {
    await x.d.close();
  }
});

test('the most a dashboard session can do about a signer is stage it: the coordinator runs stage-update-signer, the signers file is not written, and the page shows the root command', async () => {
  const k = ed25519();
  const f = machineFiles({ signers: `first@example.com ssh-ed25519 ${ed25519()}\n` });
  const signersBefore = readFileSync(f.signersPath, 'utf8');
  const x = await serve(f, 'example-owner');
  try {
    const review = await x.post('/review', { step: 'stage', principal: 'owner@example.com', key: `ssh-ed25519 ${k} owner@laptop` });
    const confirm = `sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer ${signerFingerprint(k)}`;
    assert.deepEqual(review.body.plan!.signer, { principal: 'owner@example.com', key: k, fingerprint: signerFingerprint(k), line: `owner@example.com ssh-ed25519 ${k}`, confirm, file: ALLOWED_SIGNERS }, 'the exact principal, key, fingerprint and the command that would confirm it');
    const ok = await x.post('', { step: 'stage', principal: 'owner@example.com', key: k, confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.machine!.requests.map((r) => [r.args.join(' '), r.status]), [[`stage-update-signer owner@example.com ssh-ed25519 ${k}`, 'pending']]);
    assert.deepEqual(x.events('dashboard.audit').filter((a) => a.action === 'machine.updater').map((a) => [a.login, (a.detail as { args: string[] }).args, (a.detail as { fingerprint: string }).fingerprint]), [['example-owner', ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k], signerFingerprint(k)]]);
    const calls: string[][] = [];
    assert.equal(x.tick((file, args) => (calls.push([file, ...args]), 'staged')), 1);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'stage-update-signer', 'owner@example.com', 'ssh-ed25519', k]], 'one helper command, through sudo -n: stage, with exactly those arguments');
    assert.equal(readFileSync(f.signersPath, 'utf8'), signersBefore, 'the dashboard wrote nothing to the signers file');
    // Every way of asking the dashboard to add it instead is refused, and none reaches the coordinator.
    for (const body of [
      { step: 'signer', principal: 'owner@example.com', key: k, confirm: true, fingerprint: signerFingerprint(k) },
      { step: 'add', principal: 'owner@example.com', key: k, confirm: true },
      { step: 'confirm', fingerprint: signerFingerprint(k), confirm: true },
      { step: 'channel', channel: 'main', confirm: true },
      { step: 'main', confirm: true },
    ]) {
      const r = await x.post('', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error!, /step is install, release, stage or discard/);
    }
    assert.equal(x.events('machine.requested').length, 1);
    assert.equal(x.tick(() => assert.fail('nothing more to run')), 0);
  } finally {
    await x.d.close();
  }
});

test('install, release and discard: confirmed, each becomes its one helper command for the coordinator; the page never writes the files', async () => {
  const staged = ed25519();
  const f = machineFiles({ config: { enabled: false, channel: 'main', required_checks: ['test'] }, pending: [{ principal: 'staged@example.com', key: staged, by: 'wl-site', at: new Date().toISOString() }] });
  const before = [f.updatesConfigPath, f.pendingSignersPath].map((p) => readFileSync(p, 'utf8'));
  const x = await serve(f, 'example-owner');
  try {
    assert.equal((await x.post('', { step: 'install', confirm: true })).status, 200);
    assert.equal((await x.post('', { step: 'release', confirm: true })).status, 200);
    assert.equal((await x.post('', { step: 'discard', principal: 'staged@example.com', key: staged, confirm: true })).status, 200);
    assert.equal((await x.post('', { step: 'discard', principal: 'other@example.com', key: staged, confirm: true })).status, 409, 'not staged');
    assert.deepEqual([f.updatesConfigPath, f.pendingSignersPath].map((p) => readFileSync(p, 'utf8')), before, 'the dashboard changed nothing itself');
    const calls: string[][] = [];
    assert.equal(x.tick((file, args) => (calls.push([file, ...args]), 'ok')), 3);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'install-updater'], ['sudo', '-n', MACHINE_HELPER, 'set-update-channel', 'release'], ['sudo', '-n', MACHINE_HELPER, 'discard-update-signer', 'staged@example.com', 'ssh-ed25519', staged]]);
  } finally {
    await x.d.close();
  }
});

test('only an instance owner who is a machine owner may: a writer is refused the review and the change, an owner who is no machine owner the change', async () => {
  const k = ed25519();
  const body = { step: 'stage', principal: 'owner@example.com', key: k, confirm: true };
  const writer = await serve(machineFiles(), 'example-collaborator');
  try {
    for (const path of ['/review', '']) {
      const r = await writer.post(path, body);
      assert.equal(r.status, 403);
      assert.match(r.body.error!, /only the instance's owners .* may set the updater up; @example-collaborator is a writer/);
    }
    assert.deepEqual(writer.events('machine.requested'), []);
  } finally {
    await writer.d.close();
  }
  const notMachineOwner = await serve(machineFiles(), 'example-owner', ['someone-else']);
  try {
    const r = await notMachineOwner.post('', body);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(notMachineOwner.events('machine.requested'), []);
  } finally {
    await notMachineOwner.d.close();
  }
});

// ---- the root shell's half: scripts/setup/updates-root.cjs (updates.sh --signer, --confirm-signer, --channel) ----

/** The helper and the root-only script side by side, as an engine has them, their fixed paths pointed into a temp root. */
function rootIn(root = mkdtempSync(join(tmpdir(), 'updates-root-'))) {
  const etc = join(root, 'etc');
  const log = join(root, 'var', 'machine-changes.jsonl');
  const pending = join(root, 'var', 'pending-signers.json');
  mkdirSync(etc, { recursive: true });
  mkdirSync(join(root, 'scripts', 'machine'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'setup'), { recursive: true });
  const paths = (s: string) => s.replace("const ETC = '/etc/worklane';", `const ETC = ${JSON.stringify(etc)};`).replace("const LOG = '/var/lib/worklane/machine-changes.jsonl';", `const LOG = ${JSON.stringify(log)};`).replace("const PENDING = '/var/lib/worklane/pending-signers.json';", `const PENDING = ${JSON.stringify(pending)};`);
  const helperCopy = join(root, 'scripts', 'machine', 'worklane-machine.cjs');
  const rootCopy = join(root, 'scripts', 'setup', 'updates-root.cjs');
  writeFileSync(helperCopy, paths(readFileSync(helperSrc, 'utf8')));
  writeFileSync(rootCopy, paths(readFileSync(rootSrc, 'utf8')));
  /** As a coordinator through sudo: the machine helper. */
  const asCoordinator = (...args: string[]) => spawnSync(process.execPath, [helperCopy, ...args], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'wl-alpha' } });
  /** As an admin at a root shell, typing `typed` when asked: what updates.sh runs. */
  const asAdminTyping = (typed: string, ...args: string[]) => spawnSync(process.execPath, [rootCopy, ...args], { encoding: 'utf8', input: `${typed}\n`, env: { ...process.env, SUDO_USER: 'admin' } });
  /** The same, typing the staged signer's own principal when a confirm asks for it (the admin read it right). */
  const asAdmin = (...args: string[]) => {
    let typed = '';
    if (args[0] === 'confirm-signer' && existsSync(pending)) typed = ((JSON.parse(readFileSync(pending, 'utf8')) as { pending: { principal: string; fingerprint: string }[] }).pending.find((e) => e.fingerprint === args[1]) ?? { principal: '' }).principal;
    return asAdminTyping(typed, ...args);
  };
  const signers = join(etc, 'allowed_signers');
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
  const staged = () => (JSON.parse(readFileSync(pending, 'utf8')) as { pending: { principal: string; key: string; at: string }[] }).pending;
  return { root, etc, log, pending, signers, asCoordinator, asAdmin, asAdminTyping, read, staged };
}

test('staging from the dashboard can\'t change the signers file; only the admin\'s confirming command, with the matching fingerprint, adds the staged key', () => {
  const m = rootIn();
  const [a, b] = [ed25519(), ed25519()];
  const mine = `# release keys\nfirst@example.com namespaces="git" ssh-ed25519 ${ed25519()}`;
  writeFileSync(m.signers, mine);
  assert.equal(m.asCoordinator('stage-update-signer', 'owner@example.com', 'ssh-ed25519', a).status, 0);
  assert.equal(m.asCoordinator('stage-update-signer', 'second@example.com', 'ssh-ed25519', b).status, 0);
  assert.equal(m.read(m.signers), mine, 'staged twice: the signers file is as it was');
  // A fingerprint that isn't a staged signer's: nothing is added, nothing is cleared.
  const pendingBefore = m.read(m.pending);
  for (const fp of [signerFingerprint(ed25519()), `${signerFingerprint(a).slice(0, -1)}${signerFingerprint(a).endsWith('A') ? 'B' : 'A'}`]) {
    const no = m.asAdmin('confirm-signer', fp);
    assert.equal(no.status, 1, no.stdout);
    assert.match(no.stderr, /no staged signer has the fingerprint SHA256:.*: nothing was added/);
    assert.equal(m.asAdmin('check', 'confirm-signer', fp).status, 1, 'and updates.sh is told so before it installs anything');
  }
  // Not a fingerprint at all (the key itself, a principal, nothing): refused as a usage error.
  for (const bad of [[a], ['owner@example.com'], ['SHA256:short'], [signerFingerprint(a), 'extra'], []]) assert.equal(m.asAdmin('confirm-signer', ...bad).status, 2, JSON.stringify(bad));
  assert.deepEqual([m.read(m.signers), m.read(m.pending)], [mine, pendingBefore]);
  assert.ok(!machineChanges(m.log).some((c) => c.what === 'updates.allowed_signers'), 'no signer was added');
  // The matching fingerprint: shown first, then added after what was there, and only that entry leaves the pending list.
  assert.equal(m.asAdmin('check', 'confirm-signer', signerFingerprint(a)).status, 0);
  const yes = m.asAdmin('confirm-signer', signerFingerprint(a));
  assert.equal(yes.status, 0, yes.stderr);
  const shown = yes.stdout.indexOf(`  principal:   owner@example.com\n  public key:  ssh-ed25519 ${a}\n  fingerprint: ${signerFingerprint(a)}\n`);
  assert.ok(shown > 0 && shown < yes.stdout.indexOf('allowed_signers: added'), `the principal and key are printed before it is applied:\n${yes.stdout}`);
  assert.match(yes.stdout, /^the staged signer, staged by wl-alpha \(instance alpha\) at /);
  assert.equal(m.read(m.signers), `${mine}\nowner@example.com ssh-ed25519 ${a}\n`, 'appended: every earlier byte in place');
  assert.deepEqual(m.staged().map((e) => e.principal), ['second@example.com']);
  // Once applied it is no longer staged: the same command again adds nothing.
  assert.equal(m.asAdmin('confirm-signer', signerFingerprint(a)).status, 1);
  assert.equal(m.read(m.signers), `${mine}\nowner@example.com ssh-ed25519 ${a}\n`);
  const added = machineChanges(m.log).filter((c) => c.what === 'updates.allowed_signers');
  assert.deepEqual(added.map((c) => [c.by, c.to]), [['admin', `added owner@example.com ssh-ed25519 ${a} (${signerFingerprint(a)})`]], 'logged as the admin who confirmed it');
});

test('a staged signer expires: 24 hours on, its confirming command adds nothing', () => {
  const m = rootIn();
  const a = ed25519();
  assert.equal(m.asCoordinator('stage-update-signer', 'owner@example.com', 'ssh-ed25519', a).status, 0);
  const [e] = m.staged();
  const write = (at: string) => writeFileSync(m.pending, JSON.stringify({ pending: [{ ...e, at }] }));
  write(new Date(Date.now() - PENDING_TTL_MS - 60_000).toISOString());
  const late = m.asAdmin('confirm-signer', signerFingerprint(a));
  assert.equal(late.status, 1);
  assert.match(late.stderr, /no staged signer has the fingerprint .* A staged signer waits 24 hours, then is dropped/);
  assert.equal(m.read(m.signers), null, 'no signers file was started');
  assert.deepEqual(updaterSetup({ pendingPath: m.pending, signersPath: m.signers, updatesConfigPath: join(m.etc, 'updates.json') }).pending, [], 'and the page no longer shows it');
  // A minute inside the 24 hours, the same command applies it.
  write(new Date(Date.now() - PENDING_TTL_MS + 60_000).toISOString());
  assert.equal(m.asAdmin('confirm-signer', signerFingerprint(a)).status, 0);
  assert.equal(m.read(m.signers), `owner@example.com ssh-ed25519 ${a}\n`);
});

test('the root command only ever adds a line: --signer and a confirmed signer keep every byte there, a signer already listed changes nothing, one fingerprint staged twice is refused', { skip: !posix && 'symlinks' }, () => {
  const m = rootIn();
  const [a, b] = [ed25519(), ed25519()];
  const mine = `# release keys\nrsa@example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 old key`;
  writeFileSync(m.signers, mine);
  assert.equal(m.asAdmin('add-signer', 'owner@example.com', 'ssh-ed25519', a).status, 0);
  assert.equal(m.read(m.signers), `${mine}\nowner@example.com ssh-ed25519 ${a}\n`);
  const after = m.read(m.signers);
  assert.match(m.asAdmin('add-signer', 'owner@example.com', 'ssh-ed25519', a).stdout, /is already listed; nothing changed/);
  // Staged and confirmed though it is already a signer: still nothing changes, and the entry is cleared.
  assert.equal(m.asCoordinator('stage-update-signer', 'owner@example.com', 'ssh-ed25519', a).status, 0);
  assert.equal(m.asAdmin('confirm-signer', signerFingerprint(a)).status, 0);
  assert.equal(m.read(m.signers), after);
  assert.deepEqual(m.staged(), []);
  assert.equal(machineChanges(m.log).filter((c) => c.what === 'updates.allowed_signers').length, 1, 'one signer added, logged once');
  // The same key staged under two principals: its fingerprint doesn't say which, so neither is applied.
  for (const p of ['x@example.com', 'y@example.com']) assert.equal(m.asCoordinator('stage-update-signer', p, 'ssh-ed25519', b).status, 0);
  const two = m.asAdmin('confirm-signer', signerFingerprint(b));
  assert.equal(two.status, 1);
  assert.match(two.stderr, /2 staged signers have the fingerprint .*x@example\.com, y@example\.com/);
  assert.equal(m.read(m.signers), after);
  // The shapes --signer refuses, exactly the helper's: nothing is written for any of them.
  for (const bad of [['add-signer', '*', 'ssh-ed25519', b], ['add-signer', 'a@example.com,b@example.com', 'ssh-ed25519', b], ['add-signer', 'owner@example.com', 'ssh-rsa', b], ['add-signer', 'owner@example.com', 'ssh-ed25519', `${b}A`], ['add-signer', 'owner@example.com', 'ssh-ed25519', b, 'x'], ['remove-signer', 'owner@example.com', 'ssh-ed25519', a], ['channel', 'beta'], []]) {
    assert.equal(m.asAdmin(...bad).status, 2, JSON.stringify(bad));
    assert.equal(m.asAdmin('check', ...bad).status, 2, JSON.stringify(bad));
  }
  assert.equal(m.read(m.signers), after);
  // A signers file that is a link is not written through.
  const l = rootIn();
  const elsewhere = join(l.root, 'elsewhere');
  writeFileSync(elsewhere, 'kept\n');
  symlinkSync(elsewhere, l.signers);
  const r = l.asAdmin('add-signer', 'owner@example.com', 'ssh-ed25519', a);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /allowed_signers isn't a regular file; not writing it/);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'kept\n');
  // The channel, at a root shell: release or main, that key alone, for an installed updater.
  assert.equal(m.asAdmin('channel', 'main').status, 1, 'no updater installed');
  const cfg = { enabled: false, channel: 'release', allowed_signers: '/etc/worklane/allowed_signers', required_checks: ['test'] };
  writeFileSync(join(m.etc, 'updates.json'), JSON.stringify(cfg));
  for (const to of ['main', 'release']) {
    assert.equal(m.asAdmin('channel', to).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(m.etc, 'updates.json'), 'utf8')), { ...cfg, channel: to });
  }
});

test('whenever a signer is staged, and whenever one is added (by --signer or a confirmed staged one), the watchdog raises an alert naming the principal and fingerprint, and posts it to the ops channel once', async () => {
  const m = rootIn();
  const [a, b] = [ed25519(), ed25519()];
  // Staging adds nothing, so it is no "added" alert; it is its own alert, naming who staged it and from which instance.
  assert.equal(m.asCoordinator('stage-update-signer', 'staged@example.com', 'ssh-ed25519', b).status, 0);
  assert.deepEqual(signerFindings(machineChanges(m.log), Date.now()), []);
  const stagedAlerts = stagedSignerFindings(machineChanges(m.log), Date.now());
  assert.deepEqual(stagedAlerts.map((f) => [f.kind, f.key, f.instance]), [['update_signer_staged', `staged@example.com ${signerFingerprint(b)}`, 'alpha']]);
  assert.match(stagedAlerts[0]!.detail, new RegExp(`a release signer was staged: staged@example\\.com, key fingerprint ${signerFingerprint(b).replace(/[+/]/g, '\\$&')}, by wl-alpha \\(instance alpha\\) at .* trusted for nothing until an admin confirms it at a root shell`));
  assert.match(stagedAlerts[0]!.fix, /--confirm-signer SHA256:.*it asks you to type the principal.*discard it on the Machine page/);
  assert.equal(m.asAdmin('add-signer', 'direct@example.com', 'ssh-ed25519', a).status, 0);
  assert.equal(m.asAdmin('confirm-signer', signerFingerprint(b)).status, 0);
  const findings = signerFindings(machineChanges(m.log), Date.now());
  assert.deepEqual(findings.map((f) => [f.kind, f.key, f.instance]), [['update_signer_added', `direct@example.com ${signerFingerprint(a)}`, null], ['update_signer_added', `staged@example.com ${signerFingerprint(b)}`, null]]);
  assert.match(findings[1]!.detail, new RegExp(`the release signer staged@example\\.com, key fingerprint ${signerFingerprint(b).replace(/[+/]/g, '\\$&')}, was added to /etc/worklane/allowed_signers by admin at `));
  // Through the watchdog, as a coordinator runs it: an open incident each (the Health page), posted once each.
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  const posts: string[] = [];
  let now = new Date();
  const deps: WatchdogDeps = {
    instance: 'alpha',
    dir,
    events: () => [],
    stop: () => null,
    emergency: () => false,
    auth: () => ({ loggedIn: true }),
    instances: () => ['alpha'],
    units: () => null,
    updates: () => [],
    machineChanges: () => machineChanges(m.log),
    disks: () => [],
    config: () => ({ stallHours: 6, diskPct: 85, opsChannel: null, dashboardUrl: null }),
    poster: () => ({ poster: async (c: string) => (posts.push(c), true), dashboardUrl: 'https://hub.example.test', secrets: [] }),
    now: () => now,
  };
  const dog = new Watchdog(deps);
  await dog.pass();
  const open = openIncidents(readIncidents(dir));
  assert.deepEqual(open.map((i) => [i.kind, i.title, i.severity, i.key, i.instance]).sort(), [
    ['update_signer_added', 'A release signer was added for engine updates', 'amber', `direct@example.com ${signerFingerprint(a)}`, null],
    ['update_signer_added', 'A release signer was added for engine updates', 'amber', `staged@example.com ${signerFingerprint(b)}`, null],
    ['update_signer_staged', 'A release signer was staged for engine updates', 'amber', `staged@example.com ${signerFingerprint(b)}`, 'alpha'],
  ]);
  // The principal and the fingerprint reach the stored incident and the post whole: they are public, and nothing redacts them.
  for (const [p, k] of [['direct@example.com', a], ['staged@example.com', b]] as const) {
    assert.ok(open.some((i) => i.detail.includes(p) && i.detail.includes(signerFingerprint(k))), `${p} in an incident`);
    assert.equal(posts.filter((c) => c.includes('was added') && c.includes(p) && c.includes(signerFingerprint(k))).length, 1, `${p} posted once:\n${posts.join('\n---\n')}`);
  }
  assert.equal(posts.filter((c) => c.includes('was staged') && c.includes('staged@example.com') && c.includes(signerFingerprint(b)) && c.includes('wl-alpha')).length, 1, 'the staging posted once, with who staged it');
  now = new Date(now.getTime() + 31 * 60_000);
  await dog.pass();
  assert.equal(posts.length, 3, 'not posted again while they stay open');
  // A day on the notice closes by itself.
  now = new Date(now.getTime() + SIGNER_NOTICE_MS);
  await dog.pass();
  assert.deepEqual(openIncidents(readIncidents(dir)), []);
  dog.stop();
});

test('updates.sh does the same from a terminal: --signer, --confirm-signer and --channel go through updates-root.cjs, checked before anything is installed', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  assert.match(s, /^root_steps="\$\(cd "\$\(dirname "\$0"\)" && pwd\)\/updates-root\.cjs"$/m);
  assert.match(s, /^  node "\$root_steps" channel "\$channel"$/m);
  assert.match(s, /^  node "\$root_steps" add-signer "\$\{signer\[@\]\}"$/m);
  assert.match(s, /^  node "\$root_steps" confirm-signer "\$confirm"$/m);
  // Each is checked before the first thing is installed.
  const firstInstall = s.indexOf('install -d -o root -g root -m 0755 /usr/local/libexec');
  for (const check of ['node "$root_steps" check channel "$channel"', 'node "$root_steps" check add-signer "${signer[@]}"', 'node "$root_steps" check confirm-signer "$confirm"']) {
    const at = s.indexOf(check);
    assert.ok(at > 0 && at < firstInstall, `${check} comes before the install`);
  }
  // The script itself never writes, empties or removes the signers file: only updates-root.cjs's add does.
  assert.doesNotMatch(s, />>?\s*"?\/etc\/worklane\/allowed_signers|rm [^\n]*allowed_signers|sed [^\n]*allowed_signers|truncate|tee [^\n]*allowed_signers/);
  // And nothing in it loosens the updater: no flag for the signers path, for skipping verification, or for no checks.
  assert.doesNotMatch(s, /--no-verify|--skip-verify|--insecure|--allowed-signers|--no-checks/);
  // The signers file has exactly one writer in the engine: the root-only script. Neither the helper nor the engine's own code names it to write.
  const rootCode = readFileSync(rootSrc, 'utf8');
  assert.match(rootCode, /^const SIGNERS = 'allowed_signers'; \/\/ in ETC$/m);
  assert.doesNotMatch(rootCode, /unlinkSync|rmSync|truncate/, 'and it has nothing that removes');
  assert.doesNotMatch(readFileSync(helperSrc, 'utf8'), /allowed_signers|updates-root/);
  // No sudoers rule a setup script writes names it: only root runs it.
  for (const f of ['lib.sh', 'machine-helper.sh', 'instance.sh']) assert.doesNotMatch(readFileSync(join(repoRoot, 'scripts', 'setup', f), 'utf8'), /updates-root/, f);
});

// ---- the updater's own guards, which this screen must never weaken ----
const updaterSrc = join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs');
const u = require_(updaterSrc) as {
  BUILD_SCRIPT: string;
  buildCommand(repoUrl: string, sha: string): string[];
  verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): { ok: boolean; reason?: string; base?: string };
  run(deps: object): Promise<string>;
};
const sshKeygen = posix && spawnSync('ssh-keygen', ['-?']).error === undefined;

/** A repo with main and one release commit on top of it (dist/ only), tagged v9.9.9 and signed with a new key. */
function signedRelease() {
  const root = mkdtempSync(join(tmpdir(), 'updater-guard-'));
  const dir = join(root, 'origin');
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const keyFile = join(root, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', keyFile]);
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['gpg.format', 'ssh'], ['user.signingkey', keyFile]]) git('config', k!, v!);
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
  git('add', 'package.json');
  git('commit', '-q', '-m', 'main');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', main);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'cli.js'), '// v9.9.9\n');
  git('add', '-f', 'dist');
  git('commit', '-q', '-m', 'Release v9.9.9');
  git('tag', '-s', 'v9.9.9', '-m', 'v9.9.9');
  const release = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return { root, dir, main, release, pub: readFileSync(`${keyFile}.pub`, 'utf8').trim().split(' ')[1]! };
}

test('guard, signature: with updates on and every check green, a release whose signer isn\'t listed is never built; listing that key is what lets it in', { skip: !sshKeygen && 'needs ssh-keygen' }, async () => {
  const o = signedRelease();
  const signers = join(o.root, 'allowed_signers');
  const exec = (file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const machine = () => {
    const calls: string[] = [];
    const logs: Record<string, unknown>[] = [];
    let current = 'a'.repeat(40);
    let clock = 0;
    const deps = {
      config: () => ({ enabled: true, channel: 'release', allowed_signers: signers, repo_url: 'https://github.com/example-org/engine.git', required_checks: ['test'] }),
      installed: () => current,
      installedVersion: () => '1.0.0',
      // The updater's own check, real git and real ssh signatures, against the signers file its config names.
      verifyRelease: (_url: string, tag: string, file: string) => u.verifyRelease(o.dir, tag, file, exec, join(mkdtempSync(join(tmpdir(), 'verify-')), 'v.git')),
      exec: (file: string, args: string[]) => {
        calls.push([file, ...args].join(' ').slice(0, 40));
        if (file === 'git') return exec('git', ['ls-remote', '--tags', o.dir, 'refs/tags/v*']);
        if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\n';
        if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
        return '';
      },
      fetchJson: async () => ({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
      slots: () => [],
      alive: () => false,
      installTree: (sha: string) => calls.push(`installTree ${sha}`),
      syncHelpers: () => [],
      switchTo: (sha: string) => ((current = sha), calls.push(`switchTo ${sha}`)),
      now: () => clock,
      sleep: async (ms: number) => void (clock += ms),
      log: (e: Record<string, unknown>) => logs.push(e),
      held: () => null,
      hold: () => {},
      configChangedAt: () => 0,
      note: (event: string, sha: string | null, reason: string) => (logs.push({ event, to: sha, reason }), event),
    };
    return { deps, calls, logs, built: () => calls.some((c) => /^(systemd-run|installTree|switchTo)/.test(c)) };
  };
  // No signers file, then one listing somebody else's key: refused both times, nothing built or switched.
  const none = machine();
  assert.equal(await u.run(none.deps), 'refused');
  assert.match(String(none.logs.at(-1)!.reason), /no allowed signers file/);
  assert.ok(!none.built());
  writeFileSync(signers, `other@example.com ssh-ed25519 ${ed25519()}\n`);
  const wrong = machine();
  assert.equal(await u.run(wrong.deps), 'refused');
  assert.match(String(wrong.logs.at(-1)!.reason), /v9\.9\.9's signature doesn't verify against/);
  assert.ok(!wrong.built(), 'green checks don\'t stand in for a signature');
  // The owner's key added after the other one, as updates.sh adds it (a line appended): now it installs.
  writeFileSync(signers, `${readFileSync(signers, 'utf8')}owner@example.com ssh-ed25519 ${o.pub}\n`);
  const ok = machine();
  assert.equal(await u.run(ok.deps), 'installed');
  assert.ok(ok.calls.includes(`switchTo ${o.release}`));
});

test('guard, checksum: the build installs from the lockfile and only at exactly the commit that was checked, or it stops', { skip: !posix && 'bash' }, () => {
  const steps = u.BUILD_SCRIPT.split(' && ');
  const exact = steps.indexOf('test "$(git rev-parse HEAD)" = "$2"');
  assert.ok(exact > 0 && exact < steps.findIndex((s) => s.startsWith('npm ')), 'the commit is checked before anything is installed or built');
  // npm ci installs exactly what package-lock.json pins, checking each package's integrity hash, and runs no package's scripts.
  assert.deepEqual(steps.filter((s) => s.startsWith('npm ')), ['npm ci --ignore-scripts --no-audit --no-fund', 'npm run -s build', 'npm run -s build:web']);
  assert.doesNotMatch(u.BUILD_SCRIPT, /npm (install|i|update)\b|--no-package-lock|--force|--legacy-peer-deps|strict-ssl|--no-verify|GIT_SSL_NO_VERIFY/);
  const sha = 'c'.repeat(40);
  const cmd = u.buildCommand('https://github.com/example-org/engine.git', sha);
  assert.deepEqual(cmd.slice(-4), [u.BUILD_SCRIPT, '_', 'https://github.com/example-org/engine.git', sha], 'the script gets the repo and the checked commit, nothing else');
  // The script's own first steps, for real: the exact commit passes; a name that only resolves to it does not.
  const root = mkdtempSync(join(tmpdir(), 'updater-build-'));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: origin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a'), '1\n');
  git('add', 'a');
  git('-c', 'user.name=x', '-c', 'user.email=x@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  const head = git('rev-parse', 'HEAD');
  const upToCheck = steps.slice(0, exact + 1).join(' && ');
  const build = (ref: string) => spawnSync('bash', ['-euo', 'pipefail', '-c', upToCheck, '_', origin, ref], { cwd: mkdtempSync(join(root, 'build-')), encoding: 'utf8' }).status;
  assert.equal(build(head), 0, 'the commit itself');
  assert.notEqual(build('main'), 0, 'a branch name that resolves to it is not the commit that was checked');
  assert.notEqual(build(head.slice(0, 12)), 0, 'nor is a short form of it');
});

test('guard: the updater verifies a release with git verify-tag against the signers file, and this change leaves that code alone', () => {
  const src = readFileSync(updaterSrc, 'utf8');
  assert.match(src, /g\('-c', 'gpg\.format=ssh', '-c', `gpg\.ssh\.allowedSignersFile=\$\{signers\}`, 'verify-tag', tag\);/);
  assert.match(src, /if \(!v\.ok\) return deps\.note\('refused', head, v\.reason, true\);/, 'a release that doesn\'t verify is refused, before its checks are even read');
  assert.match(src, /if \(!exists\(signers\)\) return \{ ok: false,/, 'no signers file: nothing verifies');
  // Nothing the screen runs is in the updater: it has no notion of the helper's commands, and the helper none of verifying.
  assert.doesNotMatch(src, /stage-update-signer|pending-signers|set-update-channel|install-updater|updates-root/);
  const helperSrc = readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs'), 'utf8');
  assert.doesNotMatch(helperSrc, /verify-tag|required_checks|unlinkSync|rmSync|truncate/);
});

test('the confirm shows who staged the signer and from which instance, and adds it only when the admin types its principal', () => {
  const m = rootIn();
  const [a, b] = [ed25519(), ed25519()];
  writeFileSync(m.signers, `first@example.com ssh-ed25519 ${a}\n`);
  assert.equal(m.asCoordinator('stage-update-signer', 'owner@example.com', 'ssh-ed25519', b).status, 0);
  const entry = (JSON.parse(readFileSync(m.pending, 'utf8')) as { pending: Record<string, unknown>[] }).pending[0]!;
  assert.deepEqual([entry.by, entry.instance], ['wl-alpha', 'alpha'], 'the pending entry records the coordinator user and its instance');
  const before = m.read(m.signers);
  // Typed wrong, typed nothing, typed with something after it, typed as the fingerprint: nothing is added, and it stays staged.
  for (const typed of ['other@example.com', '', 'owner@example.com x', signerFingerprint(b), 'OWNER@example.com']) {
    const r = m.asAdminTyping(typed, 'confirm-signer', signerFingerprint(b));
    assert.equal(r.status, 1, `typed ${JSON.stringify(typed)}: ${r.stdout}`);
    assert.match(r.stdout, /^the staged signer, staged by wl-alpha \(instance alpha\) at .*\n  principal:   owner@example\.com\n/);
    assert.match(r.stderr, /Type the principal to add it[\s\S]*isn't the staged signer's \(owner@example\.com\): nothing was added/);
    assert.equal(m.read(m.signers), before);
    assert.equal(m.staged().length, 1);
  }
  assert.ok(!machineChanges(m.log).some((c) => c.what === 'updates.allowed_signers'));
  // Typed right (surrounding spaces don't matter): added, cleared.
  const ok = m.asAdminTyping('  owner@example.com ', 'confirm-signer', signerFingerprint(b));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(m.read(m.signers), `${before}owner@example.com ssh-ed25519 ${b}\n`);
  assert.deepEqual(m.staged(), []);
  // A signer staged by root itself (no coordinator): it says so, and still asks.
  const rootStaged = rootIn();
  const run = spawnSync(process.execPath, [join(rootStaged.root, 'scripts', 'machine', 'worklane-machine.cjs'), 'stage-update-signer', 'root@example.com', 'ssh-ed25519', a], { encoding: 'utf8', env: { ...process.env, SUDO_USER: '' } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(rootStaged.asAdminTyping('nope', 'confirm-signer', signerFingerprint(a)).stdout, /^the staged signer, staged by root at /);
});

// ---- holds: nothing a coordinator can run releases one; only the root command does ----

/** The updater as an engine has it, its fixed paths in a temp root: run() over the real hold file, and updates-root.cjs beside it. */
function heldMachine() {
  const m = rootIn();
  const varDir = join(m.root, 'var');
  mkdirSync(varDir, { recursive: true });
  const held = join(varDir, 'update-held.json');
  const cfgFile = join(m.etc, 'updates.json');
  const rewrite = (src: string) => src.replace("const HELD = '/var/lib/worklane/update-held.json';", `const HELD = ${JSON.stringify(held)};`).replace("const CONFIG = '/etc/worklane/updates.json';", `const CONFIG = ${JSON.stringify(cfgFile)};`).replace("const ETC = '/etc/worklane';", `const ETC = ${JSON.stringify(m.etc)};`).replace("const LOG = '/var/lib/worklane/machine-changes.jsonl';", `const LOG = ${JSON.stringify(m.log)};`).replace("const PENDING = '/var/lib/worklane/pending-signers.json';", `const PENDING = ${JSON.stringify(m.pending)};`);
  const updaterCopy = join(m.root, 'scripts', 'machine', 'worklane-update.cjs');
  writeFileSync(updaterCopy, rewrite(readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs'), 'utf8')));
  const rootCopy = join(m.root, 'scripts', 'setup', 'updates-root.cjs');
  writeFileSync(rootCopy, rewrite(readFileSync(rootSrc, 'utf8')));
  const helperCopy = join(m.root, 'scripts', 'machine', 'worklane-machine.cjs');
  writeFileSync(helperCopy, rewrite(readFileSync(helperSrc, 'utf8')));
  const NEW = 'b'.repeat(40);
  writeFileSync(cfgFile, `${JSON.stringify({ enabled: true, channel: 'main', repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] })}\n`);
  writeFileSync(held, `${JSON.stringify({ sha: NEW, at: new Date(Date.now() - 3_600_000).toISOString(), failed: ['worklane-x.service: failed'] })}\n`);
  const u = require_(updaterCopy) as { run(deps: object): Promise<string> };
  const logs: Record<string, unknown>[] = [];
  /** One run on the real hold file, as realDeps reads it; GitHub and the build stood in, every check green. */
  const once = async () => {
    let current = 'a'.repeat(40);
    let clock = 0;
    const r = await u.run({
      config: () => JSON.parse(readFileSync(cfgFile, 'utf8')),
      held: () => (existsSync(held) ? JSON.parse(readFileSync(held, 'utf8')) : null),
      // What realDeps reported before this change: updates.json's mtime. A write to updates.json must not matter.
      configChangedAt: () => statSync(cfgFile).mtimeMs,
      installed: () => current,
      installedVersion: () => '1.0.0',
      // Both channels see the held commit as their newest: main's tip, and the release tag v1.0.1's commit.
      verifyRelease: () => ({ ok: true, base: 'c'.repeat(40) }),
      exec: (file: string, args: string[]) => (file === 'git' && args.includes('--tags') ? `${'3'.repeat(40)}\trefs/tags/v1.0.1\n${NEW}\trefs/tags/v1.0.1^{}\n` : file === 'git' ? `${NEW}\trefs/heads/main\n` : file === 'systemctl' && args[0] === 'list-units' ? 'worklane-x.service loaded active running x\n' : file === 'systemctl' && args[0] === 'show' ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : ''),
      fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', behind_by: 0, ahead_by: 1, total_commits: 1, commits: [{ sha: NEW, parents: [{ sha: current }], commit: { committer: { date: new Date(0).toISOString() } } }] } : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
      slots: () => [],
      alive: () => false,
      installTree: () => {},
      syncHelpers: () => [],
      switchTo: (sha: string) => (current = sha),
      now: () => clock,
      sleep: async (ms: number) => void (clock += ms),
      log: (e: Record<string, unknown>) => logs.push(e),
      hold: () => {},
      note: (event: string, sha: string | null, reason: string) => (logs.push({ event, to: sha, reason }), event),
    });
    return r;
  };
  const asCoordinator = (...args: string[]) => spawnSync(process.execPath, [helperCopy, ...args], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'wl-alpha' } });
  const asAdmin = (...args: string[]) => spawnSync(process.execPath, [rootCopy, ...args], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'admin' } });
  return { m, held, cfgFile, once, logs, asCoordinator, asAdmin, helperCopy };
}

test('a rolled-back commit\'s hold survives everything a coordinator can run (the channel, the on/off switch) and is released only by updates.sh --release-hold', async () => {
  const h = heldMachine();
  assert.equal(await h.once(), 'held');
  assert.match(String(h.logs.at(-1)!.reason), /held until a newer commit, or until an admin releases it at a root shell: sudo bash \/opt\/worklane\/current\/scripts\/setup\/updates\.sh --release-hold/);
  const holdBytes = readFileSync(h.held, 'utf8');
  // Every command the helper takes that touches the updater, each after the hold: updates.json changes, the hold doesn't.
  for (const args of [['set-update-channel', 'release'], ['set-updates', 'off'], ['set-updates', 'on'], ['set-update-channel', 'release']]) {
    await new Promise((r) => setTimeout(r, 15));
    const r = h.asCoordinator(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(readFileSync(h.held, 'utf8'), holdBytes, `${args.join(' ')} left the hold file as it was`);
    assert.ok(statSync(h.cfgFile).mtimeMs > Date.parse(JSON.parse(holdBytes).at), 'updates.json is newer than the hold');
    assert.equal(await h.once(), args.join(' ') === 'set-updates off' ? 'disabled' : 'held', `still held after ${args.join(' ')}`);
  }
  assert.ok(JSON.parse(readFileSync(h.cfgFile, 'utf8')).channel === 'release' && JSON.parse(readFileSync(h.cfgFile, 'utf8')).enabled === true);
  // The helper names no hold file: it has no way to one.
  assert.doesNotMatch(readFileSync(helperSrc, 'utf8'), /update-held|held\.json|signers-state|-hold/i);
  // At a root shell: shown, moved aside (kept), logged; the next run tries the commit again.
  const r = h.asAdmin('release-hold');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^held: bbbbbbbbbbbb, rolled back at .* \(worklane-x\.service: failed\)\nreleased: the updater may try bbbbbbbbbbbb again on its next run\n$/);
  assert.ok(!existsSync(h.held) && existsSync(h.held.replace(/\.json$/, '.released.json')));
  assert.deepEqual(machineChanges(h.m.log).filter((c) => c.what === 'updates.hold_released').map((c) => c.by), ['admin']);
  assert.equal(await h.once(), 'installed');
  assert.match(h.asAdmin('release-hold').stdout, /^nothing is held/);
});

test('the invariant for every hold the updater keeps under /var/lib: no helper command writes there but its own log and pending list, and the updater never reads updates.json to release one', () => {
  const helper = readFileSync(helperSrc, 'utf8');
  // The helper's only paths under /var/lib: its change log and the staged signers. Not a hold file, of any kind.
  assert.deepEqual([...helper.matchAll(/'\/var\/lib\/[^']*'/g)].map((x) => x[0]).sort(), ["'/var/lib/worklane/machine-changes.jsonl'", "'/var/lib/worklane/pending-signers.json'"]);
  const updater = readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs'), 'utf8');
  // updates.json's mtime (what set-updates and set-update-channel change) plays no part in any hold.
  assert.doesNotMatch(updater, /configChangedAt|mtimeMs/);
  // The one release, by root, named everywhere a hold is shown.
  for (const f of ['src/updates.ts', 'web/src/components/UpdatesPanel.tsx', 'web/src/components/HealthPanel.tsx', 'web/src/components/UpdaterSetup.tsx', 'docs/separate-users.md', 'docs/canary.md']) assert.match(readFileSync(join(repoRoot, f), 'utf8'), /--release-hold|releaseHold/, f);
  for (const f of ['src/updates.ts', 'src/digest.ts', 'web/src/components/UpdatesPanel.tsx', 'web/src/components/HealthPanel.tsx', 'docs/separate-users.md', 'docs/canary.md', 'scripts/machine/worklane-update.cjs']) assert.doesNotMatch(readFileSync(join(repoRoot, f), 'utf8'), /until (updates are turned|you turn updates) off and on|turning updates off and on again retries/, f);
});

// The first-run wizard's Updater screen (server mode; the Machine page's "Updater setup"): install the engine
// updater, add a release signer, pick the channel. Each is one machine helper command an owner reviews and confirms;
// the dashboard records it and the coordinator runs it. The signers file is the root of trust for release updates, so
// most of this is what the screen can't do: add a key the owner didn't see whole, replace or remove one, or weaken
// how the updater verifies (its signature check and its exact-commit build, each with a guard test here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER, signerFingerprint, signerKeyOk, signerPrincipalOk } from '../src/machine.js';
import { machineRefusal } from '../src/machine-requests.js';
import { SETUP_STEPS } from '../src/setup-steps.js';
import { ALLOWED_SIGNERS, listedSigners, signerInput, updaterPlan, updaterSetup } from '../src/updater-setup.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

const require_ = createRequire(import.meta.url);
const helper = require_(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parse(a: string[]): unknown; parseAddSigner(a: string[]): unknown; fingerprint(k: string): string };
const posix = process.platform !== 'win32';

/** A new ed25519 public key as ssh writes it. */
function ed25519() {
  const raw = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]).toString('base64');
}

test('the engine allows exactly what the helper takes: install-updater, the two channels, one email-shaped principal and one ed25519 key', () => {
  const k = ed25519();
  const lists: string[][] = [
    ['install-updater'],
    ['install-updater', 'x'],
    ['set-update-channel', 'release'],
    ['set-update-channel', 'main'],
    ['set-update-channel', 'beta'],
    ['set-update-channel'],
    ['set-update-channel', 'main', 'x'],
    ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['add-update-signer', 'release+signing@example.com', 'ssh-ed25519', k],
    ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k, 'extra'],
    ['add-update-signer', 'owner@example.com', 'ssh-ed25519', `${k}A`],
    ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k.slice(0, -1)],
    ['add-update-signer', 'owner@example.com', 'ssh-ed25519', `AAAAB3NzaC1yc2E${k.slice(15)}`],
    ['add-update-signer', 'owner@example.com', 'ssh-rsa', k],
    ['add-update-signer', '*', 'ssh-ed25519', k],
    ['add-update-signer', '*@example.com', 'ssh-ed25519', k],
    ['add-update-signer', 'a@example.com,b@example.com', 'ssh-ed25519', k],
    ['add-update-signer', '!owner@example.com', 'ssh-ed25519', k],
    ['add-update-signer', 'owner@example.com cert-authority', 'ssh-ed25519', k],
    ['add-update-signer', 'owner@example.com', 'cert-authority', 'ssh-ed25519', k],
    ['add-update-signer', `owner@example.com ssh-ed25519 ${k}`],
    ['remove-update-signer', 'owner@example.com', 'ssh-ed25519', k],
    ['set-update-signers', '/tmp/allowed_signers'],
    ['set-update-verify', 'off'],
  ];
  const helperTakes = (a: string[]) => (a[0] === 'install-updater' ? a.length === 1 : !!helper.parseAddSigner(a) || (a[0] === 'set-update-channel' && !!helper.parse(a)));
  const allowed = lists.filter((a) => checkRootStep(a[0]!, a.slice(1)).allowed);
  assert.deepEqual(allowed, lists.filter(helperTakes), 'the engine and the helper agree on every list');
  assert.deepEqual(allowed.map((a) => a.slice(0, 2).join(' ')), ['install-updater', 'set-update-channel release', 'set-update-channel main', 'add-update-signer owner@example.com', 'add-update-signer release+signing@example.com']);
  for (const a of lists) assert.equal(machineRefusal(a) === null, allowed.includes(a), `a machine request for ${JSON.stringify(a)}`);
  assert.ok(signerPrincipalOk('owner@example.com') && signerKeyOk(k));
  assert.equal(signerFingerprint(k), helper.fingerprint(k), 'the page and the helper name a key the same way');
});

test('what an owner types becomes one exact signer: a .pub line loses only its comment; anything else is refused with why', () => {
  const k = ed25519();
  const want = { principal: 'owner@example.com', key: k, fingerprint: signerFingerprint(k), line: `owner@example.com ssh-ed25519 ${k}` };
  assert.deepEqual(signerInput('owner@example.com', `ssh-ed25519 ${k} owner@laptop`), want);
  assert.deepEqual(signerInput('  owner@example.com ', `  ssh-ed25519 ${k}\n`), want);
  assert.deepEqual(signerInput('owner@example.com', k), want);
  for (const [p, key, why] of [
    ['owner@example.com', `ssh-rsa ${k}`, /adds ssh-ed25519 keys only, not ssh-rsa/],
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

function machineFiles(o: { config?: Record<string, unknown> | null; signers?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'updater-setup-'));
  const updatesConfigPath = join(dir, 'updates.json');
  const signersPath = join(dir, 'allowed_signers');
  if (o.config !== null) writeFileSync(updatesConfigPath, JSON.stringify(o.config ?? { enabled: false, channel: 'release', allowed_signers: ALLOWED_SIGNERS, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }));
  if (o.signers != null) writeFileSync(signersPath, o.signers);
  return { dir, updatesConfigPath, signersPath };
}

test('the setup as the page shows it: installed or not, the channel, each listed signer with its fingerprint, and the script that does the same', () => {
  const [a, b] = [ed25519(), ed25519()];
  const bare = updaterSetup(machineFiles({ config: null }));
  assert.deepEqual([bare.installed, bare.enabled, bare.channel, bare.signers], [false, null, null, null]);
  const f = machineFiles({ signers: `# release keys\n\nfirst@example.com namespaces="git" ssh-ed25519 ${a} laptop\nsecond@example.com ssh-ed25519 ${b}\nrsa@example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7\nnot a signer line\n` });
  const v = updaterSetup(f);
  assert.deepEqual([v.installed, v.enabled, v.channel, v.updaterReads], [true, false, 'release', null]);
  assert.deepEqual(v.signers, [
    { principal: 'first@example.com', options: 'namespaces="git"', keyType: 'ssh-ed25519', key: a, fingerprint: signerFingerprint(a) },
    { principal: 'second@example.com', options: '', keyType: 'ssh-ed25519', key: b, fingerprint: signerFingerprint(b) },
    { principal: 'rsa@example.com', options: '', keyType: 'ssh-rsa', key: 'AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7', fingerprint: signerFingerprint('AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7') },
  ]);
  assert.deepEqual(listedSigners(join(f.dir, 'nope')), null);
  assert.deepEqual(v.channels.map((c) => c.id), ['release', 'main']);
  assert.match(v.channels[1]!.what, /no tag signature is checked/, 'main says what it gives up');
  assert.deepEqual(v.script, {
    install: 'sudo bash scripts/setup/updates.sh',
    channel: 'sudo bash scripts/setup/updates.sh --channel <release|main>',
    signer: 'sudo bash scripts/setup/updates.sh --signer <principal> ssh-ed25519 <public key>',
    signersByHand: `${ALLOWED_SIGNERS}: one line per key, "<principal> <key type> <public key>" (root:root 0644)`,
  });
  // An existing install without a channel follows main; one whose config names another signers file says so.
  const old = updaterSetup(machineFiles({ config: { enabled: true, allowed_signers: '/root/signers' } }));
  assert.deepEqual([old.channel, old.enabled, old.updaterReads], ['main', true, '/root/signers']);
  // The first-run step opens this screen, and names the script.
  const step = SETUP_STEPS.find((s) => s.id === 'updater')!;
  assert.deepEqual(step.fix, { kind: 'screen', path: '/machine', label: "the Machine page's Updater setup" });
  assert.match(step.today, /sudo bash scripts\/setup\/updates\.sh.*--signer <principal> ssh-ed25519 <public key>.*--channel release\|main/);
});

test('a plan says exactly what runs and changes; a signer already listed, the channel already set or no updater yet are refused', () => {
  const k = ed25519();
  const none = updaterSetup(machineFiles({ config: null }));
  const install = updaterPlan({ step: 'install' }, none);
  assert.ok(!('error' in install));
  assert.deepEqual([install.args, install.command, install.script], [['install-updater'], `${MACHINE_HELPER} install-updater`, 'sudo bash scripts/setup/updates.sh']);
  assert.match(install.changes.join('\n'), /with updates off and the channel "release"[\s\S]*doesn't touch \/etc\/worklane\/allowed_signers/);
  assert.deepEqual(updaterPlan({ step: 'channel', channel: 'main' }, none), { error: "the updater isn't installed on this machine yet: install it first" });
  const f = machineFiles({ signers: `owner@example.com ssh-ed25519 ${k}\n` });
  const now = updaterSetup(f);
  assert.match((updaterPlan({ step: 'install' }, now) as { changes: string[] }).changes.join('\n'), /keeps .*updates\.json as it is/);
  const toMain = updaterPlan({ step: 'channel', channel: 'main' }, now);
  assert.ok(!('error' in toMain));
  assert.deepEqual([toMain.args, toMain.script], [['set-update-channel', 'main'], 'sudo bash scripts/setup/updates.sh --channel main']);
  assert.match(toMain.changes.join('\n'), /from "release" to "main"[\s\S]*no tag signature is checked[\s\S]*changes nothing else in/);
  assert.deepEqual(updaterPlan({ step: 'channel', channel: 'release' }, now), { error: 'the channel is already release', status: 409 });
  assert.deepEqual(updaterPlan({ step: 'channel', channel: 'beta' }, now), { error: 'the channel is one of: release, main' });
  assert.deepEqual(updaterPlan({ step: 'signer', principal: 'owner@example.com', key: k }, now), { error: `owner@example.com with this key (${signerFingerprint(k)}) is already listed in ${f.signersPath}`, status: 409 });
  const k2 = ed25519();
  const add = updaterPlan({ step: 'signer', principal: 'second@example.com', key: `ssh-ed25519 ${k2} me@laptop` }, now);
  assert.ok(!('error' in add));
  assert.deepEqual(add.args, ['add-update-signer', 'second@example.com', 'ssh-ed25519', k2]);
  assert.deepEqual(add.signer, { principal: 'second@example.com', key: k2, fingerprint: signerFingerprint(k2), line: `second@example.com ssh-ed25519 ${k2}`, file: ALLOWED_SIGNERS });
  assert.equal(add.script, `sudo bash scripts/setup/updates.sh --signer second@example.com ssh-ed25519 ${k2}`);
  assert.match(add.changes.join('\n'), /adds one line[\s\S]*keeps the 1 signer already listed, unchanged/);
  // There is no step that removes, replaces or turns anything off.
  for (const step of ['remove', 'replace', 'verify', 'signers', undefined]) assert.deepEqual(updaterPlan({ step, principal: 'owner@example.com', key: k }, now), { error: 'step is install, channel or signer' });
});

async function serve(f: ReturnType<typeof machineFiles>, user: string, owners = ['example-owner']) {
  const eventsDb = join(f.dir, 'events.db');
  new EventLog(eventsDb).close();
  const { dir: root } = exampleProject();
  const slotsDir = join(f.dir, 'slots');
  mkdirSync(slotsDir, { recursive: true });
  const ownersFile = machineOwnersFile(...owners);
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: f.dir, user: 'example-owner', roleOf: exampleRoles, slotsDir, machine: { updatesConfigPath: f.updatesConfigPath, signersPath: f.signersPath, changesPath: join(f.dir, 'changes.jsonl'), updatesLogPath: join(f.dir, 'updates.jsonl') }, machineOwnersFile: ownersFile });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson(user) };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/api/machine/updater${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string; plan?: { args: string[]; command: string; signer?: { principal: string; key: string; fingerprint: string; line: string } }; pending?: boolean; machine?: { updater: { channel: string }; requests: { args: string[]; status: string }[] } } };
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
  const machine = async () => (await (await fetch(`${base}/api/machine`, { headers: h })).json()) as { updater: { installed: boolean; channel: string; signers: { principal: string }[] | null } };
  return { d, post, events, tick, machine };
}

test('looking and reviewing change nothing: no request, no audit line, the files as they were (a skipped screen is a machine left alone)', async () => {
  const k = ed25519();
  const f = machineFiles({ signers: `owner@example.com ssh-ed25519 ${ed25519()}\n` });
  const before = [readFileSync(f.updatesConfigPath, 'utf8'), readFileSync(f.signersPath, 'utf8')];
  const x = await serve(f, 'example-owner');
  try {
    const m = await x.machine();
    assert.deepEqual([m.updater.installed, m.updater.channel, m.updater.signers?.map((s) => s.principal)], [true, 'release', ['owner@example.com']]);
    for (const body of [{ step: 'install' }, { step: 'channel', channel: 'main' }, { step: 'signer', principal: 'second@example.com', key: k }]) {
      const r = await x.post('/review', body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.plan!.command, /^\/usr\/local\/libexec\/worklane-machine (install-updater|set-update-channel main|add-update-signer second@example\.com ssh-ed25519 )/);
      // And the change itself, sent without the confirming click: refused.
      const unconfirmed = await x.post('', body);
      assert.equal(unconfirmed.status, 400);
      assert.match(unconfirmed.body.error!, /review what it shows .* then confirm it/);
    }
    assert.deepEqual(x.events('machine.requested'), [], 'nothing was asked of the coordinator');
    assert.deepEqual(x.events('dashboard.audit').filter((a) => a.action === 'machine.updater'), []);
    assert.equal(x.tick(() => assert.fail('nothing to run')), 0);
    assert.deepEqual([readFileSync(f.updatesConfigPath, 'utf8'), readFileSync(f.signersPath, 'utf8')], before);
  } finally {
    await x.d.close();
  }
});

test('a signer is added only as the exact key the review showed: the confirm carries its fingerprint, and the coordinator runs that one command', async () => {
  const [k, other] = [ed25519(), ed25519()];
  const f = machineFiles();
  const x = await serve(f, 'example-owner');
  try {
    const review = await x.post('/review', { step: 'signer', principal: 'owner@example.com', key: `ssh-ed25519 ${k} owner@laptop` });
    assert.deepEqual(review.body.plan!.signer, { principal: 'owner@example.com', key: k, fingerprint: signerFingerprint(k), line: `owner@example.com ssh-ed25519 ${k}`, file: ALLOWED_SIGNERS }, 'the exact principal, key, fingerprint and line');
    const shown = review.body.plan!.signer!.fingerprint;
    // Confirmed with no fingerprint, or with the one shown for a different key: refused, nothing recorded.
    for (const body of [
      { step: 'signer', principal: 'owner@example.com', key: k, confirm: true },
      { step: 'signer', principal: 'owner@example.com', key: other, confirm: true, fingerprint: shown },
      { step: 'signer', principal: 'owner@example.com', key: k, confirm: 'yes', fingerprint: shown },
    ]) {
      const r = await x.post('', body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
    }
    assert.match((await x.post('', { step: 'signer', principal: 'owner@example.com', key: other, confirm: true, fingerprint: shown })).body.error!, new RegExp(`confirm the key that was shown: this key's fingerprint is ${signerFingerprint(other).replace(/[+/]/g, '\\$&')}`));
    assert.deepEqual(x.events('machine.requested'), []);
    const ok = await x.post('', { step: 'signer', principal: 'owner@example.com', key: k, confirm: true, fingerprint: shown });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.pending, true);
    assert.deepEqual(ok.body.machine!.requests.map((r) => [r.args.join(' '), r.status]), [[`add-update-signer owner@example.com ssh-ed25519 ${k}`, 'pending']]);
    assert.deepEqual(x.events('dashboard.audit').filter((a) => a.action === 'machine.updater').map((a) => [a.login, (a.detail as { step: string; args: string[]; fingerprint: string }).args, (a.detail as { fingerprint: string }).fingerprint]), [['example-owner', ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k], shown]]);
    const calls: string[][] = [];
    assert.equal(x.tick((file, args) => (calls.push([file, ...args]), 'added')), 1);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'add-update-signer', 'owner@example.com', 'ssh-ed25519', k]], 'one helper command, through sudo -n, with exactly those arguments');
  } finally {
    await x.d.close();
  }
});

test('install and channel: confirmed, they become install-updater and set-update-channel for the coordinator; the page never writes the files', async () => {
  const f = machineFiles();
  const before = readFileSync(f.updatesConfigPath, 'utf8');
  const x = await serve(f, 'example-owner');
  try {
    assert.equal((await x.post('', { step: 'install', confirm: true })).status, 200);
    assert.equal((await x.post('', { step: 'channel', channel: 'main', confirm: true })).status, 200);
    assert.equal((await x.post('', { step: 'channel', channel: 'release', confirm: true })).status, 409, 'already release');
    assert.equal((await x.post('', { step: 'channel', channel: 'nightly', confirm: true })).status, 400);
    assert.equal(readFileSync(f.updatesConfigPath, 'utf8'), before, 'the dashboard changed nothing itself');
    const calls: string[][] = [];
    assert.equal(x.tick((file, args) => (calls.push([file, ...args]), 'ok')), 2);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'install-updater'], ['sudo', '-n', MACHINE_HELPER, 'set-update-channel', 'main']]);
  } finally {
    await x.d.close();
  }
});

test('only an instance owner who is a machine owner may: a writer is refused the review and the change, an owner who is no machine owner the change', async () => {
  const k = ed25519();
  const body = { step: 'signer', principal: 'owner@example.com', key: k, confirm: true, fingerprint: signerFingerprint(k) };
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

test('updates.sh does the same from a terminal: --channel and --signer go through the helper\'s own code, checked before anything is installed', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  assert.match(s, /^helper="\$\(cd "\$\(dirname "\$0"\)\/\.\.\/machine" && pwd\)\/worklane-machine\.cjs"$/m);
  assert.match(s, /^  node "\$helper" set-update-channel "\$channel"$/m);
  assert.match(s, /^  node "\$helper" add-update-signer "\$\{signer\[@\]\}"$/m);
  // Both are checked with the helper's parsers before the first thing is installed.
  const firstInstall = s.indexOf('install -d -o root -g root -m 0755 /usr/local/libexec');
  for (const check of ["require(process.argv[1]).parse(process.argv.slice(2))", "require(process.argv[1]).parseAddSigner(process.argv.slice(2))"]) {
    const at = s.indexOf(check);
    assert.ok(at > 0 && at < firstInstall, `${check} comes before the install`);
  }
  // The script itself never writes, empties or removes the signers file: only the helper's add does.
  assert.doesNotMatch(s, />>?\s*"?\/etc\/worklane\/allowed_signers|rm [^\n]*allowed_signers|sed [^\n]*allowed_signers|truncate|tee [^\n]*allowed_signers/);
  // And nothing in it loosens the updater: no flag for the signers path, for skipping verification, or for no checks.
  assert.doesNotMatch(s, /--no-verify|--skip-verify|--insecure|--allowed-signers|--no-checks/);
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
  // The owner's key added after the other one, as the helper writes it (a line appended): now it installs.
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
  assert.doesNotMatch(src, /add-update-signer|set-update-channel|install-updater/);
  const helperSrc = readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs'), 'utf8');
  assert.doesNotMatch(helperSrc, /verify-tag|required_checks|unlinkSync|rmSync|truncate/);
});

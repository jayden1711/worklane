// Issue #726: on a single machine an instance's policy.yaml is root's, and only root changes it. Stand-ins only: no
// test runs as root, so "root" is this test's own uid where a root-owned file has to exist (setPolicyRootUid,
// PolicyRootDeps.rootUid), and the real root (uid 0) where the coordinator user's own file must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { instanceAutoMerge, loadInstanceSetup, readPolicy } from '../src/instance.js';
import { processIdentity } from '../src/os/index.js';
import { autoMergeKilled, killAutoMerge, killSwitchPath } from '../src/policy-kill.js';
import { applyPolicy, POLICY_KEYS, PolicyEditError, policyForm } from '../src/policy-edit.js';
import { changeSetting, SETTING_KEYS, settingsReader, SettingsError } from '../src/settings.js';
import { decodePolicyValue, POLICY_ROOT_DIR, POLICY_SET_KEYS, readPolicyChecked, setPolicyRootUid } from '../src/policy-gate.js';
import { ownPolicy, policyCommand, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { policyRootChecks } from '../src/doctor-policy-root.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
// A root policy is a Linux machine install's: the gate asks the kernel where the opened file is (/proc/self/fd).
const skip = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';
const cfg = loadConfig(exampleProject().dir);
const me = posix ? process.getuid!() : 0;
const POLICY = `version: 1
# the operator's own notes stay
budget: { daily_usd: 50 }
agents: { max_workers: 4 }
land_mode: pr
auto_merge: false
`;

/** A machine instance: wl-<name>'s home, its instance home and policy.yaml (0600, the coordinator's, as setup made it before). */
function machineInstance(name: string, policy = POLICY, o: { linkedHomes?: boolean } = {}) {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'policy-root-')));
  mkdirSync(join(T, 'home'));
  // A machine whose homes sit under a link (/home -> /data/home): the engine's path to the file goes through it.
  const homes = o.linkedHomes ? join(T, 'homes-link') : join(T, 'home');
  if (o.linkedHomes) symlinkSync(join(T, 'home'), homes);
  const instances = join(homes, `wl-${name}`, '.local', 'state', BRAND.cli, 'instances');
  const dir = join(instances, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'policy.yaml');
  writeFileSync(file, policy, { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === `wl-${name}` ? join(homes, `wl-${name}`) : null), uid: () => me, rootUid: me, rootGid: posix ? process.getgid!() : 0, limitsPath: join(T, 'limits.json') };
  return { T, instances, dir, file, deps };
}
/** The coordinator user's own file in place of the policy (here: written by this test's uid, so "root's" only to a stand-in). */
function coordinatorWrites(m: { dir: string; file: string }, text: string, mode = 0o600) {
  writeFileSync(join(m.dir, '.mine'), text, { mode });
  chmodSync(join(m.dir, '.mine'), mode);
  renameSync(join(m.dir, '.mine'), m.file);
}
/** As if this test's uid were root, for the engine's reads. */
function asRoot<R>(fn: () => R): R {
  setPolicyRootUid(me);
  try {
    return fn();
  } finally {
    setPolicyRootUid(0);
  }
}

test('an admin makes an existing coordinator-owned policy.yaml root\'s with its content unchanged, and is shown a loose key', { skip }, () => {
  const loose = `${POLICY}sandbox: false\n`;
  const m = machineInstance('reown', loose);
  // Before: the engine reads it as it always has (no record yet).
  assert.equal(readPolicy(m.file).policy?.sandbox, false);
  const ino = statSync(m.file).ino;
  const r = ownPolicy('reown', m.deps, { acceptLoose: true });
  assert.equal(readFileSync(m.file, 'utf8'), loose, 'byte for byte');
  const st = statSync(m.file);
  assert.equal(st.mode & 0o777, 0o644);
  assert.notEqual(st.ino, ino, 'a new file root wrote, not the old one chmodded');
  assert.deepEqual(JSON.parse(readFileSync(join(POLICY_ROOT_DIR, 'reown'), 'utf8')), { file: m.file, sha256: createHash('sha256').update(loose).digest('hex') }, "root's record names exactly this file, and what root wrote there");
  assert.deepEqual(r.loose, ['sandbox: false'], 'what a coordinator-user process may have loosened is shown');
  assert.equal(asRoot(() => readPolicy(m.file).policy?.sandbox), false);
  // A link planted under the name is never followed: refused, and its target untouched.
  const n = machineInstance('reown-link');
  const target = join(n.T, 'elsewhere.yaml');
  writeFileSync(target, POLICY, { mode: 0o600 });
  renameSync(n.file, join(n.dir, 'old.yaml'));
  symlinkSync(target, n.file);
  assert.throws(() => ownPolicy('reown-link', n.deps), /ELOOP|link/);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  // A directory on the way that the coordinator made a link (to another instance's home, say): refused before anything
  // is read or written there.
  const k = machineInstance('reown-dir');
  const local = join(k.T, 'home', 'wl-reown-dir', '.local');
  renameSync(local, join(k.T, 'elsewhere'));
  symlinkSync(join(k.T, 'elsewhere'), local);
  assert.throws(() => ownPolicy('reown-dir', k.deps), /a link on the way/);
  assert.equal(statSync(join(k.T, 'elsewhere', 'state', BRAND.cli, 'instances', 'reown-dir', 'policy.yaml')).mode & 0o777, 0o600);
});

test("the coordinator user's write to a root policy.yaml is refused", { skip }, () => {
  const m = machineInstance('refuse');
  ownPolicy('refuse', m.deps);
  const text = readFileSync(m.file, 'utf8');
  // The engine's own writers (Settings, the Policy form) never write it.
  asRoot(() => {
    assert.throws(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'events.db'), key: 'workers', value: 1, by: cfg.project.owners.default, owner: true }), (e: Error) => e instanceof SettingsError && /is root's/.test(e.message));
    assert.throws(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: true }, eventsDb: join(m.T, 'events.db'), by: 'olive' }), (e: Error) => e instanceof PolicyEditError && /is root's/.test(e.message));
  });
  assert.equal(readFileSync(m.file, 'utf8'), text, 'nothing written');
  // A file the coordinator user puts in its place (here: a file of a uid that isn't root's) is never read.
  const reader = asRoot(() => settingsReader(m.file, join(m.T, 'limits.json')));
  assert.equal(asRoot(() => reader()).error, null);
  writeFileSync(join(m.dir, 'mine.yaml'), `${POLICY}sandbox: false\nallow_same_user: true\nsettings: { workers: 1 }\n`, { mode: 0o600 });
  renameSync(join(m.dir, 'mine.yaml'), m.file);
  const r = readPolicy(m.file);
  assert.equal(r.policy, undefined);
  assert.match(r.errors[0]!.message, new RegExp(`refused: .*belongs to uid ${me}, not root.*sudo ${BRAND.cli} policy own refuse`));
  const s = reader();
  assert.match(s.error ?? '', /refused/);
  assert.deepEqual(s.settings, {}, 'the last settings read stay, never the new file\'s');
  writeFileSync(join(m.dir, 'instance.yaml'), 'version: 1\nname: refuse\nrepos:\n  - path: "x"\n    repo: example/refuse\n');
  writeFileSync(join(m.dir, 'credentials.yaml'), 'version: 1\ngithub: { kind: gh-config-dir, path: "/x" }\n');
  assert.throws(() => loadInstanceSetup('refuse', m.instances), /refused/, 'the instance does not load: it fails closed');
  assert.throws(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'events.db'), key: 'workers', value: 1, by: cfg.project.owners.default, owner: true }), /refused/);
  // Even "root's" own uid: never through a link, nor a file with a second name.
  const l = machineInstance('refuse-link');
  ownPolicy('refuse-link', l.deps);
  renameSync(l.file, join(l.T, 'kept.yaml'));
  symlinkSync(join(l.T, 'kept.yaml'), l.file);
  assert.match(asRoot(() => readPolicy(l.file)).errors[0]!.message, /is a link/);
  const h = machineInstance('refuse-hard');
  ownPolicy('refuse-hard', h.deps);
  linkSync(h.file, join(h.T, 'second-name.yaml'));
  assert.match(asRoot(() => readPolicy(h.file)).errors[0]!.message, /2 names/);
});

test("root's policy set: one checked key, written root's with the file's comments; never sandbox or allow_same_user, and no loosening for a coordinator", { skip }, () => {
  const m = machineInstance('rootset');
  assert.throws(() => setPolicy('rootset', 'auto_merge', 'on', null, m.deps), /isn't root's yet/, 'only a policy setup made root\'s');
  ownPolicy('rootset', m.deps);
  assert.deepEqual(setPolicy('rootset', 'auto_merge', 'on', 'wl-rootset', m.deps), { key: 'auto_merge', from: false, to: true });
  assert.deepEqual(setPolicy('rootset', 'settings.run_windows', '0900-1700', 'wl-rootset', m.deps), { key: 'settings.run_windows', from: null, to: [{ from: '09:00', to: '17:00' }] });
  assert.match(readFileSync(m.file, 'utf8'), /# the operator's own notes stay/);
  assert.equal(statSync(m.file).mode & 0o777, 0o644);
  assert.equal(asRoot(() => readPolicy(m.file).policy?.auto_merge), true);
  const text = readFileSync(m.file, 'utf8');
  assert.throws(() => setPolicy('rootset', 'sandbox', 'off', 'wl-rootset', m.deps), /isn't a key/);
  assert.throws(() => setPolicy('rootset', 'allow_same_user', 'on', null, m.deps), /isn't a key/, 'not even an admin, this way');
  assert.throws(() => setPolicy('rootset', 'land_mode', 'direct', 'wl-rootset', m.deps), /loosens the instance/);
  assert.throws(() => setPolicy('rootset', 'main_watch', 'off', 'wl-rootset', m.deps), /loosens the instance/);
  assert.throws(() => setPolicy('rootset', 'budget.daily_usd', '5000', null, m.deps), /machine limits/);
  assert.throws(() => setPolicy('rootset', 'auto_merge', 'yes', null, m.deps), /isn't a value/);
  assert.equal(readFileSync(m.file, 'utf8'), text, 'nothing written by a refusal');
  // An admin at a root shell (no coordinator behind sudo) may loosen land_mode.
  assert.deepEqual(setPolicy('rootset', 'land_mode', 'direct', null, m.deps), { key: 'land_mode', from: 'pr', to: 'direct' });
});

test("policy set's keys are exactly the dashboard's (the Policy form's and the Settings page's); values are plain words", () => {
  assert.deepEqual(Object.keys(POLICY_SET_KEYS).sort(), [...POLICY_KEYS, ...SETTING_KEYS.map((k) => `settings.${k}`)].sort());
  assert.deepEqual(decodePolicyValue('settings.run_windows', '0900-1700+2200-0600'), [{ from: '09:00', to: '17:00' }, { from: '22:00', to: '06:00' }]);
  assert.deepEqual(decodePolicyValue('settings.run_windows', 'none'), []);
  assert.equal(decodePolicyValue('auto_merge', 'off'), false);
  assert.equal(decodePolicyValue('budget.daily_usd', '12.5'), 12.5);
  for (const [k, v] of [['auto_merge', 'true'], ['budget.daily_usd', '1e9'], ['settings.workers', '-1'], ['settings.run_windows', '09:00-17:00'], ['sandbox', 'off']]) assert.equal(decodePolicyValue(k!, v!), undefined, `${k} ${v}`);
});

test('doctor: a machine install whose policy.yaml the coordinator can rewrite is flagged; a recorded one is checked', { skip }, () => {
  const m = machineInstance('doc');
  writeFileSync(join(m.dir, 'instance.yaml'), 'version: 1\nname: doc\nrepos:\n  - path: "x"\n    repo: example/doc\n');
  const flagged = policyRootChecks(m.instances, { machine: true });
  assert.equal(flagged[0]!.level, 'warn');
  assert.match(flagged[0]!.detail, new RegExp(`can rewrite it .*sudo ${BRAND.cli} policy own doc`));
  assert.deepEqual(policyRootChecks(m.instances, { machine: false }), [], 'a laptop, cloud or VM install: nothing');
  ownPolicy('doc', m.deps);
  assert.equal(asRoot(() => policyRootChecks(m.instances, { machine: true }))[0]!.level, 'ok');
  // Recorded, and not root's (the real root is uid 0): a failure, naming the root command.
  const failed = policyRootChecks(m.instances, { machine: true })[0]!;
  assert.equal(failed.level, 'fail');
  assert.match(failed.detail, new RegExp(`sudo ${BRAND.cli} policy own doc.*won't start`));
});

/** `policyCommand`'s exit code, its output kept off the test's. */
function quietly(fn: () => number): { code: number; err: string } {
  const [log, error] = [console.log, console.error];
  let err = '';
  console.log = () => {};
  console.error = (s: unknown) => void (err += `${String(s)}\n`);
  try {
    return { code: fn(), err };
  } finally {
    [console.log, console.error] = [log, error];
  }
}
const refusal = (r: ReturnType<typeof readPolicyChecked>) => (r && 'refused' in r ? r.refused : `not refused: ${JSON.stringify(r)}`);
const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');

test("P6: the machine helper's route to `policy own` (add-project's rerun: no flag) never makes root's a policy looser than its coordinator could make it, nor a recorded one that changed (#726)", { skip }, () => {
  // Unrecorded and loose: refused, left the coordinator's own, nothing recorded.
  const LOOSE = `${POLICY}sandbox: false\nallow_same_user: true\n`;
  const u = machineInstance('loose', LOOSE);
  const ino = statSync(u.file).ino;
  const out = quietly(() => policyCommand('own', ['loose'], u.deps, true));
  assert.equal(out.code, 1);
  assert.match(out.err, new RegExp(`looser than its coordinator could make it \\(allow_same_user: true; sandbox: false\\).*sudo ${BRAND.cli} policy own loose --accept-loose`));
  assert.equal(statSync(u.file).ino, ino, 'never written');
  assert.equal(statSync(u.file).mode & 0o777, 0o600);
  assert.equal(existsSync(join(POLICY_ROOT_DIR, 'loose')), false, 'never recorded');
  // Every other loosening, too: whatever `policy set` from a coordinator couldn't have made.
  for (const [n, text, shown] of [
    ['loose-land', POLICY.replace('land_mode: pr', 'land_mode: direct'), 'land_mode: direct'],
    ['loose-watch', `${POLICY}main_watch: off\n`, 'main_watch: off'],
    ['loose-lanes', `${POLICY}lanes: { default: { allowed_domains: [example.com] } }\n`, 'lanes.default.allowed_domains: ["example.com"]'],
    ['loose-cap', `${POLICY}settings: { model_cap: opus }\n`, 'settings.model_cap: opus'],
    ['loose-budget', POLICY.replace('daily_usd: 50', 'daily_usd: 500'), 'budget.daily_usd 500 is over 100'],
  ] as const) {
    const k = machineInstance(n, text);
    assert.throws(() => ownPolicy(n, k.deps), (e: Error) => e.message.includes(shown) && e.message.includes('--accept-loose'), n);
    assert.equal(existsSync(join(POLICY_ROOT_DIR, n)), false, n);
  }
  // What the coordinator could have set itself through `policy set`: taken over, no flag.
  const ok = machineInstance('in-reach', `${POLICY.replace('daily_usd: 50', 'daily_usd: 30')}settings: { workers: 3, run_windows: [{ from: "09:00", to: "17:00" }] }\n`);
  assert.deepEqual(ownPolicy('in-reach', ok.deps).loose, []);
  // An admin, at a root shell, having checked it.
  assert.equal(quietly(() => policyCommand('own', ['loose', '--accept-loose'], u.deps, true)).code, 0);
  assert.equal(asRoot(() => readPolicy(u.file).policy?.sandbox), false);
  assert.equal(quietly(() => policyCommand('own', ['loose', '--yes'], u.deps, true)).code, 2, 'no other flag');

  // Recorded, and replaced by the coordinator's own file since: refused, even one within reach; the gate refuses it still.
  const r = machineInstance('retake');
  ownPolicy('retake', r.deps);
  coordinatorWrites(r, POLICY.replace('daily_usd: 50', 'daily_usd: 60'));
  assert.throws(() => ownPolicy('retake', r.deps), new RegExp(`isn't what root last wrote there.*sudo ${BRAND.cli} policy own retake --retake`));
  assert.match(refusal(asRoot(() => readPolicyChecked(r.file))), /isn't what root last wrote/);
  coordinatorWrites(r, LOOSE);
  assert.throws(() => ownPolicy('retake', r.deps, { retake: true }), /policy own retake --retake --accept-loose/, 'retaking a loose one takes both');
  coordinatorWrites(r, POLICY.replace('daily_usd: 50', 'daily_usd: 60'));
  ownPolicy('retake', r.deps, { retake: true });
  assert.equal(asRoot(() => readPolicy(r.file).policy?.budget.daily_usd), 60);
  // The same bytes root wrote, in a file of the coordinator's: root's content, taken back with no flag.
  coordinatorWrites(r, readFileSync(r.file, 'utf8'));
  assert.doesNotThrow(() => ownPolicy('retake', r.deps));

  // Setup's own_policy passes no flag (the engine as root gets `policy own <name>`), and no script passes one.
  const T = mkdtempSync(join(tmpdir(), 'own-policy-'));
  const fake = join(T, 'engine');
  writeFileSync(fake, '#!/bin/sh\necho "$@" >> "$0.args"\n', { mode: 0o755 });
  assert.equal(spawnSync('bash', ['-c', 'source "$1"; ENGINE_CLI="$2"; own_policy alpha', '_', lib, fake], { encoding: 'utf8' }).status, 0);
  assert.equal(readFileSync(`${fake}.args`, 'utf8'), 'policy own alpha\n');
  for (const d of ['setup', 'machine']) {
    for (const f of readdirSync(join(repoRoot, 'scripts', d), { recursive: true, encoding: 'utf8' })) {
      if (statSync(join(repoRoot, 'scripts', d, f)).isFile()) assert.doesNotMatch(readFileSync(join(repoRoot, 'scripts', d, f), 'utf8'), /--accept-loose|--retake/, `scripts/${d}/${f}`);
    }
  }
});

test('P2: a home under a link (/home -> /data/home) keeps the gate on: the record is keyed on the instance, not the path string (#726)', { skip }, () => {
  const m = machineInstance('linked', POLICY, { linkedHomes: true });
  ownPolicy('linked', m.deps);
  assert.notEqual(realpathSync(m.file), m.file, 'the engine spells the path through the link');
  assert.equal(asRoot(() => readPolicy(m.file).policy?.budget.daily_usd), 50, 'root\'s file, read through the link');
  coordinatorWrites(m, `${POLICY}sandbox: false\n`, 0o666);
  const r = asRoot(() => readPolicy(m.file));
  assert.equal(r.policy, undefined, 'a world-writable replacement is never read');
  assert.match(r.errors[0]!.message, /refused: .*may be written by others/);
});

test("P3: a record the coordinator can't read refuses the policy, never skips the gate; root writes it 0755/0644 whatever its umask (#726)", { skip }, () => {
  const m = machineInstance('unread');
  const markers = join(m.T, 'markers');
  ownPolicy('unread', { ...m.deps, markerDir: markers });
  coordinatorWrites(m, `${POLICY}sandbox: false\n`, 0o666);
  assert.match(refusal(asRoot(() => readPolicyChecked(m.file, markers))), /may be written by others/);
  if (me !== 0) {
    chmodSync(markers, 0);
    try {
      assert.match(refusal(asRoot(() => readPolicyChecked(m.file, markers))), /record of it .* can't be read \(EACCES\)/);
    } finally {
      chmodSync(markers, 0o755);
    }
  }
  writeFileSync(join(markers, 'unread'), `${m.file}\n`);
  assert.match(refusal(asRoot(() => readPolicyChecked(m.file, markers))), /isn't one this engine reads/, 'a record this engine can\'t read');
  // Root's umask 077 (a hardened root shell, or sudo from an admin with it): the record is still readable to all.
  const n = machineInstance('umask');
  const fresh = join(n.T, 'etc', 'policy-root');
  const old = process.umask(0o077);
  try {
    ownPolicy('umask', { ...n.deps, markerDir: fresh });
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(join(n.T, 'etc')).mode & 0o777, 0o755);
  assert.equal(statSync(fresh).mode & 0o777, 0o755);
  assert.equal(statSync(join(fresh, 'umask')).mode & 0o777, 0o644);
  assert.equal(statSync(n.file).mode & 0o777, 0o644);
  assert.ok(asRoot(() => readPolicyChecked(n.file, fresh)) !== null, 'and the gate covers it');
});

test('P1: a directory on the way swapped for a link (to a root file of the same bytes) is refused: the gate checks where the opened file really is (#726)', { skip }, () => {
  const m = machineInstance('dirlink');
  ownPolicy('dirlink', m.deps);
  const other = join(m.T, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'policy.yaml'), readFileSync(m.file, 'utf8'), { mode: 0o644 });
  renameSync(m.dir, join(m.T, 'stash-dir'));
  symlinkSync(other, m.dir);
  assert.match(refusal(asRoot(() => readPolicyChecked(m.file))), new RegExp(`the file opened is ${join(other, 'policy.yaml')}, not ${m.file}.*a link on the way`));
});

test("P5: an earlier root file the coordinator kept aside during root's `set` and put back later is refused, and never changed or taken back as root's (#726)", { skip }, () => {
  const m = machineInstance('stash');
  ownPolicy('stash', m.deps);
  setPolicy('stash', 'land_mode', 'direct', null, m.deps);
  // The admin tightens it again; the coordinator, watching its own directory, renames the live root file aside between
  // root's read and root's rename (root's rename is the moment it sees root's temp file).
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const rename = fs.renameSync;
  let stashed = false;
  fs.renameSync = ((a: string, b: string) => {
    if (!stashed && String(a).startsWith('.policy.yaml.') && b === 'policy.yaml') {
      rename('policy.yaml', '.coordinator-stash');
      stashed = true;
    }
    return rename(a, b);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    setPolicy('stash', 'land_mode', 'pr', null, m.deps);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.ok(stashed);
  assert.equal(asRoot(() => readPolicy(m.file).policy?.land_mode), 'pr');
  // Any time later: the earlier root file (root's, 0644, one name) put back.
  renameSync(join(m.dir, '.coordinator-stash'), m.file);
  const r = asRoot(() => readPolicy(m.file));
  assert.equal(r.policy, undefined, 'land_mode direct is never read again');
  assert.match(r.errors[0]!.message, /its content isn't what root last wrote there/);
  assert.throws(() => setPolicy('stash', 'budget.daily_usd', '40', 'wl-stash', m.deps), /isn't what root last wrote there/, 'nor changed and recorded as root\'s');
  assert.throws(() => ownPolicy('stash', m.deps), /--retake/, 'nor taken back by setup');
  // auto_merge off never reads it (root's kill switch): it works on the put-back file too, and leaves it and the record as they are.
  const record = readFileSync(join(POLICY_ROOT_DIR, 'stash'), 'utf8');
  const putBack = readFileSync(m.file, 'utf8');
  assert.deepEqual(setPolicy('stash', 'auto_merge', 'off', 'wl-stash', m.deps), { key: 'auto_merge', from: null, to: false });
  assert.equal(readFileSync(m.file, 'utf8'), putBack);
  assert.equal(readFileSync(join(POLICY_ROOT_DIR, 'stash'), 'utf8'), record);
});

test("rename: a recorded instance's policy.yaml is root's and recorded under the new name, its content as carried; an unrecorded one's isn't taken over (#726)", { skip }, () => {
  // Root's under the old name (an admin accepted it loose, once).
  const LOOSE = `${POLICY}sandbox: false\n`;
  const o = machineInstance('oldname', LOOSE);
  const markers = join(o.T, 'markers');
  ownPolicy('oldname', { ...o.deps, markerDir: markers }, { acceptLoose: true });
  // instance-rename.sh's home step: the file carried to the new name's home, the new coordinator's (0600 here).
  const n = machineInstance('newname', readFileSync(o.file, 'utf8'));
  const calls = join(n.T, 'calls');
  const carry = (from: string, to: string) => spawnSync('bash', ['-c', 'source "$1"; POLICY_ROOT_DIR="$2"; CALLS="$3"; own_policy() { echo "own_policy $*" >> "$CALLS"; }; carry_policy_root "$4" "$5"', '_', lib, markers, calls, from, to], { encoding: 'utf8' });
  // Root's auto_merge kill switch under the old name: carried too, so a rename never turns auto_merge back on.
  writeFileSync(join(markers, 'oldname.auto-merge-off'), 'auto_merge off\n', { mode: 0o644 });
  assert.equal(carry('oldname', 'newname').status, 0);
  assert.equal(readFileSync(calls, 'utf8'), 'own_policy newname\n');
  assert.equal(autoMergeKilled('newname', markers), true);
  // The engine's `policy own newname`, as the script runs it (no flag): the carried bytes are root's content.
  ownPolicy('newname', { ...n.deps, markerDir: markers });
  assert.equal(statSync(n.file).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(join(markers, 'newname'), 'utf8')), { file: n.file, sha256: createHash('sha256').update(LOOSE).digest('hex') });
  const gate = asRoot(() => readPolicyChecked(n.file, markers));
  assert.ok(gate && 'text' in gate && gate.text === LOOSE);
  // Carried, but changed on the way: refused, the rename stops at its home step.
  const c = machineInstance('changed', `${POLICY}allow_same_user: true\n`);
  copyFileSync(join(markers, 'oldname'), join(markers, 'changed'));
  assert.throws(() => ownPolicy('changed', { ...c.deps, markerDir: markers }), /--retake/);
  // Unrecorded under the old name: no record made, nothing taken over.
  assert.equal(carry('never', 'other').status, 0);
  assert.equal(readFileSync(calls, 'utf8'), 'own_policy newname\n');
  assert.equal(existsSync(join(markers, 'other')), false);
  // The rename script's home step runs it.
  assert.match(readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-rename.sh'), 'utf8'), /\n {2}carry_policy_root "\$old" "\$new"\n/);
});

test("`policy check <name>` (read-only) is 0 only when the engine's gate would read the policy: not before root's record, not with an earlier root file put back; it changes nothing (#726)", { skip }, () => {
  const m = machineInstance('check');
  const check = () => quietly(() => policyCommand('check', ['check'], m.deps, false));
  assert.match(check().err, /isn't root's yet/, 'no record');
  assert.equal(check().code, 1);
  ownPolicy('check', m.deps);
  const earlier = readFileSync(m.file, 'utf8');
  assert.equal(check().code, 0, 'root takes no part: a reader may ask');
  setPolicy('check', 'budget.daily_usd', '60', null, m.deps);
  assert.equal(check().code, 0);
  // An earlier root file put back: root's, 0644, one name, recorded; not what root last wrote.
  writeFileSync(join(m.dir, '.earlier'), earlier, { mode: 0o644 });
  renameSync(join(m.dir, '.earlier'), m.file);
  const record = readFileSync(join(POLICY_ROOT_DIR, 'check'), 'utf8');
  const out = check();
  assert.equal(out.code, 1);
  assert.match(out.err, /its content isn't what root last wrote there/);
  assert.equal(readFileSync(m.file, 'utf8'), earlier, 'read only');
  assert.equal(readFileSync(join(POLICY_ROOT_DIR, 'check'), 'utf8'), record, 'read only');
});

test("root's writers of one instance's policy are serialized: a coordinator's set-policy that read before an admin's `policy set land_mode pr` never writes after it, putting back what the admin changed (#726)", { skip }, () => {
  const m = machineInstance('race');
  ownPolicy('race', m.deps);
  setPolicy('race', 'land_mode', 'direct', null, m.deps); // the admin accepted direct, once
  // The reviewer's interleaving: the coordinator's set-policy has read policy.yaml; as it opens its temp file, the
  // admin's `policy set land_mode pr` runs whole.
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const open = fs.openSync;
  let admin: string | null = null;
  let ran = false;
  fs.openSync = ((p: string, ...rest: unknown[]) => {
    if (!ran && String(p).startsWith('.policy.yaml.')) {
      ran = true;
      try {
        setPolicy('race', 'land_mode', 'pr', null, { ...m.deps, lockWaitMs: 0 });
        admin = 'ran';
      } catch (e) {
        admin = (e as Error).message;
      }
    }
    return (open as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    setPolicy('race', 'budget.daily_usd', '40', 'wl-race', m.deps);
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
  assert.ok(ran);
  // The admin's change waits for (here: is refused during) the coordinator's; run again, as the admin would, it lands.
  if (admin !== 'ran') {
    assert.match(admin!, /another root change to race's policy is in progress/);
    setPolicy('race', 'land_mode', 'pr', null, m.deps);
  }
  const p = asRoot(() => readPolicy(m.file).policy)!;
  assert.equal(p.land_mode, 'pr', "the admin's tightening is never rolled back");
  assert.equal(p.budget.daily_usd, 40);
  assert.ok(asRoot(() => readPolicyChecked(m.file)) !== null && 'text' in asRoot(() => readPolicyChecked(m.file))!);
});

/** A process that keeps running until killed: a live lock holder. */
function liveHolder() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const id = processIdentity(c.pid!);
  assert.ok(id, 'the holder runs');
  return { pid: c.pid!, line: `${c.pid} ${id}\n`, stop: () => c.kill('SIGKILL') };
}

test("root's lock on an instance's policy: one a live writer holds makes `own` and `set` wait, then refuse, naming it; nothing changes; it is gone after each; auto_merge off never waits for it (#726)", { skip }, () => {
  const m = machineInstance('locked');
  ownPolicy('locked', m.deps);
  setPolicy('locked', 'auto_merge', 'on', null, m.deps);
  const lock = join(POLICY_ROOT_DIR, '.locked.lock');
  assert.equal(existsSync(lock), false, 'released after own and set');
  const text = readFileSync(m.file, 'utf8');
  const h = liveHolder();
  try {
    writeFileSync(lock, h.line);
    const d = { ...m.deps, lockWaitMs: 100 };
    assert.throws(() => setPolicy('locked', 'budget.daily_usd', '60', null, d), new RegExp(`in progress \\(${lock.replace(/[.]/g, '\\.')}, held by ${h.pid} `));
    assert.throws(() => ownPolicy('locked', d), /in progress/);
    assert.equal(readFileSync(m.file, 'utf8'), text);
    // OFF: root's kill switch, no lock: at once, while it is held.
    const t = performance.now();
    assert.deepEqual(setPolicy('locked', 'auto_merge', 'off', 'wl-locked', d), { key: 'auto_merge', from: null, to: false });
    assert.ok(performance.now() - t < 1000, 'never waited');
    assert.equal(asRoot(() => readPolicy(m.file)).policy?.auto_merge, false, 'the engine reads off');
    assert.equal(readFileSync(lock, 'utf8'), h.line, "the holder's lock untouched");
  } finally {
    h.stop();
  }
  // Its holder gone (killed, not yet reaped: a zombie still answers signal 0): the lock is stale, broken, and a writer goes on.
  for (let i = 0; i < 100 && processIdentity(h.pid) !== null; i++) spawnSync('sleep', ['0.05']);
  assert.equal(processIdentity(h.pid), null, 'a killed holder reads as gone');
  setPolicy('locked', 'budget.daily_usd', '60', null, m.deps);
  assert.equal(existsSync(lock), false, 'released after set');
});

test("a lock a writer left empty (killed between creating it and writing its line) is live for a few seconds, then stale; a garbage one is stale; and `own` never clears root's kill switch (#726 round 4 adversarial pass)", { skip }, () => {
  const m = machineInstance('empty');
  ownPolicy('empty', m.deps);
  const lock = join(POLICY_ROOT_DIR, '.empty.lock');
  writeFileSync(lock, '');
  assert.throws(() => setPolicy('empty', 'budget.daily_usd', '60', null, { ...m.deps, lockWaitMs: 100 }), /in progress/, 'a fresh empty lock: a writer still writing its line');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  setPolicy('empty', 'budget.daily_usd', '60', null, { ...m.deps, lockWaitMs: 100 });
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, 'not-a-pid x\n');
  setPolicy('empty', 'budget.daily_usd', '61', null, { ...m.deps, lockWaitMs: 100 });
  assert.equal(existsSync(lock), false);
  // auto_merge off, then an admin retaking the file (or setup taking it back): the switch stays; only `set on` clears it.
  setPolicy('empty', 'auto_merge', 'off', null, m.deps);
  ownPolicy('empty', m.deps, { retake: true });
  assert.equal(autoMergeKilled('empty'), true);
});

test("a root writer that died inside the lock (SIGKILL in `own`, add-project's call) leaves no lock that blocks anyone: auto_merge off works, and so does the next writer (#726 round 3)", { skip }, () => {
  const m = machineInstance('died');
  ownPolicy('died', m.deps);
  setPolicy('died', 'auto_merge', 'on', null, m.deps);
  // The coordinator puts its own file there, so add-project's rerun runs `own`; root's `own` is killed while it reads.
  coordinatorWrites(m, readFileSync(m.file, 'utf8').replace('daily_usd: 50', 'daily_usd: 51'));
  const child = join(m.T, 'own-child.mjs');
  writeFileSync(child, `import { createRequire, syncBuiltinESMExports } from 'node:module';
const a = JSON.parse(process.argv[2]);
const fs = createRequire(import.meta.url)('node:fs');
const open = fs.openSync;
fs.openSync = (p, ...r) => { if (p === 'policy.yaml') process.kill(process.pid, 'SIGKILL'); return open(p, ...r); };
syncBuiltinESMExports();
const { ownPolicy } = await import(a.module);
ownPolicy(a.name, { home: () => a.home, uid: () => a.uid, rootUid: a.uid, rootGid: a.gid, markerDir: a.markers, limitsPath: a.limits });
`);
  const r = spawnSync(process.execPath, [child, JSON.stringify({ module: pathToFileURL(join(repoRoot, 'dist', 'src', 'policy-root.js')).href, name: 'died', home: join(m.T, 'home', 'wl-died'), uid: me, gid: process.getgid!(), markers: POLICY_ROOT_DIR, limits: join(m.T, 'limits.json') })], { encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  const lock = join(POLICY_ROOT_DIR, '.died.lock');
  assert.ok(existsSync(lock), 'it died holding the lock');
  // auto_merge off: at once; the engine reads off whatever policy.yaml says.
  assert.deepEqual(setPolicy('died', 'auto_merge', 'off', 'wl-died', { ...m.deps, lockWaitMs: 100 }), { key: 'auto_merge', from: null, to: false });
  assert.equal(autoMergeKilled('died'), true);
  // The next root writer breaks the dead holder's lock and goes on (here: an admin retaking the file, checked).
  ownPolicy('died', { ...m.deps, lockWaitMs: 100 }, { retake: true });
  assert.equal(existsSync(lock), false);
  assert.equal(asRoot(() => readPolicy(m.file)).policy?.auto_merge, false, 'still off: only an admin turns it on');
});

test("`own` refuses an oversized policy.yaml from fstat, before reading or parsing it, and a changed one before parsing it; neither holds the lock; auto_merge off works, and the engine reads off (#726 round 3)", { skip }, () => {
  const m = machineInstance('big');
  ownPolicy('big', m.deps);
  setPolicy('big', 'auto_merge', 'on', null, m.deps);
  // Oversized: 2 MB the coordinator planted.
  coordinatorWrites(m, `${POLICY}# ${'x'.repeat(2 * 1024 * 1024)}\n`);
  const t = performance.now();
  assert.throws(() => ownPolicy('big', m.deps), /is \d+ bytes, over 262144, so it isn't read/);
  assert.ok(performance.now() - t < 2000, 'refused at once');
  assert.equal(existsSync(join(POLICY_ROOT_DIR, '.big.lock')), false, 'the lock released');
  assert.match(refusal(asRoot(() => readPolicyChecked(m.file))), /bytes, over 262144/, 'the gate refuses it, unread, too');
  setPolicy('big', 'auto_merge', 'off', 'wl-big', m.deps);
  assert.equal(instanceAutoMerge('big', m.instances), false, 'the engine reads off without reading the policy');
  // Changed and corrupt (not YAML): refused as changed, never parsed.
  const c = machineInstance('corrupt');
  ownPolicy('corrupt', c.deps);
  setPolicy('corrupt', 'auto_merge', 'on', null, c.deps);
  coordinatorWrites(c, 'version: 1\nbudget: [ {{{ :\n');
  assert.throws(() => ownPolicy('corrupt', c.deps), /isn't what root last wrote there/);
  setPolicy('corrupt', 'auto_merge', 'off', 'wl-corrupt', c.deps);
  assert.equal(instanceAutoMerge('corrupt', c.instances), false, 'off: the corrupt policy is never read');
});

test("auto_merge off is root's kill switch alone: it opens no policy.yaml and no lock (a lint on its module, and every path it touches), the coordinator can't make, remove or replace it, and only root's `set on` clears it (#726, the owner's structural decision)", { skip }, () => {
  // Its module imports nothing that reads policy.yaml or takes the lock.
  const src = readFileSync(join(repoRoot, 'src', 'policy-kill.ts'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((x) => x[1]).sort();
  assert.deepEqual(imports, ['./os/system-paths.js', 'node:crypto', 'node:fs', 'node:path']);
  const m = machineInstance('kill');
  ownPolicy('kill', m.deps);
  setPolicy('kill', 'auto_merge', 'on', null, m.deps);
  // Every path the OFF call touches through node:fs.
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const names = ['openSync', 'readFileSync', 'lstatSync', 'statSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'chmodSync', 'unlinkSync', 'linkSync'];
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const touched: string[] = [];
  for (const n of names) fs[n] = (p: unknown, ...r: unknown[]) => (touched.push(String(p)), (orig[n] as (...a: unknown[]) => unknown)(p, ...r));
  syncBuiltinESMExports();
  try {
    setPolicy('kill', 'auto_merge', 'off', 'wl-kill', m.deps);
  } finally {
    for (const n of names) fs[n] = orig[n];
    syncBuiltinESMExports();
  }
  assert.ok(touched.length > 0);
  assert.deepEqual(touched.filter((p) => /policy\.yaml$|\.lock$/.test(p) || p === m.dir || p.startsWith(`${m.dir}/`)), [], 'no policy.yaml, no lock, nothing in the instance home');
  // The switch: root's (the stand-in), 0644, in root's 0755 directory: the coordinator user can't write there.
  const flag = killSwitchPath('kill');
  assert.equal(statSync(flag).mode & 0o777, 0o644);
  assert.equal(statSync(flag).uid, me);
  assert.equal(statSync(POLICY_ROOT_DIR).mode & 0o777, 0o755);
  assert.equal(asRoot(() => readPolicy(m.file)).policy?.auto_merge, false);
  assert.equal(asRoot(() => policyForm(m.file)).fields.find((f) => f.key === 'auto_merge')!.value, false, 'the form shows off');
  // Root's ON clears it (a coordinator's ON is refused by #770's HELPER_ONLY).
  assert.ok(existsSync(flag));
  setPolicy('kill', 'auto_merge', 'on', null, m.deps);
  assert.equal(existsSync(flag), false);
  assert.equal(asRoot(() => readPolicy(m.file)).policy?.auto_merge, true);
  // A name that isn't an instance's never names a file (a path outside root's directory, a user that doesn't exist).
  const users = { ...m.deps, uid: (u: string) => (u === 'wl-kill' ? me : null) };
  for (const bad of ['../kill', 'kill/x', '.', 'Kill', 'nouser']) assert.throws(() => setPolicy(bad, 'auto_merge', 'off', 'wl-kill', users), /not an instance name|no instance/, bad);
  assert.equal(existsSync(join(POLICY_ROOT_DIR, '..', 'kill.auto-merge-off')), false);
  assert.throws(() => killAutoMerge('../kill'), /not an instance name/);
  // Anything at its name counts as off (fail closed): a link, a directory.
  symlinkSync('/nonexistent', flag);
  assert.equal(autoMergeKilled('kill'), true);
  renameSync(flag, join(m.T, 'gone-link'));
  mkdirSync(flag);
  assert.equal(autoMergeKilled('kill'), true);
});

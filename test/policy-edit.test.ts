// Issue #726: on a single machine an instance's policy.yaml is root's, and only root changes it. Stand-ins only: no
// test runs as root, so "root" is this test's own uid where a root-owned file has to exist (setPolicyRootUid,
// PolicyRootDeps.rootUid), and the real root (uid 0) where the coordinator user's own file must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import { loadInstanceSetup, readPolicy } from '../src/instance.js';
import { applyPolicy, POLICY_KEYS, PolicyEditError } from '../src/policy-edit.js';
import { changeSetting, SETTING_KEYS, settingsReader, SettingsError } from '../src/settings.js';
import { decodePolicyValue, encodePolicyValue, POLICY_ROOT_DIR, POLICY_SET_KEYS, setPolicyRootUid } from '../src/policy-gate.js';
import { ownPolicy, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { policyRootChecks } from '../src/doctor-policy-root.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { MachineRequestError, machineRequests, requestPolicyChange } from '../src/machine-requests.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { exampleProject, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const skip = !posix && 'POSIX owners and modes';
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const helper = createRequire(import.meta.url)(helperSrc) as { parsePolicySet: (a: string[]) => { key: string; value: string } | null; POLICY_SET_KEYS: Record<string, string> };
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
function machineInstance(name: string, policy = POLICY) {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'policy-root-')));
  const instances = join(T, 'home', `wl-${name}`, '.local', 'state', BRAND.cli, 'instances');
  const dir = join(instances, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'policy.yaml');
  writeFileSync(file, policy, { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === `wl-${name}` ? join(T, 'home', `wl-${name}`) : null), uid: () => me, rootUid: me, rootGid: posix ? process.getgid!() : 0, limitsPath: join(T, 'limits.json') };
  return { T, instances, dir, file, deps };
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
/** The helper through sudo, stood in: its own argument check, then the engine's `policy set` as root with SUDO_USER wl-<name>. */
const helperStandIn = (name: string, deps: PolicyRootDeps, calls: string[][]) => (file: string, args: string[]) => {
  calls.push([file, ...args]);
  assert.deepEqual(args.slice(0, 2), ['-n', MACHINE_HELPER]);
  const p = helper.parsePolicySet(args.slice(2));
  if (!p) throw Object.assign(new Error('usage'), { stderr: 'usage: worklane-machine ...' });
  return JSON.stringify(asRoot(() => setPolicy(name, p.key, p.value, `wl-${name}`, deps)));
};

test('setup makes an existing coordinator-owned policy.yaml root\'s with its content unchanged, and shows a loose key', { skip }, () => {
  const loose = `${POLICY}sandbox: false\n`;
  const m = machineInstance('reown', loose);
  // Before: the engine reads it as it always has (no record yet).
  assert.equal(readPolicy(m.file).policy?.sandbox, false);
  const ino = statSync(m.file).ino;
  const r = ownPolicy('reown', m.deps);
  assert.equal(readFileSync(m.file, 'utf8'), loose, 'byte for byte');
  const st = statSync(m.file);
  assert.equal(st.mode & 0o777, 0o644);
  assert.notEqual(st.ino, ino, 'a new file root wrote, not the old one chmodded');
  assert.equal(readFileSync(join(POLICY_ROOT_DIR, 'reown'), 'utf8').trim(), m.file, "root's record names exactly this file");
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

test("a dashboard change to auto_merge (and a Settings change) still works, through root's helper", { skip }, () => {
  const m = machineInstance('change');
  ownPolicy('change', m.deps);
  const log = new EventLog(':memory:');
  const asked: string[][] = [];
  const request = (args: string[]) => (asked.push(args), requestPolicyChange(log, { args, by: 'olive', breakGlass: false }).id);
  asRoot(() => {
    assert.deepEqual(applyPolicy({ path: m.file, cfg, values: { auto_merge: true }, eventsDb: join(m.T, 'events.db'), by: 'olive', request }), [{ key: 'auto_merge', from: false, to: true }]);
    assert.ok(changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'events.db'), key: 'workers', value: 1, by: cfg.project.owners.default, owner: true, request }).requested);
  });
  assert.deepEqual(asked, [['set-policy', 'auto_merge', 'on'], ['set-policy', 'settings.workers', '1']]);
  assert.match(readFileSync(m.file, 'utf8'), /auto_merge: false/, 'the dashboard wrote nothing itself');
  // The coordinator's next tick: each through the helper, as root.
  const calls: string[][] = [];
  assert.equal(runMachineRequests({ log, instance: 'change', exec: helperStandIn('change', m.deps, calls) }), 2);
  assert.deepEqual(calls.map((c) => c.slice(3)), asked);
  assert.deepEqual(machineRequests(log.read(0)).map((r) => r.status), ['done', 'done']);
  const p = asRoot(() => readPolicy(m.file).policy)!;
  assert.equal(p.auto_merge, true);
  assert.equal(p.settings.workers, 1);
  assert.equal(statSync(m.file).mode & 0o777, 0o644);
  assert.match(readFileSync(m.file, 'utf8'), /# the operator's own notes stay/);
  const changed = log.read(0, ['settings.changed']).map((e) => e.payload as { key: string; from: unknown; to: unknown; by: string });
  assert.deepEqual(changed.map((c) => [c.key, c.from, c.to, c.by]), [['policy.auto_merge', false, true, 'olive'], ['workers', null, 1, 'olive']]);
});

test("root's helper refuses sandbox: false and allow_same_user: true from the dashboard (and a loosening of land_mode or main_watch)", { skip }, () => {
  const loosen = [['sandbox', 'off'], ['allow_same_user', 'on'], ['land_mode', 'direct'], ['main_watch', 'off'], ['lanes', 'none'], ['network_allow', 'none']];
  for (const [k, v] of loosen) {
    assert.equal(helper.parsePolicySet(['set-policy', k!, v!]), null, `${k} ${v}`);
    assert.equal(checkRootStep('set-policy', [k!, v!]).allowed, false, `${k} ${v}`);
    // The helper itself, as a process: usage, nothing run.
    const r = spawnSync(process.execPath, [helperSrc, 'set-policy', k!, v!], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SUDO_USER: 'wl-loose' } });
    assert.equal(r.status, 2, `${k} ${v}: ${r.stderr}`);
    assert.match(r.stderr, /usage: /);
  }
  assert.ok(helper.parsePolicySet(['set-policy', 'land_mode', 'pr']) && helper.parsePolicySet(['set-policy', 'main_watch', 'auto']), 'tightening is taken');
  const m = machineInstance('loose');
  ownPolicy('loose', m.deps);
  const text = readFileSync(m.file, 'utf8');
  const log = new EventLog(':memory:');
  assert.throws(() => requestPolicyChange(log, { args: ['set-policy', 'sandbox', 'off'], by: 'olive', breakGlass: false }), MachineRequestError);
  // The Policy form refuses before asking anything.
  let asked = 0;
  asRoot(() => assert.throws(() => applyPolicy({ path: m.file, cfg, values: { land_mode: 'direct' }, eventsDb: join(m.T, 'e.db'), by: 'olive', request: () => String(++asked) }), /loosening it is an admin's/));
  assert.equal(asked, 0);
  // A request written to the log some other way: the coordinator refuses it, and never runs the helper.
  log.append('machine.requested', { id: 'mr-x', args: ['set-policy', 'allow_same_user', 'on'], by: 'olive', via: 'policy', ask: null }, 'olive', 'human');
  const calls: string[][] = [];
  runMachineRequests({ log, instance: 'loose', exec: helperStandIn('loose', m.deps, calls) });
  assert.deepEqual(calls, []);
  assert.equal(machineRequests(log.read(0))[0]!.status, 'refused');
  assert.equal(readFileSync(m.file, 'utf8'), text);
});

test("the machine helper's set-policy table is the engine's; a dashboard value passes as one plain word", () => {
  assert.deepEqual(helper.POLICY_SET_KEYS, POLICY_SET_KEYS);
  const windows = [{ from: '09:00', to: '17:00' }, { from: '22:00', to: '06:00' }];
  assert.equal(encodePolicyValue('settings.run_windows', windows), '0900-1700+2200-0600');
  assert.deepEqual(decodePolicyValue('settings.run_windows', encodePolicyValue('settings.run_windows', windows)!), windows);
  assert.equal(encodePolicyValue('settings.run_windows', []), 'none');
  assert.equal(encodePolicyValue('auto_merge', 'yes'), null);
  assert.equal(encodePolicyValue('budget.daily_usd', 12.5), '12.5');
  assert.equal(encodePolicyValue('sandbox', false), null);
  for (const [k, v] of [['settings.workers', '3'], ['settings.run_windows', '0900-1700'], ['automations.enabled', 'off'], ['settings.stuck_guard', 'dry-run']]) assert.ok(helper.parsePolicySet(['set-policy', k!, v!]), `${k} ${v}`);
});

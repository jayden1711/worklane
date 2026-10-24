// lint-test
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
import { EventLog } from '../src/events/log.js';
import { instanceAutoMerge, loadInstanceSetup, readPolicy } from '../src/instance.js';
import { processIdentity } from '../src/os/index.js';
import { aliasInstance, armedSwitches, autoMergeKilled, idDir, instanceId, killAutoMerge } from '../src/policy-kill.js';
import { applyPolicy, POLICY_KEYS, PolicyEditError, policyForm } from '../src/policy-edit.js';
import { changeSetting, POLICY_CHECK_REFUSED, SETTING_KEYS, settingsReader, SettingsError } from '../src/settings.js';
import { DETAIL_LOGGED, refusalText } from '../src/user-facing-error.js';
import { DASHBOARD_TIGHTEN_ONLY, decodePolicyValue, encodePolicyValue, HELPER_ONLY, POLICY_ROOT_DIR, POLICY_SET_KEYS, readPolicyChecked, setPolicyRootUid } from '../src/policy-gate.js';
import * as gate from '../src/policy-gate.js';
import { ownPolicy, policyCommand, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { policyRootChecks } from '../src/doctor-policy-root.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { MachineRequestError, machineRequests, requestPolicyChange } from '../src/machine-requests.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { exampleProject, repoRoot } from './helpers.js';
import { onRealMachine } from './isolate.js';

const posix = process.platform !== 'win32';
// A root policy is a Linux machine install's: the gate asks the kernel where the opened file is (/proc/self/fd).
const skip = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const helper = createRequire(import.meta.url)(helperSrc) as { parsePolicySet: (a: string[]) => { key: string; value: string } | null; POLICY_SET_KEYS: Record<string, string>; POLICY_ONLY: Record<string, string> };
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
/** The helper through sudo, stood in: its own argument check, then the engine's `policy set` as root with SUDO_USER wl-<name>. */
const helperStandIn = (name: string, deps: PolicyRootDeps, calls: string[][]) => (file: string, args: string[]) => {
  calls.push([file, ...args]);
  assert.deepEqual(args.slice(0, 2), ['-n', MACHINE_HELPER]);
  const p = helper.parsePolicySet(args.slice(2));
  if (!p) throw Object.assign(new Error('usage'), { stderr: 'usage: worklane-machine ...' });
  return JSON.stringify(asRoot(() => setPolicy(name, p.key, p.value, `wl-${name}`, deps)));
};

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
    // (A lowering: round 10 refuses a raise past root's value before this, #726.)
    assert.throws(() => applyPolicy({ path: m.file, cfg, values: { 'budget.daily_usd': 40 }, eventsDb: join(m.T, 'events.db'), by: 'olive' }), (e: Error) => e instanceof PolicyEditError && /is root's/.test(e.message));
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
  assert.throws(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'events.db'), key: 'workers', value: 1, by: cfg.project.owners.default, owner: true }), (e: Error) => {
    // #882: the page gets the engine's words; the gate's refusal, which names the file and root's record, is the
    // cause, which the route logs (refusalText).
    assert.ok(e instanceof SettingsError);
    assert.equal(e.message, POLICY_CHECK_REFUSED);
    const lines: string[] = [];
    assert.equal(refusalText('POST /api/instance-settings', e, (l) => lines.push(l)), `${POLICY_CHECK_REFUSED}; ${DETAIL_LOGGED}`);
    assert.ok(lines.some((l) => l.includes(m.file) && l.includes('policy own refuse')), `the refusal is logged: ${JSON.stringify(lines)}`);
    return true;
  });
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
  assert.throws(() => setPolicy('rootset', 'auto_merge', 'on', 'wl-rootset', m.deps), /loosens the instance/, 'auto_merge on: root\'s alone');
  assert.deepEqual(setPolicy('rootset', 'auto_merge', 'on', null, m.deps), { key: 'auto_merge', from: false, to: true });
  // Round 11: the coordinator's route can't tell the windows in effect (the repo's config sets them), so setting them is
  // the admin's; through 7289dac3 the coordinator's route set them. The admin's write is checked as before.
  assert.throws(() => setPolicy('rootset', 'settings.run_windows', '0900-1700', 'wl-rootset', m.deps), /the value in effect isn't in policy\.yaml.*policy set rootset settings\.run_windows 0900-1700/);
  assert.deepEqual(setPolicy('rootset', 'settings.run_windows', '0900-1700', null, m.deps), { key: 'settings.run_windows', from: null, to: [{ from: '09:00', to: '17:00' }] });
  // Once root set them, the coordinator's route may narrow them.
  assert.equal(setPolicy('rootset', 'settings.run_windows', '1000-1600', 'wl-rootset', m.deps).key, 'settings.run_windows');
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

test("a dashboard change to auto_merge (turning it off) and a Settings change still work, through root's helper", { skip }, () => {
  const m = machineInstance('change');
  ownPolicy('change', m.deps);
  // Turning it on is root's alone (the owner's decision on #770): an admin at a root shell.
  setPolicy('change', 'auto_merge', 'on', null, m.deps);
  const log = new EventLog(':memory:');
  const asked: string[][] = [];
  const request = (args: string[]) => (asked.push(args), requestPolicyChange(log, { args, by: 'olive', breakGlass: false }).id);
  asRoot(() => {
    // auto_merge off alone on a root policy: asked for without reading policy.yaml, so its `from` is unknown (null).
    assert.deepEqual(applyPolicy({ path: m.file, cfg, values: { auto_merge: false }, eventsDb: join(m.T, 'events.db'), by: 'olive', request }), [{ key: 'auto_merge', from: null, to: false }]);
    assert.ok(changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'events.db'), key: 'workers', value: 1, by: cfg.project.owners.default, owner: true, request }).requested);
  });
  assert.deepEqual(asked, [['set-policy', 'auto_merge', 'off'], ['set-policy', 'settings.workers', '1']]);
  assert.match(readFileSync(m.file, 'utf8'), /auto_merge: true/, 'the dashboard wrote nothing itself');
  // The coordinator's next tick: each through the helper, as root.
  const calls: string[][] = [];
  assert.equal(runMachineRequests({ log, instance: 'change', exec: helperStandIn('change', m.deps, calls) }), 2);
  assert.deepEqual(calls.map((c) => c.slice(3)), asked);
  assert.deepEqual(machineRequests(log.read(0)).map((r) => r.status), ['done', 'done']);
  const p = asRoot(() => readPolicy(m.file).policy)!;
  assert.equal(p.auto_merge, false);
  assert.equal(p.settings.workers, 1);
  assert.equal(statSync(m.file).mode & 0o777, 0o644);
  assert.match(readFileSync(m.file, 'utf8'), /# the operator's own notes stay/);
  const changed = log.read(0, ['settings.changed']).map((e) => e.payload as { key: string; from: unknown; to: unknown; by: string });
  // auto_merge off is root's kill switch: policy.yaml is never read, so its `from` is unknown (null).
  assert.deepEqual(changed.map((c) => [c.key, c.from, c.to, c.by]), [['policy.auto_merge', null, false, 'olive'], ['workers', null, 1, 'olive']]);
});

test("auto_merge on is root's alone (#770, the owner's decision): the dashboard never asks for it, the coordinator refuses a forged request, and the helper refuses it; off is taken everywhere", { skip }, () => {
  const m = machineInstance('am-on');
  ownPolicy('am-on', m.deps);
  const text = readFileSync(m.file, 'utf8');
  const log = new EventLog(':memory:');
  let asked = 0;
  const request = () => String(++asked);
  // The Policy form refuses before asking, naming the root command.
  asRoot(() => assert.throws(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: true }, eventsDb: join(m.T, 'e.db'), by: 'olive', request }), new RegExp(`auto_merge true: loosening it is an admin's, at a root shell \\(sudo ${BRAND.cli} policy set am-on auto_merge on\\)`)));
  assert.equal(asked, 0);
  assert.throws(() => requestPolicyChange(log, { args: ['set-policy', 'auto_merge', 'on'], by: 'olive', breakGlass: false }), MachineRequestError);
  // A request written to the log some other way: the coordinator refuses it, and never runs the helper.
  log.append('machine.requested', { id: 'mr-am', args: ['set-policy', 'auto_merge', 'on'], by: 'olive', via: 'policy', ask: null }, 'olive', 'human');
  const calls: string[][] = [];
  runMachineRequests({ log, instance: 'am-on', exec: helperStandIn('am-on', m.deps, calls) });
  assert.deepEqual(calls, []);
  assert.equal(machineRequests(log.read(0))[0]!.status, 'refused');
  // The helper: on is usage (the process too), off is taken; root's `policy set` from a coordinator refuses on.
  assert.equal(helper.parsePolicySet(['set-policy', 'auto_merge', 'on']), null);
  assert.deepEqual(helper.parsePolicySet(['set-policy', 'auto_merge', 'off']), { key: 'auto_merge', value: 'off' });
  const r = spawnSync(process.execPath, [helperSrc, 'set-policy', 'auto_merge', 'on'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SUDO_USER: 'wl-am-on' } });
  assert.equal(r.status, 2, r.stderr);
  assert.throws(() => setPolicy('am-on', 'auto_merge', 'on', 'wl-am-on', m.deps), /loosens the instance/);
  assert.equal(readFileSync(m.file, 'utf8'), text, 'nothing written');
  // Only root, at a root shell; then the dashboard may turn it off again.
  setPolicy('am-on', 'auto_merge', 'on', null, m.deps);
  assert.equal(checkRootStep('set-policy', ['auto_merge', 'off']).allowed, true);
  asRoot(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: false }, eventsDb: join(m.T, 'e.db'), by: 'olive', request }));
  assert.equal(asked, 1);
  // The Policy form offers only off, and names the root command for on.
  const f = asRoot(() => policyForm(m.file)).fields.find((x) => x.key === 'auto_merge')!;
  assert.equal(f.only, false);
  assert.equal(f.root, `sudo ${BRAND.cli} policy set am-on auto_merge on`);
  // `policy own` (setup, no flag) never takes over a coordinator's file with it on.
  const n = machineInstance('am-own', POLICY.replace('auto_merge: false', 'auto_merge: true'));
  assert.throws(() => ownPolicy('am-own', n.deps), /auto_merge: true.*--accept-loose/);
});

test("auto_merge on is never the dashboard's on ANY install: an unrecorded policy (laptop, cloud, VM, or a machine not taken over) refuses it too, naming the admin's route, writing and logging nothing; off is still written, and the form offers only off (#770)", { skip }, () => {
  const m = machineInstance('unrec', POLICY.replace('auto_merge: false', 'auto_merge: true'));
  const events = join(m.T, 'events.db');
  const changed = () => (existsSync(events) ? new EventLog(events).read(0, ['settings.changed']).length : 0);
  // Its coordinator's file, read as before (no record); turning auto_merge off is written there, as before.
  assert.deepEqual(applyPolicy({ path: m.file, cfg, values: { auto_merge: false }, eventsDb: events, by: 'olive', machine: false }), [{ key: 'auto_merge', from: true, to: false }]);
  assert.match(readFileSync(m.file, 'utf8'), /auto_merge: false/);
  assert.equal(changed(), 1);
  const off = readFileSync(m.file, 'utf8');
  // On: refused, nothing written or logged. A laptop, cloud or VM install: an admin edits the file (or the Helm value).
  assert.throws(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: true }, eventsDb: events, by: 'olive', machine: false }), new RegExp(`auto_merge true: that is an admin's alone, never this form's \\(edit ${m.file.replace(/[.]/g, '\\.')} \\(auto_merge: true\\), or its Helm value\\); here it may only be false`));
  // A machine install not taken over yet: root takes it over, then sets it.
  assert.throws(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: true }, eventsDb: events, by: 'olive', machine: true }), new RegExp(`\\(sudo ${BRAND.cli} policy own unrec, then sudo ${BRAND.cli} policy set unrec auto_merge on\\)`));
  assert.equal(readFileSync(m.file, 'utf8'), off, 'nothing written');
  assert.equal(changed(), 1, 'nothing logged');
  // The form offers only off, naming the route.
  const f = policyForm(m.file, undefined, true).fields.find((x) => x.key === 'auto_merge')!;
  assert.deepEqual([f.only, f.root], [false, `sudo ${BRAND.cli} policy own unrec, then sudo ${BRAND.cli} policy set unrec auto_merge on`]);
  // Inverted (the owner's decision, 2026-10-19, principle 6): land_mode and main_watch are tighten-only on an
  // unrecorded policy too. Until then this line held `only` undefined for land_mode here ("the brief: auto_merge only").
  const form = policyForm(m.file, undefined, true).fields;
  assert.deepEqual(['land_mode', 'main_watch'].map((k) => form.find((x) => x.key === k)!.only), ['pr', 'auto']);
});

test("land_mode is tighten-only on the dashboard on EVERY install (the owner's decision, 2026-10-19, principle 6): an unrecorded policy can't be set to direct, nor main_watch off, from the Policy form; pr and auto still can; the tables hold every HELPER_ONLY key (#770)", { skip }, () => {
  assert.deepEqual([...DASHBOARD_TIGHTEN_ONLY].sort(), Object.keys(HELPER_ONLY).sort(), 'every key the helper only tightens is tighten-only on the dashboard everywhere');
  for (const machine of [false, true]) {
    const m = machineInstance(`ld${machine ? 'm' : 'l'}`);
    const events = join(m.T, 'events.db');
    const before = readFileSync(m.file, 'utf8');
    // direct (and main_watch off): refused, naming the admin's route; nothing written, nothing logged.
    assert.throws(() => applyPolicy({ path: m.file, cfg, values: { land_mode: 'direct' }, eventsDb: events, by: 'olive', machine }), /land_mode direct: that is an admin's alone, never this form's .*here it may only be pr/);
    assert.throws(() => applyPolicy({ path: m.file, cfg, values: { main_watch: 'off' }, eventsDb: events, by: 'olive', machine }), /main_watch off: that is an admin's alone, never this form's .*here it may only be auto/);
    assert.equal(readFileSync(m.file, 'utf8'), before, 'nothing written');
    assert.equal(existsSync(events) ? new EventLog(events).read(0, ['settings.changed']).length : 0, 0, 'nothing logged');
    // Back to pr (an admin had set direct by hand): still the form's to do.
    writeFileSync(m.file, before.replace('land_mode: pr', 'land_mode: direct'));
    assert.deepEqual(applyPolicy({ path: m.file, cfg, values: { land_mode: 'pr' }, eventsDb: events, by: 'olive', machine }), [{ key: 'land_mode', from: 'direct', to: 'pr' }]);
    assert.match(readFileSync(m.file, 'utf8'), /land_mode: pr/);
  }
});

test("turning auto_merge off (and land_mode back to pr, main_watch back to auto) works on a sudo older than 1.9.10 too: listed whole in sudoers, so the dashboard asks and the helper runs it; anything else is still refused up front (#770)", { skip }, () => {
  const m = machineInstance('oldoff');
  ownPolicy('oldoff', m.deps);
  // An admin's loosenings, at a root shell.
  for (const [k, v] of [['auto_merge', 'on'], ['land_mode', 'direct'], ['main_watch', 'off']] as const) setPolicy('oldoff', k, v, null, m.deps);
  const rules = join(m.T, 'helper-rules.json');
  writeFileSync(rules, JSON.stringify({ sudo: '1.9.9', patterns_min: '1.9.10', left_out: ['add-project', 'stage-update-signer', 'discard-update-signer', 'claude-account-profiles', 'plugins', 'set-policy'] }));
  const log = new EventLog(':memory:');
  const request = (args: string[]) => requestPolicyChange(log, { args, by: 'olive', breakGlass: false }).id;
  asRoot(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: false, land_mode: 'pr', main_watch: 'auto' }, eventsDb: join(m.T, 'e.db'), by: 'olive', request, helperRulesFile: rules }));
  assert.deepEqual(machineRequests(log.read(0)).map((r) => r.args), [['set-policy', 'land_mode', 'pr'], ['set-policy', 'auto_merge', 'off'], ['set-policy', 'main_watch', 'auto']]);
  // The coordinator's next tick, through the helper (as root's sudo lets it on that sudo: the literal rules).
  const calls: string[][] = [];
  assert.equal(runMachineRequests({ log, instance: 'oldoff', exec: helperStandIn('oldoff', m.deps, calls) }), 3);
  const p = asRoot(() => readPolicy(m.file).policy)!;
  assert.deepEqual([p.auto_merge, p.land_mode, p.main_watch], [false, 'pr', 'auto']);
  // A change only the pattern rule takes is still refused up front, nothing asked.
  let asked = 0;
  assert.throws(() => asRoot(() => applyPolicy({ path: m.file, cfg, values: { 'budget.daily_usd': 40 }, eventsDb: join(m.T, 'e.db'), by: 'olive', request: () => String(++asked), helperRulesFile: rules })), /older than 1\.9\.10/);
  assert.equal(asked, 0);
  // The machine CLI turns it off too: an admin at a root shell, or a coordinator through sudo.
  setPolicy('oldoff', 'auto_merge', 'on', null, m.deps);
  assert.equal(quietly(() => policyCommand('set', ['oldoff', 'auto_merge', 'off'], m.deps, true)).code, 0);
  assert.equal(asRoot(() => readPolicy(m.file).policy)!.auto_merge, false);
  setPolicy('oldoff', 'auto_merge', 'on', null, m.deps);
  assert.deepEqual(setPolicy('oldoff', 'auto_merge', 'off', 'wl-oldoff', m.deps), { key: 'auto_merge', from: null, to: false });
});

test("auto_merge OFF from the dashboard works with root's lock held by a live writer, with one a dead writer left, with an oversized and with a corrupt policy.yaml: through root's helper to the kill switch, and the engine reads off in all four (#726 round 4)", { skip }, () => {
  const states: [string, (m: ReturnType<typeof machineInstance>) => () => void][] = [
    // onRealMachine: throws unless root's directory is inside this test's system root (#815).
    ['off-live', () => { const h = liveHolder(); onRealMachine(POLICY_ROOT_DIR); writeFileSync(join(POLICY_ROOT_DIR, '.off-live.lock'), h.line); return h.stop; }],
    ['off-dead', () => { const r = spawnSync(process.execPath, ['-e', '']); onRealMachine(POLICY_ROOT_DIR); writeFileSync(join(POLICY_ROOT_DIR, '.off-dead.lock'), `${r.pid} gone\n`); return () => {}; }],
    ['off-huge', (m) => { coordinatorWrites(m, `${POLICY}# ${'x'.repeat(2 * 1024 * 1024)}\n`); return () => {}; }],
    ['off-corrupt', (m) => { coordinatorWrites(m, 'version: 1\nbudget: [ {{{ :\n'); return () => {}; }],
  ];
  for (const [name, plant] of states) {
    const m = machineInstance(name);
    ownPolicy(name, m.deps);
    setPolicy(name, 'auto_merge', 'on', null, m.deps); // an admin's, at a root shell
    const done = plant(m);
    try {
      const log = new EventLog(':memory:');
      const request = (args: string[]) => requestPolicyChange(log, { args, by: 'olive', breakGlass: false }).id;
      // The Policy form asks for it without reading policy.yaml.
      assert.deepEqual(asRoot(() => applyPolicy({ path: m.file, cfg, values: { auto_merge: false }, eventsDb: join(m.T, 'e.db'), by: 'olive', request })), [{ key: 'auto_merge', from: null, to: false }], name);
      // The coordinator runs it through root's helper (its own argument check, then `policy set` as root).
      const calls: string[][] = [];
      assert.equal(runMachineRequests({ log, instance: name, exec: helperStandIn(name, { ...m.deps, lockWaitMs: 100 }, calls) }), 1, name);
      assert.deepEqual(machineRequests(log.read(0)).map((r) => r.status), ['done'], name);
      assert.equal(autoMergeKilled(name), true, name);
      assert.equal(instanceAutoMerge(name, m.instances), false, `${name}: the engine reads off`);
    } finally {
      done();
    }
  }
});

test("on a sudo older than 1.9.10 (helper-rules.json leaves set-policy out), Settings and the Policy form refuse up front, naming the root command, and record no request", { skip }, () => {
  const m = machineInstance('oldsudo');
  ownPolicy('oldsudo', m.deps);
  const rules = join(m.T, 'helper-rules.json');
  let asked = 0;
  const request = () => String(++asked);
  // (A lowering: round 11 refuses a raise from the dashboard before anything else.)
  const settings = () => asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key: 'daily_budget_usd', value: 30, by: cfg.project.owners.default, owner: true, request, helperRulesFile: rules }));
  const form = () => asRoot(() => applyPolicy({ path: m.file, cfg, values: { 'budget.daily_usd': 40 }, eventsDb: join(m.T, 'e.db'), by: 'olive', request, helperRulesFile: rules }));
  // As machine-helper.sh writes it on such a sudo; and as an earlier one wrote it, before set-policy existed.
  for (const leftOut of [['add-project', 'stage-update-signer', 'discard-update-signer', 'claude-account-profiles', 'plugins', 'set-policy'], ['add-project', 'stage-update-signer', 'discard-update-signer', 'claude-account-profiles', 'plugins']]) {
    writeFileSync(rules, JSON.stringify({ sudo: '1.9.9', patterns_min: '1.9.10', left_out: leftOut }));
    assert.throws(settings, new RegExp(`sudo \\(1\\.9\\.9\\) is older than 1\\.9\\.10.*sudo ${BRAND.cli} policy set oldsudo settings\\.daily_budget_usd 30`));
    assert.throws(form, new RegExp(`sudo \\(1\\.9\\.9\\) is older than 1\\.9\\.10.*sudo ${BRAND.cli} policy set oldsudo budget\\.daily_usd 40`));
    assert.equal(asked, 0, 'no request recorded');
  }
  // A sudo that takes the pattern (nothing left out), or no record at all: asked of the coordinator, as before.
  writeFileSync(rules, JSON.stringify({ sudo: '1.9.15', patterns_min: '1.9.10', left_out: [] }));
  assert.ok(settings().requested);
  assert.equal(form().length, 1);
  assert.equal(asked, 2);
});

test("root's helper refuses sandbox: false and allow_same_user: true from the dashboard (and a loosening of land_mode or main_watch)", { skip }, () => {
  const loosen = [['sandbox', 'off'], ['allow_same_user', 'on'], ['land_mode', 'direct'], ['main_watch', 'off'], ['auto_merge', 'on'], ['lanes', 'none'], ['network_allow', 'none']];
  for (const [k, v] of loosen) {
    assert.equal(helper.parsePolicySet(['set-policy', k!, v!]), null, `${k} ${v}`);
    assert.equal(checkRootStep('set-policy', [k!, v!]).allowed, false, `${k} ${v}`);
    // The helper itself, as a process: usage, nothing run.
    const r = spawnSync(process.execPath, [helperSrc, 'set-policy', k!, v!], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SUDO_USER: 'wl-loose' } });
    assert.equal(r.status, 2, `${k} ${v}: ${r.stderr}`);
    assert.match(r.stderr, /usage: /);
  }
  assert.ok(helper.parsePolicySet(['set-policy', 'land_mode', 'pr']) && helper.parsePolicySet(['set-policy', 'main_watch', 'auto']), 'tightening is taken');
  const m = machineInstance('helper-loose');
  ownPolicy('helper-loose', m.deps);
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
  runMachineRequests({ log, instance: 'helper-loose', exec: helperStandIn('helper-loose', m.deps, calls) });
  assert.deepEqual(calls, []);
  assert.equal(machineRequests(log.read(0))[0]!.status, 'refused');
  assert.equal(readFileSync(m.file, 'utf8'), text);
});

test("the machine helper's set-policy tables are the engine's (its keys, and the one value of each a coordinator may set); a dashboard value passes as one plain word", () => {
  assert.deepEqual(helper.POLICY_SET_KEYS, POLICY_SET_KEYS);
  assert.deepEqual(helper.POLICY_ONLY, HELPER_ONLY);
  const windows = [{ from: '09:00', to: '17:00' }, { from: '22:00', to: '06:00' }];
  assert.equal(encodePolicyValue('settings.run_windows', windows), '0900-1700+2200-0600');
  assert.deepEqual(decodePolicyValue('settings.run_windows', encodePolicyValue('settings.run_windows', windows)!), windows);
  assert.equal(encodePolicyValue('settings.run_windows', []), 'none');
  assert.equal(encodePolicyValue('auto_merge', 'yes'), null);
  assert.equal(encodePolicyValue('budget.daily_usd', 12.5), '12.5');
  assert.equal(encodePolicyValue('sandbox', false), null);
  for (const [k, v] of [['settings.workers', '3'], ['settings.run_windows', '0900-1700'], ['automations.enabled', 'off'], ['settings.stuck_guard', 'dry-run']]) assert.ok(helper.parsePolicySet(['set-policy', k!, v!]), `${k} ${v}`);
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
  // Root's auto_merge kill switch armed under the old name: the rename's start points the new name at the same id
  // (round 9), so it is the new name's too, and a rename never turns auto_merge back on.
  killAutoMerge('oldname', markers);
  aliasInstance('oldname', 'newname', markers);
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
  onRealMachine(lock); // throws unless it is inside this test's system root: never the machine's own (#815)
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

test("an auto_merge off that lands while an admin's `set on` is in flight wins: ON clears only the kill switch it saw when it started (#726 round 4 adversarial pass)", { skip }, () => {
  for (const before of [false, true]) {
    const name = before ? 'onrace-off' : 'onrace';
    const m = machineInstance(name);
    ownPolicy(name, m.deps);
    if (before) setPolicy(name, 'auto_merge', 'off', null, m.deps); // a switch there already, which ON means to clear
    // The OFF lands as ON renames its new policy.yaml into place: after ON's start, before its clear.
    const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const rename = fs.renameSync;
    let landed = false;
    fs.renameSync = ((a: string, b: string) => {
      const r = rename(a, b);
      if (!landed && b === 'policy.yaml') {
        landed = true;
        setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
      }
      return r;
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      setPolicy(name, 'auto_merge', 'on', null, m.deps);
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
    assert.ok(landed, name);
    assert.equal(autoMergeKilled(name), true, `${name}: the OFF that landed during ON stays`);
    assert.equal(asRoot(() => readPolicy(m.file)).policy?.auto_merge, false, `${name}: the engine reads off`);
    // An ON with no OFF in flight clears the switch it saw.
    setPolicy(name, 'auto_merge', 'on', null, m.deps);
    assert.equal(autoMergeKilled(name), false, name);
  }
});

test("a lock a writer left empty (killed between creating it and writing its line) is live for a few seconds, then stale; a garbage one is stale; and `own` never clears root's kill switch (#726 round 4 adversarial pass)", { skip }, () => {
  const m = machineInstance('empty');
  ownPolicy('empty', m.deps);
  const lock = join(POLICY_ROOT_DIR, '.empty.lock');
  onRealMachine(lock); // throws unless it is inside this test's system root (#815)
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
  ownPolicy('died', { ...m.deps, lockWaitMs: 100 }, { retake: true, acceptLoose: true });
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
  // The switch: root's (the stand-in), 0644, in root's 0755 directories (the id's, under root's record directory),
  // reached through root's 0644 pointer: the coordinator user can't write any of them.
  const switches = armedSwitches('kill');
  assert.equal(switches.length, 1, 'one switch, of its own');
  const flag = switches[0]!;
  const id = instanceId('kill');
  assert.ok(id && 'id' in id);
  const d = idDir(id.id);
  onRealMachine(d); // throws unless it is inside this test's system root (#815)
  assert.ok(flag.startsWith(join(d, 'auto-merge-off.')));
  assert.equal(statSync(flag).mode & 0o777, 0o644);
  assert.equal(statSync(flag).uid, me);
  assert.equal(statSync(POLICY_ROOT_DIR).mode & 0o777, 0o755);
  assert.equal(statSync(d).mode & 0o777, 0o755);
  assert.equal(statSync(join(POLICY_ROOT_DIR, 'by_id')).mode & 0o777, 0o755);
  assert.equal(statSync(join(POLICY_ROOT_DIR, 'kill.id')).mode & 0o777, 0o644);
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
  assert.equal(existsSync(join(POLICY_ROOT_DIR, '..', 'kill.id')), false);
  assert.throws(() => killAutoMerge('../kill'), /not an instance name/);
  // Anything at an armed name counts as off (fail closed): a link, a directory, a name that says "disarmed". Only the
  // spare's own name is never counted, and a spare beside a switch hides nothing.
  assert.equal(existsSync(join(d, 'auto-merge-spare')), true, 'a disarmed spare is there for the next OFF');
  assert.equal(autoMergeKilled('kill'), false);
  symlinkSync('/nonexistent', flag);
  assert.equal(autoMergeKilled('kill'), true);
  renameSync(flag, join(m.T, 'gone-link'));
  mkdirSync(flag);
  assert.equal(autoMergeKilled('kill'), true);
  renameSync(flag, join(m.T, 'gone-dir'));
  writeFileSync(join(d, 'auto-merge-off.disarmed'), '');
  assert.equal(autoMergeKilled('kill'), true, 'an armed name, whatever follows');
});

// Every loosening key the coordinator's route takes, with root's value, one looser and (where there is one) one tighter.
const CEILING_CASES: [key: string, root: string, looser: string[], tighter: string | null][] = [
  ['budget.daily_usd', '10', ['11'], '5'],
  ['agents.max_workers', '1', ['2'], null],
  ['automations.enabled', 'off', ['on'], null],
  ['settings.workers', '1', ['2'], null],
  ['settings.daily_budget_usd', '10', ['11'], '5'],
  ['settings.ci_repair.enabled', 'off', ['on'], null],
  ['settings.ci_repair.max_fixes_per_pr', '2', ['3'], '1'],
  ['settings.run_windows', '0900-1700', ['0800-1700', '0900-1800', 'none', '2200-0600'], '1000-1600'],
  ['settings.research.max_searches_per_day', '5', ['6'], '4'],
  ['settings.research.max_fetches_per_day', '5', ['6'], '4'],
  ['settings.research.max_usd_per_day', '2', ['3'], '1'],
  ['settings.research.repo_access', 'off', ['on'], null],
  ['settings.intake.reports_per_sender_per_day', '5', ['6'], '4'],
  ['settings.intake.drafts_per_day', '5', ['6'], '4'],
  ['settings.intake.max_usd_per_day', '2', ['3'], '1'],
  ['settings.stuck_guard', 'dry-run', ['off'], 'on'],
  ['settings.chat_attachments.max_file_mb', '5', ['6'], '4'],
  ['settings.chat_attachments.max_message_mb', '10', ['11'], '9'],
  ['settings.chat_attachments.retention_days', '7', ['8'], '6'],
];

test("the coordinator's route only tightens, every loosening key, on a root policy: the value in effect is the ceiling; lowering works, raising back doesn't; root's command raises it (#726 rounds 10 and 11, the owner's decision of 2026-10-19)", { skip }, () => {
  const CEILING_KEYS = (gate as Record<string, unknown>).CEILING_KEYS as string[] | undefined;
  assert.ok(CEILING_KEYS, 'the tighten-only keys (src/policy-gate.ts CEILING_KEYS)');
  assert.deepEqual([...CEILING_KEYS].sort(), Object.keys(POLICY_SET_KEYS).filter((k) => !Object.hasOwn(HELPER_ONLY, k)).sort(), 'every key policy set takes but the HELPER_ONLY ones');
  assert.deepEqual(CEILING_CASES.map(([k]) => k).sort(), [...CEILING_KEYS].sort(), 'every key is tested');
  const m = machineInstance('ceil');
  ownPolicy('ceil', m.deps);
  for (const [key, root, looser, tighter] of CEILING_CASES) {
    // An admin, at a root shell: the value in effect.
    setPolicy('ceil', key, root, null, m.deps);
    // The coordinator's route (the helper runs `policy set` with SUDO_USER wl-<instance>): never looser.
    for (const l of looser) assert.throws(() => setPolicy('ceil', key, l, 'wl-ceil', m.deps), /would loosen it .*policy set ceil /, `${key} ${l}`);
    if (tighter) {
      // Tighter: allowed; back up to root's value: now a raise, so refused (round 11; round 10 allowed it).
      assert.equal(setPolicy('ceil', key, tighter, 'wl-ceil', m.deps).key, key, `${key} ${tighter}`);
      assert.throws(() => setPolicy('ceil', key, root, 'wl-ceil', m.deps), /would loosen it/, `${key} back to ${root}`);
    }
    // Root's command raises it; the coordinator's route may then keep it there.
    setPolicy('ceil', key, looser[0]!, null, m.deps);
    assert.equal(setPolicy('ceil', key, looser[0]!, 'wl-ceil', m.deps).key, key, `${key} ${looser[0]} after root raised it`);
  }
});

test("from the default policy.yaml a new instance gets, root's takeover leaves no Settings key loosenable: Settings and the helper's route refuse each raise, naming root's command, and lowering still goes (#726 round 11; the reviewer's measured keys)", { skip }, () => {
  const m = machineInstance('dflt');
  ownPolicy('dflt', m.deps);
  let asked = 0;
  const request = () => String(++asked);
  for (const [key, value, arg] of [['research.repo_access', true, 'on'], ['ci_repair.enabled', true, 'on'], ['stuck_guard', 'off', 'off'], ['chat_attachments.retention_days', 365, '365'], ['chat_attachments.max_message_mb', 250, '250']] as const) {
    assert.throws(() => asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key, value, by: cfg.project.owners.default, owner: true, request })), new RegExp(`settings\\.${key.replace(/\./g, '\\.')} .*(would loosen it|isn't in policy\\.yaml).*policy set dflt settings\\.${key.replace(/\./g, '\\.')} ${arg}`), `Settings ${key}`);
    assert.throws(() => setPolicy('dflt', `settings.${key}`, arg, 'wl-dflt', m.deps), /would loosen it|isn't in policy\.yaml/, `helper ${key}`);
  }
  assert.equal(asked, 0, 'nothing asked');
  // Lowering, and turning a switch off: queued for the helper, which runs it.
  assert.ok(asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key: 'chat_attachments.retention_days', value: 7, by: cfg.project.owners.default, owner: true, request })).requested);
  assert.equal(setPolicy('dflt', 'settings.chat_attachments.retention_days', '7', 'wl-dflt', m.deps).key, 'settings.chat_attachments.retention_days');
  assert.equal(setPolicy('dflt', 'settings.ci_repair.enabled', 'off', 'wl-dflt', m.deps).key, 'settings.ci_repair.enabled');
});

test("on a root policy, Settings queues only a tightening root's `policy set` can prove: one it can't (ci_repair's cap, run windows, while the repo's config decides them) is refused up front, naming root's command, and nothing is asked; once policy.yaml holds the value, the same tightening is queued and the helper runs it (#726 round 12)", { skip }, () => {
  // Through 72ead9a5 Settings queued both, and root's helper always refused them ("the value in effect isn't in policy.yaml").
  const m = machineInstance('prov');
  ownPolicy('prov', m.deps);
  const asked: string[][] = [];
  const request = (args: string[]) => (asked.push(args), String(asked.length));
  const settings = (key: string, value: unknown) => asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key, value, by: cfg.project.owners.default, owner: true, request }));
  const narrow = [{ from: '09:00', to: '17:00' }];
  assert.throws(() => settings('ci_repair.max_fixes_per_pr', 1), new RegExp(`settings\\.ci_repair\\.max_fixes_per_pr 1: .*policy set prov settings\\.ci_repair\\.max_fixes_per_pr 1`));
  assert.throws(() => settings('run_windows', narrow), new RegExp(`settings\\.run_windows .*policy set prov settings\\.run_windows 0900-1700`));
  assert.equal(asked.length, 0, 'nothing asked');
  // Turning ci_repair off is provable from the file alone: queued, and the helper runs it.
  assert.ok(settings('ci_repair.enabled', false).requested);
  assert.equal(setPolicy('prov', 'settings.ci_repair.enabled', 'off', 'wl-prov', m.deps).to, false);
  // An admin puts the values in policy.yaml; from then on the dashboard's tightening is provable, queued and run.
  setPolicy('prov', 'settings.ci_repair.max_fixes_per_pr', '2', null, m.deps);
  setPolicy('prov', 'settings.run_windows', '0800-1800', null, m.deps);
  assert.ok(settings('ci_repair.max_fixes_per_pr', 1).requested);
  assert.ok(settings('run_windows', narrow).requested);
  assert.deepEqual(asked.slice(1), [['set-policy', 'settings.ci_repair.max_fixes_per_pr', '1'], ['set-policy', 'settings.run_windows', '0900-1700']]);
  for (const [, key, arg] of asked.slice(1)) assert.equal(setPolicy('prov', key!, arg!, 'wl-prov', m.deps).key, key);
});

test("root's `policy set` on the coordinator's route compares an intake cap with the one the engine applies (intake.yaml's beside policy.yaml), and Settings on a root policy refuses that raise up front; an intake.yaml root can't read refuses all but a value policy.yaml sets (#726 round 12)", { skip }, () => {
  // Through 72ead9a5 root compared with the engine's defaults (10/20/2), so with intake.yaml at 5/3/1 it took 20.
  const m = machineInstance('pint');
  ownPolicy('pint', m.deps);
  writeFileSync(join(m.dir, 'intake.yaml'), 'version: 1\ncaps: { drafts_per_day: 5, reports_per_sender_per_day: 3, max_usd_per_day: 1 }\n', { mode: 0o600 });
  const asked: string[][] = [];
  const request = (args: string[]) => (asked.push(args), String(asked.length));
  assert.throws(() => setPolicy('pint', 'settings.intake.drafts_per_day', '20', 'wl-pint', m.deps), /intake\.drafts_per_day 20 would loosen it \(now 5\)/);
  assert.throws(() => setPolicy('pint', 'settings.intake.max_usd_per_day', '2', 'wl-pint', m.deps), /max_usd_per_day 2 would loosen it \(now 1\)/);
  assert.throws(() => asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key: 'intake.drafts_per_day', value: 20, by: cfg.project.owners.default, owner: true, request })), /would loosen it \(now 5\)/);
  assert.equal(asked.length, 0, 'nothing asked');
  assert.equal(setPolicy('pint', 'settings.intake.drafts_per_day', '4', 'wl-pint', m.deps).to, 4);
  // A link in its place: root never follows it, so it can't tell what applies, and refuses (fail closed).
  renameSync(join(m.dir, 'intake.yaml'), join(m.T, 'intake.yaml'));
  symlinkSync(join(m.T, 'intake.yaml'), join(m.dir, 'intake.yaml'));
  assert.throws(() => setPolicy('pint', 'settings.intake.reports_per_sender_per_day', '2', 'wl-pint', m.deps), /reports_per_sender_per_day 2: .*intake\.yaml/);
  assert.equal(setPolicy('pint', 'settings.intake.drafts_per_day', '3', 'wl-pint', m.deps).to, 3, "policy.yaml's own value: still provable");
});

// Through e386a668 Settings read intake.yaml with the engine's loader (links followed, no size cap) and queued a
// lowering root's helper then refused ("intake.yaml beside it doesn't load"), for each of these shapes.
const INTAKE_CAPS = 'version: 1\ncaps: { drafts_per_day: 5, reports_per_sender_per_day: 3, max_usd_per_day: 1 }\n';
const INTAKE_SHAPES: [string, (dir: string, T: string) => void][] = [
  ['a symlink', (dir, T) => (writeFileSync(join(T, 'real-intake.yaml'), INTAKE_CAPS, { mode: 0o600 }), symlinkSync(join(T, 'real-intake.yaml'), join(dir, 'intake.yaml')))],
  ['a dangling symlink', (dir, T) => symlinkSync(join(T, 'no-such-intake.yaml'), join(dir, 'intake.yaml'))],
  ['a hard link', (dir, T) => (writeFileSync(join(dir, 'intake.yaml'), INTAKE_CAPS, { mode: 0o600 }), linkSync(join(dir, 'intake.yaml'), join(T, 'second-name.yaml')))],
  ["a file over root's size cap", (dir) => writeFileSync(join(dir, 'intake.yaml'), `${INTAKE_CAPS}${'# padding\n'.repeat(210_000)}`, { mode: 0o600 })],
];
for (const [i, [what, make]] of INTAKE_SHAPES.entries()) {
  test(`on a root policy, Settings reads intake.yaml as root's helper will (no link, one name, root's size cap) before it asks: ${what} is refused up front, naming root's command, and nothing is queued (#726 round 13)`, { skip }, () => {
    const name = `ish${i}`;
    const m = machineInstance(name);
    ownPolicy(name, m.deps);
    make(m.dir, m.T);
    const asked: string[][] = [];
    const request = (args: string[]) => (asked.push(args), String(asked.length));
    assert.throws(() => asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key: 'intake.drafts_per_day', value: 4, by: cfg.project.owners.default, owner: true, request })), new RegExp(`intake\\.drafts_per_day 4: .*intake\\.yaml.*policy set ${name} settings\\.intake\\.drafts_per_day 4`), what);
    assert.equal(asked.length, 0, `${what}: nothing asked`);
    // Root's helper route agrees: it would refuse the same change.
    assert.throws(() => setPolicy(name, 'settings.intake.drafts_per_day', '4', `wl-${name}`, m.deps), /intake\.yaml/, `${what}: root`);
  });
}

test("an install root never took over (a laptop, cloud or VM; a machine not taken over yet) also only tightens from the dashboard: each loosening key's raise is refused, naming that install's route; lowering is written (#726 round 11, the owner's decision of 2026-10-19)", { skip }, () => {
  for (const machine of [false, true]) {
    const u = machineInstance(`unr${machine ? 'm' : 'l'}`);
    const events = join(u.T, 'e.db');
    const route = machine ? new RegExp(`policy own unr${machine ? 'm' : 'l'}, then .*policy set`) : /edit .*policy\.yaml \(.*\), or its Helm value/;
    for (const values of [{ 'budget.daily_usd': 90 }, { 'agents.max_workers': 5 }, { 'automations.enabled': true }] as Record<string, unknown>[]) {
      assert.throws(() => applyPolicy({ path: u.file, cfg, values, eventsDb: events, by: 'olive', machine }), (e: Error) => /would loosen it/.test(e.message) && route.test(e.message), JSON.stringify(values));
    }
    for (const [key, value] of [['research.repo_access', true], ['ci_repair.enabled', true], ['stuck_guard', 'off'], ['chat_attachments.retention_days', 365], ['workers', 3], ['daily_budget_usd', 45]] as const) {
      assert.throws(() => changeSetting({ policyPath: u.file, cfg, eventsDb: events, key, value, by: cfg.project.owners.default, owner: true, machine }), (e: Error) => /would loosen it/.test(e.message) && route.test(e.message), `${key} ${String(value)}`);
    }
    // Lowering is written, as on main.
    assert.deepEqual(applyPolicy({ path: u.file, cfg, values: { 'budget.daily_usd': 45 }, eventsDb: events, by: 'olive', machine }), [{ key: 'budget.daily_usd', from: 50, to: 45 }]);
    assert.match(readFileSync(u.file, 'utf8'), /daily_usd: 45/);
  }
});

test("the reviewer's case: an admin's budget, workers, automations off and ci_repair off at a root shell stay so; the helper's route, the Policy form and Settings can't set any of them back (#726 round 10)", { skip }, () => {
  // (The reviewer's admin set budget 10 and workers 1; here 45 and 4, so this example repo's own config, which asks
  // for at least 40 and 4, still loads.)
  const m = machineInstance('reopen');
  ownPolicy('reopen', m.deps);
  for (const [k, v] of [['budget.daily_usd', '45'], ['agents.max_workers', '4'], ['automations.enabled', 'off'], ['settings.ci_repair.enabled', 'off']] as const) setPolicy('reopen', k, v, null, m.deps);
  const text = readFileSync(m.file, 'utf8');
  for (const [k, v] of [['budget.daily_usd', '50'], ['agents.max_workers', '5'], ['automations.enabled', 'on'], ['settings.ci_repair.enabled', 'on']] as const) assert.throws(() => setPolicy('reopen', k, v, 'wl-reopen', m.deps), /would loosen it/, `${k} ${v}`);
  assert.equal(readFileSync(m.file, 'utf8'), text, 'nothing written');
  // Up front, nothing asked: the Policy form and Settings.
  let asked = 0;
  const request = () => String(++asked);
  assert.throws(() => asRoot(() => applyPolicy({ path: m.file, cfg, values: { 'budget.daily_usd': 50 }, eventsDb: join(m.T, 'e.db'), by: 'olive', request })), /budget\.daily_usd 50 would loosen it \(now 45\)/);
  assert.throws(() => asRoot(() => applyPolicy({ path: m.file, cfg, values: { 'automations.enabled': true }, eventsDb: join(m.T, 'e.db'), by: 'olive', request })), /automations\.enabled true would loosen it \(now false\)/);
  assert.throws(() => asRoot(() => changeSetting({ policyPath: m.file, cfg, eventsDb: join(m.T, 'e.db'), key: 'ci_repair.enabled', value: true, by: cfg.project.owners.default, owner: true, request })), /settings\.ci_repair\.enabled true would loosen it \(now false\)/);
  assert.equal(asked, 0, 'nothing asked');
  // Lowering still goes: queued for the helper.
  asRoot(() => applyPolicy({ path: m.file, cfg, values: { 'budget.daily_usd': 42 }, eventsDb: join(m.T, 'e.db'), by: 'olive', request }));
  assert.equal(asked, 1);
});

test("#882: an unreadable limits file: root's `policy set` prints its path and the parser's text, and the coordinator's settings reader says them", { skip }, () => {
  const m = machineInstance('limits-cause');
  ownPolicy('limits-cause', m.deps);
  writeFileSync(m.deps.limitsPath!, '{not json');
  const lines: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  let code: number;
  try {
    code = asRoot(() => policyCommand('set', ['limits-cause', 'budget.daily_usd', '40'], m.deps, true));
  } finally {
    console.error = was;
  }
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.startsWith("the machine's limits file is unreadable: limits file ") && l.includes(m.deps.limitsPath!) && l.includes('JSON')), JSON.stringify(lines));
  const plain = machineInstance('limits-cause-reader');
  writeFileSync(plain.deps.limitsPath!, '{not json');
  const r = settingsReader(plain.file, plain.deps.limitsPath!)();
  assert.match(r.error ?? '', new RegExp(`^policy settings unusable: the machine's limits file is unreadable: limits file ${plain.deps.limitsPath!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*JSON`));
});

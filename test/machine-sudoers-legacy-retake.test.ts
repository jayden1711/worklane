// Issue #902 round 13: for an instance named machine or console (reserved after it was made), `policy own <n> --retake`
// is refused, so no message may tell an admin to run it. Every message that would name `--retake` names the instance's
// removal instead, through one builder (src/policy-kill.ts retakeWayOut; src/policy-gate.ts retakeClause uses it): the
// kill switch's and the id's errors, root's `policy set` refusals, doctor's checks and `policy own`'s CHECK line. The
// builder returns the whole clause, so the words around the removal describe a removal, not a retake (#985).
// Behaviour first (each error provoked in a temp marker dir), then a scan of the message builders as a backstop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { policyRootChecks } from '../src/doctor-policy-root.js';
import { instanceNameProblem, LATER_RESERVED } from '../src/instance-name.js';
import { asRoot } from '../src/os/system-paths.js';
import { readPolicyChecked, retakeClause, setPolicyRootUid } from '../src/policy-gate.js';
import * as kill from '../src/policy-kill.js';
import { ownPolicy, policyCommand, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { repoRoot } from './helpers.js';

const linux = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';
const ID = 'a'.repeat(32);

/** The message each of policy-kill's id errors gives for <name>, provoked in a fresh marker dir. */
function killMessages(name: string): Record<string, string> {
  const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'retake-')));
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return '(no error)';
  };
  const bad = fresh();
  writeFileSync(join(bad, `${name}.id`), 'not an id\n');
  const lost = fresh();
  const gone = fresh();
  writeFileSync(join(gone, `${name}.id`), `${ID}\n`);
  const rec = fresh();
  writeFileSync(join(rec, name), '{}');
  return {
    'ensureId, a pointer that cannot be used': msg(() => kill.ensureId(name, bad)),
    'ensureId, no pointer for a taken-over instance': msg(() => kill.ensureId(name, lost, false)),
    'ensureSpare, its id directory gone': msg(() => kill.ensureSpare(name, gone)),
    'aliasInstance, taken over with no pointer': msg(() => kill.aliasInstance(name, 'beta', rec)),
    'killAutoMerge, a pointer that cannot be used': msg(() => kill.killAutoMerge(name, bad)),
  };
}

test('#902 round 13: no id or kill-switch error tells an admin to retake a reserved name; each names its removal', () => {
  // policy-kill.ts imports only node's modules and system-paths (test/policy-edit.test.ts), so it holds its own copy of
  // the reserved names: the same as the engine's.
  assert.deepEqual([...((kill as { RESERVED_SINCE?: readonly string[] }).RESERVED_SINCE ?? [])].sort(), [...LATER_RESERVED].sort());
  for (const n of LATER_RESERVED) {
    for (const [what, m] of Object.entries(killMessages(n))) {
      assert.doesNotMatch(m, /--retake/, `${n}: ${what}: ${m}`);
      assert.match(m, new RegExp(`instance-remove\\.sh ${n} \\(`), `${n}: ${what}: ${m}`);
    }
    assert.doesNotMatch(retakeClause(n, (c) => c), /--retake/);
  }
  // Any other name keeps root's --retake.
  for (const [what, m] of Object.entries(killMessages('alpha'))) assert.match(m, /policy own alpha --retake/, `${what}: ${m}`);
});

/** Valid names that only start or end like a reserved one: each keeps the retake. */
const NEAR_MISSES = ['machines', 'console2', 'xmachine', 'my-console'];

/** The words after "an admin" in each way-out message for a reserved name: the removal, worded as one (#985). */
const removal = (n: string) => `removes the instance with sudo bash ${asRoot.opt('current/scripts/setup/instance-remove.sh')} ${n} (${n} was made before that name was reserved, so root never takes its policy over again), then adds it again under another name`;

/**
 * Each way-out message for `n`, provoked, with its whole expected text: `before` the way out, then the removal for a
 * reserved name, else `retake(n)`, the retake clause as it reads for any other name.
 */
function wayOuts(n: string): [what: string, got: string, before: string, retake: (n: string) => string][] {
  const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'way-out-')));
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return '(no error)';
  };
  const bad = fresh();
  writeFileSync(join(bad, `${n}.id`), 'not an id\n');
  const lost = fresh();
  const gone = fresh();
  writeFileSync(join(gone, `${n}.id`), `${ID}\n`);
  const rec = fresh();
  writeFileSync(join(rec, n), '{}');
  const doctor = (markers: string, check: string) => {
    const inst = fresh();
    mkdirSync(join(inst, n));
    writeFileSync(join(inst, n, 'instance.yaml'), `version: 1\nname: ${n}\n`);
    return { inst, detail: policyRootChecks(inst, { machine: false, markers }).find((c) => c.name === `${check} ${n}`)?.detail ?? '(no check)' };
  };
  const noId = `can't be used (it holds no id ("not an id"))`;
  const runs = (n: string) => `runs \`policy own ${n} --retake\``;
  const sudoRuns = (n: string) => `runs sudo ${BRAND.cli} policy own ${n} --retake`;
  const owner = doctor(rec, 'policy owner');
  return [
    ['ensureId, a pointer that cannot be used', msg(() => kill.ensureId(n, bad)), `root's ${bad}/${n}.id ${noId}: auto_merge reads off until an admin `, runs],
    ['ensureId, no pointer', msg(() => kill.ensureId(n, lost, false)), `no ${lost}/${n}.id for an instance root took over: auto_merge reads off until an admin `, runs],
    ['ensureSpare, its id directory gone', msg(() => kill.ensureSpare(n, gone)), `root's ${gone}/by_id/${ID} is gone, so auto_merge reads off: an admin `, (n) => `${runs(n)} (it keeps auto_merge off)`],
    ['aliasInstance, no pointer', msg(() => kill.aliasInstance(n, 'beta', rec)), `${n} was taken over (root's record is there) but has no ${rec}/${n}.id, so auto_merge reads off; a new id would read on. An admin `, (n) => `${runs(n)} first (it keeps auto_merge off)`],
    ['killAutoMerge, a pointer that cannot be used', msg(() => kill.killAutoMerge(n, bad)), `root's ${bad}/${n}.id ${noId}, so ${n}'s auto_merge reads off already; no switch could be armed for it. An admin `, (n) => `${runs(n)}, which keeps it off`],
    ['doctor, a pointer that cannot be used', doctor(bad, 'auto_merge id').detail, `root's ${bad}/${n}.id ${noId}: auto_merge reads off until an admin `, (n) => `${sudoRuns(n)} (a new id, auto_merge kept off)`],
    ['doctor, no pointer', doctor(rec, 'auto_merge id').detail, `no ${rec}/${n}.id for a policy root took over: auto_merge reads off until an admin `, sudoRuns],
    ['doctor, its id directory gone', doctor(gone, 'auto_merge id').detail, `root's ${gone}/by_id/${ID} is gone: auto_merge reads off, and root's writers but OFF refuse, until an admin `, (n) => `${sudoRuns(n)} (it puts it back with auto_merge kept off)`],
    // The gate's refusal, as doctor's policy owner check shows it; its last words come after the way out.
    ['doctor, the gate refusing a record it cannot read', owner.detail.replace(/\. Until then the coordinator won't start\.$/, ''), `refused: on this machine ${owner.inst}/${n}/policy.yaml is root's and only root changes it, but root's record of it (${rec}/${n}) isn't one this engine reads, so the coordinator user (or something running as it) may have changed it. An admin checks it, then `, (n) => `makes it root's again: sudo ${BRAND.cli} policy own ${n} --retake`],
  ];
}

/**
 * policy own's and policy set's way outs, and the gate's, for `n` once root's file is swapped for a looser one, then
 * once root's record of it can't be read; and `retakeLoose`, what `policy own <n> --retake` says of the swapped `file`.
 */
function swappedWayOuts(n: string): { wayOuts: [what: string, got: string, before: string, retake: (n: string) => string][]; retakeLoose: string; file: string } {
  const me = process.getuid!();
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'way-out-swap-')));
  const dir = join(T, 'home', `wl-${n}`, '.local', 'state', BRAND.cli, 'instances', n);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'policy.yaml');
  writeFileSync(file, 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n', { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === `wl-${n}` ? join(T, 'home', `wl-${n}`) : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json'), markerDir: join(T, 'markers') };
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return '(no error)';
  };
  setPolicyRootUid(me);
  try {
    ownPolicy(n, deps);
    writeFileSync(join(dir, '.x'), 'version: 1\nbudget: { daily_usd: 80 }\nagents: { max_workers: 4 }\nland_mode: direct\nauto_merge: true\n', { mode: 0o600 });
    renameSync(join(dir, '.x'), file);
    const gate = readPolicyChecked(file, join(T, 'markers'), n, me);
    const ownChanged = msg(() => ownPolicy(n, deps));
    const setChanged = msg(() => setPolicy(n, 'budget.daily_usd', '10', null, deps));
    const retakeLoose = msg(() => ownPolicy(n, deps, { retake: true }));
    const record = join(T, 'markers', n);
    writeFileSync(record, 'not a record\n');
    const setUnread = msg(() => setPolicy(n, 'budget.daily_usd', '10', null, deps));
    const own = (n: string) => `sudo ${BRAND.cli} policy own ${n} --retake`;
    const wayOuts: [string, string, string, (n: string) => string][] = [
      ['policy own, a recorded file that changed', ownChanged, `${file} isn't what root last wrote there (its content changed since), so it is left as it is: a process running as its coordinator user may have put it there. An admin checks it at a root shell, then `, (n) => `takes it over as it is with ${own(n)}`],
      ['policy set, a recorded file that changed', setChanged, `${file} isn't what root last wrote there (an earlier or other file put back in its place), so nothing is changed: an admin checks it, then `, own],
      ['the gate, a recorded file that changed', gate && 'refused' in gate ? gate.refused : '(not refused)', `refused: on this machine ${file} is root's and only root changes it, but its content isn't what root last wrote there (an earlier or other file put back in its place), so the coordinator user (or something running as it) may have changed it. An admin checks it, then `, (n) => `makes it root's again: ${own(n)}`],
      ['policy set, a record it cannot read', setUnread, `${file}: root's record of it (${record}) isn't one this engine reads, so nothing is changed: an admin checks it, then `, own],
    ];
    return { wayOuts, retakeLoose, file };
  } finally {
    setPolicyRootUid(0);
  }
}

test('#985: for a reserved name each way-out message, in full, names the removal as a removal; any other name\'s is its retake', () => {
  for (const n of [...LATER_RESERVED, ...NEAR_MISSES, 'alpha']) {
    for (const [what, got, before, retake] of wayOuts(n)) assert.equal(got, `${before}${LATER_RESERVED.includes(n) ? removal(n) : retake(n)}`, `${n}: ${what}`);
  }
});

test('#985: policy own\'s, policy set\'s and the gate\'s way outs for a reserved name, in full, name the removal as a removal', { skip: linux }, () => {
  for (const n of [...LATER_RESERVED, ...NEAR_MISSES, 'alpha']) {
    const { wayOuts, retakeLoose, file } = swappedWayOuts(n);
    for (const [what, got, before, retake] of wayOuts) assert.equal(got, `${before}${LATER_RESERVED.includes(n) ? removal(n) : retake(n)}`, `${n}: ${what}`);
    // policy own --retake of a looser file: refused by name for a reserved one, else its way out keeps the retake.
    assert.equal(retakeLoose, LATER_RESERVED.includes(n) ? `${n} is a name the instance-name rules refuse now (${instanceNameProblem(n)}): its policy is never taken over with --retake, which could loosen what root wrote; it only tightens (policy set)` : `${file} is looser than its coordinator could make it (land_mode: direct; auto_merge: true), so it is left as it is, not root's: a process running as its coordinator user may have written that. An admin checks it at a root shell, then changes it, or takes it over as it is with sudo ${BRAND.cli} policy own ${n} --retake --accept-loose`, `${n}: policy own --retake, a looser file`);
  }
});

/** policy own's CHECK line for `n`'s first takeover of a loose file with --accept-loose. */
function checkLine(n: string): string {
  const me = process.getuid!();
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'retake-check-')));
  const dir = join(T, 'home', `wl-${n}`, '.local', 'state', BRAND.cli, 'instances', n);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 80 }\nagents: { max_workers: 4 }\nland_mode: direct\nauto_merge: true\n', { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === `wl-${n}` ? join(T, 'home', `wl-${n}`) : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json'), markerDir: join(T, 'markers') };
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void out.push(a.join(' '));
  setPolicyRootUid(me);
  let code: number;
  try {
    code = policyCommand('own', [n, '--accept-loose'], deps, true);
  } finally {
    setPolicyRootUid(0);
    console.log = log;
    console.error = err;
  }
  assert.equal(code, 0, out.join('\n'));
  const check = out.find((l) => l.startsWith('CHECK: '));
  assert.ok(check, out.join('\n'));
  return check;
}

test('#902 round 13, #985: policy own\'s CHECK line, in full: policy set only for a reserved name, else also the retake', { skip: linux }, () => {
  for (const n of [...LATER_RESERVED, ...NEAR_MISSES, 'alpha']) {
    const tail = LATER_RESERVED.includes(n) ? ` (it only tightens: ${n} was made before that name was reserved, so a file edited by hand is never taken over again)` : `, or edit the file as root and then run sudo ${BRAND.cli} policy own ${n} --retake --accept-loose`;
    assert.equal(checkLine(n), `CHECK: land_mode: direct; auto_merge: true: looser than its coordinator could make it. If you didn't set it, change it with sudo ${BRAND.cli} policy set ${n} <key> <value>${tail}.`, n);
  }
});

test('#902 round 13: backstop: the message builders name `policy own … --retake` only through the one builder', () => {
  const src = (f: string) => readFileSync(join(repoRoot, 'src', f), 'utf8');
  for (const f of ['policy-kill.ts', 'policy-root.ts', 'policy-gate.ts', 'doctor-policy-root.ts']) {
    const text = src(f);
    // A literal "policy own <instance> --retake" in a message, outside the builder itself.
    const literal = [...text.matchAll(/policy own \$\{[^}]+\} --retake/g)].map((m) => m[0]);
    assert.deepEqual(literal, f === 'policy-kill.ts' ? ['policy own ${instance} --retake'] : [], `${f}: ${literal.join(', ')}`);
    // Nor any other placeholder followed by --retake, such as `${ownCommand(instance)} --retake` (#985).
    const appended = [...text.matchAll(/\}\s*--retake/g)].length;
    assert.equal(appended, f === 'policy-kill.ts' ? 1 : 0, `${f}: --retake after a placeholder`);
  }
});

// The root side of a single machine's root-owned policy.yaml (issue #726; the rules in src/policy-gate.ts):
//   <cli> policy own <instance> [--retake] [--accept-loose]
//                                               root: make the instance's policy.yaml root's (0644), its content kept,
//                                               and record it; prints the isolation and merge keys (setup's policy step)
//   <cli> policy set <instance> <key> <value>   root: one change, checked
//   <cli> policy check <instance>               read-only: 0 only when the engine's gate would read it (setup's
//                                               policy step is done only then)
// own and set hold root's lock on the instance (withPolicyLock) from their read to their record write.
// The instance is the coordinator user wl-<instance>'s; its home comes from the user database, never an argument.
// Asked through sudo by a coordinator user (SUDO_USER wl-...), a loosening of land_mode or main_watch is refused.
//
// THREAT: a coordinator user reaches `policy own <its instance>` as root through the machine helper (add-project's
// rerun), with no flag. So without a flag `own` never makes root's anything the coordinator couldn't have reached by
// `policy set` itself: a policy looser than that (sandbox off, allow_same_user, land_mode direct, main_watch off,
// lanes, allowlists, any key `policy set` doesn't take, a value over the machine's limits) is refused, and so is a
// recorded policy that changed since root last wrote it (P5: an earlier root file put back). Those take an admin, at a
// root shell, with --accept-loose or --retake. setup-scripts never pass either (test/policy-edit.test.ts holds that).
import { chmodSync, closeSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import { PolicyFile } from './instance.js';
import { instanceNameOk } from './instance-name.js';
import { isRoot, processIdentity, UNKNOWN_IDENTITY, userHomeDir, userUid } from './os/index.js';
import { readInOwnedDir, replaceInOwnedDir } from './os/root-file.js';
import { armedSwitches, clearKillSwitches, ensureSpare, killAutoMerge, recordDir } from './policy-kill.js';
import { decodePolicyValue, HELPER_ONLY, ownCommand, POLICY_ROOT_DIR, POLICY_SET_KEYS, policyRecord, type PolicyRecord, readPolicyChecked, recordText, sha256 } from './policy-gate.js';
import { type Limits, LIMITS_PATH, loadLimits, settingsProblems } from './settings.js';

const FILE = 'policy.yaml';
const LOCK_WAIT_MS = 10_000;
const EMPTY_LOCK_MS = 5_000;
/** The keys an admin should see whenever root takes a policy over: what isolates the agents, and what merges. */
const WATCHED = ['sandbox', 'allow_same_user', 'land_mode', 'main_watch', 'auto_merge'] as const;

/** Where the work happens, and as whom; tests stand in for the user database and root. */
export interface PolicyRootDeps {
  home?: (user: string) => string | null;
  uid?: (user: string) => number | null;
  rootUid?: number;
  rootGid?: number;
  markerDir?: string;
  limitsPath?: string;
  /** How long a root writer waits for another's lock on the same instance (withPolicyLock); default 10 s. */
  lockWaitMs?: number;
}

/** An instance's policy.yaml on this machine: its coordinator's instance home (real path), and that user's uid. */
export function instancePolicy(instance: string, d: PolicyRootDeps = {}): { dir: string; file: string; coordUid: number } {
  if (!instanceNameOk(instance)) throw new Error(`${instance}: not an instance name`);
  const user = `wl-${instance}`;
  const home = (d.home ?? userHomeDir)(user);
  const coordUid = (d.uid ?? userUid)(user);
  if (!home || coordUid === null) throw new Error(`no user ${user} on this machine`);
  const dir = join(realpathSync(home), '.local', 'state', BRAND.cli, 'instances', instance);
  return { dir, file: join(dir, FILE), coordUid };
}

function parsePolicy(text: string, file: string): PolicyFile {
  const r = PolicyFile.safeParse(parseDocument(text).toJS());
  if (!r.success) throw new Error(`${file} is invalid, so it is left as it is: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** Where a key sits in the file: `settings.workers` is settings: { workers }, `budget.daily_usd` budget: { daily_usd }. */
const pathOf = (key: string) => key.split('.');
const getIn = (o: unknown, path: string[]): unknown => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function setIn(o: Record<string, unknown>, path: string[], v: unknown): void {
  let at = o;
  for (const k of path.slice(0, -1)) {
    if (!isPlain(at[k])) at[k] = {};
    at = at[k] as Record<string, unknown>;
  }
  at[path[path.length - 1]!] = v;
}
const shown = (v: unknown) => (v === undefined ? '(none)' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
/** Every place `b` differs from `a`, as `path: b's value`. */
function differences(a: unknown, b: unknown, path: string[] = []): string[] {
  if (isPlain(a) && isPlain(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differences(a[k], b[k], [...path, k]));
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${path.join('.')}: ${shown(b)}`];
}

/** A policy's values over the machine's limits (what `policy set` refuses). */
function limitProblems(p: PolicyFile, limits: Limits): string[] {
  const problems = settingsProblems(p.settings, limits, p);
  if (p.budget.daily_usd > limits.daily_budget_usd.max) problems.push(`budget.daily_usd ${p.budget.daily_usd} is over ${limits.daily_budget_usd.max} (machine limits)`);
  if (p.agents.max_workers > limits.workers.max) problems.push(`agents.max_workers ${p.agents.max_workers} is over ${limits.workers.max} (machine limits)`);
  return problems;
}

/**
 * Where `p` is looser than its coordinator could make it through `policy set` (from the default policy: each key of
 * POLICY_SET_KEYS as it is in `p`, each HELPER_ONLY key only at its tightening value, within the machine's limits).
 * Empty: nothing here a coordinator couldn't have set itself. Derived from the two tables, so a key moved into
 * HELPER_ONLY is a loosening here too.
 */
export function beyondCoordinator(p: PolicyFile, limits: Limits): string[] {
  const reach = PolicyFile.parse({ version: 1, budget: { daily_usd: p.budget.daily_usd } }) as unknown as Record<string, unknown>;
  for (const key of Object.keys(POLICY_SET_KEYS)) {
    const v = Object.hasOwn(HELPER_ONLY, key) ? decodePolicyValue(key, HELPER_ONLY[key]!) : getIn(p, pathOf(key));
    if (v !== undefined) setIn(reach, pathOf(key), v);
  }
  return [...differences(reach, p), ...limitProblems(p, limits)];
}

/**
 * Root's record of an instance, written whatever root's umask: the directory 0755 (recordDir) and the record 0644, so
 * the coordinator user can always read it (an unreadable one refuses its policy).
 */
function writeRecord(dir: string, instance: string, rec: PolicyRecord): void {
  recordDir(dir);
  const tmp = join(dir, `.${instance}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, recordText(rec), { mode: 0o644, flag: 'wx' });
  chmodSync(tmp, 0o644);
  renameSync(tmp, join(dir, instance));
}

/**
 * Run `fn` holding root's lock on one instance's policy: a file root creates (O_EXCL) in its own record directory,
 * which the coordinator user can't create, remove or write. `own` and `set` hold it from their read of policy.yaml to
 * their record write, so two root writers of one instance never interleave (THREAT: a coordinator's `set-policy`
 * reading before an admin's `policy set` and writing after it would put back what the admin changed, and record it).
 * Another live holder: wait (bounded), then refuse, naming it.
 *
 * A holder that stopped part way (killed, crashed, the machine rebooted) is stale, so it never blocks anyone: the lock
 * names its holder (pid, and processIdentity: this boot and the process's start time, through the OS adapter), and a
 * lock whose holder no longer runs, or whose pid now belongs to another process, is broken. THREAT (#726 round 3): an
 * `own` that died inside the lock left it for good, so no root writer, an admin's included, could change the policy
 * after it. Breaking it renames it aside and checks the renamed file is the stale one, so a fresh lock another writer
 * took meanwhile is put back, not broken; a holder removes the lock only while it is still its own.
 */
function withPolicyLock<T>(dir: string, instance: string, waitMs: number, fn: () => T): T {
  recordDir(dir);
  const lock = join(dir, `.${instance}.lock`);
  const mine = `${process.pid} ${processIdentity(process.pid) ?? ''}\n`;
  const until = Date.now() + waitMs;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readLock(lock);
      if (held !== null && lockStale(held, lock)) {
        breakLock(lock, held);
        continue;
      }
      if (Date.now() >= until) throw new Error(`another root change to ${instance}'s policy is in progress (${lock}, held by ${held?.trim() || 'a writer'}), so nothing is changed: try again once it is done`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      continue;
    }
    try {
      writeSync(fd, mine);
    } finally {
      closeSync(fd);
    }
    break;
  }
  try {
    return fn();
  } finally {
    if (readLock(lock) === mine) unlinkSync(lock);
  }
}

function readLock(lock: string): string | null {
  try {
    return readFileSync(lock, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether a lock's holder (its text: `<pid> <identity>`) no longer runs, or its pid is another process's now. An empty
 * lock is a holder still writing its line, live for EMPTY_LOCK_MS; older, it is one killed between creating and writing
 * it, and stale.
 */
function lockStale(text: string, lock: string): boolean {
  if (!text.trim()) {
    try {
      return Date.now() - statSync(lock).mtimeMs > EMPTY_LOCK_MS;
    } catch {
      return false;
    }
  }
  const sp = text.trim().indexOf(' ');
  const pid = Number(sp < 0 ? text.trim() : text.trim().slice(0, sp));
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const now = processIdentity(pid);
  if (now === null) return true;
  // Fail closed: a holder that answers signal 0 but whose identity can't be read is live (OFF never waits for it).
  if (now === UNKNOWN_IDENTITY) return false;
  const was = sp < 0 ? '' : text.trim().slice(sp + 1);
  return was !== '' && now !== was;
}

/**
 * Break a stale lock. Breakers take turns through a second lock (`<lock>.break`, O_EXCL; one older than EMPTY_LOCK_MS
 * is a breaker that died and goes), and under it the lock is removed only while it is still the stale one. The lock
 * can't change under a breaker: no writer creates it while it is there, and its own holder is gone. So a fresh lock
 * another writer took is never broken, and no third writer slips in between.
 */
function breakLock(lock: string, stale: string): void {
  const brk = `${lock}.break`;
  let fd: number;
  try {
    fd = openSync(brk, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      if (Date.now() - statSync(brk).mtimeMs > EMPTY_LOCK_MS) unlinkSync(brk);
    } catch {
      // another breaker finished first
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    return; // another breaker is at it: wait, and look again
  }
  closeSync(fd);
  try {
    if (readLock(lock) === stale) unlinkSync(lock);
  } finally {
    unlinkSync(brk);
  }
}

/** What an admin passed to `policy own`, having checked the file first (never setup: its own_policy passes neither). */
export interface OwnFlags {
  /** A recorded policy that changed since root last wrote it: take it over as it is now. */
  retake?: boolean;
  /** A policy looser than its coordinator could make it: take it over as it is. */
  acceptLoose?: boolean;
}

/**
 * Make an instance's policy.yaml root's, 0644, with its content as it is (setup's policy step, and an admin after a
 * refusal), and record it (its real path, and the sha256 of what root wrote) in root's directory, so the engine reads
 * it only while it stays exactly that. Returns the keys an admin should check, and which of them are loose.
 * Refused, nothing changed: a recorded policy whose content isn't what root last wrote (unless `retake`), and a
 * policy looser than its coordinator could make it (unless `acceptLoose`). Content root already wrote (its hash is the
 * record's: a rerun, or a rename's carried file) is taken as it is.
 */
export function ownPolicy(instance: string, d: PolicyRootDeps = {}, flags: OwnFlags = {}): { file: string; keys: Record<string, unknown>; loose: string[] } {
  const { dir, file, coordUid } = instancePolicy(instance, d);
  const rootUid = d.rootUid ?? 0;
  const markers = d.markerDir ?? POLICY_ROOT_DIR;
  return withPolicyLock(markers, instance, d.lockWaitMs ?? LOCK_WAIT_MS, () => {
    // Size-capped from fstat (readInOwnedDir), and the record's sha256 checked before a byte is parsed: a changed file
    // the coordinator planted (huge, or built to be slow to parse) is refused without parsing it.
    const text = readInOwnedDir(dir, FILE, coordUid, [coordUid, rootUid]);
    const rec = policyRecord(instance, markers);
    const written = rec !== null && !('problem' in rec) && rec.sha256 === sha256(text);
    if (rec !== null && !written && !flags.retake) throw new Error(`${file} isn't what root last wrote there (${'problem' in rec ? rec.problem : 'its content changed since'}), so it is left as it is: a process running as its coordinator user may have put it there. An admin checks it at a root shell, then takes it over as it is with ${ownCommand(instance, '--retake')}`);
    const policy = parsePolicy(text, file);
    const loose = beyondCoordinator(policy, loadLimits(d.limitsPath ?? LIMITS_PATH));
    if (!written && loose.length && !flags.acceptLoose) throw new Error(`${file} is looser than its coordinator could make it (${loose.join('; ')}), so it is left as it is, not root's: a process running as its coordinator user may have written that. An admin checks it at a root shell, then changes it, or takes it over as it is with ${ownCommand(instance, ...(rec !== null ? (['--retake'] as const) : []), '--accept-loose')}`);
    replaceInOwnedDir({ dir, name: FILE, text, dirOwner: coordUid, uid: rootUid, gid: d.rootGid ?? 0, mode: 0o644 });
    writeRecord(markers, instance, { file, sha256: sha256(text) });
    // A disarmed kill switch, so a later auto_merge off needs no new space (src/policy-kill.ts).
    ensureSpare(instance, markers);
    return { file, keys: Object.fromEntries(WATCHED.map((k) => [k, policy[k]])), loose };
  });
}

/**
 * One change to a root policy.yaml, as root: a key and value in its shape (src/policy-gate.ts), checked
 * against the schema and the machine's limits, then written root's, 0644, and recorded. `by`: who asked (sudo's
 * SUDO_USER); a coordinator user (wl-...) may never loosen land_mode or main_watch, whatever its arguments. Refused,
 * nothing changed, when the file there isn't the one root last wrote (so an earlier root file put back is never
 * changed and recorded as root's).
 */
export function setPolicy(instance: string, key: string, arg: string, by: string | null, d: PolicyRootDeps = {}): { key: string; from: unknown; to: unknown } {
  if (!Object.hasOwn(POLICY_SET_KEYS, key)) throw new Error(`${key} isn't a key that changes this way (${Object.keys(POLICY_SET_KEYS).join(', ')})`);
  const value = decodePolicyValue(key, arg);
  if (value === undefined) throw new Error(`${arg} isn't a value for ${key}`);
  if (by && /^wl-/.test(by) && Object.hasOwn(HELPER_ONLY, key) && HELPER_ONLY[key] !== arg) throw new Error(`${key}: ${arg} loosens the instance, which is an admin's, at a root shell (sudo ${BRAND.cli} policy set ${instance} ${key} ${arg}); a dashboard may only tighten it`);
  const markers = d.markerDir ?? POLICY_ROOT_DIR;
  // auto_merge off: root's kill switch alone (src/policy-kill.ts), before any lock or read of policy.yaml, so nothing
  // (another writer's lock, a stale one, a huge or corrupt policy.yaml) can hold it up. Its `from` is unknown: unread.
  if (key === 'auto_merge' && value === false) {
    if (!instanceNameOk(instance) || (d.uid ?? userUid)(`wl-${instance}`) === null) throw new Error(`no instance ${instance} on this machine`);
    killAutoMerge(instance, markers);
    return { key, from: null, to: false };
  }
  // auto_merge on: the kill switches there now, before anything waits (root's lock included), are the only ones it may
  // clear; an OFF that says done any time after this has a switch of its own, which stays.
  const seen = key === 'auto_merge' && value === true ? armedSwitches(instance, markers) : [];
  const { dir, file, coordUid } = instancePolicy(instance, d);
  if (policyRecord(instance, markers) === null) throw new Error(`${file} isn't root's yet: make it so first (${ownCommand(instance)})`);
  return withPolicyLock(markers, instance, d.lockWaitMs ?? LOCK_WAIT_MS, () => {
    const rec = policyRecord(instance, markers);
    if (rec === null) throw new Error(`${file} isn't root's yet: make it so first (${ownCommand(instance)})`);
    if ('problem' in rec) throw new Error(`${file}: ${rec.problem}, so nothing is changed: an admin checks it, then ${ownCommand(instance, '--retake')}`);
    const rootUid = d.rootUid ?? 0;
    const text = readInOwnedDir(dir, FILE, coordUid, [rootUid]);
    if (rec.file !== file || rec.sha256 !== sha256(text)) throw new Error(`${file} isn't what root last wrote there (an earlier or other file put back in its place), so nothing is changed: an admin checks it, then ${ownCommand(instance, '--retake')}`);
    const doc = parseDocument(text);
    const from = getIn(doc.toJS(), pathOf(key)) ?? null;
    doc.setIn(pathOf(key), value);
    const out = doc.toString();
    const next = parsePolicy(out, file);
    const problems = limitProblems(next, loadLimits(d.limitsPath ?? LIMITS_PATH));
    if (problems.length) throw new Error(`refused: ${problems.join('; ')}`);
    replaceInOwnedDir({ dir, name: FILE, text: out, dirOwner: coordUid, uid: rootUid, gid: d.rootGid ?? 0, mode: 0o644 });
    writeRecord(markers, instance, { file, sha256: sha256(out) });
    // auto_merge on (root's alone; a coordinator's was refused above): the switches it saw go, last, each by its own
    // name, so auto_merge reads off until policy.yaml says on, and any an OFF armed since stays.
    if (key === 'auto_merge' && value === true) clearKillSwitches(instance, seen, markers);
    else ensureSpare(instance, markers);
    return { key, from, to: value };
  });
}

/**
 * `policy check <instance>`, read-only: whether the engine's gate would read the instance's policy.yaml (root's
 * record covers it, and it is exactly what root last wrote there: readPolicyChecked). null when it would; else why
 * not. add-project's policy step is done only when this says so (lib.sh policy_root_ok), so the step and the gate
 * never disagree.
 */
export function checkPolicy(instance: string, d: PolicyRootDeps = {}): string | null {
  const { file } = instancePolicy(instance, d);
  const r = readPolicyChecked(file, d.markerDir ?? POLICY_ROOT_DIR, instance, d.rootUid ?? 0);
  if (r === null) return `${file} isn't root's yet: no record of it (${ownCommand(instance)})`;
  return 'refused' in r ? r.refused : null;
}

/** `<cli> policy own|set|check ...`, as root (check reads only). `deps` and `root`: tests stand in for the machine and for root. */
export function policyCommand(sub: string | undefined, rest: string[], deps: PolicyRootDeps = {}, root = isRoot()): number {
  const usage = `usage: ${BRAND.cli} policy own <instance> [--retake] [--accept-loose] | policy set <instance> <key> <value>   (as root) | policy check <instance>`;
  if (sub === 'check' && rest.length === 1 && !rest[0]!.startsWith('--')) {
    try {
      const why = checkPolicy(rest[0]!, deps);
      if (why) console.error(why);
      else console.log(`${rest[0]}: policy.yaml is root's, and what root last wrote there`);
      return why ? 1 : 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }
  if (!root) {
    console.error(`policy ${sub ?? ''} is root's: run it with sudo\n${usage}`);
    return 2;
  }
  const flags = rest.filter((a) => a.startsWith('--'));
  const args = rest.filter((a) => !a.startsWith('--'));
  try {
    if (sub === 'own' && args.length === 1 && flags.every((f) => f === '--retake' || f === '--accept-loose')) {
      const r = ownPolicy(args[0]!, deps, { retake: flags.includes('--retake'), acceptLoose: flags.includes('--accept-loose') });
      console.log(`${r.file} is root's now (0644), its content as it was:\n${Object.entries(r.keys).map(([k, v]) => `  ${k}: ${String(v)}`).join('\n')}`);
      if (r.loose.length) console.log(`CHECK: ${r.loose.join('; ')}: looser than its coordinator could make it. If you didn't set it, change it with sudo ${BRAND.cli} policy set ${args[0]} <key> <value>, or edit the file as root and then run ${ownCommand(args[0]!, '--retake', '--accept-loose')}.`);
      return 0;
    }
    if (sub === 'set' && rest.length === 3 && !flags.length) {
      console.log(JSON.stringify(setPolicy(rest[0]!, rest[1]!, rest[2]!, process.env.SUDO_USER ?? null, deps)));
      return 0;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.error(usage);
  return 2;
}

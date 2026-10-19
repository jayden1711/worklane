// auto_merge OFF on a single machine (#726; the owner's structural decision of 2026-10-19): root's kill switch for one
// instance, a file of its own in root's record directory (/etc/<cli>/policy-root/<instance>.auto-merge-off).
//
//   - Turning auto_merge off writes it, atomically (a temp file, then a rename), and does nothing else: it never takes
//     root's policy lock and never reads or parses policy.yaml. So no stale lock, no oversized or corrupt policy.yaml,
//     and no other root writer can stop it. Every OFF surface comes here: `<cli> policy set <instance> auto_merge off`
//     (an admin, or the machine helper's literal `set-policy auto_merge off` rule for a dashboard).
//   - The engine checks it BEFORE it reads the policy (autoMergeKilled): while it is there, auto_merge is off,
//     whatever policy.yaml says. Anything at its name, or any error but "no such file", counts as there.
//   - Only root's `policy set <instance> auto_merge on`, through the locked path, removes it.
// The coordinator user can't create, remove or replace it: root's directory, 0755 (recordDir).
//
// INVARIANT: this module imports nothing that reads policy.yaml or takes root's lock (test/policy-edit.test.ts holds
// its imports to node's own modules and the pure ones below).
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { etcPath } from './os/system-paths.js';

/** Root's record of the instances whose policy.yaml is root's (src/policy-gate.ts), and their kill switches. */
export const POLICY_ROOT_DIR = etcPath('policy-root');

/** Where an instance's auto_merge kill switch is. */
export const killSwitchPath = (instance: string, dir = POLICY_ROOT_DIR) => join(dir, `${instance}.auto-merge-off`);

/** A name no file in the record directory can have, so it is never an instance's. */
const fileName = (instance: string) => !!instance && instance !== '.' && instance !== '..' && !/[/\\\0]/.test(instance);

/**
 * Whether root's kill switch turns this instance's auto_merge off: checked before anything reads its policy.yaml.
 * Fail closed toward off: anything at the name (a file, a link, a directory), or an error other than ENOENT, is off.
 */
export function autoMergeKilled(instance: string, dir = POLICY_ROOT_DIR): boolean {
  if (!fileName(instance)) return false;
  try {
    lstatSync(killSwitchPath(instance, dir));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Root's record directory, made whatever root's umask: 0755, and each directory made here too, so the coordinator
 * user can read what is in it and change none of it.
 */
export function recordDir(dir: string): void {
  const made = mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (made) {
    let p = made;
    chmodSync(p, 0o755);
    for (const s of relative(made, dir).split(sep).filter(Boolean)) chmodSync((p = join(p, s)), 0o755);
  }
  chmodSync(dir, 0o755);
}

/**
 * Turn this instance's auto_merge off (as root): write its kill switch, 0644, as a temp file renamed into place. No
 * lock, no policy.yaml: nothing else can hold this up. `at`: when, for whoever looks.
 */
export function killAutoMerge(instance: string, dir = POLICY_ROOT_DIR, at = new Date()): void {
  if (!fileName(instance)) throw new Error(`${instance}: not an instance name`);
  recordDir(dir);
  const tmp = join(dir, `.${instance}.auto-merge-off.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, `auto_merge off since ${at.toISOString()}\n`, { mode: 0o644, flag: 'wx' });
  chmodSync(tmp, 0o644);
  renameSync(tmp, killSwitchPath(instance, dir));
}

/** Which kill switch is there now (its inode), or null: what root's `set on` saw when it started (clearKillSwitch). */
export function killSwitchSeen(instance: string, dir = POLICY_ROOT_DIR): number | null {
  try {
    return lstatSync(killSwitchPath(instance, dir)).ino;
  } catch {
    return null;
  }
}

/**
 * Root's `policy set <instance> auto_merge on` only (src/policy-root.ts, inside its lock), after it wrote policy.yaml:
 * the kill switch it saw when it started (`seen`, killSwitchSeen) goes, and only that one. THREAT: an OFF that lands
 * while ON is in flight writes a new switch (a new inode); removing it would turn auto_merge back on after that OFF
 * said done. So it is moved aside, checked, and put back when it isn't the one ON saw: the later OFF wins.
 */
export function clearKillSwitch(instance: string, seen: number | null, dir = POLICY_ROOT_DIR): void {
  if (seen === null) return; // none when ON started: any switch there now is a later OFF's
  const flag = killSwitchPath(instance, dir);
  const aside = `${flag}.clearing.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(flag, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (lstatSync(aside).ino !== seen) {
    renameSync(aside, flag); // a later OFF's: back it goes (a still later one, if any, is newer still and stays off)
    return;
  }
  unlinkSync(aside);
}

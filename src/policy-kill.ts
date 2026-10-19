// auto_merge OFF on a single machine (#726; the owner's structural decision of 2026-10-19, and principle 2: OFF can
// never be blocked or undone): root's kill switch for one instance, in root's record directory (/etc/<cli>/policy-root).
//
//   - A switch is any file whose name starts with `<instance>.auto-merge-off`: each OFF arms one of its own,
//     `<instance>.auto-merge-off.<id>`. The engine checks for any BEFORE it reads the policy (autoMergeKilled): while
//     one is there, auto_merge is off, whatever policy.yaml says. Any error reading the directory but "no such
//     directory" counts as off.
//   - Turning auto_merge off never takes root's policy lock and never reads or parses policy.yaml, and needs no new
//     space: root keeps a disarmed spare (`<instance>.auto-merge-spare`, which the engine never counts), and OFF arms
//     it by a rename (no new inode or block). With no spare, OFF writes a new switch (a temp file renamed into place).
//     Either way the switch and the directory are fsynced before OFF says done. Every OFF surface comes here:
//     `<cli> policy set <instance> auto_merge off`, an admin's or the machine helper's literal rule for a dashboard.
//   - Only root's `policy set <instance> auto_merge on`, through the locked path, removes switches, and only the ones
//     it saw before it waited for the lock (armedSwitches), each by its own name: an OFF that lands any time after
//     that has a name ON never saw, so nothing ON does (or a crash part way) can undo it. There is never a moment
//     with no switch while one that said done should be there.
// The coordinator user can't create, remove or replace any of them: root's directory, 0755 (recordDir).
//
// INVARIANT: this module imports nothing that reads policy.yaml or takes root's lock (test/policy-edit.test.ts holds
// its imports to node's own modules and the pure ones below).
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { etcPath } from './os/system-paths.js';

/** Root's record of the instances whose policy.yaml is root's (src/policy-gate.ts), and their kill switches. */
export const POLICY_ROOT_DIR = etcPath('policy-root');

/** The name every armed switch of an instance starts with (and the one the first ones had). */
export const killSwitchPath = (instance: string, dir = POLICY_ROOT_DIR) => join(dir, `${instance}.auto-merge-off`);
/** An instance's disarmed spare: never counted; OFF renames it into an armed name. */
export const spareSwitchPath = (instance: string, dir = POLICY_ROOT_DIR) => join(dir, `${instance}.auto-merge-spare`);

/** A name no file in the record directory can have, so it is never an instance's. */
const fileName = (instance: string) => !!instance && instance !== '.' && instance !== '..' && !/[/\\\0]/.test(instance);

/**
 * The armed switches of an instance there now, by name; null when the directory can't be read (an error but ENOENT).
 * Instance names hold no dot, so `<instance>.auto-merge-off` never starts another instance's name.
 */
function armed(instance: string, dir: string): string[] | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const prefix = `${instance}.auto-merge-off`;
  return names.filter((n) => n.startsWith(prefix));
}

/**
 * Whether root's kill switch turns this instance's auto_merge off: checked before anything reads its policy.yaml.
 * Fail closed toward off: any armed switch (whatever it is: a file, a link, a directory), or a directory that can't be
 * read, is off.
 */
export function autoMergeKilled(instance: string, dir = POLICY_ROOT_DIR): boolean {
  if (!fileName(instance)) return false;
  const a = armed(instance, dir);
  return a === null || a.length > 0;
}

/** The armed switches root's `set on` may clear: the ones there before it waits for its lock (clearKillSwitches). */
export function armedSwitches(instance: string, dir = POLICY_ROOT_DIR): string[] {
  return fileName(instance) ? (armed(instance, dir) ?? []) : [];
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

function fsyncPath(p: string): void {
  const fd = openSync(p, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A new file in `dir`, 0644: a temp file renamed to `to`. */
function writeNew(dir: string, to: string, text: string): void {
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.auto-merge.tmp`);
  writeFileSync(tmp, text, { mode: 0o644, flag: 'wx' });
  chmodSync(tmp, 0o644);
  renameSync(tmp, to);
}

/** Root keeps a disarmed spare for each instance it took over (`own`, `set`, after `set on`), so OFF needs no space. */
export function ensureSpare(instance: string, dir = POLICY_ROOT_DIR): void {
  if (!fileName(instance)) return;
  recordDir(dir);
  try {
    writeFileSync(spareSwitchPath(instance, dir), 'disarmed: auto_merge off renames this into <instance>.auto-merge-off.<id>\n', { mode: 0o644, flag: 'wx' });
    chmodSync(spareSwitchPath(instance, dir), 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * Turn this instance's auto_merge off (as root): arm a switch of its own, by renaming the disarmed spare (no new space)
 * or, with none, writing one; fsync it and the directory; then, if space allows, a new spare for the next OFF. No
 * lock, no policy.yaml: nothing else can hold this up. Returns the switch's path.
 */
export function killAutoMerge(instance: string, dir = POLICY_ROOT_DIR, at = new Date()): string {
  if (!fileName(instance)) throw new Error(`${instance}: not an instance name`);
  recordDir(dir);
  const to = `${killSwitchPath(instance, dir)}.${at.getTime()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(spareSwitchPath(instance, dir), to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    writeNew(dir, to, `auto_merge off since ${at.toISOString()}\n`);
  }
  fsyncPath(to);
  fsyncPath(dir);
  try {
    ensureSpare(instance, dir);
  } catch {
    // no space for the next spare: the next OFF writes its own switch, or names why it can't
  }
  return to;
}

/**
 * Root's `policy set <instance> auto_merge on` only (src/policy-root.ts, inside its lock, after it wrote
 * policy.yaml): the switches it saw before it waited for the lock go, each by its own name, and nothing else. A
 * switch an OFF armed since has a name ON never saw, so it stays: no OFF that said done is ever undone, part way or
 * whole. Then a spare for the next OFF.
 */
export function clearKillSwitches(instance: string, seen: readonly string[], dir = POLICY_ROOT_DIR): void {
  for (const name of seen) {
    try {
      unlinkSync(join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  ensureSpare(instance, dir);
}

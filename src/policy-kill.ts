// auto_merge OFF on a single machine (#726; the owner's structural decision of 2026-10-19, and principle 2: OFF can
// never be blocked or undone): root's kill switch for one instance, in root's record directory (/etc/<cli>/policy-root).
//
//   - A switch is any file whose name starts with `<instance>.auto-merge-off`: each OFF leaves one under a new name of
//     its own, `<instance>.auto-merge-off.<id>`, moving an armed one there, or the spare, by rename. OFFs one after
//     another, or many at once, add no files and report no failure while a switch is armed (armOne); only an OFF
//     that finds no switch and no spare at all writes one. While a rename is in progress, an OFF given to the old name
//     arms the new name's too (`<old>.rename-to`, which instance-rename.sh writes first and removes last). The engine
//     checks for any BEFORE it reads the policy (autoMergeKilled): while
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
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** How old a temp file of ours is before it counts as a root writer's that crashed between writing and renaming it. */
const TEMP_STALE_MS = 60_000;
/** Temp files a root writer killed before its rename left behind (`.<hex>.auto-merge.tmp`): gone on the next write. */
function sweepTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^\.[0-9a-f]{12}\.auto-merge\.tmp$/.test(n)) continue;
    try {
      if (Date.now() - statSync(join(dir, n)).mtimeMs > TEMP_STALE_MS) unlinkSync(join(dir, n));
    } catch {
      // gone already
    }
  }
}

/** A new file in `dir`, 0644: a temp file renamed to `to`. */
function writeNew(dir: string, to: string, text: string): void {
  sweepTemps(dir);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.auto-merge.tmp`);
  writeFileSync(tmp, text, { mode: 0o644, flag: 'wx' });
  chmodSync(tmp, 0o644);
  renameSync(tmp, to);
}

/** Root keeps a disarmed spare for each instance it took over (`own`, `set`, after `set on`), so OFF needs no space. */
export function ensureSpare(instance: string, dir = POLICY_ROOT_DIR): void {
  if (!fileName(instance)) return;
  recordDir(dir);
  sweepTemps(dir);
  try {
    lstatSync(spareSwitchPath(instance, dir));
    return; // there already
  } catch {
    // none yet
  }
  try {
    writeFileSync(spareSwitchPath(instance, dir), 'disarmed: auto_merge off renames this into <instance>.auto-merge-off.<id>\n', { mode: 0o644, flag: 'wx' });
    chmodSync(spareSwitchPath(instance, dir), 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/** Where a rename in progress forwards an instance's auto_merge off (instance-rename.sh writes it first, removes it last). */
export const renameForwardPath = (instance: string, dir = POLICY_ROOT_DIR) => join(dir, `${instance}.rename-to`);

/** The new name a rename of `instance` in progress forwards its OFF to, or null (read only: no lock, no parse). */
function renamedTo(instance: string, dir: string): string | null {
  try {
    const to = readFileSync(renameForwardPath(instance, dir), 'utf8').trim();
    return /^[a-z][a-z0-9-]{0,40}$/.test(to) && to !== instance ? to : null;
  } catch {
    return null;
  }
}

/**
 * Arm one instance's switch under a new name of its own, and say when that is done. THREAT (#726 round 5): many OFFs
 * at once (the helper takes no lock, so a coordinator user can run it in parallel) must neither add files nor report a
 * failure while auto_merge is off. So:
 *   - it moves a switch armed there (one picked at random, so racing OFFs spread out), else the disarmed spare, by
 *     rename: no new space, and a switch stays visible throughout;
 *   - losing a rename race to another OFF is done: when the name it moved has gone and a name it hadn't seen has
 *     appeared, a later OFF armed that one after this OFF began, so no `set on` that listed before this OFF can clear
 *     it (only an ON's clear makes names go without new ones coming);
 *   - it writes a new file only when there is no switch and no spare at all.
 */
function armOne(instance: string, dir: string, at: Date): void {
  const to = `${killSwitchPath(instance, dir)}.${at.getTime()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const spare = spareSwitchPath(instance, dir);
  let seen = armed(instance, dir) ?? [];
  let mine = false;
  for (let i = 0; i < 64; i++) {
    const from = seen.length ? join(dir, seen[Math.floor(Math.random() * seen.length)]!) : spare;
    try {
      renameSync(from, to);
      mine = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const now = armed(instance, dir) ?? [];
    if (now.some((n) => !seen.includes(n))) return fsyncPath(dir); // a later OFF's switch: done
    if (!now.length && from === spare) break; // no switch, no spare
    seen = now;
  }
  if (!mine) {
    const now = armed(instance, dir) ?? [];
    if (now.some((n) => !seen.includes(n))) return fsyncPath(dir);
    writeNew(dir, to, `auto_merge off since ${at.toISOString()}\n`);
  }
  try {
    fsyncPath(to);
  } catch (e) {
    // A later OFF moved it on already (its own name, armed after this one): done all the same.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fsyncPath(dir);
}

/**
 * Turn this instance's auto_merge off (as root): arm a switch of its own name (armOne: by rename, no new space; a new
 * file only with no switch and no spare at all); fsync it and the directory; then, if space allows, a new spare for
 * the next OFF. While a rename of the instance is in progress (renamedTo), the new name's switch is armed too, the
 * same way, before OFF says done: an OFF given to the old name at any step reaches the instance that runs. No lock,
 * no policy.yaml: nothing else can hold this up.
 */
export function killAutoMerge(instance: string, dir = POLICY_ROOT_DIR, at = new Date()): void {
  if (!fileName(instance)) throw new Error(`${instance}: not an instance name`);
  recordDir(dir);
  const forward = renamedTo(instance, dir);
  if (forward) {
    // The new name first: it is the one that runs (or will). The old name's coordinator is parked from the rename's
    // first step, and its switches may be gone already (its removal takes them before its user), so its own switch
    // is armed where it can be; an --abort carries the new name's back to it (instance-rename.sh).
    try {
      armOne(forward, dir, at);
    } catch (e) {
      throw new Error(`${instance} is being renamed to ${forward}, and ${forward}'s auto_merge switch couldn't be armed (${(e as Error).message}): run \`policy set ${forward} auto_merge off\` as root`);
    }
    try {
      armOne(instance, dir, at);
    } catch {
      // the new name is off; the old one is parked
    }
  } else armOne(instance, dir, at);
  for (const n of forward ? [instance, forward] : [instance]) {
    try {
      ensureSpare(n, dir);
    } catch {
      // no space for the next spare: the next OFF moves the armed switch, which needs none
    }
  }
}

/**
 * Root's `policy set <instance> auto_merge on` only (src/policy-root.ts, inside its lock, after it wrote
 * policy.yaml): the switches it saw before it waited for the lock go, each by its own name, and nothing else. A
 * switch an OFF armed since has a name ON never saw, so it stays: no OFF that said done is ever undone, part way or
 * whole. ON made sure of a spare before it changed anything (src/policy-root.ts), so the next OFF needs no new space.
 */
export function clearKillSwitches(seen: readonly string[], dir = POLICY_ROOT_DIR): void {
  for (const name of seen) {
    try {
      unlinkSync(join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

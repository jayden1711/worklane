// auto_merge OFF on a single machine (#726; the owner's structural decision of 2026-10-19, and principle 2: OFF can
// never be blocked or undone): root's kill switch for one instance, in root's record directory (/etc/<cli>/policy-root).
//
//   - A switch is any `<instance>.auto-merge-off*`; each OFF leaves one of its own name (armOne), moving an armed one
//     or the disarmed spare (`<instance>.auto-merge-spare`): no new space, no lock, no read of policy.yaml.
//     The engine checks them BEFORE it reads the policy (autoMergeKilled); a directory it can't read counts as off.
//   - Only root's `set on` removes switches: the ones it saw before it waited for the lock, each by name, so no OFF
//     that said done is undone.
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

/** A temp file this old is swept whatever its writer; a live (or unknown) writer's never sooner, so a stalled one keeps it. */
const TEMP_ABANDONED_MS = 24 * 60 * 60 * 1000;
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
/** Temp files a killed root writer left: `.<pid>-<hex>.auto-merge.tmp` once that pid is gone (one pid space: no PrivatePIDs), any once a day old. */
function sweepTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^\.(?:([1-9][0-9]{0,9})-)?[0-9a-f]{12}\.auto-merge\.tmp$/.exec(n);
    if (!m) continue;
    try {
      if ((m[1] && pidGone(Number(m[1]))) || Date.now() - statSync(join(dir, n)).mtimeMs > TEMP_ABANDONED_MS) unlinkSync(join(dir, n));
    } catch {
      // gone already
    }
  }
}

/** A new file in `dir`, 0644: a temp file (named for this pid) renamed to `to`. */
function writeNew(dir: string, to: string, text: string): void {
  sweepTemps(dir);
  const tmp = join(dir, `.${process.pid}-${randomBytes(6).toString('hex')}.auto-merge.tmp`);
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

/** Root's forward record of a rename: written first; gone on --abort, with either name's removal, and at the end. */
export const renameForwardPath = (instance: string, dir = POLICY_ROOT_DIR) => join(dir, `${instance}.rename-to`);

/** Root's forward record of `instance`: null only when there is none (ENOENT), else the name it gives or its problem. */
export function forwardRecord(instance: string, dir = POLICY_ROOT_DIR): null | { to: string } | { problem: string } {
  let text: string;
  try {
    text = readFileSync(renameForwardPath(instance, dir), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { problem: (e as Error).message };
  }
  const to = text.trim();
  return /^[a-z][a-z0-9-]{0,40}$/.test(to) && to !== instance ? { to } : { problem: `it names no other instance (${JSON.stringify(to.slice(0, 40))})` };
}

/**
 * Arm one instance's switch under a new name of its own. Racing OFFs add no files and never fail while one is armed:
 * it moves an armed switch (picked at random) or the spare; losing that race is done once a name it hadn't seen
 * appears (a later OFF's, which no earlier `set on` listed); a new file only with no switch and no spare at all.
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

/** An OFF that couldn't arm a name that can still start (or tell where a rename forwards it): never reported done. */
export class KillSwitchError extends Error {
  constructor(readonly stillOn: readonly { name: string; why: string }[], notes: readonly string[] = []) {
    super([...stillOn.map(({ name, why }) => `${name}'s auto_merge switch couldn't be armed (${why}), so ${name} can still merge on its own: free space in ${POLICY_ROOT_DIR}, then run \`policy set ${name} auto_merge off\` as root again`), ...notes].join('; '));
  }
}

/**
 * Turn this instance's auto_merge off (as root). THE RULE (#726 round 7): arm every name OFF reaches before deciding
 * anything; done only when each that can still start (`canStart`: its coordinator user is there) is armed, else
 * KillSwitchError naming it. The names: the one given, first; then the one its forward record gives, even once the
 * given name's user is gone. Each by armOne, then a new spare if space allows. No lock, no policy.yaml.
 */
export function killAutoMerge(instance: string, dir = POLICY_ROOT_DIR, at = new Date(), canStart: (name: string) => boolean = () => true): void {
  if (!fileName(instance)) throw new Error(`${instance}: not an instance name`);
  const failed: { name: string; why: string }[] = [];
  let dirWhy: string | null = null;
  try {
    recordDir(dir);
  } catch (e) {
    dirWhy = (e as Error).message; // every arm still tried
  }
  const rec = forwardRecord(instance, dir);
  const forward = rec && 'to' in rec ? rec.to : null;
  const names = forward ? [instance, forward] : [instance];
  for (const name of names) {
    try {
      armOne(name, dir, at);
    } catch (e) {
      failed.push({ name, why: dirWhy ? `${(e as Error).message}; ${dirWhy}` : (e as Error).message });
    }
  }
  for (const n of names) {
    try {
      ensureSpare(n, dir);
    } catch {
      // no space for the next spare: the next OFF moves the armed switch, which needs none
    }
  }
  const stillOn = failed.filter(({ name }) => {
    try {
      return canStart(name);
    } catch {
      return true; // can't tell: it can start
    }
  });
  const notes = rec && 'problem' in rec ? [`root's ${renameForwardPath(instance, dir)} can't be used (${rec.problem}): if a rename of ${instance} is under way, run \`policy set <its new name> auto_merge off\` as root too, then fix or remove that file`] : [];
  if (stillOn.length || notes.length) throw new KillSwitchError(stillOn, notes);
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

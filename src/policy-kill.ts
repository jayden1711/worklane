// auto_merge OFF on a single machine (#726; the owner's structural decision of 2026-10-19, and principle 2: OFF can
// never be blocked or undone): root's kill switch for one instance, in root's record directory (/etc/<cli>/policy-root).
//
//   - Switches are keyed by a stable instance id, never by name (the owner's decision, round 9): root's pointer
//     `<name>.id` holds a random id, and the switches live in `by_id/<id>/`. A rename writes the new name's pointer with
//     the same id at its start (aliasInstance), so it never carries, forwards or moves a switch; the old name's removal
//     drops its pointer, and --abort the new one's. (`by_id`: an instance name has no `_`, so it is never a record's.)
//   - Each OFF leaves a switch of its own name in that directory (armOne), moving an armed one or the disarmed spare:
//     no new space, no lock, no read of policy.yaml. The engine checks them BEFORE it reads the policy
//     (autoMergeKilled). Fail closed: a pointer that can't be read, isn't a plain file or holds no id, an id directory
//     that is missing or can't be listed, or a taken-over instance (its record there) with no pointer, all read off.
//   - Only root's `set on` removes switches: the ones it saw before it waited for the lock, each by name, so no OFF
//     that said done is undone.
// The coordinator user can't create, remove or replace any of them: root's directories, 0755 (recordDir).
//
// INVARIANT: this module imports nothing that reads policy.yaml or takes root's lock (test/policy-edit.test.ts holds
// its imports to node's own modules and the pure ones below).
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { etcPath } from './os/system-paths.js';

/** Root's record of the instances whose policy.yaml is root's (src/policy-gate.ts), their ids and kill switches. */
export const POLICY_ROOT_DIR = etcPath('policy-root');

/** A name no file in the record directory can have, so it is never an instance's. */
const fileName = (instance: string) => !!instance && instance !== '.' && instance !== '..' && !/[/\\\0]/.test(instance);
const ID = /^[0-9a-f]{32}$/;

/** Root's pointer from an instance's name to its id. */
export const idPointerPath = (instance: string, dir = POLICY_ROOT_DIR) => join(dir, `${instance}.id`);
/** Where an id's switches and spare live. */
export const idDir = (id: string, dir = POLICY_ROOT_DIR) => join(dir, 'by_id', id);

/** An instance's id: null only when it has no pointer (ENOENT); a pointer that can't be used gives its problem. */
export function instanceId(instance: string, dir = POLICY_ROOT_DIR): null | { id: string } | { problem: string } {
  const p = idPointerPath(instance, dir);
  try {
    if (!lstatSync(p).isFile()) return { problem: 'not a plain file' };
    const id = readFileSync(p, 'utf8').trim();
    return ID.test(id) ? { id } : { problem: `it holds no id (${JSON.stringify(id.slice(0, 40))})` };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { problem: (e as Error).message };
  }
}

/** Whether root's record says the instance was taken over (anything at that name but "no such file" counts). */
function recorded(instance: string, dir: string): boolean {
  try {
    lstatSync(join(dir, instance));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** The armed switches in an id's directory, by name; null when it is missing or can't be read. */
function armed(d: string): string[] | null {
  try {
    return readdirSync(d).filter((n) => n.startsWith('auto-merge-off'));
  } catch {
    return null;
  }
}

/** Whether root's kill switch turns this instance's auto_merge off: checked before anything reads its policy.yaml. */
export function autoMergeKilled(instance: string, dir = POLICY_ROOT_DIR): boolean {
  if (!fileName(instance)) return false;
  const p = instanceId(instance, dir);
  if (p === null) return recorded(instance, dir);
  if ('problem' in p) return true;
  const a = armed(idDir(p.id, dir));
  return a === null || a.length > 0;
}

/** The armed switches root's `set on` may clear (full paths): the ones there before it waits for its lock. */
export function armedSwitches(instance: string, dir = POLICY_ROOT_DIR): string[] {
  const p = fileName(instance) ? instanceId(instance, dir) : null;
  if (!p || 'problem' in p) return [];
  const d = idDir(p.id, dir);
  return (armed(d) ?? []).map((n) => join(d, n));
}

/** The other names whose pointer holds this instance's id (a rename under way, or one a crash left). */
export function sharedWith(instance: string, dir = POLICY_ROOT_DIR): string[] {
  const p = instanceId(instance, dir);
  if (!p || 'problem' in p) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.id') && n !== `${instance}.id`)
    .map((n) => n.slice(0, -3))
    .filter((n) => {
      const q = instanceId(n, dir);
      return q !== null && 'id' in q && q.id === p.id;
    });
}

/** Root's directories, made whatever root's umask: 0755, so the coordinator user can read and change nothing. */
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
/** Temp files a killed root writer left: `.<pid>-<hex>.(auto-merge|id).tmp` once that pid is gone (no PrivatePIDs), any once a day old. */
function sweepTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^\.(?:([1-9][0-9]{0,9})-)?[0-9a-f]{12}\.(?:auto-merge|id)\.tmp$/.exec(n);
    if (!m) continue;
    try {
      if ((m[1] && pidGone(Number(m[1]))) || Date.now() - statSync(join(dir, n)).mtimeMs > TEMP_ABANDONED_MS) unlinkSync(join(dir, n));
    } catch {
      // gone already
    }
  }
}

/** A temp file in `dir`, 0644, named for this pid. */
function tempFile(dir: string, kind: string, text: string): string {
  sweepTemps(dir);
  const tmp = join(dir, `.${process.pid}-${randomBytes(6).toString('hex')}.${kind}.tmp`);
  writeFileSync(tmp, text, { mode: 0o644, flag: 'wx' });
  chmodSync(tmp, 0o644);
  return tmp;
}

/** Write `instance`'s pointer to `id` if it has none (an atomic link: never a half-written pointer); its id after. */
function linkPointer(instance: string, id: string, dir: string): string {
  const tmp = tempFile(dir, 'id', `${id}\n`);
  try {
    linkSync(tmp, idPointerPath(instance, dir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    unlinkSync(tmp);
  }
  const p = instanceId(instance, dir);
  if (!p || 'problem' in p) throw new Error(`${idPointerPath(instance, dir)}: ${p ? p.problem : 'gone'}`);
  fsyncPath(idPointerPath(instance, dir));
  fsyncPath(dir);
  return p.id;
}

/** A new id for an instance with no pointer: its directory first, then the pointer (another writer's, if it won). */
function mintId(instance: string, dir: string): string {
  recordDir(dir);
  const id = randomBytes(16).toString('hex');
  recordDir(idDir(id, dir));
  const got = linkPointer(instance, id, dir);
  if (got !== id) {
    try {
      rmdirSync(idDir(id, dir)); // another writer's pointer won: ours is empty and no one's
    } catch {
      // not empty, or gone: nothing points at it
    }
  }
  return got;
}

/** The instance's id, minting one when it has no pointer and `mint` allows; refused on a pointer that can't be used. */
export function ensureId(instance: string, dir = POLICY_ROOT_DIR, mint = true): string {
  if (!fileName(instance)) throw new Error(`${instance}: not an instance name`);
  const p = instanceId(instance, dir);
  if (p && 'problem' in p) throw new Error(`root's ${idPointerPath(instance, dir)} can't be used (${p.problem}): auto_merge reads off while it is so`);
  if (p) return p.id;
  if (!mint) throw new Error(`no ${idPointerPath(instance, dir)} for an instance root took over: auto_merge reads off until an admin runs \`policy own ${instance} --retake\``);
  return mintId(instance, dir);
}

/** Root keeps a disarmed spare in each id's directory (`own`, `set`, before `set on`, a rename's start), so OFF needs no space. */
export function ensureSpare(instance: string, dir = POLICY_ROOT_DIR, mint = false): void {
  const d = idDir(ensureId(instance, dir, mint), dir);
  recordDir(d);
  sweepTemps(d);
  try {
    writeFileSync(join(d, 'auto-merge-spare'), 'disarmed: auto_merge off renames this into auto-merge-off.<id>\n', { mode: 0o644, flag: 'wx' });
    chmodSync(join(d, 'auto-merge-spare'), 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * A rename's start (instance-rename.sh, as root): the new name's pointer holds the old name's id (minted, with its
 * spare, if the old name had none), so both names are the same instance's switches from here on. Refused when the
 * new name already points elsewhere.
 */
export function aliasInstance(from: string, to: string, dir = POLICY_ROOT_DIR): string {
  if (!fileName(to)) throw new Error(`${to}: not an instance name`);
  const id = ensureId(from, dir, true);
  ensureSpare(from, dir);
  const got = linkPointer(to, id, dir);
  if (got !== id) throw new Error(`${idPointerPath(to, dir)} holds another id: ${to} is in use`);
  return id;
}

/**
 * Arm one switch of its own name in an id's directory. Racing OFFs add no files and never fail while one is armed:
 * it moves an armed switch (picked at random) or the spare; losing that race is done once a name it hadn't seen
 * appears (a later OFF's, which no earlier `set on` listed); a new file only with no switch and no spare at all.
 */
function armOne(d: string, at: Date): void {
  const to = join(d, `auto-merge-off.${at.getTime()}-${process.pid}-${randomBytes(4).toString('hex')}`);
  const spare = join(d, 'auto-merge-spare');
  let seen = armed(d) ?? [];
  let mine = false;
  for (let i = 0; i < 64; i++) {
    const from = seen.length ? join(d, seen[Math.floor(Math.random() * seen.length)]!) : spare;
    try {
      renameSync(from, to);
      mine = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const now = armed(d) ?? [];
    if (now.some((n) => !seen.includes(n))) return fsyncPath(d); // a later OFF's switch: done
    if (!now.length && from === spare) break; // no switch, no spare
    seen = now;
  }
  if (!mine) {
    const now = armed(d) ?? [];
    if (now.some((n) => !seen.includes(n))) return fsyncPath(d);
    renameSync(tempFile(d, 'auto-merge', `auto_merge off since ${at.toISOString()}\n`), to);
  }
  try {
    fsyncPath(to);
  } catch (e) {
    // A later OFF moved it on already (its own name, armed after this one): done all the same.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fsyncPath(d);
}

/** An OFF that couldn't arm its instance's switch: never reported done. */
export class KillSwitchError extends Error {
  constructor(instance: string, why: string) {
    super(`${instance}'s auto_merge switch couldn't be armed (${why}), so it can still merge on its own: fix that (free space in ${POLICY_ROOT_DIR}), then run \`policy set ${instance} auto_merge off\` as root again`);
  }
}

/**
 * Turn this instance's auto_merge off (as root): its id (a new one only when it has no pointer yet: needs space), then
 * a switch armed in that id's directory by armOne, then a new spare if space allows. Every name pointing at the id
 * (a rename's two) is off at once. No lock, no policy.yaml.
 */
export function killAutoMerge(instance: string, dir = POLICY_ROOT_DIR, at = new Date()): void {
  if (!fileName(instance)) throw new Error(`${instance}: not an instance name`);
  let d: string;
  try {
    d = idDir(ensureId(instance, dir, true), dir);
    armOne(d, at);
  } catch (e) {
    throw new KillSwitchError(instance, (e as Error).message);
  }
  try {
    ensureSpare(instance, dir);
  } catch {
    // no space for the next spare: the next OFF moves the armed switch, which needs none
  }
}

/** Root's `set on` only (inside its lock): the switches it saw before it waited for the lock go, each by its own path. */
export function clearKillSwitches(seen: readonly string[]): void {
  for (const p of seen) {
    try {
      unlinkSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

// The one way to write a file in the shared slot directory (#661). Removing an instance (#555) takes group write
// off its files there, so any of them can be 0444 to everyone else: an in-place write gets EACCES (#616). Replacing
// a file needs only the directory's write permission. So writeSlotFile puts the content in a temp file of its own,
// with a random name and created exclusively (O_EXCL), so it never opens a file someone else left (a crashed
// writer's, or one under a reused pid), and then renames it over the file, or hard-links it to a file that must not
// exist yet (a lock). test/slot-dir-writes.test.ts reports any other write in a module that touches the slot dir.
//
// Everything done to the temp file goes through the descriptor its exclusive open returned (its mode, its content),
// never through its name: the slot dir is group-writable without the sticky bit, so another member can swap the
// name for a symlink at any moment, and a chmod by name would follow it to a file of the writer's own.
//
// A slot-dir path is a SlotPath (#772), never a string: an opaque value that only this module turns back into the
// path. os/index.ts makes the slot dir one (slotsDir), slotFile names a file in it, and only the
// functions here read, list, remove or write what one names. So tsc rejects a slot path handed to any other writer
// (writeFileSync, writeGroupOnly, path.join, a method of another module, through `.call` too), whatever the call
// chain; and at run time the value is an object whose path no one else can read: fs and path.join refuse it, and
// String(), a template literal and `+` throw. test/slot-path.test.ts checks that nothing else makes one, that no
// cast or string conversion touches one, and that fs is reached only through imports tsc can type.
//
// A function here also takes a plain string (a path outside the slot dir, or a test's own dir): a string carries no
// slot path, so it changes nothing above. An error from a slot path's file operation keeps its code, never the path.
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

declare const SLOT_PATH: unique symbol;

/** A path in the machine's shared slot directory: opaque everywhere but here (the key is this module's alone). */
export interface SlotPath {
  readonly [SLOT_PATH]: 'slot path';
}

/** What the functions here take: a slot path, or a plain path that is not one. */
export type SlotPathLike = SlotPath | string;

const OPAQUE = 'a slot path is opaque: only src/slot-file.ts reads, lists, removes or writes what it names';

/** Passed to Box's constructor: one reached through a slot path's `constructor` refuses to make another. */
const MINT = Symbol('slot path');
/** Reads a Box's path: set in its static block, so no method on the class or a value hands it out. */
let pathOf: (b: Box) => string = () => {
  throw new TypeError(OPAQUE);
};

/** A slot path at run time: its path is in a private field, read only through `pathOf`. */
class Box {
  readonly #path: string;
  static {
    pathOf = (b: Box) => b.#path; // a TypeError for anything not made here (a forged object, a Proxy)
  }
  constructor(mint: symbol, path: string) {
    if (mint !== MINT) throw new TypeError(OPAQUE);
    this.#path = path;
    Object.freeze(this);
  }
  toString(): never {
    throw new TypeError(OPAQUE);
  }
  [Symbol.toPrimitive](): never {
    throw new TypeError(OPAQUE);
  }
  toJSON(): string {
    return '[slot path]';
  }
}
Object.freeze(Box.prototype);
Object.freeze(Box);

/**
 * A fresh value on every mint, never one shared per path: two slot paths for one place are different values. So
 * identity (`===`, `Object.is`, a Map, Set or WeakMap key) tells no caller whether a path it chose is the slot dir:
 * `slotPathOf(guess) === slotsDir()` is false whatever the guess (#806 round 6). No table is kept, so there is no
 * size or cache timing to read either. os/index.ts keeps the one slot dir it resolves, so slotsDir() is one value.
 */
const box = (path: string): SlotPath => new Box(MINT, path) as unknown as SlotPath;

/**
 * A slot path made by slotFile or slotSibling: its own name and the directory it is in, kept when it is made. So
 * slotFileName and makeSlotFileDir never take a path apart (path.basename and dirname call methods a module could
 * patch: #806 review, A5), and a directory (the slot dir) has no name here at all.
 */
const fileOf = new WeakMap<object, { name: string; dir: SlotPath }>();

/** The path a slot path names (a string is its own). Private: no export hands one out. */
const raw = (p: SlotPathLike): string => (typeof p === 'string' ? p : pathOf(p as unknown as Box));

/**
 * A directory as a slot path: a new value every time, equal (`===`) to no other. Only src/os/index.ts calls this in
 * src/, with the directory it resolved (slotsDir) or a test's system dir (slotsDirFor): test/slot-path.test.ts
 * reports any other caller. Even one would learn nothing: the value it gets is equal to no slot path but itself.
 */
export function slotPathOf(dir: string): SlotPath {
  // No method is called on the path (a patched String.prototype.includes would be handed it): a NUL in it is refused by
  // fs at its first use.
  if (typeof dir !== 'string' || !dir) throw new TypeError('a slot dir is a non-empty path');
  return box(dir);
}

/** `name` is one plain file name: no separator, not `.` or `..`. */
function plainName(name: string, what: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new TypeError(`${what} is a plain file name, not ${JSON.stringify(name)}`);
  return name;
}

/** A slot path for the file `name` in `dir`, built by concatenation alone: no method is handed the path (A5). */
const fileIn = (dir: SlotPath, name: string): SlotPath => {
  const p = box(`${raw(dir)}/${name}`);
  fileOf.set(p, { name, dir });
  return p;
};

/** The file `name` in the directory `dir`. A slot dir gives a slot path, a string a string (path.join, as before). */
export function slotFile(dir: SlotPath, name: string): SlotPath;
export function slotFile(dir: string, name: string): string;
export function slotFile(dir: SlotPathLike, name: string): SlotPathLike;
export function slotFile(dir: SlotPathLike, name: string): SlotPathLike {
  const n = plainName(name, 'a slot file');
  return typeof dir === 'string' ? join(dir, n) : fileIn(dir, n);
}

/**
 * The file beside `file` named `file` + `suffix` (a lock's takeover claim, a file moved aside). Only beside a file
 * slotFile or slotSibling named: beside the slot dir itself, slotFileName would give the slot dir's own name.
 */
export function slotSibling(file: SlotPath, suffix: string): SlotPath;
export function slotSibling(file: string, suffix: string): string;
export function slotSibling(file: SlotPathLike, suffix: string): SlotPathLike;
export function slotSibling(file: SlotPathLike, suffix: string): SlotPathLike {
  const s = plainName(suffix, 'a suffix');
  if (typeof file === 'string') return `${file}${s}`;
  const f = fileOf.get(file);
  if (!f) throw new TypeError(`${OPAQUE}; a sibling is only of a file named by slotFile`);
  return fileIn(f.dir, `${f.name}${s}`);
}

// Nothing here gives a slot path's parent: a value for a directory above the slot dir could be listed, and its
// entries told apart by `===` with slotFile, spelling the path out. Only a file's own directory is made (below).

/**
 * The file's own name, without its directory: only for a slot path made by slotFile or slotSibling, whose name its
 * caller gave. Never a directory's (the slot dir), and never a name the caller didn't give (#806 review, A1).
 */
export function slotFileName(file: SlotPathLike): string {
  if (typeof file === 'string') return basename(file);
  const f = fileOf.get(file);
  if (!f) throw new TypeError(OPAQUE);
  return f.name;
}

/** Run `fileOp` on the path; for a slot path, an error keeps its code and loses the path (its message, `path`, `dest`). */
function onPath<T>(p: SlotPathLike, fileOp: (path: string) => T): T {
  if (typeof p === 'string') return fileOp(p);
  try {
    return fileOp(raw(p));
  } catch (e) {
    throw pathless(e);
  }
}

function onPaths<T>(a: SlotPathLike, b: SlotPathLike, fileOp: (a: string, b: string) => T): T {
  return onPath(a, (x) => onPath(b, (y) => fileOp(x, y)));
}

function pathless(e: unknown): Error {
  const x = e as NodeJS.ErrnoException;
  const code = typeof x?.code === 'string' ? x.code : undefined;
  const syscall = typeof x?.syscall === 'string' ? x.syscall : undefined;
  return Object.assign(new Error(`${code ?? 'error'}: ${syscall ?? 'a file operation'} on a slot-dir path`), { ...(code ? { code } : {}), ...(syscall ? { syscall } : {}), ...(typeof x?.errno === 'number' ? { errno: x.errno } : {}) });
}

/** The file's text (utf8). */
export const readSlotFile = (file: SlotPathLike): string => onPath(file, (f) => readFileSync(f, 'utf8'));
/** The names in the directory. */
export const listSlotDir = (dir: SlotPathLike): string[] => onPath(dir, (d) => readdirSync(d));
export const statSlotFile = (file: SlotPathLike) => onPath(file, (f) => statSync(f));
/** The entry itself, a symlink not followed. */
export const lstatSlotFile = (file: SlotPathLike) => onPath(file, (f) => lstatSync(f));
export const slotFileExists = (file: SlotPathLike): boolean => onPath(file, (f) => existsSync(f));
/** The directory, and its parents, if missing. */
export const makeSlotDir = (dir: SlotPathLike): void => void onPath(dir, (d) => mkdirSync(d, { recursive: true }));
/** The directory `file` is in, and its parents, if missing. */
export function makeSlotFileDir(file: SlotPathLike): void {
  if (typeof file === 'string') return void mkdirSync(dirname(file), { recursive: true });
  const f = fileOf.get(file);
  if (!f) throw new TypeError(`${OPAQUE}; only a file named by slotFile has a directory here`);
  makeSlotDir(f.dir);
}
/** Remove a file (`force`: no error when it is missing). */
export const removeSlotFile = (file: SlotPathLike, o: { force?: boolean } = {}): void => onPath(file, (f) => rmSync(f, { force: o.force === true }));
export const renameSlotFile = (from: SlotPathLike, to: SlotPathLike): void => onPaths(from, to, (a, b) => renameSync(a, b));
/** A hard link `to` the file at `from` (EEXIST when `to` exists). */
export const linkSlotFile = (from: SlotPathLike, to: SlotPathLike): void => onPaths(from, to, (a, b) => linkSync(a, b));
/** What readRegularSlotFile found (os/index.ts readRegularFile adds `unsupported`, native Windows). */
export type RegularRead = { kind: 'missing' | 'hidden' | 'unsupported' | 'symlink' | 'not-file' } | { kind: 'too-big'; size: number } | { kind: 'file'; uid: number; mode: string; text: string };

/**
 * A regular file's owner, mode and text, read through one descriptor opened read-only without following a symlink
 * and without waiting on a FIFO, so what is checked is what is read (os/index.ts readRegularFile, POSIX). The
 * descriptor is closed here: one handed out would name its path through /proc/self/fd (#806 review, A2).
 */
export function readRegularSlotFile(file: SlotPathLike, maxBytes: number): RegularRead {
  let rfd: number;
  try {
    rfd = onPath(file, (f) => openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'symlink' };
    return code === 'EACCES' || code === 'EPERM' ? { kind: 'hidden' } : { kind: 'missing' };
  }
  try {
    const s = fstatSync(rfd);
    if (!s.isFile()) return { kind: 'not-file' };
    if (s.size > maxBytes) return { kind: 'too-big', size: s.size };
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(rfd, buf, 0, maxBytes + 1, 0);
    if (n > maxBytes) return { kind: 'too-big', size: n };
    return { kind: 'file', uid: s.uid, mode: (s.mode & 0o777).toString(8).padStart(4, '0'), text: buf.subarray(0, n).toString('utf8') };
  } finally {
    closeSync(rfd);
  }
}
/** The file system the directory is on. */
export const statfsSlotDir = (dir: SlotPathLike) => onPath(dir, (d) => statfsSync(d));

export interface SlotWrite {
  /** The file's mode, as writeFileSync takes it: the umask applies (default 0o666). */
  mode?: number;
  /** Give the file exactly `mode`, past the umask. */
  exactMode?: boolean;
  /** false: create the file only when there is none, as a lock is taken (a hard link: EEXIST when one exists). Default: replace it. */
  replace?: boolean;
}

/** Write `file` whole: a reader sees the old content or the new, never part of it. On failure nothing is left behind. */
export function writeSlotFile(file: SlotPathLike, data: string, o: SlotWrite = {}): void {
  onPath(file, (f) => place(f, data, o));
}

function place(file: string, data: string, o: SlotWrite): void {
  const tmp = tempWith(file, data, o.mode ?? 0o666, o.exactMode ? o.mode : undefined);
  let placed = false;
  try {
    if (o.replace === false) linkSync(tmp, file);
    else {
      renameSync(tmp, file);
      placed = true;
    }
  } finally {
    if (!placed) rmSync(tmp, { force: true });
  }
}

/**
 * A new temp file beside `file`, holding `data` (with exactly `exact` as its mode, when given). Never an existing
 * one: a name that is taken is skipped, not opened.
 */
function tempWith(file: string, data: string, mode: number, exact: number | undefined): string {
  for (let attempt = 0; ; attempt++) {
    const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let created = false;
    try {
      // test/slot-dir-writes.test.ts records the fs calls made here: one exclusive open, the rest on its descriptor.
      const fd = openSync(tmp, 'wx', mode);
      created = true;
      try {
        if (exact !== undefined) fchmodSync(fd, exact);
        writeFileSync(fd, data);
      } finally {
        closeSync(fd);
      }
      return tmp;
    } catch (e) {
      if (!created) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 2) continue; // someone else's: not ours to touch
        throw e; // not created: nothing of ours to remove
      }
      rmSync(tmp, { force: true }); // created, then the write (or the close) failed
      throw e;
    }
  }
}

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
// path. os/index.ts makes the slot dir one (slotsDir, slotDirAt), slotFile names a file in it, and only the
// functions here read, list, remove or write what one names. So tsc rejects a slot path handed to any other writer
// (writeFileSync, writeGroupOnly, path.join, a method of another module, through `.call` too), whatever the call
// chain; and at run time the value is an object whose path no one else can read: fs and path.join refuse it, and
// String(), a template literal and `+` throw. test/slot-path.test.ts checks that nothing else makes one, that no
// cast or string conversion touches one, and that fs is reached only through imports tsc can type.
//
// A function here also takes a plain string (a path outside the slot dir, or a test's own dir): a string carries no
// slot path, so it changes nothing above. An error from a slot path's file operation keeps its code, never the path.
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
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
 * One value per path, so two slot paths for one place are the same value (`===`, a Map key). A plain object without
 * a prototype, not a Map: no method another module could patch (Map.prototype.get) is ever handed a path.
 */
const made: Record<string, SlotPath> = Object.create(null) as Record<string, SlotPath>;
const box = (path: string): SlotPath => (made[path] ??= new Box(MINT, path) as unknown as SlotPath);

/** Slot paths named by slotFile or slotSibling: the only ones whose name slotFileName gives (never a directory's). */
const named = new WeakSet<object>();

/** The path a slot path names (a string is its own). Private: no export hands one out. */
const raw = (p: SlotPathLike): string => (typeof p === 'string' ? p : pathOf(p as unknown as Box));

/**
 * The slot dir as a slot path. Only src/os/index.ts calls this, with the directory it resolved (slotsDir) or one a
 * caller made for a coordinator of its own (slotDirAt): test/slot-path.test.ts fails on any other caller in src/.
 */
export function slotPathOf(dir: string): SlotPath {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) throw new TypeError('a slot dir is a non-empty path');
  return box(dir);
}

/** `name` is one plain file name: no separator, not `.` or `..`. */
function plainName(name: string, what: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new TypeError(`${what} is a plain file name, not ${JSON.stringify(name)}`);
  return name;
}

const like = (from: SlotPathLike, path: string): SlotPathLike => (typeof from === 'string' ? path : box(path));
const nameOf = (p: SlotPathLike): SlotPathLike => {
  if (typeof p !== 'string') named.add(p);
  return p;
};

/** The file `name` in the directory `dir`. A slot dir gives a slot path, a string a string. */
export function slotFile(dir: SlotPath, name: string): SlotPath;
export function slotFile(dir: string, name: string): string;
export function slotFile(dir: SlotPathLike, name: string): SlotPathLike;
export function slotFile(dir: SlotPathLike, name: string): SlotPathLike {
  return nameOf(like(dir, join(raw(dir), plainName(name, 'a slot file'))));
}

/** The file beside `file` named `file` + `suffix` (a lock's takeover claim, a file moved aside). */
export function slotSibling(file: SlotPath, suffix: string): SlotPath;
export function slotSibling(file: string, suffix: string): string;
export function slotSibling(file: SlotPathLike, suffix: string): SlotPathLike;
export function slotSibling(file: SlotPathLike, suffix: string): SlotPathLike {
  return nameOf(like(file, `${raw(file)}${plainName(suffix, 'a suffix')}`));
}

// Nothing here gives a slot path's parent: a value for a directory above the slot dir could be listed, and its
// entries told apart by `===` with slotFile, spelling the path out. Only a file's own directory is made (below).

/**
 * The file's own name, without its directory: only for a slot path made by slotFile or slotSibling, whose name its
 * caller gave. Never a directory's (the slot dir), so no name of where the slot dir is comes out.
 */
export function slotFileName(file: SlotPathLike): string {
  if (typeof file !== 'string' && !named.has(file)) throw new TypeError(OPAQUE);
  return basename(raw(file));
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
export const makeSlotFileDir = (file: SlotPathLike): void => void onPath(file, (f) => mkdirSync(dirname(f), { recursive: true }));
/** Remove a file (`force`: no error when it is missing). */
export const removeSlotFile = (file: SlotPathLike, o: { force?: boolean } = {}): void => onPath(file, (f) => rmSync(f, { force: o.force === true }));
export const renameSlotFile = (from: SlotPathLike, to: SlotPathLike): void => onPaths(from, to, (a, b) => renameSync(a, b));
/** A hard link `to` the file at `from` (EEXIST when `to` exists). */
export const linkSlotFile = (from: SlotPathLike, to: SlotPathLike): void => onPaths(from, to, (a, b) => linkSync(a, b));
/** A read-only descriptor of the file, a symlink refused (ELOOP) and a FIFO never waited on; the caller closes it. */
export const openSlotFileToRead = (file: SlotPathLike): number => onPath(file, (f) => openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)));
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

// Root's own file inside a directory another user owns (an instance's policy.yaml, in its coordinator's home): how the
// engine checks a file is root's alone, and how root reads and replaces it there without following anything the
// directory's owner planted (issue #726).
//
// THREAT: the directory's owner (the coordinator user) may rename, delete or replace any name in it at any moment, and
// swap a directory on the way for a link. So root never opens a path through that directory: it changes into it, checks
// that the directory it is now in is the expected one (the kernel's own path for it, no link on the way) and the
// owner's, and then works on names relative to it. It reads with O_NOFOLLOW and checks what it opened, and writes a new
// file it created itself (O_EXCL, so never through a planted link) before renaming it over the old name. Whatever the
// owner swaps in afterwards is the owner's own file, which readRootFile refuses.
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Where the file open on `fd` really is: the kernel's own path for it (Linux: /proc/self/fd/<fd>), with every link on
 * the way resolved, whatever path opened it. Null where this OS has no such answer: a caller that must know refuses.
 */
export function openedPath(fd: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

// O_NONBLOCK: a FIFO planted under the name opens at once instead of waiting for a writer (a regular file ignores it).
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/**
 * The most either reader here reads, checked from fstat before reading: a policy.yaml is a few hundred bytes. THREAT:
 * a file the directory's owner planted, megabytes long, would hold root (and its lock) for minutes while parsed, or
 * crash it (#726 round 3).
 */
export const ROOT_FILE_MAX_BYTES = 256 * 1024;

/** The text of the file open on `fd`, read into a buffer of ROOT_FILE_MAX_BYTES + 1 at most; null when it holds more (it grew after fstat). */
function readCapped(fd: number): string | null {
  const buf = Buffer.alloc(ROOT_FILE_MAX_BYTES + 1);
  let n = 0;
  for (;;) {
    const r = readSync(fd, buf, n, buf.length - n, null);
    if (r === 0) break;
    n += r;
    if (n > ROOT_FILE_MAX_BYTES) return null;
  }
  return buf.subarray(0, n).toString('utf8');
}

/** Why an opened file isn't one only `rootUid` can change: a regular file, its owner's, writable by no one else, one name. */
function notRootsAlone(st: { isFile(): boolean; uid: number; mode: number; nlink: number }, rootUid: number): string | null {
  if (!st.isFile()) return "isn't a regular file";
  if (st.uid !== rootUid) return `belongs to uid ${st.uid}, not root`;
  if (st.mode & 0o022) return `may be written by others (mode ${(st.mode & 0o777).toString(8)})`;
  // A second name (a hard link) would be a second way to change it.
  if (st.nlink !== 1) return `has ${st.nlink} names (a hard link)`;
  return null;
}

/**
 * `file`'s text when it is root's alone (never through a link; the checks are on the file this process opened, so
 * nothing swapped in after them is read), and where the kernel says the opened file is (openedPath: a link in a
 * directory on the way shows there); else why it isn't. Native Windows has no such install: read as it is.
 */
export function readRootFile(file: string, rootUid = 0): { text: string; at: string | null } | { problem: string } {
  if (process.platform === 'win32') return { text: readFileSync(file, 'utf8'), at: null };
  let fd: number;
  try {
    fd = openSync(file, OPEN_READ);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { problem: `${file} ${code === 'ELOOP' ? 'is a link' : code === 'ENOENT' ? 'is missing' : `can't be opened (${code ?? (e as Error).message})`}` };
  }
  try {
    const st = fstatSync(fd);
    const why = notRootsAlone(st, rootUid) ?? (st.size > ROOT_FILE_MAX_BYTES ? `is ${st.size} bytes, over ${ROOT_FILE_MAX_BYTES}` : null);
    if (why) return { problem: `${file} ${why}` };
    const text = readCapped(fd);
    return text === null ? { problem: `${file} is over ${ROOT_FILE_MAX_BYTES} bytes` } : { text, at: openedPath(fd) };
  } finally {
    closeSync(fd);
  }
}

/** Run `fn` inside `dir` (its names relative to it), once `dir` is exactly where the kernel says this process is, and `owner`'s. */
function inDir<T>(dir: string, owner: number, fn: () => T): T {
  const back = process.cwd();
  process.chdir(dir);
  try {
    // getcwd: the directory this process is in now, wherever a link pointed. Not `dir`: a link on the way, refused.
    const here = process.cwd();
    if (here !== dir) throw new Error(`${dir} leads to ${here}: a link on the way, so nothing is read or written there`);
    const st = statSync('.');
    if (st.uid !== owner) throw new Error(`${dir} belongs to uid ${st.uid}, not ${owner}`);
    return fn();
  } finally {
    process.chdir(back);
  }
}

/**
 * Read `name` in `dir` (a directory of `dirOwner`'s, given as its real path) without following a link: a regular file
 * with one name, owned by one of `owners`. Throws otherwise.
 */
export function readInOwnedDir(dir: string, name: string, dirOwner: number, owners: readonly number[]): string {
  return inDir(dir, dirOwner, () => {
    const fd = openSync(name, OPEN_READ);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || !owners.includes(st.uid)) throw new Error(`${dir}/${name} isn't a regular file with one name owned by uid ${owners.join(' or ')}`);
      // From fstat, before a byte is read: nothing this long is read, let alone parsed.
      if (st.size > ROOT_FILE_MAX_BYTES) throw new Error(`${dir}/${name} is ${st.size} bytes, over ${ROOT_FILE_MAX_BYTES}, so it isn't read: a policy.yaml is far smaller`);
      const text = readCapped(fd);
      if (text === null) throw new Error(`${dir}/${name} is over ${ROOT_FILE_MAX_BYTES} bytes, so it isn't read: a policy.yaml is far smaller`);
      return text;
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * Replace `name` in `dir` (a directory of `dirOwner`'s, given as its real path) with `text`, owned by uid:gid, `mode`:
 * a new file this process creates (O_EXCL), then renamed over the old name. Throws when the name it renamed isn't, a
 * moment later, the file it wrote (the directory's owner swapped it): what is there then is the owner's, and refused.
 */
export function replaceInOwnedDir(o: { dir: string; name: string; text: string; dirOwner: number; uid: number; gid: number; mode: number }): void {
  inDir(o.dir, o.dirOwner, () => {
    const tmp = `.${o.name}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let ino: number;
    try {
      writeSync(fd, o.text);
      fchownSync(fd, o.uid, o.gid);
      fchmodSync(fd, o.mode);
      fsyncSync(fd);
      ino = fstatSync(fd).ino;
    } catch (e) {
      closeSync(fd);
      unlinkSync(tmp);
      throw e;
    }
    closeSync(fd);
    renameSync(tmp, o.name);
    const now = lstatSync(o.name);
    if (now.ino !== ino) throw new Error(`${o.dir}/${o.name} was replaced while it was written; what is there now isn't root's`);
  });
}

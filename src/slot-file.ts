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
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, linkSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export interface SlotWrite {
  /** The file's mode, as writeFileSync takes it: the umask applies (default 0o666). */
  mode?: number;
  /** Give the file exactly `mode`, past the umask. */
  exactMode?: boolean;
  /** false: create the file only when there is none, as a lock is taken (a hard link: EEXIST when one exists). Default: replace it. */
  replace?: boolean;
}

/** Write `file` whole: a reader sees the old content or the new, never part of it. On failure nothing is left behind. */
export function writeSlotFile(file: string, data: string, o: SlotWrite = {}): void {
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

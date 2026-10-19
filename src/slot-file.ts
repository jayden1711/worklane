// The one way to write a file in the shared slot directory (#661). Removing an instance (#555) takes group write
// off its files there, so any of them can be 0444 to everyone else: an in-place write gets EACCES (#616). Replacing
// a file needs only the directory's write permission. So writeSlotFile puts the content in a temp file of its own,
// with a random name and created exclusively (O_EXCL), so it never opens a file someone else left (a crashed
// writer's, or one under a reused pid), and then renames it over the file, or hard-links it to a file that must not
// exist yet (a lock). test/slot-dir-writes.test.ts reports any other write in a module that touches the slot dir.
import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, renameSync, rmSync, writeFileSync } from 'node:fs';

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
  const tmp = tempWith(file, data, o.mode ?? 0o666);
  let placed = false;
  try {
    if (o.exactMode && o.mode !== undefined) chmodSync(tmp, o.mode);
    if (o.replace === false) linkSync(tmp, file);
    else {
      renameSync(tmp, file);
      placed = true;
    }
  } finally {
    if (!placed) rmSync(tmp, { force: true });
  }
}

/** A new temp file beside `file`, holding `data`. Never an existing one: a name that is taken is skipped, not opened. */
function tempWith(file: string, data: string, mode: number): string {
  for (let attempt = 0; ; attempt++) {
    const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, data, { flag: 'wx', mode });
      return tmp;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 2) continue; // someone else's: not ours to touch
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(tmp, { force: true }); // created, then the write failed
      throw e;
    }
  }
}

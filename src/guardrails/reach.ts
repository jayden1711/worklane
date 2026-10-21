// Where a path really leads. WHY (#972): protected-path checks decide on the file a write really reaches, resolved the
// way the file system will resolve it when the tool acts. A path that can't be resolved is null, and a caller refuses
// it rather than judge it by its name alone.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PATH_MAX } from './access.js';
import { ownFolderLink } from '../os/process-links.js';

/** The most links one path may pass through (Linux's own limit); past that, where it leads can't be told. */
export const MAX_LINKS = 40;
/** The most path parts one tool call's paths take to resolve, all together; past that, every later one can't be told. */
export const STEP_LIMIT = 50_000;
/**
 * The longest one tool call's paths take to resolve, on a monotonic clock: well under the agent hook's timeout
 * (src/install.ts), since a hook that times out doesn't block the call.
 */
export const REACH_MS = 5_000;

/** A path's parts, last first (a stack: the next part to take is at the end). */
const partsOf = (p: string) =>
  p
    .split(sep === '\\' ? /[\\/]+/ : /\/+/)
    .filter(Boolean)
    .reverse();

/**
 * A part that isn't there, or that is past what one system call can name (PATH_MAX): the rest stays as written. A
 * program that walks a path one part at a time (`mkdir -p`) can go deeper than that, and the guard has judged such a
 * path by its text since before #972; refusing it would refuse a long path main lets through.
 */
const missing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
};

/** One tool call's resolver: every path it resolves shares one budget (STEP_LIMIT parts, REACH_MS). */
export class Reach {
  private steps = 0;
  private readonly deadline: number;

  constructor(private readonly now: () => number = () => performance.now(), ms = REACH_MS) {
    this.deadline = this.now() + ms;
  }

  /** Whether the call's budget is spent, counting one more step. */
  private spent(): boolean {
    return ++this.steps > STEP_LIMIT || this.now() > this.deadline;
  }

  /**
   * The file absolute `written` reaches, its parts taken in order as the file system takes them (`.` and `..` are not
   * tidied away first), and the existing part spelled as the file system spells it. Parts that don't exist yet stay as
   * written, as a write would create them. Null when that can't be told: more than MAX_LINKS links, a link whose
   * meaning depends on the process reading it (src/os/process-links.ts), a part that can't be read, or the call's
   * budget spent.
   */
  of(written: string): string | null {
    if (!isAbsolute(written)) return null;
    // `head`: the existing part reached so far, with no link left in it; `tail`: the parts after it that aren't there.
    let head = parse(written).root;
    const tail: string[] = [];
    const todo = partsOf(written.slice(head.length));
    let links = 0;
    while (todo.length) {
      const part = todo.pop()!;
      if (part === '.') continue;
      // Past a part that isn't there, nothing is looked up (no link can be there): text only, charged to the clock.
      if (tail.length) {
        if (this.now() > this.deadline) return null;
        if (part === '..') tail.pop();
        else tail.push(part);
        continue;
      }
      if (this.spent()) return null;
      if (part === '..') {
        head = dirname(head);
        continue;
      }
      const next = head.endsWith(sep) ? head + part : head + sep + part;
      let link = false;
      try {
        link = lstatSync(next).isSymbolicLink();
      } catch (e) {
        if (!missing(e)) return null;
        // Not there: a write creates it as written (or fails).
        tail.push(part);
        continue;
      }
      if (!link) {
        head = next;
        continue;
      }
      if (++links > MAX_LINKS || ownFolderLink(next)) return null;
      let to: string;
      try {
        to = readlinkSync(next);
      } catch {
        return null;
      }
      if (to.length > PATH_MAX) return null;
      // An absolute one starts again from its root; a relative one from the folder it is in (head).
      if (isAbsolute(to)) head = parse(to).root;
      todo.push(...partsOf(isAbsolute(to) ? to.slice(parse(to).root.length) : to));
    }
    // The existing part as the file system spells it (its case, on a system that ignores case), then the rest.
    try {
      const real = realpathSync.native(head);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      return null;
    }
  }
}

/** `p` as a call wrote it, made absolute against `base` without tidying its `.` and `..` parts. */
export function asWritten(base: string, p: string): string {
  if (isAbsolute(p)) return p;
  return base.endsWith(sep) || base.endsWith('/') ? base + p : base + sep + p;
}

/** Whether `p` is an existing file with more than one hard link (a write to it changes it under every name it has). */
export function hardLinked(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

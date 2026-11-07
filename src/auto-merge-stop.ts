// WHY (#982): a stop must always stop (principle 2: turning off always works). Every reader of the auto-merge stop
// file goes through here, so a stop file that is there holds whatever it holds: an empty, blank, missing or non-string
// reason, bytes that can't be read or parsed, or a path that can't be checked. Its reason is shown when it gives one.
//
// INVARIANT: readStopFile's reason is never empty. test/auto-merge-stop.test.ts checks that no other file in src/
// names the stop file.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The auto-merge stop file in an instance's state dir: written by the engine or the operator, cleared by an admin. */
export const stopFilePath = (stateDir: string) => join(stateDir, 'auto-merge-stopped.json');

/** Shown for a stop file whose reason is empty, blank, missing or not a string. */
export const STOP_NO_REASON = 'stopped (the stop file gives no reason)';
/** Shown for a stop file that can't be read, isn't JSON or isn't a JSON object. */
export const STOP_UNREADABLE = 'the stop file is unreadable';

export type StopFile = {
  /** Why auto-merge is stopped, never empty. */
  reason: string;
  by: string | null;
  /** The file's bytes ('' when they can't be read). */
  raw: string;
  /** false when the file couldn't be read or parsed as a JSON object: `reason` is STOP_UNREADABLE. */
  readable: boolean;
};

/**
 * Whether something is at the stop file's path. A dangling symlink counts, and so does a path whose check fails for
 * any reason but "not there" (fail closed).
 */
export function stopFilePresent(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** A stop file's reason and `by`, from its bytes. */
export function parseStopFile(raw: string): Omit<StopFile, 'raw'> {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { reason: STOP_UNREADABLE, by: null, readable: false };
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return { reason: STOP_UNREADABLE, by: null, readable: false };
  const { reason, by } = j as { reason?: unknown; by?: unknown };
  return { reason: typeof reason === 'string' && reason.trim() ? reason : STOP_NO_REASON, by: typeof by === 'string' ? by : null, readable: true };
}

/** The stop file at `file`, or null when nothing is there. */
export function readStopFile(file: string): StopFile | null {
  if (!stopFilePresent(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { reason: STOP_UNREADABLE, by: null, raw: '', readable: false };
  }
  return { raw, ...parseStopFile(raw) };
}

// The engine updater's drain (scripts/machine/<cli>-update.cjs): when an update has waited drain_after_minutes for a
// machine that is never quiet, the updater writes a root-owned flag, and while it stands no new test run, full-run
// lock or agent session starts on the machine. What is already running finishes; nothing is stopped. The updater
// installs once nothing is in flight and removes the flag on every way its run ends.
//
// The flag carries an expiry ("until"), which the updater pushes forward on each run while it drains. A flag past its
// expiry, unreadable, or claiming more than DRAIN_TTL_MAX_MS ahead is ignored: an updater that crashed or was turned
// off never leaves the machine drained.
//
// Test runs: it is the `drain` source of the one start gate every test run passes (src/testrun/gate.ts, added by the
// coordinator in src/service.ts), so a run asked for while it stands is held, not started. A run that passed the gate
// before the drain began and is still queued for its slot is stopped at tryTestSlot (src/testrun/slots.ts), which reads
// it under the slot directory's lock: the updater's flag write and a slot take can't cross there. Agents and the
// full-run lock read it at tryAgentSlot and fullRunLock (src/slots.ts).
import { slotsDir, updateDrainPath } from './os/index.js';
import { readSlotFile, type SlotPathLike } from './slot-file.js';

export interface UpdateDrain {
  /** When the drain began. */
  since: string;
  /** When it lapses unless the updater writes it again. */
  until: string;
  /** The engine commit it waits to install, when known. */
  to: string | null;
}

/** The longest a flag is honored past now. The updater writes at most 3 hours ahead (an install's whole span). */
export const DRAIN_TTL_MAX_MS = 4 * 3600_000;

/** The drain in force now, or null: none, unreadable, expired, or with an expiry too far ahead to be the updater's. */
export function updateDrain(dir: SlotPathLike = slotsDir(), now = Date.now()): UpdateDrain | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readSlotFile(updateDrainPath(dir))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!j || typeof j.since !== 'string' || typeof j.until !== 'string') return null;
  const until = Date.parse(j.until);
  // INVARIANT: no expiry, no drain. A flag nobody refreshes stops counting by itself.
  if (!Number.isFinite(until) || until <= now || until - now > DRAIN_TTL_MAX_MS) return null;
  return { since: j.since, until: j.until, to: typeof j.to === 'string' ? j.to : null };
}

/** What a gate says when the drain holds it. */
export function drainHoldLine(d: UpdateDrain): string {
  return `draining for an engine update since ${d.since}: new test runs and agents wait until it is installed`;
}

/** The start gate's `drain` source (src/testrun/gate.ts): why no test run may start now, or null. Cheap, never throws. */
export function drainRefusal(): string | null {
  const d = updateDrain();
  return d ? drainHoldLine(d) : null;
}

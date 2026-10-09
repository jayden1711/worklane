// Machine-wide slots, shared by every agent harness on the machine through
// a tiny file protocol (docs/slots.md):
//   <config>                 {"max_agents": N, "adaptive": {...}}  the machine cap, set once per box
//                            (/etc/<cli>/slots.json with the system slot dir, else <dir>/config.json)
//   <dir>/cap.json           {"cap": N}  the adaptive cap, when the cap evaluator runs
//   <dir>/slots.lock         held briefly while counting and taking a slot
//   <dir>/agent-<i>.lock     one per running agent; the count, not the index, is capped
//   <dir>/full-run.lock      at most one full test run on the machine
// A lock file holds {pid, owner, acquiredAt}; a dead pid means the slot is free.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, tryLock, type Lock, type LockInfo } from './locks.js';
import { pidAlive, slotsConfigPath, slotsDir } from './os/index.js';

export const DEFAULT_MAX_AGENTS = 2;

export function machineCap(dir = slotsDir()): number {
  try {
    const n = (JSON.parse(readFileSync(slotsConfigPath(dir), 'utf8')) as { max_agents?: unknown }).max_agents;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_AGENTS;
  } catch {
    return DEFAULT_MAX_AGENTS;
  }
}

/**
 * The cap in force now: the adaptive cap (cap.json, written by the cap
 * evaluator) when there is one, else the configured max_agents.
 */
export function currentCap(dir = slotsDir()): number {
  try {
    const n = (JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8')) as { cap?: unknown }).cap;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return n;
  } catch {
    // no adaptive cap: the configured one applies
  }
  return machineCap(dir);
}

/** Slot files may be numbered past the cap: lowering it must never strand an agent that is still running. */
const SLOT_INDEX_LIMIT = 64;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Take an agent slot if fewer than the cap are running, machine-wide, across
 * every instance and harness. Counting and taking happen under one directory
 * lock, so two processes can't both see room for the last slot.
 */
export function tryAgentSlot(owner: string, dir = slotsDir()): Lock | null {
  let guard: Lock | null = null;
  for (let i = 0; i < 200 && !guard; i++) {
    const r = tryLock(join(dir, 'slots.lock'), owner);
    if ('lock' in r) guard = r.lock;
    else pause(10);
  }
  if (!guard) return null; // busy for 2s: treat as full and try again next tick
  try {
    if (slotStatus(dir).agents.length >= currentCap(dir)) return null;
    for (let i = 0; i < SLOT_INDEX_LIMIT; i++) {
      const r = tryLock(join(dir, `agent-${i}.lock`), owner);
      if ('lock' in r) return r.lock;
    }
    return null;
  } finally {
    guard.release();
  }
}

export function fullRunLock(owner: string, waitMs: number, dir = slotsDir()) {
  return acquireLock(join(dir, 'full-run.lock'), owner, waitMs, 1000);
}

export interface SlotStatus {
  cap: number;
  agents: (LockInfo & { slot: string })[];
  fullRun: LockInfo | null;
}

/** Live holders only; stale files (dead pids) don't count. */
export function slotStatus(dir = slotsDir()): SlotStatus {
  const read = (f: string): LockInfo | null => {
    try {
      const info = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LockInfo;
      return pidAlive(info.pid) ? info : null;
    } catch {
      return null;
    }
  };
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // no slots dir yet: nothing held
  }
  const agents = files
    .filter((f) => /^agent-\d+\.lock$/.test(f))
    .map((f) => ({ f, info: read(f) }))
    .filter((x): x is { f: string; info: LockInfo } => !!x.info)
    .map(({ f, info }) => ({ ...info, slot: f.replace('.lock', '') }));
  return { cap: currentCap(dir), agents, fullRun: files.includes('full-run.lock') ? read('full-run.lock') : null };
}

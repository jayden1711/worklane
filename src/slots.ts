// Machine-wide slots, shared by every agent harness on the machine through
// a tiny file protocol (docs/slots.md):
//   <dir>/config.json        {"max_agents": N}   the machine cap, set once per box
//   <dir>/agent-<i>.lock     one per running agent, i < max_agents
//   <dir>/full-run.lock      at most one full test run on the machine
// A lock file holds {pid, owner, acquiredAt}; a dead pid means the slot is free.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, tryLock, type Lock, type LockInfo } from './locks.js';
import { pidAlive, slotsDir } from './os/index.js';

export const DEFAULT_MAX_AGENTS = 2;

export function machineCap(dir = slotsDir()): number {
  try {
    const n = (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { max_agents?: unknown }).max_agents;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_AGENTS;
  } catch {
    return DEFAULT_MAX_AGENTS;
  }
}

/** Take a free agent slot, or null if the machine is at its cap. */
export function tryAgentSlot(owner: string, dir = slotsDir()): Lock | null {
  const cap = machineCap(dir);
  for (let i = 0; i < cap; i++) {
    const r = tryLock(join(dir, `agent-${i}.lock`), owner);
    if ('lock' in r) return r.lock;
  }
  return null;
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
  return { cap: machineCap(dir), agents, fullRun: files.includes('full-run.lock') ? read('full-run.lock') : null };
}

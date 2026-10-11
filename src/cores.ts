// The core budget: each running task's fair share of the machine's CPU cores, so parallel test runs never
// oversubscribe it. A project writes `{cores}` where its test command takes a worker count (an env value in
// tests.yaml such as a pytest-xdist or jest worker variable, or an argument in a command); every command and
// agent session gets it filled in with the share at the moment it starts. Agents counted are every live
// agent slot on the machine (all instances and harnesses), so the share falls as agents start and rises as
// they stop.
import { slotStatus } from './slots.js';
import { cpuCount } from './os/index.js';

export const CORES_PLACEHOLDER = '{cores}';

export interface CoreBudget {
  /** Cores kept back for the machine itself (the coordinator, the dashboard, the OS). */
  reserve: number;
  /** Never fewer than this per task. */
  min: number;
  /** Never more than this per task (absent: no cap beyond the machine). */
  max?: number | undefined;
}

export const DEFAULT_CORE_BUDGET: CoreBudget = { reserve: 0, min: 1 };

/**
 * A task's share: the cores left after the reserve, split evenly over the agents running (at least one, the
 * task itself), rounded down so the shares together never exceed the machine; then held within min..max.
 */
export function coreShare(o: { cores: number; running: number; budget?: CoreBudget }): number {
  const b = o.budget ?? DEFAULT_CORE_BUDGET;
  const usable = Math.max(1, Math.floor(o.cores) - Math.max(0, Math.floor(b.reserve)));
  const share = Math.floor(usable / Math.max(1, Math.floor(o.running)));
  const capped = b.max !== undefined ? Math.min(share, b.max) : share;
  return Math.max(Math.max(1, b.min), capped);
}

/** The share right now on this machine: its cores, over the live agent slots. */
export function currentCoreShare(budget?: CoreBudget, slotsDir?: string): number {
  const running = slotStatus(slotsDir).agents.length;
  return coreShare({ cores: cpuCount(), running, ...(budget ? { budget } : {}) });
}

/** A command with `{cores}` filled in. */
export function withCores(command: string, share: number): string {
  return command.split(CORES_PLACEHOLDER).join(String(share));
}

/** A project's env (tests.yaml `env`) with `{cores}` filled in. */
export function envWithCores(env: Record<string, string> | undefined, share: number): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, withCores(v, share)]));
}

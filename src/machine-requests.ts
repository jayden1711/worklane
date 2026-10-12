// Machine changes asked for from the dashboard, run by the coordinator.
//
// The dashboard runs hardened (its unit sets NoNewPrivileges), so it can't use sudo, and it doesn't try: a
// machine change from Settings, or a setup-console root step, is recorded here as a `machine.requested` event in
// the instance's log, after the dashboard's own checks (the owner's role, CSRF, the audit) and the helper's
// allowlist. The coordinator, whose unit allows sudo, takes each request on its next tick
// (src/coordinator/machine-requests.ts), checks it again against the same allowlist (so a request written
// some other way can't widen what runs), runs the machine helper, and records `machine.finished`. The
// dashboard shows each request as pending, running, then done or failed.
//
// Which coordinator acts: the one whose log holds the request, that is, the instance whose dashboard the
// owner used. Every coordinator user is in the helper's sudoers (machine-helper.sh lists them all), and the
// settings are machine-wide, so any one will do. A request lives in one log only, so no other coordinator sees
// it, and within that log `machine.started` is claimed in a write transaction, so it runs at most once.
import { randomBytes } from 'node:crypto';
import type { EventLog } from './events/log.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { checkRootStep } from './console/root-steps.js';

export const MACHINE_EVENTS = ['machine.requested', 'machine.started', 'machine.finished'] as const;

export type MachineRequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'refused' | 'interrupted';

export interface MachineRequest {
  id: string;
  /** The helper's arguments: set-slots <n>, set-updates on|off. */
  args: string[];
  by: string;
  via: 'settings' | 'ask';
  ask: string | null;
  at: string;
  status: MachineRequestStatus;
  /** The helper's output, or why it failed or was refused. */
  detail: string;
  finishedAt: string | null;
}

export class MachineRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(message);
  }
}

/** The helper arguments a Settings change maps to, or why it can't be one. */
export function settingArgs(what: unknown, value: unknown): string[] | { error: string } {
  if (what === 'slots') return ['set-slots', String(value)];
  if (what === 'updates') return typeof value === 'boolean' ? ['set-updates', value ? 'on' : 'off'] : { error: 'updates is on (true) or off (false)' };
  return { error: 'what is slots or updates' };
}

/** Why these helper arguments may not run (not on the allowlist); null when they may. */
export function machineRefusal(args: readonly string[]): string | null {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) return 'not a machine helper command';
  const c = checkRootStep(args[0]!, args.slice(1));
  return c.allowed ? null : c.why;
}

/** The requests in these events, oldest first, each with its status. */
export function machineRequests(events: readonly StoredEvent[]): MachineRequest[] {
  const byId = new Map<string, MachineRequest>();
  for (const e of events) {
    if (e.type === 'machine.requested') {
      const p = e.payload as EventPayload<'machine.requested'>;
      if (!byId.has(p.id)) byId.set(p.id, { id: p.id, args: p.args, by: p.by, via: p.via, ask: p.ask, at: e.ts, status: 'pending', detail: '', finishedAt: null });
    } else if (e.type === 'machine.started') {
      const r = byId.get((e.payload as EventPayload<'machine.started'>).id);
      if (r && r.status === 'pending') r.status = 'running';
    } else if (e.type === 'machine.finished') {
      const p = e.payload as EventPayload<'machine.finished'>;
      const r = byId.get(p.id);
      if (r && (r.status === 'pending' || r.status === 'running')) {
        r.status = p.outcome;
        r.detail = p.detail;
        r.finishedAt = e.ts;
      }
    }
  }
  return [...byId.values()];
}

const open = (r: MachineRequest) => r.status === 'pending' || r.status === 'running';

/**
 * Record a machine change for the coordinator to run. The caller has checked who may (the owner); this checks
 * the helper's allowlist, and that a root-step ask doesn't already have one pending. Never runs anything.
 */
export function requestMachineChange(log: EventLog, r: { args: string[]; by: string; via: 'settings' | 'ask'; ask?: string | null }): MachineRequest {
  const why = machineRefusal(r.args);
  if (why) throw new MachineRequestError(why, 400);
  const id = `mr-${randomBytes(6).toString('hex')}`;
  log.db.exec('BEGIN IMMEDIATE');
  try {
    if (r.ask && machineRequests(log.read(0, [...MACHINE_EVENTS])).some((x) => x.ask === r.ask && open(x))) throw new MachineRequestError(`ask ${r.ask} already has a machine change waiting for the coordinator`, 409);
    log.append('machine.requested', { id, args: [...r.args], by: r.by, via: r.via, ask: r.ask ?? null }, r.by, 'human');
    log.db.exec('COMMIT');
  } catch (e) {
    log.db.exec('ROLLBACK');
    throw e;
  }
  return machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.id === id)!;
}

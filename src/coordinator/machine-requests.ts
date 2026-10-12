// The coordinator's side of machine changes (src/machine-requests.ts): each request the dashboard recorded is
// claimed once, checked again against the machine helper's allowlist, run through the helper with sudo -n (the
// coordinator's unit allows it; the dashboard's doesn't), and its outcome recorded. A request a coordinator
// claimed but never finished (it stopped mid-run) is marked interrupted, never run again.
import type { EventLog } from '../events/log.js';
import { checkRootStep } from '../console/root-steps.js';
import { recordAnswer } from '../console/asks.js';
import type { Exec } from '../machine.js';
import { MACHINE_EVENTS, machineRefusal, machineRequests, type MachineRequest } from '../machine-requests.js';

/** A claim older than this with no outcome is from a coordinator that stopped mid-run (the helper times out at 30 s). */
export const STALE_CLAIM_MS = 5 * 60_000;

export interface MachineRequestDeps {
  log: EventLog;
  instance: string;
  /** How the helper is run (sudo -n); machine.ts's default when unset. */
  exec?: Exec;
  now?: () => number;
}

/** Claim a pending request: append machine.started inside a write transaction, so of two takers only one wins. */
function claim(log: EventLog, id: string, instance: string): boolean {
  log.db.exec('BEGIN IMMEDIATE');
  try {
    const r = machineRequests(log.read(0, [...MACHINE_EVENTS])).find((x) => x.id === id);
    if (!r || r.status !== 'pending') {
      log.db.exec('ROLLBACK');
      return false;
    }
    log.append('machine.started', { id, instance }, instance, 'coordinator');
    log.db.exec('COMMIT');
    return true;
  } catch (e) {
    log.db.exec('ROLLBACK');
    throw e;
  }
}

/** A root-step ask behind a request gets the outcome as its answer (once; a later answer would be refused anyway). */
function answerAsk(log: EventLog, r: MachineRequest, answer: 'ran' | 'failed', detail: string) {
  if (!r.ask) return;
  try {
    recordAnswer(log, r.ask, { by: r.by, role: 'owner', answer, detail });
  } catch {
    // the ask was answered or withdrawn meanwhile: the request's own outcome is the record
  }
}

/** Run every pending machine request in this instance's log, once each. Returns how many ran. */
export function runMachineRequests(d: MachineRequestDeps): number {
  const now = d.now ?? Date.now;
  let ran = 0;
  for (const r of machineRequests(d.log.read(0, [...MACHINE_EVENTS]))) {
    if (r.status === 'running') {
      const started = d.log.read(0, ['machine.started']).find((e) => (e.payload as { id: string }).id === r.id);
      if (started && now() - Date.parse(started.ts) > STALE_CLAIM_MS) d.log.append('machine.finished', { id: r.id, outcome: 'interrupted', detail: 'the coordinator stopped before it finished; not run again (see the machine changes log for whether it applied)' }, d.instance, 'coordinator');
      continue;
    }
    if (r.status !== 'pending' || !claim(d.log, r.id, d.instance)) continue;
    // Checked again here, whatever the dashboard checked: a request written any other way can't widen what runs.
    const why = machineRefusal(r.args);
    if (why) {
      d.log.append('machine.finished', { id: r.id, outcome: 'refused', detail: why.slice(0, 1000) }, d.instance, 'coordinator');
      continue;
    }
    const c = checkRootStep(r.args[0]!, r.args.slice(1));
    if (!c.allowed) continue; // unreachable: machineRefusal checked the same
    const out = c.rule.run(r.args.slice(1), d.exec);
    const detail = (out.ok ? out.output : out.error).slice(0, 1000);
    d.log.append('machine.finished', { id: r.id, outcome: out.ok ? 'done' : 'failed', detail }, d.instance, 'coordinator');
    answerAsk(d.log, r, out.ok ? 'ran' : 'failed', detail);
    ran++;
  }
  return ran;
}

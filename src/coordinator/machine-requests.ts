// The coordinator's side of machine changes (src/machine-requests.ts): each request the dashboard recorded is
// claimed once, checked again against the machine helper's allowlist and the machine owners (the request names who
// asked; src/machine-owners.ts), run through the helper with sudo -n (the
// coordinator's unit allows it; the dashboard's doesn't), and its outcome recorded. A request a coordinator
// claimed but never finished (it stopped mid-run) is marked interrupted, never run again.
import type { EventLog } from '../events/log.js';
import { checkRootStep } from '../console/root-steps.js';
import { PLUGIN_STEPS } from '../plugins/steps.js';
import { recordAnswer } from '../console/asks.js';
import type { Exec } from '../machine.js';
import { MACHINE_EVENTS, machineRefusal, machineRequests, type MachineRequest } from '../machine-requests.js';
import { isMachineOwner, MACHINE_OWNERS_FILE, machineOwners, ownersText } from '../machine-owners.js';
import { runAddProject, runningAddProjects, type SpawnHelper } from './add-project.js';

/** A claim older than this with no outcome is from a coordinator that stopped mid-run (the helper times out at 30 s). */
export const STALE_CLAIM_MS = 5 * 60_000;

export interface MachineRequestDeps {
  log: EventLog;
  instance: string;
  /** How the helper is run (sudo -n); machine.ts's default when unset. */
  exec?: Exec;
  now?: () => number;
  /** The machine owners file; the system's when unset (tests). */
  ownersFile?: string;
  /** How a streamed command (add-project) starts; sudo -n by default (src/coordinator/add-project.ts). */
  spawn?: SpawnHelper;
}

/**
 * Why the person a request names may not change the machine; null when they may. Checked here as well as by the
 * dashboard: a request written to the log some other way, naming someone who isn't a machine owner, never runs.
 * One marked as the break-glass's is allowed, as the dashboard allows it.
 */
export function requesterRefusal(r: Pick<MachineRequest, 'by' | 'breakGlass'>, file = MACHINE_OWNERS_FILE): string | null {
  if (r.breakGlass) return null;
  return isMachineOwner(r.by, file) ? null : `@${r.by} isn't one of the machine's owners (machine owners: ${ownersText(machineOwners(file))}), so it wasn't run`;
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

/** A policy change root's helper made: settings.changed, from its last line (`<cli> policy set` prints {key, from, to}). */
function policyChanged(d: MachineRequestDeps, r: MachineRequest, output: string) {
  try {
    const c = JSON.parse(output.trim().split('\n').pop() ?? '') as { key?: unknown; from?: unknown; to?: unknown };
    if (typeof c.key !== 'string') return;
    const key = c.key.startsWith('settings.') ? c.key.slice('settings.'.length) : `policy.${c.key}`;
    d.log.append('settings.changed', { key, from: c.from ?? null, to: c.to ?? null, by: r.by, at: new Date((d.now ?? Date.now)()).toISOString() }, r.by, 'human');
  } catch {
    // no change line: machine.finished holds the helper's output
  }
}

/** Run every pending machine request in this instance's log, once each. Returns how many ran. */
export function runMachineRequests(d: MachineRequestDeps): number {
  const now = d.now ?? Date.now;
  let ran = 0;
  for (const r of machineRequests(d.log.read(0, [...MACHINE_EVENTS]))) {
    if (r.status === 'running') {
      const started = d.log.read(0, ['machine.started']).find((e) => (e.payload as { id: string }).id === r.id);
      if (runningAddProjects.has(r.id)) continue; // this process is running it now
      if (started && now() - Date.parse(started.ts) > STALE_CLAIM_MS) d.log.append('machine.finished', { id: r.id, outcome: 'interrupted', detail: 'the coordinator stopped before it finished; not run again (see the machine changes log for whether it applied)' }, d.instance, 'coordinator');
      continue;
    }
    if (r.status !== 'pending') continue;
    // One add-project at a time: a second waits, pending, until the first is over.
    if (r.args[0] === 'add-project' && runningAddProjects.size) continue;
    if (!claim(d.log, r.id, d.instance)) continue;
    // Checked again here, whatever the dashboard checked: a request written any other way can't widen what runs.
    // Q13: a plugin step (via the Plugins page) is the instance owner's to ask for, and the dashboard checked that role;
    // it is for this instance alone and approves nothing. Every other machine change still needs a machine owner.
    // A change to this instance's root policy.yaml (#726) is its owner's to ask for too, and the helper refuses loosening.
    const instanceStep = (r.via === 'plugins' && (PLUGIN_STEPS as readonly string[]).includes(r.args[0] ?? '')) || (r.via === 'policy' && r.args[0] === 'set-policy');
    const why = (instanceStep ? null : requesterRefusal(r, d.ownersFile)) ?? machineRefusal(r.args);
    if (why) {
      d.log.append('machine.finished', { id: r.id, outcome: 'refused', detail: why.slice(0, 1000) }, d.instance, 'coordinator');
      continue;
    }
    const c = checkRootStep(r.args[0]!, r.args.slice(1));
    if (!c.allowed) continue; // unreachable: machineRefusal checked the same
    if (c.rule.streams) {
      // Minutes long, with asks on the way: run alongside the ticks, each step relayed as it comes.
      const run = runAddProject({ log: d.log, instance: d.instance, ...(d.spawn ? { spawn: d.spawn } : {}) }, r).finally(() => runningAddProjects.delete(r.id));
      runningAddProjects.set(r.id, run);
      ran++;
      continue;
    }
    const out = c.rule.run(r.args.slice(1), d.exec);
    const detail = (out.ok ? out.output : out.error).slice(0, 1000);
    d.log.append('machine.finished', { id: r.id, outcome: out.ok ? 'done' : 'failed', detail }, d.instance, 'coordinator');
    if (out.ok && r.args[0] === 'set-policy') policyChanged(d, r, out.output);
    answerAsk(d.log, r, out.ok ? 'ran' : 'failed', detail);
    ran++;
  }
  return ran;
}

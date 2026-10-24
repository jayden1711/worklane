// The instance's automations.yaml: read with the checks intake.yaml gets (only its owner may write or read it), and
// written only through a plan the person reviewed: plan* returns exactly what would change and writes nothing;
// apply* plans again against the file as it is now, refuses if it changed since the review (its digest), writes it
// atomically (0600) and records automation.changed. Who may do what is here too, so the dashboard and the tests share
// one rule: owners create, edit, delete and resume; writers may pause and run now; viewers nothing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Role } from '../dashboard-auth.js';
import type { EventLog } from '../events/log.js';
import { replaceFileAtomically } from '../os/index.js';
import { describeCron } from './cron.js';
import { makeSecret, removeSecret, unbind } from './secrets.js';
import { Automation, AutomationsFile, type Trigger } from './schema.js';

export const ACTIONS = ['create', 'edit', 'delete', 'pause', 'resume', 'run', 'rotate', 'unbind'] as const;
export type AutomationAction = (typeof ACTIONS)[number];

/** INVARIANT: the one rule for who may do what. Pause and run now are the writers' too; the rest (rotating a webhook's secret and unbinding its node included) the owners' only. */
export function mayDo(action: AutomationAction, role: Role | null | undefined): boolean {
  if (role === 'owner') return true;
  if (role === 'writer') return action === 'pause' || action === 'run';
  return false;
}

export class AutomationsError extends Error {}

export interface Loaded {
  file: AutomationsFile;
  /** The file's text as read ('' when absent): its digest pins a review to it. */
  text: string;
  error: string | null;
}

const EMPTY: AutomationsFile = { version: 1, automations: [] };
export const digestOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Read automations.yaml. Absent: none. Unsafe permissions or an invalid file: none run, and `error` says why. The
 * error names the file by its name only, never its path under the instance home: the dashboard shows it (#882).
 */
export function loadAutomations(path: string): Loaded {
  if (!existsSync(path)) return { file: EMPTY, text: '', error: null };
  const name = basename(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null) {
    const st = statSync(path);
    if (st.mode & 0o077) return { file: EMPTY, text: '', error: `${name} is readable or writable by its group or others; it decides what runs and spends, so only its owner may (chmod 600)` };
    if (st.uid !== uid && st.uid !== 0) return { file: EMPTY, text: '', error: `${name} belongs to another user; it must be this service's own file` };
  }
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = parse(text) ?? { version: 1 };
  } catch (e) {
    // The YAML parser's first line says where (line and column), never the file's path.
    return { file: EMPTY, text, error: `${name} is not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const r = AutomationsFile.safeParse(raw);
  if (!r.success) return { file: EMPTY, text, error: `${name} is invalid: ${r.error.issues.map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`).join('; ')}` };
  return { file: r.data, text, error: null };
}

/** What a person asks for: an action, the automation's id, and for create/edit the definition. */
export interface ChangeRequest {
  action: AutomationAction;
  id?: string;
  automation?: unknown;
}

export interface Plan {
  action: AutomationAction;
  id: string;
  /** Every changed field, as `- path: old` / `+ path: new` lines; a run now changes no field. */
  changes: string[];
  /** What it means, in plain words. */
  summary: string[];
  /** The file's digest this plan was made against. */
  digest: string;
  next: AutomationsFile;
}

function flatten(v: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else out.set(prefix, JSON.stringify(v));
  return out;
}

/** The changed fields between two versions of one automation (null: it doesn't exist on that side). */
export function fieldDiff(before: Automation | null, after: Automation | null): string[] {
  const a = before ? flatten(before) : new Map<string, string>();
  const b = after ? flatten(after) : new Map<string, string>();
  const out: string[] = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (a.get(k) === b.get(k)) continue;
    if (a.has(k)) out.push(`- ${k}: ${a.get(k)}`);
    if (b.has(k)) out.push(`+ ${k}: ${b.get(k)}`);
  }
  return out;
}

/** A trigger in plain words. */
export function describeTrigger(t: Trigger): string {
  if (t.kind === 'schedule') return `${describeCron(t.cron)}, this machine's time (${t.cron})`;
  if (t.kind === 'discord') return `"run ${t.command}" to the Discord bot, from a writer or owner`;
  if (t.kind === 'webhook') return 'a signed POST to the hooks gateway, from its bound tailnet device; each run waits for an owner\'s approval';
  const what = { 'issue.opened': 'an issue is opened', 'issue.labeled': `an issue gets the label ${t.label}`, 'issue_comment.created': `a comment starts with /${t.command}`, 'pull_request.opened': 'a pull request is opened', 'pull_request.merged': 'a pull request is merged' }[t.on];
  return `when ${what} on GitHub, by a writer or owner`;
}

/** What an automation does, in plain words (the Review's summary and the detail pane). */
export function describe(a: Automation): string[] {
  return [
    `When: ${describeTrigger(a.trigger)}.`,
    a.mode === 'task' ? `Does: files the issue "${a.template.title}" with its done_when and the ready label; it is built, reviewed and merged like any other task.` : `Does: one read-only run (no shell, no edits) whose answer is posted as a comment; nothing is built.`,
    `Budget: at most $${a.budget.per_run_usd} a run and $${a.budget.per_day_usd} a local day; at most ${a.limits.runs_per_day} run(s) a day, ${a.limits.cooldown_minutes} min apart.`,
    a.chain.accept_from.length ? `Chains: output of ${a.chain.accept_from.join(', ')} may start it (never itself; at most 2 deep).` : 'Chains: no other automation can start it.',
  ];
}

/**
 * The change a request makes to `loaded`, or why it is refused (AutomationsError). Nothing is written. `by`: the
 * person asking (a create's owner); their role is checked by the caller with mayDo.
 */
export function planChange(loaded: Loaded, req: ChangeRequest, by: string): Plan {
  if (loaded.error) throw new AutomationsError(`can't change automations while the file is refused: ${loaded.error}`);
  if (!(ACTIONS as readonly string[]).includes(req.action)) throw new AutomationsError(`no action ${String(req.action).slice(0, 20)}`);
  const list = loaded.file.automations;
  const digest = digestOf(loaded.text);
  const find = (id: unknown) => {
    const a = list.find((x) => x.id === id);
    if (!a) throw new AutomationsError(`no automation ${String(id).slice(0, 40)}`);
    return a;
  };
  const parsed = (raw: unknown, owner: string) => {
    const r = Automation.safeParse({ ...(raw && typeof raw === 'object' ? raw : {}), owner });
    if (!r.success) throw new AutomationsError(`refused: ${r.error.issues.map((i) => `${i.path.join('.') || '(automation)'}: ${i.message}`).join('; ')}`);
    return r.data;
  };
  const finish = (action: AutomationAction, id: string, before: Automation | null, after: Automation | null, summary: string[]): Plan => {
    const next = AutomationsFile.safeParse({ version: 1, automations: after ? (before ? list.map((x) => (x.id === id ? after : x)) : [...list, after]) : list.filter((x) => x.id !== id) });
    if (!next.success) throw new AutomationsError(`refused: ${next.error.issues.map((i) => i.message).join('; ')}`);
    const changes = fieldDiff(before, after);
    if (!['run', 'rotate', 'unbind'].includes(action) && !changes.length) throw new AutomationsError('nothing to change');
    return { action, id, changes, summary, digest, next: next.data };
  };
  switch (req.action) {
    case 'create': {
      const a = parsed(req.automation, by);
      if (list.some((x) => x.id === a.id)) throw new AutomationsError(`an automation ${a.id} exists already`);
      return finish('create', a.id, null, a, [`Adds "${a.name}" (${a.id}), owned by @${by}.`, ...describe(a)]);
    }
    case 'edit': {
      const before = find(req.id);
      const after = parsed({ ...(req.automation as object), id: before.id }, before.owner);
      return finish('edit', before.id, before, after, [`Changes "${after.name}" (${after.id}).`, ...describe(after)]);
    }
    case 'delete': {
      const a = find(req.id);
      return finish('delete', a.id, a, null, [`Removes "${a.name}" (${a.id}). Its past runs, issues and comments stay.`]);
    }
    case 'pause': {
      const a = find(req.id);
      if (!a.enabled) throw new AutomationsError(`${a.id} is paused already`);
      return finish('pause', a.id, a, { ...a, enabled: false }, [`Pauses "${a.name}": it doesn't fire until an owner resumes it, and nothing missed meanwhile catches up. Work it already started goes on.`]);
    }
    case 'resume': {
      const a = find(req.id);
      if (a.enabled) throw new AutomationsError(`${a.id} is on already`);
      return finish('resume', a.id, a, { ...a, enabled: true }, [`Resumes "${a.name}": it fires on its next trigger (nothing missed while paused catches up).`, ...describe(a)]);
    }
    case 'rotate': {
      const a = find(req.id);
      if (a.trigger.kind !== 'webhook') throw new AutomationsError(`${a.id} takes no webhook, so it has no secret`);
      return finish('rotate', a.id, a, a, [`Makes a new secret for "${a.name}" and shows it to you once. The old one stops working at once: update the caller.`]);
    }
    case 'unbind': {
      const a = find(req.id);
      if (a.trigger.kind !== 'webhook') throw new AutomationsError(`${a.id} takes no webhook, so it is bound to no device`);
      return finish('unbind', a.id, a, a, [`Forgets which tailnet device "${a.name}" is bound to. The next valid delivery, from any device, binds it again.`]);
    }
    case 'run': {
      const a = find(req.id);
      if (!a.enabled) throw new AutomationsError(`${a.id} is paused; an owner resumes it first`);
      return finish('run', a.id, a, a, [`Starts one run of "${a.name}" now: at most $${a.budget.per_run_usd}, counted in today's ${a.limits.runs_per_day} run(s) and its caps. Its cooldown and every cap still apply.`]);
    }
  }
}

/**
 * Carry out a reviewed plan: planned again on the file as it is now, refused when its digest isn't `digest` (the file
 * changed since the review). A run now writes nothing to the file: it is recorded (automation.run_requested) for the
 * coordinator. Every change is recorded as automation.changed with who did it.
 */
export function applyChange(o: { path: string; req: ChangeRequest; digest: string; by: string; role: Role; log: EventLog; stateDir?: string }): Plan & { secret?: string } {
  if (!mayDo(o.req.action, o.role) || o.role === 'viewer') throw new AutomationsError(`a ${o.role} may not ${o.req.action} an automation`);
  const role = o.role;
  const loaded = loadAutomations(o.path);
  const plan = planChange(loaded, o.req, o.by);
  if (plan.digest !== o.digest) throw new AutomationsError('the automations changed since your review; review again');
  if (plan.action === 'run') {
    o.log.append('automation.run_requested', { id: plan.id, by: o.by, role: o.role }, o.by, 'human');
    return plan;
  }
  // A webhook's secret: made when one starts taking webhooks (shown once, in this answer only), made anew on a rotate,
  // removed with the automation or when it stops taking webhooks; its binding forgotten on an unbind or a delete.
  const home = dirname(o.path);
  const before = loaded.file.automations.find((x) => x.id === plan.id);
  const after = plan.next.automations.find((x) => x.id === plan.id);
  const hooksBefore = before?.trigger.kind === 'webhook';
  const hooksAfter = after?.trigger.kind === 'webhook';
  if (plan.action !== 'rotate' && plan.action !== 'unbind') replaceFileAtomically(o.path, stringify(plan.next), 0o600, existsSync(o.path) ? o.path : home);
  let secret: string | undefined;
  if (plan.action === 'rotate' || (hooksAfter && !hooksBefore)) secret = makeSecret(home, plan.id);
  if (hooksBefore && !hooksAfter) removeSecret(home, plan.id);
  if (o.stateDir && (plan.action === 'unbind' || plan.action === 'delete' || (hooksBefore && !hooksAfter))) unbind(o.stateDir, plan.id);
  o.log.append('automation.changed', { id: plan.id, action: plan.action, by: o.by, role, changes: plan.changes.slice(0, 200) }, o.by, 'human');
  return secret ? { ...plan, secret } : plan;
}

/**
 * The engine pausing an automation (its breaker): enabled false in the file, recorded as automation.changed by
 * `system` with why. Never anything else: it can't resume, edit or add one.
 */
export function pauseBySystem(o: { path: string; id: string; why: string; by: string; log: EventLog }): boolean {
  const loaded = loadAutomations(o.path);
  const a = loaded.file.automations.find((x) => x.id === o.id);
  if (loaded.error || !a || !a.enabled) return false;
  const next = { ...loaded.file, automations: loaded.file.automations.map((x) => (x.id === o.id ? { ...x, enabled: false } : x)) };
  replaceFileAtomically(o.path, stringify(next), 0o600);
  o.log.append('automation.changed', { id: o.id, action: 'pause', by: o.by, role: 'system', changes: ['- enabled: true', '+ enabled: false'], why: o.why }, o.by);
  return true;
}

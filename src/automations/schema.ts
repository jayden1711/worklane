// Automations (docs/automations.md): owner-defined agent tasks that run on a schedule or on an event. A definition
// lives in the instance's own automations.yaml (its home, 0600, the coordinator user's), never in the repo: an agent
// can open a PR to the repo, so a definition there would let it schedule itself. Only the dashboard's Review ->
// Confirm writes the file (src/automations/store.ts). The repo's config can only tighten (config.yaml automations).
import { z } from 'zod';
import { validLogin } from '../dashboard-auth.js';
import { parseCron } from './cron.js';

export const AUTOMATIONS_FILE = 'automations.yaml';
/** An automation's id: its key in the audit, the log and (for a webhook) its address. Never changes. */
export const AUTOMATION_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** A Discord command word or a comment's /command. */
const COMMAND = /^[a-z][a-z0-9-]{0,30}$/;
/**
 * INVARIANT: how deep a chain of automations may go (one automation's output starting another, and so on). A code
 * constant: no file, policy or payload changes it. Depth 0 is a person, a schedule or a chat command.
 */
export const MAX_CHAIN_DEPTH = 2;
/** At most this many automations per instance. */
export const MAX_AUTOMATIONS = 50;
/** A trigger's text is cut to this many characters (after redaction) before any run sees it. */
export const TRIGGER_TEXT_MAX = 4000;
/** A scheduled time missed (the machine off, a hold) still fires within this long after it; never later. */
export const CATCH_UP_MINUTES = 120;
/** The GitHub events an automation can start on. */
export const GITHUB_EVENTS = ['issue.opened', 'issue.labeled', 'issue_comment.created', 'pull_request.opened', 'pull_request.merged'] as const;
export type GitHubEventName = (typeof GITHUB_EVENTS)[number];

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), 'one line');

export const Trigger = z.discriminatedUnion('kind', [
  /** A 5-field cron in this machine's local time; its minute is one number, so it fires at most once an hour. */
  z.strictObject({ kind: z.literal('schedule'), cron: z.string().refine((c) => parseCron(c).ok, { message: 'not a cron this accepts (5 fields; the minute is one number 0-59)' }) }),
  /**
   * A GitHub event on the instance's repo, by a writer or owner of it (v0.5.1: never anyone else). `label`: for
   * issue.labeled, the label. `command`: for issue_comment.created, the comment must start with /<command>.
   */
  z
    .strictObject({ kind: z.literal('github'), on: z.enum(GITHUB_EVENTS), label: z.string().trim().min(1).max(50).optional(), command: z.string().regex(COMMAND).optional() })
    .refine((t) => t.on !== 'issue.labeled' || !!t.label, { message: 'issue.labeled needs a label', path: ['label'] })
    .refine((t) => t.on !== 'issue_comment.created' || !!t.command, { message: 'issue_comment.created needs a command', path: ['command'] }),
  /** `run <command>` addressed to the instance's Discord bot, by an allowed, mapped writer or owner. */
  z.strictObject({ kind: z.literal('discord'), command: z.string().regex(COMMAND) }),
]);
export type Trigger = z.infer<typeof Trigger>;

/** One done_when check, as the first-task form builds them: a test, or a command and optionally text its output holds. */
const DoneWhen = z.union([z.strictObject({ test: oneLine(300) }), z.strictObject({ command: z.string().trim().min(1).max(2000), expect: oneLine(300).optional() })]);

export const Automation = z
  .strictObject({
    id: z.string().regex(AUTOMATION_ID),
    name: oneLine(80),
    /** Who answers for it: an owner (admin) of the repo, checked again every time it fires. */
    owner: z.string().refine(validLogin, 'a GitHub login'),
    enabled: z.boolean().default(true),
    trigger: Trigger,
    /** task: an issue the normal build flow takes (every gate). report: one read-only run whose answer is posted. */
    mode: z.enum(['task', 'report']),
    template: z.strictObject({
      title: oneLine(200),
      outcome: oneLine(500),
      done_when: z.array(DoneWhen).max(10).default([]),
      /** quoted: the trigger's text goes to the run as fenced, untrusted data; none: only its reference. */
      trigger_text: z.enum(['quoted', 'none']).default('quoted'),
    }),
    budget: z.strictObject({ per_run_usd: z.number().positive().max(50), per_day_usd: z.number().positive().max(500) }),
    limits: z.strictObject({ runs_per_day: z.number().int().min(1).max(24).default(4), cooldown_minutes: z.number().int().min(0).max(1440).default(60) }).prefault({}),
    /** auto: it starts on its trigger (the owner's Confirm of this definition is the approval). */
    gates: z.strictObject({ start: z.literal('auto').default('auto') }).prefault({}),
    /** The automations whose output may start this one (default none). Never itself. */
    chain: z.strictObject({ accept_from: z.array(z.string().regex(AUTOMATION_ID)).max(10).default([]) }).prefault({}),
  })
  .refine((a) => a.mode !== 'task' || a.template.done_when.length > 0, { message: 'a task needs at least one done_when check', path: ['template', 'done_when'] })
  .refine((a) => !a.chain.accept_from.includes(a.id), { message: 'an automation can never start itself', path: ['chain', 'accept_from'] })
  .refine((a) => a.budget.per_run_usd <= a.budget.per_day_usd, { message: 'per_run_usd is over per_day_usd', path: ['budget', 'per_run_usd'] });
export type Automation = z.infer<typeof Automation>;

export const AutomationsFile = z
  .strictObject({ version: z.literal(1), automations: z.array(Automation).max(MAX_AUTOMATIONS).default([]) })
  .refine((f) => new Set(f.automations.map((a) => a.id)).size === f.automations.length, { message: 'two automations share an id', path: ['automations'] })
  .refine((f) => !chainCycle(f.automations), { message: 'chain.accept_from makes a cycle', path: ['automations'] });
export type AutomationsFile = z.infer<typeof AutomationsFile>;

/** An id on a cycle of accept_from (A accepts B, B accepts A, ...), or null. */
export function chainCycle(list: Pick<Automation, 'id' | 'chain'>[]): string | null {
  const from = new Map(list.map((a) => [a.id, a.chain.accept_from]));
  for (const start of list) {
    const seen = new Set<string>();
    const stack = [...start.chain.accept_from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === start.id) return start.id;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(from.get(n) ?? []));
    }
  }
  return null;
}

/**
 * The instance policy's automations part (policy.yaml, the owners' only). Off until an owner turns it on. The caps
 * hold over every automation together: at most `max_runs_per_day` fires a local day, `max_concurrent` at once, and
 * `budget_share` of the daily budget spent by them a local day.
 */
export const AutomationsPolicy = z
  .strictObject({
    enabled: z.boolean().default(false),
    max_runs_per_day: z.number().int().min(1).max(100).default(12),
    max_concurrent: z.number().int().min(1).max(8).default(1),
    budget_share: z.number().positive().max(1).default(0.25),
  })
  .prefault({});
export type AutomationsPolicy = z.infer<typeof AutomationsPolicy>;

/** The repo's say (config.yaml automations): it can only tighten the policy; every field is a ceiling or an off. */
export const AutomationsRepo = z
  .strictObject({
    enabled: z.boolean().default(true),
    max_runs_per_day: z.number().int().min(0).max(100).optional(),
    daily_usd: z.number().nonnegative().optional(),
  })
  .prefault({});
export type AutomationsRepo = z.infer<typeof AutomationsRepo>;

/** What is in force: the policy, narrowed by the repo. The repo can turn it off or lower a cap, never more. */
export interface AutomationLimits {
  enabled: boolean;
  /** Why it is off, when it is. */
  off: string | null;
  maxRunsPerDay: number;
  maxConcurrent: number;
  dailyUsd: number;
}

export function limitsInForce(policy: AutomationsPolicy, repo: AutomationsRepo, dailyBudgetUsd: number): AutomationLimits {
  const off = !policy.enabled ? "off in the instance's policy (an owner turns it on in the policy form)" : !repo.enabled ? "off in the repo's config.yaml (automations.enabled: false)" : null;
  const share = Math.round(policy.budget_share * dailyBudgetUsd * 100) / 100;
  return {
    enabled: off === null,
    off,
    maxRunsPerDay: Math.min(policy.max_runs_per_day, repo.max_runs_per_day ?? Infinity),
    maxConcurrent: policy.max_concurrent,
    dailyUsd: Math.min(share, repo.daily_usd ?? Infinity),
  };
}

// Loop control for a task's worker attempts: the attempt cap (agents.yaml max_attempts, default 8), a short read-only
// reflection run before each retry, a stop after IDENTICAL_FAILURES identical failures in a row (the task is
// reassigned once: a fresh worktree and an escalated model; the second time it is blocked), and a per-issue budget of
// agent time and tokens (agents.yaml budget): an incident at BUDGET_WARN of either, the task stopped at all of it.
// Everything here is read from the event log, so a restart or a requeue continues where the task was.
import type { StoredEvent } from '../events/types.js';
import { normalizeCause } from '../failure-modes.js';

/** Identical failures in a row that stop the attempts: the first time the task is reassigned, the second it is blocked. */
export const IDENTICAL_FAILURES = 3;
/** The share of a budget at which the incident is raised. */
export const BUDGET_WARN = 0.85;
/** The incident a task near its budget raises, keyed by instance and issue. */
export const TASK_BUDGET_INCIDENT = 'task_budget';
/** The default attempt cap, when agents.yaml sets none. */
export const DEFAULT_MAX_ATTEMPTS = 8;

/** How an attempt failed, for its fingerprint. */
export type FailureKind = 'stuck' | 'rejected' | 'checks' | 'evaluator';

/** An attempt's failure, reduced so the same failure reads the same each time (ids, numbers, paths and quotes out). */
export function failureFingerprint(kind: FailureKind, text: string): string {
  return `${kind}: ${normalizeCause(text)}`;
}

/** The fingerprint of failed checks: each failing check and the start of its output. */
export function checksFingerprint(failing: { check: string; tail?: string }[]): string {
  return failureFingerprint('checks', failing.map((c) => `${c.check}: ${(c.tail ?? '').trim().split(/\r?\n/).slice(-3).join(' ')}`).join(' | '));
}

/**
 * The issue's events since its attempt budget last reset: its last block or decision asked, after which the owner
 * relabels or answers and the task starts afresh (as the coordinator's attempt count resets).
 */
export function sinceReset(events: StoredEvent[]): StoredEvent[] {
  let from = 0;
  events.forEach((e, i) => {
    if (e.type === 'issue.blocked' || e.type === 'decision.asked') from = i + 1;
  });
  return events.slice(from);
}

/** Whether the task was already reassigned since its last reset. */
export function reassigned(events: StoredEvent[]): boolean {
  return sinceReset(events).some((e) => e.type === 'task.reassigned');
}

/**
 * The run of identical failures the task's attempts end on (since the reset and the last reassign): its fingerprint
 * and how many in a row.
 */
export function identicalStreak(events: StoredEvent[]): { fingerprint: string | null; count: number } {
  const since = sinceReset(events);
  const last = since.findLastIndex((e) => e.type === 'task.reassigned');
  const failures = since.slice(last + 1).filter((e) => e.type === 'attempt.failed').map((e) => (e.payload as { fingerprint: string }).fingerprint);
  const fingerprint = failures.at(-1) ?? null;
  let count = 0;
  for (let i = failures.length - 1; i >= 0 && failures[i] === fingerprint; i--) count++;
  return { fingerprint, count };
}

export interface TaskBudget {
  /** Agent run time for one issue, in minutes. */
  task_minutes?: number | undefined;
  /** Tokens in and out for one issue, all its runs together. */
  task_tokens?: number | undefined;
}

export interface TaskUsage {
  tokens: number;
  minutes: number;
}

/** What the issue's runs used since its reset: tokens in and out, and run time, from their run.cost events. */
export function taskUsage(events: StoredEvent[]): TaskUsage {
  let tokens = 0;
  let secs = 0;
  for (const e of sinceReset(events)) {
    if (e.type !== 'run.cost') continue;
    const p = e.payload as { tokens_in?: number; tokens_out?: number; secs?: number };
    tokens += (p.tokens_in ?? 0) + (p.tokens_out ?? 0);
    secs += p.secs ?? 0;
  }
  return { tokens, minutes: secs / 60 };
}

export interface BudgetState {
  level: 'ok' | 'warn' | 'over';
  /** The larger share of the two budgets used (0 with no budget). */
  share: number;
  /** What was used of what, for the incident and the block. */
  detail: string;
}

/** Where the usage stands against the budget: over at 100% of either, warn at BUDGET_WARN. */
export function budgetState(u: TaskUsage, b: TaskBudget | undefined): BudgetState {
  const parts: { share: number; text: string }[] = [];
  if (b?.task_tokens) parts.push({ share: u.tokens / b.task_tokens, text: `${Math.round(u.tokens).toLocaleString('en-US')} of ${b.task_tokens.toLocaleString('en-US')} tokens (budget.task_tokens)` });
  if (b?.task_minutes) parts.push({ share: u.minutes / b.task_minutes, text: `${Math.round(u.minutes)} of ${b.task_minutes} minutes of agent time (budget.task_minutes)` });
  if (!parts.length) return { level: 'ok', share: 0, detail: '' };
  const share = Math.max(...parts.map((p) => p.share));
  const detail = parts.map((p) => `${p.text}, ${Math.round(p.share * 100)}%`).join('; ');
  return { level: share >= 1 ? 'over' : share >= BUDGET_WARN ? 'warn' : 'ok', share, detail };
}

/** How long the next run may take before the time budget runs out (ms), or null with no time budget. */
export function timeLeftMs(u: TaskUsage, b: TaskBudget | undefined): number | null {
  if (!b?.task_minutes) return null;
  return Math.max(0, (b.task_minutes - u.minutes) * 60_000);
}

/** The prompt for a reflection run: the issue brief, why the last attempt failed, the earlier failures, the change. */
export function reflectionBrief(brief: string, feedback: string[], earlier: string[], changed: string): string {
  return [
    brief,
    '',
    'The last attempt at this issue failed. Why it was rejected:',
    ...feedback,
    ...(earlier.length ? ['', 'Earlier failures on this issue, oldest first:', ...earlier.map((f) => `- ${f}`)] : []),
    '',
    changed ? `What the attempt changed against the base (git diff --stat), as left in this worktree:\n${changed}` : 'The attempt left no change against the base.',
  ].join('\n');
}

/** What the next attempt is told from a reflection. */
export function reflectionFeedback(s: { what_failed?: unknown; what_to_change?: unknown } | undefined): string[] {
  const failed = typeof s?.what_failed === 'string' ? s.what_failed.trim() : '';
  const change = typeof s?.what_to_change === 'string' ? s.what_to_change.trim() : '';
  if (!failed || !change) return [];
  return ['', 'A review of the failed attempt, before this one:', `- What failed: ${failed.slice(0, 1500)}`, `- What to change: ${change.slice(0, 1500)}`];
}

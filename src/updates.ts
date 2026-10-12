// Engine updates, as the machine's updater records them (scripts/machine/<cli>-update.cjs, run
// by a root timer): whether they're on, and each attempt, install, refusal and rollback. Read-only
// here; turning them on or off goes through the machine helper (src/machine.ts setUpdates).
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';

export const UPDATES_CONFIG = `/etc/${BRAND.cli}/updates.json`;
export const UPDATES_LOG = `/var/lib/${BRAND.cli}/updates.jsonl`;

/** held: a commit that was rolled back, skipped until a newer one or until updates are turned off and on again. */
export type UpdateEvent = 'attempt' | 'installed' | 'rolled_back' | 'held' | 'refused' | 'waiting' | 'build_failed' | 'error';
export interface UpdateEntry {
  at: string;
  event: UpdateEvent;
  from?: string | null;
  to?: string | null;
  reason?: string;
  units?: string[];
  failed?: string[];
  back?: string;
  /** On a rollback: each failing unit's result, exit status, restarts and journal tail (redacted). */
  diagnosis?: { unit: string; result: string; status: string; restarts: number; journal: string }[];
  /** On a rollback: the commit is now held. */
  held?: boolean;
  /** On a rollback because an instance's migration failed: which, and why. */
  migration?: { instance: string; error: string; restored?: string[]; unrestored?: string[] };
}

/** An engine update that was rolled back and is held: the owner's to look at, until an install succeeds. */
export interface HeldUpdate {
  at: string;
  sha: string | null;
  reason: string;
  migration: boolean;
}

/** The held rollback, if the newest install or held rollback in the log is one. */
export function heldUpdate(log: UpdateEntry[]): HeldUpdate | null {
  const last = [...log].reverse().find((e) => e.event === 'installed' || (e.event === 'rolled_back' && e.held));
  if (!last || last.event !== 'rolled_back') return null;
  const reason = last.reason ?? (last.failed?.length ? `rolled back: ${last.failed.join('; ')}` : 'rolled back');
  return { at: last.at, sha: last.from ?? null, reason, migration: !!last.migration || /migration failed/.test(reason) };
}

const EVENTS = new Set<string>(['attempt', 'installed', 'rolled_back', 'held', 'refused', 'waiting', 'build_failed', 'error']);

/** What the updater follows: signed release tags, or main's tip. */
export type UpdateChannel = 'release' | 'main';

/** The channel an updates.json selects: "release" only when it says so; absent (an existing install) is main. */
export function updateChannel(j: Record<string, unknown>): UpdateChannel {
  return j.channel === 'release' ? 'release' : 'main';
}

/** The updater's settings, or null when it isn't set up on this machine. */
export function updateSettings(path = UPDATES_CONFIG): { enabled: boolean; channel: UpdateChannel; repo_url: string; branch: string; required_checks: string[] } | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      enabled: j.enabled === true,
      channel: updateChannel(j),
      repo_url: typeof j.repo_url === 'string' ? j.repo_url : '',
      branch: typeof j.branch === 'string' ? j.branch : 'main',
      required_checks: Array.isArray(j.required_checks) ? j.required_checks.filter((c): c is string => typeof c === 'string') : [],
    };
  } catch {
    return null;
  }
}

/** The update log, newest last; torn or unknown lines are skipped. */
export function updateLog(path = UPDATES_LOG, limit = 200): UpdateEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: UpdateEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as UpdateEntry;
      if (typeof j.at === 'string' && EVENTS.has(j.event)) out.push(j);
    } catch {
      // torn line
    }
  }
  return out.slice(-limit);
}

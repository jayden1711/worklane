// Engine updates, as the machine's updater records them (scripts/machine/<cli>-update.cjs, run
// by a root timer): whether they're on, and each attempt, install, refusal and rollback. Read-only
// here; turning them on or off goes through the machine helper (src/machine.ts setUpdates).
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';

export const UPDATES_CONFIG = `/etc/${BRAND.cli}/updates.json`;
export const UPDATES_LOG = `/var/lib/${BRAND.cli}/updates.jsonl`;

export type UpdateEvent = 'attempt' | 'installed' | 'rolled_back' | 'refused' | 'waiting' | 'build_failed' | 'error';
export interface UpdateEntry {
  at: string;
  event: UpdateEvent;
  from?: string | null;
  to?: string | null;
  reason?: string;
  units?: string[];
  failed?: string[];
  back?: string;
}

const EVENTS = new Set<string>(['attempt', 'installed', 'rolled_back', 'refused', 'waiting', 'build_failed', 'error']);

/** The updater's settings, or null when it isn't set up on this machine. */
export function updateSettings(path = UPDATES_CONFIG): { enabled: boolean; repo_url: string; branch: string; required_checks: string[] } | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      enabled: j.enabled === true,
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

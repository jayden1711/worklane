// Engine updates, as the machine's updater records them (scripts/machine/<cli>-update.cjs, run
// by a root timer): whether they're on, and each attempt, install, refusal and rollback. Read-only
// here; turning them on or off goes through the machine helper (src/machine.ts setUpdates).
import { readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BRAND } from './brand.js';

export const UPDATES_CONFIG = `/etc/${BRAND.cli}/updates.json`;
export const UPDATES_LOG = `/var/lib/${BRAND.cli}/updates.jsonl`;
/** The engine the machine's services run: a link to /opt/<cli>/<sha>. */
export const ENGINE_CURRENT = `/opt/${BRAND.cli}/current`;

/** held: a commit that was rolled back, skipped until a newer one or until an admin releases it at a root shell (updates.sh --release-hold). */
/** The root command that releases a hold; nothing a coordinator or the dashboard can do releases one. */
export const RELEASE_HOLD = `sudo bash /opt/${BRAND.cli}/current/scripts/setup/updates.sh --release-hold`;
/** chose: an older commit than main's tip is being installed (the tip, and every newer one, failed or held). */
export type UpdateEvent = 'attempt' | 'chose' | 'installed' | 'rolled_back' | 'held' | 'refused' | 'waiting' | 'build_failed' | 'error' | CanaryEvent;
/** The canary (docs/canary.md): filed, then passed or failed. */
export type CanaryEvent = 'canary_filed' | 'canary_passed' | 'canary_failed';
export interface UpdateEntry {
  at: string;
  event: UpdateEvent;
  from?: string | null;
  to?: string | null;
  reason?: string;
  units?: string[];
  failed?: string[];
  /** On chose: main's tip then, and each newer commit passed over, with why. */
  tip?: string;
  skipped?: { sha: string; reason: string; held?: boolean; pending?: boolean }[];
  back?: string;
  /** On a rollback: each failing unit's result, exit status, restarts and journal tail (redacted). */
  diagnosis?: { unit: string; result: string; status: string; restarts: number; journal: string }[];
  /** On a rollback: the commit is now held. */
  held?: boolean;
  /** On an install (the new engine's) or a rollback (the old engine's): the root helpers replaced to match it. */
  helpers?: { path: string; state: string }[];
  /** On a rollback: why the old engine's helpers couldn't all be put back. */
  helpers_error?: string;
  /** On a rollback because an instance's migration failed: which, and why. */
  migration?: { instance: string; error: string; restored?: string[]; unrestored?: string[] };
  /** On a rollback because the canary failed: its issue, how far it got, its PR. */
  canary?: { issue: number | null; url: string | null; stage: string; pr: { number: number; url: string } | null };
  /** A canary line (reason: why it failed, or what passed): after an install or the daily one, its issue, the stage it reached, its PR, how long since it was filed. */
  trigger?: 'update' | 'daily';
  issue?: number | null;
  url?: string | null;
  stage?: string;
  pr?: { number: number; url: string } | null;
  duration_ms?: number;
  timed_out?: boolean;
  deadline?: string;
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

const EVENTS = new Set<string>(['attempt', 'chose', 'installed', 'rolled_back', 'held', 'refused', 'waiting', 'build_failed', 'error', 'canary_filed', 'canary_passed', 'canary_failed']);

/** What the updater follows: signed release tags, or main's tip. */
export type UpdateChannel = 'release' | 'main';

/** The channel an updates.json selects: "release" only when it says so; absent (an existing install) is main. */
export function updateChannel(j: Record<string, unknown>): UpdateChannel {
  return j.channel === 'release' ? 'release' : 'main';
}

/** The updater's settings, or null when it isn't set up on this machine. */
export function updateSettings(path = UPDATES_CONFIG): { enabled: boolean; channel: UpdateChannel; repo_url: string; branch: string; required_checks: string[]; canary: CanarySettings | null } | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      enabled: j.enabled === true,
      channel: updateChannel(j),
      repo_url: typeof j.repo_url === 'string' ? j.repo_url : '',
      branch: typeof j.branch === 'string' ? j.branch : 'main',
      required_checks: Array.isArray(j.required_checks) ? j.required_checks.filter((c): c is string => typeof c === 'string') : [],
      canary: canarySettings(j.canary),
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

/** The canary as updates.json names it (the updater reads the same fields): its instance, its scratch repo, its time limit. */
export interface CanarySettings {
  instance: string;
  repo: string;
  timeLimitMinutes: number;
}
export const CANARY_TIME_LIMIT_MINUTES = 120;

function canarySettings(c: unknown): CanarySettings | null {
  const o = (c ?? {}) as Record<string, unknown>;
  if (typeof o.instance !== 'string' || typeof o.repo !== 'string' || !o.instance || !o.repo) return null;
  const min = Number(o.time_limit_minutes);
  return { instance: o.instance, repo: o.repo, timeLimitMinutes: Number.isFinite(min) && min > 0 ? min : CANARY_TIME_LIMIT_MINUTES };
}

/** The canary's last result: passed or failed, why, how long it took, its PR (or its issue when it got no PR). */
export interface CanaryResult {
  at: string;
  passed: boolean;
  trigger: 'update' | 'daily';
  stage: string | null;
  why: string | null;
  durationMs: number | null;
  timedOut: boolean;
  issue: { number: number; url: string | null } | null;
  pr: { number: number; url: string } | null;
  /** The engine commit it ran on after an install, when it was one. */
  sha: string | null;
}

/** What the Machine page's Updates panel shows: the engine running now, the last install, any hold, the canary. */
export interface UpdatesPanel {
  configured: boolean;
  enabled: boolean | null;
  installed: { sha: string | null; version: string | null };
  lastInstall: { at: string; from: string | null; to: string | null } | null;
  /** The newest rollback, while no later install succeeded: when, what, why, and whether it is held. */
  rollback: { at: string; sha: string | null; reason: string; held: boolean; canary: boolean } | null;
  canary: {
    settings: CanarySettings | null;
    /** A canary filed and not yet passed or failed. */
    running: { at: string; trigger: 'update' | 'daily'; issue: number | null; url: string | null; deadline: string | null } | null;
    last: CanaryResult | null;
  };
}

/** The engine the services run: its commit (the link's target) and version (its package.json); null where there's none. */
export function installedEngine(current = ENGINE_CURRENT): { sha: string | null; version: string | null } {
  let sha: string | null = null;
  try {
    const target = basename(readlinkSync(current));
    sha = /^[0-9a-f]{40}$/.test(target) ? target : null;
  } catch {
    // not a link: no updater-installed engine here
  }
  let version: string | null = null;
  try {
    const v = (JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { version?: unknown }).version;
    version = typeof v === 'string' ? v : null;
  } catch {
    // no package.json
  }
  return { sha, version };
}

/** The Updates panel from the updater's log (oldest first), its settings and the engine installed now. */
export function updatesPanel(log: UpdateEntry[], settings: ReturnType<typeof updateSettings>, installed: { sha: string | null; version: string | null }): UpdatesPanel {
  const lastOf = (f: (e: UpdateEntry) => boolean) => [...log].reverse().find(f) ?? null;
  const install = lastOf((e) => e.event === 'installed');
  const rolled = lastOf((e) => e.event === 'rolled_back');
  const rollbackNow = rolled && (!install || rolled.at >= install.at) ? rolled : null;
  const held = heldUpdate(log);
  const result = lastOf((e) => e.event === 'canary_passed' || e.event === 'canary_failed');
  const filed = lastOf((e) => e.event === 'canary_filed');
  const running = filed && (!result || filed.at > result.at) ? filed : null;
  return {
    configured: !!settings,
    enabled: settings ? settings.enabled : null,
    installed,
    lastInstall: install ? { at: install.at, from: install.from ?? null, to: install.to ?? null } : null,
    rollback: rollbackNow
      ? { at: rollbackNow.at, sha: rollbackNow.from ?? null, reason: rollbackNow.reason ?? (rollbackNow.failed?.length ? `rolled back: ${rollbackNow.failed.join('; ')}` : 'rolled back'), held: !!held && held.at === rollbackNow.at, canary: !!rollbackNow.canary }
      : null,
    canary: {
      settings: settings?.canary ?? null,
      running: running ? { at: running.at, trigger: running.trigger === 'update' ? 'update' : 'daily', issue: running.issue ?? null, url: running.url ?? null, deadline: running.deadline ?? null } : null,
      last: result
        ? {
            at: result.at,
            passed: result.event === 'canary_passed',
            trigger: result.trigger === 'update' ? 'update' : 'daily',
            stage: result.stage ?? null,
            why: result.reason ?? null,
            durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : null,
            timedOut: result.timed_out === true,
            issue: typeof result.issue === 'number' ? { number: result.issue, url: result.url ?? null } : null,
            pr: result.pr ?? null,
            sha: result.to ?? null,
          }
        : null,
    },
  };
}

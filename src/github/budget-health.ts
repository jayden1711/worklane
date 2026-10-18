// The machine's shared GitHub API budget (src/github/budget.ts) as the Health page shows it (#198): per credential,
// what is left and when it resets per rate-limit resource, whether a back-off is in force, and who used it most in
// the current window. Read-only: nothing here changes a budget. The dashboard shows it to owners and writers only.
//
// INVARIANT: nothing here names a credential by anything derived from its token. The state files are named by a hash
// of the token (<slots>/github-budget-<key>.json); this view numbers the credentials instead ("credential 1", ...)
// in the order shown, and never carries the key, the file's name or its path.
//
// INVARIANT: reading never takes the budget's lock and never waits. The state is only ever replaced whole (a copy
// renamed over it), so a read without the lock sees one whole state. Each file is read through one descriptor that
// follows no symlink and doesn't block (a FIFO with a budget's name is refused), up to LIMITS.fileBytes, and at most
// LIMITS.credentials files are read: the most recently changed. What can't be read is counted, not shown.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile, slotsDir } from '../os/index.js';
import { sanitize, type PauseKind } from './budget.js';

export const BUDGET_HEALTH_LIMITS = {
  /** Credentials shown: the most recently changed state files. */
  credentials: 8,
  /** Budget files looked at (stat) at most, whatever else the slot directory holds. */
  scan: 256,
  /** A state file larger than this is not read. */
  fileBytes: 64 * 1024,
  /** Rate-limit resources shown per credential. */
  resources: 8,
  /** Consumers shown per credential, most calls first. */
  consumers: 5,
} as const;

/** GitHub's rate-limit resource names (core, graphql, search, code_search, ...). */
const RESOURCE = /^[a-z][a-z0-9_]{0,31}$/;
/** A consumer as the engine names one (backlog, pr-watch, merge-flow, ...); anything else is shown as OTHER. */
const CONSUMER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,47}$/;
const OTHER = '(other)';
const STATE_FILE = /^github-budget-[0-9a-f]{16}\.json$/;

export interface BudgetResourceHealth {
  resource: string;
  limit: number | null;
  /** What is left in this window, as the budget counts it; null: not known (no answer from GitHub in this window). */
  remaining: number | null;
  /** When the window resets (ISO); null when not known. */
  resetAt: string | null;
}

export interface BudgetCredentialHealth {
  /** Its place in this view ("credential 1"): never the file's key, which is a hash of the token. */
  id: string;
  resources: BudgetResourceHealth[];
  /** A back-off every caller on this credential is in (a secondary limit, or a limit known only by Retry-After); null when none. */
  backoff: { kind: PauseKind; until: string } | null;
  /** Calls granted in the current windows, by consumer over every resource, most first (at most LIMITS.consumers). */
  top: { consumer: string; calls: number }[];
  /** Calls granted in the current windows, every consumer. */
  calls: number;
  /** When the state last changed (ISO). */
  updatedAt: string;
}

export interface GitHubBudgetHealth {
  credentials: BudgetCredentialHealth[];
  /** Budget files not shown: past LIMITS.credentials, or refused (not a regular file, a symlink, too big, not JSON). */
  notShown: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** One state file, read without the lock; null when refused. */
function readState(file: string, now: number): Omit<BudgetCredentialHealth, 'id' | 'updatedAt'> | null {
  const r = readRegularFile(file, BUDGET_HEALTH_LIMITS.fileBytes);
  if (r.kind !== 'file') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // The budget's own bounds: what take() would act on is what is shown (an implausible pause or window is dropped).
  const s = sanitize(raw, now);
  const by = new Map<string, number>();
  const resources: BudgetResourceHealth[] = [];
  for (const [name, res] of Object.entries(s.resources)) {
    if (!RESOURCE.test(name)) continue;
    if (resources.length < BUDGET_HEALTH_LIMITS.resources) resources.push({ resource: name, limit: res.limit, remaining: res.remaining, resetAt: res.reset === null ? null : iso(res.reset * 1000) });
    for (const [who, n] of Object.entries(res.used)) {
      if (!(n > 0)) continue;
      const k = CONSUMER.test(who) ? who : OTHER;
      by.set(k, (by.get(k) ?? 0) + n);
    }
  }
  resources.sort((a, b) => a.resource.localeCompare(b.resource));
  const all = [...by].map(([consumer, calls]) => ({ consumer, calls })).sort((a, b) => b.calls - a.calls || a.consumer.localeCompare(b.consumer));
  return {
    resources,
    backoff: s.pausedUntil > now ? { kind: s.pauseKind ?? 'secondary_rate_limited', until: iso(s.pausedUntil) } : null,
    top: all.slice(0, BUDGET_HEALTH_LIMITS.consumers),
    calls: all.reduce((t, c) => t + c.calls, 0),
  };
}

/** The smallest share left over the resources whose limit and remaining are known (1 when none is). */
const leftShare = (c: Omit<BudgetCredentialHealth, 'id'>) => Math.min(1, ...c.resources.filter((r) => r.limit && r.remaining !== null).map((r) => r.remaining! / r.limit!));

/**
 * The budgets in `dir` (the machine's slot directory by default), most pressing first: a back-off, then the least
 * left. Null when there is no budget file at all (nothing has called GitHub through the budget yet).
 */
export function githubBudgetHealth(dir: string = slotsDir(), now = Date.now()): GitHubBudgetHealth | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => STATE_FILE.test(n));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const files: { file: string; mtimeMs: number }[] = [];
  for (const name of names.sort().slice(0, BUDGET_HEALTH_LIMITS.scan)) {
    const file = join(dir, name);
    try {
      files.push({ file, mtimeMs: lstatSync(file).mtimeMs });
    } catch {
      // gone since the listing (pruned): not counted
    }
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const shown: Omit<BudgetCredentialHealth, 'id'>[] = [];
  for (const f of files.slice(0, BUDGET_HEALTH_LIMITS.credentials)) {
    const s = readState(f.file, now);
    if (s) shown.push({ ...s, updatedAt: iso(f.mtimeMs) });
  }
  shown.sort((a, b) => Number(!!b.backoff) - Number(!!a.backoff) || leftShare(a) - leftShare(b) || b.updatedAt.localeCompare(a.updatedAt));
  const unscanned = Math.max(0, names.length - BUDGET_HEALTH_LIMITS.scan);
  return { credentials: shown.map((c, i) => ({ id: `credential ${i + 1}`, ...c })), notShown: unscanned + files.length - shown.length };
}

// One GitHub API budget per credential, shared by every process on the machine (coordinators of every instance,
// whatever user each runs as, dashboards, the updater), through files in the machine's slot directory (docs/slots.md):
//   <slots>/github-budget-<key>.json   the state: per resource, GitHub's last word on what is left and when it resets,
//                                      the calls granted since, by consumer; and a pause over every resource
//   <slots>/github-budget-<key>.lock   held for a moment while one process reads, decides and writes the state
// <key> is a hash of the token, never the token. A call takes one unit before it is made (take), and every response's
// X-RateLimit-* headers lower what is left (observe); a secondary limit pauses every caller until it lifts (pause).
// INVARIANT: this decides only when a call runs, never what it does.
//
// INVARIANT: the budget can delay a call, never stop GitHub access for long. Whatever the state file holds (written by
// GitHub's headers, a bug, or anyone who can write the slot directory), a pause counts only up to MAX_PAUSE_S ahead and
// a window only up to MAX_WINDOW_S ahead; anything else is "not known", and a call then goes. Its own faults (a state
// it can't read or write, a busy lock) let the call go too.
//
// Cross-user: the system slot directory is root:agent-slots 2770 (scripts/setup/machine.sh), with no sticky bit, so
// any coordinator user may create, rename over and remove files in it, but a file another user created is theirs. So
// the state is never written in place: a new copy (0660) is renamed over it. No subdirectory either: one made by one
// user would follow that user's umask and could shut the others out.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock, type Lock } from '../locks.js';
import { slotsDir } from '../os/index.js';
import { testSlotsRefusal } from '../os/system-paths.js';

export class TestSlotsRefused extends Error {
  override name = 'TestSlotsRefused';
}

/**
 * Where a budget lives when no directory is given: the machine's slot directory. In a test run, only the test
 * machine's (test/isolate.ts); anything else throws before any file is opened, so a test that builds a GitHub client
 * without the isolation can never read or write the machine's own budget (#669). Outside a test run: slotsDir(), as
 * always.
 */
export function defaultBudgetDir(): string {
  const refusal = testSlotsRefusal(process.env.AGENT_SLOTS_DIR);
  if (refusal) throw new TestSlotsRefused(`GitHub budget: ${refusal}`);
  return slotsDir();
}

/** How long take() waits out a pause or an exhausted budget before refusing (the caller sees GitHub's own kind of error). */
export const DEFAULT_MAX_WAIT_MS = 10_000;
/** A secondary limit with no Retry-After: GitHub's documented minimum wait. */
export const SECONDARY_DEFAULT_S = 60;
/** The longest pause that counts. GitHub's secondary-limit waits are about a minute; a longer one is ignored. */
export const MAX_PAUSE_S = 15 * 60;
/** The furthest reset that counts: GitHub's windows are an hour, plus clock skew. */
export const MAX_WINDOW_S = 3600 + 300;
/** take() waits this long for the lock, then lets the call go. */
export const LOCK_WAIT_MS = 500;
/**
 * The lock is held for microseconds: one dated more than this before now, or after now, or not dated at all, is stuck
 * or planted, and is broken whatever its pid.
 */
export const LOCK_STALE_MS = 5_000;
/** A state file unchanged this long belongs to a token no longer used (App installation tokens rotate hourly): removed. */
export const PRUNE_AFTER_MS = 2 * 3600_000;
const PRUNE_EVERY_MS = 10 * 60_000;

export type PauseKind = 'rate_limited' | 'secondary_rate_limited';

export interface ResourceState {
  limit: number | null;
  /** What is left in this window: GitHub's last answer, less every call granted since. null: not known yet. */
  remaining: number | null;
  /** When the window resets, epoch seconds (GitHub's X-RateLimit-Reset). */
  reset: number | null;
  /** Calls granted in this window, by consumer. */
  used: Record<string, number>;
}

export interface BudgetState {
  resources: Record<string, ResourceState>;
  /** No call on this credential, any resource, before this (epoch ms). */
  pausedUntil: number;
  pauseKind?: PauseKind;
}

export class BudgetPaused extends Error {
  constructor(
    readonly kind: PauseKind,
    /** Seconds until the budget allows calls again. */
    readonly retryAfter: number,
  ) {
    super(`${kind === 'secondary_rate_limited' ? 'secondary rate limit' : 'rate limit'}: every caller on this token is paused by the shared budget for ${retryAfter} s`);
  }
}

type Headers = Record<string, string | undefined>;

export const credentialKey = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);

const empty = (): ResourceState => ({ limit: null, remaining: null, reset: null, used: {} });
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: string | undefined): number | null => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
/** A reset (epoch s) that can be a real window's: in the future, and at most MAX_WINDOW_S ahead. */
const plausibleReset = (reset: number, now: number) => reset * 1000 > now && reset * 1000 <= now + MAX_WINDOW_S * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The state as it may be trusted at `now`: an implausible pause or window is dropped, an expired one too. */
export function sanitize(raw: unknown, now: number): BudgetState {
  const out: BudgetState = { resources: {}, pausedUntil: 0 };
  if (!raw || typeof raw !== 'object') return out;
  const s = raw as { resources?: unknown; pausedUntil?: unknown; pauseKind?: unknown };
  if (finite(s.pausedUntil) && s.pausedUntil > now && s.pausedUntil <= now + MAX_PAUSE_S * 1000) {
    out.pausedUntil = s.pausedUntil;
    out.pauseKind = s.pauseKind === 'rate_limited' ? 'rate_limited' : 'secondary_rate_limited';
  }
  const resources = s.resources && typeof s.resources === 'object' ? (s.resources as Record<string, Partial<ResourceState> | null>) : {};
  for (const [name, r] of Object.entries(resources)) {
    if (!r || typeof r !== 'object') continue;
    const used = Object.fromEntries(Object.entries(r.used && typeof r.used === 'object' ? r.used : {}).filter(([, n]) => finite(n)));
    if (finite(r.remaining) && r.remaining >= 0 && finite(r.reset) && plausibleReset(r.reset, now)) {
      out.resources[name] = { limit: finite(r.limit) ? r.limit : null, remaining: r.remaining, reset: r.reset, used };
    } else {
      // Not known (yet, or any more): calls go until GitHub says. Before the first answer, keep the count.
      out.resources[name] = { ...empty(), used: r.remaining === null && r.reset === null ? used : {} };
    }
  }
  return out;
}

export interface BudgetOptions {
  maxWaitMs?: number;
  pollMs?: number;
}

const lastPrune = new Map<string, number>();

export class GitHubBudget {
  private readonly file: string;
  private readonly lockPath: string;

  constructor(
    readonly key: string,
    readonly dir: string = defaultBudgetDir(),
    private readonly opts: BudgetOptions = {},
  ) {
    this.file = join(dir, `github-budget-${key}.json`);
    this.lockPath = join(dir, `github-budget-${key}.lock`);
  }

  read(now = Date.now()): BudgetState {
    try {
      return sanitize(JSON.parse(readFileSync(this.file, 'utf8')), now);
    } catch {
      return { resources: {}, pausedUntil: 0 }; // missing or unreadable: start afresh
    }
  }

  /**
   * Take one call from the budget for `consumer`, waiting out a pause or an exhausted window for up to maxWaitMs.
   * Throws BudgetPaused when the wait would be longer.
   */
  async take(consumer: string, resource = 'core'): Promise<void> {
    this.prune();
    const deadline = Date.now() + (this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    for (;;) {
      const r = await this.update((s, now) => {
        if (s.pausedUntil > now) return { wait: s.pausedUntil - now, kind: s.pauseKind ?? 'secondary_rate_limited' };
        const res = (s.resources[resource] ??= empty());
        if (res.remaining !== null && res.remaining <= 0) return { wait: (res.reset ?? 0) * 1000 - now, kind: 'rate_limited' as const };
        if (res.remaining !== null) res.remaining--;
        res.used[consumer] = (res.used[consumer] ?? 0) + 1;
        return null;
      });
      if (!r) return;
      if (Date.now() + r.wait > deadline) throw new BudgetPaused(r.kind, Math.max(1, Math.ceil(r.wait / 1000)));
      await sleep(Math.max(1, Math.min(r.wait, this.opts.pollMs ?? 1000)));
    }
  }

  /**
   * A response's X-RateLimit-* headers: a new window replaces what is known; within one, it can only go down. One try
   * at the lock, never a wait: a lost observation only leaves the budget a little high until the next.
   */
  observe(resource: string, headers: Headers): void {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const remaining = num(h['x-ratelimit-remaining']);
    const reset = num(h['x-ratelimit-reset']);
    if (remaining === null || remaining < 0 || reset === null || !plausibleReset(reset, Date.now())) return;
    const name = h['x-ratelimit-resource'] || resource;
    this.updateNow((s) => {
      const res = s.resources[name] ?? empty();
      if (res.reset === null || reset > res.reset) {
        s.resources[name] = { limit: num(h['x-ratelimit-limit']) ?? res.limit, remaining, reset, used: res.reset === null ? res.used : {} };
      } else if (reset === res.reset) {
        res.remaining = Math.min(res.remaining ?? remaining, remaining);
        s.resources[name] = res;
      }
      return null;
    });
  }

  /** Stop every caller on this credential for `seconds`, at most MAX_PAUSE_S. One try at the lock, never a wait. */
  pause(kind: PauseKind, seconds: number): void {
    const until = Date.now() + Math.min(MAX_PAUSE_S, Math.max(1, finite(seconds) ? seconds : SECONDARY_DEFAULT_S)) * 1000;
    this.updateNow((s) => {
      if (until > s.pausedUntil) Object.assign(s, { pausedUntil: until, pauseKind: kind });
      return null;
    });
  }

  private async update<T>(fn: (s: BudgetState, now: number) => T): Promise<T | null> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const lock = this.lock();
      if (lock) return this.under(lock, fn);
      if (Date.now() >= deadline) return null; // busy: let the call go rather than stop GitHub access
      await sleep(10);
    }
  }

  private updateNow<T>(fn: (s: BudgetState, now: number) => T): T | null {
    const lock = this.lock();
    return lock ? this.under(lock, fn) : null;
  }

  /** One try. A lock held longer than LOCK_STALE_MS is broken first: it is moved aside, and put back if it changed meanwhile. */
  private lock(path = this.lockPath): Lock | null {
    try {
      const r = tryLock(path, `github-budget pid ${process.pid}`);
      if ('lock' in r) return r.lock;
      const seen = readFileSync(path, 'utf8');
      const at = Date.parse((JSON.parse(seen) as { acquiredAt?: string }).acquiredAt ?? '');
      // Fresh only if dated within LOCK_STALE_MS of now, either way: a lock dated in the future is planted, not held.
      if (Number.isFinite(at) && Math.abs(Date.now() - at) <= LOCK_STALE_MS) return null;
      const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
      renameSync(path, aside);
      if (readFileSync(aside, 'utf8') !== seen) {
        try {
          linkSync(aside, path); // a fresh lock was taken in between: give it back
        } catch {
          // taken again since: theirs stands
        }
      }
      rmSync(aside, { force: true });
      const again = tryLock(path, `github-budget pid ${process.pid}`);
      return 'lock' in again ? again.lock : null;
    } catch {
      return null;
    }
  }

  /** Read, change and replace the state under the lock. A file system that refuses the write lets the call go. */
  private under<T>(lock: Lock, fn: (s: BudgetState, now: number) => T): T | null {
    try {
      const now = Date.now();
      const s = this.read(now);
      const out = fn(s, now);
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(s));
        chmodSync(tmp, 0o660);
        renameSync(tmp, this.file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      return out;
    } catch {
      return null;
    } finally {
      lock.release();
    }
  }

  /**
   * Remove other credentials' state files unchanged for PRUNE_AFTER_MS, each under its own lock (at most every
   * PRUNE_EVERY_MS per process). By then any pause or window in them has ended (MAX_PAUSE_S, MAX_WINDOW_S).
   */
  private prune(): void {
    const now = Date.now();
    if (now - (lastPrune.get(this.dir) ?? 0) < PRUNE_EVERY_MS) return;
    lastPrune.set(this.dir, now);
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^github-budget-([0-9a-f]{16})\.json$/.exec(name);
      if (!m || m[1] === this.key) continue;
      const file = join(this.dir, name);
      const old = () => {
        try {
          return now - statSync(file).mtimeMs > PRUNE_AFTER_MS;
        } catch {
          return false;
        }
      };
      if (!old()) continue;
      const lock = this.lock(join(this.dir, `github-budget-${m[1]}.lock`));
      if (!lock) continue;
      try {
        if (old()) rmSync(file, { force: true });
      } catch {
        // another user's file we may not remove: left
      } finally {
        lock.release();
      }
    }
  }
}

/** The machine's budget for this token. */
export function budgetFor(token: string, dir?: string, opts?: BudgetOptions): GitHubBudget {
  return new GitHubBudget(credentialKey(token), dir ?? defaultBudgetDir(), opts);
}

// One GitHub API budget per credential, shared by every process on the machine (coordinators of every instance,
// whatever user each runs as, dashboards, the updater), through files in the machine's slot directory (docs/slots.md):
//   <slots>/github-budget-<key>.json   the state: per resource, GitHub's last word on what is left and when it resets,
//                                      the calls granted since, by consumer; and a pause over every resource
//   <slots>/github-budget-<key>.lock   held for a moment while one process reads, decides and writes the state
// <key> is a hash of the token, never the token. A call takes one unit before it is made (take), and every response's
// X-RateLimit-* headers lower what is left (observe); a secondary limit pauses every caller until it lifts (pause).
// INVARIANT: this decides only when a call runs, never what it does.
//
// Cross-user: the system slot directory is root:agent-slots 2770 (scripts/setup/machine.sh), with no sticky bit, so
// any coordinator user may create, rename over and remove files in it, but a file another user created is theirs. So
// the state is never written in place: a new copy (0660) is renamed over it. No subdirectory either: one made by one
// user would follow that user's umask and could shut the others out.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock, type Lock } from '../locks.js';
import { slotsDir } from '../os/index.js';

/** How long take() waits out a pause or an exhausted budget before refusing (the caller sees GitHub's own kind of error). */
export const DEFAULT_MAX_WAIT_MS = 10_000;
/** A secondary limit with no Retry-After: GitHub's documented minimum wait. */
export const SECONDARY_DEFAULT_S = 60;

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
const num = (v: string | undefined): number | null => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BudgetOptions {
  maxWaitMs?: number;
  pollMs?: number;
}

export class GitHubBudget {
  private readonly file: string;
  private readonly lockPath: string;

  constructor(
    readonly key: string,
    readonly dir: string = slotsDir(),
    private readonly opts: BudgetOptions = {},
  ) {
    this.file = join(dir, `github-budget-${key}.json`);
    this.lockPath = join(dir, `github-budget-${key}.lock`);
  }

  read(): BudgetState {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as BudgetState;
      if (s && typeof s === 'object' && s.resources && typeof s.resources === 'object' && typeof s.pausedUntil === 'number') return s;
    } catch {
      // missing or unreadable: start afresh
    }
    return { resources: {}, pausedUntil: 0 };
  }

  /**
   * Take one call from the budget for `consumer`, waiting out a pause or an exhausted window for up to maxWaitMs.
   * Throws BudgetPaused when the wait would be longer.
   */
  async take(consumer: string, resource = 'core'): Promise<void> {
    const deadline = Date.now() + (this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    for (;;) {
      const r = await this.update((s, now) => {
        if (s.pausedUntil > now) return { wait: s.pausedUntil - now, kind: s.pauseKind ?? 'secondary_rate_limited' };
        let res = s.resources[resource] ?? empty();
        if (res.reset !== null && res.reset * 1000 <= now) res = empty(); // the window reset: unknown until GitHub says
        s.resources[resource] = res;
        if (res.remaining !== null && res.remaining <= 0) return { wait: Math.max(1, (res.reset ?? 0) * 1000 - now), kind: 'rate_limited' as const };
        if (res.remaining !== null) res.remaining--;
        res.used[consumer] = (res.used[consumer] ?? 0) + 1;
        return null;
      });
      if (!r) return;
      const now = Date.now();
      if (now + r.wait > deadline) throw new BudgetPaused(r.kind, Math.ceil(r.wait / 1000));
      await sleep(Math.min(r.wait, this.opts.pollMs ?? 1000));
    }
  }

  /** A response's X-RateLimit-* headers: a new window replaces what is known; within one, it can only go down. */
  observe(resource: string, headers: Headers): void {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const remaining = num(h['x-ratelimit-remaining']);
    const reset = num(h['x-ratelimit-reset']);
    if (remaining === null || reset === null) return;
    const name = h['x-ratelimit-resource'] || resource;
    this.updateSync((s) => {
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

  /** Stop every caller on this credential for `seconds` (a secondary limit, or a limit with only a Retry-After). */
  pause(kind: PauseKind, seconds: number): void {
    const until = Date.now() + Math.max(1, seconds) * 1000;
    this.updateSync((s) => {
      if (until > s.pausedUntil) Object.assign(s, { pausedUntil: until, pauseKind: kind });
      return null;
    });
  }

  private async update<T>(fn: (s: BudgetState, now: number) => T): Promise<T | null> {
    for (let i = 0; i < 200; i++) {
      const lock = this.lock();
      if (lock) return this.under(lock, fn);
      await sleep(10);
    }
    return null; // held for 2 s by a live process: let the call go rather than stop GitHub access
  }

  private updateSync<T>(fn: (s: BudgetState, now: number) => T): T | null {
    for (let i = 0; i < 200; i++) {
      const lock = this.lock();
      if (lock) return this.under(lock, fn);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return null;
  }

  private lock(): Lock | null {
    try {
      const r = tryLock(this.lockPath, `github-budget pid ${process.pid}`);
      return 'lock' in r ? r.lock : null;
    } catch {
      return null;
    }
  }

  /** Read, change and replace the state under the lock. A file system that refuses the write lets the call go. */
  private under<T>(lock: Lock, fn: (s: BudgetState, now: number) => T): T | null {
    try {
      const s = this.read();
      const out = fn(s, Date.now());
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
}

/** The machine's budget for this token. */
export function budgetFor(token: string, dir?: string, opts?: BudgetOptions): GitHubBudget {
  return new GitHubBudget(credentialKey(token), dir ?? slotsDir(), opts);
}

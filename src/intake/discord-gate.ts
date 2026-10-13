// The machine-wide identify gate for Discord gateway sessions. Several instances on one machine may use the same
// bot token (one bot installed in several servers): each opens its own gateway session and identifies on its own,
// and Discord limits identifies per token, not per process:
// - one identify per 5 seconds per rate-limit bucket (shard_id % max_concurrency). Every instance's session is
//   unsharded (shard 0), so all of them share bucket 0 whatever max_concurrency is: one identify per 5 s per token;
// - a daily number of session starts (session_start_limit.remaining, from GET /gateway/bot), shared by every
//   session on the token: none left, no identify until it resets.
// So every identify on the machine goes through one lock file in the machine-wide slot directory (shared by every
// instance's coordinator user): holding it, the gate reads when this token last identified (by a hash of the
// token, never the token), waits out the 5 s, asks Discord how many session starts are left, records the time and
// lets the identify go. Two instances starting at once identify one after the other, at least 5 s apart.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock, type Lock } from '../locks.js';

/** The least time between two identifies on one token (Discord: one per 5 s per bucket; every session here is shard 0). */
export const IDENTIFY_SPACING_MS = 5_000;
export const GATE_LOCK = 'discord-identify.lock';
export const GATE_STATE = 'discord-identify.json';
/** How long a gate waits for the lock before trying again later (a holder holds it a few seconds at most). */
const LOCK_WAIT_MS = 120_000;

/** GET /gateway/bot's session_start_limit. */
export interface SessionStartLimit {
  total?: number;
  remaining: number;
  reset_after: number;
  max_concurrency: number;
}

export type GateResult = { ok: true } | { ok: false; retryInMs: number; why: string };

export interface IdentifyGateOptions {
  /** The machine-wide directory (the agent slot directory: every instance's coordinator can write it). */
  dir: string;
  /** The bot token; only a hash of it keys the gate's state. */
  token: string;
  /** Who holds the lock, as the lock file says. */
  owner: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The token's session_start_limit (GET /gateway/bot), or null when unknown (a failed call: the 5 s spacing still holds). */
  limit?: () => Promise<SessionStartLimit | null>;
}

/** The key a token's state is kept under: a short hash, never the token. */
export const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16);

type GateState = Record<string, { last: number }>;

function readState(file: string): GateState {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as GateState) : {};
  } catch {
    return {};
  }
}

/**
 * The gate one adapter calls before each identify: resolves once this identify may go (`ok`), or says when to try
 * again (the daily session starts are used up, or the lock could not be had).
 */
export function identifyGate(o: IdentifyGateOptions): () => Promise<GateResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const key = tokenKey(o.token);
  const lockPath = join(o.dir, GATE_LOCK);
  const stateFile = join(o.dir, GATE_STATE);
  return async () => {
    mkdirSync(o.dir, { recursive: true });
    let lock: Lock | null = null;
    const start = now();
    while (!lock) {
      const r = tryLock(lockPath, o.owner);
      if ('lock' in r) lock = r.lock;
      else if (now() - start > LOCK_WAIT_MS) return { ok: false, retryInMs: IDENTIFY_SPACING_MS, why: 'the identify lock stayed held' };
      else await sleep(250);
    }
    try {
      const last = readState(stateFile)[key]?.last ?? 0;
      const wait = last + IDENTIFY_SPACING_MS - now();
      if (wait > 0) await sleep(wait);
      let limit: SessionStartLimit | null = null;
      try {
        limit = (await o.limit?.()) ?? null;
      } catch {
        limit = null;
      }
      if (limit && limit.remaining <= 0) return { ok: false, retryInMs: Math.max(IDENTIFY_SPACING_MS, Math.min(limit.reset_after, 24 * 3600_000)), why: 'the daily session start limit is used up' };
      const state = readState(stateFile);
      state[key] = { last: now() };
      // Whole or not at all: a reader never sees half a file.
      const tmp = `${stateFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, stateFile);
      return { ok: true };
    } finally {
      lock.release();
    }
  };
}

/** session_start_limit from GET /gateway/bot, with the bot's token; null on any failure. */
export async function sessionStartLimit(token: string, f: typeof fetch = fetch, api = 'https://discord.com/api/v10'): Promise<SessionStartLimit | null> {
  const r = await f(`${api}/gateway/bot`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const body = (await r.json()) as { session_start_limit?: Partial<SessionStartLimit> };
  const l = body.session_start_limit;
  if (!l || typeof l.remaining !== 'number' || typeof l.reset_after !== 'number') return null;
  return { remaining: l.remaining, reset_after: l.reset_after, max_concurrency: typeof l.max_concurrency === 'number' ? l.max_concurrency : 1, ...(typeof l.total === 'number' ? { total: l.total } : {}) };
}

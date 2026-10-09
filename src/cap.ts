// The adaptive agent cap, shared by every instance on the machine. It lives
// in the slot directory next to the slots it limits:
//   config.json          {"max_agents": N, "adaptive": {...}}  adaptive is opt-in
//   cap.json             the cap in force, why, and the last evaluation
//   cap-log.jsonl        every change, with its reason
//   signals/<name>.json  what each instance (and the operator) reports
// One evaluation runs at a time (cap.lock), at most every interval_min.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { tryLock } from './locks.js';

export const AdaptiveConfig = z.strictObject({
  start: z.number().int().min(1).default(2),
  floor: z.number().int().min(1).default(2),
  ceiling: z.number().int().min(1).default(8),
  interval_min: z.number().min(1).default(15),
  raise_cooldown_min: z.number().min(0).default(60),
  usage_window_h: z.number().min(0).default(5),
  min_free_mem_gb: z.number().min(0).default(8),
  max_prs_waiting: z.number().int().min(1).default(5),
  stale_signal_min: z.number().min(1).default(30),
  min_verdicts: z.number().int().min(2).default(20),
});
export type AdaptiveConfig = z.infer<typeof AdaptiveConfig>;

export interface Signals {
  instance: string;
  at: string;
  lastUsageLimitAt: string | null;
  prsWaiting: number | null;
  /** Recent evaluator verdicts, oldest first. */
  verdicts: { at: string; pass: boolean }[];
}

export type ConditionState = 'pass' | 'fail' | 'unknown';
export interface Condition {
  name: 'usage limit' | 'free memory' | 'PRs waiting' | 'evaluator pass rate';
  state: ConditionState;
  detail: string;
}

export interface CapState {
  cap: number;
  floor: number;
  ceiling: number;
  changedAt: string;
  reason: string;
  checkedAt: string;
  conditions: Condition[];
}

/** Decide the next cap. Pure: everything it needs is passed in. */
export function decide(cfg: AdaptiveConfig, prev: CapState | null, signals: Signals[], memFreeGb: number | null, now: Date): CapState {
  const t = now.getTime();
  const h = 3_600_000;
  const cap = prev?.cap ?? Math.min(Math.max(cfg.start, cfg.floor), cfg.ceiling);
  const instances = signals.filter((s) => s.instance !== '_operator');
  const stale = instances.filter((s) => t - Date.parse(s.at) > cfg.stale_signal_min * 60_000).map((s) => s.instance);
  const conditions: Condition[] = [];

  const limits = signals.map((s) => s.lastUsageLimitAt).filter((x): x is string => !!x).map(Date.parse);
  const lastLimit = limits.length ? Math.max(...limits) : null;
  if (lastLimit !== null && t - lastLimit < cfg.usage_window_h * h) conditions.push({ name: 'usage limit', state: 'fail', detail: `hit ${((t - lastLimit) / h).toFixed(1)}h ago (window ${cfg.usage_window_h}h)` });
  else if (!instances.length || stale.length) conditions.push({ name: 'usage limit', state: 'unknown', detail: instances.length ? `no recent report from ${stale.join(', ')}` : 'no instance reporting' });
  else conditions.push({ name: 'usage limit', state: 'pass', detail: lastLimit ? `last hit ${((t - lastLimit) / h).toFixed(1)}h ago` : 'none recorded' });

  if (memFreeGb === null) conditions.push({ name: 'free memory', state: 'unknown', detail: 'not measurable here' });
  else conditions.push({ name: 'free memory', state: memFreeGb > cfg.min_free_mem_gb ? 'pass' : 'fail', detail: `${memFreeGb.toFixed(1)} GB available (need > ${cfg.min_free_mem_gb})` });

  const prs = instances.map((s) => s.prsWaiting);
  if (!instances.length || stale.length || prs.some((p) => p === null)) conditions.push({ name: 'PRs waiting', state: 'unknown', detail: 'not every instance reported' });
  else {
    const n = prs.reduce<number>((a, b) => a + (b ?? 0), 0);
    conditions.push({ name: 'PRs waiting', state: n < cfg.max_prs_waiting ? 'pass' : 'fail', detail: `${n} waiting on you (limit ${cfg.max_prs_waiting})` });
  }

  const verdicts = instances.flatMap((s) => s.verdicts).sort((a, b) => a.at.localeCompare(b.at));
  if (verdicts.length < cfg.min_verdicts) conditions.push({ name: 'evaluator pass rate', state: 'unknown', detail: `${verdicts.length} verdicts (need ${cfg.min_verdicts})` });
  else {
    const rate = (xs: { pass: boolean }[]) => xs.filter((v) => v.pass).length / xs.length;
    const last = rate(verdicts.slice(-10));
    const before = rate(verdicts.slice(-20, -10));
    conditions.push({ name: 'evaluator pass rate', state: last >= before ? 'pass' : 'fail', detail: `last 10 ${Math.round(last * 100)}%, previous 10 ${Math.round(before * 100)}%` });
  }

  const failed = conditions.filter((c) => c.state === 'fail');
  const base = { floor: cfg.floor, ceiling: cfg.ceiling, checkedAt: now.toISOString(), conditions };
  // The first evaluation records the start; moves come from later evaluations, after a full interval.
  if (!prev) return { ...base, cap, changedAt: now.toISOString(), reason: `start at ${cap}` };
  // Holding keeps the last change's reason; the conditions say what stands in the way now.
  const keep = (): CapState => ({ ...base, cap, changedAt: prev?.changedAt ?? now.toISOString(), reason: prev?.reason ?? `start at ${cap}` });
  if (failed.length) {
    // Any breach drops by one, down to the floor.
    if (cap > cfg.floor) return { ...base, cap: cap - 1, changedAt: now.toISOString(), reason: `dropped: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}` };
    return keep();
  }
  if (conditions.some((c) => c.state === 'unknown') || cap >= cfg.ceiling) return keep();
  if (prev && t - Date.parse(prev.changedAt) < cfg.raise_cooldown_min * 60_000) return keep();
  return { ...base, cap: cap + 1, changedAt: now.toISOString(), reason: 'raised: no usage limit, memory free, few PRs waiting, pass rate not falling' };
}

export function readCapState(dir: string): CapState | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8')) as CapState;
  } catch {
    return null;
  }
}

export function adaptiveConfig(dir: string): AdaptiveConfig | null {
  try {
    const raw = (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { adaptive?: unknown }).adaptive;
    return raw === undefined ? null : AdaptiveConfig.parse(raw);
  } catch {
    return null;
  }
}

const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

export function publishSignals(dir: string, s: Signals): void {
  mkdirSync(join(dir, 'signals'), { recursive: true });
  writeAtomic(join(dir, 'signals', `${s.instance}.json`), JSON.stringify(s));
}

export function readSignals(dir: string): Signals[] {
  try {
    return readdirSync(join(dir, 'signals'))
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(dir, 'signals', f), 'utf8')) as Signals];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** The operator hit a usage limit outside the harness (an interactive session). */
export function noteLimit(dir: string, now = new Date()): void {
  publishSignals(dir, { instance: '_operator', at: now.toISOString(), lastUsageLimitAt: now.toISOString(), prsWaiting: 0, verdicts: [] });
}

/**
 * Evaluate the cap if adaptive is on and the interval has passed, under a lock
 * so only one process decides. Returns the change, if the cap moved.
 */
export function evaluateCap(dir: string, memFreeGb: number | null, now = new Date()): { from: number; to: number; reason: string } | null {
  const cfg = adaptiveConfig(dir);
  if (!cfg) return null;
  const lock = tryLock(join(dir, 'cap.lock'), 'cap evaluator');
  if (!('lock' in lock)) return null;
  try {
    const prev = readCapState(dir);
    if (prev && now.getTime() - Date.parse(prev.checkedAt) < cfg.interval_min * 60_000) return null;
    const next = decide(cfg, prev, readSignals(dir), memFreeGb, now);
    writeAtomic(join(dir, 'cap.json'), JSON.stringify(next, null, 2));
    const from = prev?.cap ?? null;
    if (from === next.cap) return null;
    const change = { from: from ?? next.cap, to: next.cap, reason: from === null ? `start at ${next.cap}` : next.reason };
    appendFileSync(join(dir, 'cap-log.jsonl'), `${JSON.stringify({ at: now.toISOString(), ...change })}\n`);
    return from === null ? null : change;
  } finally {
    lock.lock.release();
  }
}

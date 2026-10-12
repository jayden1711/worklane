// One test run, start to end: queue for a test slot, take the full-run lock shared (waiting for an exclusive holder,
// never failing on one), make the workspace, run the tiers, wipe, record. docs/test-runs.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '../events/log.js';
import type { EventPayload, EventType } from '../events/types.js';
import { redact } from '../events/redact.js';
import { holdFlock, type HeldFlock } from '../os/index.js';
import { BRAND } from '../brand.js';
import type { Lock } from '../locks.js';
import { cacheDirs } from './cache.js';
import type { TestRunConfig, TestRunTier } from './config.js';
import { newRunId, type RunDatabase, type RunHost } from './host.js';
import { waitTestSlot } from './slots.js';
import { createWorkspace, runEnv } from './workspace.js';

export interface TestRunRequest {
  repo: string;
  sha: string;
  kind: 'fast' | 'full';
  prs: number[];
  changedFiles?: string[];
  /** This shard of a sharded full run: `index` is 1-based (1..total). */
  shard?: { index: number; total: number };
}
export interface TierResult {
  tier: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  logRef: string;
}
export interface TestRunResult {
  id: string;
  sha: string;
  kind: 'fast' | 'full';
  ok: boolean;
  tiers: TierResult[];
}

/** The machine-wide full-run lock: test runs take it shared, agents' and other full runs exclusive. */
export const FULL_RUN_LOCK = `/run/lock/${BRAND.cli}-full-run.lock`;

export interface TestRunDeps {
  config: TestRunConfig;
  host: RunHost;
  /** The coordinator's clone, where `sha` is (fetched already). */
  repo: string;
  log: EventLog;
  actor: string;
  /** Where each tier's full log goes: the instance's private state. */
  logDir: string;
  lockPath?: string;
  slotsDir?: string;
  slotPollMs?: number;
  /** Taking the lock (tests inject one). */
  lock?: (path: string, signal?: AbortSignal) => Promise<HeldFlock>;
  now?: () => number;
}

/** The tiers a request runs: its kind's, and of a sharded run's later shards only the shardable ones. */
export function tiersFor(c: TestRunConfig, req: Pick<TestRunRequest, 'kind' | 'shard'>): TestRunTier[] {
  return c.tiers.filter((t) => t.kind === req.kind && (!req.shard || req.shard.index === 1 || t.shardable));
}

/** A tier's command with its placeholders filled; null when it needs the change's files and has none. */
export function tierCommand(t: TestRunTier, shard: { index: number; total: number }, changedFilesPath: string | null): string | null {
  if (t.command.includes('{changed_files}') && changedFilesPath === null) return null;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return t.command
    .replaceAll('{changed_files}', changedFilesPath === null ? '' : q(changedFilesPath))
    .replaceAll('{shard_index}', String(shard.index))
    .replaceAll('{shard_total}', String(shard.total))
    .replaceAll('{shard}', String(shard.index))
    .replaceAll('{total}', String(shard.total));
}

const tail = (out: string, lines = 20) => String(redact(out.trim().split('\n').slice(-lines).join('\n'))).slice(-1800);

export function validateRequest(req: TestRunRequest): void {
  if (!/^[0-9a-f]{7,40}$/.test(req.sha)) throw new Error(`not a commit: ${req.sha}`);
  if (req.kind !== 'fast' && req.kind !== 'full') throw new Error(`a run is fast or full, not ${String(req.kind)}`);
  if (!Array.isArray(req.prs) || req.prs.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('prs are PR numbers');
  if (req.shard) {
    const { index, total } = req.shard;
    if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 1 || index > total) throw new Error(`shard.index is 1-based, 1..${total}; got ${index}`);
  }
}

/**
 * Run one test run. Waits for a slot and then the lock as long as either takes (until `signal` aborts: a
 * superseded run), wipes the run whatever happens, and records every step. Never throws for a test failure, a
 * setup failure or a cancellation: those are the result (ok false). Throws only for a bad request.
 */
export async function runTestRun(d: TestRunDeps, req: TestRunRequest, o: { signal?: AbortSignal; id?: string } = {}): Promise<TestRunResult> {
  validateRequest(req);
  const now = d.now ?? Date.now;
  const id = o.id ?? newRunId(req.kind, req.sha);
  const emit = <T extends EventType>(type: T, payload: EventPayload<T>) => d.log.append(type, payload, d.actor);
  const tiers = tiersFor(d.config, req);
  const shard = req.shard ?? { index: 1, total: 1 };
  emit('testrun.queued', { id, sha: req.sha, kind: req.kind, prs: req.prs, shard: req.shard ?? null });
  const results: TierResult[] = [];
  const failAll = (summary: string, from = 0) => {
    for (const t of tiers.slice(from)) if (!results.some((r) => r.tier === t.name)) results.push({ tier: t.name, ok: false, durationMs: 0, summary, logRef: '' });
  };
  let slot: Lock | null = null;
  let lock: HeldFlock | null = null;
  let created = false;
  let outcome: EventPayload<'testrun.finished'>['outcome'] = 'done';
  let detail = '';
  try {
    slot = await waitTestSlot(`${d.actor} test run ${id}`, { ...(d.slotsDir ? { dir: d.slotsDir } : {}), ...(d.slotPollMs ? { pollMs: d.slotPollMs } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    const waitFrom = now();
    lock = await (d.lock ?? ((p, s) => holdFlock(p, 'shared', s)))(d.lockPath ?? FULL_RUN_LOCK, o.signal);
    emit('testrun.started', { id, slot: slot.path.split(/[\\/]/).pop()!.replace('.lock', ''), lock_wait_ms: Math.max(0, now() - waitFrom) });
    created = true;
    await createWorkspace(d.host, d.repo, req.sha, id);
    const changed = req.changedFiles ? await d.host.changedFiles(id, req.changedFiles) : null;
    const caches = await cacheDirs(d.config.caches, d.repo, req.sha, (n, k) => d.host.cache(n, k));
    for (const s of d.config.shared) caches[s.env] = await d.host.shared(s.name);
    let db: RunDatabase | null = null;
    if (d.config.database && tiers.some((t) => t.database)) db = await d.host.startDb(id, { image: d.config.database.image, name: d.config.database.name, readyS: d.config.database.ready_timeout_s });
    const baseEnv = runEnv(d.config.env, caches, null);
    const dbEnv = runEnv(d.config.env, caches, db);
    mkdirSync(join(d.logDir, id), { recursive: true, mode: 0o700 });
    let setupFailed = false;
    for (const [i, step] of d.config.setup.entries()) {
      if (o.signal?.aborted) break;
      const r = await d.host.exec(id, step, baseEnv, 1800_000, o.signal);
      writeFileSync(join(d.logDir, id, `setup-${i + 1}.log`), r.out, { mode: 0o600 });
      if (r.code !== 0) {
        setupFailed = true;
        failAll(`setup step ${i + 1} (${step}) failed (exit ${r.code ?? 'killed'}):\n${tail(r.out)}`);
        break;
      }
    }
    for (const t of tiers) {
      if (setupFailed) break; // every tier already failed
      if (o.signal?.aborted) break;
      const command = tierCommand(t, shard, changed);
      if (command === null) {
        results.push({ tier: t.name, ok: false, durationMs: 0, summary: 'needs the change\'s files ({changed_files}) and the run was given none', logRef: '' });
        continue;
      }
      const start = now();
      const r = await d.host.exec(id, command, t.database ? dbEnv : baseEnv, t.timeout_s * 1000, o.signal);
      const logRef = `${id}/${t.name}.log`;
      writeFileSync(join(d.logDir, logRef), r.out, { mode: 0o600 });
      const tr = { tier: t.name, ok: r.code === 0, durationMs: Math.max(0, now() - start), summary: r.code === null ? `timed out or cancelled\n${tail(r.out)}` : tail(r.out), logRef };
      results.push(tr);
      emit('testrun.tier', { id, tier: t.name, ok: tr.ok, duration_ms: tr.durationMs, summary: tr.summary.slice(0, 2000), log_ref: logRef, cpu_s: r.stats?.cpuS ?? null, mem_peak_mb: r.stats?.memPeakMb ?? null });
    }
    if (o.signal?.aborted) {
      outcome = 'cancelled';
      detail = 'superseded or cancelled';
      failAll('cancelled');
    }
  } catch (e) {
    outcome = o.signal?.aborted ? 'cancelled' : 'error';
    detail = String(redact((e as Error).message)).slice(0, 1500);
    failAll(outcome === 'cancelled' ? 'cancelled' : `the run couldn't go ahead: ${detail}`);
  } finally {
    if (created) {
      const w = await d.host.wipe(id).catch((e: Error) => ({ ok: false, left: [e.message.slice(0, 200)] }));
      if (!w.ok) emit('testrun.wipe_failed', { id, left: w.left.slice(0, 20) });
    }
    await lock?.release();
    slot?.release();
  }
  const ok = outcome === 'done' && tiers.length > 0 && results.length === tiers.length && results.every((r) => r.ok);
  if (!tiers.length) detail = `no ${req.kind} tiers in tests.yaml test_run`;
  emit('testrun.finished', { id, sha: req.sha, kind: req.kind, prs: req.prs, ok, outcome, results: results.map((r) => ({ tier: r.tier, ok: r.ok })), detail });
  return { id, sha: req.sha, kind: req.kind, ok, tiers: results };
}

/** A sharded full run's shards as one result: each tier passes only if it passed in every shard that ran it. */
export function mergeShards(results: readonly TestRunResult[]): TestRunResult {
  if (!results.length) throw new Error('no shards to merge');
  const first = results[0]!;
  if (results.some((r) => r.sha !== first.sha || r.kind !== first.kind)) throw new Error('shards of different runs');
  const byTier = new Map<string, TierResult[]>();
  for (const r of results) for (const t of r.tiers) byTier.set(t.tier, [...(byTier.get(t.tier) ?? []), t]);
  const tiers = [...byTier.entries()].map(([tier, ts]) => ({
    tier,
    ok: ts.every((t) => t.ok),
    durationMs: Math.max(...ts.map((t) => t.durationMs)),
    summary: ts.filter((t) => !t.ok).map((t) => t.summary).join('\n---\n') || ts[0]!.summary,
    logRef: ts.map((t) => t.logRef).filter(Boolean).join(' '),
  }));
  return { id: results.map((r) => r.id).join('+'), sha: first.sha, kind: first.kind, ok: results.every((r) => r.ok), tiers };
}

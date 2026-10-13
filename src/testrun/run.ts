// One test run, start to end: queue for a test slot, take the full-run lock shared (waiting for an exclusive holder,
// never failing on one), make the workspace, run the tiers, wipe, record. docs/test-runs.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '../events/log.js';
import type { EventPayload, EventType } from '../events/types.js';
import { redact, redactString } from '../events/redact.js';
import { holdFlock, type HeldFlock } from '../os/index.js';
import { BRAND } from '../brand.js';
import type { Lock } from '../locks.js';
import { recordable } from '../test-durations.js';
import { cacheDirs } from './cache.js';
import type { TestRunConfig, TestRunTier } from './config.js';
import type { HelperState } from './helper.js';
import { newRunId, SetupStepError, type RunDatabase, type RunHost } from './host.js';
import { waitTestSlot } from './slots.js';
import { createWorkspace, runEnv } from './workspace.js';
import { configBehind, missingReferencedPath, oldHeadFailure, type Predates } from './predates.js';
import type { Plan } from './affected.js';
import { importsPlan, selectMode, testsArg } from './select.js';

export interface TestRunRequest {
  repo: string;
  sha: string;
  kind: 'fast' | 'full';
  prs: number[];
  changedFiles?: string[];
  /** This shard of a sharded full run: `index` is 1-based (1..total). */
  shard?: { index: number; total: number };
  /** Only these tiers, of either kind, unsharded (the deploy gate's post-merge run); absent: the kind's tiers. */
  tiers?: string[];
}
export interface TierResult {
  tier: string;
  ok: boolean;
  durationMs: number;
  /** What the check shows of it: its last output lines (redacted), or why it didn't run. */
  summary: string;
  logRef: string;
  /** The PR's head is older than the test-run config and can't run this tier as configured (./predates.ts). */
  predates?: Predates;
}
export interface TestRunResult {
  id: string;
  sha: string;
  kind: 'fast' | 'full';
  ok: boolean;
  tiers: TierResult[];
  /**
   * How the run ended, as testrun.finished records it: `done` is a verdict on the code (ok says which); `cancelled`
   * (superseded, dropped, the coordinator stopping) and `error` (the run couldn't go ahead) are none. A cancel during
   * a tier and that tier timing out both fail it, so only this tells them apart.
   */
  outcome: 'done' | 'cancelled' | 'error';
  /**
   * The setup step that failed, when one did (the helper's version, the workspace, a cache, the database, a setup
   * command): what the posted check says, with the end of that step's stderr, redacted. Never its stdout.
   */
  setup?: SetupFailure;
}

export interface SetupFailure {
  /** helper, create, changed-files, caches, shared, db-start, or "setup step <n> (<command>)". */
  step: string;
  detail: string;
  /** The last lines of its stderr, redacted; '' when it said nothing there. */
  stderr: string;
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
  /** The helper's protocol, asked once at coordinator start (./helper.ts): when not ok, no run starts. */
  helper?: HelperState;
  /** test_run.select: imports's plan for a change (tests inject one); default ./select.ts importsPlan. */
  plan?: (repo: string, sha: string, changed: readonly string[]) => Plan;
}

/**
 * What a run hands {tests} (test_run.select: imports): the test files a PR's fast run can affect, or null for the
 * whole suite (a full run, a run given no changed files, a plan that can't tell or fails), with the line its checks
 * show. Never fails the run: the whole suite is always a safe answer.
 */
export function selectionFor(d: Pick<TestRunDeps, 'config' | 'repo' | 'plan'>, req: Pick<TestRunRequest, 'kind' | 'sha' | 'changedFiles' | 'tiers'>): { tests: string[] | null; line: string } {
  const whole = (why: string) => ({ tests: null, line: `test selection (imports): the whole suite, ${why}` });
  if (selectMode(d.config) !== 'imports') return { tests: null, line: '' };
  if (req.kind !== 'fast' || req.tiers) return whole('a full run');
  if (!req.changedFiles) return whole('the run was given no changed files');
  try {
    const p = (d.plan ?? importsPlan)(d.repo, req.sha, req.changedFiles);
    if (p.all) return whole(p.all);
    return { tests: p.tests, line: `test selection (imports): ${p.tests.length} test file(s) this change can affect` };
  } catch (e) {
    return whole(`the plan failed: ${String(redact((e as Error).message)).slice(0, 300)}`);
  }
}

/** The tiers a request runs: its kind's, and of a sharded run's later shards only the shardable ones. */
export function tiersFor(c: TestRunConfig, req: Pick<TestRunRequest, 'kind' | 'shard' | 'tiers'>): TestRunTier[] {
  if (req.tiers) return c.tiers.filter((t) => req.tiers!.includes(t.name));
  return c.tiers.filter((t) => t.kind === req.kind && (!req.shard || req.shard.index === 1 || t.shardable));
}

/**
 * A tier's command with its placeholders filled; null when it needs the change's files and has none. `tests` fills
 * {tests}: the selected test files, or null (nothing) for the whole suite.
 */
export function tierCommand(t: TestRunTier, shard: { index: number; total: number }, changedFilesPath: string | null, tests: readonly string[] | null = null): string | null {
  if (t.command.includes('{changed_files}') && changedFilesPath === null) return null;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return t.command
    .replaceAll('{changed_files}', changedFilesPath === null ? '' : q(changedFilesPath))
    .replaceAll('{tests}', testsArg(tests))
    .replaceAll('{shard_index}', String(shard.index))
    .replaceAll('{shard_total}', String(shard.total))
    .replaceAll('{shard}', String(shard.index))
    .replaceAll('{total}', String(shard.total));
}

const tail = (out: string, lines = 20) => String(redact(out.trim().split('\n').slice(-lines).join('\n'))).slice(-1800);
/**
 * A tier's last lines, as its check shows them. The whole output is redacted first, so a secret that spans lines (a
 * private key) is masked even when only its end is in the last lines.
 */
export const TIER_LINES = 30;
export const lastLines = (out: string, lines = TIER_LINES) => redactString(out).trim().split('\n').slice(-lines).join('\n').slice(-4000);

export function validateRequest(req: TestRunRequest): void {
  if (!/^[0-9a-f]{7,40}$/.test(req.sha)) throw new Error(`not a commit: ${req.sha}`);
  if (req.kind !== 'fast' && req.kind !== 'full') throw new Error(`a run is fast or full, not ${String(req.kind)}`);
  if (!Array.isArray(req.prs) || req.prs.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('prs are PR numbers');
  if (req.tiers !== undefined && (!Array.isArray(req.tiers) || !req.tiers.length || req.tiers.some((t) => typeof t !== 'string' || !t))) throw new Error('tiers names at least one tier');
  if (req.tiers && req.shard) throw new Error('a run of named tiers is never sharded');
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
  // An outdated helper: nothing is started (no slot, no lock, no workspace), and the result says why and the fix.
  if (d.helper && !d.helper.ok) {
    const setup: SetupFailure = { step: 'helper', detail: String(redact(d.helper.detail)).slice(0, 1500), stderr: tail(d.helper.stderr) };
    failAll(`not run: ${setup.detail}`);
    emit('testrun.finished', { id, sha: req.sha, kind: req.kind, prs: req.prs, ok: false, outcome: 'error', results: results.map((r) => ({ tier: r.tier, ok: r.ok })), detail: setup.detail });
    return { id, sha: req.sha, kind: req.kind, ok: false, tiers: results, outcome: 'error', setup };
  }
  let slot: Lock | null = null;
  let lock: HeldFlock | null = null;
  let created = false;
  let outcome: TestRunResult['outcome'] = 'done';
  let detail = '';
  let setup: SetupFailure | undefined;
  // The step in progress, for a failure that doesn't name its own.
  let stage = 'slot';
  try {
    slot = await waitTestSlot(`${d.actor} test run ${id}`, { ...(d.slotsDir ? { dir: d.slotsDir } : {}), ...(d.slotPollMs ? { pollMs: d.slotPollMs } : {}), ...(o.signal ? { signal: o.signal } : {}) });
    const waitFrom = now();
    lock = await (d.lock ?? ((p, s) => holdFlock(p, 'shared', s)))(d.lockPath ?? FULL_RUN_LOCK, o.signal);
    emit('testrun.started', { id, slot: slot.path.split(/[\\/]/).pop()!.replace('.lock', ''), lock_wait_ms: Math.max(0, now() - waitFrom) });
    created = true;
    stage = 'create';
    await createWorkspace(d.host, d.repo, req.sha, id);
    stage = 'changed-files';
    const changed = req.changedFiles ? await d.host.changedFiles(id, req.changedFiles) : null;
    stage = 'caches';
    const caches = await cacheDirs(d.config.caches, d.repo, req.sha, (n, k) => d.host.cache(n, k));
    stage = 'shared';
    for (const s of d.config.shared) caches[s.env] = await d.host.shared(s.name);
    let db: RunDatabase | null = null;
    stage = 'db-start';
    if (d.config.database && tiers.some((t) => t.database)) db = await d.host.startDb(id, { image: d.config.database.image, name: d.config.database.name, readyS: d.config.database.ready_timeout_s, maxConnections: d.config.database.max_connections });
    const baseEnv = runEnv(d.config.env, caches, null);
    const dbEnv = runEnv(d.config.env, caches, db);
    mkdirSync(join(d.logDir, id), { recursive: true, mode: 0o700 });
    let setupFailed = false;
    stage = 'setup';
    for (const [i, step] of d.config.setup.entries()) {
      if (o.signal?.aborted) break;
      const r = await d.host.exec(id, step, baseEnv, 1800_000, o.signal);
      writeFileSync(join(d.logDir, id, `setup-${i + 1}.log`), r.out, { mode: 0o600 });
      if (r.code !== 0) {
        setupFailed = true;
        setup = { step: `setup step ${i + 1} (${step})`, detail: `exit ${r.code ?? 'killed'}`, stderr: tail(r.err ?? '') };
        failAll(`setup step ${i + 1} (${step}) failed (exit ${r.code ?? 'killed'}):\n${tail(r.out)}`);
        break;
      }
    }
    const selection = tiers.some((t) => t.command.includes('{tests}')) ? selectionFor(d, req) : { tests: null, line: '' };
    stage = 'tiers';
    // The config commit, when this head is older than it (null otherwise): only then can a tier predate the config.
    let behind: string | null = null;
    try {
      behind = configBehind(d.repo, req.sha);
    } catch {
      // no evidence of an old head
    }
    for (const t of tiers) {
      if (setupFailed) break; // every tier already failed
      if (o.signal?.aborted) break;
      const command = tierCommand(t, shard, changed, selection.tests);
      const selects = t.command.includes('{tests}') && selection.line !== '';
      // Selection found no test file the change can affect: nothing to run, and the check says so.
      if (selects && selection.tests?.length === 0) {
        const tr: TierResult = { tier: t.name, ok: true, durationMs: 0, summary: `${selection.line}: none, so nothing ran`, logRef: '' };
        results.push(tr);
        emit('testrun.tier', { id, tier: t.name, ok: true, duration_ms: 0, summary: tr.summary, log_ref: '', cpu_s: null, mem_peak_mb: null });
        continue;
      }
      if (command === null) {
        results.push({ tier: t.name, ok: false, durationMs: 0, summary: 'needs the change\'s files ({changed_files}) and the run was given none', logRef: '' });
        continue;
      }
      // A file the command calls that this old head doesn't have: not run (it could only fail), and the check says why.
      const missing = behind ? missingReferencedPath(d.repo, req.sha, behind, t.command) : null;
      if (behind && missing) {
        const predates: Predates = { configCommit: behind, what: `\`${missing}\` is not in this PR's head`, notRun: true };
        const tr: TierResult = { tier: t.name, ok: false, durationMs: 0, summary: `not run: ${predates.what} (the test-run config is from ${behind.slice(0, 10)})`, logRef: '', predates };
        results.push(tr);
        emit('testrun.tier', { id, tier: t.name, ok: false, duration_ms: 0, summary: tr.summary.slice(0, 2000), log_ref: '', cpu_s: null, mem_peak_mb: null });
        continue;
      }
      const start = now();
      const r = await d.host.exec(id, command, t.database ? dbEnv : baseEnv, t.timeout_s * 1000, o.signal);
      const logRef = `${id}/${t.name}.log`;
      writeFileSync(join(d.logDir, logRef), r.out, { mode: 0o600 });
      const out = r.code === null ? `timed out or cancelled\n${lastLines(r.out)}` : lastLines(r.out);
      const tr: TierResult = { tier: t.name, ok: r.code === 0, durationMs: Math.max(0, now() - start), summary: selects ? `${selection.line}\n${out}` : out, logRef };
      const old = behind && !tr.ok ? oldHeadFailure(command, r.code, r.out) : null;
      if (behind && old) tr.predates = { configCommit: behind, what: old, notRun: false };
      results.push(tr);
      emit('testrun.tier', { id, tier: t.name, ok: tr.ok, duration_ms: tr.durationMs, summary: tr.summary.slice(0, 2000), log_ref: logRef, cpu_s: r.stats?.cpuS ?? null, mem_peak_mb: r.stats?.memPeakMb ?? null });
      // Its per-test durations, for the metrics' slow tests (src/test-durations.ts): names and times only, never output.
      const durations = recordable(r.out);
      emit('testrun.durations', { id, tier: t.name, tests: durations.tests, parsed: durations.parsed });
    }
    if (o.signal?.aborted) {
      outcome = 'cancelled';
      detail = 'superseded or cancelled';
      failAll('cancelled');
    }
  } catch (e) {
    outcome = o.signal?.aborted ? 'cancelled' : 'error';
    detail = String(redact((e as Error).message)).slice(0, 1500);
    if (outcome === 'error' && stage !== 'slot' && stage !== 'tiers') setup = e instanceof SetupStepError ? { step: e.step, detail: String(redact(e.what)), stderr: tail(e.stderr) } : { step: stage, detail, stderr: '' };
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
  return { id, sha: req.sha, kind: req.kind, ok, tiers: results, outcome, ...(setup ? { setup } : {}) };
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
    ...(ts.find((t) => t.predates) ? { predates: ts.find((t) => t.predates)!.predates! } : {}),
  }));
  // Any shard without a verdict leaves the whole run without one.
  const outcome = results.find((r) => r.outcome !== 'done')?.outcome ?? 'done';
  const setup = results.find((r) => r.setup)?.setup;
  return { id: results.map((r) => r.id).join('+'), sha: first.sha, kind: first.kind, ok: results.every((r) => r.ok), tiers, outcome, ...(setup ? { setup } : {}) };
}

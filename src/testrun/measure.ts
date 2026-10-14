// WHY: `<cli> testrun measure` (docs/test-runs.md "Measuring a setting") times one test_run env value through the
// same sandboxed path a PR's run takes (runTestRun: slot, shared full-run lock, workspace, caches, database, the
// helper's per-run limits, wipe), never by running a project's tests outside the sandbox.

// INVARIANT: a measure run can never post a check or touch a PR. This module takes no checks dependency, no token
// and no fetch, so nothing here can reach GitHub (test/testrun-measure.test.ts). Its runs' testrun.* events stay in
// memory; the log gets only `testrun.measure`, which the PR runs, the batcher and the test-run view never read.

// INVARIANT: nothing starts until the request, the instance's quiet and the helper have all been checked: a
// refusal makes no workspace and calls no helper.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '../events/log.js';
import type { EventPayload, EventType, StoredEvent } from '../events/types.js';
import { flockHeld, flockHolders, type HeldFlock } from '../os/index.js';
import { projectEnvProblem } from '../project-env.js';
import { recordable } from '../test-durations.js';
import type { TestRunConfig } from './config.js';
import { checkHelper } from './helper.js';
import type { RunHost } from './host.js';
import { FULL_RUN_LOCK, runTestRun, type TestRunResult } from './run.js';
import { testSlotsHeld } from './slots.js';
import { testRunStatus } from './status.js';

/** A measure request refused before anything started. The message says why; nothing was made or called. */
export class MeasureRefused extends Error {}

/** At most this many values in one `--set`: each is a whole run, one after another. */
export const MAX_VALUES = 12;
/** A value: a plain token, never a quote, space, comma or `=` (nothing that could read as a second variable). */
const VALUE = /^[A-Za-z0-9._:/@%+-]{1,200}$/;
/** A key as tests.yaml spells one: ASCII only, so a look-alike letter or a stray space never matches. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** What the host itself sets for every command (src/testrun/host.ts exec), beyond what projectEnvProblem reserves. */
const HOST_SET = ['DATABASE_URL', 'CI', 'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'];

/** The keys the engine sets for a run, never a measure's to change: the host's, the database's, the caches' and the shared directories'. */
export function engineSetKeys(c: Pick<TestRunConfig, 'caches' | 'shared'>): string[] {
  return [...HOST_SET, ...c.caches.map((x) => x.env), ...c.shared.map((x) => x.env)];
}

export interface MeasurePlan {
  sha: string;
  tiers: string[];
  key: string;
  values: string[];
  /** The kind the run is recorded as: full when a named tier is. Named tiers run unsharded either way. */
  kind: 'fast' | 'full';
}

/**
 * Check a measure request against the project's test_run config, before anything starts. `sets`: every `--set`
 * given, as written. Throws MeasureRefused with the reason; returns what to run otherwise.
 */
export function planMeasure(c: TestRunConfig, req: { sha: string; tiers: string[]; sets: string[] }): MeasurePlan {
  const refuse = (why: string): never => {
    throw new MeasureRefused(`${why}; nothing was started`);
  };
  if (!/^[0-9a-f]{7,40}$/.test(req.sha)) refuse(`--sha: not a commit id: ${JSON.stringify(req.sha)}`);
  if (!req.tiers.length) refuse('--tier names at least one tier of tests.yaml test_run');
  for (const t of req.tiers) {
    const tier = c.tiers.find((x) => x.name === t);
    if (!tier) refuse(`--tier ${JSON.stringify(t)}: not a tier of tests.yaml test_run (its tiers: ${c.tiers.map((x) => x.name).join(', ')})`);
    // WHY: a measure has no change, so {changed_files} has nothing to list and the tier could only fail.
    if (tier!.command.includes('{changed_files}')) refuse(`--tier ${t}: its command needs a change's files ({changed_files}), and a measure has no change`);
  }
  if (req.sets.length !== 1) refuse(`exactly one --set KEY=V1,V2,... (got ${req.sets.length})`);
  const set = req.sets[0]!;
  const eq = set.indexOf('=');
  if (eq < 0) refuse(`--set ${JSON.stringify(set)}: KEY=V1,V2,...`);
  const key = set.slice(0, eq);
  const rest = set.slice(eq + 1);
  if (!KEY.test(key)) refuse(`--set: ${JSON.stringify(key)} is not a variable name (ASCII letters, digits and _ only)`);
  const engine = engineSetKeys(c);
  if (engine.some((k) => k.toUpperCase() === key.toUpperCase())) refuse(`--set ${key}: set by the engine for every run, never by a measure`);
  const reserved = projectEnvProblem(key);
  if (reserved) refuse(`--set ${key}: ${reserved}`);
  // INVARIANT: exactly a key tests.yaml already sets: never a new one, and never another spelling or casing of one.
  if (!Object.hasOwn(c.env, key)) refuse(`--set ${key}: not a key of tests.yaml test_run env (its keys: ${Object.keys(c.env).join(', ') || 'none'})`);
  const values = rest.split(',');
  if (values.length > MAX_VALUES) refuse(`--set ${key}: at most ${MAX_VALUES} values`);
  for (const v of values) if (!VALUE.test(v)) refuse(`--set ${key}: ${JSON.stringify(v)} is not a value (1-200 of A-Z a-z 0-9 . _ : / @ % + -; no empty value, space, quote or =)`);
  const kind = req.tiers.some((t) => c.tiers.find((x) => x.name === t)!.kind === 'full') ? 'full' : 'fast';
  return { sha: req.sha, tiers: [...new Set(req.tiers)], key, values, kind };
}

/**
 * Why the machine isn't quiet enough to measure, or null when it is: a test run of this instance queued or running
 * (from its event log), any test slot held on the machine, or the full-run lock held (or a holder this can't rule out).
 */
export function busyReason(events: readonly StoredEvent[], o: { slotsDir?: string; lockPath?: string } = {}): string | null {
  const st = testRunStatus(events);
  const inFlight = [...st.queue, ...st.running];
  if (inFlight.length) return `this instance has ${inFlight.length} test run(s) in flight (${inFlight.map((r) => `${r.id} ${r.state}`).join(', ')})`;
  const slots = testSlotsHeld(o.slotsDir);
  if (slots.length) return `${slots.length} test slot(s) are held on this machine (${slots.map((s) => `${s.slot}: ${s.owner}`).join('; ')})`;
  const lock = o.lockPath ?? FULL_RUN_LOCK;
  // WHY: flockHeld calls a missing file free, but no run can take a lock that isn't there (holdFlock rejects).
  if (!existsSync(lock)) return `${lock} is missing: the machine's locks aren't set up`;
  const holders = flockHolders(lock);
  if (holders === null) {
    const held = flockHeld(lock);
    if (held === null) return `can't tell whether ${lock} is held`;
    if (held) return `${lock} is held (a full run)`;
  } else if (holders.length) return `${lock} is held (${holders.map((h) => `pid ${h.pid} ${h.mode}`).join(', ')})`;
  return null;
}

/** Per-suite durations a runner prints as `⏱ <name>: 12.3s` lines; else its per-test ones (src/test-durations.ts). */
export function suiteDurations(out: string): { name: string; ms: number }[] {
  const suites: { name: string; ms: number }[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const m = /^\s*⏱️?\s*(.+?):\s*(\d+(?:\.\d+)?)\s*(ms|s)\b/.exec(line);
    if (m) suites.push({ name: m[1]!.slice(0, 300), ms: Math.round(Number(m[2]) * (m[3] === 's' ? 1000 : 1)) });
  }
  const list = suites.length ? suites : recordable(out).tests;
  return [...list].sort((a, b) => b.ms - a.ms);
}

export interface MeasureTier {
  tier: string;
  /** passed, failed, timed out (or cancelled), or not run. */
  status: 'passed' | 'failed' | 'timed out' | 'not run';
  durationMs: number;
  /** The sandbox unit's CPU time and peak memory (systemd-run's summary); null where the host can't tell. */
  cpuS: number | null;
  memPeakMb: number | null;
  /** cpuS over the tier's wall time: how many cores it kept busy on average. */
  avgCores: number | null;
  suites: { name: string; ms: number }[];
}

export interface MeasureValue {
  key: string;
  value: string;
  runId: string;
  ok: boolean;
  outcome: TestRunResult['outcome'];
  wallMs: number;
  tiers: MeasureTier[];
  /** The setup step that failed, if one did. */
  setup?: string;
}

export interface MeasureDeps {
  instance: string;
  config: TestRunConfig;
  host: RunHost;
  /** The instance's checkout, where the commit is. */
  repo: string;
  /** The instance's event log: read for its runs in flight, written only with testrun.measure. */
  log: Pick<EventLog, 'append' | 'read'>;
  actor: string;
  /** Where the runs' tier logs go (the instance's private state). */
  logDir: string;
  sparseExclude?: readonly string[];
  lockPath?: string;
  slotsDir?: string;
  slotPollMs?: number;
  lock?: (path: string, signal?: AbortSignal) => Promise<HeldFlock>;
  now?: () => number;
  /** Each value's result as it finishes. */
  onValue?: (v: MeasureValue) => void;
  signal?: AbortSignal;
}

const runIdFor = (sha: string) => `measure-${sha.slice(0, 10)}-${randomBytes(4).toString('hex')}`;

/** An event log that keeps a run's testrun.* events in memory: they never reach the instance's log. */
function memorySink(): { log: Pick<EventLog, 'append'>; events: { type: string; payload: unknown }[] } {
  const events: { type: string; payload: unknown }[] = [];
  let n = 0;
  const log = {
    append<T extends EventType>(type: T, payload: EventPayload<T>, actor: string): StoredEvent<T> {
      events.push({ type, payload });
      return { id: ++n, ts: new Date().toISOString(), type, payload, actor, source: 'coordinator' } as unknown as StoredEvent<T>;
    },
  };
  return { log, events };
}

/**
 * Run the plan's tiers once per value, one after another, each a full sandboxed run with the key set to that value.
 * Refuses (MeasureRefused, nothing started) while the machine is busy or the helper is outdated or fails its check.
 * Stops before the next value when the machine became busy meanwhile, or on `signal` (the run going is cancelled and
 * wiped by runTestRun).
 */
export async function runMeasure(d: MeasureDeps, plan: MeasurePlan): Promise<{ values: MeasureValue[]; stopped: string | null }> {
  const now = d.now ?? Date.now;
  const busy = () => busyReason(d.log.read(0, ['testrun.queued', 'testrun.started', 'testrun.finished']), { ...(d.slotsDir ? { slotsDir: d.slotsDir } : {}), ...(d.lockPath ? { lockPath: d.lockPath } : {}) });
  const first = busy();
  if (first) throw new MeasureRefused(`the machine is busy: ${first}. Run it when the box is idle; nothing was started`);
  const helper = await checkHelper(d.host, d.instance);
  if (!helper.ok) throw new MeasureRefused(`${helper.detail}; nothing was started`);
  if (d.host.kind === 'sandbox') {
    const checked = await d.host.check().catch((e: Error) => ({ ok: false, detail: `the check didn't run: ${e.message}` }));
    if (!checked.ok) throw new MeasureRefused(`the sandbox failed its check: ${checked.detail.split('\n')[0]}; nothing was started`);
  }
  const id = `m-${randomBytes(6).toString('hex')}`;
  const emit = (p: Omit<EventPayload<'testrun.measure'>, 'id' | 'sha' | 'key'>) => d.log.append('testrun.measure', { id, sha: plan.sha, key: plan.key, ...p }, d.actor);
  // WHY: a measure killed mid-run left its workspace (the coordinator's recover only knows its own runs).
  for (const left of unfinishedMeasureRuns(d.log.read(0, ['testrun.measure']))) {
    const w = await d.host.wipe(left).catch((e: Error) => ({ ok: false, left: [e.message.slice(0, 200)] }));
    emit({ phase: 'recovered', value: null, run_id: left, ok: w.ok, wall_ms: null, tiers: [], detail: w.ok ? 'wiped what a stopped measure left' : `not wiped: ${w.left.join(', ').slice(0, 1500)}` });
  }
  emit({ phase: 'started', value: null, run_id: null, ok: null, wall_ms: null, tiers: [], detail: `tiers ${plan.tiers.join(',')}; values ${plan.values.join(',')}` });
  const values: MeasureValue[] = [];
  let stopped: string | null = null;
  // WHY: one value at a time, never in parallel: two runs at once would measure each other's load, not the value.
  for (const value of plan.values) {
    if (d.signal?.aborted) {
      stopped = 'cancelled';
      break;
    }
    const why = values.length ? busy() : null;
    if (why) {
      stopped = `the machine became busy: ${why}`;
      break;
    }
    const runId = runIdFor(plan.sha);
    emit({ phase: 'run_started', value, run_id: runId, ok: null, wall_ms: null, tiers: [], detail: '' });
    const sink = memorySink();
    const config: TestRunConfig = { ...d.config, env: { ...d.config.env, [plan.key]: value } };
    const t0 = now();
    const result = await runTestRun(
      { config, host: d.host, repo: d.repo, log: sink.log, actor: d.actor, logDir: d.logDir, helper, ...(d.sparseExclude ? { sparseExclude: d.sparseExclude } : {}), ...(d.lockPath ? { lockPath: d.lockPath } : {}), ...(d.slotsDir ? { slotsDir: d.slotsDir } : {}), ...(d.slotPollMs ? { slotPollMs: d.slotPollMs } : {}), ...(d.lock ? { lock: d.lock } : {}), ...(d.now ? { now: d.now } : {}) },
      { repo: d.repo, sha: plan.sha, kind: plan.kind, prs: [], tiers: plan.tiers },
      { id: runId, ...(d.signal ? { signal: d.signal } : {}) },
    );
    const wallMs = Math.max(0, now() - t0);
    const v: MeasureValue = { key: plan.key, value, runId, ok: result.ok, outcome: result.outcome, wallMs, tiers: tiersOf(result, sink.events, d.logDir), ...(result.setup ? { setup: `${result.setup.step}: ${result.setup.detail}` } : {}) };
    values.push(v);
    emit({ phase: 'run_finished', value, run_id: runId, ok: v.ok, wall_ms: wallMs, tiers: v.tiers.map((t) => ({ tier: t.tier, status: t.status, duration_ms: t.durationMs, cpu_s: t.cpuS, mem_peak_mb: t.memPeakMb })), detail: (v.setup ?? result.outcome).slice(0, 2000) });
    d.onValue?.(v);
    if (result.outcome === 'cancelled') {
      stopped = 'cancelled';
      break;
    }
  }
  emit({ phase: stopped ? 'stopped' : 'finished', value: null, run_id: null, ok: null, wall_ms: null, tiers: [], detail: (stopped ?? `${values.length} value(s) measured`).slice(0, 2000) });
  return { values, stopped };
}

/** Measure runs started and never finished (the measure was killed): their run ids, to wipe. */
export function unfinishedMeasureRuns(events: readonly StoredEvent[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type !== 'testrun.measure') continue;
    const p = e.payload as EventPayload<'testrun.measure'>;
    if (!p.run_id) continue;
    if (p.phase === 'run_started') open.add(p.run_id);
    else open.delete(p.run_id);
  }
  return [...open];
}

function tiersOf(result: TestRunResult, events: { type: string; payload: unknown }[], logDir: string): MeasureTier[] {
  return result.tiers.map((t) => {
    const ev = events.filter((e) => e.type === 'testrun.tier').map((e) => e.payload as EventPayload<'testrun.tier'>).find((p) => p.tier === t.tier);
    let out = '';
    try {
      if (t.logRef) out = readFileSync(join(logDir, t.logRef), 'utf8');
    } catch {
      // WHY: a tier that never ran has no log, so it has no suites to show.
    }
    const status: MeasureTier['status'] = !ev ? 'not run' : t.ok ? 'passed' : t.summary.startsWith('timed out or cancelled') ? 'timed out' : 'failed';
    const cpuS = ev?.cpu_s ?? null;
    const avgCores = cpuS !== null && t.durationMs > 0 ? Math.round((cpuS / (t.durationMs / 1000)) * 10) / 10 : null;
    return { tier: t.tier, status, durationMs: t.durationMs, cpuS, memPeakMb: ev?.mem_peak_mb ?? null, avgCores, suites: suiteDurations(out) };
  });
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One value's line: wall time, then each tier's status, time, CPU and memory, and its slowest suites. */
export function measureLine(v: MeasureValue, suitesShown = 8): string {
  const tiers = v.tiers.map((t) => {
    const use = [t.cpuS !== null ? `cpu ${t.cpuS.toFixed(1)}s` : 'cpu n/a', t.avgCores !== null ? `${t.avgCores} cores avg` : null, t.memPeakMb !== null ? `mem peak ${Math.round(t.memPeakMb)} MB` : 'mem n/a'].filter(Boolean).join(', ');
    const suites = t.suites.length ? `; suites: ${t.suites.slice(0, suitesShown).map((s) => `${s.name} ${secs(s.ms)}`).join(', ')}${t.suites.length > suitesShown ? `, +${t.suites.length - suitesShown} more` : ''}` : '';
    return `${t.tier} ${t.status} in ${secs(t.durationMs)} (${use})${suites}`;
  });
  return `${v.key}=${v.value}  wall ${secs(v.wallMs)}  ${v.outcome === 'done' ? (v.ok ? 'ok' : 'FAILED') : v.outcome}  ${tiers.join(' | ')}${v.setup ? `  setup failed: ${v.setup}` : ''}  [run ${v.runId}]`;
}

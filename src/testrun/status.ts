// The test runs' state, folded from the event log: the queue, the runs going, the recent results, what each tier
// takes, and the two things that stop them working (a sandbox that failed its check, an App that can't post checks).
// For health and the dashboard; viewers get viewerTestRuns, tier pass or fail only.
import type { EventPayload, StoredEvent } from '../events/types.js';

export interface TestRunRow {
  id: string;
  sha: string;
  kind: 'fast' | 'full';
  prs: number[];
  shard: { index: number; total: number } | null;
  state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  slot: string | null;
  lockWaitMs: number | null;
  /** Each tier's outcome so far (or at the end). */
  tiers: { tier: string; ok: boolean; durationMs: number | null; summary?: string; logRef?: string }[];
}

export interface TierStats {
  tier: string;
  runs: number;
  medianMs: number;
  /** The largest peak memory and CPU time a run of it recorded (the sandbox reports them), null when none did. */
  peakMemMb: number | null;
  maxCpuS: number | null;
}

export interface TestRunStatus {
  sandbox: { ok: boolean; detail: string; at: string } | null;
  checksPermission: { level: 'write' | 'read' | 'none' | 'unknown'; detail: string; at: string } | null;
  /** The last attempt to post checks failed for want of the permission, and none posted since. */
  checksBlocked: { detail: string; at: string } | null;
  queue: TestRunRow[];
  running: TestRunRow[];
  recent: TestRunRow[];
  tierStats: TierStats[];
  wipeFailures: { id: string; left: string[]; at: string }[];
  /** Plain statements of what keeps test runs from working; empty when nothing does. */
  problems: string[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export function testRunStatus(events: readonly StoredEvent[], recentN = 30): TestRunStatus {
  const rows = new Map<string, TestRunRow>();
  const st: TestRunStatus = { sandbox: null, checksPermission: null, checksBlocked: null, queue: [], running: [], recent: [], tierStats: [], wipeFailures: [], problems: [] };
  const tierRuns = new Map<string, { ms: number[]; mem: number[]; cpu: number[] }>();
  for (const e of events) {
    switch (e.type) {
      case 'testrun.queued': {
        const p = e.payload as EventPayload<'testrun.queued'>;
        rows.set(p.id, { id: p.id, sha: p.sha, kind: p.kind, prs: p.prs, shard: p.shard, state: 'queued', queuedAt: e.ts, startedAt: null, finishedAt: null, slot: null, lockWaitMs: null, tiers: [] });
        break;
      }
      case 'testrun.started': {
        const p = e.payload as EventPayload<'testrun.started'>;
        const r = rows.get(p.id);
        if (r) Object.assign(r, { state: 'running', startedAt: e.ts, slot: p.slot, lockWaitMs: p.lock_wait_ms });
        break;
      }
      case 'testrun.tier': {
        const p = e.payload as EventPayload<'testrun.tier'>;
        rows.get(p.id)?.tiers.push({ tier: p.tier, ok: p.ok, durationMs: p.duration_ms, summary: p.summary, logRef: p.log_ref });
        const t = tierRuns.get(p.tier) ?? { ms: [], mem: [], cpu: [] };
        t.ms.push(p.duration_ms);
        if (p.mem_peak_mb !== null) t.mem.push(p.mem_peak_mb);
        if (p.cpu_s !== null) t.cpu.push(p.cpu_s);
        tierRuns.set(p.tier, t);
        break;
      }
      case 'testrun.finished': {
        const p = e.payload as EventPayload<'testrun.finished'>;
        const r = rows.get(p.id);
        if (!r) break;
        r.finishedAt = e.ts;
        r.state = p.outcome === 'cancelled' ? 'cancelled' : p.outcome === 'interrupted' ? 'interrupted' : p.ok ? 'passed' : 'failed';
        // Tiers that never ran (setup failed, cancelled) appear from the final results.
        for (const x of p.results) if (!r.tiers.some((t) => t.tier === x.tier)) r.tiers.push({ tier: x.tier, ok: x.ok, durationMs: null });
        break;
      }
      case 'testrun.wipe_failed': {
        const p = e.payload as EventPayload<'testrun.wipe_failed'>;
        st.wipeFailures.push({ id: p.id, left: p.left, at: e.ts });
        break;
      }
      case 'testrun.sandbox': {
        const p = e.payload as EventPayload<'testrun.sandbox'>;
        st.sandbox = { ok: p.ok, detail: p.detail, at: e.ts };
        break;
      }
      case 'testrun.checks_permission': {
        const p = e.payload as EventPayload<'testrun.checks_permission'>;
        st.checksPermission = { level: p.level, detail: p.detail, at: e.ts };
        break;
      }
      case 'testrun.checks_failed': {
        const p = e.payload as EventPayload<'testrun.checks_failed'>;
        if (p.reason === 'no_permission') st.checksBlocked = { detail: p.detail, at: e.ts };
        break;
      }
      case 'testrun.checks_posted':
        st.checksBlocked = null;
        break;
    }
  }
  const all = [...rows.values()];
  st.queue = all.filter((r) => r.state === 'queued');
  st.running = all.filter((r) => r.state === 'running');
  st.recent = all.filter((r) => r.finishedAt).slice(-recentN).reverse();
  st.tierStats = [...tierRuns.entries()].map(([tier, t]) => ({ tier, runs: t.ms.length, medianMs: median(t.ms), peakMemMb: t.mem.length ? Math.max(...t.mem) : null, maxCpuS: t.cpu.length ? Math.max(...t.cpu) : null }));
  st.wipeFailures = st.wipeFailures.slice(-10);
  if (st.sandbox && !st.sandbox.ok) st.problems.push(`Test runs are off: the sandbox failed its check (${st.sandbox.detail.split('\n')[0]}). An admin runs scripts/setup/test-user.sh check, fixes the FAIL lines, then restarts the instance.`);
  const cannotPost = st.checksBlocked ?? (st.checksPermission && st.checksPermission.level !== 'write' && st.checksPermission.level !== 'unknown' ? st.checksPermission : null);
  if (cannotPost) st.problems.push(`Test runs can't post their checks: the App has no Checks: write permission${st.checksPermission ? ` (it has ${st.checksPermission.level})` : ''}. The owner adds Checks: read & write in the App's settings and accepts it on the installation; until then results are only on the dashboard.`);
  if (st.wipeFailures.length) st.problems.push(`A test run was not wiped completely (${st.wipeFailures.at(-1)!.id}: ${st.wipeFailures.at(-1)!.left.slice(0, 3).join(', ')}).`);
  return st;
}

/** What a viewer sees of the test runs: each run's commit, PRs, state and tiers' pass or fail. Never a log, summary or slot. */
export function viewerTestRuns(s: TestRunStatus) {
  const row = (r: TestRunRow) => ({ id: r.id, sha: r.sha, kind: r.kind, prs: r.prs, state: r.state, tiers: r.tiers.map((t) => ({ tier: t.tier, ok: t.ok })) });
  return { queue: s.queue.map(row), running: s.running.map(row), recent: s.recent.map(row) };
}

export interface TestRunsViewInput {
  events: readonly StoredEvent[];
  /** tests.yaml has a test_run section. */
  configured: boolean;
  /** Whether this person is an owner or writer (else a viewer). */
  writer: boolean;
  cap: number;
  slots: { slot: string; owner: string; acquiredAt: string }[];
  lock: { path: string; holders: { pid: number; mode: 'shared' | 'exclusive' }[] | null };
}

/**
 * The test runs as the dashboard shows them. Owners and writers: the queue, the running slots and their holders,
 * the full-run lock's holders, results with each tier's summary, per-tier figures, and the problems. A viewer: the
 * runs' commits, PRs, states and tiers' pass or fail, and the slot counts; never a log, summary, holder or problem.
 */
export function testRunsView(i: TestRunsViewInput) {
  const s = testRunStatus(i.events);
  const base = { configured: i.configured, cap: i.cap, inUse: i.slots.length };
  if (!i.writer) return { ...base, viewer: true as const, ...viewerTestRuns(s) };
  return {
    ...base,
    viewer: false as const,
    slots: i.slots,
    lock: i.lock,
    queue: s.queue,
    running: s.running,
    recent: s.recent,
    tierStats: s.tierStats,
    sandbox: s.sandbox,
    checksPermission: s.checksPermission,
    problems: s.problems,
  };
}

// The coordinator's test runs (src/testrun/): the queue, the slots running, who holds the full-run lock, and each
// run's tiers. On the Board compactly, on the Machine page in full. A viewer is sent each run's tiers' pass or fail
// and the slot counts only (src/testrun/status.ts testRunsView): no log, summary, slot holder or lock holder.
import { useEffect, useState } from 'react';
import { useView } from '../api';
import { DotPill, RecordsTable } from './patterns';
import { ago, cx } from './ui';

export interface TestRunTierRow {
  tier: string;
  ok: boolean;
  durationMs?: number | null;
  summary?: string;
  /** Only for a tier that asked for the GPU: whether the sandbox granted it. */
  gpu?: { granted: boolean; devices: string[]; detail: string };
}
export interface TestRunRowData {
  id: string;
  sha: string;
  kind: 'fast' | 'full';
  prs: number[];
  state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
  tiers: TestRunTierRow[];
  queuedAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  slot?: string | null;
  lockWaitMs?: number | null;
  shard?: { index: number; total: number } | null;
  gpu?: 'planned' | null;
}
/** Root's GPU opt-in for this instance (src/testrun/status.ts gpuView): read-only; `change` is the root command. */
export type TestRunsGpu = { state: 'on'; devices: number[]; maxMinutes: number; change: string; status: string } | { state: 'off' | 'unknown'; why: string; change: string; status: string };
/** Root's network grants for this instance (src/testrun/status.ts networkView): read-only; `change` is the root command. */
export type TestRunsNetwork = { state: 'on'; tiers: string[]; change: string; status: string } | { state: 'off' | 'unknown'; why: string; change: string; status: string };
export interface TestRunsData {
  configured: boolean;
  viewer: boolean;
  cap: number;
  inUse: number;
  queue: TestRunRowData[];
  running: TestRunRowData[];
  recent: TestRunRowData[];
  slots?: { slot: string; owner: string; acquiredAt: string }[];
  lock?: { path: string; holders: { pid: number; mode: 'shared' | 'exclusive' }[] | null };
  tierStats?: { tier: string; runs: number; medianMs: number; peakMemMb: number | null; maxCpuS: number | null }[];
  problems?: string[];
  gpu?: TestRunsGpu;
  network?: TestRunsNetwork;
}

const STATE_TONE: Record<TestRunRowData['state'], 'green' | 'red' | 'orange' | 'ink'> = { queued: 'ink', running: 'orange', passed: 'green', failed: 'red', cancelled: 'ink', interrupted: 'red' };
const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? '–' : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);

/** Each tier's pass or fail, as small marks. */
function Tiers({ tiers }: { tiers: TestRunTierRow[] }) {
  if (!tiers.length) return <span className="text-[12px] text-ink-3">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tiers.map((t) => (
        <span key={t.tier} title={t.summary ? t.summary.split('\n').slice(-3).join('\n') : undefined} className={cx('rounded-full px-1.5 text-[11.5px] font-medium shadow-hairline', t.ok ? 'text-green' : 'text-red')} data-testid="test-run-tier" data-ok={t.ok ? 'yes' : 'no'}>
          {t.ok ? '✓' : '✗'} {t.tier}
          {t.gpu ? (
            <span className="ml-1 text-ink-3" title={t.gpu.granted ? `GPU: ${t.gpu.devices.join(' ')}; ${t.gpu.detail}` : `no GPU: ${t.gpu.detail}`} data-testid="test-run-tier-gpu" data-granted={t.gpu.granted ? 'yes' : 'no'}>
              {t.gpu.granted ? 'GPU' : 'no GPU'}
            </span>
          ) : null}
          {t.durationMs ? <span className="ml-1 text-ink-3 tabular-nums">{secs(t.durationMs)}</span> : null}
        </span>
      ))}
    </span>
  );
}

/** Root's GPU opt-in, read-only: only root changes it, with the command shown (docs/test-runs.md "GPU"). */
function GpuOptIn({ gpu }: { gpu: TestRunsGpu }) {
  return (
    <div className="text-[12px] text-ink-3" data-testid="test-runs-gpu" data-state={gpu.state}>
      <span className="text-ink-2">GPU for test runs: </span>
      {gpu.state === 'on' ? `on: GPU ${gpu.devices.join(', ')}, at most ${gpu.maxMinutes} min a GPU command, one run per GPU` : `${gpu.state === 'off' ? 'off' : 'unknown'} (${gpu.why})`}
      <span>. Only root changes it: </span>
      <code className="font-mono text-[11.5px] text-ink-2" data-testid="test-runs-gpu-command">
        {gpu.change}
      </code>
    </div>
  );
}

/** Root's network grants, read-only: a run has none unless root lists its tier (docs/test-runs.md "Network"). */
function NetworkGrants({ network }: { network: TestRunsNetwork }) {
  return (
    <div className="text-[12px] text-ink-3" data-testid="test-runs-network" data-state={network.state}>
      <span className="text-ink-2">Network for test runs: </span>
      {network.state === 'on' ? `none, except tiers ${network.tiers.join(', ')} (public addresses only)` : `none for every tier${network.state === 'unknown' ? ` (root's grants can't be read: ${network.why})` : ''}`}
      <span>. Only root changes it: </span>
      <code className="font-mono text-[11.5px] text-ink-2" data-testid="test-runs-network-command">
        {network.change}
      </code>
    </div>
  );
}

/** Who holds the full-run lock: test runs share it; an agent's (or other) full run holds it alone. */
export function lockLine(lock: TestRunsData['lock']): string {
  if (!lock) return '';
  if (!lock.holders) return `full-run lock ${lock.path}: holders not visible on this OS`;
  if (!lock.holders.length) return `full-run lock: free`;
  const ex = lock.holders.find((h) => h.mode === 'exclusive');
  return ex ? `full-run lock: held exclusively (pid ${ex.pid}); test runs wait for it` : `full-run lock: shared by ${lock.holders.length} test run${lock.holders.length === 1 ? '' : 's'}`;
}

function RunsTable({ rows, testId, compact }: { rows: TestRunRowData[]; testId: string; compact?: boolean }) {
  return (
    <RecordsTable testId={testId} head={compact ? ['Run', 'PRs', 'State', 'Tiers'] : ['Run', 'PRs', 'State', 'Tiers', 'When']} className="[&_th:nth-child(1)]:w-40 [&_th:nth-child(2)]:w-24 [&_th:nth-child(3)]:w-28">
      {rows.map((r) => (
        <tr key={r.id} className="border-b border-line align-top last:border-0" data-testid="test-run-row" data-state={r.state}>
          <td className="primitive-table-cell font-mono text-[12px] text-ink" title={r.id}>
            {r.kind} {r.sha.slice(0, 8)}
            {r.shard ? <span className="text-ink-3"> {r.shard.index}/{r.shard.total}</span> : null}
          </td>
          <td className="primitive-table-cell text-[12px] text-ink-2">{r.prs.length ? r.prs.map((n) => `#${n}`).join(' ') : '–'}</td>
          <td className="primitive-table-cell">
            <DotPill tone={STATE_TONE[r.state]}>{r.state}</DotPill>
            {r.slot ? <div className="mt-0.5 font-mono text-[11px] text-ink-3">{r.slot}</div> : null}
          </td>
          <td className="primitive-table-cell">
            <Tiers tiers={r.tiers} />
          </td>
          {compact ? null : <td className="primitive-table-cell text-[12px] text-ink-3">{r.finishedAt ?? r.startedAt ?? r.queuedAt ? ago(r.finishedAt ?? r.startedAt ?? r.queuedAt ?? null) : '–'}</td>}
        </tr>
      ))}
    </RecordsTable>
  );
}

/** The test runs from their data (also what the render checks render). `compact`: the Board's short form. */
export function TestRunsView({ data, compact = false }: { data: TestRunsData; compact?: boolean }) {
  if (!data.configured) {
    return (
      <section aria-label="Test runs" data-testid="test-runs" data-configured="no" className="text-[12.5px] text-ink-3">
        Test runs: off (no test_run in tests.yaml).
      </section>
    );
  }
  const live = [...data.running, ...data.queue];
  return (
    <section className="space-y-2" aria-label="Test runs" data-testid="test-runs" data-configured="yes">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Test runs</span>
        <span className="text-[12px] tabular-nums text-ink-3" data-testid="test-runs-counts">
          {data.inUse} of {data.cap} slots running, machine-wide · {data.queue.length} queued
          {data.lock ? ` · ${lockLine(data.lock)}` : ''}
        </span>
      </div>
      {!compact && data.gpu ? <GpuOptIn gpu={data.gpu} /> : null}
      {!compact && data.network ? <NetworkGrants network={data.network} /> : null}
      {data.problems?.map((p) => (
        <div key={p} className="rounded-control bg-[var(--red-tint)] px-2.5 py-2 text-[12.5px] text-ink" data-testid="test-runs-problem">
          {p}
        </div>
      ))}
      {live.length ? <RunsTable rows={live} testId="test-runs-live" compact={compact} /> : <div className="text-[12.5px] text-ink-3">No test run queued or running.</div>}
      {!compact && data.slots?.length ? (
        <RecordsTable testId="test-runs-slots" head={['Slot', 'Held by', 'Since']} className="[&_th:nth-child(1)]:w-28 [&_th:nth-child(3)]:w-32">
          {data.slots.map((s) => (
            <tr key={s.slot} className="border-b border-line last:border-0">
              <td className="primitive-table-cell font-mono text-[12px] text-ink">{s.slot}</td>
              <td className="primitive-table-cell truncate text-[12.5px] text-ink-2" title={s.owner}>
                {s.owner}
              </td>
              <td className="primitive-table-cell text-[12.5px] text-ink-3">{ago(s.acquiredAt)}</td>
            </tr>
          ))}
        </RecordsTable>
      ) : null}
      {data.recent.length ? (
        <div className="space-y-1">
          <div className="text-[12px] font-medium text-ink-2">Recent</div>
          <RunsTable rows={compact ? data.recent.slice(0, 5) : data.recent} testId="test-runs-recent" compact={compact} />
        </div>
      ) : null}
      {!compact && data.tierStats?.length ? (
        <RecordsTable testId="test-runs-tier-stats" head={['Tier', 'Runs', 'Median', 'Peak memory', 'Most CPU']}>
          {data.tierStats.map((t) => (
            <tr key={t.tier} className="border-b border-line last:border-0">
              <td className="primitive-table-cell text-[12.5px] text-ink">{t.tier}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{t.runs}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{secs(t.medianMs)}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{t.peakMemMb === null ? '–' : `${Math.round(t.peakMemMb)} MB`}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{t.maxCpuS === null ? '–' : `${t.maxCpuS} s`}</td>
            </tr>
          ))}
        </RecordsTable>
      ) : null}
      {data.viewer ? <div className="text-[12px] text-ink-3" data-testid="test-runs-viewer">Logs and what each run is waiting on are for the owners and writers.</div> : null}
    </section>
  );
}

/** Loads one instance's test runs (null: this page's own server), again whenever `pulse` changes. */
export function TestRunsPanel({ instance = null, pulse = 0, compact = false, onLoaded }: { instance?: string | null; pulse?: number; compact?: boolean; onLoaded?: () => void }) {
  // Shown at once from what was kept for this instance, then read again (web/src/cache.ts).
  const { data, error } = useView<TestRunsData>('/api/test-runs', pulse, instance);
  const answered = !!data || !!error;
  useEffect(() => {
    if (answered) onLoaded?.();
  }, [answered, onLoaded]);
  if (error && !data) return <div className="text-[12.5px] text-ink-3">Test runs: {error}</div>;
  return data ? <TestRunsView data={data} compact={compact} /> : null;
}

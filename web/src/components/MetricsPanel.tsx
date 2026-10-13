// Metrics (GET /api/metrics, src/merge-metrics.ts deliveryMetrics): merges per day, main red, time to green, fix-forward
// versus revert, PR CI wall-clock, agent startup, flake rate, and the slowest tests with those over the time budget.
// Over 7 days, the 30-day value under each. A figure whose source has recorded nothing yet says "not measured yet",
// never 0. Read-only; the owner's and the writers'.
import { useEffect, useState } from 'react';
import { api, type Measure, type Metrics, type MetricsWindow, type SlowTest, type State } from '../api';
import { MergedBars } from './ThroughputPanel';
import { Badge, Card } from './ui';

export const NOT_MEASURED = 'not measured yet';

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 1000) / 10}%`);
const mins = (n: number | null) => (n === null ? '–' : n < 1 ? `${Math.round(n * 60)} s` : `${n} min`);
const secs = (n: number | null) => (n === null ? '–' : n >= 120 ? `${Math.round(n / 6) / 10} min` : `${n} s`);
const dur = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} min` : ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms)} ms`);

type Key = Exclude<keyof MetricsWindow, 'days' | 'since'>;
type Of<K extends Key> = Extract<MetricsWindow[K], { measured: true }>;

interface Figure<K extends Key = Key> {
  key: K;
  label: string;
  value: (x: Of<K>) => string;
  sub?: (x: Of<K>) => string | null;
}
const fig = <K extends Key>(f: Figure<K>) => f as unknown as Figure;

const FIGURES: Figure[] = [
  fig({ key: 'merges', label: 'Merges per day', value: (x) => String(x.perDay), sub: (x) => `${x.total} merged` }),
  fig({ key: 'mainRed', label: 'Main red', value: (x) => String(x.count), sub: (x) => (x.stillRed ? 'red now' : null) }),
  fig({ key: 'timeToGreen', label: 'Time to green', value: (x) => mins(x.medianMinutes), sub: (x) => (x.minutes.length ? `median of ${x.minutes.length}` : null) }),
  fig({ key: 'reverts', label: 'Revert rate', value: (x) => pct(x.rate), sub: (x) => `${x.opened} opened, ${x.merged} merged` }),
  fig({ key: 'fixForward', label: 'Fix-forward success', value: (x) => pct(x.successRate), sub: (x) => `${x.fixed} of ${x.attempts} fixed` }),
  fig({ key: 'prCi', label: 'PR CI wall-clock', value: (x) => mins(x.medianMinutes), sub: (x) => (x.prs ? `median of ${x.prs}; p90 ${mins(x.p90Minutes)}` : null) }),
  fig({ key: 'startup', label: 'Agent startup', value: (x) => secs(x.medianSeconds), sub: (x) => (x.runs ? `median of ${x.runs}; p90 ${secs(x.p90Seconds)}` : null) }),
  fig({ key: 'flake', label: 'Flake rate', value: (x) => pct(x.rate), sub: (x) => `${x.flaky} of ${x.reruns} re-runs` }),
];

/** One figure: the last 7 days large, the last 30 under it; "not measured yet" with why when its source has nothing. */
function FigureCard({ f, w7, w30 }: { f: Figure; w7: MetricsWindow; w30: MetricsWindow }) {
  const a = w7[f.key] as Measure<object>;
  const b = w30[f.key] as Measure<object>;
  return (
    <Card className="min-w-0 p-3" data-testid="metrics-figure" data-figure={f.key} data-measured={String(a.measured)}>
      <div className="truncate text-[12px] font-medium text-ink-3">{f.label}</div>
      {a.measured && b.measured ? (
        <>
          <div className="mt-1 text-[22px] font-semibold tracking-tight tabular-nums text-ink" data-testid="metrics-figure-7">
            {f.value(a as Of<Key>)}
          </div>
          {f.sub?.(a as Of<Key>) && <div className="truncate text-[11.5px] text-ink-3">{f.sub(a as Of<Key>)}</div>}
          <div className="mt-1.5 border-t border-line pt-1.5 text-[12px] tabular-nums text-ink-2" data-testid="metrics-figure-30">
            30 days: <span className="font-medium text-ink">{f.value(b as Of<Key>)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="mt-1 text-[15px] font-medium text-ink-3" data-testid="metrics-not-measured">
            {NOT_MEASURED}
          </div>
          <div className="text-[11.5px] leading-4 text-ink-3">{(a.measured ? (b as { why: string }) : (a as { why: string })).why}</div>
        </>
      )}
    </Card>
  );
}

function TestList({ tests, testId }: { tests: SlowTest[]; testId: string }) {
  return (
    <ol className="divide-y divide-line">
      {tests.map((t, i) => (
        <li key={t.name} className="flex items-baseline gap-3 py-1.5 text-[12.5px]" data-testid={testId}>
          <span className="w-5 shrink-0 text-right tabular-nums text-ink-3">{i + 1}</span>
          <span className="min-w-0 flex-1 break-words font-mono text-[12px] text-ink">{t.name}</span>
          <span className="shrink-0 tabular-nums text-ink-2" title={`median of ${t.runs} run${t.runs === 1 ? '' : 's'}; slowest ${dur(t.maxMs)}`}>
            {dur(t.medianMs)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The panel from its data (also what the render checks render). */
export function MetricsView({ m }: { m: Metrics }) {
  const w7 = m.windows.find((w) => w.days === 7)!;
  const w30 = m.windows.find((w) => w.days === 30)!;
  const s = m.slowTests;
  return (
    <section className="space-y-3" aria-label="Metrics" data-testid="metrics-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Metrics</span>
        <span className="text-[12px] text-ink-3">the last 7 days, and 30; measured only</span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {FIGURES.map((f) => (
          <FigureCard key={f.key} f={f} w7={w7} w30={w30} />
        ))}
      </div>

      {m.perDay && (
        <Card className="p-3" data-testid="metrics-per-day">
          <div className="text-[12px] font-medium text-ink-3">Merged per day, last {m.perDay.length} days</div>
          <div className="mt-2">
            <MergedBars days={m.perDay} />
          </div>
        </Card>
      )}

      <Card className="min-w-0 p-3" data-testid="metrics-slow-tests" data-measured={String(s.measured)}>
        {s.measured ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">The {s.slowest.length} slowest tests</span>
              <span className="text-[12px] text-ink-3">
                last {s.days} days, median of {s.runs} run{s.runs === 1 ? '' : 's'}
              </span>
            </div>
            <TestList tests={s.slowest} testId="metrics-slow-test" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-ink">Over the {s.budgetS} s budget</span>
              <Badge tone={s.overBudgetTotal ? 'warn' : 'ok'}>
                <span data-testid="metrics-over-budget-count">{s.overBudgetTotal}</span>
              </Badge>
            </div>
            {s.overBudget.length ? (
              <>
                <TestList tests={s.overBudget} testId="metrics-over-budget" />
                {s.overBudgetTotal > s.overBudget.length && <div className="text-[12px] text-ink-3">and {s.overBudgetTotal - s.overBudget.length} more</div>}
              </>
            ) : (
              <div className="text-[12.5px] text-ink-3">None.</div>
            )}
          </div>
        ) : (
          <div className="text-[13px]">
            <span className="font-medium text-ink">Slow tests: </span>
            <span className="text-ink-3" data-testid="metrics-not-measured">
              {NOT_MEASURED}
            </span>
            <span className="text-ink-3"> ({s.why})</span>
          </div>
        )}
      </Card>

      <details className="text-[12px] text-ink-3" data-testid="metrics-definitions">
        <summary className="cursor-pointer select-none">How each number is counted</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {m.definitions.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** For a viewer the state says may not read the metrics, the refusal the server would give; null for the owner and writers. */
export const metricsRefusal = (state: Pick<State, 'canReadThroughput' | 'user' | 'role'>) =>
  state.canReadThroughput === false ? `the metrics are for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;

/** Loaded for the owner and the writers only (anyone else's page says so without asking). */
export function MetricsPanel({ state }: { state: State }) {
  const refused = metricsRefusal(state);
  const [m, setM] = useState<Metrics | { error: string } | null>(null);
  useEffect(() => {
    if (refused) return;
    api<Metrics>('/api/metrics')
      .then(setM)
      .catch((e: Error) => setM({ error: e.message }));
  }, [refused, state.lastId]);
  if (refused) {
    return (
      <div className="text-[13px] text-ink-3" data-testid="metrics-refused">
        {refused.replace(/^the/, 'The')}.
      </div>
    );
  }
  if (!m) return null;
  if ('error' in m) return <div className="text-[13px] text-red">Can't load the metrics: {m.error}</div>;
  return <MetricsView m={m} />;
}

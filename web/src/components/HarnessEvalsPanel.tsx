// Harness evals (GET /api/harness-evals, src/harness-evals/): fixed past tasks replayed through the real coordinator,
// weekly and when the engine's src/ changes on main. One row per run, newest first, so the columns read as the trend:
// success rate, estimated cost, wall-clock and human interventions per replay, and the change from the baseline (the
// run before it that finished). Under it, the latest run's tasks. Owners and writers read it.
import { useEffect, useState } from 'react';
import { api, type HarnessEvalRun, type HarnessEvals, type State } from '../api';
import { ago, Badge, Card, EST_NOTE, estUsd } from './ui';

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 100)}%`);
const mins = (ms: number | null) => (ms === null ? '–' : `${(ms / 60_000).toFixed(1)} min`);

function Delta({ d, unit, better }: { d: number | null; unit: 'pct' | 'usd'; better: 'up' | 'down' }) {
  if (d === null) return <span className="text-ink-3">–</span>;
  if (Math.abs(d) < 1e-9) return <span className="text-ink-3">±0</span>;
  const worse = better === 'up' ? d < 0 : d > 0;
  const text = unit === 'pct' ? `${Math.round(Math.abs(d) * 100)} pts` : `$${Math.abs(d).toFixed(2)}`;
  return <span className={worse ? 'text-red' : 'text-green'}>{`${d > 0 ? '+' : '−'}${text}`}</span>;
}

function RunRow({ r }: { r: HarnessEvalRun }) {
  return (
    <tr className="border-t border-line align-top" data-testid="harness-eval-run" data-run={r.id}>
      <td className="px-3 py-2 text-ink-2">{ago(r.at)}</td>
      <td className="px-3 py-2 text-ink-2">
        {r.trigger}
        {r.pr ? ` · #${r.pr}` : ''}
        {r.engine ? <span className="ml-1 font-mono text-[11.5px] text-ink-3">{r.engine.slice(0, 8)}</span> : null}
      </td>
      <td className="px-3 py-2 tabular-nums text-ink" data-testid="harness-eval-success">
        {r.error && !r.runs ? <span className="text-ink-3">{r.error}</span> : `${pct(r.successRate)} (${r.passed}/${r.runs})`} {r.stopped ? <Badge tone="warn">budget</Badge> : null}
      </td>
      <td className="px-3 py-2 tabular-nums">
        <Delta d={r.successDelta} unit="pct" better="up" />
      </td>
      <td className="px-3 py-2 tabular-nums text-ink-2" title={EST_NOTE}>
        {r.costPerRun === null ? '–' : estUsd(r.costPerRun)} <Delta d={r.costDelta} unit="usd" better="down" />
      </td>
      <td className="px-3 py-2 tabular-nums text-ink-2">{mins(r.wallMsPerRun)}</td>
      <td className="px-3 py-2 tabular-nums text-ink-2">{r.interventionsPerRun === null ? '–' : r.interventionsPerRun.toFixed(2)}</td>
    </tr>
  );
}

export function HarnessEvalsView({ h }: { h: HarnessEvals }) {
  const last = h.runs[0];
  return (
    <section className="space-y-2" aria-label="Harness evals" data-testid="harness-evals-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Harness evals</span>
        <Badge tone={h.enabled ? 'ok' : 'neutral'}>{h.enabled ? 'on' : 'off'}</Badge>
        {last ? (
          <span className="text-[12.5px] text-ink-3" data-testid="harness-evals-latest">
            Latest: {pct(last.successRate)} of {last.runs} replays passed, {ago(last.at)}
          </span>
        ) : null}
      </div>
      <p className="text-[12px] text-ink-3">Past tasks replayed through the real coordinator in a scratch instance, weekly and when the engine&apos;s src/ changes. Success: the done_when checks pass and the evaluator approves. Interventions: decisions asked and waits for the owner. Each change is against the run before it that finished.</p>
      {h.runs.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Success</th>
                <th className="px-3 py-2 font-medium">Change</th>
                <th className="px-3 py-2 font-medium">Cost per replay</th>
                <th className="px-3 py-2 font-medium">Wall-clock</th>
                <th className="px-3 py-2 font-medium">Interventions</th>
              </tr>
            </thead>
            <tbody>
              {h.runs.map((r) => (
                <RunRow key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="text-[12.5px] text-ink-3">No runs yet.</div>
      )}
      {h.latest.length ? (
        <ul className="flex flex-wrap gap-2 text-[12px]" data-testid="harness-evals-tasks">
          {h.latest.map((t) => (
            <li key={t.task}>
              <Badge tone={t.passed === t.samples ? 'ok' : t.passed ? 'warn' : 'danger'}>
                {t.task}
                {t.heldOut ? ' (held out)' : ''}: {t.passed}/{t.samples}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function HarnessEvalsPanel({ state }: { state: State }) {
  const [h, setH] = useState<HarnessEvals | { error: string } | null>(null);
  useEffect(() => {
    if (state.canWrite === false) return;
    api<HarnessEvals>('/api/harness-evals')
      .then(setH)
      .catch((e: Error) => setH({ error: e.message }));
  }, [state.lastId, state.canWrite]);
  if (state.canWrite === false || !h) return null;
  if ('error' in h) return <div className="text-[13px] text-red">Can't load the harness evals: {h.error}</div>;
  return <HarnessEvalsView h={h} />;
}

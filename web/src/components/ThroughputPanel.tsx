// Throughput (GET /api/throughput): merged PRs per day and per week, the estimated cost per merged PR by
// stage, where PRs waited for the owner and why, and the three biggest costs with a tuning to try for each
// (fixed rules, src/throughput.ts). The owner's and the writers' to read.
import { useEffect, useState } from 'react';
import { api, type State, type Throughput } from '../api';
import { RecordsTable } from './patterns';
import { Card, EST_NOTE, estUsd } from './ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const MODEL_LABEL: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', local: 'Local model', unknown: 'Model not recorded' };
/** A model's name for the table: a tier, the local model, a hosted provider by its name, or the model's id. */
const modelLabel = (m: string) => MODEL_LABEL[m] ?? (m.startsWith('hosted:') ? `Hosted: ${m.slice(7)}` : m);
/** Tokens and run time, for a model whose cost alone says little (a local model costs nothing). */
const tokensAndTime = (m: { tokensIn?: number; tokensOut?: number; secs?: number }) => {
  const t = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  if (!t) return '–';
  const k = t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${Math.round(t / 1000)}k` : String(t);
  return `${k} tokens · ${Math.max(1, Math.round((m.secs ?? 0) / 60))} min`;
};

const STAGE_LABEL: Record<string, string> = {
  worker: 'Worker',
  evaluator: 'Evaluator',
  plan: 'Plan',
  research: 'Research',
  intake: 'Intake',
  gardener: 'Gardener',
  chat: 'Chat',
  retries: 'Retries and fixes',
  other: 'Other (evals)',
};

/** For a viewer the state says may not read throughput, the refusal the server would give; null for the owner and writers. */
export const throughputRefusal = (state: Pick<State, 'canReadThroughput' | 'owners' | 'user' | 'role'>) =>
  state.canReadThroughput === false ? `throughput is for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;

/** Merged PRs per day as one quiet series of bars (each hoverable), labelled at the ends. */
export function MergedBars({ days }: { days: Throughput['merged']['perDay'] }) {
  const max = Math.max(1, ...days.map((d) => d.merged));
  return (
    <div>
      <div className="flex h-16 items-end gap-0.5" role="img" aria-label={`merged PRs per day, the last ${days.length} days: ${days.map((d) => d.merged).join(', ')}`}>
        {days.map((d) => (
          <div key={d.day} className="group flex h-full flex-1 items-end" title={`${d.day}: ${d.merged} merged`} data-testid="throughput-day">
            <div className="w-full rounded-t-[4px] bg-ring group-hover:opacity-80" style={{ height: d.merged ? `${(d.merged / max) * 100}%` : 2, opacity: d.merged ? 1 : 0.25 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-3">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days.at(-1)?.day.slice(5)}</span>
      </div>
    </div>
  );
}

/** The panel from its data (also what the render checks render). */
export function ThroughputView({ t }: { t: Throughput }) {
  const mine = t.waits.filter((w) => w.owner);
  const others = t.waits.filter((w) => !w.owner);
  return (
    <section className="space-y-3" aria-label="Throughput" data-testid="throughput-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Throughput</span>
        <span className="text-[12px] text-ink-3" title={EST_NOTE}>
          the last 7 days; costs are the CLI's own estimates, not billed money
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="p-3" data-testid="throughput-merged">
          <div className="text-[12px] font-medium text-ink-3">Merged PRs</div>
          <div className="mt-1 text-[22px] font-semibold tracking-tight tabular-nums text-ink">{t.merged.total}</div>
          <div className="text-[12px] text-ink-3">this week</div>
        </Card>
        <Card className="p-3" data-testid="throughput-per-pr">
          <div className="text-[12px] font-medium text-ink-3">Cost per merged PR</div>
          <div className="mt-1 text-[22px] font-semibold tracking-tight tabular-nums text-ink" title={EST_NOTE}>
            {t.cost.perMergedPrUsd !== null ? estUsd(t.cost.perMergedPrUsd) : '–'}
          </div>
          <div className="text-[12px] text-ink-3">{t.cost.perMergedPrUsd !== null ? `${estUsd(t.cost.totalUsd)} in all` : `none merged; ${estUsd(t.cost.totalUsd)} spent`}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[12px] font-medium text-ink-3">Merged per day, last 14 days</div>
          <div className="mt-2">
            <MergedBars days={t.merged.perDay} />
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3" data-testid="throughput-weeks">
        By week (from Monday):
        {t.merged.perWeek.map((w) => (
          <span key={w.week} className="tabular-nums" data-testid="throughput-week">
            {w.week.slice(5)} <span className="font-medium text-ink">{w.merged}</span>
          </span>
        ))}
      </div>

      {!!t.top.length && (
        <Card className="primitive-card-pad space-y-2" data-testid="throughput-top">
          <div className="text-[13px] font-medium text-ink">The biggest costs, and a tuning to try</div>
          <ol className="space-y-1.5">
            {t.top.map((x, i) => (
              <li key={x.stage} className="text-[13px] leading-5" data-testid="throughput-suggestion" data-stage={x.stage}>
                <span className="font-medium text-ink">
                  {i + 1}. {STAGE_LABEL[x.stage]} · {estUsd(x.usd)} ({pct(x.share)})
                </span>
                <span className="text-ink-2"> {x.suggestion}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <RecordsTable testId="throughput-stages" head={['Stage', 'Per merged PR', 'This week', 'Share']} className="[&_th:nth-child(2)]:w-32 [&_th:nth-child(3)]:w-28 [&_th:nth-child(4)]:w-40">
        {t.cost.byStage.map((s) => (
          <tr key={s.stage} className="border-b border-line last:border-0" data-testid="throughput-stage" data-stage={s.stage}>
            <td className="primitive-table-cell text-[13px] text-ink">{STAGE_LABEL[s.stage]}</td>
            <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{s.perMergedPrUsd !== null ? estUsd(s.perMergedPrUsd) : '–'}</td>
            <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{estUsd(s.usd)}</td>
            <td className="primitive-table-cell">
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover-2" role="progressbar" aria-label={`${STAGE_LABEL[s.stage]} share`} aria-valuenow={Math.round(s.share * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-ring" style={{ width: `${s.share * 100}%` }} />
                </div>
                <span className="w-9 text-right text-[12px] tabular-nums text-ink-3">{pct(s.share)}</span>
              </div>
            </td>
          </tr>
        ))}
      </RecordsTable>

      {(t.cost.byModel ?? []).length > 0 && (
        <RecordsTable testId="throughput-models" head={['Model', 'Per merged PR', 'This week', 'Tokens, time', 'Share']} className="[&_th:nth-child(2)]:w-32 [&_th:nth-child(3)]:w-28 [&_th:nth-child(4)]:w-40">
          {(t.cost.byModel ?? []).map((m) => (
            <tr key={m.model} className="border-b border-line last:border-0" data-testid="throughput-model" data-model={m.model}>
              <td className="primitive-table-cell text-[13px] text-ink">{modelLabel(m.model)}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{m.perMergedPrUsd !== null ? estUsd(m.perMergedPrUsd) : '–'}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{estUsd(m.usd)}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2" data-testid="throughput-model-tokens">{tokensAndTime(m)}</td>
              <td className="primitive-table-cell">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover-2" role="progressbar" aria-label={`${modelLabel(m.model)} share`} aria-valuenow={Math.round(m.share * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full rounded-full bg-ring" style={{ width: `${m.share * 100}%` }} />
                  </div>
                  <span className="w-9 text-right text-[12px] tabular-nums text-ink-3">{pct(m.share)}</span>
                </div>
              </td>
            </tr>
          ))}
        </RecordsTable>
      )}

      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-ink">Where PRs waited for you</div>
        {mine.length ? (
          <RecordsTable testId="throughput-waits" head={['Waiting on', 'Times', 'Median', 'In all', 'Why']} className="[&_th:nth-child(2)]:w-20 [&_th:nth-child(3)]:w-24 [&_th:nth-child(4)]:w-24">
            {mine.map((w) => (
              <tr key={w.kind} className="border-b border-line align-top last:border-0" data-testid="throughput-wait" data-kind={w.kind}>
                <td className="primitive-table-cell text-[13px] text-ink">{w.label}</td>
                <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">
                  {w.count}
                  {w.open > 0 && <div className="text-[11.5px] text-orange">{w.open} waiting now</div>}
                </td>
                <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{w.medianHours !== null ? `${w.medianHours} h` : '–'}</td>
                <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{w.totalHours} h</td>
                <td className="primitive-table-cell text-[12px] text-ink-3">{w.reasons.length ? w.reasons.map((r) => `${r.reason}${r.count > 1 ? ` (${r.count})` : ''}`).join('; ') : '–'}</td>
              </tr>
            ))}
          </RecordsTable>
        ) : (
          <div className="text-[12.5px] text-ink-3" data-testid="throughput-no-waits">
            Nothing waited for you this week.
          </div>
        )}
        {others.map((w) => (
          <div key={w.kind} className="text-[12px] text-ink-3" data-testid="throughput-other-wait">
            Also: {w.count} task(s) {w.label}, {w.totalHours} h in all.
          </div>
        ))}
      </div>
    </section>
  );
}

/** Loaded for the owner and the writers only (anyone else's page says so without asking). */
export function ThroughputPanel({ state }: { state: State }) {
  const refused = throughputRefusal(state);
  const [t, setT] = useState<Throughput | { error: string } | null>(null);
  useEffect(() => {
    if (refused) return;
    api<Throughput>('/api/throughput')
      .then(setT)
      .catch((e: Error) => setT({ error: e.message }));
  }, [refused, state.lastId]);
  if (refused) {
    return (
      <div className="text-[13px] text-ink-3" data-testid="throughput-refused">
        {refused.replace(/^throughput/, 'Throughput')}.
      </div>
    );
  }
  if (!t) return null;
  if ('error' in t) return <div className="text-[13px] text-red">Can't load throughput: {t.error}</div>;
  return <ThroughputView t={t} />;
}

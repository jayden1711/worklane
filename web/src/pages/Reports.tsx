import { getScorecard, useFetch, type Scorecard, type State } from '../api';
import { ago, Badge, Card, cx } from '../components/ui';
import { Header } from './Overview';

type Row = [keyof Scorecard, string, 'up' | 'down', (v: number) => string];
const pct = (v: number) => `${Math.round(v * 100)}%`;
const h = (v: number) => `${v}h`;
const ROWS: Row[] = [
  ['tasksDone', 'Tasks done', 'up', String],
  ['evaluatorPassRate', 'Evaluator pass rate', 'up', pct],
  ['unverifiedClaimRate', 'Unverified claims', 'down', pct],
  ['reverts', 'Reverts', 'down', String],
  ['redCaught', 'New reds caught at the gate', 'down', String],
  ['baselineGrowth', "New failures on main's baseline", 'down', String],
  ['costPerDoneUsd', 'Cost per done task', 'down', (v) => `$${v.toFixed(2)}`],
  ['readyToDoneHours', 'Ready to done (median)', 'down', h],
  ['interventionsPerTask', 'Human interventions per task', 'down', String],
  ['idleHours', 'Idle hours (work waiting, nothing running)', 'down', h],
  ['decisionWaitHours', 'Hours decisions waited on owners', 'down', h],
  ['blockedHours', 'Hours tasks sat blocked', 'down', h],
  ['spendUsd', 'Spend', 'down', (v) => `$${v.toFixed(2)}`],
];

function Delta({ now, prev, dir }: { now: number | null; prev: number | null; dir: 'up' | 'down' }) {
  if (now === null || prev === null || now === prev) return <span className="text-xs text-muted-foreground">-</span>;
  const better = dir === 'up' ? now > prev : now < prev;
  const d = Math.round((now - prev) * 100) / 100;
  return <span className={cx('text-xs tabular-nums', better ? 'text-ok' : 'text-danger')}>{d > 0 ? `+${d}` : d}</span>;
}

export function Reports({ state, pulse }: { state: State; pulse: number }) {
  const { data, error } = useFetch(getScorecard, pulse);
  return (
    <div>
      <Header title="Reports" sub={`trust stage ${state.project.stage} · scorecard over the last 7 days`} />
      <div className="space-y-6 p-6">
        {error && <div className="text-sm text-danger">Can't load the scorecard: {error}</div>}
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="text-sm font-medium">Scorecard</span>
              <span className="text-xs text-muted-foreground">vs the 7 days before</span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {ROWS.map(([k, label, dir, fmt]) => {
                  const v = data?.current[k] as number | null | undefined;
                  const p = data?.previous[k] as number | null | undefined;
                  return (
                    <tr key={k}>
                      <td className="px-4 py-2 text-muted-foreground">{label}</td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">{v === null || v === undefined ? '-' : fmt(v)}</td>
                      <td className="w-20 px-4 py-2 text-right">
                        <Delta now={v ?? null} prev={p ?? null} dir={dir} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          <div className="space-y-6">
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Trust</div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-2xl font-semibold">Stage {state.project.stage}</span>
                {data && <Badge tone={data.health.healthy ? 'ok' : 'warn'}>{data.health.healthy ? 'healthy' : 'not yet'}</Badge>}
              </div>
              {data && !data.health.healthy && (
                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {data.health.why.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 text-xs text-muted-foreground">Promotion is always the owner's decision. A regression demotes on its own. Protected categories never relax.</div>
              {!!state.trust.changes.length && (
                <ul className="mt-3 space-y-1 border-t pt-2 text-xs">
                  {state.trust.changes.map((c, i) => (
                    <li key={i}>
                      {c.from} → {c.to} by {c.by} <span className="text-muted-foreground">· {ago(c.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Daily health checks</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {state.trust.evaluations.length ? (
                  state.trust.evaluations
                    .slice()
                    .reverse()
                    .map((e) => <span key={e.day} title={`${e.day}: ${e.healthy ? 'healthy' : e.why.join('; ')}`} className={cx('size-3 rounded-sm', e.healthy ? 'bg-ok' : 'bg-muted-foreground/30')} />)
                ) : (
                  <span className="text-xs text-muted-foreground">None yet.</span>
                )}
              </div>
            </Card>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <div className="border-b px-4 py-2.5 text-sm font-medium">Next report (preview)</div>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5">{data?.report ?? 'Loading…'}</pre>
          </Card>
          <Card>
            <div className="border-b px-4 py-2.5 text-sm font-medium">Posted</div>
            {state.reports.length ? (
              <ul className="divide-y">
                {state.reports.map((r) => (
                  <li key={`${r.day}-${r.slot}`} className="flex justify-between px-4 py-2 text-sm">
                    <span>
                      {r.day} {r.slot}
                    </span>
                    <span className="text-xs text-muted-foreground">{r.issue ? `on #${r.issue}` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">Reports post at the configured times as comments on one report issue.</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

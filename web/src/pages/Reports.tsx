import { api, useFetch, type State } from '../api';
import { ThroughputPanel } from '../components/ThroughputPanel';
import { Card } from '../components/ui';
import { Header } from './Overview';

const getReport = () => api<{ report: string }>('/api/report');

/** For a viewer the state says may not read the preview, the refusal the server would give; null for the owner and writers. */
export const reportRefusal = (state: Pick<State, 'canReadReports' | 'owners' | 'user'>) =>
  state.canReadReports === false ? `the report preview is for the owner (@${state.owners.default}) and the project's writers; @${state.user || 'unknown'} isn't one` : null;

export function Reports({ state, pulse }: { state: State; pulse: number }) {
  const refused = reportRefusal(state);
  // Refused up front (the state says so): not asked for at all.
  const { data, error } = useFetch(() => (refused ? Promise.resolve(null) : getReport()), pulse);
  return (
    <div data-testid="page-reports">
      <Header title="Reports" sub="posted at the configured times as comments on one report issue" />
      <div className="px-6 pt-6">
        <ThroughputPanel state={state} />
      </div>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="report-preview">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Next report (preview)</div>
          {refused ? (
            <div className="p-4 text-[13px] text-ink-3" data-testid="report-refused">
              {refused.replace(/^the/, 'The')}.
            </div>
          ) : (
            <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-5">{error ? `Can't load the report: ${error}` : (data?.report ?? 'Loading…')}</pre>
          )}
        </Card>
        <Card className="overflow-hidden">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Posted</div>
          {state.reports.length ? (
            <ul className="divide-y divide-line">
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
            <div className="p-4 text-xs text-muted-foreground">None yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

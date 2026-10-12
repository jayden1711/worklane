// Intake: reports from the chat bot, texts and the product's bug form, as the coordinator recorded them,
// redacted (a sender is a short hash, the text only its redacted excerpt), with what became of each: the
// triage, the issue it was filed as or joined, the reproduction, and the replies sent. Drafts that need the
// owner wait in the Inbox. The owner's and the writers' to read.
import { useEffect, useMemo, useState } from 'react';
import { api, type IntakeReport, type IntakeView, type State } from '../api';
import { navigate } from '../App';
import { RecordsTable } from '../components/patterns';
import { ago, Badge, cx, Empty } from '../components/ui';
import { Header } from './Overview';

const OUTCOME: Record<IntakeReport['outcome'], { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' }> = {
  filed: { label: 'filed', tone: 'ok' },
  commented: { label: 'added to an issue', tone: 'ok' },
  grouped: { label: 'grouped', tone: 'info' },
  awaiting_owner: { label: 'waiting on the owner', tone: 'warn' },
  asked_owner: { label: 'asked the owner', tone: 'warn' },
  replied: { label: 'replied', tone: 'info' },
  pending: { label: 'in triage', tone: 'neutral' },
  rejected: { label: 'rejected', tone: 'neutral' },
  dropped: { label: 'dropped', tone: 'danger' },
};

const VIEWS: Record<string, (r: IntakeReport) => boolean> = {
  All: () => true,
  'Needs the owner': (r) => r.outcome === 'awaiting_owner' || r.outcome === 'asked_owner',
  'On an issue': (r) => r.issue !== null,
  Dropped: (r) => r.outcome === 'dropped' || r.outcome === 'rejected',
};

/** For a viewer the state says may not read intake, the refusal the server would give; null for the owner and writers. */
export const intakeRefusal = (state: Pick<State, 'canReadIntake' | 'owners' | 'user'>) =>
  state.canReadIntake === false ? `intake reports are for the owner (@${state.owners.default}) and the project's writers; @${state.user || 'unknown'} isn't one` : null;

/** The page from its data (also what the render checks render). */
export function IntakeReports({ data, view = 'All', onView = () => {} }: { data: IntakeView; view?: string; onView?: (v: string) => void }) {
  const rows = data.reports.filter(VIEWS[view] ?? VIEWS.All!);
  const waiting = data.reports.filter(VIEWS['Needs the owner']!).length;
  return (
    <div className="space-y-3 p-6">
      <div className="flex flex-wrap items-center gap-1.5">
        {Object.keys(VIEWS).map((v) => (
          <button key={v} onClick={() => onView(v)} className={cx('h-7 rounded-full px-2.5 text-[12px]', view === v ? 'bg-ink font-medium text-surface' : 'text-ink-2 shadow-hairline hover:bg-hover-2')} data-testid="intake-view">
            {v}
            {v === 'Needs the owner' && waiting > 0 && <span className="ml-1 tabular-nums">{waiting}</span>}
          </button>
        ))}
        {waiting > 0 && (
          <button onClick={() => navigate('/inbox')} className="ml-auto text-[12px] text-blue-ink hover:underline" data-testid="intake-inbox-link">
            {waiting} draft(s) wait in your Inbox
          </button>
        )}
      </div>
      {rows.length ? (
        <RecordsTable testId="intake-table" head={['Received', 'Report', 'Triage', 'Outcome', 'Replies']} className="[&_th:nth-child(1)]:w-32 [&_th:nth-child(3)]:w-40 [&_th:nth-child(4)]:w-44 [&_th:nth-child(5)]:w-28">
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line align-top last:border-0" data-testid="intake-row" data-outcome={r.outcome}>
              <td className="primitive-table-cell text-[12px] text-ink-3">
                <div title={r.receivedAt}>{ago(r.receivedAt)}</div>
                <div className="mt-0.5">
                  <Badge>{r.source}</Badge>
                </div>
              </td>
              <td className="primitive-table-cell">
                <div className="whitespace-pre-wrap break-words text-[13px] leading-5 text-ink" data-testid="intake-excerpt">
                  {r.excerpt ?? <span className="text-ink-3">no excerpt kept</span>}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-3" title="the sender, as a short hash">
                  from {r.sender}
                </div>
              </td>
              <td className="primitive-table-cell text-[12.5px] text-ink-2">
                {r.kind ?? <span className="text-ink-3">–</span>}
                {r.reproduction && (
                  <div className="mt-0.5 text-[11.5px] text-ink-3" data-testid="intake-reproduction">
                    reproduction: {r.reproduction}
                  </div>
                )}
              </td>
              <td className="primitive-table-cell text-[12.5px]">
                <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                {r.issue !== null && (
                  <button onClick={() => navigate(`/issues/${r.issue}`)} className="ml-1.5 font-mono text-[12px] text-blue-ink hover:underline" data-testid="intake-issue">
                    #{r.issue}
                  </button>
                )}
                {r.dropped && (
                  <div className="mt-0.5 text-[11.5px] text-ink-3" data-testid="intake-dropped">
                    {r.dropped}
                  </div>
                )}
              </td>
              <td className="primitive-table-cell text-[12px] text-ink-2" data-testid="intake-replies">
                {r.replies.length ? r.replies.join(', ') : <span className="text-ink-3">none</span>}
              </td>
            </tr>
          ))}
        </RecordsTable>
      ) : data.reports.length ? (
        <Empty title="No reports in this view" />
      ) : (
        <Empty title="No reports yet" hint="Each source (chat bot, texts, the product's bug form) is off until the owner turns it on for this instance; see docs/intake.md." />
      )}
    </div>
  );
}

export function IntakePage({ state }: { state: State }) {
  const refused = intakeRefusal(state);
  const [data, setData] = useState<IntakeView | { error: string } | null>(null);
  const [view, setView] = useState('All');
  // Refused up front (the state says so): not asked for at all. Otherwise again whenever the log changes.
  useEffect(() => {
    if (refused) return;
    api<IntakeView>('/api/intake')
      .then(setData)
      .catch((e: Error) => setData({ error: e.message }));
  }, [refused, state.lastId]);
  const sub = useMemo(() => (data && 'reports' in data ? `${data.reports.length} report(s), redacted` : 'reports from chat, texts and the product, redacted'), [data]);
  return (
    <div data-testid="page-intake">
      <Header title="Intake" sub={sub} />
      {refused ? (
        <div className="p-6 text-[13px] text-ink-3" data-testid="intake-refused">
          {refused.replace(/^intake/, 'Intake')}.
        </div>
      ) : !data ? null : 'error' in data ? (
        <div className="p-6 text-[13px] text-red">Can't load intake: {data.error}</div>
      ) : (
        <IntakeReports data={data} view={view} onView={setView} />
      )}
    </div>
  );
}

const minutes = (m: number) => (m < 60 ? `${Math.round(m)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`);

/** Intake's numbers for the health panel: reports per day by source, drops by reason, and report to merged fix. */
export function IntakeHealthSection({ health }: { health: IntakeView['health'] }) {
  const drops = Object.entries(health.dropped).sort((a, b) => b[1] - a[1]);
  if (!health.perDay.length && !drops.length) return null;
  return (
    <section className="space-y-1.5" aria-label="Intake" data-testid="health-intake">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Intake</span>
        <span className="text-[12px] text-ink-3">the last 14 days</span>
        <span className="ml-auto text-[12px] text-ink-2" data-testid="health-intake-merged">
          {health.reportToMerged.count
            ? `report to merged fix: median ${minutes(health.reportToMerged.medianMinutes!)} over ${health.reportToMerged.count} report(s)`
            : 'no reported fix has merged yet'}
        </span>
      </div>
      {!!health.perDay.length && (
        <RecordsTable testId="health-intake-days" head={['Day (UTC)', 'Source', 'Reports']} className="[&_th:nth-child(3)]:w-24">
          {health.perDay.map((d) => (
            <tr key={`${d.day}:${d.source}`} className="border-b border-line last:border-0" data-testid="health-intake-day">
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{d.day}</td>
              <td className="primitive-table-cell text-[12.5px] text-ink-2">{d.source}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink">{d.reports}</td>
            </tr>
          ))}
        </RecordsTable>
      )}
      {!!drops.length && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3" data-testid="health-intake-dropped">
          Dropped:
          {drops.map(([why, n]) => (
            <Badge key={why}>
              {why}: {n}
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}

/** The section, loaded for the owner and the writers only (anyone else's page doesn't ask). */
export function IntakeHealthPanel({ state }: { state: State }) {
  const [health, setHealth] = useState<IntakeView['health'] | null>(null);
  const refused = intakeRefusal(state);
  useEffect(() => {
    if (refused) return;
    api<IntakeView>('/api/intake')
      .then((v) => setHealth(v.health))
      .catch(() => setHealth(null));
  }, [refused, state.lastId]);
  return health ? <IntakeHealthSection health={health} /> : null;
}

import { useEffect, useMemo, useState } from 'react';
import type { State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Card, cx, Empty } from '../components/ui';
import { Header } from './Overview';

const GROUPS: Record<string, (t: string) => boolean> = {
  All: () => true,
  Runs: (t) => t.startsWith('run.') || t.startsWith('repro.'),
  Checks: (t) => t.startsWith('check.') || t.startsWith('eval.') || t.startsWith('change.'),
  Decisions: (t) => t.startsWith('decision.'),
  Landing: (t) => t.startsWith('land.') || t.startsWith('deploy.'),
  Issues: (t) => t.startsWith('issue.') || t.startsWith('contract.'),
  System: (t) => /^(coordinator|governor|report|nightly|baseline)\./.test(t),
  Settings: (t) => t.startsWith('settings.'),
};

export function ActivityPage({ state }: { state: State }) {
  const [group, setGroup] = useState('All');
  // An event a chat answer cited (`?event=<id>`): marked and scrolled to, if this page still lists it.
  const cited = useMemo(() => new URLSearchParams(window.location.search).get('event'), []);
  useEffect(() => {
    if (cited) document.querySelector(`[data-event="${CSS.escape(cited)}"]`)?.scrollIntoView({ block: 'center' });
  }, [cited]);
  const [text, setText] = useState('');
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return state.activity.filter((a) => GROUPS[group]!(a.type) && (!q || `${a.summary} ${a.actor} ${a.type} #${a.issue ?? ''}`.toLowerCase().includes(q)));
  }, [state.activity, group, text]);
  return (
    <div data-testid="page-activity">
      <Header title="Activity" sub="every event from the log, newest first">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter…" className="h-7 w-48 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--blue)]" />
      </Header>
      <div className="space-y-3 p-6">
        {cited && !state.activity.some((a) => String(a.id) === cited) && (
          <div className="text-[12.5px] text-ink-3" data-testid="activity-cited-missing">
            Event {cited} is older than the events this page lists.
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(GROUPS).map((g) => (
            <button key={g} onClick={() => setGroup(g)} className={cx('h-7 rounded-full px-2.5 text-[12px]', group === g ? 'bg-ink font-medium text-surface' : 'text-ink-2 shadow-hairline hover:bg-hover-2')}>
              {g}
            </button>
          ))}
        </div>
        <Card className="overflow-hidden">
          {rows.length ? (
            <ul className="divide-y divide-line">
              {rows.map((a) => (
                <li key={a.id} className={cx('flex items-center gap-3 px-4 py-2 text-sm', cited === String(a.id) && 'bg-blue-tint')} data-event={a.id} data-testid="activity-row" {...(cited === String(a.id) ? { 'data-cited': '' } : {})}>
                  <span className="w-16 shrink-0 text-xs text-muted-foreground" title={a.ts}>
                    {ago(a.ts)}
                  </span>
                  {a.issue !== null ? (
                    <button className="w-12 shrink-0 text-left font-mono text-xs text-blue-ink hover:underline" onClick={() => navigate(`/issues/${a.issue}`)}>
                      #{a.issue}
                    </button>
                  ) : (
                    <span className="w-12 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{a.summary}</span>
                  <span className="hidden w-28 truncate text-right text-xs text-muted-foreground md:inline">{a.actor}</span>
                  <Badge className="hidden sm:inline-flex">{a.type}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <Empty title="No matching events" />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

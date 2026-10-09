import { useMemo, useState } from 'react';
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
};

export function ActivityPage({ state }: { state: State }) {
  const [group, setGroup] = useState('All');
  const [text, setText] = useState('');
  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return state.activity.filter((a) => GROUPS[group]!(a.type) && (!q || `${a.summary} ${a.actor} ${a.type} #${a.issue ?? ''}`.toLowerCase().includes(q)));
  }, [state.activity, group, text]);
  return (
    <div>
      <Header title="Activity" sub="every event from the log, newest first">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter…" className="h-7 w-48 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring" />
      </Header>
      <div className="space-y-3 p-6">
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(GROUPS).map((g) => (
            <button key={g} onClick={() => setGroup(g)} className={cx('h-7 rounded-md border px-2.5 text-xs', group === g ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent')}>
              {g}
            </button>
          ))}
        </div>
        <Card>
          {rows.length ? (
            <ul className="divide-y">
              {rows.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground" title={a.ts}>
                    {ago(a.ts)}
                  </span>
                  {a.issue !== null ? (
                    <button className="w-12 shrink-0 text-left font-mono text-xs text-info hover:underline" onClick={() => navigate(`/issues/${a.issue}`)}>
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

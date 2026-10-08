import type { State, Task } from '../api';
import { navigate } from '../App';
import { ago, Card, Empty, LevelBadge, StatusBadge } from '../components/ui';
import { DecisionCard } from './Decisions';
import { Header } from './Overview';

function TaskRow({ t, note }: { t: Task; note?: string }) {
  return (
    <button onClick={() => navigate(`/issues/${t.issue}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent">
      <span className="w-12 font-mono text-xs text-muted-foreground">#{t.issue}</span>
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      {note && <span className="hidden max-w-xs truncate text-xs text-muted-foreground lg:inline">{note}</span>}
      <LevelBadge level={t.level} />
      <StatusBadge status={t.status} />
      <span className="w-14 text-right text-xs text-muted-foreground">{ago(t.lastActivity)}</span>
    </button>
  );
}

export function InboxPage({ state }: { state: State }) {
  const { decisions, blocked, notify } = state.inbox;
  const empty = !decisions.length && !blocked.length && !notify.length;
  return (
    <div>
      <Header title="Inbox" sub={`for @${state.user}`} />
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {empty && <Empty title="You're all caught up" hint="Decisions that need you, your blocked tasks, and L2 changes landed on your behalf show up here." />}
        {!!decisions.length && (
          <section className="space-y-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs your decision</h2>
            {decisions.map((d) => (
              <DecisionCard key={d.id} d={d} selected={false} />
            ))}
          </section>
        )}
        {!!blocked.length && (
          <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Blocked, yours</h2>
            <Card className="divide-y overflow-hidden">
              {blocked.map((t) => (
                <TaskRow key={t.issue} t={t} note={t.blockedReason ?? undefined} />
              ))}
            </Card>
          </section>
        )}
        {!!notify.length && (
          <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Landed for you (L2: look it over, revert if wrong)</h2>
            <Card className="divide-y overflow-hidden">
              {notify.map((t) => (
                <TaskRow key={t.issue} t={t} note={t.landed ? `at ${t.landed.slice(0, 8)}` : undefined} />
              ))}
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, type ServiceLog, type State } from '../api';
import { ago, Badge, Card, cx, Empty } from '../components/ui';
import { Header } from './Overview';

const PRIORITY: Record<number, { label: string; tone: 'danger' | 'warn' | 'neutral' }> = {
  0: { label: 'emerg', tone: 'danger' },
  1: { label: 'alert', tone: 'danger' },
  2: { label: 'crit', tone: 'danger' },
  3: { label: 'error', tone: 'danger' },
  4: { label: 'warn', tone: 'warn' },
};

/** For someone the state says may not read the service log (a viewer), the refusal the server would give; null otherwise. */
export const logsRefusal = (state: Pick<State, 'canReadLogs' | 'user' | 'role'>) =>
  state.canReadLogs === false ? `the service log is for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;

/** The coordinator's service log, read-only: newest at the bottom, refreshed every 10 s while open. Not asked for when refused. */
export function LogsPage({ refused = null }: { refused?: string | null }) {
  const [log, setLog] = useState<ServiceLog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (refused) return;
    let live = true;
    const load = () =>
      api<ServiceLog>('/api/logs?lines=300')
        .then((l) => live && (setLog(l), setErr(null)))
        .catch((e: Error) => live && setErr(e.message));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [refused]);
  if (refused)
    return (
      <div data-testid="page-logs">
        <Header title="Logs" sub="read-only" />
        <div className="p-6">
          <Card className="p-3 text-[13px] text-ink-3" data-testid="logs-refused">
            {refused[0]!.toUpperCase() + refused.slice(1)}.
          </Card>
        </div>
      </div>
    );
  const sub = !log ? 'loading…' : log.source === 'journal' ? `journal of ${log.unit}` : log.source === 'file' ? 'coordinator log file' : 'no log';
  return (
    <div data-testid="page-logs">
      <Header title="Logs" sub={`${sub} · read-only`} />
      <div className="space-y-3 p-6">
        {err && <div className="text-sm text-danger">Can't load: {err}</div>}
        {log?.problem && (
          <Card className="border-warn/40 bg-warn/10 p-3 text-sm" data-log-problem>
            {log.problem}
          </Card>
        )}
        {log && !log.entries.length && !log.problem && <Empty title="No lines yet" />}
        {!!log?.entries.length && (
          <Card className="overflow-hidden">
            <ol className="max-h-[70vh] overflow-auto font-mono text-[11px] leading-snug">
              {log.entries.map((e, i) => {
                const p = e.priority !== null ? PRIORITY[e.priority] : undefined;
                return (
                  <li key={i} className={cx('flex gap-3 border-b px-3 py-1 last:border-b-0', p?.tone === 'danger' && 'bg-danger/5')}>
                    <span className="w-16 shrink-0 text-muted-foreground" title={e.at ?? undefined}>
                      {e.at ? ago(e.at) : ''}
                    </span>
                    {p && (
                      <Badge tone={p.tone} className="shrink-0">
                        {p.label}
                      </Badge>
                    )}
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.message}</span>
                  </li>
                );
              })}
            </ol>
          </Card>
        )}
      </div>
    </div>
  );
}

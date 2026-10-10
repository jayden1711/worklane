import type { State } from '../api';
import { navigate } from '../App';
import { ago, Avatar, Badge, Card, cx, Empty, EST_NOTE, estUsd } from '../components/ui';
import { Header } from './Overview';

const REASON_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'neutral'> = { succeeded: 'ok', error: 'danger', stalled: 'danger', timeout: 'danger', rate_limited: 'warn', budget_exhausted: 'warn', auth_mismatch: 'danger' };

export function Agents({ state }: { state: State }) {
  const g = state.governor;
  return (
    <div>
      <Header title="Agents" sub={`${state.slots.running} of ${state.slots.cap} machine-wide slots in use`} />
      <div className="space-y-6 p-6">
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Governor</div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span className={cx('size-2 rounded-full', g?.held ? 'bg-warn' : 'bg-ok')} />
              {g?.held ? 'Holding new starts' : 'Starting work when free'}
            </div>
            {g?.held && <div className="mt-1 text-xs">{g.reason}</div>}
            {g && (
              <div className="mt-1 text-xs text-muted-foreground">
                load {g.load ?? '?'} · free disk {g.freeDiskPct ?? '?'}% · {ago(g.at)}
              </div>
            )}
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Slots on this machine</div>
            <ul className="mt-2 space-y-1 text-xs">
              {state.slots.agents.map((a) => (
                <li key={a.slot} className="flex justify-between gap-2">
                  <span className="truncate">{a.owner}</span>
                  <span className="text-muted-foreground">
                    pid {a.pid} · {ago(a.acquiredAt)}
                  </span>
                </li>
              ))}
              {!state.slots.agents.length && <li className="text-muted-foreground">All free.</li>}
              {state.slots.fullRun && <li className="pt-1">Full test run: {state.slots.fullRun.owner}</li>}
            </ul>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground" title={EST_NOTE}>Estimated spend today by role</div>
            <div className="mt-2 space-y-1">
              {Object.entries(state.spendByRole).map(([r, v]) => (
                <div key={r} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{r}</span>
                  <span className="tabular-nums" title={EST_NOTE}>{estUsd(v)}</span>
                </div>
              ))}
              {!Object.keys(state.spendByRole).length && <div className="text-xs text-muted-foreground">Nothing spent today.</div>}
            </div>
          </Card>
        </div>

        <Card>
          <div className="border-b px-4 py-2.5 text-sm font-medium">Running now ({state.runs.active.length})</div>
          {state.runs.active.length ? (
            <ul className="divide-y">
              {state.runs.active.map((r) => (
                <li key={`${r.issue}-${r.role}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <Avatar login={r.role} />
                  <span className="w-36 truncate">{r.role}</span>
                  <button className="font-mono text-xs text-info hover:underline" onClick={() => navigate(`/issues/${r.issue}`)}>
                    #{r.issue}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.note ?? 'started'}</span>
                  <Badge>{r.model}</Badge>
                  <span className="w-24 text-right text-xs text-muted-foreground">attempt {r.attempt}</span>
                  <span className="w-20 text-right text-xs text-muted-foreground" title={`pid ${r.pid}`}>
                    {ago(r.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <Empty title="No agents running" hint="Workers start when there is ready work, budget, and room on the machine." />
            </div>
          )}
        </Card>

        <Card>
          <div className="border-b px-4 py-2.5 text-sm font-medium">Recent runs</div>
          {state.runs.recent.length ? (
            <ul className="divide-y">
              {state.runs.recent.map((r, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="w-36 truncate">{r.role}</span>
                  <button className="font-mono text-xs text-info hover:underline" onClick={() => navigate(`/issues/${r.issue}`)}>
                    #{r.issue}
                  </button>
                  <Badge tone={REASON_TONE[r.reason ?? ''] ?? 'neutral'}>{r.reason}</Badge>
                  <span className="ml-auto w-16 text-right text-xs tabular-nums" title={EST_NOTE}>{estUsd(r.costUsd)}</span>
                  <span className="w-20 text-right text-xs text-muted-foreground">{ago(r.finishedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No finished runs yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

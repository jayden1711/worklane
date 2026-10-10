import type { State } from '../api';
import { navigate } from '../App';
import { StatusMark, TaskRow } from '../components/patterns';
import { ago, Badge, Card, cx, Empty, EST_NOTE, estUsd } from '../components/ui';
import { Header } from './Overview';

const REASON_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'neutral'> = { succeeded: 'ok', error: 'danger', stalled: 'danger', timeout: 'danger', rate_limited: 'warn', budget_exhausted: 'warn', auth_mismatch: 'danger' };

export function Agents({ state }: { state: State }) {
  const g = state.governor;
  return (
    <div data-testid="page-agents">
      <Header title="Agents" sub={`${state.slots.running} of ${state.slots.cap} machine-wide slots in use`} />
      <div className="space-y-6 p-6">
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="p-3">
            <div className="text-[12px] font-medium text-ink-3">Governor</div>
            <div className="mt-1 flex items-center gap-2 text-[13px] text-ink">
              <span className={cx('size-2 rounded-full', g?.held ? 'bg-orange' : 'bg-green')} />
              {g?.held ? 'Holding new starts' : 'Starting work when free'}
            </div>
            {g?.held && <div className="mt-1 text-[12px] text-ink-2">{g.reason}</div>}
            {g && (
              <div className="mt-1 text-[12px] text-ink-3">
                load {g.load ?? '?'} · free disk {g.freeDiskPct ?? '?'}% · {ago(g.at)}
              </div>
            )}
          </Card>
          <Card className="p-3">
            <div className="text-[12px] font-medium text-ink-3">Slots on this machine</div>
            <ul className="mt-2 space-y-1 text-[12px] text-ink">
              {state.slots.agents.map((a) => (
                <li key={a.slot} className="flex justify-between gap-2">
                  <span className="truncate">{a.owner}</span>
                  <span className="text-ink-3">
                    pid {a.pid} · {ago(a.acquiredAt)}
                  </span>
                </li>
              ))}
              {!state.slots.agents.length && <li className="text-ink-3">All free.</li>}
              {state.slots.fullRun && <li className="pt-1">Full test run: {state.slots.fullRun.owner}</li>}
            </ul>
          </Card>
          <Card className="p-3">
            <div className="text-[12px] font-medium text-ink-3" title={EST_NOTE}>
              Estimated spend today by role
            </div>
            <div className="mt-2 space-y-1">
              {Object.entries(state.spendByRole).map(([r, v]) => (
                <div key={r} className="flex justify-between text-[12px]">
                  <span className="text-ink-2">{r}</span>
                  <span className="tabular-nums text-ink" title={EST_NOTE}>
                    {estUsd(v)}
                  </span>
                </div>
              ))}
              {!Object.keys(state.spendByRole).length && <div className="text-[12px] text-ink-3">Nothing spent today.</div>}
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Running now ({state.runs.active.length})</div>
          {state.runs.active.length ? (
            <div>
              {state.runs.active.map((r, i) => (
                <TaskRow
                  key={`${r.issue}-${r.role}`}
                  index={i}
                  mark={<StatusMark state="running">{r.attempt}</StatusMark>}
                  label={
                    <>
                      {r.role} <span className="font-mono font-normal text-blue-ink">#{r.issue}</span> <span className="font-normal text-ink-3">· {r.note ?? 'started'}</span>
                    </>
                  }
                  amount={<span title={`pid ${r.pid}`}>started {ago(r.startedAt)}</span>}
                  pill={<Badge>{r.model}</Badge>}
                  onClick={() => navigate(`/issues/${r.issue}`)}
                />
              ))}
            </div>
          ) : (
            <div className="p-3">
              <Empty title="No agents running" hint="Workers start when there is ready work, budget, and room on the machine." />
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Recent runs</div>
          {state.runs.recent.length ? (
            <div>
              {state.runs.recent.map((r, i) => (
                <TaskRow
                  key={i}
                  index={i}
                  mark={<StatusMark state={r.reason === 'succeeded' ? 'done' : 'failed'} />}
                  label={
                    <>
                      {r.role} <span className="font-mono font-normal text-blue-ink">#{r.issue}</span>
                    </>
                  }
                  amount={
                    <>
                      <span title={EST_NOTE}>{estUsd(r.costUsd)}</span> · {ago(r.finishedAt)}
                    </>
                  }
                  pill={<Badge tone={REASON_TONE[r.reason ?? ''] ?? 'neutral'}>{r.reason}</Badge>}
                  onClick={() => navigate(`/issues/${r.issue}`)}
                />
              ))}
            </div>
          ) : (
            <div className="p-4 text-[12.5px] text-ink-3">No finished runs yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

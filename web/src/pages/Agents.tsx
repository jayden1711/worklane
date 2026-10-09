import type { State } from '../api';
import { navigate } from '../App';
import { ago, Avatar, Badge, Card, cx, Empty, usd } from '../components/ui';
import { Header } from './Overview';

const REASON_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'neutral'> = { succeeded: 'ok', error: 'danger', stalled: 'danger', timeout: 'danger', rate_limited: 'warn', budget_exhausted: 'warn', auth_mismatch: 'danger' };

const COND_TONE = { pass: 'ok', fail: 'danger', unknown: 'neutral' } as const;

/** The shared cap across every instance on this machine, and why it is where it is. */
function CapCard({ state }: { state: State }) {
  const c = state.capInfo;
  if (!c.adaptive) {
    return (
      <Card className="p-4 text-sm">
        <span className="text-muted-foreground">Shared agent cap:</span> fixed at {state.slots.cap}
      </Card>
    );
  }
  if (!c.state) return <Card className="p-4 text-sm text-muted-foreground">Shared agent cap: adaptive, not evaluated yet.</Card>;
  const s = c.state;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <span className="text-sm font-medium">Shared agent cap</span>
        <span className="text-2xl font-semibold tabular-nums">{s.cap}</span>
        <span className="text-xs text-muted-foreground">
          floor {s.floor} · ceiling {s.ceiling} · checked {ago(s.checkedAt)}
        </span>
      </div>
      <div className="space-y-3 p-4">
        <div className="text-sm">
          {s.reason} <span className="text-xs text-muted-foreground">({ago(s.changedAt)})</span>
        </div>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {s.conditions.map((x) => (
            <li key={x.name} className="flex items-start gap-2 text-xs">
              <Badge tone={COND_TONE[x.state]}>{x.state}</Badge>
              <span>
                <span className="font-medium">{x.name}</span> <span className="text-muted-foreground">{x.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        {!!c.changes.length && (
          <ul className="space-y-1 border-t pt-2 text-xs">
            {c.changes.map((ch, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{ago(ch.at)}</span>
                <span className="shrink-0 whitespace-nowrap tabular-nums">{ch.from === ch.to ? `start ${ch.to}` : `${ch.from} → ${ch.to}`}</span>
                <span className="min-w-0 truncate text-muted-foreground" title={ch.reason}>
                  {ch.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

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
            <div className="text-xs text-muted-foreground">Spend today by role</div>
            <div className="mt-2 space-y-1">
              {Object.entries(state.spendByRole).map(([r, v]) => (
                <div key={r} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{r}</span>
                  <span className="tabular-nums">{usd(v)}</span>
                </div>
              ))}
              {!Object.keys(state.spendByRole).length && <div className="text-xs text-muted-foreground">Nothing spent today.</div>}
            </div>
          </Card>
        </div>

        <CapCard state={state} />

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
                  <span className="ml-auto w-16 text-right text-xs tabular-nums">{usd(r.costUsd)}</span>
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

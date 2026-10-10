import type { State } from '../api';
import { navigate } from '../App';
import { HealthPanel } from '../components/HealthPanel';
import { InsightCard } from '../components/patterns';
import { ago, Badge, Card, cx, Empty, EST_NOTE, estUsd, usd } from '../components/ui';

export function Header({ title, children, sub }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-line bg-page/90 px-6 backdrop-blur">
      <h1 className="text-[14px] font-semibold tracking-tight text-ink" data-testid="page-title">{title}</h1>
      {sub && <span className="truncate text-[12.5px] text-ink-3">{sub}</span>}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </header>
  );
}

/** A headline figure, as an insight card (Beautiful UI). */
const Stat = InsightCard;

const ACTIVE = new Set(['claimed', 'reproducing', 'building', 'verifying', 'evaluating']);

export function Overview({ state, pulse }: { state: State; pulse: number }) {
  const active = state.tasks.filter((t) => ACTIVE.has(t.status));
  const open = state.decisions.filter((d) => !d.answer);
  const blocked = state.tasks.filter((t) => t.status === 'blocked');
  const queued = state.tasks.filter((t) => t.status === 'queued');
  const budgetPct = Math.min(100, (state.spendToday / Math.max(state.budget, 0.01)) * 100);
  const stale = state.coordinator?.lastTick ? Date.now() - Date.parse(state.coordinator.lastTick) > 5 * 60_000 : true;

  return (
    <div data-testid="page-overview">
      <Header title="Overview" sub={`${state.project.repo} · land mode ${state.project.landMode}`} />
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Agents running" value={`${state.slots.running} / ${state.slots.cap}`} hint="machine-wide, all harnesses" />
          <Stat label="In progress" value={active.length} hint={active.map((t) => `#${t.issue}`).join(' ') || 'nothing running'} />
          <Stat label="Needs a decision" value={open.length} tone={open.length ? 'warn' : undefined} hint={open[0] ? `oldest ${ago(open.at(-1)!.askedAt)}` : 'none waiting'} />
          <Stat label="Blocked" value={blocked.length} tone={blocked.length ? 'danger' : undefined} hint={blocked[0]?.blockedReason ?? 'none'} />
          <Stat label="Landed today" value={state.landedToday} tone={state.landedToday ? 'ok' : undefined} hint={`${queued.length} queued to land`} />
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span title={EST_NOTE}>Estimated spend today</span>
              <span className="tabular-nums" title={EST_NOTE}>
                {estUsd(state.spendToday)} of {usd(state.budget)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover-2" role="progressbar" aria-valuenow={Math.round(budgetPct)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cx('h-full rounded-full', budgetPct > 90 ? 'bg-red' : budgetPct > 70 ? 'bg-orange' : 'bg-blue')} style={{ width: `${budgetPct}%` }} />
            </div>
            <div className="mt-3 space-y-1">
              {Object.entries(state.spendByRole)
                .sort((a, b) => b[1] - a[1])
                .map(([role, v]) => (
                  <div key={role} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{role}</span>
                    <span className="tabular-nums" title={EST_NOTE}>{estUsd(v)}</span>
                  </div>
                ))}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Main's baseline</div>
            {state.baseline ? (
              <>
                <div className="mt-1 text-sm">
                  <span className="text-2xl font-semibold tabular-nums">{state.baseline.failing.length}</span> failing at <span className="font-mono text-xs">{state.baseline.sha.slice(0, 8)}</span>
                </div>
                <div className="text-xs text-muted-foreground">recorded {ago(state.baseline.at)}; changes land if they add no new failures</div>
                <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto text-xs">
                  {state.baseline.failing.map((f) => (
                    <li key={f} className="truncate text-muted-foreground" title={f}>
                      · {f}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">None recorded. Until there is one, a red run can't land.</div>
            )}
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Coordinator</div>
            {state.coordinator ? (
              <div className="mt-1 space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className={cx('size-2 rounded-full', stale ? 'bg-danger' : 'bg-ok')} />
                  {state.coordinator.instance}
                </div>
                <div className="text-xs text-muted-foreground">
                  started {ago(state.coordinator.startedAt)} · last tick {ago(state.coordinator.lastTick)}
                </div>
                {state.slots.fullRun && <div className="text-xs">Full test run: {state.slots.fullRun.owner}</div>}
              </div>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">Not started on this machine.</div>
            )}
            {!!state.errors.length && (
              <div className="mt-3 space-y-1">
                {state.errors.slice(0, 3).map((e, i) => (
                  <div key={i} className="truncate text-xs text-danger" title={e.message}>
                    {e.where}: {e.message}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <HealthPanel />

        <Card className="overflow-hidden">
          <div className="primitive-card-bar flex items-center justify-between border-b border-line">
            <span className="text-[13px] font-medium text-ink">Recent activity</span>
            <span key={pulse} className="text-[11px] text-muted-foreground">live</span>
          </div>
          {state.activity.length ? (
            <ul className="divide-y divide-line">
              {state.activity.slice(0, 25).map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-[13px] text-ink transition-colors hover:bg-inset">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground">{ago(a.ts)}</span>
                  {a.issue !== null ? (
                    <button className="w-12 shrink-0 text-left font-mono text-[12px] text-blue-ink hover:underline" onClick={() => navigate(`/issues/${a.issue}`)}>
                      #{a.issue}
                    </button>
                  ) : (
                    <span className="w-12 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{a.summary}</span>
                  <Badge className="hidden sm:inline-flex">{a.type}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <Empty title="No activity yet" hint="Events appear here as the coordinator works." />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

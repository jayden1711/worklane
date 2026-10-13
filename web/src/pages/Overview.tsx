import type { State, UsageInfo } from '../api';
import { MenuButton, navigate } from '../App';
import { InsightCard } from '../components/patterns';
import { ago, Badge, Card, cx, Empty, EST_NOTE, estUsd, usd } from '../components/ui';
import { IntakeHealthPanel } from './Intake';
import { UsageLines } from '../components/Usage';

export function Header({ title, children, sub }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-line bg-page/90 px-6 backdrop-blur max-md:gap-2 max-md:px-4">
        <MenuButton />
        <h1 className="text-[14px] font-semibold tracking-tight text-ink" data-testid="page-title">{title}</h1>
        {sub && <span className="truncate text-[12.5px] text-ink-3 max-md:hidden">{sub}</span>}
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </header>
      {/* On a phone the line under the title is whole, under the bar, rather than cut short in it. */}
      {sub && <p className="px-6 pt-3 text-[12.5px] text-ink-3 md:hidden">{sub}</p>}
    </>
  );
}

/** A headline figure, as an insight card (Beautiful UI). */
const Stat = InsightCard;

/** The machine in a line: slots in use, the governor's last reading, and the way to its page (health moved there). */
export function MachineSummary({ state }: { state: State }) {
  const g = state.governor;
  return (
    <Card className="primitive-card-pad flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]" data-testid="overview-machine">
      <span className="text-[13px] font-medium text-ink">Machine</span>
      <span className="tabular-nums text-ink-2">
        {state.slots.running} of {state.slots.cap} agent slots in use
      </span>
      {g && (
        <span className={cx('tabular-nums', g.held ? 'text-orange' : 'text-ink-2')}>
          {g.held ? `dispatch held: ${g.reason}` : 'dispatch running'}
          {g.load !== null ? ` · load ${g.load.toFixed(1)}` : ''}
          {g.freeDiskPct !== null ? ` · ${Math.round(g.freeDiskPct)}% disk free` : ''}
        </span>
      )}
      <button className="ml-auto text-blue-ink hover:underline" onClick={() => navigate('/machine')} data-testid="overview-machine-link">
        Memory, load, disk, backups and settings on the Machine page
      </button>
    </Card>
  );
}

const ACTIVE = new Set(['claimed', 'reproducing', 'building', 'verifying', 'evaluating']);

export function Overview({ state, pulse, usage = [], now = Date.now() }: { state: State; pulse: number; usage?: UsageInfo[]; now?: number }) {
  const active = state.tasks.filter((t) => ACTIVE.has(t.status));
  const open = state.decisions.filter((d) => !d.answer);
  const blocked = state.tasks.filter((t) => t.status === 'blocked');
  const queued = state.tasks.filter((t) => t.status === 'queued');
  // Absent for a viewer: spend and the budget are the owners' and writers'.
  const spend = state.spendToday !== undefined && state.budget !== undefined ? { today: state.spendToday, budget: state.budget, byRole: state.spendByRole ?? {} } : null;
  // The budget is a configured cap, not a cost: shown as is.
  const budget = spend?.budget ?? 0;
  const budgetPct = spend ? Math.min(100, (spend.today / Math.max(spend.budget, 0.01)) * 100) : 0;
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

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {spend ? (
          <Card className="p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span title={EST_NOTE}>Estimated spend today</span>
              <span className="tabular-nums" title={EST_NOTE}>
                {estUsd(spend.today)} of {usd(budget)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover-2" role="progressbar" aria-valuenow={Math.round(budgetPct)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cx('h-full rounded-full', budgetPct > 90 ? 'bg-red' : budgetPct > 70 ? 'bg-orange' : 'bg-blue')} style={{ width: `${budgetPct}%` }} />
            </div>
            <div className="mt-3 space-y-1">
              {Object.entries(spend.byRole)
                .sort((a, b) => b[1] - a[1])
                .map(([role, v]) => (
                  <div key={role} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{role}</span>
                    <span className="tabular-nums" title={EST_NOTE}>{estUsd(v)}</span>
                  </div>
                ))}
            </div>
          </Card>
          ) : (
            <Card className="p-3 text-[12.5px] text-ink-3" data-testid="spend-viewer-only">
              Costs, spend and the budget are for the instance's owners and writers (write on its repo).
            </Card>
          )}
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
            {!state.errors && !!state.errorCount && (
              <div className="mt-3 text-xs text-danger" data-testid="coordinator-errors-count">
                The coordinator reported errors ({state.errorCount}).
              </div>
            )}
            {!!state.errors?.length && (
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

        <MachineSummary state={state} />
        <UsageLines usage={usage} now={now} />
        <IntakeHealthPanel state={state} />

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
                  <span className="min-w-0 flex-1 truncate max-md:whitespace-normal max-md:break-words">{a.summary}</span>
                  <Badge className="max-sm:hidden">{a.type}</Badge>
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

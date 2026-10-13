// The Claude usage limit on the dashboard: while an instance is paused on it, a banner on every page counting down
// to its reset; and on the Overview, a usage line per instance (today's runs, limit hits, running or paused). Read
// from each instance's /api/usage (on a hub, every instance that answers; elsewhere, this page's own server).
import { useEffect, useState } from 'react';
import { api, hub, instanceApi, type UsageInfo } from '../api';
import { ago, Card, cx } from './ui';

/** How long until `resetAt`, as "2 h 05 min 09 s" (or "now" once it has passed). */
export function countdown(resetAt: string, now: number): string {
  const s = Math.max(0, Math.floor((Date.parse(resetAt) - now) / 1000));
  if (s === 0) return 'now';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h} h ${pad(m)} min ${pad(s % 60)} s` : `${m} min ${pad(s % 60)} s`;
}

/** The reset as a local time of day (and date when it isn't today), for the viewer's own clock. */
export function resetClock(resetAt: string, now: number): string {
  const d = new Date(resetAt);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** A clock that ticks every second while something counts down. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

/** Every instance's usage this page can read: re-read every 30 s and whenever the event log moves (`lastId`). */
export function useUsage(lastId: number | undefined): UsageInfo[] {
  const [usage, setUsage] = useState<UsageInfo[]>([]);
  useEffect(() => {
    let gone = false;
    const load = async () => {
      const h = await hub;
      const got = h ? await Promise.all(h.instances.filter((i) => i.up).map((i) => instanceApi<UsageInfo>(i.name, '/api/usage').catch(() => null))) : [await api<UsageInfo>('/api/usage').catch(() => null)];
      if (!gone) setUsage(got.filter((u): u is UsageInfo => u !== null));
    };
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => {
      gone = true;
      window.clearInterval(t);
    };
  }, [lastId]);
  return usage;
}

/** One banner per paused instance, on every page, counting down to its reset. */
export function UsageBanner({ usage, now }: { usage: UsageInfo[]; now: number }) {
  const paused = usage.filter((u) => u.paused);
  if (!paused.length) return null;
  return (
    <>
      {paused.map((u) => {
        const p = u.paused!;
        const due = Date.parse(p.resetAt) <= now;
        return (
          <div key={u.instance} role="status" className="mx-6 mt-4 rounded-card bg-orange-tint px-4 py-3 text-[13px] shadow-[0_0_0_1px_var(--orange-tint)]" data-testid="usage-banner" data-instance={u.instance}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-semibold text-orange">Paused on the Claude usage limit</span>
              <span className="text-ink-2">{u.instance}</span>
              <span className="ml-auto text-[13px] font-medium tabular-nums text-ink" data-testid="usage-countdown" aria-live="off">
                {due ? 'resuming now' : `resumes in ${countdown(p.resetAt, now)}`}
              </span>
            </div>
            <div className="mt-1 text-ink-2">
              No new runs start until {resetClock(p.resetAt, now)}
              {p.source === 'default' ? " (claude's message named no reset time, so this is the default wait)" : ''}. The task it hit was requeued, not failed; it resumes on
              its own. Paused {ago(p.since)}.
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The Overview's usage lines: one per instance, today's runs and limit hits, and whether it's running or paused. */
export function UsageLines({ usage, now }: { usage: UsageInfo[]; now: number }) {
  if (!usage.length) return null;
  return (
    <Card className="primitive-card-pad space-y-1.5 text-[12.5px]" data-testid="overview-usage">
      <div className="text-[13px] font-medium text-ink">Claude usage</div>
      {usage.map((u) => (
        <div key={u.instance} className="flex flex-wrap items-center gap-x-4 gap-y-0.5" data-testid="usage-line" data-instance={u.instance}>
          <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
            <span className={cx('size-2 shrink-0 rounded-full', u.paused ? 'bg-orange' : 'bg-green')} />
            <span className="truncate">{u.instance}</span>
          </span>
          <span className="tabular-nums text-ink-2">{u.today.runs} runs today</span>
          <span className={cx('tabular-nums', u.today.limitHits ? 'text-orange' : 'text-ink-2')}>
            {u.today.limitHits} usage-limit {u.today.limitHits === 1 ? 'hit' : 'hits'} today
          </span>
          <span className={cx('tabular-nums sm:ml-auto', u.paused ? 'text-orange' : 'text-ink-3')} data-testid="usage-line-status">
            {u.paused ? `paused until ${resetClock(u.paused.resetAt, now)} (${countdown(u.paused.resetAt, now)})` : u.lastHit ? `running · last limit hit ${ago(u.lastHit)}` : 'running'}
          </span>
        </div>
      ))}
    </Card>
  );
}

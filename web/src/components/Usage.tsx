// The Claude usage limit on the dashboard: while an instance is paused on it, a banner on every page counting down
// to its reset; and on the Overview, a usage line per instance (today's runs, limit hits, running or paused). Read
// from each instance's /api/usage (on a hub, every instance that answers; elsewhere, this page's own server).
import { useEffect, useRef, useState } from 'react';
import { api, hub, hubNow, instanceApi, scopeNowOrNull, viewUrl, type UsageInfo } from '../api';
import { peek } from '../cache';
import { ago, Button, Card, cx } from './ui';

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

/**
 * Every instance's usage this page can read: shown at once from what was kept (web/src/cache.ts), re-read every 30 s,
 * and the instance shown's again whenever its event log moves (`lastId`; the others' logs don't move with it).
 * `answered`: every instance's first answer (or failure) is in, or was kept, or USAGE_WAIT_MS has passed: until then
 * the page waits, so a banner never appears above controls already on screen (#455: a pause's banner answering last
 * moved every page 83 px). The bound keeps a usage request that hangs from holding every page on Loading; an answer
 * after it may still add the banner late.
 */
/** The longest a page waits for the usage's first answer before it shows anyway. */
export const USAGE_WAIT_MS = 3_000;

export function useUsage(lastId: number | undefined): { usage: UsageInfo[]; answered: boolean } {
  const names = (): (string | null)[] => {
    const h = hubNow();
    return h ? h.instances.filter((i) => i.up).map((i) => i.name) : [null];
  };
  const got = useRef<Map<string | null, UsageInfo | null>>(null as unknown as Map<string | null, UsageInfo | null>);
  got.current ??= new Map(names().map((n) => [n, peek<UsageInfo>(viewUrl('/api/usage', n))?.data ?? null]));
  const shown = () => names().flatMap((n) => (got.current.get(n) ? [got.current.get(n)!] : []));
  const [usage, setUsage] = useState<UsageInfo[]>(shown);
  const [answered, setAnswered] = useState(() => names().every((n) => got.current.get(n)));
  const gone = useRef(false);
  const load = async (which: (string | null)[]) => {
    await hub;
    await Promise.all(which.map(async (n) => got.current.set(n, await (n ? instanceApi<UsageInfo>(n, '/api/usage') : api<UsageInfo>('/api/usage')).catch(() => null))));
    if (!gone.current) (setUsage(shown()), setAnswered(true));
  };
  useEffect(() => {
    gone.current = false;
    void load(names());
    const t = window.setInterval(() => void load(names()), 30_000);
    const bound = window.setTimeout(() => setAnswered(true), USAGE_WAIT_MS);
    return () => {
      gone.current = true;
      window.clearInterval(t);
      window.clearTimeout(bound);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load([scopeNowOrNull()?.current ?? null]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);
  return { usage, answered };
}

/** The owner's re-check of a refused login: the coordinator makes one tiny real call on its next tick. */
function RecheckSignin({ instance }: { instance: string }) {
  const [state, setState] = useState<'idle' | 'asking' | 'asked' | string>('idle');
  const ask = async () => {
    setState('asking');
    const init = { method: 'POST' };
    try {
      await (hubNow() ? instanceApi(instance, '/api/claude-auth/recheck', init) : api('/api/claude-auth/recheck', init));
      setState('asked');
    } catch (e) {
      setState((e as Error).message || 'the re-check could not be asked for');
    }
  };
  return (
    <span className="ml-auto flex items-center gap-2">
      {state === 'asked' && <span className="text-ink-2">asked: checked within a minute</span>}
      {state !== 'idle' && state !== 'asking' && state !== 'asked' && <span className="text-red">{state}</span>}
      <Button size="sm" variant="outline" disabled={state === 'asking'} onClick={() => void ask()} data-testid="signin-recheck">
        Re-check sign-in
      </Button>
    </span>
  );
}

/** One banner per Claude login the API refused (src/claude-auth-failure.ts): who it is, Claude's words, and what to do. */
function SigninBanner({ usage }: { usage: UsageInfo[] }) {
  const failed = usage.filter((u) => u.signinFailed?.length);
  if (!failed.length) return null;
  return (
    <>
      {failed.map((u) =>
        u.signinFailed!.map((f) => (
          <div key={`${u.instance} ${f.login}`} role="alert" className="mx-6 mt-4 rounded-card bg-red-tint px-4 py-3 text-[13px] shadow-[0_0_0_1px_var(--red-tint)]" data-testid="signin-banner" data-instance={u.instance}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-semibold text-red">Claude sign-in failed: no new runs</span>
              <span className="text-ink-2">{u.instance}</span>
              {u.canRecheckSignin && <RecheckSignin instance={u.instance} />}
            </div>
            <div className="mt-1 text-ink-2">
              Claude refused the login <span className="font-medium text-ink">{f.login}</span> {ago(f.since)}. No new Claude run starts on it (tasks were requeued, not failed). Sign the agent user in to Claude
              again (switch the Claude account); it resumes on its own once a check call on the login succeeds.
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-ink-2" data-testid="signin-detail">
              Claude said: {f.detail}
            </div>
            {f.lastCheck && (
              <div className="mt-1 text-ink-3">
                Last checked {ago(f.lastCheck.at)}: {f.lastCheck.ok ? 'answered' : f.lastCheck.detail}
              </div>
            )}
          </div>
        )),
      )}
    </>
  );
}

/** One banner per paused instance, on every page, counting down to its reset; and one per refused Claude login. */
export function UsageBanner({ usage, now }: { usage: UsageInfo[]; now: number }) {
  const paused = usage.filter((u) => u.paused);
  if (!paused.length) return <SigninBanner usage={usage} />;
  return (
    <>
      <SigninBanner usage={usage} />
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
            <span className={cx('size-2 shrink-0 rounded-full', u.signinFailed?.length ? 'bg-red' : u.paused ? 'bg-orange' : 'bg-green')} />
            <span className="truncate">{u.instance}</span>
          </span>
          <span className="tabular-nums text-ink-2">{u.today.runs} runs today</span>
          <span className={cx('tabular-nums', u.today.limitHits ? 'text-orange' : 'text-ink-2')}>
            {u.today.limitHits} usage-limit {u.today.limitHits === 1 ? 'hit' : 'hits'} today
          </span>
          <span className={cx('tabular-nums sm:ml-auto', u.signinFailed?.length ? 'text-red' : u.paused ? 'text-orange' : 'text-ink-3')} data-testid="usage-line-status">
            {u.signinFailed?.length ? 'Claude sign-in failed: no new runs' : u.paused ?`paused until ${resetClock(u.paused.resetAt, now)} (${countdown(u.paused.resetAt, now)})` : u.lastHit ? `running · last limit hit ${ago(u.lastHit)}` : 'running'}
          </span>
        </div>
      ))}
    </Card>
  );
}

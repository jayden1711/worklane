// Health: the machine's incidents in one place (src/watchdog/). Each instance's status as a dot; every open
// incident with what broke, since when, what the harness already tried and the one action that fixes it; the
// resolved ones folded into a history. Each incident is anchored (#incident-<id>): an ops-channel post links
// straight to it. A viewer sees that something broke and since when, not its detail or fix.
import { useEffect, useState } from 'react';
import { loadIncidents, mergeIncidents, refreshHub, statusOf, type DotStatus, type Incident, type InstanceIncidents } from '../api';
import { Loading } from '../components/patterns';
import { ago, Badge, Card, cx, Empty } from '../components/ui';
import { Header } from '../components/Header';

// The dot itself is the shell's too (the sidebar's): components/StatusDot.tsx.
import { StatusDot } from '../components/StatusDot';
export { STATUS_DOT, StatusDot } from '../components/StatusDot';

const span = (from: string, to: string) => {
  const m = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} days`;
};
const where = (x: Incident) => (x.instance ? x.instance : 'machine');

function OpenIncident({ x, targeted }: { x: Incident; targeted: boolean }) {
  const shown = x.detail !== undefined;
  return (
    <Card id={`incident-${x.id}`} data-testid="incident" data-severity={x.severity} data-targeted={targeted || undefined} className={cx('primitive-card-pad scroll-mt-16', targeted && 'ring-2 ring-blue')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot status={x.severity} />
        <span className="text-[13.5px] font-medium text-ink" data-testid="incident-title">
          {x.title}
        </span>
        <Badge tone={x.severity === 'red' ? 'danger' : 'warn'}>{where(x)}</Badge>
        <span className="ml-auto text-[12px] tabular-nums text-ink-3" title={x.since} data-testid="incident-since">
          since {ago(x.since)}
        </span>
      </div>
      {shown ? (
        <dl className="mt-2 grid grid-cols-1 gap-y-1.5 text-[12.5px] leading-relaxed sm:grid-cols-[max-content_1fr] sm:gap-x-4">
          <dt className="font-medium text-ink-3">What broke</dt>
          <dd className="min-w-0 break-words text-ink-2" data-testid="incident-detail">
            {x.detail}
          </dd>
          <dt className="font-medium text-ink-3">Already tried</dt>
          <dd className="min-w-0 break-words text-ink-2" data-testid="incident-tried">
            {x.tried?.length ? x.tried.join('; ') : 'nothing: it needs a person'}
          </dd>
          <dt className="font-medium text-ink-3">Fix</dt>
          <dd className="min-w-0 break-words font-medium text-ink" data-testid="incident-fix">
            {x.fix}
          </dd>
        </dl>
      ) : (
        <div className="mt-1.5 text-[12.5px] text-ink-3" data-testid="incident-detail-hidden">
          What broke and how to fix it are for the owners and writers.
        </div>
      )}
    </Card>
  );
}

/** The page from its data (also what the render checks render). `target`: the incident the address points at. */
export function HealthView({ all, target = null }: { all: InstanceIncidents[]; target?: string | null }) {
  const { open, resolved } = mergeIncidents(all);
  const status = statusOf(all);
  const hasTarget = !!target && resolved.some((x) => x.id === target);
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <section aria-label="Instances" className="flex flex-wrap gap-2" data-testid="health-instances">
        {all.map((a) => (
          <span key={a.name ?? ''} className="inline-flex h-7 items-center gap-2 rounded-full bg-surface px-3 text-[12.5px] font-medium text-ink shadow-card" data-testid="health-instance" title={a.error ?? undefined}>
            <StatusDot status={status[a.name ?? '']!} why={a.view ? null : a.error} testId="health-instance-dot" />
            {a.name ?? a.view?.instance ?? 'this instance'}
            {a.error && <span className="font-normal text-ink-3">not readable</span>}
          </span>
        ))}
      </section>

      <section aria-label="Open incidents" className="space-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-medium text-ink">Open</h2>
          <span className="text-[12px] tabular-nums text-ink-3">{open.length}</span>
        </div>
        {open.length ? (
          open.map((x) => <OpenIncident key={x.id} x={x} targeted={x.id === target} />)
        ) : (
          <div data-testid="health-all-clear">
            <Empty title="Nothing needs you" hint="No open incidents: every service is up, updates installed, sign-ins work, and work is moving." />
          </div>
        )}
      </section>

      <details className="group" data-testid="incident-history" open={hasTarget || undefined}>
        <summary className="flex cursor-pointer list-none items-baseline gap-2 text-[13px] font-medium text-ink">
          <span className="text-ink-3 transition-transform group-open:rotate-90" aria-hidden>
            ›
          </span>
          Resolved
          <span className="text-[12px] font-normal tabular-nums text-ink-3">{resolved.length}</span>
        </summary>
        <div className="mt-2 overflow-hidden rounded-card bg-surface shadow-card">
          {resolved.length ? (
            resolved.map((x) => (
              <div key={x.id} id={`incident-${x.id}`} className={cx('flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line px-3 py-2 text-[12.5px] last:border-0', x.id === target && 'bg-blue-tint')} data-testid="incident-resolved">
                <span className="size-2 shrink-0 rounded-full bg-ink-3" aria-hidden />
                <span className="font-medium text-ink">{x.title}</span>
                <span className="text-ink-3">{where(x)}</span>
                <span className="ml-auto tabular-nums text-ink-3" title={`${x.since} to ${x.resolvedAt}`}>
                  resolved {ago(x.resolvedAt)}, open {span(x.since, x.resolvedAt!)}
                </span>
              </div>
            ))
          ) : (
            <div className="px-3 py-2.5 text-[12.5px] text-ink-3">Nothing resolved yet.</div>
          )}
        </div>
      </details>
    </div>
  );
}

const targetOf = () => (typeof window !== 'undefined' ? (/^#incident-([A-Za-z0-9_-]+)$/.exec(window.location.hash)?.[1] ?? null) : null);

export function HealthPage() {
  const [all, setAll] = useState<InstanceIncidents[] | null>(null);
  const [target, setTarget] = useState<string | null>(targetOf);
  useEffect(() => {
    let live = true;
    // The hub's list asked again each time: an instance down at page load is read once it answers.
    const load = () => void refreshHub().then((h) => loadIncidents(h)).then((a) => live && setAll(a));
    load();
    const t = setInterval(load, 30_000);
    const onHash = () => setTarget(targetOf());
    window.addEventListener('hashchange', onHash);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  // A link to one incident (an ops-channel post) lands on it.
  useEffect(() => {
    if (all && target) document.getElementById(`incident-${target}`)?.scrollIntoView({ block: 'center' });
  }, [all, target]);
  return (
    <div data-testid="page-health">
      <Header title="Health" sub="what broke on this machine, what was tried, and the fix" />
      {all ? <HealthView all={all} target={target} /> : <Loading />}
    </div>
  );
}

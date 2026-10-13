// Trust (GET /api/trust, src/trust.ts): this instance's DORA-style numbers over 7 and 30 days (change failure rate,
// escaped bugs, time to restore, revise/reject rate, flaky checks, cost per merged PR, verification time per tier),
// by risk area, with a plain recommendation for the agent count and for each area's verification. Read-only: the
// panel has no control that changes anything; raising the agent count stays a machine owner's action.
import { useEffect, useState } from 'react';
import { api, type RiskArea, type State, type Trust, type TrustArea, type TrustWindow } from '../api';
import { Badge, Card, EST_NOTE, estUsd } from './ui';

const AREAS: RiskArea[] = ['money', 'auth', 'other'];
const AREA_LABEL: Record<RiskArea, string> = { money: 'Money path', auth: 'Auth', other: 'Other' };
const ADVICE: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  heavier: { label: 'Verify more', tone: 'danger' },
  lighter: { label: 'Could be lighter', tone: 'ok' },
  keep: { label: 'Keep as is', tone: 'neutral' },
  too_few: { label: 'Too few to judge', tone: 'neutral' },
};
const FAILURE_LABEL = { reverted: 'reverted', main_red: 'broke the default branch', fix_followed: 'a fix PR followed', escaped: 'a production bug traced to it' } as const;

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 1000) / 10}%`);
const hours = (h: number | null) => (h === null ? '–' : h < 1 ? `${Math.round(h * 60)} min` : `${h} h`);
const tokens = (n: number | null) => (n === null ? '–' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const minutes = (n: number) => (n < 1 ? `${Math.round(n * 60)} s` : `${Math.round(n * 10) / 10} min`);

interface Figure {
  key: string;
  label: string;
  value: (a: TrustArea, w: TrustWindow) => string;
  sub?: (a: TrustArea, w: TrustWindow) => string | null;
  /** Hidden for this reader when the server left it out. */
  shown: (a: TrustArea) => boolean;
}

const FIGURES: Figure[] = [
  { key: 'merges', label: 'Merged', value: (a) => String(a.merges ?? '–'), shown: (a) => a.merges !== null },
  { key: 'cfr', label: 'Change failure rate', value: (a) => pct(a.changeFailureRate), sub: (a) => (a.failures !== null && a.merges ? `${a.failures} of ${a.merges}` : null), shown: (a) => a.failures !== null },
  { key: 'escaped', label: 'Escaped bugs', value: (a) => String(a.escapedBugs ?? '–'), sub: (_a, w) => (w.escapedMoney !== null ? `${w.escapedMoney} on the money path` : null), shown: (a) => a.escapedBugs !== null },
  { key: 'restore', label: 'Time to restore', value: (a) => hours(a.medianRestoreHours), sub: (a) => (a.restoreHours?.length ? `median of ${a.restoreHours.length}` : null), shown: (a) => a.restoreHours !== null },
  { key: 'review', label: 'Revised or rejected', value: (a) => pct(a.reviseRejectRate), sub: (a) => (a.reviewed ? `${a.revisedOrRejected} of ${a.reviewed} reviewed` : null), shown: (a) => a.reviewed !== null },
  { key: 'flaky', label: 'Flaky checks', value: (a) => pct(a.flakyRate), sub: (a) => (a.checks ? `${a.flakyChecks} of ${a.checks}` : null), shown: (a) => a.checks !== null },
  { key: 'cost', label: 'Cost per merged PR', value: (a) => (a.cost?.perMergedPrUsd != null ? estUsd(a.cost.perMergedPrUsd) : '–'), sub: (a) => (a.cost ? `${tokens(a.cost.perMergedPrTokens)} tokens` : null), shown: (a) => a.cost !== null },
];

/** One figure: the last 7 days large, the last 30 under it. */
function FigureCard({ f, w7, w30 }: { f: Figure; w7: TrustWindow; w30: TrustWindow }) {
  const sub7 = f.sub?.(w7.total, w7);
  return (
    <Card className="min-w-0 p-3" data-testid="trust-figure" data-figure={f.key} title={f.key === 'cost' ? EST_NOTE : undefined}>
      <div className="truncate text-[12px] font-medium text-ink-3">{f.label}</div>
      <div className="mt-1 text-[22px] font-semibold tracking-tight tabular-nums text-ink" data-testid="trust-figure-7">
        {f.value(w7.total, w7)}
      </div>
      {sub7 && <div className="truncate text-[11.5px] text-ink-3">{sub7}</div>}
      <div className="mt-1.5 border-t border-line pt-1.5 text-[12px] tabular-nums text-ink-2" data-testid="trust-figure-30">
        30 days: <span className="font-medium text-ink">{f.value(w30.total, w30)}</span>
      </div>
    </Card>
  );
}

/** One risk area over 30 days: its change failure rate next to its cost and verification time, and the advice for it. */
function AreaCard({ area, a, advice }: { area: RiskArea; a: TrustArea; advice: NonNullable<Trust['verification']>[number] | undefined }) {
  const rows: [string, string][] = [
    ['Merged', String(a.merges ?? '–')],
    ['Change failure rate', `${pct(a.changeFailureRate)}${a.failures ? ` (${a.failures})` : ''}`],
    ['Escaped bugs', String(a.escapedBugs ?? '–')],
    ['Time to restore', hours(a.medianRestoreHours)],
    ['Revised or rejected', pct(a.reviseRejectRate)],
    ['Flaky checks', pct(a.flakyRate)],
    ...(a.cost ? ([['Cost per merged PR', a.cost.perMergedPrUsd !== null ? `${estUsd(a.cost.perMergedPrUsd)} · ${tokens(a.cost.perMergedPrTokens)} tokens` : '–']] as [string, string][]) : []),
  ];
  const a2 = advice ? ADVICE[advice.advice]! : null;
  return (
    <Card className="min-w-0 space-y-2 p-3" data-testid="trust-area" data-area={area}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{AREA_LABEL[area]}</span>
        {a2 && (
          <Badge tone={a2.tone} className="shrink-0">
            <span data-testid="trust-area-advice" data-advice={advice!.advice}>
              {a2.label}
            </span>
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="truncate text-ink-3">{k}</dt>
            <dd className="text-right tabular-nums text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {a.verification && (
        <div data-testid="trust-verification">
          <div className="text-[12px] font-medium text-ink-3">Verification time per tier</div>
          {a.verification.length ? (
            <ul className="mt-1 space-y-0.5">
              {a.verification.map((t) => (
                <li key={t.tier} className="flex justify-between gap-3 text-[12px]" data-testid="trust-tier">
                  <span className="min-w-0 truncate text-ink-2">{t.tier}</span>
                  <span className="shrink-0 tabular-nums text-ink-3">
                    {minutes(t.medianMinutes)} median · {t.runs}×
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[12px] text-ink-3">None recorded.</div>
          )}
        </div>
      )}
      {advice && <p className="text-[12px] leading-5 text-ink-2">{advice.text}</p>}
    </Card>
  );
}

/** The panel from its data (also what the render checks render). */
export function TrustView({ t }: { t: Trust }) {
  const w7 = t.windows.find((w) => w.days === 7)!;
  const w30 = t.windows.find((w) => w.days === 30)!;
  const figures = FIGURES.filter((f) => f.shown(w7.total));
  return (
    <section className="space-y-3" aria-label="Trust" data-testid="trust-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Trust</span>
        <span className="text-[12px] text-ink-3">the last 7 days, and 30; measured only, nothing here changes the agents, caps or merges</span>
      </div>

      {t.agents && (
        <Card className={`p-3 ${t.agents.action === 'raise' ? 'bg-green-tint' : ''}`} data-testid="trust-recommendation" data-action={t.agents.action}>
          <div className="text-[13px] font-medium text-ink">{t.agents.action === 'raise' ? `Ready to raise to ${t.agents.to} agents` : `Keep ${t.agents.now} agent${t.agents.now === 1 ? '' : 's'}`}</div>
          <ul className="mt-1 space-y-0.5">
            {t.agents.why.map((w) => (
              <li key={w.rule} className="flex gap-1.5 text-[12.5px] text-ink-2" data-testid="trust-rule" data-met={String(w.met)}>
                <span className={w.met ? 'text-green' : 'text-orange'} aria-hidden>
                  {w.met ? '✓' : '·'}
                </span>
                <span className="min-w-0">{w.rule}</span>
              </li>
            ))}
          </ul>
          <div className="mt-1.5 text-[12px] text-ink-3" data-testid="trust-note">
            {t.note}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {figures.map((f) => (
          <FigureCard key={f.key} f={f} w7={w7} w30={w30} />
        ))}
      </div>

      {w30.byArea && (
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium text-ink">By risk area, last 30 days</div>
          <div className="grid gap-3 lg:grid-cols-3">
            {AREAS.map((area) => (
              <AreaCard key={area} area={area} a={w30.byArea![area]} advice={t.verification?.find((v) => v.area === area)} />
            ))}
          </div>
        </div>
      )}

      {!!w30.failures?.length && (
        <div className="text-[12px] text-ink-3" data-testid="trust-failures">
          Failed, last 30 days:{' '}
          {w30.failures.map((f, i) => (
            <span key={f.issue} data-testid="trust-failure" data-kind={f.kind}>
              {i ? '; ' : ''}#{f.issue}
              {f.number !== null ? ` (PR #${f.number})` : ''} {FAILURE_LABEL[f.kind]}
              {f.by !== null ? ` (#${f.by})` : ''}
            </span>
          ))}
        </div>
      )}

      {t.hidden.length > 0 && (
        <div className="text-[12.5px] text-ink-3" data-testid="trust-hidden">
          The other figures ({t.hidden.join(', ')}) are for the instance's owners and writers: what they are made of isn't on the viewers' list.
        </div>
      )}

      <details className="text-[12px] text-ink-3" data-testid="trust-definitions">
        <summary className="cursor-pointer select-none">How each number is counted</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {t.definitions.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** Loaded for everyone: the server leaves out what a viewer may not see. */
export function TrustPanel({ state }: { state: State }) {
  const [t, setT] = useState<Trust | { error: string } | null>(null);
  useEffect(() => {
    api<Trust>('/api/trust')
      .then(setT)
      .catch((e: Error) => setT({ error: e.message }));
  }, [state.lastId]);
  if (!t) return null;
  if ('error' in t) return <div className="text-[13px] text-red">Can't load the trust numbers: {t.error}</div>;
  return <TrustView t={t} />;
}

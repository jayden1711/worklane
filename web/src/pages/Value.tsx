// The value report (GET /api/value, src/value-report.ts, #708): PRs the engine merged on its own vs held, why it held
// them by kind, what became of the held ones, the review hours saved (an estimate, with its formula and constants, and
// whether those are the owner's or the defaults),
// and what went wrong after merges. The instance's owners and writers only: anyone else gets no panel and no request.
import { useState } from 'react';
import { useView, type State } from '../api';
import { Button, Card } from '../components/ui';
import { Header } from '../components/Header';
import type { HeldOutcome, HoldKind, MainSaid, PostMerge, ValueReport } from '../../../src/value-report-types';

const DAYS = [7, 30, 90] as const;

/** The refusal the server would give; null only for an owner or a writer (fails closed when the role is unknown). */
export const valueRefusal = (state: Pick<State, 'user' | 'role'>) =>
  state.role === 'owner' || state.role === 'writer' ? null : `the value report is for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}`;

/** A short name per kind of src/hold-words.ts's table (a kind added there fails the web typecheck until named here). */
const KIND_LABEL: Record<HoldKind, string> = {
  'policy-off': 'Auto-merge off for the instance (kill switch)',
  'repo-off': 'Auto-merge off for the repo (kill switch)',
  stopped: 'Auto-merge stopped',
  never: 'Never auto-merged',
  'high-risk': 'High risk',
  design: 'Design-level',
  'outside-plan': 'Outside the approved plan',
  eval: 'Instruction evals',
  big: 'Too big',
  doubt: 'Doubt',
  'conflict-fix': 'Conflict fixed by an agent',
  'cant-merge': "GitHub can't merge it",
  'merge-failed': 'Merging failed',
  'mergeable-unknown': 'GitHub never said',
  combined: 'Fails with the latest default branch',
  ruleset: 'A required check did not pass',
  other: 'Other',
};
const OUTCOME_LABEL: Record<HeldOutcome, string> = {
  approved: 'merged on a person\'s approval',
  merged_by_person: 'merged by a person (inferred: no actor recorded)',
  closed: 'closed',
  waiting: 'still waiting',
};
const MAIN_LABEL: Record<MainSaid, string> = { green: 'green', red: 'red', reverted: 'reverted', none: 'no result recorded' };

const pct = (n: number | null) => (n === null ? 'no data' : `${Math.round(n * 100)}%`);
const hours = (ms: number | null) => (ms === null ? 'no data' : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

function Figure({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <Card className="p-3" data-testid={testId}>
      <div className="text-[12px] font-medium text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      {sub && <div className="text-[12px] text-ink-3">{sub}</div>}
    </Card>
  );
}

function PostRow({ name, p }: { name: string; p: PostMerge }) {
  return (
    <tr className="border-t border-line">
      <td className="py-1 pr-3">{name}</td>
      <td className="py-1 pr-3 tabular-nums">{p.merged}</td>
      <td className="py-1 pr-3 tabular-nums">{p.mainRed}</td>
      <td className="py-1 pr-3 tabular-nums">{p.reverts}</td>
      <td className="py-1 tabular-nums">
        {p.fixForward.fixed} fixed · {p.fixForward.reverted} reverted · {p.fixForward.gave_up} gave up
      </td>
    </tr>
  );
}

/** The report from its data. */
export function ValueReportView({ r }: { r: ValueReport }) {
  const c = r.hoursSaved.constants;
  return (
    <section className="space-y-4" aria-label="Value report" data-testid="value-panel">
      <div className="grid gap-3 md:grid-cols-4">
        <Figure testId="value-auto" label="Auto-merged" value={String(r.counts.auto)} sub="the engine merged on its own" />
        <Figure testId="value-held" label="Held" value={String(r.counts.held)} sub="left to a person" />
        <Figure testId="value-hold-rate" label="Hold rate" value={pct(r.counts.holdRate)} sub="held / (held + auto-merged)" />
        <Figure testId="value-hours" label="Review hours saved (estimate)" value={`~${r.hoursSaved.estimate.toFixed(1)} h`} sub={`${r.hoursSaved.prs} PRs estimated, ${r.hoursSaved.withoutStats} without size data`} />
      </div>
      {(r.counts.unsure > 0 || r.unreadable > 0) && (
        <div className="text-[12px] text-ink-3" data-testid="value-unreadable">
          {r.unreadable} unreadable event{r.unreadable === 1 ? '' : 's'} skipped
          {r.counts.unsure > 0 ? `; ${r.counts.unsure} PR${r.counts.unsure === 1 ? '' : 's'} left unsure by one, counted in neither number` : ''}.
        </div>
      )}
      <Card className="p-3 text-[12px] text-ink-3" data-testid="value-formula">
        <div className="font-medium text-ink">How the hours are estimated</div>
        <div className="mt-1 font-mono">{r.hoursSaved.formula}</div>
        <div className="mt-1 tabular-nums">
          base_min = {c.base_min}, per_100_lines_min = {c.per_100_lines_min}, cap_min = {c.cap_min}
        </div>
        <div className="mt-1" data-testid="value-constants-from">
          {r.hoursSaved.constantsFrom === 'policy'
            ? "Set by the instance's owner in policy.yaml (value_report.hours_estimate)."
            : "The engine's defaults, guesses until calibrated; an owner sets them in policy.yaml (value_report.hours_estimate)."}
        </div>
        <div className="mt-1">{r.hoursSaved.label}</div>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-3 text-[13px]" data-testid="value-kinds">
          <div className="font-medium text-ink">Why PRs were held</div>
          {r.heldByKind.length ? (
            <ul className="mt-1 space-y-0.5">
              {r.heldByKind.map((k) => (
                <li key={k.kind} className="flex justify-between">
                  <span>{KIND_LABEL[k.kind]}</span>
                  <span className="tabular-nums">{k.prs}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 text-ink-3">Nothing held.</div>
          )}
          <div className="mt-2 text-[12px] text-ink-3">A PR counts once in each kind it has.</div>
        </Card>
        <Card className="p-3 text-[13px]" data-testid="value-outcomes">
          <div className="font-medium text-ink">What became of the held PRs</div>
          <ul className="mt-1 space-y-0.5">
            {(Object.keys(OUTCOME_LABEL) as HeldOutcome[]).map((o) => (
              <li key={o} className="flex justify-between">
                <span>{OUTCOME_LABEL[o]}</span>
                <span className="tabular-nums">{r.heldOutcomes[o]}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[12px] text-ink-3">
            Median wait from the first hold: {hours(r.heldWait.medianMs)} ({r.heldWait.resolved} resolved)
          </div>
        </Card>
      </div>
      <Card className="p-3 text-[13px]" data-testid="value-would-have-merged">
        <div className="font-medium text-ink">Held only by the kill switch: {r.wouldHaveMerged.count}</div>
        {r.wouldHaveMerged.prs.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {r.wouldHaveMerged.prs.map((p) => (
              <li key={p.number}>
                #{p.number}: {OUTCOME_LABEL[p.outcome]}; main: {MAIN_LABEL[p.main]}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="overflow-x-auto p-3 text-[13px]" data-testid="value-post-merge">
        <div className="font-medium text-ink">After the merge</div>
        <table className="mt-1 w-full text-left">
          <thead className="text-[12px] text-ink-3">
            <tr>
              <th className="pr-3 font-medium">Merged</th>
              <th className="pr-3 font-medium">PRs</th>
              <th className="pr-3 font-medium">Main red</th>
              <th className="pr-3 font-medium">Reverted</th>
              <th className="font-medium">Fix-forward</th>
            </tr>
          </thead>
          <tbody>
            <PostRow name="by the engine on its own" p={r.postMerge.auto} />
            <PostRow name="by or on a person's call" p={r.postMerge.person} />
          </tbody>
        </table>
        <div className="mt-2 text-[12px] text-ink-3">
          Agent spend on auto-merged PRs: ${r.spend.usd.toFixed(2)}
          {r.spend.perAutoPr !== null ? ` (~$${r.spend.perAutoPr.toFixed(2)} each)` : ''}, the agent CLI's own estimates.        </div>
      </Card>
    </section>
  );
}

export function ValuePage({ state, pulse }: { state: State; pulse: number }) {
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const refused = valueRefusal(state);
  // Refused up front: not asked for at all.
  const { data, error } = useView<ValueReport>(refused ? null : `/api/value?days=${days}`, pulse);
  return (
    <div data-testid="page-value">
      <Header title="Value" sub="what the engine merged on its own, what it held and why" />
      <div className="px-6 pt-6">
        {refused ? (
          <div className="text-[13px] text-ink-3" data-testid="value-refused">
            {refused.replace(/^the/, 'The')}.
          </div>
        ) : (
          <>
            <div className="mb-4 flex gap-2 text-[12px]" role="group" aria-label="Window">
              {DAYS.map((d) => (
                <Button key={d} type="button" size="sm" variant={d === days ? 'default' : 'outline'} aria-pressed={d === days} onClick={() => setDays(d)}>
                  {d} days
                </Button>
              ))}
            </div>
            {data ? <ValueReportView r={data} /> : <div className="text-[13px] text-ink-3">{error ? `Can't load the value report: ${error}` : 'Loading…'}</div>}
          </>
        )}
      </div>
    </div>
  );
}

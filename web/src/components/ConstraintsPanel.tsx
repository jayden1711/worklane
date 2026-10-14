// Repeated feedback (GET /api/constraints, src/checks-from-feedback.ts): the constraints people's "no"s cluster into,
// each with how often it came up, links to where, and what became of it (a draft check PR, an issue for a protected
// area, or why not yet). Read-only: proposals are made by the coordinator, never from here.
import { useEffect, useState } from 'react';
import { api, type ConstraintItem, type Constraints, type State } from '../api';
import { Badge, Card } from './ui';

const STATUS: Record<ConstraintItem['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  proposed_pr: { label: 'Check proposed', tone: 'ok' },
  proposed_issue: { label: 'Issue (protected)', tone: 'warn' },
  due: { label: 'Due', tone: 'info' },
  held: { label: 'Held', tone: 'neutral' },
  dropped: { label: 'No check', tone: 'neutral' },
  watching: { label: 'Seen once', tone: 'neutral' },
};

const link = (url: string | null, text: string) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer" className="text-blue-ink underline-offset-2 hover:underline">
      {text}
    </a>
  ) : (
    <span>{text}</span>
  );

function Row({ c }: { c: ConstraintItem }) {
  const s = STATUS[c.status];
  return (
    <li className="space-y-1.5 px-3 py-2.5" data-testid="constraint" data-status={c.status} data-count={c.count}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-words text-[13px] text-ink">{c.label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="text-[12px] tabular-nums text-ink-2" data-testid="constraint-count">
            {c.count}×
          </span>
          <Badge tone={s.tone}>{s.label}</Badge>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] text-ink-3" data-testid="constraint-links">
        {c.sightings.map((x) => (
          <span key={x.key} title={x.words}>
            {link(x.url, x.ref)} by @{x.by}
          </span>
        ))}
        {c.reverts.map((r, i) => (
          <span key={`r${i}`} title={r.words}>
            {link(r.url, 'revert')}
          </span>
        ))}
      </div>
      {(c.proposal || c.detail) && (
        <div className="text-[12px] text-ink-2" data-testid="constraint-detail">
          {c.proposal && <>{link(c.proposal.url, `${c.proposal.kind === 'pr' ? 'PR' : 'Issue'} #${c.proposal.number}`)}. </>}
          {c.detail}
        </div>
      )}
    </li>
  );
}

/** The panel from its data (also what the render checks render). */
export function ConstraintsView({ c }: { c: Constraints }) {
  return (
    <section className="space-y-3" aria-label="Repeated feedback" data-testid="constraints-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Repeated feedback</span>
        <span className="text-[12px] text-ink-3">
          what people keep saying no to; at {c.minSightings} sightings it becomes a proposed check ({c.usedThisWeek} of {c.maxPerWeek} this week){c.enabled ? '' : '; off for this instance'}
        </span>
      </div>
      <Card className="overflow-hidden">
        {c.constraints.length ? (
          <ul className="divide-y divide-line">
            {c.constraints.map((x) => (
              <Row key={x.id} c={x} />
            ))}
          </ul>
        ) : (
          <div className="p-3 text-[12.5px] text-ink-3" data-testid="constraints-empty">
            No feedback recorded yet.
          </div>
        )}
      </Card>
    </section>
  );
}

/** Loaded for the owner and the writers only, like throughput (anyone else's page says so without asking). */
export function ConstraintsPanel({ state }: { state: State }) {
  const refused = state.canReadThroughput === false ? `repeated feedback is for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;
  const [c, setC] = useState<Constraints | { error: string } | null>(null);
  useEffect(() => {
    if (refused) return;
    api<Constraints>('/api/constraints')
      .then(setC)
      .catch((e: Error) => setC({ error: e.message }));
  }, [refused, state.lastId]);
  if (refused) {
    return (
      <div className="text-[13px] text-ink-3" data-testid="constraints-refused">
        {refused.replace(/^repeated/, 'Repeated')}.
      </div>
    );
  }
  if (!c) return null;
  if ('error' in c) return <div className="text-[13px] text-red">Can't load repeated feedback: {c.error}</div>;
  return <ConstraintsView c={c} />;
}

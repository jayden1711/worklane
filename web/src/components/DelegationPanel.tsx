// Gradual delegation (GET /api/delegation, src/delegation.ts): each review category's record since the owner's last
// answer on it, who approved its PRs and how fast, every approver's history across categories, and the suggestions
// with their answers. Read-only: a suggestion is answered in the Inbox and only files a review.yaml PR the owner
// reviews; nothing here loosens anything.
import { useEffect, useState } from 'react';
import { navigate } from '../App';
import { api, type Delegation, type DelegationApprover, type DelegationCategory, type State } from '../api';
import { ago, Badge, Card } from './ui';

/** A wait in plain words, to the nearest minute (as src/delegation.ts waitText). */
const waitText = (ms: number) => {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
};

const who = (a: Pick<DelegationApprover, 'by' | 'role'>) => `@${a.by}${a.role ? ` (${a.role})` : ''}`;

function status(c: DelegationCategory): { label: string; tone: 'neutral' | 'ok' | 'warn' | 'info' } {
  if (c.protected) return { label: 'Never suggested', tone: 'neutral' };
  if (c.loosened) return { label: 'Loosened', tone: 'info' };
  if (c.waits) return { label: 'Waits for you', tone: 'warn' };
  return { label: 'Not waiting', tone: 'ok' };
}

function CategoryRow({ c }: { c: DelegationCategory }) {
  const s = status(c);
  const bad = c.reverted + c.mainRed + c.laterFix;
  return (
    <li className="space-y-1 px-3 py-2 text-[12.5px]" data-testid="delegation-category" data-category={c.category}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-ink">{c.category}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <div className="text-ink-2" data-testid="delegation-record">
        {c.prs.length} PRs since the last answer: {c.clean} approved unchanged, {c.changed} changed{bad ? `, ${bad} went wrong after (${c.reverted} reverted, ${c.mainRed} main red, ${c.laterFix} later fix)` : ''}
      </div>
      {(c.wait || c.approvers.length > 0) && (
        <div className="text-ink-3" data-testid="delegation-approvals">
          {c.wait && `${c.held} waited for a person; time to approve: median ${waitText(c.wait.medianMs)} (fastest ${waitText(c.wait.fastestMs)}, slowest ${waitText(c.wait.slowestMs)})`}
          {c.wait && c.approvers.length > 0 && ' · '}
          {c.approvers.length > 0 && `approved by ${c.approvers.map((a) => `${who(a)} ${a.unchanged} of ${a.approvals} unchanged`).join(', ')}`}
        </div>
      )}
    </li>
  );
}

/** The panel from its data (also what the render checks render). */
export function DelegationView({ d }: { d: Delegation }) {
  return (
    <section className="mt-6 space-y-2" aria-label="Delegation" data-testid="delegation-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Delegation</span>
        <Badge tone={d.enabled ? 'info' : 'neutral'}>
          <span data-testid="delegation-state">{d.enabled ? 'suggest-only' : 'off'}</span>
        </Badge>
      </div>
      <p className="text-[12px] text-ink-3">
        Each review category's record since your last answer on it, and who approved its PRs and how fast.
        {d.enabled && d.minClean !== null ? ` A category that waits for you is put to you in the Inbox after ${d.minClean} PRs in a row approved unchanged with nothing gone wrong after.` : ' Suggestions are off for this instance (delegation in review.yaml).'} Nothing is loosened without your answer, and high-risk, safety-floor and agent-instructions categories are never suggested.
      </p>
      {d.categories.length ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {d.categories.map((c) => (
              <CategoryRow key={c.category} c={c} />
            ))}
          </ul>
        </Card>
      ) : (
        <div className="text-[12.5px] text-ink-3" data-testid="delegation-empty">
          No category waits for you, and no merged PR has been recorded yet.
        </div>
      )}
      {d.approvers.length > 0 && (
        <Card className="divide-y divide-line" aria-label="Who approved">
          {d.approvers.map((a) => (
            <div key={a.by} className="px-3 py-2 text-[12.5px] text-ink-2" data-testid="delegation-approver" data-by={a.by}>
              <span className="text-ink">{who(a)}</span>: {a.approvals} approved, {a.unchanged} unchanged{a.bad ? `, ${a.bad} went wrong after` : ''}
              {a.medianWaitMs !== null && ` · median ${waitText(a.medianWaitMs)} to approve`} · {a.categories.join(', ')}
            </div>
          ))}
        </Card>
      )}
      {d.suggestions.length > 0 && (
        <Card className="divide-y divide-line" aria-label="Suggestions">
          {d.suggestions.map((s) => (
            <div key={s.decision} className="px-3 py-2 text-[12.5px] text-ink-2" data-testid="delegation-suggestion" data-answer={s.answer ?? ''}>
              <span className="text-ink">
                {s.direction === 'loosen' ? 'Stop waiting' : 'Wait again'} on <span className="font-mono">{s.category}</span>
              </span>{' '}
              · asked {ago(s.at)} ·{' '}
              {s.answer ? (
                `${s.answer} by @${s.by}${s.issue ? `, filed #${s.issue}` : ''}`
              ) : (
                <a className="text-blue-ink underline-offset-2 hover:underline" href={`/decisions/${encodeURIComponent(s.decision)}`} onClick={(e) => (e.preventDefault(), navigate(`/decisions/${encodeURIComponent(s.decision)}`))}>
                  waiting for your answer
                </a>
              )}
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

/** Loaded for the owner and the writers only, like the learnings (anyone else's page leaves it out). */
export function DelegationPanel({ state }: { state: State }) {
  const [d, setD] = useState<Delegation | { error: string } | null>(null);
  useEffect(() => {
    if (state.canWrite === false) return;
    api<Delegation>('/api/delegation')
      .then(setD)
      .catch((e: Error) => setD({ error: e.message }));
  }, [state.lastId, state.canWrite]);
  if (state.canWrite === false || !d) return null;
  if ('error' in d) return <div className="mt-6 text-[13px] text-red">Can't load the delegation summary: {d.error}</div>;
  return <DelegationView d={d} />;
}

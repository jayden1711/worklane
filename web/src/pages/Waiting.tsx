// Waiting on you: every state that holds work until the owner acts (a decision, a held plan, a PR left to
// them, a CI fix that gave up, a block, a failed landing or deploy, a check that holds a PR back, a hotspot
// hold, a stopped auto-merge, an emergency stop), how long each has waited, and its issue or PR. Nothing
// here times out. The same list is the daily digest posted on GitHub; its Markdown is shown below.
import { useEffect, useState } from 'react';
import { api, type MergedItem, type State, type WaitItem, type WaitKind, type Waiting } from '../api';
import { navigate } from '../App';
import { Badge, Card, Empty } from '../components/ui';
import { Header } from './Overview';

/** The kinds in the digest's order, with its headings (src/digest.ts). */
export const KINDS: [WaitKind, string][] = [
  ['emergency_halt', 'Emergency stop in force'],
  ['merge_stopped', 'Auto-merge stopped'],
  ['awaiting_decision', 'Decisions waiting for you'],
  ['plan_held', 'Plans held for you'],
  ['needs_owner', 'PRs waiting for you to review and merge'],
  ['ci_fix_gave_up', 'CI fixes that gave up'],
  ['blocked', 'Blocked'],
  ['landing_failed', 'Landing failed'],
  ['deploy_failed', 'Deploys that failed'],
  ['check_held', 'PRs held back by a required check'],
  ['hotspot_held', 'Tasks held behind another on the same files'],
];

/** How long, in words (the digest's own wording). */
export function waited(since: string, now = Date.now()): string {
  const m = Math.max(0, (now - Date.parse(since)) / 60_000);
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

/** For a viewer the state says may not read it, the refusal the server would give; null for the owner and writers. */
export const waitingRefusal = (state: Pick<State, 'canReadDigest' | 'owners' | 'user'>) =>
  state.canReadDigest === false ? `what waits on the owner is for the owner (@${state.owners.default}) and the project's writers; @${state.user || 'unknown'} isn't one` : null;

function Subject({ i }: { i: WaitItem }) {
  const issue = i.issue !== null && (
    <button onClick={() => navigate(`/issues/${i.issue}`)} className="font-mono text-[12.5px] text-blue-ink hover:underline" data-testid="waiting-issue">
      #{i.issue}
    </button>
  );
  if (i.pr !== null) {
    return (
      <span className="flex flex-wrap items-baseline gap-1.5">
        <button onClick={() => navigate('/prs')} className="font-mono text-[12.5px] text-blue-ink hover:underline" data-testid="waiting-pr">
          PR #{i.pr}
        </button>
        {issue && <span className="text-[12px] text-ink-3">for</span>}
        {issue}
        {i.title && <span className="text-[13px] text-ink">{i.title}</span>}
      </span>
    );
  }
  if (issue) {
    return (
      <span className="flex flex-wrap items-baseline gap-1.5">
        {issue}
        {i.title && <span className="text-[13px] text-ink">{i.title}</span>}
      </span>
    );
  }
  return i.sha ? <span className="font-mono text-[12px] text-ink-2">{i.sha.slice(0, 12)}</span> : null;
}

/** The list from its data (also what the render checks render). */
export function WaitingView({ w, now }: { w: Waiting; now?: number }) {
  return (
    <div className="space-y-6">
      <WaitList w={w} {...(now !== undefined ? { now } : {})} />
      <MergedSince merged={w.merged} since={w.mergedSince} />
    </div>
  );
}

const CONFIDENCE_TONE: Record<string, 'ok' | 'warn' | 'danger'> = { high: 'ok', medium: 'warn', low: 'danger' };

/** The PRs merged on their own since the last digest, for the owner to sample: each with its review level and the evaluator's confidence. */
export function MergedSince({ merged, since }: { merged: MergedItem[]; since: string }) {
  return (
    <section aria-label="Merged since yesterday" data-testid="merged-since">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Merged since yesterday</span>
        <span className="text-[12px] tabular-nums text-ink-3">{merged.length}</span>
        <span className="text-[12px] text-ink-3">merged on their own since {since.slice(0, 16).replace('T', ' ')} UTC, to sample</span>
      </div>
      {merged.length ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {merged.map((m) => (
              <li key={m.pr} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5" data-testid="merged-item">
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[12.5px] text-blue-ink hover:underline" data-testid="merged-pr">
                  PR #{m.pr}
                </a>
                <span className="text-[12px] text-ink-3">for</span>
                <button onClick={() => navigate(`/issues/${m.issue}`)} className="font-mono text-[12.5px] text-blue-ink hover:underline">
                  #{m.issue}
                </button>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{m.title}</span>
                <span data-testid="merged-level">
                  <Badge>{m.level ?? 'level not recorded'}</Badge>
                </span>
                <span data-testid="merged-confidence">
                  <Badge tone={m.confidence ? CONFIDENCE_TONE[m.confidence] ?? 'neutral' : 'neutral'}>{m.confidence ? `evaluator confidence ${m.confidence}` : 'confidence not recorded'}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <div className="text-[12.5px] text-ink-3">Nothing merged on its own.</div>
      )}
    </section>
  );
}

function WaitList({ w, now }: { w: Waiting; now?: number }) {
  if (!w.items.length) return <Empty title="Nothing is waiting on you" hint="Decisions, held plans and PRs, blocks and stops show up here until you act on them; nothing times out." />;
  return (
    <div className="space-y-4">
      {KINDS.map(([kind, label]) => {
        const these = w.items.filter((i) => i.kind === kind);
        if (!these.length) return null;
        return (
          <section key={kind} aria-label={label} data-testid="waiting-group" data-kind={kind}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-ink">{label}</span>
              <span className="text-[12px] tabular-nums text-ink-3">{these.length}</span>
            </div>
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {these.map((i, n) => (
                  <li key={n} className="flex flex-wrap items-start gap-x-3 gap-y-0.5 px-4 py-2.5" data-testid="waiting-item">
                    <div className="min-w-0 flex-1">
                      <Subject i={i} />
                      <div className="mt-0.5 text-[12.5px] text-ink-2" data-testid="waiting-detail">
                        {i.detail}
                      </div>
                    </div>
                    <span className="text-[12px] tabular-nums text-ink-3" title={i.since} data-testid="waiting-since">
                      waiting {waited(i.since, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

export function WaitingPage({ state }: { state: State }) {
  const refused = waitingRefusal(state);
  const [w, setW] = useState<Waiting | { error: string } | null>(null);
  // Refused up front (the state says so): not asked for at all. Otherwise again whenever the log changes.
  useEffect(() => {
    if (refused) return;
    api<Waiting>('/api/waiting')
      .then(setW)
      .catch((e: Error) => setW({ error: e.message }));
  }, [refused, state.lastId]);
  return (
    <div data-testid="page-waiting">
      <Header title="Waiting on you" sub={w && 'items' in w ? `${w.items.length} waiting; nothing here times out` : 'everything that waits until you act'} />
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {refused ? (
          <div className="text-[13px] text-ink-3" data-testid="waiting-refused">
            {refused.replace(/^what/, 'What')}.
          </div>
        ) : !w ? null : 'error' in w ? (
          <div className="text-[13px] text-red">Can't load what waits: {w.error}</div>
        ) : (
          <>
            <WaitingView w={w} />
            <details className="rounded-card bg-surface shadow-card" data-testid="waiting-digest">
              <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-ink">The daily digest, as posted on GitHub</summary>
              <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap border-t border-line p-4 font-mono text-[12px] leading-5 text-ink-2">{w.markdown}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

// WHY: item 33 (GET /api/learnings, src/learnings.ts). Read-only for writers; an owner's Promote only asks the
// coordinator to file an AGENTS.md PR, which waits for the owner (L3) like any change to the agents' instructions.
import { useEffect, useState } from 'react';
import { api, promoteLearning, type LearningGroup, type Learnings, type State } from '../api';
import { ago, Badge, Button, Card } from './ui';

function Promote({ g, onDone }: { g: LearningGroup; onDone: () => void }) {
  const [line, setLine] = useState(g.line);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await promoteLearning(g.fingerprint, line);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input value={line} onChange={(e) => setLine(e.target.value)} aria-label="The line to add to AGENTS.md" className="h-7 min-w-0 flex-1 basis-64 rounded-control bg-field px-2 font-mono text-[12px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)]" data-testid="learning-line" />
      <Button size="sm" variant="outline" disabled={busy || !line.trim()} onClick={() => void go()} data-testid="learning-promote">
        Promote to AGENTS.md
      </Button>
      {error && <div className="basis-full text-[12px] text-red">{error}</div>}
    </div>
  );
}

function Promotion({ p }: { p: NonNullable<LearningGroup['promotion']> }) {
  if (p.state === 'requested') return <div className="mt-1 text-[12px] text-ink-3">Promoted by @{p.by}; the PR is being filed.</div>;
  if (p.state === 'failed') return <div className="mt-1 text-[12px] text-red">Promote by @{p.by} filed nothing: {p.detail}</div>;
  return (
    <div className="mt-1 text-[12px] text-ink-3">
      Promoted by @{p.by}:{' '}
      <a className="underline-offset-2 hover:underline" href={p.pr ?? undefined} target="_blank" rel="noreferrer">
        the AGENTS.md PR
      </a>{' '}
      (L3, waits for the owner){p.detail ? `; ${p.detail}` : ''}
    </div>
  );
}

export function LearningsView({ l, onChanged = () => undefined }: { l: Learnings; onChanged?: () => void }) {
  return (
    <section className="mt-6 space-y-2" aria-label="Learnings" data-testid="learnings-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Learnings</span>
        <Badge tone={l.groups.some((g) => g.ready && !g.promotion) ? 'warn' : 'neutral'}>
          <span data-testid="learnings-count">{l.groups.length}</span> causes
        </Badge>
      </div>
      <p className="text-[12px] text-ink-3">
        When a task ends, each failed run leaves a note: its earliest failed stage and its cause. Notes with the same cause are grouped. A cause seen {l.minSightings} times or more can be promoted by an owner, which opens a PR adding one line to AGENTS.md; agents never write AGENTS.md themselves.
      </p>
      {l.groups.length ? (
        <Card className="divide-y divide-line">
          {l.groups.map((g) => (
            <div key={g.fingerprint} className="px-3 py-2 text-[12.5px]" data-testid="learning-row" data-fingerprint={g.fingerprint}>
              <div className="flex flex-wrap items-baseline gap-2">
                <Badge tone={g.ready ? 'warn' : 'neutral'}>
                  <span data-testid="learning-sightings">{g.count}</span>× {g.outcome}
                </Badge>
                <span className="min-w-0 break-words font-mono text-ink" data-testid="learning-cause">
                  {g.cause}
                </span>
              </div>
              <div className="mt-1 text-ink-3" data-testid="learning-stages">
                {g.stages.map((s) => `${s.stage} ${s.count}`).join(' · ')} · issues {g.issues.map((n) => `#${n}`).join(', ')} · last {ago(g.last)}
                {!g.ready && ` · promotable from ${l.minSightings}`}
              </div>
              {g.promotion && <Promotion p={g.promotion} />}
              {g.ready && l.canPromote && (!g.promotion || g.promotion.state === 'failed') && <Promote g={g} onDone={onChanged} />}
            </div>
          ))}
        </Card>
      ) : (
        <div className="text-[12.5px] text-ink-3">No failed runs noted yet.</div>
      )}
    </section>
  );
}

export function LearningsPanel({ state }: { state: State }) {
  const [l, setL] = useState<Learnings | { error: string } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (state.canWrite === false) return;
    api<Learnings>('/api/learnings')
      .then(setL)
      .catch((e: Error) => setL({ error: e.message }));
  }, [state.lastId, state.canWrite, n]);
  if (state.canWrite === false || !l) return null;
  if ('error' in l) return <div className="mt-6 text-[13px] text-red">Can't load the learnings: {l.error}</div>;
  return <LearningsView l={l} onChanged={() => setN((x) => x + 1)} />;
}

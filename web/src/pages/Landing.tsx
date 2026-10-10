import type { State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Card, Empty, LevelBadge, StatusBadge } from '../components/ui';
import { Header } from './Overview';

const BATCH_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'info' | 'neutral'> = { landed: 'ok', red: 'danger', split: 'warn', deferred: 'warn', started: 'info' };
const REVIEW = new Set(['verifying', 'evaluating', 'awaiting_decision']);

function IssueLink({ n }: { n: number }) {
  return (
    <button className="font-mono text-xs text-blue-ink hover:underline" onClick={() => navigate(`/issues/${n}`)}>
      #{n}
    </button>
  );
}

export function Landing({ state }: { state: State }) {
  const review = state.tasks.filter((t) => REVIEW.has(t.status));
  return (
    <div data-testid="page-land">
      <Header title="Land queue" sub={`land mode ${state.project.landMode} · changes land in tested batches`} />
      <div className="space-y-6 p-6">
        <Card className="overflow-hidden">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Queued to land ({state.landQueue.length})</div>
          {state.landQueue.length ? (
            <ul className="divide-y divide-line">
              {state.landQueue.map((q, i) => (
                <li key={q.issue} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="w-5 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <IssueLink n={q.issue} />
                  <span className="min-w-0 flex-1 truncate">{q.title}</span>
                  {q.deferred && (
                    <Badge tone="warn" className="max-w-[40%] truncate">
                      deferred: {q.deferred}
                    </Badge>
                  )}
                  <LevelBadge level={q.level} />
                  <span className="w-20 text-right font-mono text-xs text-muted-foreground">{q.head.slice(0, 8)}</span>
                  <span className="w-16 text-right text-xs text-muted-foreground">{ago(q.queuedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <Empty title="Nothing waiting to land" hint="Changes join this queue once checks and the evaluator pass and their review level allows it." />
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">In review ({review.length})</div>
          {review.length ? (
            <ul className="divide-y divide-line">
              {review.map((t) => (
                <li key={t.issue} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <IssueLink n={t.issue} />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <StatusBadge status={t.status} />
                  <LevelBadge level={t.level} />
                  <span className="w-16 text-right text-xs text-muted-foreground">{ago(t.lastActivity)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">Nothing in review.</div>
          )}
        </Card>

        <div className="grid gap-6">
          <Card className="overflow-hidden">
            <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Recent batches</div>
            {state.batches.length ? (
              <ul className="divide-y divide-line">
                {state.batches.map((b) => (
                  <li key={b.id} className="space-y-1 px-4 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge tone={BATCH_TONE[b.outcome] ?? 'neutral'}>{b.outcome}</Badge>
                      <span className="flex flex-wrap gap-1.5">
                        {b.issues.map((n) => (
                          <IssueLink key={n} n={n} />
                        ))}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">{ago(b.at)}</span>
                    </div>
                    {b.detail && <div className="truncate text-xs text-muted-foreground" title={b.detail}>{b.detail}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">No batches yet.</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

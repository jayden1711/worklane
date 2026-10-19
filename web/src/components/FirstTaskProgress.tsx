// WHY (#741): after "File one" the page said one line and then nothing until a PR showed up elsewhere. This card
// follows that issue through the stages the engine records (src/first-task-progress.ts): claimed, the worker, the
// evaluator, the PR, its checks, then merged or held, with why in plain words. It shows what the events say and
// nothing more: a stage with no event is waiting, and every estimate says where its number comes from. Read-only: no
// control here changes a setting or merges anything.
import type { FirstTaskProgress } from '../api';
import { ago, Badge, Card, cx } from './ui';

type Stage = FirstTaskProgress['stages'][number];

const STATE_TONE: Record<Stage['state'], 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = { waiting: 'neutral', running: 'info', done: 'ok', failed: 'danger', held: 'warn' };
const STATE_WORD: Record<Stage['state'], string> = { waiting: 'waiting', running: 'in progress', done: 'done', failed: 'failed', held: 'held' };
/** How an estimate is labelled: never as measured. */
const BASIS_WORD: Record<NonNullable<Stage['estimate']>['basis'], string> = { tick: 'Estimate', guess: 'Guess', none: 'Estimate' };

export function FirstTaskCard({ t }: { t: FirstTaskProgress }) {
  return (
    <Card className="space-y-3 p-4" data-testid="first-task-card" data-issue={t.issue} data-outcome={t.outcome}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <div className="text-[13px] font-medium text-ink">First task</div>
        <span className="font-mono text-[12px] text-ink-3">#{t.issue}</span>
        {t.title && <span className="min-w-0 break-words text-[12.5px] text-ink-2">{t.title}</span>}
        <span className="text-[11.5px] text-ink-3">filed {ago(t.filedAt)}</span>
      </div>
      {t.blocked && (
        <p className="break-words text-[12.5px] text-orange" data-testid="first-task-blocked">
          Blocked: {t.blocked.why}. It waits for you on the Board.
        </p>
      )}
      {t.question && (
        <p className="text-[12.5px] text-orange" data-testid="first-task-question">
          A question about it waits for your answer on Decisions.
        </p>
      )}
      <ol className="space-y-2" data-testid="first-task-stages">
        {t.stages.map((s) => (
          <li key={s.id} className="flex gap-3" data-testid="first-task-stage" data-stage={s.id} data-state={s.state}>
            <span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', s.state === 'done' ? 'bg-green' : s.state === 'failed' ? 'bg-red' : s.state === 'held' ? 'bg-orange' : s.state === 'running' ? 'bg-blue' : 'bg-inset shadow-hairline')} aria-hidden />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12.5px] font-medium text-ink">{s.title}</span>
                <Badge tone={STATE_TONE[s.state]}>{STATE_WORD[s.state]}</Badge>
                {s.at && <span className="text-[11.5px] text-ink-3">{ago(s.at)}</span>}
              </div>
              <p className="break-words text-[12.5px] text-ink-2" data-testid="first-task-stage-detail">
                {s.id === 'pr' && t.pr?.url ? (
                  <a href={t.pr.url} target="_blank" rel="noreferrer" className="text-blue-ink hover:underline" data-testid="first-task-pr-link">
                    {s.detail}
                  </a>
                ) : (
                  s.detail
                )}
              </p>
              {s.estimate && (
                <p className="text-[11.5px] text-ink-3" data-testid="first-task-estimate" data-basis={s.estimate.basis}>
                  {BASIS_WORD[s.estimate.basis]}: {s.estimate.text}
                </p>
              )}
              {s.state === 'held' && !!t.holds.length && (
                <ul className="mt-1 space-y-1.5" data-testid="first-task-holds">
                  {t.holds.map((h) => (
                    <li key={`${h.kind} ${h.why}`} className="space-y-0.5 rounded-lg bg-inset px-3 py-2" data-testid="first-task-hold" data-kind={h.kind}>
                      <p className="break-words text-[12.5px] text-ink">{h.why}</p>
                      <p className="break-words text-[12px] text-ink-2">What lets it through: {h.through}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

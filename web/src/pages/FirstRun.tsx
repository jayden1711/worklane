// The first-run page: `init`'s checklist as it recorded it (GET /api/first-run, src/init.ts), with its
// progress, where it stopped and how to pick up, and what this mode can't do (each with why). The same checklist
// `doctor` shows. Read-only: the steps run in the terminal (logins and installs need it), not from here.
import { useEffect, useState } from 'react';
import { getFirstRun, type FirstRun, type FirstRunStatus, type State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Card, cx } from '../components/ui';
import { Header } from './Overview';

const STATUS_LABEL: Record<FirstRunStatus, string> = { pending: 'not yet', done: 'done', skipped: 'skipped', failed: 'stopped here' };
const STATUS_TONE: Record<FirstRunStatus, 'neutral' | 'ok' | 'warn' | 'danger'> = { pending: 'neutral', done: 'ok', skipped: 'neutral', failed: 'danger' };
const MARK: Record<FirstRunStatus, string> = { pending: 'bg-inset text-ink-3 shadow-hairline', done: 'bg-green-tint text-green', skipped: 'bg-inset text-ink-3 shadow-hairline', failed: 'bg-red-tint text-red' };

const MODE_LINE = {
  local: 'Local mode: on this machine, as you. No server, no ssh, no root.',
  server: 'Server mode: the hardened multi-user Linux setup, each project as users of its own.',
};

/** The checklist from its data (also what the render checks render). */
export function FirstRunView({ f }: { f: FirstRun }) {
  const pct = f.total ? Math.round((f.done / f.total) * 100) : 0;
  const stopped = f.steps.find((s) => s.status === 'failed' && !s.optional);
  return (
    <div className="space-y-5">
      {!f.recorded && (
        <Card className="space-y-2 p-4" data-testid="first-run-none">
          <div className="text-[13px] font-medium text-ink">Setup hasn't been walked here yet</div>
          <p className="text-[12.5px] text-ink-2">Run this in a terminal on this machine. It checks each step, does what isn't done (asking before it installs anything), and this page follows along.</p>
          <code className="block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline">{f.command}</code>
        </Card>
      )}
      {f.mode && (
        <p className="text-[12.5px] text-ink-2" data-testid="first-run-mode" data-mode={f.mode}>
          {MODE_LINE[f.mode]}
        </p>
      )}
      <section aria-label="Progress" className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
          <span className="font-medium text-ink">
            {f.done} of {f.total} steps done
          </span>
          {f.updatedAt && <span className="text-ink-3">updated {ago(f.updatedAt)}</span>}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-inset shadow-hairline" role="progressbar" aria-valuemin={0} aria-valuemax={f.total} aria-valuenow={f.done} aria-label="Setup progress" data-testid="first-run-progress">
          <div className={cx('h-full rounded-full transition-[width] duration-300', f.finishedAt ? 'bg-green' : 'bg-blue')} style={{ width: `${pct}%` }} />
        </div>
      </section>
      <Card className="overflow-hidden">
        <ol className="divide-y divide-line" data-testid="first-run-steps">
          {f.steps.map((s, i) => (
            <li key={s.id} className="flex gap-3 px-4 py-3" data-testid="first-run-step" data-step={s.id} data-status={s.status}>
              <span className={cx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold tabular-nums', MARK[s.status])} aria-hidden>
                {s.status === 'done' ? '✓' : i + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cx('text-[13px] font-medium', s.status === 'pending' ? 'text-ink-3' : 'text-ink')}>{s.title}</span>
                  {s.optional && <span className="text-[11.5px] text-ink-3">optional</span>}
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                </div>
                {s.status !== 'pending' && <p className="break-words text-[12.5px] text-ink-2">{s.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Card>
      {stopped && (
        <Card className="space-y-2 p-4" data-testid="first-run-resume">
          <div className="text-[13px] font-medium text-red">Stopped at {stopped.title}</div>
          <p className="text-[12.5px] text-ink-2">Fix what it says above, then run the same command again: the steps already done are checked, not redone, and it picks up here.</p>
          <code className="block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline">{f.command}</code>
        </Card>
      )}
      {f.finishedAt && (
        <p className="text-[12.5px] text-green" data-testid="first-run-finished">
          Every required step is done ({ago(f.finishedAt)}).
        </p>
      )}
      {f.mode === 'server' && (
        <p className="text-[12.5px] text-ink-3">
          Each project's own steps on a server (its instance, GitHub App, Claude token and checkout) show on the{' '}
          <button onClick={() => navigate('/setup')} className="text-blue-ink hover:underline">
            Setup console
          </button>
          's Add project.
        </p>
      )}
      {!!f.unavailable.length && (
        <section aria-label={`Not available in ${f.mode} mode`} data-testid="first-run-unavailable">
          <div className="mb-1.5 text-[13px] font-medium text-ink">Not available in {f.mode} mode</div>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {f.unavailable.map((u) => (
                <li key={u.feature} className="space-y-0.5 px-4 py-2.5" data-testid="first-run-unavailable-item">
                  <div className="text-[13px] text-ink">{u.feature}</div>
                  <p className="text-[12.5px] text-ink-2">{u.why}</p>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}

/** For anyone the state says may not read it (viewers), the refusal; null for owners and writers. */
export const firstRunRefusal = (state: Pick<State, 'canReadDigest' | 'user' | 'role'>) =>
  state.canReadDigest === false ? `the first-run checklist is for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;

export function FirstRunPage({ state }: { state: State }) {
  const refused = firstRunRefusal(state);
  const [f, setF] = useState<FirstRun | { error: string } | null>(null);
  useEffect(() => {
    if (refused) return;
    getFirstRun()
      .then(setF)
      .catch((e: Error) => setF({ error: e.message }));
  }, [refused, state.lastId]);
  return (
    <div data-testid="page-first-run">
      <Header title="First run" sub={f && 'steps' in f ? `${f.done} of ${f.total} steps done` : 'the guided setup, step by step'} />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {refused ? (
          <div className="text-[13px] text-ink-3" data-testid="first-run-refused">
            {refused.replace(/^the/, 'The')}.
          </div>
        ) : !f ? null : 'error' in f ? (
          <div className="text-[13px] text-red">Can't load the checklist: {f.error}</div>
        ) : (
          <FirstRunView f={f} />
        )}
      </div>
    </div>
  );
}

// The first-run page: every setup step (src/setup-steps.ts), checked live from the real state, grouped, each done or
// not done, with a Fix for each that isn't: the screen that does it, or what to do today where there is no screen yet,
// or the provider's own page (a login, a consent) with this page noticing when it's done. It checks again on a short
// poll while open, and on Re-check. Start installs and starts the coordinator's service, after showing what it changes
// and a confirmation (the server records it in the audit). `doctor` shows the same steps with the same states.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getFirstRun, runFirstRunAction, startCoordinator, type FirstRun, type FirstRunActionPlan, type FirstRunAutoConfig, type FirstRunStart, type FirstRunVerification, type SetupStepView, type State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Button, Card, cx } from '../components/ui';
import { Header } from './Overview';

/** How often the page checks again while it is open. The server keeps GitHub's answers for 2 minutes, the rest for 10 s. */
export const POLL_MS = 15_000;

const MODE_LINE = {
  local: 'Local mode: on this machine, as you. No server, no ssh, no root.',
  server: 'Server mode: the hardened multi-user Linux setup, each project as users of its own.',
};

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';

const SLOT_LABEL: Record<FirstRunVerification['slot'], string> = { setup: 'worktree setup', full: 'runner.full', changed: 'runner.changed', one: 'runner.one' };

/** Auto-config's part of the Repo config step: the questions it can't settle alone, with their choices, and each command's run on the default branch. */
function AutoConfigView({ a }: { a: FirstRunAutoConfig }) {
  if (!a.questions.length && !a.verified.length && !a.pr) return null;
  return (
    <section aria-label="Repo config" className="space-y-3" data-testid="first-run-auto-config">
      <div className="text-[13px] font-medium text-ink">Repo config</div>
      {a.pr && (
        <p className="text-[12.5px] text-ink-2" data-testid="first-run-auto-config-pr">
          Proposed as{' '}
          <a href={a.pr.url} className="text-blue-ink hover:underline" target="_blank" rel="noreferrer">
            {a.pr.number ? `PR #${a.pr.number}` : 'a PR'}
          </a>
          : review and merge it, then run init again.
        </p>
      )}
      {!!a.questions.length && (
        <Card className="space-y-3 p-4" data-testid="first-run-questions">
          <p className="text-[12.5px] text-ink-2">Nothing is guessed: answer these in the terminal (init asks them), or give each answer to init.</p>
          <ol className="space-y-3">
            {a.questions.map((q) => (
              <li key={q.id} className="space-y-1.5" data-testid="first-run-question" data-question={q.id}>
                <div className="break-words text-[13px] text-ink">{q.ask}</div>
                <ul className="space-y-1">
                  {q.choices.map((c) => (
                    <li key={c.id} className="flex min-w-0 gap-2 text-[12.5px] text-ink-2" data-testid="first-run-choice" data-choice={c.id}>
                      <code className="shrink-0 rounded bg-inset px-1.5 font-mono text-[11.5px] text-ink shadow-hairline">{c.id}</code>
                      <span className="min-w-0 break-words">{c.label}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <code className="block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline">{a.answer}</code>
        </Card>
      )}
      {!!a.verified.length && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="first-run-verified">
            {a.verified.map((v) => (
              <li key={`${v.slot} ${v.command}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5" data-testid="first-run-verified-item" data-passed={v.passed}>
                <span className="text-[12.5px] text-ink-3">{SLOT_LABEL[v.slot]}</span>
                <code className="min-w-0 break-all font-mono text-[12px] text-ink">{v.command}</code>
                <Badge tone={v.passed ? 'ok' : 'danger'}>{v.passed ? 'passes on main' : `fails on main (exit ${v.code ?? 'none'})`}</Badge>
                <span className="text-[11.5px] text-ink-3">{Math.round(v.ms / 1000)} s</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}


/** WHY: a Fix the dashboard does itself shows its whole plan first, then needs a second click to confirm (owners only). */
function ActionPanel({ plan, canAct, initialConfirming = false, onDone }: { plan: FirstRunActionPlan | undefined; canAct: boolean; initialConfirming?: boolean; onDone: () => void }) {
  const [confirming, setConfirming] = useState(initialConfirming);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!plan) return <p className="text-[12.5px] text-ink-3">Checking what it would do…</p>;
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await runFirstRunAction(plan.id);
      setMsg({ ok: true, text: r.detail });
      setConfirming(false);
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="first-run-action" data-action={plan.id}>
      {!plan.available ? (
        <p className="break-words text-[12.5px] text-ink-2" data-testid="first-run-action-unavailable">
          Not from here: {plan.why}.
        </p>
      ) : (
        <>
          <div className="space-y-1.5 text-[12.5px] text-ink-2" data-testid="first-run-action-plan">
            {!!plan.changes.length && (
              <>
                <p>{plan.label} changes:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {plan.changes.map((c) => (
                    <li key={c} className="break-words">
                      {c}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {!!plan.commands.length && (
              <>
                <p>It runs:</p>
                <code className={code}>{plan.commands.join('\n')}</code>
              </>
            )}
          </div>
          {!canAct ? (
            <p className="text-[12.5px] text-ink-3" data-testid="first-run-action-refused">
              Only the instance's owners can run it.
            </p>
          ) : !confirming ? (
            <Button size="sm" onClick={() => setConfirming(true)} data-testid="first-run-action-button">
              {plan.label}…
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="first-run-action-confirming">
              <span className="text-[12.5px] text-ink">Make the change above?</span>
              <Button size="sm" disabled={busy} onClick={() => void go()} data-testid="first-run-action-confirm">
                {busy ? 'Working…' : 'Confirm'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)} data-testid="first-run-action-cancel">
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="first-run-action-result">
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** What a step's Fix shows when it has no screen to open: today's way, a provider's page, or a terminal command. */
function FixPanel({ s }: { s: SetupStepView }) {
  const f = s.fix;
  if (f.kind === 'outside')
    return (
      <div className="space-y-2" data-testid="first-run-outside">
        <p className="text-[12.5px] text-ink-2">This one happens on {f.label}: {f.why}. This page checks again every {POLL_MS / 1000} s and marks it done when it is.</p>
        {f.url && (
          <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="first-run-outside-link">
            Open {f.label}
          </a>
        )}
        {f.command && <code className={code}>{f.command}</code>}
      </div>
    );
  if (f.kind === 'terminal')
    return (
      <div className="space-y-2" data-testid="first-run-terminal">
        <p className="text-[12.5px] text-ink-2">Only in a terminal: {f.why}.</p>
        <code className={code}>{f.command}</code>
      </div>
    );
  return (
    <div className="space-y-1.5" data-testid="first-run-coming">
      <p className="text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">Today: </span>
        {s.today}
      </p>
      <p className="text-[12px] text-ink-3">A screen for this is coming.</p>
    </div>
  );
}

function StepRow({ s, open, onFix, action }: { s: SetupStepView; open: boolean; onFix: () => void; action?: ReactNode }) {
  const label = s.fix.kind === 'screen' ? 'Open' : s.fix.kind === 'start' ? 'Start' : s.fix.kind === 'action' ? s.fix.label : 'Fix';
  return (
    <li className="px-4 py-3" data-testid="first-run-step" data-step={s.id} data-status={s.done ? 'done' : 'todo'}>
      <div className="flex gap-3">
        <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', s.done ? 'bg-green-tint text-green' : s.optional ? 'bg-inset text-ink-3 shadow-hairline' : 'bg-red-tint text-red')} aria-hidden>
          {s.done ? '✓' : ''}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-ink">{s.title}</span>
            {s.optional && <span className="text-[11.5px] text-ink-3">optional</span>}
            <Badge tone={s.done ? 'ok' : s.optional ? 'neutral' : 'warn'}>{s.done ? 'done' : 'not done'}</Badge>
          </div>
          <p className="break-words text-[12.5px] text-ink-2">{s.detail}</p>
        </div>
        {!s.done && (
          <Button size="sm" variant={open ? 'ghost' : 'outline'} className="shrink-0 self-start" onClick={onFix} aria-expanded={s.fix.kind === 'screen' ? undefined : open} data-testid="first-run-fix" data-fix={s.fix.kind}>
            {label}
          </Button>
        )}
      </div>
      {open && !s.done && s.fix.kind !== 'screen' && s.fix.kind !== 'start' && (
        <div className="mt-2.5 rounded-lg bg-inset p-3 sm:ml-8" data-testid="first-run-fix-panel">
          {s.fix.kind === 'action' ? action : <FixPanel s={s} />}
        </div>
      )}
    </li>
  );
}

/** Start: what it changes, shown first; then a confirmation; then what happened. */
function StartCard({ start, canStart, blocked, confirming, setConfirming, onStarted }: { start: FirstRunStart; canStart: boolean; blocked: number; confirming: boolean; setConfirming: (b: boolean) => void; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await startCoordinator();
      setMsg({ ok: true, text: `started: ${r.detail}` });
      setConfirming(false);
      onStarted();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="first-run-start" id="first-run-start">
      <div className="text-[13px] font-medium text-ink">Start the coordinator</div>
      {start.kind === 'local' && (
        <>
          <div className="space-y-1.5 text-[12.5px] text-ink-2" data-testid="first-run-start-change">
            <p>
              Start installs a service for you with {start.manager}, which runs the coordinator now and again after a restart. It writes:
            </p>
            <code className={code}>{start.file}</code>
            <p>runs these:</p>
            <code className={code}>{start.commands.join('\n')}</code>
            <p>and the service runs:</p>
            <code className={code}>{start.program.join(' ')}</code>
            <p>
              Its log: <span className="break-all font-mono text-[12px] text-ink">{start.log}</span>. The CLI's <code className="font-mono text-[12px]">down</code> command removes the service again.
            </p>
          </div>
          {blocked > 0 && <p className="text-[12.5px] text-orange">{blocked} required step{blocked === 1 ? " isn't" : "s aren't"} done yet: the coordinator may stop at {blocked === 1 ? 'it' : 'them'}.</p>}
          {!canStart ? (
            <p className="text-[12.5px] text-ink-3" data-testid="first-run-start-refused">
              Only the instance's owners can start it.
            </p>
          ) : !confirming ? (
            <Button size="sm" onClick={() => setConfirming(true)} data-testid="first-run-start-button">
              Start…
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="first-run-start-confirming">
              <span className="text-[12.5px] text-ink">Make the change above and start it?</span>
              <Button size="sm" disabled={busy} onClick={() => void go()} data-testid="first-run-start-confirm">
                {busy ? 'Starting…' : 'Confirm start'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)} data-testid="first-run-start-cancel">
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
      {start.kind === 'owner-command' && (
        <div className="space-y-1.5 text-[12.5px] text-ink-2" data-testid="first-run-start-owner-command">
          <p>
            Not from here: {start.why}. It installs and starts <span className="font-mono text-[12px] text-ink">{start.unit}</span>.
          </p>
          <code className={code}>{start.command}</code>
        </div>
      )}
      {start.kind === 'unsupported' && <p className="text-[12.5px] text-ink-2">{start.why}.</p>}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="first-run-start-result">
          {msg.text}
        </p>
      )}
    </Card>
  );
}

/** The checklist from its data (also what the render checks render). `open` is the step whose Fix is open. */
export function FirstRunView({ f, onRecheck, checking = false, initialOpen = null, initialConfirming = false, initialActionConfirming = false }: { f: FirstRun; onRecheck?: () => void; checking?: boolean; initialOpen?: string | null; initialConfirming?: boolean; initialActionConfirming?: boolean }) {
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [confirming, setConfirming] = useState(initialConfirming);
  const setup = f.setup;
  const pct = setup?.total ? Math.round((setup.done / setup.total) * 100) : 0;
  const stopped = f.steps.find((s) => s.status === 'failed' && !s.optional);
  const checkedAt = setup?.groups.flatMap((g) => g.steps.map((s) => s.checkedAt)).sort()[0] ?? null;
  const fix = (s: SetupStepView) => {
    if (s.fix.kind === 'screen') return navigate(s.fix.path);
    if (s.fix.kind === 'start') {
      document.getElementById('first-run-start')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setOpen(open === s.id ? null : s.id);
  };
  return (
    <div className="space-y-5">
      {f.mode && (
        <p className="text-[12.5px] text-ink-2" data-testid="first-run-mode" data-mode={f.mode}>
          {MODE_LINE[f.mode]}
        </p>
      )}
      {setup && (
        <section aria-label="Progress" className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
            <span className="font-medium text-ink">
              {setup.done} of {setup.total} steps done{setup.requiredLeft ? `, ${setup.requiredLeft} required left` : ', every required step done'}
            </span>
            <span className="flex items-center gap-2">
              {checkedAt && (
                <span className="text-ink-3" data-testid="first-run-checked">
                  checked {ago(checkedAt)}
                </span>
              )}
              {onRecheck && (
                <Button size="sm" variant="outline" disabled={checking} onClick={onRecheck} data-testid="first-run-recheck">
                  {checking ? 'Checking…' : 'Re-check'}
                </Button>
              )}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-inset shadow-hairline" role="progressbar" aria-valuemin={0} aria-valuemax={setup.total} aria-valuenow={setup.done} aria-label="Setup progress" data-testid="first-run-progress">
            <div className={cx('h-full rounded-full transition-[width] duration-300', setup.requiredLeft ? 'bg-blue' : 'bg-green')} style={{ width: `${pct}%` }} />
          </div>
        </section>
      )}
      {setup?.groups.map((g) => (
        <section key={g.id} aria-label={g.title} className="space-y-1.5" data-testid="first-run-group" data-group={g.id} data-done={g.done} data-ready={g.ready}>
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-medium text-ink">{g.title}</h2>
            {g.optional && <span className="text-[11.5px] text-ink-3">optional</span>}
            <span className="text-[12px] text-ink-3">
              {g.steps.filter((s) => s.done).length}/{g.steps.length}
            </span>
          </div>
          <Card className="overflow-hidden">
            <ol className="divide-y divide-line" data-testid="first-run-steps">
              {g.steps.map((s) => (
                <StepRow
                  key={s.id}
                  s={s}
                  open={open === s.id}
                  onFix={() => fix(s)}
                  action={s.fix.kind === 'action' ? <ActionPanel plan={f.actions?.[s.fix.action]} canAct={!!f.canAct} initialConfirming={initialActionConfirming} onDone={() => onRecheck?.()} /> : undefined}
                />
              ))}
            </ol>
          </Card>
        </section>
      ))}
      <StartCard start={f.start} canStart={f.canStart} blocked={setup?.groups.flatMap((g) => g.steps).filter((s) => !s.optional && !s.done && s.fix.kind !== 'start').length ?? 0} confirming={confirming} setConfirming={setConfirming} onStarted={() => onRecheck?.()} />
      {f.autoConfig && <AutoConfigView a={f.autoConfig} />}
      {!f.recorded && (
        <Card className="space-y-2 p-4" data-testid="first-run-none">
          <div className="text-[13px] font-medium text-ink">init hasn't been run here</div>
          <p className="text-[12.5px] text-ink-2">The steps above are checked live either way. To walk them in a terminal (it does what isn't done, asking before it installs anything):</p>
          <code className={code}>{f.command}</code>
        </Card>
      )}
      {stopped && (
        <Card className="space-y-2 p-4" data-testid="first-run-resume">
          <div className="text-[13px] font-medium text-ink">init last stopped at {stopped.title}</div>
          <p className="text-[12.5px] text-ink-2">{stopped.detail}. Once that's fixed, run it again: it picks up there.</p>
          <code className={code}>{f.command}</code>
        </Card>
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
  const [checking, setChecking] = useState(false);
  const load = useCallback(
    (fresh: boolean) => {
      if (refused) return;
      if (fresh) setChecking(true);
      getFirstRun(fresh)
        .then(setF)
        .catch((e: Error) => setF({ error: e.message }))
        .finally(() => fresh && setChecking(false));
    },
    [refused],
  );
  useEffect(() => load(false), [load, state.lastId]);
  // Live while open: a provider login done in another tab shows here without a click.
  useEffect(() => {
    if (refused) return;
    const t = window.setInterval(() => load(false), POLL_MS);
    return () => window.clearInterval(t);
  }, [load, refused]);
  return (
    <div data-testid="page-first-run">
      <Header title="First run" sub={f && 'setup' in f && f.setup ? `${f.setup.done} of ${f.setup.total} steps done` : 'the guided setup, step by step'} />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {refused ? (
          <div className="text-[13px] text-ink-3" data-testid="first-run-refused">
            {refused.replace(/^the/, 'The')}.
          </div>
        ) : !f ? null : 'error' in f ? (
          <div className="text-[13px] text-red">Can't load the checklist: {f.error}</div>
        ) : (
          <FirstRunView f={f} onRecheck={() => load(true)} checking={checking} />
        )}
      </div>
    </div>
  );
}

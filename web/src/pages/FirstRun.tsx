// The first-run page: every setup step (src/setup-steps.ts), checked live from the real state, grouped, each done or
// not done, with a Fix for each that isn't: the screen that does it, or what to do today where there is no screen yet,
// or the provider's own page (a login, a consent) with this page noticing when it's done. It checks again on a short
// poll while open, and on Re-check. Start installs and starts the coordinator's service, after showing what it changes
// and a confirmation (the server records it in the audit). `doctor` shows the same steps with the same states.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cancelGhLogin, getFirstRun, getGhLogin, runFirstRunAction, skipStep, startCoordinator, startGhLogin, type FirstRun, type GhLoginView, type FirstRunActionPlan, type PolicyChange, type ConfigChange, type FirstRunAutoConfig, type FirstRunStart, type FirstRunVerification, type SetupStepView, type State, type ClaudeSigninData } from '../api';
import { navigate } from '../App';
import { ClaudeSigninPanel, ClaudeSigninView } from '../components/ClaudeSignin';
import { DiscordSetupPanel } from '../components/DiscordSetup';
import { ago, Badge, Button, Card, cx } from '../components/ui';
import { Header } from '../components/Header';
import { PolicyForm } from '../components/PolicyForm';
import { RepoConfigForm } from '../components/RepoConfigForm';
import { SetupAutoConfig, SetupOrigin } from '../components/SetupConfig';

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

/** How often Connect GitHub asks where the login is, while it waits for the code to be typed on GitHub. */
export const GH_POLL_MS = 2_000;

/**
 * WHY: Connect GitHub (audit row 8). The server runs `gh auth login --web` and relays only its one-time code; the person
 * types it on GitHub's device page, and the step is done once `gh auth status` says so. The token stays in gh's store.
 */
export function GhLoginPanel({ canAct, command, initial = null, onDone }: { canAct: boolean; command: string; initial?: GhLoginView | null; onDone: () => void }) {
  const [v, setV] = useState<GhLoginView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const waiting = v?.state === 'waiting';
  useEffect(() => {
    if (initial || !canAct) return;
    getGhLogin()
      .then(setV)
      .catch((e: Error) => setErr(e.message));
  }, [initial, canAct]);
  useEffect(() => {
    if (!waiting || initial) return;
    const t = window.setInterval(() => {
      getGhLogin()
        .then((n) => {
          setV(n);
          if (n.state === 'done') onDone();
        })
        .catch((e: Error) => setErr(e.message));
    }, GH_POLL_MS);
    return () => window.clearInterval(t);
  }, [waiting, initial, onDone]);
  const act = async (f: () => Promise<GhLoginView>) => {
    setBusy(true);
    setErr(null);
    try {
      const n = await f();
      setV(n);
      if (n.state === 'done') onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2.5" data-testid="gh-login" data-state={v?.state ?? 'loading'}>
      <p className="text-[12.5px] text-ink-2">
        This runs <code className="font-mono text-[12px] text-ink">{command}</code> on this machine for you. GitHub gives a one-time code to type on its device page; gh keeps the login in its own store, and this page never sees the token.
      </p>
      {!canAct ? (
        <p className="text-[12.5px] text-ink-3" data-testid="gh-login-refused">
          Only the instance's owners can connect GitHub here.
        </p>
      ) : v?.state === 'waiting' ? (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="gh-login-waiting">
          {v.code ? (
            <>
              <p className="text-[12.5px] text-ink">Type this code on GitHub:</p>
              <div className="select-all font-mono text-[22px] font-semibold tracking-[0.12em] text-ink" data-testid="gh-login-code">
                {v.code}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a href={v.url ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="gh-login-link">
                  Open github.com/login/device
                </a>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(cancelGhLogin)} data-testid="gh-login-cancel">
                  Cancel
                </Button>
              </div>
              <p className="text-[12px] text-ink-3">
                This page checks every {GH_POLL_MS / 1000} s and marks the step done once GitHub has the code{v.expiresAt ? `; the code lasts until ${new Date(v.expiresAt).toLocaleTimeString()}` : ''}.
              </p>
            </>
          ) : (
            <p className="text-[12.5px] text-ink" data-testid="gh-login-starting">
              Asking GitHub for a code…
            </p>
          )}
        </div>
      ) : v?.state === 'done' ? (
        <p className="text-[12.5px] text-green" data-testid="gh-login-done">
          {v.detail ?? 'Signed in.'} Checking that you can push…
        </p>
      ) : (
        <div className="space-y-2">
          {v && v.state !== 'idle' && v.detail && (
            <p className={cx('break-words text-[12.5px]', v.state === 'cancelled' ? 'text-ink-3' : 'text-red')} data-testid="gh-login-detail">
              {v.detail}
            </p>
          )}
          {v && !v.installed ? (
            <p className="text-[12.5px] text-ink-2" data-testid="gh-login-no-gh">
              gh isn't installed yet: the Tools step installs it.
            </p>
          ) : (
            <Button size="sm" disabled={busy || !v} onClick={() => void act(startGhLogin)} data-testid="gh-login-start">
              {busy ? 'Starting…' : v && v.state !== 'idle' ? 'Try again' : 'Connect GitHub'}
            </Button>
          )}
        </div>
      )}
      {err && (
        <p className="break-words text-[12.5px] text-red" data-testid="gh-login-error">
          {err}
        </p>
      )}
      <p className="text-[12px] text-ink-3">You can skip this and run the command in a terminal instead; the step turns done either way.</p>
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

function StepRow({ s, open, onFix, action, rerun = false, onSkip }: { s: SetupStepView; open: boolean; onFix: () => void; action?: ReactNode; rerun?: boolean; onSkip?: (skip: boolean) => void }) {
  const panel = s.fix.kind === 'action' || s.fix.kind === 'form' || s.fix.kind === 'signin' || s.fix.kind === 'gh-login' || s.fix.kind === 'discord';
  const label = s.fix.kind === 'screen' ? 'Open' : s.fix.kind === 'start' ? 'Start' : s.fix.kind === 'action' || s.fix.kind === 'form' || s.fix.kind === 'signin' || s.fix.kind === 'gh-login' || s.fix.kind === 'discord' ? s.fix.label : 'Fix';
  // WHY: a form's values can be reviewed and changed whether or not the step is done (the policy starts valid), and a
  // sign-in or the Discord step is rerunnable (another account, an expired login, another channel); any step opened from Settings' Setup list can be run
  // again; a skipped step stays closed until the skip is undone.
  const offered = rerun || (!s.skipped && (!s.done || (s.fix.kind === 'form' && s.fix.form !== 'setup-origin' && s.fix.form !== 'setup-config') || s.fix.kind === 'signin' || s.fix.kind === 'discord'));
  return (
    <li className="px-4 py-3" data-testid="first-run-step" data-step={s.id} data-status={s.done ? 'done' : s.skipped ? 'skipped' : 'todo'}>
      <div className="flex gap-3">
        <span className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', s.done ? 'bg-green-tint text-green' : s.optional ? 'bg-inset text-ink-3 shadow-hairline' : 'bg-red-tint text-red')} aria-hidden>
          {s.done ? '✓' : ''}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-ink">{s.title}</span>
            {s.optional && <span className="text-[11.5px] text-ink-3">optional</span>}
            <Badge tone={s.done ? 'ok' : s.optional || s.skipped ? 'neutral' : 'warn'}>{s.done ? 'done' : s.skipped ? 'skipped' : 'not done'}</Badge>
          </div>
          <p className="break-words text-[12.5px] text-ink-2">{s.detail}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-start justify-end gap-1.5 self-start">
          {onSkip && !s.done && (
            <Button size="sm" variant="ghost" onClick={() => onSkip(!s.skipped)} data-testid="first-run-skip" data-skipped={s.skipped}>
              {s.skipped ? 'Undo skip' : 'Skip'}
            </Button>
          )}
          {offered && (
            <Button size="sm" variant={open || (s.done && (s.fix.kind === 'signin' || s.fix.kind === 'discord')) ? 'ghost' : 'outline'} onClick={onFix} aria-expanded={s.fix.kind === 'screen' ? undefined : open} data-testid="first-run-fix" data-fix={s.fix.kind}>
              {s.done ? (s.fix.kind === 'form' ? label : s.fix.kind === 'signin' ? 'Again' : s.fix.kind === 'discord' ? 'Change' : 'Run again') : label}
            </Button>
          )}
        </div>
      </div>
      {open && offered && s.fix.kind !== 'screen' && s.fix.kind !== 'start' && (
        <div className="mt-2.5 rounded-lg bg-inset p-3 sm:ml-8" data-testid="first-run-fix-panel">
          {panel ? action : <FixPanel s={s} />}
          {s.automation && (
            <p className="mt-2.5 break-words border-t border-line pt-2 text-[12px] text-ink-3" data-testid="first-run-automation">
              Without this page: <code className="font-mono text-[11.5px] text-ink-2">{s.automation}</code>
            </p>
          )}
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
export function FirstRunView({ f, onRecheck, checking = false, initialOpen = null, initialConfirming = false, initialActionConfirming = false, initialPolicyChanges = null, initialConfigChanges = null, initialDraftConfirming = false, rerun = null, signin = null, discord, initialGhLogin = null }: { f: FirstRun; onRecheck?: () => void; checking?: boolean; initialOpen?: string | null; initialConfirming?: boolean; initialActionConfirming?: boolean; initialPolicyChanges?: PolicyChange[] | null; initialConfigChanges?: ConfigChange[] | null; initialDraftConfirming?: boolean; rerun?: string | null; signin?: ClaudeSigninData | null; discord?: ReactNode; initialGhLogin?: GhLoginView | null }) {
  const [skipError, setSkipError] = useState<string | null>(null);
  const skip = (id: string, on: boolean) => {
    setSkipError(null);
    skipStep(id, on)
      .then(() => onRecheck?.())
      .catch((e: Error) => setSkipError(e.message));
  };
  const [open, setOpen] = useState<string | null>(initialOpen);
  const recheck = useCallback(() => onRecheck?.(), [onRecheck]);
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
      {f.setupMode && (
        <Card className="space-y-1 p-4" data-testid="first-run-setup-mode">
          <div className="text-[13px] font-medium text-ink">{f.configReady ? 'The config is here: opening the dashboard…' : 'Setup mode: this checkout has no config yet'}</div>
          <p className="text-[12.5px] text-ink-2">Pick its GitHub repo, answer what auto-config asks, draft the config and merge its PR. The rest of the dashboard opens here on its own once the config is on the default branch and in this checkout.</p>
        </Card>
      )}
      {skipError && (
        <p className="break-words text-[12.5px] text-red" data-testid="first-run-skip-error">
          {skipError}
        </p>
      )}
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
                  rerun={rerun === s.id}
                  {...(f.canAct ? { onSkip: (on: boolean) => skip(s.id, on) } : {})}
                  action={
                    s.fix.kind === 'action' ? (
                      <ActionPanel plan={f.actions?.[s.fix.action]} canAct={!!f.canAct} initialConfirming={initialActionConfirming} onDone={() => onRecheck?.()} />
                    ) : s.fix.kind === 'signin' ? (
                      signin ? <ClaudeSigninView v={signin} onChanged={() => onRecheck?.()} /> : <ClaudeSigninPanel onDone={recheck} />
                    ) : s.fix.kind === 'gh-login' ? (
                      <GhLoginPanel canAct={!!f.canAct} command={s.fix.command} initial={initialGhLogin} onDone={recheck} />
                    ) : s.fix.kind === 'discord' ? (
                      (discord ?? <DiscordSetupPanel onChanged={() => onRecheck?.()} />)
                    ) : s.fix.kind === 'form' && s.fix.form === 'policy' && f.policy ? (
                      <PolicyForm p={f.policy} canEdit={!!f.canAct} initialChanges={initialPolicyChanges} onDone={() => onRecheck?.()} />
                    ) : s.fix.kind === 'form' && s.fix.form === 'repo-config' && f.repoConfig ? (
                      'error' in f.repoConfig ? (
                        <p className="break-words text-[12.5px] text-ink-2" data-testid="repo-config-error">
                          Not from here yet: {f.repoConfig.error}
                        </p>
                      ) : (
                        <RepoConfigForm c={f.repoConfig} canEdit={!!f.canAct} initialChanges={initialConfigChanges} onMerged={() => onRecheck?.()} />
                      )
                    ) : s.fix.kind === 'form' && s.fix.form === 'setup-origin' && f.setupMode ? (
                      <SetupOrigin canEdit={!!f.canAct} onDone={() => onRecheck?.()} />
                    ) : s.fix.kind === 'form' && s.fix.form === 'setup-config' && f.setupMode ? (
                      <SetupAutoConfig a={f.autoConfig} draft={f.draft} canEdit={!!f.canAct} onDone={() => onRecheck?.()} initialConfirming={initialDraftConfirming} />
                    ) : (
                      <FixPanel s={s} />
                    )
                  }
                />
              ))}
            </ol>
          </Card>
        </section>
      ))}
      <StartCard start={f.start} canStart={f.canStart} blocked={setup?.groups.flatMap((g) => g.steps).filter((s) => !s.optional && !s.done && s.fix.kind !== 'start').length ?? 0} confirming={confirming} setConfirming={setConfirming} onStarted={() => onRecheck?.()} />
      {f.autoConfig && !f.setupMode && <AutoConfigView a={f.autoConfig} />}
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

/** The step a link asked to open (Settings links here to run a step again): /first-run?open=<step>. */
const openFromUrl = () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('open'));

export function FirstRunPage({ state }: { state: State }) {
  const refused = firstRunRefusal(state);
  // WHY: Settings' Setup list opens one step here (?step=<id>), done or not, to run it again.
  const [rerun] = useState(() => new URLSearchParams(window.location.search).get('step'));
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
  const setupMode = !!(f && 'setupMode' in f && f.setupMode);
  const drafting = !!(f && 'draft' in f && f.draft?.running);
  // WHY: setup mode hands over to the dashboard on the same address: the first answer from it (not in setup mode) reloads the app.
  useEffect(() => {
    if (state.setupMode && f && !('error' in f) && f.setupMode === false) window.location.reload();
  }, [f, state.setupMode]);
  // Live while open: a provider login done in another tab shows here without a click; faster while setting up.
  useEffect(() => {
    if (refused) return;
    const t = window.setInterval(() => load(false), drafting || setupMode ? 3_000 : POLL_MS);
    return () => window.clearInterval(t);
  }, [load, refused, drafting, setupMode]);
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
          <FirstRunView f={f} onRecheck={() => load(true)} checking={checking} initialOpen={rerun ?? openFromUrl()} rerun={rerun} />
        )}
      </div>
    </div>
  );
}

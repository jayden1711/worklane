// Tailscale and HTTPS for the dashboard hub, on the Machine page, for the machine's owners only (the first-run
// wizard's screen for a server; src/tailscale-setup.ts): whether tailscale is installed and up, and four steps in
// order: install it, log this machine in, put the hub on HTTPS, set the hub's URL. Each step shows what it changes
// and the command that does the same in a terminal, then needs a second click; the coordinator runs it through the
// machine helper. While the login step waits, its link is a button here, for machine owners and nobody else.
// Nothing runs until a step is confirmed: leaving the panel alone is the skip, and the hub keeps its URL. Everyone
// else gets nothing here: the server sends them no data, and the view renders nothing for them.
import { useEffect, useRef, useState } from 'react';
import { getTailscale, tailscaleAction, type TailscaleAction, type TailscaleData, type TailscaleStepLine, type TailscaleStepView } from '../api';
import { afterLoad, NOTHING_YET, StaleNote, useRetry, type Loaded } from '../refresh';
import { ago, Badge, Button, Card, cx } from './ui';

const RUN_TONE: Record<NonNullable<TailscaleData['run']>['status'], 'info' | 'warn' | 'ok' | 'danger'> = { running: 'info', waiting: 'warn', done: 'ok', failed: 'danger', stalled: 'danger' };
const RUN_LABEL: Record<NonNullable<TailscaleData['run']>['status'], string> = { running: 'running', waiting: 'waiting on you', done: 'done', failed: 'failed', stalled: 'stopped without finishing' };
const LINE_TONE: Record<TailscaleStepLine['state'], 'neutral' | 'info' | 'warn' | 'ok' | 'danger'> = { started: 'neutral', running: 'info', waiting: 'warn', done: 'ok', failed: 'danger' };

/** How long a request handed to the step's unit is waited on for the unit's first line, at the busy pace. */
const HANDOFF_MS = 60_000;

/**
 * Whether the card looks again every few seconds rather than at its idle pace: a step is running or waiting on the owner,
 * a request waits for the coordinator, or the newest request was handed to the step's own unit and the unit hasn't
 * written its first line yet (the progress file still shows an earlier step, or none). Without that last case the card
 * went idle between the request finishing and the step starting, and showed the step only 20 s later.
 */
export function tailscaleBusy(d: Pick<TailscaleData, 'run' | 'requests'>, now = Date.now()): boolean {
  if (d.run && (d.run.status === 'running' || d.run.status === 'waiting')) return true;
  if (d.requests.some((r) => r.status === 'pending' || r.status === 'running')) return true;
  const last = d.requests[0];
  if (!last || last.status !== 'done' || now - Date.parse(last.finishedAt ?? last.at) > HANDOFF_MS) return false;
  // Progress lines carry whole seconds; a request is recorded to the millisecond.
  return !d.run || Date.parse(d.run.startedAt) < Date.parse(last.at) - 1_000;
}

/**
 * Whether a step ended between two reads. The card then reads again at once, with Tailscale asked afresh, so the next
 * step is offered from what Tailscale says after the step, not at the idle pace.
 */
export function tailscaleStepEnded(prev: Pick<TailscaleData, 'run'> | null, next: Pick<TailscaleData, 'run'>): boolean {
  const was = prev?.run;
  const now = next.run;
  return !!was && !!now && (was.status === 'running' || was.status === 'waiting') && now.step === was.step && now.startedAt === was.startedAt && (now.status === 'done' || now.status === 'failed');
}

/** What the machine says now, in a line. */
function summary(d: TailscaleData): { tone: 'ok' | 'neutral' | 'warn'; label: string; text: string } {
  const s = d.status;
  if (!s) return { tone: 'neutral', label: 'not available', text: "This machine's engine has no Tailscale setup script yet, or it didn't answer. Nothing here changes the machine." };
  if (!s.installed) return { tone: 'neutral', label: 'not installed', text: 'Tailscale is not installed on this machine. It is optional: without it the hub stays where it is.' };
  if (s.state !== 'Running' || !s.name) return { tone: 'warn', label: 'not logged in', text: `Tailscale ${s.version ?? ''} is installed, and this machine is not on a tailnet${s.state ? ` (${s.state})` : ''}.` };
  return { tone: 'ok', label: 'up', text: `Tailscale ${s.version ?? ''} is up: this machine is ${s.name}.` };
}

function StepCard({ n, step, d, next, confirming, busy, onAsk, onCancel, onRun }: { n: number; step: TailscaleStepView; d: TailscaleData; next: boolean; confirming: boolean; busy: boolean; onAsk: () => void; onCancel: () => void; onRun: () => void }) {
  const active = d.run?.step === step.id && (d.run.status === 'running' || d.run.status === 'waiting');
  const canRun = d.allowed && !d.busy && !step.blocked && !!d.status;
  const tone = step.done ? 'ok' : active ? RUN_TONE[d.run!.status] : step.blocked ? 'neutral' : 'warn';
  const label = step.done ? 'done' : active ? RUN_LABEL[d.run!.status] : step.blocked ? 'not yet' : 'not done';
  return (
    <li className="space-y-2 rounded-control bg-inset p-3 shadow-hairline" data-testid="tailscale-step" data-step={step.id} data-done={step.done} data-next={next}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums text-[12.5px] text-ink-3">{n}.</span>
        <span className="text-[13px] font-medium text-ink">{step.title}</span>
        <Badge tone={tone}>{label}</Badge>
        <span className="flex-1" />
        {!confirming && !active && (
          <Button size="sm" variant={next && !step.done ? 'default' : 'ghost'} disabled={!canRun || busy} onClick={onAsk} data-testid="tailscale-step-run">
            {step.done ? 'Run again…' : `${step.title}…`}
          </Button>
        )}
      </div>
      {step.blocked && !step.done && (
        <p className="break-words text-[12.5px] text-ink-2" data-testid="tailscale-step-blocked">
          Not yet: {step.blocked}.
        </p>
      )}
      {step.link && (
        <a href={step.link.url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-full bg-surface px-3 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover" data-testid="tailscale-step-link">
          Open {step.link.label}
        </a>
      )}
      {confirming && (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="tailscale-step-confirm">
          <p className="text-[12.5px] text-ink">As root, through the machine helper, this:</p>
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-2">
            {step.changes.map((c) => (
              <li key={c} className="break-words">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={onRun} data-testid="tailscale-step-confirm-run">
              {busy ? 'Asking…' : 'Confirm'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel} data-testid="tailscale-step-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      <p className="break-words text-[12px] text-ink-3" data-testid="tailscale-step-command">
        Without this page: <code className="font-mono text-[11.5px] text-ink-2">{step.command}</code>
      </p>
    </li>
  );
}

/** The last step's progress, and, while the login waits, its link. */
function Run({ d }: { d: TailscaleData }) {
  const run = d.run;
  if (!run) return null;
  return (
    <div className="space-y-2" data-testid="tailscale-run" data-step={run.step} data-status={run.status}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">Last step: {run.step}</span>
        <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
        <span className="text-ink-3">started {ago(run.startedAt)}</span>
      </div>
      {d.loginUrl && (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="tailscale-login">
          <p className="text-[12.5px] text-ink">Open Tailscale's login page, sign in, and approve this machine. This panel notices when it is done. The link is shown to machine owners only and works once.</p>
          <a href={d.loginUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="tailscale-login-link">
            Open Tailscale's login page
          </a>
        </div>
      )}
      <ul className="space-y-1">
        {run.lines
          .filter((l) => l.detail)
          .map((l, i) => (
            <li key={`${l.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]" data-testid="tailscale-run-line" data-state={l.state}>
              <Badge tone={LINE_TONE[l.state]}>{l.state}</Badge>
              <span className={cx('min-w-0 break-words', l.state === 'failed' ? 'text-red' : 'text-ink-2')}>{l.detail}</span>
            </li>
          ))}
      </ul>
      {run.status === 'stalled' && <p className="text-[12.5px] text-red">It stopped without a last line: see the step's unit in the machine's journal, then run the step again.</p>}
    </div>
  );
}

/** The panel from its data (also what the render checks render); nothing at all for anyone but a machine owner. */
export function TailscaleSetupView({ data, onChanged, initialConfirming = null }: { data: TailscaleData; onChanged?: () => void; initialConfirming?: TailscaleAction | null }) {
  const [confirming, setConfirming] = useState<TailscaleAction | null>(initialConfirming);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data.machineOwner) return null;
  const run = async (action: TailscaleAction) => {
    setBusy(true);
    setErr(null);
    try {
      await tailscaleAction(action);
      setConfirming(null);
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sum = summary(data);
  const open = data.requests.filter((r) => r.status === 'pending' || r.status === 'running');
  const lastRequest = data.requests[0];
  const s = data.status;
  return (
    <Card className="space-y-3 p-4" data-testid="tailscale-setup" data-next={data.next ?? 'none'}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium text-ink">Tailscale and HTTPS</span>
          <span className="text-[11.5px] text-ink-3">optional</span>
          <Badge tone={sum.tone}>{sum.label}</Badge>
        </div>
        <p className="text-[12px] text-ink-3">Reach the dashboard hub from your own devices over HTTPS, through your tailnet. For the machine's owners. Nothing here runs until you confirm a step; leave it alone and the hub keeps its URL.</p>
      </div>
      <div className="space-y-1 text-[12.5px] text-ink-2" data-testid="tailscale-status">
        <p className="break-words">{sum.text}</p>
        {s?.installed && s.name && (
          <p className="break-words">
            HTTPS certificate for this name: {s.https ? 'yes' : 'not yet'}. Forwarded to the hub: {s.serve ? 'yes' : 'no'}.
          </p>
        )}
        <p className="break-words" data-testid="tailscale-hub-url">
          The hub's URL now: {s?.hubUrl ? <span className="font-mono text-[12px] text-ink">{s.hubUrl}</span> : 'none read'}
        </p>
        {s?.installed && (
          <p className={cx('break-words', s.funnel && 'text-red')} data-testid="tailscale-funnel" data-funnel={s.funnel ? 'on' : 'off'}>
            Funnel (the public internet): {s.funnel ? 'ON. Nothing here turns it on or off, and the HTTPS and URL steps do nothing while it is on. To turn it off, on the machine: tailscale funnel reset.' : 'off. Nothing here turns it on: the hub is reachable from your tailnet only.'}
          </p>
        )}
        {s?.breakGlassForwarded && <p className="text-red">tailscale serve forwards to the break-glass port (4398), which must never be forwarded: on the machine, run tailscale serve reset.</p>}
      </div>
      {s && (
        <ol className="space-y-2" data-testid="tailscale-steps">
          {data.steps.map((step, i) => (
            <StepCard key={step.id} n={i + 1} step={step} d={data} next={data.next === step.id} confirming={confirming === step.id} busy={busy} onAsk={() => (setErr(null), setConfirming(step.id))} onCancel={() => setConfirming(null)} onRun={() => void run(step.id)} />
          ))}
        </ol>
      )}
      {!data.allowed && data.why && (
        <p className="break-words text-[12.5px] text-ink-2" data-testid="tailscale-disabled">
          Read-only: {data.why}.
        </p>
      )}
      {open.map((r) => (
        <p key={r.id} className="text-[12.5px] text-ink-3" data-testid="tailscale-request">
          {r.args.join(' ')}: {r.status === 'pending' ? 'waiting for the coordinator' : 'starting'} (asked {ago(r.at)} by @{r.by})
        </p>
      ))}
      {lastRequest && (lastRequest.status === 'failed' || lastRequest.status === 'refused' || lastRequest.status === 'interrupted') && (
        <p className="break-words text-[12.5px] text-red" data-testid="tailscale-request-failed">
          {lastRequest.args.join(' ')} wasn't started: {lastRequest.detail}
        </p>
      )}
      {err && (
        <p className="break-words text-[12.5px] text-red" data-testid="tailscale-error">
          {err}
        </p>
      )}
      <Run d={data} />
      <p className="break-words text-[12px] text-ink-3" data-testid="tailscale-script">
        The same in a terminal, without this page: <code className="font-mono text-[11.5px] text-ink-2">{data.script.status}</code>, then <code className="font-mono text-[11.5px] text-ink-2">{data.script.steps.join(' ; ')}</code>
      </p>
    </Card>
  );
}

/**
 * The panel: loaded, and looked at again every few seconds while a step or a request is under way. Hidden on refusal;
 * a look that fails otherwise keeps the last good data, and a step being confirmed, on screen (web/src/refresh.tsx).
 */
export function TailscaleSetupPanel() {
  const [loaded, setLoaded] = useState<Loaded<TailscaleData>>(NOTHING_YET);
  const data = loaded.data;
  const el = useRef<HTMLDivElement>(null);
  const last = useRef<TailscaleData | null>(null);
  const load = (fresh = false) =>
    getTailscale(fresh).then(
      (d) => {
        const ended = tailscaleStepEnded(last.current, d);
        last.current = d;
        setLoaded({ data: d, stale: null });
        // A step just ended: read again now, with Tailscale asked afresh, so the next step is offered at once.
        if (ended) void load(true);
      },
      (error: unknown) => setLoaded((p) => afterLoad(p, { error })),
    );
  useEffect(() => void load(), []);
  useRetry(loaded, () => void load());
  const active = !!data && tailscaleBusy(data);
  useEffect(() => {
    // While a step runs (or is being handed to its unit), every 3 s; otherwise every 20 s, so a login or a setting
    // changed on Tailscale's own pages shows up.
    const t = window.setInterval(() => void load(), active ? 3000 : 20_000);
    return () => window.clearInterval(t);
  }, [active]);
  // The first-run page's Open lands here (/machine#tailscale).
  const shown = !!data?.machineOwner;
  useEffect(() => {
    if (shown && window.location.hash === '#tailscale') el.current?.scrollIntoView({ block: 'start' });
  }, [shown]);
  if (!data) return null;
  return (
    <div ref={el} id="tailscale" className="space-y-1">
      {shown && <StaleNote stale={loaded.stale} />}
      <TailscaleSetupView data={data} onChanged={() => void load()} />
    </div>
  );
}

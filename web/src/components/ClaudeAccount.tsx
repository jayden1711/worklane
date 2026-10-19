// The agents' Claude account, on the Machine page, for the machine's owners only (src/claude-account.ts): which
// account and expiry each agent user has, and a switch of every agent on the machine to another account that a root
// admin runs on the machine, followed step by step (pause, the token at that root shell, each instance's check,
// resume). The page never takes a Claude credential (issue #711): no token box, no switch button; it names the root
// command. Everyone else gets only whether an account is set (issue #567): the server refuses them the accounts, and
// sends that in the state.
import { useEffect, useId, useState } from 'react';
import { claudeAccountAction, getClaudeAccount, isRefusal, useScope, type ClaudeAccountData, type InstanceScope, type SwitchLine, type SwitchView } from '../api';
import { afterLoad, NOTHING_YET, StaleNote, useRetry, type Loaded } from '../refresh';
import { ago, Badge, Button, Card, cx, firstWhy } from './ui';
import { ClaudeProfiles } from './ClaudeProfiles';

type Phase = 'pending' | 'running' | 'done' | 'failed';
const PHASE_TONE: Record<Phase, 'neutral' | 'info' | 'ok' | 'danger'> = { pending: 'neutral', running: 'info', done: 'ok', failed: 'danger' };
const PHASE_LABEL: Record<Phase, string> = { pending: 'not yet', running: 'in progress', done: 'done', failed: 'failed' };
const LINE_TONE: Record<SwitchLine['state'], 'neutral' | 'info' | 'ok' | 'danger' | 'warn'> = { started: 'info', done: 'ok', failed: 'danger', ask: 'warn', skipped: 'neutral' };
const LINE_LABEL: Record<SwitchLine['state'], string> = { started: 'started', done: 'done', failed: 'failed', ask: 'waiting on you', skipped: 'skipped' };
const SWITCH_LABEL: Record<SwitchView['status'], string> = { running: 'running', done: 'done', failed: 'failed', stalled: 'stopped without finishing' };

/** Where each of the four steps is, from the switch's lines. */
export function switchPhases(s: SwitchView): Record<'pause' | 'token' | 'check' | 'resume', Phase> {
  const ended = s.status !== 'running';
  const insts = s.instances;
  const any = (f: (i: SwitchView['instances'][number]) => (SwitchLine | null)[]) => insts.flatMap(f).filter((l): l is SwitchLine => !!l);
  const phase = (lines: SwitchLine[], complete: boolean): Phase => (lines.some((l) => l.state === 'failed') ? 'failed' : complete || (ended && lines.length) ? 'done' : lines.length ? 'running' : 'pending');
  const pauses = any((i) => [i.pause, i.wait]);
  const pauseDone = insts.length > 0 && insts.every((i) => i.pause && (i.pause.state !== 'done' || i.wait));
  const checks = any((i) => [i.check, ...i.users.flatMap((u) => [u.install, u.check])]);
  const resumes = any((i) => [i.resume]);
  return {
    pause: phase(pauses, pauseDone),
    token: !s.token ? 'pending' : s.token.state === 'failed' ? 'failed' : s.token.state === 'done' ? 'done' : 'running',
    check: phase(checks, insts.length > 0 && insts.every((i) => i.resume)),
    resume: phase(resumes, insts.length > 0 && insts.every((i) => i.resume)),
  };
}

function Line({ l, label }: { l: SwitchLine | null; label?: string }) {
  if (!l) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]" data-testid="claude-switch-line" data-step={l.step} data-state={l.state}>
      {label && <span className="font-mono text-[12px] text-ink-2">{label}</span>}
      <Badge tone={LINE_TONE[l.state]}>{LINE_LABEL[l.state]}</Badge>
      <span className="min-w-0 break-words text-ink-3">{l.detail}</span>
    </div>
  );
}

function Step({ n, title, phase, children }: { n: number; title: string; phase: Phase; children?: React.ReactNode }) {
  return (
    <li className="space-y-1.5 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-switch-step" data-phase={phase}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums text-[12.5px] text-ink-3">{n}.</span>
        <span className="text-[13px] font-medium text-ink">{title}</span>
        <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>
      </div>
      {children}
    </li>
  );
}

/** A switch a root admin runs on the machine, step by step, with each instance's result as it comes. Read-only. */
export function SwitchSteps({ s }: { s: SwitchView }) {
  const p = switchPhases(s);
  return (
    <div className="space-y-2" data-testid="claude-switch" data-status={s.status}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">Switch account</span>
        <Badge tone={s.status === 'done' ? 'ok' : s.status === 'running' ? 'info' : 'danger'}>{SWITCH_LABEL[s.status]}</Badge>
        <span className="text-ink-3">started {ago(s.startedAt)}</span>
      </div>
      {s.status !== 'running' && <p className={cx('text-[12.5px]', s.status === 'done' ? 'text-ink-2' : 'text-red')} data-testid="claude-switch-result">{s.detail}</p>}
      <ol className="space-y-2">
        <Step n={1} title="Pause every instance" phase={p.pause}>
          {s.instances.map((i) => (
            <div key={i.name} className="space-y-0.5" data-testid="claude-switch-instance" data-instance={i.name}>
              <Line l={i.pause} label={i.name} />
              <Line l={i.wait} label={i.name} />
            </div>
          ))}
        </Step>
        <Step n={2} title="The new token, at the root shell" phase={p.token}>
          <Line l={s.token} />
          {s.waitingForToken && (
            <p className="text-[12px] text-ink-3" data-testid="claude-switch-token-elsewhere">
              It is pasted in the terminal where the switch was started. This page never takes it.
            </p>
          )}
        </Step>
        <Step n={3} title="Check each agent user" phase={p.check}>
          {s.instances.map((i) => (
            <div key={i.name} className="space-y-0.5" data-testid="claude-switch-check" data-instance={i.name}>
              <Line l={i.check} label={i.name} />
              {i.users.map((u) => (
                <div key={u.user} className="space-y-0.5">
                  <Line l={u.install} label={u.user} />
                  <Line l={u.check} label={u.user} />
                </div>
              ))}
            </div>
          ))}
        </Step>
        <Step n={4} title="Resume" phase={p.resume}>
          {s.instances.map((i) => (
            <div key={i.name} data-testid="claude-switch-resume" data-instance={i.name} data-state={i.resume?.state ?? 'pending'}>
              <Line l={i.resume} label={i.name} />
            </div>
          ))}
        </Step>
      </ol>
    </div>
  );
}

const expiry = (at: string | null, now: number) => {
  if (!at) return { text: 'no expiry known', tone: 'neutral' as const };
  const days = Math.floor((Date.parse(at) - now) / 86_400_000);
  if (days < 0) return { text: `expired ${at.slice(0, 10)}`, tone: 'danger' as const };
  return { text: `expires ${at.slice(0, 10)} (${days} day${days === 1 ? '' : 's'})`, tone: days < 14 ? ('warn' as const) : ('neutral' as const) };
};

/**
 * The panel from its data (also what the render checks render); nothing at all for anyone but a machine owner.
 * `scope`: on a hub, the instances the page shows. With "All instances" chosen the panel says it covers every one and
 * offers no step for one instance alone (those would go to the instance picked before, which the page no longer names:
 * #562); with one instance picked, its steps are for that one.
 */
export function ClaudeAccountView({ data, scope = null, onChanged, now = Date.now() }: { data: ClaudeAccountData; scope?: InstanceScope | null; onChanged?: () => void; now?: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refusedId, busyId] = [useId(), useId()];
  if (!data.machineOwner) return null;
  const script = data.confirmScript ?? 'claude-account.sh';
  const act = async (action: 'status') => {
    setBusy(action);
    setErr(null);
    try {
      await claudeAccountAction(action);
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const users = data.status?.users ?? [];
  const open = data.requests.filter((r) => r.status === 'pending' || r.status === 'running');
  const all = scope?.all ? scope.instances.filter((i): i is string => !!i) : null;
  return (
    <Card className="space-y-3 p-4" data-testid="claude-account">
      <div>
        <div className="text-[14px] font-medium text-ink">Claude account</div>
        <p className="text-[12px] text-ink-3">The Claude login every agent on this machine uses: each instance's agent user (channel chat runs as it too) and eval user. For the machine's owners.</p>
        {scope?.current && (
          <p className="mt-1 text-[12px] text-ink-2" data-testid="claude-account-scope" data-scope={all ? 'all' : data.instance}>
            {all ? (
              <>
                For every instance on this machine ({all.join(', ')}): Refresh covers them all. To choose or remove an account for one instance from here, pick it in the sidebar.
              </>
            ) : (
              <>
                For {data.instance}: the account steps below are for it alone; Refresh covers every instance.
              </>
            )}
          </p>
        )}
      </div>
      {data.status ? (
        <ul className="divide-y divide-line rounded-card bg-surface shadow-card" data-testid="claude-account-users">
          {users.map((u) => {
            const e = expiry(u.expiresAt, now);
            return (
              <li key={`${u.instance}/${u.user}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]" data-testid="claude-account-user" data-user={u.user} data-signed-in={u.loggedIn ? 'yes' : 'no'}>
                <span className="min-w-0 font-mono text-[12px] text-ink">
                  {u.user} <span className="text-ink-3">({u.instance}, {u.kind})</span>
                </span>
                <Badge tone={u.loggedIn ? 'ok' : 'danger'}>{u.loggedIn ? 'signed in' : 'not signed in'}</Badge>
                <span className="min-w-0 break-words text-ink-2">{u.account ? `${u.account}${u.org ? ` · ${u.org}` : ''}` : (u.authMethod ?? 'no account named')}</span>
                {u.tokenId && <span className="font-mono text-[11.5px] text-ink-3" title="the first 8 hex digits of the token's sha256: the same login shows the same id">token {u.tokenId}</span>}
                <Badge tone={e.tone}>{e.text}</Badge>
                {u.error && !u.loggedIn && <span className="basis-full text-[12px] text-red">{u.error}</span>}
              </li>
            );
          })}
          {!users.length && <li className="px-3 py-2 text-[12.5px] text-ink-3">No agent users found on this machine.</li>}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3" data-testid="claude-account-none">
          Not read yet: Refresh asks the machine for each agent user's account.
        </p>
      )}
      {data.status && <p className="text-[11.5px] text-ink-3">Read {ago(data.status.at)}.</p>}
      {data.profiles && <ClaudeProfiles table={data.profiles} ops={data.profileOps ?? []} self={all ? null : data.instance} confirmScript={script} canAct={data.allowed && !data.busy} {...(onChanged ? { onChanged } : {})} />}
      {/* A person no device would help (their role here) gets no buttons, only the read-only line below. */}
      {data.everAllowed !== false && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" why={firstWhy(!data.allowed && (data.why ?? 'not allowed'), !!busy && 'Asking…', open.some((r) => r.args[1] === 'status') && 'A refresh is waiting for the coordinator')} {...(!data.allowed && data.why ? { whyAt: refusedId } : {})} onClick={() => void act('status')} data-testid="claude-account-refresh">
            {busy === 'status' || open.some((r) => r.args[1] === 'status') ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      )}
      {/* Issue #711: switching takes a Claude credential, which this page never takes: the root command, never a button. */}
      <div className="space-y-1 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-account-switch-howto">
        <p className="text-[12.5px] text-ink-2">
          To switch every agent on this machine to another account, a root admin runs this on the machine and pastes the token <code>claude setup-token</code> prints there. This page never takes a Claude credential.
        </p>
        <pre className="overflow-x-auto font-mono text-[12px] text-ink" data-testid="claude-account-switch-command">sudo bash {script} switch</pre>
      </div>
      {!data.allowed && data.why && (
        <p id={refusedId} className="text-[12.5px] text-ink-2" data-testid="claude-account-disabled">
          Read-only: {data.why}.
        </p>
      )}
      {data.allowed && data.busy && <p id={busyId} className="text-[12.5px] text-ink-3">{data.busy[0]!.toUpperCase() + data.busy.slice(1)}.</p>}
      {open.map((r) => (
        <p key={r.id} className="text-[12.5px] text-ink-3" data-testid="claude-account-request">
          {r.args.join(' ')}: {r.status === 'pending' ? 'waiting for the coordinator' : 'running'} (asked {ago(r.at)} by @{r.by})
        </p>
      ))}
      {err && (
        <p className="text-[12.5px] text-red" data-testid="claude-account-error">
          {err}
        </p>
      )}
      {data.switch && <SwitchSteps s={data.switch} />}
    </Card>
  );
}

/**
 * Whether the panel looks again every few seconds: a switch (a root admin's) is running, a request waits for the
 * coordinator, or the newest request was a profile step handed to its own unit, which hasn't written its first line
 * yet. Without that last case the panel stopped looking the moment the request finished, before the step had started.
 */
export function accountBusy(d: Pick<ClaudeAccountData, 'switch' | 'requests' | 'profileOps'>, now = Date.now()): boolean {
  if (d.switch?.status === 'running') return true;
  if (d.profileOps?.[0]?.status === 'running') return true;
  if (d.requests.some((r) => r.status === 'pending' || r.status === 'running')) return true;
  const last = d.requests[0];
  if (!last || last.status !== 'done' || !['use', 'remove'].includes(last.args[1] ?? '') || now - Date.parse(last.finishedAt ?? last.at) > 60_000) return false;
  const op = d.profileOps?.[0];
  return !op || Date.parse(op.startedAt) < Date.parse(last.at) - 1_000;
}

/**
 * For anyone the panel refuses (a viewer, a writer, an owner who isn't a machine owner): whether the agents' Claude
 * account is set, from the state, and nothing more. The server sends them no account, plan or profile name (#567).
 * Nothing when the state doesn't say (a checkout, an older server).
 */
export function ClaudeAccountSet({ set }: { set: boolean | null | undefined }) {
  if (set === undefined) return null;
  return (
    <Card className="space-y-1 p-4" data-testid="claude-account-set" data-set={set === null ? 'unknown' : String(set)}>
      <div className="text-[14px] font-medium text-ink">Claude account</div>
      <p className="text-[12.5px] text-ink-2">
        {set === null ? "Not known yet: the machine hasn't checked the agents' Claude login." : set ? 'An account is set for this instance\'s agents.' : "No account is signed in for this instance's agents."}
      </p>
      <p className="text-[12px] text-ink-3">Which account it is, and switching it, are for the machine's owners.</p>
    </Card>
  );
}

/**
 * The panel: loaded, and looked at again every few seconds while a switch or a request is under way. On refusal, only
 * whether an account is set (`accountSet`, from the state); a look that fails otherwise keeps the last good data, and
 * a token being pasted, on screen (web/src/refresh.tsx).
 */
export function ClaudeAccountPanel({ onLoaded, accountSet }: { onLoaded?: () => void; accountSet?: boolean | null | undefined }) {
  const scope = useScope();
  const [loaded, setLoaded] = useState<Loaded<ClaudeAccountData>>(NOTHING_YET);
  const [refused, setRefused] = useState(false);
  const data = loaded.data;
  const load = () =>
    getClaudeAccount()
      .then(
        (d) => {
          setRefused(false);
          setLoaded({ data: d, stale: null });
        },
        (error: unknown) => {
          if (isRefusal(error)) setRefused(true);
          setLoaded((p) => afterLoad(p, { error }));
        },
      )
      .finally(() => onLoaded?.());
  useEffect(() => void load(), []);
  useRetry(loaded, () => void load());
  const active = !!data && accountBusy(data);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [active]);
  if (!data) return refused ? <ClaudeAccountSet set={accountSet} /> : null;
  return (
    <div className="space-y-1">
      <StaleNote stale={loaded.stale} />
      <ClaudeAccountView data={data} scope={scope} onChanged={() => void load()} />
    </div>
  );
}

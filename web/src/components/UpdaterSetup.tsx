// The Machine page's "Updater setup" (the first-run wizard's Engine updates step, server mode): install the engine
// updater, see the release signers it verifies tags against, stage one more, and put it on the release channel. The
// on/off switch stays in the machine settings table below.
//
// A dashboard session can't add a release signer: those keys are the root of trust for engine updates. The page can
// only STAGE one. It then shows the exact command an admin runs at a root shell on the machine to confirm it, naming
// the key by its fingerprint; until that is run the staged key is trusted for nothing, and it is dropped after 24
// hours. Following main instead of releases is likewise a root shell's: the page offers only "release".
//
// Every step is two clicks. Review asks the server what would run and change, and shows it; the second click confirms.
// Nothing changes until then, and leaving the page changes nothing. A confirmed step is a machine request: the
// coordinator runs the machine helper (the dashboard never runs sudo), and it shows under "Requested here".
import { useState } from 'react';
import { api } from '../api';
import type { MachineData } from './MachineSettings';
import { ago, Badge, Button, Card, cx } from './ui';

export interface UpdaterSigner {
  principal: string;
  options: string;
  keyType: string;
  key: string;
  fingerprint: string | null;
}

export interface UpdaterPending {
  principal: string;
  key: string;
  fingerprint: string;
  by: string;
  /** The instance whose dashboard staged it; absent from older servers. */
  instance?: string | null;
  at: string;
  expiresAt: string;
  /** The root command that confirms it. */
  confirm: string;
}

export interface UpdaterData {
  installed: boolean;
  enabled: boolean | null;
  channel: 'release' | 'main' | null;
  channelWhat: string | null;
  signersFile: string;
  updaterReads: string | null;
  signers: UpdaterSigner[] | null;
  pending: UpdaterPending[];
  pendingMax: number;
  script: { install: string; signer: string; confirm: string; release: string; main: string; releaseHold?: string };
}

export interface UpdaterPlan {
  step: 'install' | 'release' | 'stage' | 'discard';
  args: string[];
  command: string;
  changes: string[];
  script: string;
  signer?: { principal: string; key: string; fingerprint: string; line: string; confirm: string; file: string };
}

type Input = { step: 'install' } | { step: 'release' } | { step: 'stage'; principal: string; key: string } | { step: 'discard'; principal: string; key: string };

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';
const field = 'h-8 w-full rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]';
const CONFIRM: Record<UpdaterPlan['step'], string> = { install: 'Install the updater', release: 'Follow releases', stage: 'Stage this signer', discard: 'Discard it' };

/** What a reviewed step will run and change; for a signer, exactly what is staged and what would then confirm it. Then the confirming click. */
function Review({ plan, busy, onConfirm, onCancel }: { plan: UpdaterPlan; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-2.5 rounded-lg bg-blue-tint p-3" data-testid="updater-review" data-step={plan.step}>
      {plan.signer && (
        <div className="space-y-1.5" data-testid="updater-review-signer">
          <p className="text-[12.5px] font-medium text-ink">Staging adds nothing to the keys this machine trusts. It records this key so an admin can confirm it at a root shell.</p>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-[12.5px] sm:grid-cols-[92px_1fr]">
            <dt className="text-ink-3">Principal</dt>
            <dd className="break-all font-mono text-[12px] text-ink" data-testid="updater-review-principal">
              {plan.signer.principal}
            </dd>
            <dt className="text-ink-3">Key type</dt>
            <dd className="font-mono text-[12px] text-ink">ssh-ed25519</dd>
            <dt className="text-ink-3">Public key</dt>
            <dd className="break-all font-mono text-[12px] text-ink" data-testid="updater-review-key">
              {plan.signer.key}
            </dd>
            <dt className="text-ink-3">Fingerprint</dt>
            <dd className="break-all font-mono text-[12px] text-ink" data-testid="updater-review-fingerprint">
              {plan.signer.fingerprint}
            </dd>
          </dl>
          <p className="text-[12.5px] text-ink-2">Once staged, it becomes a signer only when an admin runs this, as root on the machine, within 24 hours:</p>
          <code className={code} data-testid="updater-review-root-command">
            {plan.signer.confirm}
          </code>
        </div>
      )}
      <div className="space-y-1.5 text-[12.5px] text-ink-2">
        <p>As root, through the machine helper, this step runs:</p>
        <code className={code} data-testid="updater-review-command">
          {plan.command}
        </code>
        <ul className="list-disc space-y-1 pl-5" data-testid="updater-review-changes">
          {plan.changes.map((c) => (
            <li key={c} className="break-words">
              {c}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onConfirm} data-testid="updater-confirm">
          {busy ? 'Asking…' : CONFIRM[plan.step]}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel} data-testid="updater-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Step({ n, title, state, tone, children }: { n: number; title: string; state: string; tone: 'ok' | 'warn' | 'neutral'; children: React.ReactNode }) {
  return (
    <li className="space-y-2 px-4 py-3" data-testid="updater-step" data-step={n}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-medium text-ink">
          {n}. {title}
        </span>
        <Badge tone={tone}>{state}</Badge>
      </div>
      {children}
    </li>
  );
}

/** How long a staged signer still waits, as people say it. */
export function waitsFor(expiresAt: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

/** The section from its data (also what the render checks render). `initialReview` opens a step's review as the server answered it. */
export function UpdaterSetupView({ data, onChanged = () => {}, initialReview = null }: { data: MachineData; onChanged?: (d: MachineData) => void; initialReview?: { input: Input; plan: UpdaterPlan } | null }) {
  const u = data.updater;
  const [review, setReview] = useState<{ input: Input; plan: UpdaterPlan } | null>(initialReview);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [principal, setPrincipal] = useState('');
  const [key, setKey] = useState('');
  if (!u) return null;
  const post = <T,>(path: string, body: object) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
  const ask = async (input: Input) => {
    setBusy(true);
    setMsg(null);
    try {
      setReview({ input, plan: (await post<{ plan: UpdaterPlan }>('/api/machine/updater/review', input)).plan });
    } catch (e) {
      setReview(null);
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ machine: MachineData }>('/api/machine/updater', { ...review.input, confirm: true });
      setMsg({ ok: true, text: `requested: ${review.plan.command}. The coordinator runs it on its next tick; it shows under "Requested here" below.` });
      setReview(null);
      if (review.input.step === 'stage') {
        setPrincipal('');
        setKey('');
      }
      onChanged(r.machine);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const open = (step: UpdaterPlan['step'], at?: string) =>
    review?.plan.step === step && (at === undefined || ('key' in review.input && review.input.key === at)) ? <Review plan={review.plan} busy={busy} onConfirm={() => void confirm()} onCancel={() => setReview(null)} /> : null;
  const can = data.canChange;
  const signers = u.signers ?? [];
  const pending = u.pending ?? [];
  return (
    <section className="space-y-2" aria-label="Updater setup" data-testid="updater-setup" id="updater-setup">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Updater setup</span>
        <span className="text-[12px] text-ink-3">the engine updater for this machine: install it, the keys it trusts for releases, and what it follows</span>
      </div>
      <p className="text-[12.5px] text-ink-2" data-testid="updater-nothing-changes">
        Nothing changes until you review a step and confirm it. Skip any of them, or all: the machine stays as it is. Each confirmed step is run as root by {data.helper}, which logs it.
      </p>
      <Card className="overflow-hidden">
        <ol className="divide-y divide-line">
          <Step n={1} title="The updater" state={u.installed ? `installed, updates ${u.enabled ? 'on' : 'off'}` : 'not installed'} tone={u.installed ? 'ok' : 'warn'}>
            <p className="text-[12.5px] text-ink-2">
              {u.installed ? 'Installed. Installing again replaces the updater with the installed engine\'s copy and keeps its settings.' : 'Installs the updater and its 10-minute timer with updates off: it does nothing until you turn engine updates on, in the machine settings below.'}
            </p>
            {can && review?.plan.step !== 'install' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void ask({ step: 'install' })} data-testid="updater-install">
                {u.installed ? 'Install again…' : 'Install the updater…'}
              </Button>
            )}
            {open('install')}
            {u.script.releaseHold && (
              <p className="text-[12px] text-ink-3" data-testid="updater-release-hold">
                A commit the updater rolled back stays held until a newer one, or until an admin releases it at a root shell: <span className="font-mono">{u.script.releaseHold}</span>. Nothing on this page releases a hold, the channel and the on/off switch included.
              </p>
            )}
          </Step>
          <Step n={2} title="Release signers" state={`${signers.length ? `${signers.length} listed` : 'none listed'}${pending.length ? `, ${pending.length} staged` : ''}`} tone={signers.length ? 'ok' : u.channel === 'main' ? 'neutral' : 'warn'}>
            <p className="text-[12.5px] text-ink-2">
              On the release channel the updater installs only a release tag whose signature verifies against one of these public keys ({u.signersFile}). With none listed, it installs no release.
            </p>
            {u.updaterReads && (
              <p className="text-[12.5px] text-orange" data-testid="updater-reads-elsewhere">
                This machine's updates.json tells the updater to read {u.updaterReads} instead, which this page doesn't show or change.
              </p>
            )}
            {!!signers.length && (
              <div className="overflow-x-auto rounded-lg shadow-hairline">
                <table className="w-full border-collapse text-left" data-testid="updater-signers">
                  <thead>
                    <tr className="border-b border-line bg-inset text-[11.5px] font-medium text-ink-3">
                      <th className="px-3 py-1.5 font-medium">Principal</th>
                      <th className="px-3 py-1.5 font-medium">Key</th>
                      <th className="px-3 py-1.5 font-medium">Fingerprint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signers.map((s) => (
                      <tr key={`${s.principal} ${s.key}`} className="border-b border-line align-top last:border-0" data-testid="updater-signer">
                        <td className="break-all px-3 py-1.5 text-[12.5px] text-ink">{s.principal}</td>
                        <td className="px-3 py-1.5 font-mono text-[12px] text-ink-2">
                          {s.keyType}
                          {s.options ? <div className="font-sans text-[11.5px] text-ink-3">{s.options}</div> : null}
                        </td>
                        <td className="break-all px-3 py-1.5 font-mono text-[12px] text-ink-2">{s.fingerprint ?? '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[12.5px] text-ink-2" data-testid="updater-stage-only">
              This page can't add a signer, and it can't remove or replace one. It can stage a key; an admin then confirms it with one command at a root shell on the machine. Until then the staged key is trusted for nothing, and after 24 hours it is dropped.
              Every signer added raises an alert on the ops channel and the Health page.
            </p>
            {pending.map((p) => (
              <div key={`${p.principal} ${p.key}`} className="space-y-1.5 rounded-lg bg-inset p-3 shadow-hairline" data-testid="updater-pending" data-fingerprint={p.fingerprint}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone="warn">staged, not a signer</Badge>
                  <span className="break-all text-[12.5px] font-medium text-ink">{p.principal}</span>
                  <span className="text-[11.5px] text-ink-3" title={p.at}>
                    staged {ago(p.at)} by {p.by}{p.instance ? ` (instance ${p.instance})` : ''}; dropped in {waitsFor(p.expiresAt)}
                  </span>
                </div>
                <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-[12.5px] sm:grid-cols-[92px_1fr]">
                  <dt className="text-ink-3">Public key</dt>
                  <dd className="break-all font-mono text-[12px] text-ink">ssh-ed25519 {p.key}</dd>
                  <dt className="text-ink-3">Fingerprint</dt>
                  <dd className="break-all font-mono text-[12px] text-ink" data-testid="updater-pending-fingerprint">
                    {p.fingerprint}
                  </dd>
                </dl>
                <p className="text-[12.5px] text-ink-2">
                  To make it a signer, check the fingerprint against your own key (<span className="font-mono text-[12px]">ssh-keygen -lf &lt;your key&gt;.pub</span>), then run this as root on the machine. It prints who staged it, the principal and the key, and asks you to type the principal before it adds anything:
                </p>
                <code className={code} data-testid="updater-pending-command">
                  {p.confirm}
                </code>
                {can && !(review?.plan.step === 'discard' && 'key' in review.input && review.input.key === p.key) && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void ask({ step: 'discard', principal: p.principal, key: p.key })} data-testid="updater-pending-discard">
                    Discard…
                  </Button>
                )}
                {open('discard', p.key)}
              </div>
            ))}
            {can && review?.plan.step !== 'stage' && pending.length < (u.pendingMax ?? 4) && (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end" data-testid="updater-signer-form">
                <label className="space-y-1 text-[11.5px] text-ink-3">
                  Principal (the signer's email)
                  <input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="release@example.com" autoComplete="off" spellCheck={false} className={field} data-testid="updater-signer-principal" />
                </label>
                <label className="space-y-1 text-[11.5px] text-ink-3">
                  Public key (the line of the .pub file)
                  <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5…" autoComplete="off" spellCheck={false} className={cx(field, 'font-mono')} data-testid="updater-signer-key" />
                </label>
                <Button size="sm" variant="outline" disabled={busy || !principal.trim() || !key.trim()} onClick={() => void ask({ step: 'stage', principal, key })} data-testid="updater-signer-review">
                  Review to stage…
                </Button>
              </div>
            )}
            {open('stage')}
          </Step>
          <Step n={3} title="Channel" state={u.channel ?? 'not installed'} tone={u.channel === 'release' ? 'ok' : u.channel === 'main' ? 'warn' : 'neutral'}>
            {u.channel ? (
              <p className="break-words text-[12.5px] text-ink-2" data-testid="updater-channel" data-channel={u.channel}>
                It follows <span className="font-medium text-ink">{u.channel}</span>: {u.channelWhat}.
              </p>
            ) : (
              <p className="text-[12px] text-ink-3">Install the updater first: it starts on release, signed release tags only.</p>
            )}
            {can && u.channel === 'main' && review?.plan.step !== 'release' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void ask({ step: 'release' })} data-testid="updater-release">
                Follow releases…
              </Button>
            )}
            {open('release')}
            <p className="text-[12px] text-ink-3" data-testid="updater-main-root-only">
              The page only ever moves a machine to release. Following main instead is set at a root shell: <span className="font-mono">{u.script.main}</span>
            </p>
          </Step>
        </ol>
      </Card>
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="updater-message">
          {msg.text}
        </p>
      )}
      <div className="space-y-1 text-[12.5px] text-ink-2" data-testid="updater-script">
        <p>The same without this page, as root from the engine's checkout (docs/dashboard.md, "Updater setup"):</p>
        <code className={code}>{[u.script.install, u.script.signer, u.script.confirm, u.script.release].join('\n')}</code>
      </div>
    </section>
  );
}

// The Machine page's "Updater setup" (the first-run wizard's Engine updates step, server mode): install the engine
// updater, list the release signers it verifies tags against and add one, and pick the channel it follows. The
// on/off switch stays in the machine settings table below.
//
// Every step is two clicks. Review asks the server what would run and change, and shows it: for a signer, the exact
// principal, the whole public key, its fingerprint and the line that will be written. Confirm sends the same values
// back with that fingerprint. Nothing changes until then, and leaving the page changes nothing. A confirmed step is a
// machine request: the coordinator runs the machine helper (the dashboard never runs sudo), and it shows under
// "Requested here". The page can add a signer; it can't remove or replace one, or change how the updater verifies.
import { useState } from 'react';
import { api } from '../api';
import type { MachineData } from './MachineSettings';
import { Badge, Button, Card, cx } from './ui';

export interface UpdaterSigner {
  principal: string;
  options: string;
  keyType: string;
  key: string;
  fingerprint: string | null;
}

export interface UpdaterData {
  installed: boolean;
  enabled: boolean | null;
  channel: 'release' | 'main' | null;
  channels: { id: 'release' | 'main'; what: string }[];
  signersFile: string;
  updaterReads: string | null;
  signers: UpdaterSigner[] | null;
  script: { install: string; channel: string; signer: string; signersByHand: string };
}

export interface UpdaterPlan {
  step: 'install' | 'channel' | 'signer';
  args: string[];
  command: string;
  changes: string[];
  script: string;
  signer?: { principal: string; key: string; fingerprint: string; line: string; file: string };
}

type Input = { step: 'install' } | { step: 'channel'; channel: string } | { step: 'signer'; principal: string; key: string };

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';
const field = 'h-8 w-full rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]';
const CONFIRM: Record<UpdaterPlan['step'], string> = { install: 'Install the updater', channel: 'Change the channel', signer: 'Add this signer' };

/** What a reviewed step will run and change; for a signer, exactly what will be written. Then the confirming click. */
function Review({ plan, busy, onConfirm, onCancel }: { plan: UpdaterPlan; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-2.5 rounded-lg bg-blue-tint p-3" data-testid="updater-review" data-step={plan.step}>
      {plan.signer && (
        <div className="space-y-1.5" data-testid="updater-review-signer">
          <p className="text-[12.5px] font-medium text-ink">This key will be trusted to sign engine releases for this machine. Check all of it before you confirm.</p>
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
            <dt className="text-ink-3">Added to</dt>
            <dd className="break-all font-mono text-[12px] text-ink">{plan.signer.file}</dd>
          </dl>
          <p className="text-[12.5px] text-ink-2">The line it adds, exactly:</p>
          <code className={code} data-testid="updater-review-line">
            {plan.signer.line}
          </code>
          <p className="text-[12px] text-ink-2">
            Compare the fingerprint with your own key's: <span className="font-mono">ssh-keygen -lf &lt;your key&gt;.pub</span>
          </p>
        </div>
      )}
      <div className="space-y-1.5 text-[12.5px] text-ink-2">
        <p>As root, through the machine helper, it runs:</p>
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

/** The section from its data (also what the render checks render). `initialReview` opens a step's review as the server answered it. */
export function UpdaterSetupView({ data, onChanged = () => {}, initialReview = null }: { data: MachineData; onChanged?: (d: MachineData) => void; initialReview?: { input: Input; plan: UpdaterPlan } | null }) {
  const u = data.updater;
  const [review, setReview] = useState<{ input: Input; plan: UpdaterPlan } | null>(initialReview);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [principal, setPrincipal] = useState('');
  const [key, setKey] = useState('');
  const [channel, setChannel] = useState<string>(u?.channel ?? '');
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
      // The fingerprint that was on the screen goes back with the confirm: the server refuses any other key.
      const r = await post<{ machine: MachineData }>('/api/machine/updater', { ...review.input, confirm: true, ...(review.plan.signer ? { fingerprint: review.plan.signer.fingerprint } : {}) });
      setMsg({ ok: true, text: `requested: ${review.plan.command}. The coordinator runs it on its next tick; it shows under "Requested here" below.` });
      setReview(null);
      if (review.input.step === 'signer') {
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
  const open = (step: UpdaterPlan['step']) => (review?.plan.step === step ? <Review plan={review.plan} busy={busy} onConfirm={() => void confirm()} onCancel={() => setReview(null)} /> : null);
  const can = data.canChange;
  const signers = u.signers ?? [];
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
          </Step>
          <Step n={2} title="Release signers" state={signers.length ? `${signers.length} listed` : 'none listed'} tone={signers.length ? 'ok' : u.channel === 'main' ? 'neutral' : 'warn'}>
            <p className="text-[12.5px] text-ink-2">
              On the release channel the updater installs only a release tag whose signature verifies against one of these public keys ({u.signersFile}). With none listed, it installs no release. This page can add a key. It can't remove or replace
              one, and it can't turn the check off: an admin edits the file at a root shell.
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
            {can && review?.plan.step !== 'signer' && (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end" data-testid="updater-signer-form">
                <label className="space-y-1 text-[11.5px] text-ink-3">
                  Principal (the signer's email)
                  <input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="release@example.com" autoComplete="off" spellCheck={false} className={field} data-testid="updater-signer-principal" />
                </label>
                <label className="space-y-1 text-[11.5px] text-ink-3">
                  Public key (the line of the .pub file)
                  <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5…" autoComplete="off" spellCheck={false} className={cx(field, 'font-mono')} data-testid="updater-signer-key" />
                </label>
                <Button size="sm" variant="outline" disabled={busy || !principal.trim() || !key.trim()} onClick={() => void ask({ step: 'signer', principal, key })} data-testid="updater-signer-review">
                  Review signer…
                </Button>
              </div>
            )}
            {open('signer')}
          </Step>
          <Step n={3} title="Channel" state={u.channel ?? 'not installed'} tone={u.channel ? 'ok' : 'neutral'}>
            <div className="space-y-1.5" role="radiogroup" aria-label="update channel">
              {u.channels.map((c) => (
                <label key={c.id} className="flex min-w-0 items-start gap-2 text-[12.5px] text-ink-2" data-testid="updater-channel" data-channel={c.id} data-current={u.channel === c.id}>
                  <input type="radio" name="updater-channel" className="mt-0.5" value={c.id} checked={channel === c.id} disabled={!can || !u.installed} onChange={() => setChannel(c.id)} />
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-ink">{c.id}</span>
                    {u.channel === c.id ? ' (now)' : ''}: {c.what}.
                  </span>
                </label>
              ))}
            </div>
            {can && u.installed && review?.plan.step !== 'channel' && (
              <Button size="sm" variant="outline" disabled={busy || channel === u.channel} onClick={() => void ask({ step: 'channel', channel })} data-testid="updater-channel-review">
                Review change…
              </Button>
            )}
            {!u.installed && <p className="text-[12px] text-ink-3">Install the updater first.</p>}
            {open('channel')}
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
        <code className={code}>{[u.script.install, u.script.signer, u.script.channel].join('\n')}</code>
      </div>
    </section>
  );
}

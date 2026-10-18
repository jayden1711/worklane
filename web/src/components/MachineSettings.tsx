// The machine-wide settings on the Settings page: the agent slot cap and whether the engine
// updates itself. They belong to the machine, not an instance: a change is recorded by this
// instance's own server and run by its coordinator, which runs the machine helper (sudo, one rule
// per coordinator; the dashboard itself can't sudo). The owner proposes, sees current and new, and
// confirms; the request shows as pending until the coordinator has run it. Below, the history:
// engine updates (installed, refused, rolled back) and every change the helper made.
import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { DotPill, RecordsTable } from './patterns';
import { UpdaterSetupView, type UpdaterData } from './UpdaterSetup';
import { ago, Button, Card, cx, Why, firstWhy } from './ui';

/** A machine change asked for from the dashboard, as the coordinator has handled it so far (src/machine-requests.ts). */
export interface MachineRequestRow {
  id: string;
  args: string[];
  by: string;
  at: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'refused' | 'interrupted';
  detail: string;
  finishedAt: string | null;
}

export interface MachineData {
  owner: string;
  user: string;
  canChange: boolean;
  /** The machine's owners: only they (or the break-glass) may change these; absent from older servers. */
  machineOwners?: string[];
  /** Whether this person is one of them; absent from older servers. */
  machineOwner?: boolean;
  /** What a change needs besides (an allowed device); absent from older servers. */
  needs?: string | null;
  /** Whether this page came from one of the console's allowed devices (the hub says); absent from older servers. */
  deviceReady?: boolean;
  /** Why this person can't ask for a change now (the check each change makes), null when they can; absent from older servers. */
  why?: string | null;
  helper: string;
  slots: { cap: number; running: number; min: number; max: number };
  /** The machine's test-run slot cap; absent from older servers. */
  testSlots?: { cap: number; running: number; min: number; max: number };
  updates: { configured: true; enabled: boolean; branch: string; requiredChecks: string[] } | { configured: false; enabled: null };
  /** The updater's setup (installed, channel, release signers), for the Updater setup steps; absent from older servers. */
  updater?: UpdaterData;
  changes: { at: string; by: string; what: string; from: unknown; to: unknown }[];
  history: { at: string; event: string; from?: string | null; to?: string | null; reason?: string; units?: string[]; failed?: string[]; back?: string }[];
  /** Changes asked for here, newest first; absent from older servers. */
  requests?: MachineRequestRow[];
}

const REQUEST_TONE: Record<MachineRequestRow['status'], 'green' | 'red' | 'orange' | 'ink'> = { pending: 'orange', running: 'orange', done: 'green', failed: 'red', refused: 'red', interrupted: 'red' };
const REQUEST_LABEL: Record<MachineRequestRow['status'], string> = { pending: 'waiting for the coordinator', running: 'running', done: 'done', failed: 'failed', refused: 'refused', interrupted: 'interrupted' };
export const anyPending = (d: MachineData) => (d.requests ?? []).some((r) => r.status === 'pending' || r.status === 'running');

const EVENT_TONE: Record<string, 'green' | 'red' | 'orange' | 'ink'> = { installed: 'green', rolled_back: 'red', build_failed: 'red', error: 'red', signers_changed: 'red', refused: 'orange', waiting: 'orange', attempt: 'ink', canary_passed: 'green', canary_failed: 'red', canary_filed: 'ink' };
const short = (s?: string | null) => (s ? s.slice(0, 8) : '–');
const val = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : v === null || v === undefined ? '–' : String(v));

/**
 * One setting's row. `readOnly`: this person can never change it (or there is nothing to change), so no input and no
 * button is drawn. `refusal`: why they can't now (the server's own check, MachineData.why), shown on the buttons.
 */
function ChangeRow({ label, testKey, current, bounds, input, proposed, onConfirm, readOnly, refusal }: { label: string; testKey: string; current: string; bounds: string; input: React.ReactNode; proposed: { value: unknown; text: string } | { error: string } | null; onConfirm: (v: unknown) => Promise<void>; readOnly: boolean; refusal: string | null }) {
  const [review, setReview] = useState<{ value: unknown; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const savingId = useId();
  return (
    <tr className="border-b border-line align-top last:border-0" data-testid="machine-setting-row" data-setting={testKey}>
      <td className="primitive-table-cell text-[13px] font-medium text-ink">{label}</td>
      <td className="primitive-table-cell text-[13px] tabular-nums text-ink" data-testid="machine-setting-current">
        {current}
      </td>
      <td className="primitive-table-cell">
        {readOnly ? (
          <span className="text-[12px] text-ink-3">{bounds}</span>
        ) : (
          <div className="space-y-1.5">
            {input}
            <div className="text-[11.5px] text-ink-3">{bounds}</div>
            {review ? (
              <div className="rounded-control bg-inset p-2 shadow-hairline" data-testid="machine-setting-review">
                <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-0.5 font-mono text-[12px]">
                  <span className="text-ink-3">current</span>
                  <span className="text-red line-through decoration-red/50">{current}</span>
                  <span className="text-ink-3">new</span>
                  <span className="text-green">{review.text}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    why={firstWhy(refusal, busy && 'Saving…')}
                    {...(busy && !refusal ? { whyAt: savingId } : {})}
                    data-testid="machine-setting-confirm"
                    onClick={async () => {
                      setBusy(true);
                      setMsg(null);
                      try {
                        await onConfirm(review.value);
                        setMsg({ ok: true, text: `requested ${review.text}: the coordinator applies it on its next tick (below)` });
                        setReview(null);
                      } catch (e) {
                        setMsg({ ok: false, text: (e as Error).message });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Confirm
                  </Button>
                  <Button size="sm" variant="ghost" why={busy && 'Saving…'} whyAt={savingId} onClick={() => setReview(null)} data-testid="machine-setting-cancel">
                    Cancel
                  </Button>
                  {busy && <Why id={savingId}>Saving…</Why>}
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" why={firstWhy(refusal, !proposed && 'Nothing to change', !!proposed && 'error' in proposed && `Not a valid value: ${proposed.error}`, !!proposed && 'text' in proposed && proposed.text === current && 'That is the value now: choose another')} onClick={() => proposed && 'value' in proposed && setReview(proposed)} data-testid="machine-setting-review-button">
                Review change
              </Button>
            )}
            {msg && (
              <div className={cx('text-[12px]', msg.ok ? 'text-green' : 'text-red')} data-testid="machine-setting-message">
                {msg.text}
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** The section from its data (also what the render checks render). */
export function MachineSettingsView({ data, onChanged = () => {} }: { data: MachineData; onChanged?: (d: MachineData) => void }) {
  // What the owner typed, kept across every refresh of the data (this view is never remounted for new data). Until
  // they type, and again after a confirmed change, each input shows what is set now, as the data says.
  type Drafts = { slots: string | null; updates: string | null; testSlots: string | null };
  const [drafts, setDrafts] = useState<Drafts>({ slots: null, updates: null, testSlots: null });
  const draft = (k: keyof Drafts) => (v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  const [setSlots, setUpdates, setTestSlots] = [draft('slots'), draft('updates'), draft('testSlots')];
  const slots = drafts.slots ?? String(data.slots.cap);
  const updates = drafts.updates ?? (data.updates.enabled === true ? 'on' : 'off');
  const testSlots = drafts.testSlots ?? String(data.testSlots?.cap ?? '');
  const tn = Number(testSlots);
  const ts = data.testSlots;
  const testSlotsProposed = !ts ? null : !testSlots.trim() || !Number.isInteger(tn) ? { error: 'a whole number' } : tn < ts.min || tn > ts.max ? { error: `${ts.min} to ${ts.max}` } : { value: tn, text: String(tn) };
  const n = Number(slots);
  const slotsProposed = !slots.trim() || !Number.isInteger(n) ? { error: 'a whole number' } : n < data.slots.min || n > data.slots.max ? { error: `${data.slots.min} to ${data.slots.max}` } : { value: n, text: String(n) };
  // The server's own reason (a device that isn't allowed), as a sentence on each button it holds.
  const refusal = data.canChange && data.why ? data.why[0]!.toUpperCase() + data.why.slice(1) : null;
  const send = (what: 'slots' | 'updates' | 'testSlots') => async (value: unknown) => {
    const r = await api<{ machine: MachineData }>('/api/machine', { method: 'POST', body: JSON.stringify({ what, value }) });
    // Confirmed: this input follows what is set again (the card's own choice, never a remount's).
    setDrafts((d) => ({ ...d, [what]: null }));
    onChanged(r.machine);
  };
  return (
    <section className="space-y-3" aria-label="Machine settings" data-testid="machine-settings">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Machine settings</span>
        <span className="text-[12px] text-ink-3">for every instance on this machine; changed through {data.helper}, which logs each change</span>
      </div>
      {!data.canChange && (
        <div className="rounded-control bg-inset px-2.5 py-2 text-[12.5px] text-ink-2 shadow-hairline" data-testid="machine-read-only">
          {data.machineOwners ? (
            <>
              Read-only: only the machine's owners can change these; you are @{data.user}.{' '}
              <span data-testid="machine-owners">machine owners: {data.machineOwners.length ? data.machineOwners.map((o) => `@${o}`).join(', ') : 'none set'}</span>
            </>
          ) : (
            <>
              Only the owner, @{data.owner}, can change these; you are @{data.user}.
            </>
          )}
        </div>
      )}
      {data.canChange && data.needs && (
        <div className="text-[12px] text-ink-3" data-testid="machine-needs" data-ready={data.deviceReady === undefined ? undefined : data.deviceReady ? 'yes' : 'no'}>
          {data.deviceReady === true ? `You may change these: this page came from ${data.needs}.` : data.deviceReady === false ? `A change needs ${data.needs}, and this page didn't come from one.` : `A change needs ${data.needs}.`}
        </div>
      )}
      <UpdaterSetupView data={data} onChanged={onChanged} />
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-inset">
              {['Setting', 'Now', data.canChange ? 'New value' : 'Bounds'].map((h) => (
                <th key={h} className="primitive-table-cell text-[11.5px] font-medium text-ink-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <ChangeRow
              label="Agent slots (machine-wide)"
              testKey="slots"
              current={String(data.slots.cap)}
              bounds={`${data.slots.min}–${data.slots.max}; ${data.slots.running} in use now`}
              readOnly={!data.canChange}
              refusal={refusal}
              proposed={slotsProposed}
              onConfirm={send('slots')}
              input={<input value={slots} onChange={(e) => setSlots(e.target.value)} aria-label="slot cap new value" className="h-7 w-24 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]" data-testid="machine-setting-input" />}
            />
            {ts ? (
              <ChangeRow
                label="Test-run slots (machine-wide)"
                testKey="testSlots"
                current={String(ts.cap)}
                bounds={`${ts.min}–${ts.max}; ${ts.running} running now; the recommendation for this machine is in docs/test-runs.md`}
                readOnly={!data.canChange}
                refusal={refusal}
                proposed={testSlotsProposed}
                onConfirm={send('testSlots')}
                input={<input value={testSlots} onChange={(e) => setTestSlots(e.target.value)} aria-label="test-run slot cap new value" className="h-7 w-24 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]" data-testid="machine-setting-input" />}
              />
            ) : null}
            <ChangeRow
              label="Engine updates"
              testKey="updates"
              current={data.updates.configured ? (data.updates.enabled ? 'on' : 'off') : 'not set up'}
              bounds={data.updates.configured ? `on: the updater installs green ${data.updates.branch} commits when the machine is quiet, and rolls back a failed one` : data.updater ? "the updater isn't set up on this machine: install it in Updater setup, above" : "the updater isn't set up on this machine (an admin runs its setup script)"}
              readOnly={!data.canChange || !data.updates.configured}
              refusal={refusal}
              proposed={{ value: updates === 'on', text: updates }}
              onConfirm={send('updates')}
              input={
                <div className="flex gap-1" role="group" aria-label="engine updates new value">
                  {['on', 'off'].map((o) => (
                    <button key={o} type="button" onClick={() => setUpdates(o)} className={cx('h-7 rounded-full px-3 text-[12.5px]', updates === o ? 'bg-ink text-surface' : 'text-ink-2 shadow-hairline hover:bg-hover-2')} data-testid="machine-setting-input">
                      {o}
                    </button>
                  ))}
                </div>
              }
            />
          </tbody>
        </table>
      </div>

      <section className="space-y-1.5" aria-label="Engine updates" data-testid="updates-history">
        <div className="text-[13px] font-medium text-ink">Engine updates</div>
        {data.history.length ? (
          <RecordsTable testId="updates-history-table" head={['When', 'What', 'From → to', 'Why']} className="[&_th:nth-child(1)]:w-28 [&_th:nth-child(2)]:w-32 [&_th:nth-child(3)]:w-44">
            {data.history.map((h, i) => (
              <tr key={i} className="border-b border-line last:border-0" data-testid="update-row" style={{ background: h.event === 'rolled_back' || h.event === 'build_failed' || h.event === 'error' || h.event === 'canary_failed' ? 'var(--red-tint)' : undefined }}>
                <td className="primitive-table-cell text-[12px] text-ink-3" title={h.at}>
                  {ago(h.at)}
                </td>
                <td className="primitive-table-cell">
                  <DotPill tone={EVENT_TONE[h.event] ?? 'ink'}>{h.event.replaceAll('_', ' ')}</DotPill>
                </td>
                <td className="primitive-table-cell font-mono text-[12px] text-ink-2">
                  {short(h.from)} → {short(h.to)}
                  {h.back ? <div className="font-sans text-[11.5px] text-ink-3">back to {short(h.back)}</div> : null}
                </td>
                <td className="primitive-table-cell text-[12px] text-ink-2">{[h.reason, h.failed?.length ? `failed: ${h.failed.join(', ')}` : '', h.units?.length ? `restarted: ${h.units.join(', ')}` : ''].filter(Boolean).join('; ') || '–'}</td>
              </tr>
            ))}
          </RecordsTable>
        ) : (
          <Card className="p-4 text-[13px] text-ink-3">{data.updates.configured ? 'No update attempts yet.' : "No updates: the updater isn't set up on this machine."}</Card>
        )}
      </section>

      {!!data.requests?.length && (
        <section className="space-y-1.5" aria-label="Requested changes" data-testid="machine-requests">
          <div className="text-[13px] font-medium text-ink">Requested here</div>
          <RecordsTable testId="machine-requests-table" head={['When', 'Who', 'Change', 'Status']} className="[&_th:nth-child(1)]:w-28 [&_th:nth-child(2)]:w-40">
            {data.requests.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0" data-testid="machine-request-row" data-status={r.status}>
                <td className="primitive-table-cell text-[12px] text-ink-3" title={r.at}>
                  {ago(r.at)}
                </td>
                <td className="primitive-table-cell text-[12.5px] text-ink">@{r.by}</td>
                <td className="primitive-table-cell font-mono text-[12px] text-ink-2">{r.args.join(' ')}</td>
                <td className="primitive-table-cell text-[12px] text-ink-2">
                  <DotPill tone={REQUEST_TONE[r.status]}>{REQUEST_LABEL[r.status]}</DotPill>
                  {r.detail && <div className="mt-1 break-words text-[11.5px] text-ink-3">{r.detail}</div>}
                </td>
              </tr>
            ))}
          </RecordsTable>
        </section>
      )}

      <section className="space-y-1.5" aria-label="Machine changes" data-testid="machine-changes">
        <div className="text-[13px] font-medium text-ink">Machine changes</div>
        {data.changes.length ? (
          <RecordsTable testId="machine-changes-table" head={['When', 'Who', 'What', 'From → to']} className="[&_th:nth-child(1)]:w-28 [&_th:nth-child(2)]:w-40">
            {data.changes.map((c, i) => (
              <tr key={i} className="border-b border-line last:border-0" data-testid="machine-change-row">
                <td className="primitive-table-cell text-[12px] text-ink-3" title={c.at}>
                  {ago(c.at)}
                </td>
                <td className="primitive-table-cell text-[12.5px] text-ink">{c.by}</td>
                <td className="primitive-table-cell text-[12.5px] text-ink-2">{c.what}</td>
                <td className="primitive-table-cell font-mono text-[12px] text-ink-2">
                  {val(c.from)} → {val(c.to)}
                </td>
              </tr>
            ))}
          </RecordsTable>
        ) : (
          <Card className="p-4 text-[13px] text-ink-3">No machine changes recorded.</Card>
        )}
      </section>
    </section>
  );
}

export function MachineSettings({ onLoaded }: { onLoaded?: () => void }) {
  const [data, setData] = useState<MachineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<MachineData>('/api/machine')
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message))
      .finally(() => onLoaded?.());
  useEffect(() => void load(), []);
  // While a request waits for the coordinator, look again every few seconds until it has run.
  const waiting = !!data && anyPending(data);
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [waiting]);
  if (error) return <div className="text-[13px] text-red" data-testid="machine-settings">Can't load the machine settings: {error}</div>;
  if (!data) return null;
  // Never keyed on the data: new data (a change logged, a request run) is new props, so what an owner typed, a
  // review they have open and a message they are reading all stay (test/machine-cards-keep-state.test.ts).
  return <MachineSettingsView data={data} onChanged={setData} />;
}



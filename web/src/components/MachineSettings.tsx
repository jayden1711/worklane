// The machine-wide settings on the Settings page: the agent slot cap and whether the engine
// updates itself. They belong to the machine, not an instance: a change goes through this
// instance's own server, which runs the machine helper as its user (sudo, one rule per
// coordinator). The owner proposes, sees current and new, and confirms. Below, the history:
// engine updates (installed, refused, rolled back) and every change the helper made.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { DotPill, RecordsTable } from './patterns';
import { ago, Button, Card, cx } from './ui';

export interface MachineData {
  owner: string;
  user: string;
  canChange: boolean;
  helper: string;
  slots: { cap: number; running: number; min: number; max: number };
  updates: { configured: true; enabled: boolean; branch: string; requiredChecks: string[] } | { configured: false; enabled: null };
  changes: { at: string; by: string; what: string; from: unknown; to: unknown }[];
  history: { at: string; event: string; from?: string | null; to?: string | null; reason?: string; units?: string[]; failed?: string[]; back?: string }[];
}

const EVENT_TONE: Record<string, 'green' | 'red' | 'orange' | 'ink'> = { installed: 'green', rolled_back: 'red', build_failed: 'red', error: 'red', refused: 'orange', waiting: 'orange', attempt: 'ink' };
const short = (s?: string | null) => (s ? s.slice(0, 8) : '–');
const val = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : v === null || v === undefined ? '–' : String(v));

function ChangeRow({ label, testKey, current, bounds, input, proposed, onConfirm, disabled }: { label: string; testKey: string; current: string; bounds: string; input: React.ReactNode; proposed: { value: unknown; text: string } | { error: string } | null; onConfirm: (v: unknown) => Promise<void>; disabled: boolean }) {
  const [review, setReview] = useState<{ value: unknown; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <tr className="border-b border-line align-top last:border-0" data-testid="machine-setting-row" data-setting={testKey}>
      <td className="primitive-table-cell text-[13px] font-medium text-ink">{label}</td>
      <td className="primitive-table-cell text-[13px] tabular-nums text-ink" data-testid="machine-setting-current">
        {current}
      </td>
      <td className="primitive-table-cell">
        {disabled ? (
          <span className="text-[12px] text-ink-3">{bounds}</span>
        ) : (
          <div className="space-y-1.5">
            {input}
            <div className="text-[11.5px] text-ink-3">{bounds}</div>
            {proposed && 'error' in proposed && <div className="text-[12px] text-red">{proposed.error}</div>}
            {review ? (
              <div className="rounded-control bg-inset p-2 shadow-hairline" data-testid="machine-setting-review">
                <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-0.5 font-mono text-[12px]">
                  <span className="text-ink-3">current</span>
                  <span className="text-red line-through decoration-red/50">{current}</span>
                  <span className="text-ink-3">new</span>
                  <span className="text-green">{review.text}</span>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="machine-setting-confirm"
                    onClick={async () => {
                      setBusy(true);
                      setMsg(null);
                      try {
                        await onConfirm(review.value);
                        setMsg({ ok: true, text: `changed to ${review.text}` });
                        setReview(null);
                      } catch (e) {
                        setMsg({ ok: false, text: (e as Error).message });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? 'Changing…' : 'Confirm'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)} data-testid="machine-setting-cancel">
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" disabled={!proposed || 'error' in proposed || proposed.text === current} onClick={() => proposed && 'value' in proposed && setReview(proposed)} data-testid="machine-setting-review-button">
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
  const [slots, setSlots] = useState(String(data.slots.cap));
  const [updates, setUpdates] = useState(data.updates.enabled === true ? 'on' : 'off');
  const n = Number(slots);
  const slotsProposed = !slots.trim() || !Number.isInteger(n) ? { error: 'a whole number' } : n < data.slots.min || n > data.slots.max ? { error: `${data.slots.min} to ${data.slots.max}` } : { value: n, text: String(n) };
  const send = (what: 'slots' | 'updates') => async (value: unknown) => {
    const r = await api<{ machine: MachineData }>('/api/machine', { method: 'POST', body: JSON.stringify({ what, value }) });
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
          Only the owner, @{data.owner}, can change these; you are @{data.user}.
        </div>
      )}
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
              disabled={!data.canChange}
              proposed={slotsProposed}
              onConfirm={send('slots')}
              input={<input value={slots} onChange={(e) => setSlots(e.target.value)} aria-label="slot cap new value" className="h-7 w-24 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]" data-testid="machine-setting-input" />}
            />
            <ChangeRow
              label="Engine updates"
              testKey="updates"
              current={data.updates.configured ? (data.updates.enabled ? 'on' : 'off') : 'not set up'}
              bounds={data.updates.configured ? `on: the updater installs green ${data.updates.branch} commits when the machine is quiet, and rolls back a failed one` : "the updater isn't set up on this machine (an admin runs its setup script)"}
              disabled={!data.canChange || !data.updates.configured}
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
              <tr key={i} className="border-b border-line last:border-0" data-testid="update-row" style={{ background: h.event === 'rolled_back' || h.event === 'build_failed' || h.event === 'error' ? 'var(--red-tint)' : undefined }}>
                <td className="primitive-table-cell text-[12px] text-ink-3" title={h.at}>
                  {ago(h.at)}
                </td>
                <td className="primitive-table-cell">
                  <DotPill tone={EVENT_TONE[h.event] ?? 'ink'}>{h.event.replace('_', ' ')}</DotPill>
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

export function MachineSettings() {
  const [data, setData] = useState<MachineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<MachineData>('/api/machine')
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="text-[13px] text-red" data-testid="machine-settings">Can't load the machine settings: {error}</div>;
  if (!data) return null;
  return <MachineSettingsView key={JSON.stringify([data.slots.cap, data.updates.enabled, data.changes.length])} data={data} onChanged={setData} />;
}



// WHY: a server instance's policy (audit row 16) as form fields with their bounds. Review asks the server what the
// values would change (nothing written); Confirm writes exactly that. Isolation keys are shown, never edited here.
import { useState } from 'react';
import { changePolicy, type FirstRunPolicy, type PolicyChange } from '../api';
import { Button, cx } from './ui';

const field = 'h-8 rounded-control bg-field px-2.5 font-mono text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)] disabled:opacity-60';
const show = (v: unknown) => (v === null || v === undefined ? 'not set' : Array.isArray(v) ? v.join(', ') || 'none' : String(v));

/** auto_merge off, asked of the coordinator (root's helper writes the kill switch), when the form itself can't load. */
function OffAnyway() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const off = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await changePolicy({ auto_merge: false }, true);
      setMsg({ ok: true, text: `${r.queued ? 'queued for the coordinator' : 'written'}: auto_merge off` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" why={busy && 'Asking…'} onClick={() => void off()} data-testid="policy-off">
        Turn auto-merge off
      </Button>
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="policy-off-result">
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function PolicyForm({ p, canEdit, initialChanges = null, onDone }: { p: FirstRunPolicy; canEdit: boolean; initialChanges?: PolicyChange[] | null; onDone?: () => void }) {
  const [values, setValues] = useState<Record<string, number | boolean | string>>(() => Object.fromEntries(p.fields.map((f) => [f.key, f.value])));
  const [changes, setChanges] = useState<PolicyChange[] | null>(initialChanges);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (p.error)
    return (
      <div className="space-y-2">
        <p className="break-words text-[12.5px] text-red" data-testid="policy-error">
          {p.error}
        </p>
        {/* Turning auto_merge off works whatever is wrong with the file: root's kill switch never reads it (#726). */}
        {p.canTurnOff && canEdit && <OffAnyway />}
      </div>
    );
  const set = (k: string, v: number | boolean | string) => {
    setValues({ ...values, [k]: v });
    setChanges(null);
    setMsg(null);
  };
  const send = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await changePolicy(values, confirm);
      if (confirm) {
        setChanges(null);
        // A root policy.yaml: only asked of the coordinator, which has root's helper write it.
        setMsg({ ok: true, text: `${r.queued ? 'queued for the coordinator' : 'written'}: ${r.changes.map((c) => `${c.key} ${show(c.from)} → ${show(c.to)}`).join('; ')}` });
        onDone?.();
      } else setChanges(r.changes);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="policy-form">
      <ul className="space-y-2.5">
        {p.fields.map((f) => {
          // f.only (a root policy, and auto_merge on every install): only toward its one value here, so at that value
          // already nothing can change.
          const locked = f.only !== undefined && f.value === f.only;
          const choices = f.only !== undefined ? [...new Set([String(f.value), String(f.only)])] : f.choices!;
          return (
            <li key={f.key} className="space-y-1" data-testid="policy-field" data-key={f.key}>
              <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
                <code className="font-mono text-[12px]">{f.key}</code>
                {f.kind === 'number' && (
                  <input type="number" min={f.min} max={f.max} step={f.step} value={String(values[f.key])} disabled={!canEdit || busy} onChange={(e) => set(f.key, Number(e.target.value))} className={cx(field, 'w-24')} aria-label={f.key} />
                )}
                {f.kind === 'boolean' && <input type="checkbox" checked={values[f.key] === true} disabled={!canEdit || busy || locked} onChange={(e) => set(f.key, e.target.checked)} aria-label={f.key} />}
                {f.kind === 'choice' && (
                  <select value={String(values[f.key])} disabled={!canEdit || busy || locked} onChange={(e) => set(f.key, e.target.value)} className={cx(field, 'w-28')} aria-label={f.key}>
                    {choices.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
                {f.kind === 'number' && <span className="text-[11.5px] text-ink-3">{f.min}–{f.max}</span>}
              </label>
              <p className="text-[12px] text-ink-3">{f.why}</p>
              {f.root && (
                <p className="break-words text-[12px] text-ink-3" data-testid="policy-root-only">
                  Here only {show(f.only)}; anything else is an admin's: <code className="font-mono text-[11.5px]">{f.root}</code>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="break-words text-[12px] text-ink-3" data-testid="policy-fixed">
        Not changed here (isolation; set at a root shell): {p.fixed.map((x) => `${x.key} ${show(x.value)}`).join(' · ')}
      </p>
      {!canEdit ? (
        <p className="text-[12.5px] text-ink-3" data-testid="policy-refused">
          Only the instance's owners can change its policy.
        </p>
      ) : !changes ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void send(false)} data-testid="policy-review">
          Review the change
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="policy-confirming">
          <ul className="space-y-0.5 text-[12.5px] text-ink">
            {changes.map((c) => (
              <li key={c.key} className="font-mono text-[12px]" data-testid="policy-change">
                {c.key}: {show(c.from)} → {show(c.to)}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void send(true)} data-testid="policy-confirm">
              {busy ? 'Writing…' : 'Confirm'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanges(null)} data-testid="policy-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="policy-result">
          {msg.text}
        </p>
      )}
    </div>
  );
}

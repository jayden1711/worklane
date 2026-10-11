// The instance's own settings on the Settings page: workers, daily budget, CI fix
// runs and run windows. Each shows the value in effect, where it comes from, and the
// bounds a new value must keep. The owner proposes a value, sees the current and the
// new one side by side, and confirms with a second click; the instance's own server
// writes it (changeSetting) and records settings.changed. Everyone else reads only.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Button, Card, cx } from './ui';

export interface InstanceSettingsData {
  owner: string;
  user: string;
  canChange: boolean;
  keys: string[];
  available: boolean;
  why?: string;
  limits?: { workers: { min: number; max: number }; daily_budget_usd: { max: number }; max_fixes_per_pr: { max: number } } | null;
  limitsError?: string | null;
  ceilings?: { max_workers: number; daily_usd: number };
  settings?: { key: string; value: unknown; source: 'instance' | 'repo' }[];
}

type Windows = { from: string; to: string }[];

const LABEL: Record<string, string> = {
  workers: 'Workers at once',
  daily_budget_usd: 'Daily budget (estimated, USD)',
  'ci_repair.enabled': 'CI fix runs',
  'ci_repair.max_fixes_per_pr': 'CI fix runs per PR',
  run_windows: 'Run windows',
};

export const showValue = (key: string, v: unknown): string => {
  if (key === 'ci_repair.enabled') return v ? 'on' : 'off';
  if (key === 'run_windows') return Array.isArray(v) && v.length ? (v as Windows).map((w) => `${w.from}-${w.to}`).join(', ') : 'any time';
  if (key === 'daily_budget_usd') return `$${v}`;
  return String(v);
};

/** The bounds a new value must keep, in words. */
export function boundsOf(key: string, d: InstanceSettingsData): string {
  const l = d.limits;
  const c = d.ceilings;
  if (!l || !c) return '';
  switch (key) {
    case 'workers':
      return `${l.workers.min}–${Math.min(l.workers.max, c.max_workers)} (machine ${l.workers.min}–${l.workers.max}, policy max ${c.max_workers})`;
    case 'daily_budget_usd':
      return `up to $${Math.min(l.daily_budget_usd.max, c.daily_usd)} (machine $${l.daily_budget_usd.max}, policy $${c.daily_usd})`;
    case 'ci_repair.max_fixes_per_pr':
      return `0–${l.max_fixes_per_pr.max} (machine limit)`;
    case 'run_windows':
      return 'HH:MM-HH:MM, comma-separated; empty for any time';
    default:
      return 'on or off';
  }
}

/** A typed value from what was entered, or why it can't be one. */
export function parseEntry(key: string, raw: string): { value: unknown } | { error: string } {
  const t = raw.trim();
  if (key === 'ci_repair.enabled') return t === 'on' ? { value: true } : t === 'off' ? { value: false } : { error: 'on or off' };
  if (key === 'run_windows') {
    if (!t) return { value: [] };
    const out: Windows = [];
    for (const part of t.split(',')) {
      const m = part.trim().match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
      if (!m) return { error: `"${part.trim()}" isn't HH:MM-HH:MM` };
      out.push({ from: m[1]!, to: m[2]! });
    }
    return { value: out };
  }
  const n = Number(t);
  if (!t || !Number.isFinite(n)) return { error: 'a number' };
  if (key !== 'daily_budget_usd' && !Number.isInteger(n)) return { error: 'a whole number' };
  return { value: n };
}

const entryOf = (key: string, v: unknown) => (key === 'ci_repair.enabled' ? (v ? 'on' : 'off') : key === 'run_windows' ? (Array.isArray(v) ? (v as Windows).map((w) => `${w.from}-${w.to}`).join(', ') : '') : String(v));

function SettingRow({ s, d, onChanged, proposed }: { s: { key: string; value: unknown; source: 'instance' | 'repo' }; d: InstanceSettingsData; onChanged: () => void; proposed?: { value: unknown } }) {
  const [entry, setEntry] = useState(entryOf(s.key, proposed ? proposed.value : s.value));
  const [review, setReview] = useState<{ value: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const parsed = parseEntry(s.key, entry);
  const same = 'value' in parsed && JSON.stringify(parsed.value) === JSON.stringify(s.value);
  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ from: unknown; to: unknown }>('/api/instance-settings', { method: 'POST', body: JSON.stringify({ key: s.key, value: review.value }) });
      setMsg({ ok: true, text: `changed: ${showValue(s.key, r.from)} → ${showValue(s.key, r.to)}` });
      setReview(null);
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className={cx('border-b border-line align-top last:border-0', proposed && 'bg-blue-tint')} data-testid="setting-row" data-setting={s.key} {...(proposed ? { 'data-proposed': '' } : {})}>
      <td className="primitive-table-cell">
        <div className="text-[13px] font-medium text-ink">{LABEL[s.key] ?? s.key}</div>
        <div className="font-mono text-[11.5px] text-ink-3">{s.key}</div>
      </td>
      <td className="primitive-table-cell">
        <div className="text-[13px] tabular-nums text-ink" data-testid="setting-current">
          {showValue(s.key, s.value)}
        </div>
        <div className="mt-0.5">
          <Badge tone={s.source === 'instance' ? 'info' : 'neutral'}>{s.source === 'instance' ? "this instance's" : "the repo's default"}</Badge>
        </div>
      </td>
      <td className="primitive-table-cell">
        {d.canChange ? (
          <div className="space-y-1.5">
            {s.key === 'ci_repair.enabled' ? (
              <div className="flex gap-1" role="group" aria-label={`${s.key} new value`}>
                {['on', 'off'].map((o) => (
                  <button key={o} type="button" onClick={() => (setEntry(o), setReview(null))} className={cx('h-7 rounded-full px-3 text-[12.5px]', entry === o ? 'bg-ink text-surface' : 'text-ink-2 shadow-hairline hover:bg-hover-2')} data-testid="setting-input">
                    {o}
                  </button>
                ))}
              </div>
            ) : (
              <input value={entry} onChange={(e) => (setEntry(e.target.value), setReview(null))} aria-label={`${s.key} new value`} className="h-7 w-full rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]" data-testid="setting-input" />
            )}
            <div className="text-[11.5px] text-ink-3" data-testid="setting-bounds">
              {boundsOf(s.key, d)}
            </div>
            {'error' in parsed && <div className="text-[12px] text-red">{parsed.error}</div>}
            {review ? (
              <div className="rounded-control bg-inset p-2 shadow-hairline" data-testid="setting-review">
                <div className="grid grid-cols-[56px_1fr] gap-x-2 gap-y-0.5 font-mono text-[12px]">
                  <span className="text-ink-3">current</span>
                  <span className="text-red line-through decoration-red/50">{showValue(s.key, s.value)}</span>
                  <span className="text-ink-3">new</span>
                  <span className="text-green">{showValue(s.key, review.value)}</span>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Button size="sm" disabled={busy} onClick={() => void confirm()} data-testid="setting-confirm">
                    {busy ? 'Changing…' : 'Confirm'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)} data-testid="setting-cancel">
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" disabled={'error' in parsed || same} onClick={() => 'value' in parsed && setReview(parsed)} data-testid="setting-review-button">
                Review change
              </Button>
            )}
            {msg && (
              <div className={cx('text-[12px]', msg.ok ? 'text-green' : 'text-red')} data-testid="setting-message">
                {msg.text}
              </div>
            )}
          </div>
        ) : (
          <span className="text-[12px] text-ink-3">{boundsOf(s.key, d)}</span>
        )}
      </td>
    </tr>
  );
}

/** The section from its data (also what the render checks render). */
export function InstanceSettingsView({ data, onChanged = () => {}, proposed }: { data: InstanceSettingsData; onChanged?: () => void; proposed?: { key: string; value: unknown } | null }) {
  if (!data.available) {
    return (
      <Card className="p-4 text-[13px] text-ink-3" data-testid="instance-settings">
        <div className="font-medium text-ink">Instance settings</div>
        <div className="mt-1">{data.why}</div>
      </Card>
    );
  }
  return (
    <section className="space-y-2" aria-label="Instance settings" data-testid="instance-settings">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Instance settings</span>
        <span className="text-[12px] text-ink-3">this instance's policy wins over the repo's defaults; each change is recorded on Activity</span>
      </div>
      {proposed && data.canChange && (data.settings ?? []).some((s) => s.key === proposed.key) && (
        <div className="rounded-control bg-blue-tint px-2.5 py-2 text-[12.5px] text-ink-2" data-testid="setting-proposed">
          The chat proposed {proposed.key} = {showValue(proposed.key, proposed.value)}; it's filled in below. Review it and confirm to change it, or leave it.
        </div>
      )}
      {!data.canChange && (
        <div className="rounded-control bg-inset px-2.5 py-2 text-[12.5px] text-ink-2 shadow-hairline" data-testid="settings-read-only">
          {data.limitsError ? `Changes are off: ${data.limitsError}` : `Only the owner, @${data.owner}, can change these; you are @${data.user}.`}
        </div>
      )}
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-inset">
              {['Setting', 'In effect', data.canChange ? 'New value' : 'Bounds'].map((h) => (
                <th key={h} className="primitive-table-cell text-[11.5px] font-medium text-ink-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data.settings ?? []).map((s) => (
              <SettingRow key={`${s.key}:${JSON.stringify(s.value)}`} s={s} d={data} onChanged={onChanged} {...(data.canChange && proposed?.key === s.key ? { proposed } : {})} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A change the chat proposed, from the page's address (`?set=<key>&to=<JSON value>`); null when none or unreadable. */
export function proposedSetting(search: string): { key: string; value: unknown } | null {
  const q = new URLSearchParams(search);
  const key = q.get('set');
  const to = q.get('to');
  if (!key || to === null) return null;
  try {
    return { key, value: JSON.parse(to) as unknown };
  } catch {
    return null;
  }
}

export function InstanceSettings() {
  const [data, setData] = useState<InstanceSettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    api<InstanceSettingsData>('/api/instance-settings')
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, [n]);
  if (error) return <div className="text-[13px] text-red" data-testid="instance-settings">Can't load the instance settings: {error}</div>;
  if (!data) return null;
  return <InstanceSettingsView data={data} onChanged={() => setN((x) => x + 1)} proposed={n === 0 ? proposedSetting(window.location.search) : null} />;
}

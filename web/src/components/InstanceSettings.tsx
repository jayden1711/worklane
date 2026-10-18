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
  limits?: { workers: { min: number; max: number }; daily_budget_usd: { max: number }; max_fixes_per_pr: { max: number }; research?: { max_searches_per_day: number; max_fetches_per_day: number; max_usd_per_day: number }; intake?: { reports_per_sender_per_day: number; drafts_per_day: number; max_usd_per_day: number } } | null;
  limitsError?: string | null;
  ceilings?: { max_workers: number; daily_usd: number };
  settings?: { key: string; value: unknown; source: Source }[];
}

type Windows = { from: string; to: string }[];
/** Where a value in effect comes from: the instance's policy, the repo's config, or the engine's own default. */
export type Source = 'instance' | 'repo' | 'engine';
export const SOURCE_LABEL: Record<Source, string> = { instance: "this instance's", repo: "the repo's default", engine: 'engine default' };

/** A readable name for each setting key the server sends (a test checks every key has one). */
export const LABEL: Record<string, string> = {
  workers: 'Workers at once',
  daily_budget_usd: 'Daily budget (estimated, USD)',
  'ci_repair.enabled': 'CI fix runs',
  'ci_repair.max_fixes_per_pr': 'CI fix runs per PR',
  run_windows: 'Run windows',
  'research.max_searches_per_day': 'Research searches per day',
  'research.max_fetches_per_day': 'Research page fetches per day',
  'research.max_usd_per_day': 'Research spend per day (estimated, USD)',
  'research.repo_access': 'Research runs may read the repo',
  'intake.reports_per_sender_per_day': 'Reports per sender per day',
  'intake.drafts_per_day': 'Intake drafts per day',
  'intake.max_usd_per_day': 'Intake spend per day (estimated, USD)',
  stuck_guard: 'Stuck-run guard',
  'chat_attachments.max_file_mb': 'Chat attachment size per file (MB)',
  'chat_attachments.max_message_mb': 'Chat attachments per question (MB)',
  'chat_attachments.retention_days': 'Days chat attachments are kept',
};

/** Settings picked from a fixed list of words. */
const CHOICES: Record<string, string[]> = { stuck_guard: ['off', 'dry-run', 'on'] };

/** On/off settings: picked from two buttons, never typed. */
const SWITCHES = new Set(['ci_repair.enabled', 'research.repo_access']);
/** Amounts of (estimated) money: shown with $, and may have cents. */
const MONEY = new Set(['daily_budget_usd', 'research.max_usd_per_day', 'intake.max_usd_per_day']);

export const showValue = (key: string, v: unknown): string => {
  if (SWITCHES.has(key)) return v ? 'on' : 'off';
  if (key === 'run_windows') return Array.isArray(v) && v.length ? (v as Windows).map((w) => `${w.from}-${w.to}`).join(', ') : 'any time';
  if (MONEY.has(key)) return `$${v}`;
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
    case 'research.max_searches_per_day':
    case 'research.max_fetches_per_day':
      return l.research ? `0–${l.research[key.slice('research.'.length) as 'max_searches_per_day' | 'max_fetches_per_day']} (machine limit)` : '';
    case 'research.max_usd_per_day':
      return l.research ? `up to $${l.research.max_usd_per_day} (machine limit)` : '';
    case 'research.repo_access':
      return 'on or off; off keeps research runs to the web';
    case 'stuck_guard':
      return 'off, dry-run (only logs what it would stop) or on (stops a run after 8 identical failed calls)';
    case 'intake.reports_per_sender_per_day':
    case 'intake.drafts_per_day':
      return l.intake ? `1–${l.intake[key.slice('intake.'.length) as 'reports_per_sender_per_day' | 'drafts_per_day']} (machine limit)` : '';
    case 'intake.max_usd_per_day':
      return l.intake ? `up to $${l.intake.max_usd_per_day} (machine limit)` : '';
    case 'chat_attachments.max_file_mb':
      return 'up to 100 MB; no more than the per-question size';
    case 'chat_attachments.max_message_mb':
      return 'up to 250 MB; at least the per-file size';
    case 'chat_attachments.retention_days':
      return '1–365 days; older attachments are deleted';
    default:
      return SWITCHES.has(key) ? 'on or off' : '';
  }
}

/** A typed value from what was entered, or why it can't be one. */
export function parseEntry(key: string, raw: string): { value: unknown } | { error: string } {
  const t = raw.trim();
  if (SWITCHES.has(key)) return t === 'on' ? { value: true } : t === 'off' ? { value: false } : { error: 'on or off' };
  const choices = CHOICES[key];
  if (choices) return choices.includes(t) ? { value: t } : { error: choices.join(', ') };
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
  if (!MONEY.has(key) && !Number.isInteger(n)) return { error: 'a whole number' };
  return { value: n };
}

const entryOf = (key: string, v: unknown) => (SWITCHES.has(key) ? (v ? 'on' : 'off') : key === 'run_windows' ? (Array.isArray(v) ? (v as Windows).map((w) => `${w.from}-${w.to}`).join(', ') : '') : String(v));

function SettingRow({ s, d, onChanged, proposed }: { s: { key: string; value: unknown; source: Source }; d: InstanceSettingsData; onChanged: () => void; proposed?: { value: unknown } }) {
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
          <Badge tone={s.source === 'instance' ? 'info' : 'neutral'}>{SOURCE_LABEL[s.source] ?? s.source}</Badge>
        </div>
      </td>
      <td className="primitive-table-cell">
        {d.canChange ? (
          <div className="space-y-1.5">
            {SWITCHES.has(s.key) ? (
              <div className="flex gap-1" role="group" aria-label={`${s.key} new value`}>
                {['on', 'off'].map((o) => (
                  <button key={o} type="button" onClick={() => (setEntry(o), setReview(null))} className={cx('h-7 rounded-full px-3 text-[12.5px]', entry === o ? 'bg-ink text-surface' : 'text-ink-2 shadow-hairline hover:bg-hover-2')} data-testid="setting-input">
                    {o}
                  </button>
                ))}
              </div>
            ) : (
              <input value={entry} onChange={(e) => (setEntry(e.target.value), setReview(null))} aria-label={`${s.key} new value`} className="h-7 w-full rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)]" data-testid="setting-input" />
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
        <span className="text-[12px] text-ink-3">this instance's policy wins over the repo's config, which wins over the engine's defaults; each change is recorded on Activity</span>
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

/** `onLoaded`: called once its first answer (the data, or an error it shows) is in, for the page's in-order panels. */
export function InstanceSettings({ onLoaded }: { onLoaded?: () => void } = {}) {
  const [data, setData] = useState<InstanceSettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    api<InstanceSettingsData>('/api/instance-settings')
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, [n]);
  useEffect(() => {
    if (data || error !== null) onLoaded?.();
  }, [data, error, onLoaded]);
  if (error) return <div className="text-[13px] text-red" data-testid="instance-settings">Can't load the instance settings: {error}</div>;
  if (!data) return null;
  return <InstanceSettingsView data={data} onChanged={() => setN((x) => x + 1)} proposed={n === 0 ? proposedSetting(window.location.search) : null} />;
}

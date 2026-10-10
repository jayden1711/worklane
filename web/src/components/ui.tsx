// Small component set: shadcn/ui's API shape (MIT), styled after Beautiful UI's atoms (MIT,
// beautifului.dev). Both credited in THIRD_PARTY_NOTICES.md.
import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import type { TaskStatus } from '../api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** Pill actions: a dark primary, a raised secondary (outline), a quiet ghost, a red danger. */
export function Button({ variant = 'default', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 px-3 text-[12.5px]' : 'h-8 px-3.5 text-[13px]',
        variant === 'default' && 'bg-ink text-surface hover:opacity-90',
        variant === 'outline' && 'bg-surface text-ink shadow-btn hover:bg-hover',
        variant === 'ghost' && 'text-ink-2 hover:bg-hover-2 hover:text-ink',
        variant === 'danger' && 'bg-red-tint text-red hover:bg-red hover:text-white',
        className,
      )}
    />
  );
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cx('rounded-card bg-surface shadow-card', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-[5px] bg-inset px-1 font-mono text-[10px] text-ink-3 shadow-hairline">{children}</kbd>;
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-inset text-ink-2 shadow-hairline',
    ok: 'bg-green-tint text-green',
    warn: 'bg-orange-tint text-orange',
    danger: 'bg-red-tint text-red',
    info: 'bg-blue-tint text-blue-ink',
  };
  // Beautiful UI's status pill: rounded, tinted, 11.5px.
  return <span className={cx('inline-flex h-5.5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Avatar({ login, title, size = 20 }: { login: string | null | undefined; title?: string; size?: number }) {
  if (!login) return <span className="inline-block rounded-full border border-dashed" style={{ width: size, height: size }} title="unassigned" />;
  const isAgent = login.includes('@') || ['worker', 'evaluator', 'investigator'].some((r) => login.startsWith(r));
  if (isAgent) {
    return (
      <span title={title ?? login} className="inline-flex items-center justify-center rounded-[7px] bg-ink font-mono text-[9px] font-semibold text-surface" style={{ width: size, height: size }}>
        AI
      </span>
    );
  }
  return <PersonAvatar login={login} title={title} size={size} />;
}

function PersonAvatar({ login, title, size }: { login: string; title: string | undefined; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span title={title ?? `@${login}`} className="inline-flex items-center justify-center rounded-full bg-muted font-medium uppercase text-muted-foreground" style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42) }}>
        {login.replace(/[^a-z0-9]/gi, '').slice(0, 2)}
      </span>
    );
  }
  return <img src={`https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`} alt={login} title={title ?? `@${login}`} width={size} height={size} className="rounded-full bg-muted" onError={() => setFailed(true)} />;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  triage: 'Triage',
  ready: 'Ready',
  claimed: 'Claimed',
  reproducing: 'Reproducing',
  building: 'Building',
  verifying: 'Verifying',
  evaluating: 'Evaluating',
  awaiting_decision: 'Needs decision',
  queued: 'Queued to land',
  landed: 'Landed',
  done: 'Done',
  blocked: 'Blocked',
  released: 'Released',
};

const STATUS_TONE: Record<TaskStatus, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  triage: 'neutral',
  ready: 'neutral',
  claimed: 'info',
  reproducing: 'info',
  building: 'info',
  verifying: 'info',
  evaluating: 'info',
  awaiting_decision: 'warn',
  queued: 'info',
  landed: 'ok',
  done: 'ok',
  blocked: 'danger',
  released: 'neutral',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function LevelBadge({ level }: { level: string | null }) {
  if (!level) return <span className="text-xs text-muted-foreground">-</span>;
  const tone = level === 'L3' ? 'danger' : level === 'L2' ? 'warn' : level === 'L1' ? 'info' : 'neutral';
  return <Badge tone={tone}>{level}</Badge>;
}

export function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** What every cost figure is: the agent CLI's own estimate of a run's cost, not money billed. */
export const EST_NOTE = "estimated: the agent CLI's own per-run cost estimate, not money billed";
/** A cost estimate, marked as one. */
export const estUsd = (n: number) => `~${usd(n)}`;

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-card bg-inset p-10 text-center shadow-hairline">
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {hint && <div className="max-w-sm text-[12.5px] text-ink-3">{hint}</div>}
    </div>
  );
}

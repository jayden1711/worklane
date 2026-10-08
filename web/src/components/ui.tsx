// Small component set in the style of shadcn/ui (MIT; credited in THIRD_PARTY_NOTICES.md).
import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import type { TaskStatus } from '../api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ variant = 'default', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        variant === 'default' && 'bg-primary text-primary-foreground hover:opacity-90',
        variant === 'outline' && 'border bg-background hover:bg-accent',
        variant === 'ghost' && 'hover:bg-accent',
        variant === 'danger' && 'border border-danger/40 text-danger hover:bg-danger/10',
        className,
      )}
    />
  );
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cx('rounded-lg border bg-card', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{children}</kbd>;
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-muted text-muted-foreground',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/20 text-foreground',
    danger: 'bg-danger/15 text-danger',
    info: 'bg-info/15 text-info',
  };
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Avatar({ login, title, size = 20 }: { login: string | null | undefined; title?: string; size?: number }) {
  if (!login) return <span className="inline-block rounded-full border border-dashed" style={{ width: size, height: size }} title="unassigned" />;
  const isAgent = login.includes('@') || ['worker', 'evaluator', 'investigator'].some((r) => login.startsWith(r));
  if (isAgent) {
    return (
      <span title={title ?? login} className="inline-flex items-center justify-center rounded-md bg-info/15 font-mono text-[9px] font-semibold text-info" style={{ width: size, height: size }}>
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

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="max-w-sm text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

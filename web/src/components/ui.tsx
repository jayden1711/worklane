// Small component set: shadcn/ui's API shape (MIT), styled after Beautiful UI's atoms (MIT,
// beautifului.dev). Both credited in THIRD_PARTY_NOTICES.md.
import { createContext, useContext, useEffect, useId, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { avatarSrc, type TaskStatus } from '../api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** The first reason that holds, else null: a button's `why`, from its checks in order. */
export const firstWhy =(...reasons: (string | null | false | undefined)[]): string | null => reasons.find((r): r is string => !!r) ?? null;

/** Why a button can't be pressed now, one line next to it (under it on a phone); a button's aria-describedby names it. */
export function Why({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="text-[12px] text-ink-3 max-sm:basis-full" data-testid="button-why">
      {children}
    </span>
  );
}

/**
 * What an action that starts or lands work says while the instance it acts on is paused on the Claude usage limit.
 * The owner's decision on #587: nothing new is refused while paused (switching the Claude account is how a usage
 * pause is fixed, so machine and account writes stay allowed); the action stays usable and says when it takes effect.
 */
export const PAUSED_HINT = 'paused: this takes effect when the instance resumes';
/** Whether the instance this page acts on is paused on the Claude usage limit (App provides it, from /api/usage). */
export const InstancePaused = createContext(false);

/**
 * Pill actions: a dark primary, a raised secondary (outline), a quiet ghost, a red danger.
 * `why`: the reason it can't be pressed now; set, the button is disabled and says so (its own line, or the `whyAt`
 * element's when one line already says it for a row of buttons). A bare `disabled` is silent: test/web-buttons.test.ts
 * holds every one to a list that only shrinks (#587).
 * `starts`: the action starts or lands work. While the instance is paused it stays usable and says PAUSED_HINT
 * beside it, as its description (a `why` that holds says that instead). An emergency stop is no pause here: it is
 * shown on every page and halts the coordinator itself.
 */
export function Button({ variant = 'default', size = 'md', className, why, whyAt, starts, disabled, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; size?: 'sm' | 'md'; why?: string | null | false; whyAt?: string; starts?: boolean }) {
  const own = useId();
  const paused = useContext(InstancePaused);
  const reason = why || null;
  const hint = !reason && starts && paused ? PAUSED_HINT : null;
  const button = (
    <button
      disabled={disabled || !!reason}
      aria-describedby={reason ? (whyAt ?? own) : hint ? own : undefined}
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
  if (hint)
    return (
      <>
        {button}
        <span id={own} className="text-[12px] text-ink-3 max-sm:basis-full" data-testid="button-paused">
          {hint}
        </span>
      </>
    );
  if (!reason || whyAt) return button;
  return (
    <>
      {button}
      <Why id={own}>{reason}</Why>
    </>
  );
}

/**
 * A value shown, not an action: flat, square-cornered, no ring, no hover (a button is a pill with a ring), so a chip
 * next to the buttons never reads as one (#587).
 */
export const CHIP = 'inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] font-medium';

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cx('rounded-card bg-surface shadow-card', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-[5px] bg-inset px-1 font-mono text-[10px] text-ink-3 shadow-hairline">{children}</kbd>;
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-inset text-ink-2',
    ok: 'bg-green-tint text-green',
    warn: 'bg-orange-tint text-orange',
    danger: 'bg-red-tint text-red',
    info: 'bg-blue-tint text-blue-ink',
  };
  // A status chip: tinted, 11.5px, never pill-shaped (that is a button's).
  return (
    <span className={cx(CHIP, 'h-5 px-1.5 text-[11.5px]', tones[tone], className)} data-role="chip">
      {children}
    </span>
  );
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

/**
 * A person's picture, in a box of exactly `size` whatever the picture does: loading, loaded at any shape, or failed.
 * WHY (#452): the bare <img> took its height from the page's `img { height: auto }`, so once GitHub's picture failed
 * the broken image grew to its alt text's height (18 px to 52 px) until the initials replaced it; every decision card
 * grew 30 px for that moment, and a click aimed at a card below landed 60 px off.
 * The picture is this server's (#462): the box stays empty while it is asked, and shows initials when there is none.
 */
function PersonAvatar({ login, title, size }: { login: string; title: string | undefined; size: number }) {
  // The picture comes from this page's own server (#462), never GitHub: undefined while asked, null when there is none.
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    setBroken(false);
    void avatarSrc(login, size).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [login, size]);
  const failed = src === null || broken;
  return (
    <span
      title={title ?? `@${login}`}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium uppercase text-muted-foreground"
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42) }}
      data-avatar={login}
    >
      {failed ? (
        login.replace(/[^a-z0-9]/gi, '').slice(0, 2)
      ) : src ? (
        <img src={src} alt={login} width={size} height={size} className="block max-w-none rounded-full" style={{ width: size, height: size }} onError={() => setBroken(true)} />
      ) : null}
    </span>
  );
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
  in_review: 'In review (PR open)',
  landed: 'Landed',
  done: 'Done',
  blocked: 'Blocked',
  released: 'Released',
};

export const STATUS_TONE: Record<TaskStatus, 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = {
  triage: 'neutral',
  ready: 'neutral',
  claimed: 'info',
  reproducing: 'info',
  building: 'info',
  verifying: 'info',
  evaluating: 'info',
  awaiting_decision: 'warn',
  queued: 'info',
  in_review: 'info',
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

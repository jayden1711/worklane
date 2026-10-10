// Interface patterns adapted from Beautiful UI (MIT, beautifului.dev; credited in
// THIRD_PARTY_NOTICES.md): task rows, tool chips, records tables, sidebar rows,
// insight cards, the loading state. Their demo timelines are left out: these show
// real state as it is, with no staged animation beyond a row's entrance.
import { useState, type ReactNode } from 'react';
import { cx } from './ui';

const CheckIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const XIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
const Chevron = ({ open, className }: { open: boolean; className?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cx('transition-transform duration-200', className)} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export type MarkState = 'done' | 'failed' | 'running' | 'waiting' | 'skipped';

/** A task's state at the start of its row: a green check, a red cross, a spinning ring, or a quiet ring. */
export function StatusMark({ state, children }: { state: MarkState; children?: ReactNode }) {
  if (state === 'done' || state === 'failed') {
    return (
      <span className={cx('flex size-5.5 shrink-0 items-center justify-center rounded-full text-white', state === 'done' ? 'bg-green' : 'bg-red')} style={{ animation: 'pop-in 300ms cubic-bezier(0.23,1,0.32,1) both' }} aria-label={state}>
        {state === 'done' ? CheckIcon : XIcon}
      </span>
    );
  }
  const size = 22;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-label={state}>
      <svg width={size} height={size} className="absolute inset-0" style={state === 'running' ? { animation: 'spin 1.1s linear infinite' } : undefined}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} strokeDasharray={state === 'skipped' ? '2 3' : undefined} />
        {state === 'running' && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ink-3)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c * 0.72}`} />}
      </svg>
      {children !== undefined && <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>}
    </span>
  );
}

/** One row of work: its mark, a label, a quiet amount, an optional pill; clickable (to open it) or expandable. */
export function TaskRow({ mark, label, amount, pill, onClick, details, index = 0, testId }: { mark: ReactNode; label: ReactNode; amount?: ReactNode; pill?: ReactNode; onClick?: () => void; details?: ReactNode; index?: number; testId?: string }) {
  const [open, setOpen] = useState(false);
  const expandable = !onClick && !!details;
  return (
    <div className="overflow-hidden border-b border-line transition-colors duration-200 last:border-0 hover:bg-inset" style={{ animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${Math.min(index, 8) * 60}ms both` }} data-task-row={testId}>
      <button type="button" aria-expanded={expandable ? open : undefined} onClick={onClick ?? (expandable ? () => setOpen((o) => !o) : undefined)} className="flex h-11 w-full items-center gap-2.5 px-3 text-left">
        <span className="flex size-6 shrink-0 items-center justify-center">{mark}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{label}</span>
        {amount !== undefined && <span className="shrink-0 text-[12.5px] tabular-nums text-ink-2">{amount}</span>}
        {pill}
        {(expandable || onClick) && (
          <span aria-hidden className="-mr-1 flex size-6 shrink-0 items-center justify-center text-ink-3">
            {onClick ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            ) : (
              <Chevron open={open} />
            )}
          </span>
        )}
      </button>
      {expandable && (
        <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}>
          <div className="overflow-hidden">
            <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-3">
              <span aria-hidden className="mx-auto h-full w-px bg-line" />
              <div className="min-w-0">{details}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TOOL_ICON: Record<'run' | 'write' | 'read', ReactNode> = {
  write: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </g>
  ),
  run: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-5-6-5M12 19h8" />
    </g>
  ),
  read: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </g>
  ),
};

/** One tool call as a compact row: icon, what it was, the chip (command or file), how it ended; expands to its output. */
export function ToolRow({ icon, label, chip, end, detail }: { icon: 'run' | 'write' | 'read'; label: string; chip: string; end?: ReactNode; detail?: string }) {
  const [open, setOpen] = useState(false);
  const can = !!detail;
  return (
    <div style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }} data-tool-row>
      <button type="button" aria-expanded={can ? open : undefined} onClick={can ? () => setOpen((o) => !o) : undefined} className={cx('group/row flex min-h-7 w-full min-w-0 items-center gap-2 rounded-control px-1 py-0.5 text-left transition-colors duration-100', can && 'hover:bg-hover-2')}>
        <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
          <svg width="13" height="13" viewBox="0 0 24 24" className={cx('transition-opacity duration-100', can && 'group-hover/row:opacity-0', open && 'opacity-0')}>
            {TOOL_ICON[icon]}
          </svg>
          {can && <Chevron open={open} className={cx('absolute group-hover/row:opacity-100', open ? 'opacity-100' : 'opacity-0')} />}
        </span>
        <span className="shrink-0 text-[12.5px] font-medium text-ink">{label}</span>
        <span className="inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-1.5 font-mono text-[11.5px] text-ink-2 shadow-hairline" title={chip}>
          {chip}
        </span>
        {end}
      </button>
      {can && (
        <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}>
          <div className="min-h-0 overflow-hidden">
            <pre className="mt-0.5 mb-1 ml-2 max-h-60 overflow-auto whitespace-pre-wrap border-l border-line py-0.5 pl-3.5 font-mono text-[11.5px] leading-[1.6] text-ink-2">{detail}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** A file chip (the files a run wrote). */
export function FileChip({ file }: { file: string }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn" title={file}>
      <span className="min-w-0 truncate">{file}</span>
    </span>
  );
}

/** A value called out inline (a recommendation, an amount). */
export function ValuePill({ children, tone }: { children: ReactNode; tone?: 'green' }) {
  return <span className={cx('inline-flex h-5.5 items-center rounded-chip px-1.5 text-[12.5px] font-medium', tone === 'green' ? 'bg-green-tint text-green' : 'bg-inset text-ink shadow-hairline')}>{children}</span>;
}

/** A three-bar confidence meter. */
export function Meter({ signal, tone }: { signal: number; tone: string }) {
  return (
    <span className="flex items-end gap-0.5" aria-hidden>
      {[0, 1, 2].map((bar) => (
        <span key={bar} className="w-1 rounded-full" style={{ height: 10, background: bar < signal ? tone : 'var(--line-strong)' }} />
      ))}
    </span>
  );
}

/** A records table on a card: a quiet header row, hairline rows. */
export function RecordsTable({ head, children, footer, className }: { head: ReactNode[]; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-hidden rounded-card bg-surface shadow-card', className)}>
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-inset">
            {head.map((h, i) => (
              <th key={i} className="primitive-table-cell text-[11.5px] font-medium text-ink-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {footer && <div className="primitive-card-footer flex min-h-11 items-center justify-between border-t border-line">{footer}</div>}
    </div>
  );
}

/** A status dot pill inside a table cell. */
export function DotPill({ tone, children }: { tone: 'green' | 'red' | 'orange' | 'ink'; children: ReactNode }) {
  const dot = { green: 'bg-green', red: 'bg-red', orange: 'bg-orange', ink: 'bg-ink-3' }[tone];
  return (
    <span className="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-inset px-2 text-[11.5px] font-medium shadow-hairline">
      <span className={cx('size-1.5 rounded-full', dot)} />
      <span className="text-ink-2">{children}</span>
    </span>
  );
}

/** A sidebar row: icon, label, count; the active one sits on a soft fill. */
export function SidebarRow({ icon, label, count, countTone, active, href, onSelect, title, disabled }: { icon: ReactNode; label: ReactNode; count?: number; countTone?: 'warn'; active: boolean; href?: string; onSelect: () => void; title?: string; disabled?: boolean }) {
  const cls = cx('relative flex h-8 items-center rounded-control px-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.98]', active ? 'bg-hover-2' : 'hover:bg-hover', disabled && 'pointer-events-none opacity-50');
  const body = (
    <>
      <span className={cx('flex size-5 shrink-0 items-center justify-center', active ? 'text-ink' : 'text-ink-2')}>{icon}</span>
      <span className={cx('ml-1.5 min-w-0 flex-1 truncate text-[13.5px] font-medium', active ? 'text-ink' : 'text-ink-2')}>{label}</span>
      {!!count && <span className={cx('ml-2 shrink-0 rounded-full px-1.5 text-[11.5px] font-medium tabular-nums', countTone === 'warn' ? 'bg-orange-tint text-orange' : 'text-ink-3')}>{count}</span>}
    </>
  );
  return href ? (
    <a
      href={href}
      title={title}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cls}
    >
      {body}
    </a>
  ) : (
    <button type="button" title={title} aria-current={active ? 'true' : undefined} disabled={disabled} onClick={onSelect} className={cx(cls, 'w-full')}>
      {body}
    </button>
  );
}

/** An insight card: a label, one figure, a quiet line under it. */
export function InsightCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="rounded-card bg-surface p-3 shadow-card">
      <div className="text-[12px] font-medium text-ink-3">{label}</div>
      <div className={cx('mt-1 text-[22px] font-semibold tracking-tight tabular-nums', tone === 'ok' ? 'text-green' : tone === 'warn' ? 'text-orange' : tone === 'danger' ? 'text-red' : 'text-ink')}>{value}</div>
      {hint !== undefined && <div className="mt-0.5 truncate text-[12px] text-ink-3">{hint}</div>}
    </div>
  );
}

/** The loading state: a shimmering label. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="p-8" role="status">
      <span className="shimmer-text text-[13px] font-medium">{label}</span>
    </div>
  );
}

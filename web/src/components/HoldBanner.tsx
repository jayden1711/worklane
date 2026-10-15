// Why no new work starts (#470): the coordinator's last governor hold (src/governor-holds.ts), shown on the Board and
// First run with its reason, its numbers and the way out, until the hold ends. The strip is always there at a fixed
// height, held or not, so a hold that begins or ends while the page is open never moves a control (#454/#455's rule).
// A viewer's banner comes without the fix or the link (the server strips them).
import type { DiskFloor, HoldBanner as Hold } from '../api';
import { navigate } from '../App';
import { resetClock } from './Usage';
import { cx } from './ui';

/** "Wait until 7:00 PM, or raise the daily budget in Settings." / "Free ~14 GB on this disk, …" */
export function fixLine(h: Pick<Hold, 'wait' | 'fix'>, now = Date.now()): string | null {
  if (h.wait) return `Wait until ${resetClock(h.wait, now)}${h.fix ? `, ${h.fix}` : '.'}`;
  return h.fix;
}

/**
 * The strip: each instance's hold (one held instance's banner; with several held, the first and how many more), or
 * that nothing holds work. Fixed height, every line clamped, the full text in the tooltip.
 */
export function HoldStrip({ holds, now = Date.now(), testId }: { holds: { instance: string | null; hold: Hold | null | undefined }[]; now?: number; testId: string }) {
  const held = holds.filter((x): x is { instance: string | null; hold: Hold } => !!x.hold);
  const first = held[0];
  const h = first?.hold;
  const fix = h ? fixLine(h, now) : null;
  return (
    <div
      role="status"
      className={cx('h-[118px] overflow-hidden rounded-card px-4 py-3 text-[12.5px] sm:h-[84px]', h ? 'bg-orange-tint shadow-[0_0_0_1px_var(--orange-tint)]' : 'bg-surface shadow-card')}
      data-testid={testId}
      data-held={h ? 'true' : 'false'}
      data-kind={h?.kind ?? ''}
      data-instance={first?.instance ?? ''}
    >
      {h ? (
        <>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-semibold text-orange" title={h.title}>
              Work is held: {h.title}
            </span>
            {first.instance && holds.length > 1 && <span className="shrink-0 text-ink-2">{first.instance}</span>}
            {held.length > 1 && <span className="shrink-0 text-ink-3">and {held.length - 1} more held</span>}
            {h.link && (
              <button type="button" className="ml-auto shrink-0 font-medium text-blue-ink hover:underline" onClick={() => navigate(h.link!.path)} data-testid={`${testId}-link`}>
                Open {h.link.label}
              </button>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-ink-2 sm:line-clamp-1" title={h.numbers ?? undefined} data-testid={`${testId}-numbers`}>
            {h.numbers ?? 'No figures recorded for this hold.'}
          </div>
          <div className="mt-0.5 line-clamp-2 text-ink sm:line-clamp-1" title={fix ?? undefined} data-testid={`${testId}-fix`}>
            {fix ?? 'Work resumes on its own once this clears.'}
          </div>
        </>
      ) : (
        <>
          <div className="truncate font-medium text-ink">Nothing is holding new work</div>
          <div className="mt-0.5 line-clamp-2 text-ink-2 sm:line-clamp-1">A ready task starts when an agent slot is free. If the machine stops new work (disk, load, budget, the agent cap, a run window, a usage limit, an update), it shows here with its numbers and what to do.</div>
        </>
      )}
    </div>
  );
}

/** First run's machine check: the disk floor now, with its numbers, and what to do when it is low. */
export function DiskFloorCheck({ d }: { d: DiskFloor }) {
  return (
    <div className={cx('rounded-card px-4 py-3 text-[12.5px]', d.level === 'warn' ? 'bg-orange-tint text-ink' : 'bg-surface text-ink-2 shadow-card')} data-testid="first-run-disk" data-level={d.level}>
      <span className={cx('font-medium', d.level === 'warn' ? 'text-orange' : 'text-ink')}>Machine check, disk: </span>
      {d.detail}
    </div>
  );
}

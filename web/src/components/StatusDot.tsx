import type { DotStatus } from '../api';
import { cx } from './ui';

export const STATUS_DOT: Record<DotStatus, string> = { green: 'bg-green', amber: 'bg-orange', red: 'bg-red', unknown: 'bg-ink-3' };
const STATUS_WORD: Record<DotStatus, string> = { green: 'healthy', amber: 'needs attention', red: 'something is broken', unknown: "status unknown: it couldn't be read" };

/** A status dot: green, amber, red, or grey (unknown), with its word (and why, when given) for screen readers and on hover. */
export function StatusDot({ status, why, testId, className }: { status: DotStatus; why?: string | null | undefined; testId?: string; className?: string }) {
  const words = why ? `${STATUS_WORD[status]} (${why})` : STATUS_WORD[status];
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', STATUS_DOT[status], className)} data-status={status} data-testid={testId} title={words} role="img" aria-label={words} />;
}

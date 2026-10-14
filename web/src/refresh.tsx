// A panel that loads its data and looks again (the Machine page's Tailscale and Claude account panels, the first-run
// Discord step): what it keeps when a look fails. A refusal (not signed in, not allowed, no such view here) hides
// it, as before. Anything else (the network, a 5xx, a timeout) keeps the last good data on screen, so what the owner
// typed, a review they have open and a message they are reading stay, and says that it couldn't refresh and will
// try again. New data always replaces the old.
import { useEffect } from 'react';
import { isRefusal } from './api';

export interface Loaded<T> {
  data: T | null;
  /** Why the last look failed, while the data shown is the last good one (or none yet); null when it is current. */
  stale: string | null;
}

export const NOTHING_YET = { data: null, stale: null };

/** What a panel keeps after a look: the new data, nothing on a refusal, or the last good data and why it is stale. */
export function afterLoad<T>(prev: Loaded<T>, r: { data: T } | { error: unknown }): Loaded<T> {
  if ('data' in r) return { data: r.data, stale: null };
  if (isRefusal(r.error)) return { data: null, stale: null };
  return { data: prev.data, stale: (r.error instanceof Error && r.error.message) || 'no answer' };
}

export const RETRY_MS = 5000;

/** While the last look failed, look again every few seconds (a panel that polls anyway still gets its answer sooner). */
export function useRetry<T>(loaded: Loaded<T>, load: () => void): void {
  useEffect(() => {
    if (loaded.stale === null) return;
    const t = window.setTimeout(load, RETRY_MS);
    return () => window.clearTimeout(t);
    // Armed once per failed look (each is a new Loaded, even with the same reason); load is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
}

/** The note a panel shows over its last good data while it can't refresh. */
export function StaleNote({ stale }: { stale: string | null }) {
  if (stale === null) return null;
  return (
    <p className="break-words text-[12px] text-ink-3" data-testid="refresh-stale" role="status">
      couldn't refresh: {stale}, retrying
    </p>
  );
}

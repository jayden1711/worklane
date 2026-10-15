// Work in the background once the page shown has what it needs: the other pages' code and the views a person is
// likely to open next (the other instances' main page, this instance's next pages), so a switch shows them at once
// from web/src/cache.ts. Never more than a few at a time, each when the browser is idle, at low priority, and never
// on a connection that asks to save data. Streams are not opened here: only the instance shown has one.

type Task = () => Promise<unknown>;

/** Run `fn` when the browser is idle (or soon, where it can't say). */
export function idle(fn: () => void, timeout = 2000): () => void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, 50);
  return () => window.clearTimeout(id);
}

/** Whether this connection asks for less (Save-Data, or 2G). */
function saveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c && (c.saveData === true || /(^|-)2g$/.test(c.effectiveType ?? ''));
}

/** At most this many background requests at once. */
export const BACKGROUND_LIMIT = 2;

/**
 * Run `tasks` in the background, in order, at most `limit` at a time, each started when the browser is idle; a task
 * that fails is skipped. Returns the cancel (what hasn't started yet never starts).
 */
export function background(tasks: Task[], limit = BACKGROUND_LIMIT): () => void {
  if (saveData()) return () => {};
  const queue = [...tasks];
  let stopped = false;
  const cancels = new Set<() => void>();
  const worker = () => {
    if (stopped) return;
    const next = queue.shift();
    if (!next) return;
    const cancel = idle(() => {
      cancels.delete(cancel);
      if (stopped) return;
      void next()
        .catch(() => undefined)
        .then(worker);
    });
    cancels.add(cancel);
  };
  for (let i = 0; i < limit; i++) worker();
  return () => {
    stopped = true;
    for (const c of cancels) c();
    cancels.clear();
  };
}

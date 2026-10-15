// A list that a live update adds to, kept in the order it was first shown: what arrives while the page is open goes
// after what is already there, never above it, so a new item never moves a card (and its buttons) under the cursor
// (#455: a decision asked while the Inbox was open went to the top, newest first, and moved every card below it 195 px,
// options and all). The next visit shows the server's order again.
import { useMemo, useRef } from 'react';

/** Each item's place: first-seen order, then arrivals in the order they came. */
export function arrivalOrder<T extends { id: string }>(items: T[], seen: Map<string, number>): T[] {
  for (const it of items) if (!seen.has(it.id)) seen.set(it.id, seen.size);
  return [...items].sort((a, b) => seen.get(a.id)! - seen.get(b.id)!);
}

/** `items` in arrival order for this page's life; a change of `view` (the reader's own: a filter) starts again. */
export function useArrivalOrder<T extends { id: string }>(items: T[], view: unknown = null): T[] {
  const seen = useRef<{ view: unknown; at: Map<string, number> }>({ view, at: new Map() });
  if (seen.current.view !== view) seen.current = { view, at: new Map() };
  const at = seen.current.at;
  return useMemo(() => arrivalOrder(items, at), [items, at]);
}

// What the page last read of each view, per instance, so a switch of instance or page shows it at once and asks again
// in the background (stale-while-revalidate), and one GET of a URL at a time (a second ask while one is in flight
// waits for it and then asks once more, so no answer predates the ask and no view is asked twice at once).
//
// INVARIANTS:
// - Memory only: never localStorage, sessionStorage or IndexedDB. A page load is one signed-in session (signing in and
//   out both leave the page), so nothing kept here outlives the session it was read in, or reaches another tab.
// - Keyed by the URL the page asks: on a hub `/api/i/<instance>/<view>`, so the instance is part of every key and one
//   instance's answer can't be read under another's. Off a hub there is one instance: the page's own server.
// - A 401 empties all of it; a 403 empties that instance's. A /state answer whose person or role differs from the
//   last one read there empties that instance's (another person: everything) before it is kept.
// - Only the listed views (KEPT) are kept: page data, never sign-in links, tokens, transcripts or setup asks.
import { useSyncExternalStore } from 'react';

interface Entry {
  data: unknown;
  at: number;
}

const entries = new Map<string, Entry>();
/** Each instance's last person and role, from its /state ('' off a hub). */
const seen = new Map<string, string>();
/** At most this many views kept (the least recently read go first). */
const MAX = 200;

/** The views kept: what pages show. Anything else is asked as before and never kept. */
const KEPT = /^\/api\/(?:i\/[^/?]+\/)?(?:state|board|prs|test-runs|usage|health|health\/incidents|intake|waiting|trust|metrics|throughput|flaky|learnings|harness-evals|constraints|events|report|live|settings|checks|goal-graph)(?:\?[^#]*)?$/;

/**
 * Off only for a measurement (the dashboard speed test's "without the cache" run): this tab's `dash-cache-off`. With it
 * off, nothing is kept or shown from here; GETs are still asked one at a time.
 */
function readOff(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('dash-cache-off') === '1';
  } catch {
    return false;
  }
}
let off = readOff();
/** For the render checks: turn keeping off or on. */
export function setCacheOff(v: boolean) {
  off = v;
  if (v) forgetAll();
}

/** The instance a URL is on (`/api/i/<name>/...`), '' for the page's own server. */
export function instanceOf(url: string): string {
  const m = url.match(/^\/api\/i\/([^/?]+)\//);
  return m ? decodeURIComponent(m[1]!) : '';
}

export function kept(url: string): boolean {
  return KEPT.test(url);
}

/** The last answer read at `url`, if kept. */
export function peek<T>(url: string): { data: T; at: number } | undefined {
  if (off) return undefined;
  const e = entries.get(url);
  if (!e) return undefined;
  // Most recently read last (the oldest go first when full).
  entries.delete(url);
  entries.set(url, e);
  return e as { data: T; at: number };
}

/** Keep an answer read at `url` (a listed view only), after the person and role checks. */
export function keep(url: string, data: unknown, now = Date.now()): void {
  if (off || !kept(url)) return;
  const inst = instanceOf(url);
  if (/\/state(?:\?|$)/.test(url) && data && typeof data === 'object') {
    const s = data as { user?: unknown; role?: unknown };
    const who = `${String(s.user ?? '')}\n${String(s.role ?? '')}`;
    const was = seen.get(inst);
    if (was !== undefined && was !== who) {
      // Another person: nothing read for the last one stays. Another role: nothing read under the old one stays.
      if (was.split('\n')[0] !== who.split('\n')[0]) forgetAll();
      else forgetInstance(inst);
    }
    seen.set(inst, who);
  }
  entries.delete(url);
  entries.set(url, { data, at: now });
  while (entries.size > MAX) entries.delete(entries.keys().next().value!);
  notify();
}

/** Forget one instance's views ('' : the page's own server's). */
export function forgetInstance(inst: string): void {
  for (const k of [...entries.keys()]) if (instanceOf(k) === inst) entries.delete(k);
  seen.delete(inst);
  notify();
}

/** Forget everything (signed out, the session refused, another person). */
export function forgetAll(): void {
  entries.clear();
  seen.clear();
  notify();
}

/** What a refusal means for what is kept: 401 (no session) everything, 403 (no role there now) that instance's. */
export function refused(url: string, status: number): void {
  if (status === 401) forgetAll();
  else if (status === 403) forgetInstance(instanceOf(url));
}

/** How many views are kept (tests). */
export const keptCount = () => entries.size;

const flights = new Map<string, { p: Promise<unknown>; again: Promise<unknown> | null }>();
const noop = () => {};

/**
 * One GET of `url` at a time. Asked while one is in flight: `fresh` (the default) waits for it and asks once more
 * (shared by everyone who asked meanwhile), since that answer may predate what made them ask; not fresh (a prefetch)
 * takes the answer in flight.
 */
export function coalesced<T>(url: string, run: () => Promise<T>, fresh = true): Promise<T> {
  const f = flights.get(url);
  if (f) {
    if (!fresh) return f.p as Promise<T>;
    f.again ??= f.p.then(noop, noop).then(() => coalesced(url, run));
    return f.again as Promise<T>;
  }
  const p = run();
  const entry = { p: p as Promise<unknown>, again: null };
  flights.set(url, entry);
  const done = () => {
    if (flights.get(url) === entry) flights.delete(url);
  };
  p.then(done, done);
  return p;
}

/** Whether a GET of `url` is in flight now. */
export const inFlight = (url: string) => flights.has(url);

// ---- "updating…": views shown from what was kept while their fresh answer is on its way ----

const updating = new Set<symbol>();
const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version++;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Mark a view as shown from what was kept until its answer comes; returns the unmark. */
export function markUpdating(): () => void {
  const id = Symbol('updating');
  updating.add(id);
  notify();
  return () => {
    if (updating.delete(id)) notify();
  };
}

/** Whether any view on the page is shown from what was kept and being read again. */
export function useUpdating(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => updating.size > 0,
    () => false,
  );
}

/** Re-render on any change to what is kept (tests and the debug readout). */
export function useCacheVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

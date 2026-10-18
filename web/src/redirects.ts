// WHY (#581): a page that moved keeps its old address working. Experiments left Extend for a sidebar item of its own,
// and a bookmark or a link to /extend/experiments[/<study>] still opens it. A module of its own, so it is ready before
// App.tsx's module body asks it where the first address moved (defined below that line in App.tsx, it wasn't yet, and
// every page failed to load).

/** Old addresses and where each moved: a path at or under `from` lands at the same place under `to`, so an id after it is kept. */
export const REDIRECTS: readonly { from: string; to: string }[] = [{ from: '/extend/experiments', to: '/experiments' }];

/** Where an old address moved (REDIRECTS); null: it's a current one. */
export function redirectFor(path: string): string | null {
  for (const r of REDIRECTS) if (path === r.from || path.startsWith(`${r.from}/`)) return r.to + path.slice(r.from.length);
  return null;
}

/** The path to show. An old address is replaced (not pushed, so Back doesn't return to it) by its new one, query and hash kept. */
export function landOn(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location, history: Pick<History, 'state' | 'replaceState'> = window.history): string {
  const to = redirectFor(loc.pathname);
  if (to === null) return loc.pathname;
  history.replaceState(history.state, '', to + loc.search + loc.hash);
  return to;
}

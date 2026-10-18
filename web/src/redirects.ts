// WHY (#581, #585): a page that moved keeps its old address working. Experiments left Extend for a sidebar item of its
// own, and a bookmark or a link to /extend/experiments[/<study>] still opens it; the pages grouped in the sidebar (#585)
// moved under their group, and /issues/12 or /decisions/<id>?x#y still opens. A module of its own, so it is ready before
// App.tsx's module body asks it where the first address moved (defined below that line in App.tsx, it wasn't yet, and
// every page failed to load).

/** Old addresses and where each moved: a path at or under `from` lands at the same place under `to`, so an id after it is kept. */
export const REDIRECTS: readonly { from: string; to: string }[] = [
  { from: '/extend/experiments', to: '/experiments' },
  // #585: the pages grouped in the sidebar live under their group's address (App.tsx NAV, each group's tabs).
  { from: '/inbox', to: '/needs-you/inbox' },
  { from: '/waiting', to: '/needs-you/waiting' },
  { from: '/decisions', to: '/needs-you/decisions' },
  { from: '/issues', to: '/work/issues' },
  { from: '/intake', to: '/work/intake' },
  { from: '/prs', to: '/work/prs' },
  { from: '/land', to: '/shipping/land' },
  { from: '/deploys', to: '/shipping/deploys' },
  { from: '/activity', to: '/agents/activity' },
  { from: '/health', to: '/machine/health' },
  { from: '/logs', to: '/machine/logs' },
  { from: '/reports', to: '/machine/reports' },
  { from: '/setup', to: '/settings/setup' },
];

/**
 * A group's own address where no page is (#585): it opens the group's first tab, as its sidebar row does. Exact only,
 * since its tabs are under it. (Needs you's is its queue; Agents', Machine's and Settings' are their first tab.)
 */
export const GROUP_HOMES: Readonly<Record<string, string>> = { '/work': '/', '/shipping': '/shipping/land' };

/** Where an old address moved (REDIRECTS), or where a group's bare address opens (GROUP_HOMES); null: it's a current one. */
export function redirectFor(path: string): string | null {
  if (Object.hasOwn(GROUP_HOMES, path)) return GROUP_HOMES[path]!;
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

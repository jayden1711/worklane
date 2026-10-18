// The sidebar's groups (#585): Needs you, Work, Shipping, Agents, Machine and Settings, each with its old pages as
// tabs; every old address lands on its new one; each role still reaches the same pages, with the same `g` keys.
// The nav is App.tsx's (NAV, navFor, pagesFor), bundled for Node with the project's own vite.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

interface Page { to: string; label: string; chord: string; testId: string; tabs?: readonly Page[] }
interface Nav {
  NAV: Page[];
  navFor(state: unknown): Page[];
  pagesFor(state: unknown): Page[];
  placeOf(path: string): { row: Page; tab: Page | null } | null;
  navCounts(state: unknown): Record<string, number | undefined>;
  navigate(to: string): void;
}
interface Redirects {
  redirectFor(path: string): string | null;
  landOn(loc: { pathname: string; search: string; hash: string }, history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void }): string;
}

let nav: Nav;
let moved: Redirects;
before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'web-nav-'));
  const src = join(repoRoot, 'web', 'src');
  await build({
    configFile: false,
    root: join(repoRoot, 'web'),
    logLevel: 'silent',
    plugins: [react()],
    ssr: { noExternal: true },
    build: { ssr: true, outDir: out, emptyOutDir: true, rollupOptions: { input: { app: join(src, 'App.tsx'), redirects: join(src, 'redirects.ts') }, output: { entryFileNames: '[name].mjs' } } },
  });
  nav = (await import(pathToFileURL(join(out, 'app.mjs')).href)) as Nav;
  moved = (await import(pathToFileURL(join(out, 'redirects.mjs')).href)) as Redirects;
});

const owner = { role: 'owner', setupMode: false, experiments: true };
const writer = { role: 'writer', setupMode: false, experiments: true };
// What a viewer's state carries: no experiments key at all.
const viewer = { role: 'viewer', setupMode: false };

/** Every page as the sidebar listed it before #585: its address, its name, its `g` key, and whether a viewer had it. */
const BEFORE: [string, string, string, boolean][] = [
  ['/', 'Board', 'b', true],
  ['/overview', 'Overview', 'o', true],
  ['/inbox', 'Inbox', 'i', true],
  ['/waiting', 'Waiting on you', 'w', true],
  ['/decisions', 'Decisions', 'd', true],
  ['/setup', 'Setup console', 'u', true],
  ['/issues', 'Issues', 's', true],
  ['/intake', 'Intake', 'n', true],
  ['/land', 'Land queue', 'l', true],
  ['/prs', 'Pull requests', 'p', true],
  ['/agents', 'Agents', 'a', true],
  ['/extend', 'Extend', 'x', false],
  ['/experiments', 'Experiments', 't', false],
  ['/activity', 'Activity', 'e', true],
  ['/deploys', 'Deploys', 'y', true],
  ['/reports', 'Reports', 'r', true],
  ['/logs', 'Logs', 'j', true],
  ['/health', 'Health', 'h', true],
  ['/machine', 'Machine', 'm', true],
  ['/settings', 'Settings', ',', true],
];

/** The old addresses the issue lists, and where each page lives now. */
const MOVED: Record<string, string> = {
  '/inbox': '/needs-you/inbox',
  '/waiting': '/needs-you/waiting',
  '/decisions': '/needs-you/decisions',
  '/issues': '/work/issues',
  '/intake': '/work/intake',
  '/prs': '/work/prs',
  '/land': '/shipping/land',
  '/deploys': '/shipping/deploys',
  '/activity': '/agents/activity',
  '/health': '/machine/health',
  '/logs': '/machine/logs',
  '/reports': '/machine/reports',
  '/setup': '/settings/setup',
};

test('the sidebar groups', () => {
  const groups = ['Needs you', 'Work', 'Overview', 'Shipping', 'Agents', 'Extend', 'Experiments', 'Machine', 'Settings'];
  assert.deepEqual(nav.navFor(owner).map((n) => n.label), groups);
  assert.deepEqual(nav.navFor(writer).map((n) => n.label), groups);
  // Experiments stays a sidebar item of its own (#581), for owners and writers where it's on; Extend, owners and writers.
  assert.deepEqual(nav.navFor(viewer).map((n) => n.label), groups.filter((g) => g !== 'Extend' && g !== 'Experiments'));
  // No grouped page keeps a sidebar row of its own.
  const rows = nav.NAV.map((n) => n.label);
  for (const page of ['Board', 'Inbox', 'Waiting on you', 'Decisions', 'Setup console', 'Issues', 'Intake', 'Land queue', 'Pull requests', 'Activity', 'Deploys', 'Reports', 'Logs', 'Health']) assert.ok(!rows.includes(page), `${page} is a tab now, not a row`);
  // Each group's tabs, in order.
  const tabs = Object.fromEntries(nav.NAV.filter((n) => n.tabs).map((n) => [n.label, n.tabs!.map((t) => t.label)]));
  assert.deepEqual(tabs, {
    'Needs you': ['Inbox', 'Waiting on you', 'Decisions'],
    Work: ['Board', 'Issues', 'Intake', 'Pull requests'],
    Shipping: ['Land queue', 'Deploys'],
    Agents: ['Agents', 'Activity'],
    Machine: ['Machine', 'Health', 'Logs', 'Reports'],
    Settings: ['Settings', 'Setup console'],
  });
  // A group's row opens its first tab, on that tab's key.
  for (const n of nav.NAV.filter((x) => x.tabs)) assert.deepEqual([n.to, n.chord], [n.tabs![0]!.to, n.tabs![0]!.chord], n.label);
  // Where an address is: its group and its tab (an id under a tab's address is on that tab).
  const at = (path: string) => {
    const p = nav.placeOf(path);
    return p && [p.row.label, p.tab?.label ?? null];
  };
  assert.deepEqual(at('/'), ['Work', 'Board']);
  assert.deepEqual(at('/work/issues/12'), ['Work', 'Issues']);
  assert.deepEqual(at('/needs-you/decisions/pr-7'), ['Needs you', 'Decisions']);
  assert.deepEqual(at('/agents'), ['Agents', 'Agents']);
  assert.deepEqual(at('/agents/activity'), ['Agents', 'Activity']);
  assert.deepEqual(at('/machine/health'), ['Machine', 'Health']);
  assert.deepEqual(at('/settings/setup'), ['Settings', 'Setup console']);
  assert.deepEqual(at('/extend/plugins'), ['Extend', null]);
  assert.deepEqual(at('/experiments/example-speed'), ['Experiments', null]);
  for (const nowhere of ['/runs/r-1', '/first-run', '/nowhere', '/agentsx']) assert.equal(at(nowhere), null, nowhere);
});

test('Needs you has one badge: each open decision and each of your blocked tasks, once', () => {
  const d = (id: string, answered = false) => ({ id, answer: answered ? { by: 'x', answer: 'y', at: '' } : null });
  const state = {
    ...owner,
    // The Inbox's decisions (yours) are among the open ones: each counted once.
    decisions: [d('a'), d('b'), d('c', true)],
    inbox: { decisions: [d('a')], blocked: [{ issue: 4 }, { issue: 5 }], notify: [{ issue: 6 }] },
    tasks: [],
    landQueue: [],
  };
  const c = nav.navCounts(state);
  assert.equal(c['nav-needs-you'], 4, 'open decisions a and b, blocked #4 and #5');
  // The tabs keep their own counts, as their rows had them.
  assert.equal(c['/needs-you/inbox'], 3);
  assert.equal(c['/needs-you/decisions'], 2);
  assert.equal(nav.navCounts(null)['nav-needs-you'], 0);
});

test('old routes redirect', () => {
  for (const [from, to] of Object.entries(MOVED)) {
    assert.equal(moved.redirectFor(from), to, from);
    assert.equal(moved.redirectFor(`${from}/`), `${to}/`, `${from}/`);
    // The new address is a page the sidebar reaches.
    assert.ok(nav.pagesFor(owner).some((p) => p.to === to), `${to} is in the nav`);
  }
  // An id after the old address is kept.
  assert.equal(moved.redirectFor('/decisions/d-1'), '/needs-you/decisions/d-1');
  assert.equal(moved.redirectFor('/decisions/pr-7'), '/needs-you/decisions/pr-7');
  assert.equal(moved.redirectFor('/issues/12'), '/work/issues/12');
  // #581's stays.
  assert.equal(moved.redirectFor('/extend/experiments/example-speed'), '/experiments/example-speed');
  // Current addresses, and a name that only starts like an old one, are left alone.
  for (const keep of ['/', '/overview', '/agents', '/machine', '/settings', '/extend', '/experiments', '/runs/r-1', '/first-run', '/landing', '/issuesx', ...Object.values(MOVED)]) assert.equal(moved.redirectFor(keep), null, keep);
  // Replaced, not pushed, with the query and the hash kept.
  const calls: string[] = [];
  const history = { state: null, replaceState: (_: unknown, __: string, url: string) => void calls.push(url) };
  assert.equal(moved.landOn({ pathname: '/issues', search: '?view=Mine', hash: '' }, history), '/work/issues');
  assert.equal(moved.landOn({ pathname: '/decisions', search: '', hash: '#d-1' }, history), '/needs-you/decisions');
  assert.equal(moved.landOn({ pathname: '/decisions/pr-7', search: '?proposed=approve', hash: '#why' }, history), '/needs-you/decisions/pr-7');
  assert.deepEqual(calls, ['/work/issues?view=Mine', '/needs-you/decisions#d-1', '/needs-you/decisions/pr-7?proposed=approve#why']);
  // A link inside the dashboard to an old address goes straight to the new one.
  const g = globalThis as Record<string, unknown>;
  const had = { window: g.window, PopStateEvent: g.PopStateEvent };
  const pushed: string[] = [];
  g.window = { location: { pathname: '/' }, history: { pushState: (_: unknown, __: string, url: string) => void pushed.push(url) }, dispatchEvent: () => true };
  g.PopStateEvent = class {};
  try {
    for (const to of ['/issues/3?view=Mine#checks', '/decisions#d-1', '/setup', '/agents']) nav.navigate(to);
  } finally {
    Object.assign(g, had);
  }
  assert.deepEqual(pushed, ['/work/issues/3?view=Mine#checks', '/needs-you/decisions#d-1', '/settings/setup', '/agents']);
});

test('roles and setup mode keep their pages', () => {
  const now = (s: unknown) => nav.pagesFor(s).map((p) => `${p.label} ${p.to} g${p.chord}`).sort();
  const before = (viewerToo: boolean) => BEFORE.filter(([, , , v]) => v || !viewerToo).map(([to, label, chord]) => `${label} ${moved.redirectFor(to) ?? to} g${chord}`).sort();
  // The same pages, each at its new address, on the same `g` key (the chords and the command menu read this list).
  assert.deepEqual(now(owner), before(false));
  assert.deepEqual(now(writer), before(false));
  assert.deepEqual(now(viewer), before(true));
  // Every key opens one page.
  const keys = nav.pagesFor(owner).map((p) => p.chord);
  assert.equal(new Set(keys).size, keys.length);
  // The Setup console is a tab under Settings, never a sidebar row.
  for (const s of [owner, writer, viewer]) assert.ok(!nav.navFor(s).some((n) => n.label === 'Setup console' || n.to.includes('setup')));
  assert.ok(nav.NAV.find((n) => n.label === 'Settings')!.tabs!.some((t) => t.label === 'Setup console' && t.to === '/settings/setup'));
  // Setup mode: First run alone, in the sidebar, the command menu and the keys.
  for (const s of [owner, viewer]) {
    assert.deepEqual(nav.navFor({ ...s, setupMode: true }).map((n) => n.to), ['/first-run']);
    assert.deepEqual(nav.pagesFor({ ...s, setupMode: true }).map((n) => n.to), ['/first-run']);
  }
});

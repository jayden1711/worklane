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
  navCounts(state: unknown, waiting?: unknown): Record<string, number | undefined>;
  navigate(to: string): void;
  needsYou(state: unknown, waiting?: unknown): { key: string; kind: string; blocking: boolean; since: string; issue: number | null; href: string | null }[];
  ORDER: string;
  KIND: Record<string, { label: string; holds: string | null }>;
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
  ['/', 'Board', 'b', true], ['/overview', 'Overview', 'o', true], ['/inbox', 'Inbox', 'i', true], ['/waiting', 'Waiting on you', 'w', true],
  ['/decisions', 'Decisions', 'd', true], ['/setup', 'Setup console', 'u', true], ['/issues', 'Issues', 's', true], ['/intake', 'Intake', 'n', true],
  ['/land', 'Land queue', 'l', true], ['/prs', 'Pull requests', 'p', true], ['/agents', 'Agents', 'a', true], ['/extend', 'Extend', 'x', false],
  ['/experiments', 'Experiments', 't', false], ['/activity', 'Activity', 'e', true], ['/deploys', 'Deploys', 'y', true], ['/reports', 'Reports', 'r', true],
  ['/logs', 'Logs', 'j', true], ['/health', 'Health', 'h', true], ['/machine', 'Machine', 'm', true], ['/settings', 'Settings', ',', true],
];

/** The old addresses the issue lists, and where each page lives now. */
const MOVED: Record<string, string> = {
  '/inbox': '/needs-you/inbox', '/waiting': '/needs-you/waiting', '/decisions': '/needs-you/decisions',
  '/issues': '/work/issues', '/intake': '/work/intake', '/prs': '/work/prs', '/land': '/shipping/land', '/deploys': '/shipping/deploys',
  '/activity': '/agents/activity', '/health': '/machine/health', '/logs': '/machine/logs', '/reports': '/machine/reports', '/setup': '/settings/setup',
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
    'Needs you': ['Needs you', 'Inbox', 'Waiting on you', 'Decisions'],
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
  assert.deepEqual(at('/needs-you'), ['Needs you', 'Needs you']);
  assert.deepEqual(at('/needs-you/inbox'), ['Needs you', 'Inbox']);
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
  const d = (id: string, answered = false) => ({ id, question: `Question ${id}?`, answer: answered ? { by: 'x', answer: 'y', at: '' } : null });
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

test('Needs you is one queue, urgency-sorted', () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const hoursAgo = (h: number) => new Date(t0 - h * 3_600_000).toISOString();
  const d = (id: string, h: number, o: object = {}) => ({ id, kind: 'triage', issue: null, owner: 'example-owner', question: `Question ${id}?\nmore`, askedAt: hoursAgo(h), answer: null, ...o });
  const decisions = [d('a', 5, { issue: 1 }), d('b', 30), d('c', 99, { answer: { by: 'x', answer: 'y', at: '' } }), d('p', 50, { kind: 'plan', issue: 2 })];
  const blocked = [{ issue: 4, title: 'four', lastActivity: hoursAgo(3), blockedReason: 'needs a key\nmore' }, { issue: 5, title: 'five', lastActivity: hoursAgo(1), blockedReason: null }];
  const state = { ...owner, decisions, inbox: { decisions: [decisions[0]], blocked, notify: [{ issue: 6 }] }, tasks: [{ issue: 1, title: 'one' }], landQueue: [] };
  const w = (kind: string, h: number, o: object = {}) => ({ kind, since: hoursAgo(h), issue: null, pr: null, title: null, detail: kind, ...o });
  const waiting = {
    items: [
      w('emergency_halt', 2),
      // Decision a and plan p, as Waiting on you lists them: the same things as the Decisions tab's.
      w('awaiting_decision', 5, { issue: 1, decision: 'a' }),
      w('plan_held', 50, { issue: 2, decision: 'p' }),
      w('needs_owner', 10, { issue: 7, pr: 70 }),
      // Your blocked #4 (the Inbox's), blocked since 8 h ago; #9 is someone else's.
      w('blocked', 8, { issue: 4 }),
      w('blocked', 6, { issue: 9 }),
      // The oldest of all, but nothing waits on them but you; two holds on one issue are two things.
      w('hotspot_held', 200, { issue: 10 }),
      w('hotspot_held', 150, { issue: 10, detail: 'Depends on #3' }),
      w('deploy_failed', 40, { sha: 'abc' }),
    ],
  };
  const q = nav.needsYou(state, waiting);
  const shown = (i: { kind: string; issue: number | null }) => `${i.kind}${i.issue !== null ? ` #${i.issue}` : ''}`;
  // What holds an agent or a merge first, the oldest first; then the rest, the oldest first. Each thing once.
  assert.deepEqual(q.map(shown), [
    'plan_held #2', 'awaiting_decision', 'needs_owner #7', 'blocked #4', 'blocked #9', 'awaiting_decision #1', 'emergency_halt', 'blocked #5',
    'hotspot_held #10', 'hotspot_held #10', 'deploy_failed',
  ]);
  assert.deepEqual(q.map((i) => i.blocking), [true, true, true, true, true, true, true, true, false, false, false]);
  assert.equal(new Set(q.map((i) => i.key)).size, q.length, 'no thing twice');
  // A blocked task the Inbox and Waiting on you both list waits since it was blocked (Waiting on you's).
  assert.equal(q.find((i) => i.issue === 4)!.since, hoursAgo(8));
  // Each opens its own page.
  assert.deepEqual(q.slice(0, 4).map((i) => i.href), ['/needs-you/decisions/p', '/needs-you/decisions/b', '/needs-you/decisions/pr-70', '/work/issues/4']);
  // The one badge counts the queue: inbox, waiting and decisions, each thing once (the Inbox's L2 landings aside).
  const c = nav.navCounts(state, waiting);
  assert.equal(c['nav-needs-you'], 11);
  assert.equal(c['/needs-you'], 11);
  // Before Waiting on you answers, or for a viewer it is refused to: the decisions and your blocked tasks.
  assert.deepEqual(nav.needsYou(state).map(shown), ['plan_held #2', 'awaiting_decision', 'awaiting_decision #1', 'blocked #4', 'blocked #5']);
  assert.equal(nav.navCounts(state)['nav-needs-you'], 5);
  // The page states the order, from the same table the sort reads: every kind is named, and which side it is on.
  for (const [kind, k] of Object.entries(nav.KIND)) assert.ok(nav.ORDER.includes(k.label), `the order names ${kind}`);
  assert.ok(nav.ORDER.indexOf(nav.KIND.blocked!.label) < nav.ORDER.indexOf('then the rest') && nav.ORDER.indexOf('then the rest') < nav.ORDER.indexOf(nav.KIND.deploy_failed!.label));
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
  // A group's own address opens it: Work and Shipping at their first tab; Needs you is the queue itself.
  assert.equal(moved.redirectFor('/work'), '/');
  assert.equal(moved.redirectFor('/shipping'), '/shipping/land');
  assert.equal(moved.redirectFor('/needs-you'), null);
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
  // The one page #585 adds, for every role: the Needs you queue.
  const before = (viewerToo: boolean) => [...BEFORE.filter(([, , , v]) => v || !viewerToo).map(([to, label, chord]) => `${label} ${moved.redirectFor(to) ?? to} g${chord}`), 'Needs you /needs-you gq'].sort();
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

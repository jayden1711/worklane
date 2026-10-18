import { createContext, createElement, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Activity, Menu, X, Bot, FlaskConical, Gauge, LogOut, Inbox as InboxIcon, Layers, ListChecks, Moon, Rocket, Search, Server, Puzzle, Settings as SettingsIcon, SquareKanban, Sun, Vote } from 'lucide-react';
import { healthPass, hub, hubNow, servedByHub, instanceScope, keyMissing, needsSignIn, onLoopback, prefetchView, scopeKey, viewUrl, selectAllInstances, selectInstance, signOut, useLiveState, useScope, type DotStatus, type HubInfo, type Role, type State } from './api';
import { peek, useUpdating } from './cache';
import { Entrances, Loading, SidebarRow } from './components/patterns';
import { ChatPanel } from './components/ChatPanel';
import { VoiceControl } from './voice/VoiceControl';
import { useVoicePrefs } from './voice/prefs';
import { MainWatchAlert } from './components/Protection';
import { UsageBanner, useNow, useUsage } from './components/Usage';
import { ago, Kbd, cx } from './components/ui';
import { Header } from './components/Header';
import { StatusDot } from './components/StatusDot';
import { WakeWord } from './voice/WakeIndicator';
import { logsRefusal, runsRefusal } from './refusals';
import { KeyForm, KeyPage } from './components/DashboardKey';
import { background, idle } from './prefetch';
import { landOn, redirectFor } from './redirects';

/**
 * A page as its own chunk (code split): the first load ships the shell and the page shown. Once its module is in
 * (preload, or its first render), it renders directly, with no Suspense fallback on a later switch to it.
 */
function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> & { preload: () => Promise<unknown> } {
  let mod: ComponentType<P> | null = null;
  let loading: Promise<{ default: ComponentType<P> }> | null = null;
  const loader = () =>
    (loading ??= load().then(
      (c) => ({ default: (mod = c) }),
      (e: unknown) => {
        loading = null; // a failed chunk is asked again next time
        throw e;
      },
    ));
  const Lazy = lazy(loader);
  const Page = (props: P) => (mod ? createElement(mod, props) : createElement(Lazy as ComponentType<P>, props));
  return Object.assign(Page, { preload: () => loader().catch(() => undefined) });
}

const Overview = lazyPage(() => import('./pages/Overview').then((m) => m.Overview));
const BoardPage = lazyPage(() => import('./pages/Board').then((m) => m.BoardPage));
const MachinePage = lazyPage(() => import('./pages/Machine').then((m) => m.MachinePage));
const InboxPage = lazyPage(() => import('./pages/Inbox').then((m) => m.InboxPage));
const SetupPage = lazyPage(() => import('./pages/Setup').then((m) => m.SetupPage));
const WaitingPage = lazyPage(() => import('./pages/Waiting').then((m) => m.WaitingPage));
const FirstRunPage = lazyPage(() => import('./pages/FirstRun').then((m) => m.FirstRunPage));
const Decisions = lazyPage(() => import('./pages/Decisions').then((m) => m.Decisions));
const DecisionDetailPage = lazyPage(() => import('./pages/DecisionDetail').then((m) => m.DecisionDetailPage));
const Issues = lazyPage(() => import('./pages/Issues').then((m) => m.Issues));
const IssueDetail = lazyPage(() => import('./pages/IssueDetail').then((m) => m.IssueDetail));
const Landing = lazyPage(() => import('./pages/Landing').then((m) => m.Landing));
const Agents = lazyPage(() => import('./pages/Agents').then((m) => m.Agents));
const ActivityPage = lazyPage(() => import('./pages/Activity').then((m) => m.ActivityPage));
const IntakePage = lazyPage(() => import('./pages/Intake').then((m) => m.IntakePage));
const Deploys = lazyPage(() => import('./pages/Deploys').then((m) => m.Deploys));
const Reports = lazyPage(() => import('./pages/Reports').then((m) => m.Reports));
const SettingsPage = lazyPage(() => import('./pages/Settings').then((m) => m.SettingsPage));
const LogsPage = lazyPage(() => import('./pages/Logs').then((m) => m.LogsPage));
const ExtendPage = lazyPage(() => import('./pages/Extend').then((m) => m.ExtendPage));
const ExperimentsPage = lazyPage(() => import('./pages/Experiments').then((m) => m.ExperimentsPage));
const RunDetail = lazyPage(() => import('./pages/RunDetail').then((m) => m.RunDetail));
const PullRequests = lazyPage(() => import('./pages/PullRequests').then((m) => m.PullRequests));
const HealthPage = lazyPage(() => import('./pages/Health').then((m) => m.HealthPage));

/** Each route's page chunk: the one shown is asked for at once (beside the first API calls), the rest when idle. */
const PAGE_FOR: [RegExp, { preload: () => Promise<unknown> }][] = [
  [/^\/$/, BoardPage],
  [/^\/overview/, Overview],
  [/^\/work\/prs/, PullRequests],
  [/^\/machine\/health/, HealthPage],
  [/^\/needs-you\/inbox/, InboxPage],
  [/^\/needs-you\/waiting/, WaitingPage],
  [/^\/needs-you\/decisions\/./, DecisionDetailPage],
  [/^\/needs-you\/decisions/, Decisions],
  [/^\/settings\/setup/, SetupPage],
  [/^\/work\/issues\/\d/, IssueDetail],
  [/^\/work\/issues/, Issues],
  [/^\/work\/intake/, IntakePage],
  [/^\/shipping\/land/, Landing],
  [/^\/agents\/activity/, ActivityPage],
  [/^\/agents/, Agents],
  [/^\/extend/, ExtendPage],
  [/^\/experiments/, ExperimentsPage],
  [/^\/shipping\/deploys/, Deploys],
  [/^\/machine\/reports/, Reports],
  [/^\/machine\/logs/, LogsPage],
  [/^\/machine/, MachinePage],
  [/^\/settings/, SettingsPage],
  [/^\/runs\//, RunDetail],
  [/^\/first-run/, FirstRunPage],
];
if (typeof window !== 'undefined') void (PAGE_FOR.find(([re]) => re.test(redirectFor(window.location.pathname) ?? window.location.pathname))?.[1] ?? BoardPage).preload();

export function navigate(to: string) {
  // A link to an old address (redirects.ts) goes straight to the new one: no entry for it in the history.
  const old = /^[^?#]*/.exec(to)![0];
  to = (redirectFor(old) ?? old) + to.slice(old.length);
  if (window.location.pathname === to) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useRoute() {
  const [path, setPath] = useState(() => landOn());
  useEffect(() => {
    const on = () => setPath(landOn());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

function useTheme(): [string, () => void] {
  const initial = (() => {
    try {
      return localStorage.getItem('dash-theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch {
      return 'light';
    }
  })();
  const [theme, setTheme] = useState(initial);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('dash-theme', theme);
    } catch {
      // per-viewer preference only
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

/** Typing in a field never triggers shortcuts. */
export function typing(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

// A `g` chord is pending until its second key. Page listeners run before the
// app's (React registers children first), so they must check this, or `g a`
// on the Decisions page would approve a decision on its way to Agents.
let chordUntil = 0;

/** Whether a page's single-key shortcut may act on this key. */
export function pageKey(e: KeyboardEvent) {
  return !typing(e) && !e.metaKey && !e.ctrlKey && !e.altKey && Date.now() >= chordUntil;
}

/**
 * A sidebar row. `roles`: only these see it (in the sidebar, the command menu and the chords); absent: everyone.
 * `when`: shown only where this says so of the state; absent: always. `tabs`: a group's pages (#585), each a tab under
 * the page header; the row opens the first one, on its key.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: typeof Bot;
  chord: string;
  testId: string;
  roles?: readonly Role[];
  when?: (state: NavState) => boolean;
  tabs?: readonly NavTab[];
}

/** A page inside a sidebar group: its own address and `g` key, and a tab in the group's tab row. */
export interface NavTab {
  to: string;
  label: string;
  chord: string;
  testId: string;
}

/** What of the state decides the sidebar's rows. */
export type NavState = Pick<State, 'setupMode' | 'role' | 'experiments'>;

// WHY (#585): nineteen sidebar rows became a handful of groups (the owner's list); every page kept its key, and its old
// address redirects (redirects.ts). The Setup console lives under Settings.
const NEEDS_YOU_TABS: readonly NavTab[] = [
  { to: '/needs-you/inbox', label: 'Inbox', chord: 'i', testId: 'tab-inbox' },
  { to: '/needs-you/waiting', label: 'Waiting on you', chord: 'w', testId: 'tab-waiting' },
  { to: '/needs-you/decisions', label: 'Decisions', chord: 'd', testId: 'tab-decisions' },
];
const WORK_TABS: readonly NavTab[] = [
  { to: '/', label: 'Board', chord: 'b', testId: 'tab-board' },
  { to: '/work/issues', label: 'Issues', chord: 's', testId: 'tab-issues' },
  { to: '/work/intake', label: 'Intake', chord: 'n', testId: 'tab-intake' },
  { to: '/work/prs', label: 'Pull requests', chord: 'p', testId: 'tab-prs' },
];
const SHIPPING_TABS: readonly NavTab[] = [
  { to: '/shipping/land', label: 'Land queue', chord: 'l', testId: 'tab-land' },
  { to: '/shipping/deploys', label: 'Deploys', chord: 'y', testId: 'tab-deploys' },
];
const AGENTS_TABS: readonly NavTab[] = [
  { to: '/agents', label: 'Agents', chord: 'a', testId: 'tab-agents' },
  { to: '/agents/activity', label: 'Activity', chord: 'e', testId: 'tab-activity' },
];
const MACHINE_TABS: readonly NavTab[] = [
  { to: '/machine', label: 'Machine', chord: 'm', testId: 'tab-machine' },
  { to: '/machine/health', label: 'Health', chord: 'h', testId: 'tab-health' },
  { to: '/machine/logs', label: 'Logs', chord: 'j', testId: 'tab-logs' },
  { to: '/machine/reports', label: 'Reports', chord: 'r', testId: 'tab-reports' },
];
const SETTINGS_TABS: readonly NavTab[] = [
  { to: '/settings', label: 'Settings', chord: ',', testId: 'tab-settings' },
  { to: '/settings/setup', label: 'Setup console', chord: 'u', testId: 'tab-setup' },
];

export const NAV: NavItem[] = [
  { to: '/needs-you/inbox', label: 'Needs you', icon: InboxIcon, chord: 'i', testId: 'nav-needs-you', tabs: NEEDS_YOU_TABS },
  { to: '/', label: 'Work', icon: SquareKanban, chord: 'b', testId: 'nav-work', tabs: WORK_TABS },
  { to: '/overview', label: 'Overview', icon: Gauge, chord: 'o', testId: 'nav-overview' },
  { to: '/shipping/land', label: 'Shipping', icon: Rocket, chord: 'l', testId: 'nav-shipping', tabs: SHIPPING_TABS },
  { to: '/agents', label: 'Agents', icon: Bot, chord: 'a', testId: 'nav-agents', tabs: AGENTS_TABS },
  // Automations (and Plugins, as another tab): what an instance does beyond its issues. Owners and writers only.
  { to: '/extend', label: 'Extend', icon: Puzzle, chord: 'x', testId: 'nav-extend', roles: ['owner', 'writer'] },
  // Experiments (#581): owners and writers, only where root's file turns experiments on for this instance (the server's
  // `experiments`; off, unknown or absent hides it). Its page still opens at its address, to say how to set it up.
  // A sidebar item of its own, not a Work tab (#585 keeps #581's choice).
  { to: '/experiments', label: 'Experiments', icon: FlaskConical, chord: 't', testId: 'nav-experiments', roles: ['owner', 'writer'], when: (s) => s.experiments === true },
  { to: '/machine', label: 'Machine', icon: Server, chord: 'm', testId: 'nav-machine', tabs: MACHINE_TABS },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, chord: ',', testId: 'nav-settings', tabs: SETTINGS_TABS },
];

/** First run: the one page in setup mode (it isn't in NAV: once configured, Settings links to it). */
export const FIRST_RUN_NAV = { to: '/first-run', label: 'First run', icon: ListChecks, chord: 'f', testId: 'nav-first-run' };

/**
 * WHY (#468): in setup mode (no config yet) nothing but First run has anything to show, so the sidebar, the command
 * menu and the `g` chords offer First run alone. (The Setup console is a server's; setup mode is a checkout's only.)
 */
export const navFor = (state: NavState | null): NavItem[] =>
  state?.setupMode ? [FIRST_RUN_NAV] : NAV.filter((n) => (!n.roles || (!!state?.role && n.roles.includes(state.role))) && (!n.when || (!!state && n.when(state))));

/** Every page this person can open, a group's tabs in its place, with the group's icon: the command menu's and the `g` keys'. */
export const pagesFor = (state: NavState | null): (NavTab & { icon: typeof Bot })[] => navFor(state).flatMap((n) => (n.tabs ?? [n]).map((t) => ({ to: t.to, label: t.label, chord: t.chord, testId: t.testId, icon: n.icon })));

/** Whether a path is at an address or under it ('/' only itself). */
const under = (path: string, to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));

/** The sidebar row a path is on, and its tab in a group: the longest address it is at or under. Null: none (a run, First run). */
export function placeOf(path: string): { row: NavItem; tab: NavTab | null } | null {
  let best: { row: NavItem; tab: NavTab | null } | null = null;
  let len = -1;
  for (const row of NAV) {
    for (const t of row.tabs ?? [row]) {
      if (under(path, t.to) && t.to.length > len) {
        best = { row, tab: row.tabs ? t : null };
        len = t.to.length;
      }
    }
  }
  return best;
}

/**
 * The sidebar's badges, by row (its test id), and each tab's, by address. Needs you: each open decision once (the
 * Inbox's are among them) and each of your blocked tasks; Work: the PRs waiting for you, as the Pull requests row had.
 */
export function navCounts(state: Pick<State, 'decisions' | 'inbox' | 'tasks' | 'landQueue' | 'prCounts' | 'runs'> | null): Counts {
  const open = state?.decisions.filter((d) => !d.answer) ?? [];
  const tabs = {
    '/needs-you/inbox': state ? state.inbox.decisions.length + state.inbox.blocked.length : 0,
    '/needs-you/decisions': open.length,
    '/work/issues': state?.tasks.filter((t) => !['done', 'released', 'triage'].includes(t.status)).length ?? 0,
    '/shipping/land': state?.landQueue.length ?? 0,
    '/work/prs': state?.prCounts?.needYou ?? 0,
    '/agents': state?.runs?.active.length ?? 0,
  };
  const needsYou = state ? new Set([...open, ...state.inbox.decisions].map((d) => d.id)).size + state.inbox.blocked.length : 0;
  return { ...tabs, 'nav-needs-you': needsYou, 'nav-work': tabs['/work/prs'], 'nav-shipping': tabs['/shipping/land'], 'nav-agents': tabs['/agents'] };
}

/** Badges that ask for the person: amber. */
const WARN = new Set(['nav-needs-you', 'nav-work', '/needs-you/inbox', '/needs-you/decisions', '/work/prs']);

/** The tab row the page header draws: the group the page is in, its tabs, the one shown, and their badges. */
export const GroupTabs = createContext<{ label: string; tabs: readonly NavTab[]; active: string; counts: Counts } | null>(null);

/** The group's tab row for a path, or null (a page that isn't in a group, or setup mode). */
export function tabsAt(path: string, state: NavState | null, counts: Counts) {
  const at = state && !state.setupMode ? placeOf(path) : null;
  return at?.tab && at.row.tabs ? { label: at.row.label, tabs: at.row.tabs, active: at.tab.to, counts } : null;
}

/** Under the page header: the tabs of the group the page is in, each its own address (as Extend's tabs). */
export function GroupTabRow() {
  const g = useContext(GroupTabs);
  if (!g) return null;
  return (
    <nav className="flex flex-wrap gap-1 border-b border-line px-6 max-md:px-4" aria-label={g.label} data-testid="group-tabs">
      {g.tabs.map((t) => (
        <a
          key={t.to}
          href={t.to}
          onClick={(e) => (e.preventDefault(), navigate(t.to))}
          className={cx('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-1.5 text-[12.5px] max-md:min-h-11', t.to === g.active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink')}
          aria-current={t.to === g.active ? 'page' : undefined}
          data-testid={t.testId}
        >
          {t.label}
          {!!g.counts[t.to] && <span className={cx('rounded-full px-1.5 text-[11.5px] font-medium tabular-nums', WARN.has(t.to) ? 'bg-orange-tint text-orange' : 'text-ink-3')}>{g.counts[t.to]}</span>}
        </a>
      ))}
    </nav>
  );
}

/** Setup mode, at the address of a page that isn't shown yet: what it needs, and the way to First run. */
export function SetupModeHidden({ path }: { path: string }) {
  const at = placeOf(redirectFor(path) ?? path);
  const page = at?.tab?.label ?? at?.row.label ?? 'This page';
  return (
    <div data-testid="setup-mode-hidden">
      <Header title={page} sub="not set up yet" />
      <div className="mx-auto max-w-3xl space-y-2 p-4 sm:p-6">
        <p className="text-[13px] text-ink" data-testid="setup-mode-hidden-why">
          {page} shows once this checkout has its config, and it has none yet.
        </p>
        <p className="text-[12.5px] text-ink-2">First run sets it up: it picks the GitHub repo, drafts the config, and merges its PR. Every page opens here after that.</p>
        <a href="/first-run" onClick={(e) => (e.preventDefault(), navigate('/first-run'))} className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="setup-mode-hidden-link">
          Open First run
        </a>
      </div>
    </div>
  );
}

function CommandMenu({ open, setOpen, state, toggleTheme }: { open: boolean; setOpen: (v: boolean) => void; state: State | null; toggleTheme: () => void }) {
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-window bg-surface shadow-overlay" style={{ animation: 'pop-in 160ms cubic-bezier(0.23,1,0.32,1) both' }} aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Command label="Command menu" data-testid="command-menu" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-ink-3" />
              <Command.Input autoFocus placeholder="Go to a page, an issue, or run an action…" className="h-11 w-full bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-3" />
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="p-6 text-center text-[13px] text-ink-3">No results.</Command.Empty>
              <Command.Group heading="Pages">
                {pagesFor(state).map((n) => (
                  <Item key={n.to} onSelect={() => go(n.to)} hint={`g ${n.chord}`}>
                    <n.icon className="size-4" /> {n.label}
                  </Item>
                ))}
              </Command.Group>
              {!!state?.decisions.filter((d) => !d.answer).length && (
                <Command.Group heading="Open decisions">
                  {state.decisions.filter((d) => !d.answer).map((d) => (
                    <Item key={d.id} onSelect={() => go(`/decisions#${d.id}`)}>
                      <Vote className="size-4" /> {d.issue ? `#${d.issue} ` : ''}
                      {d.question}
                    </Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Issues">
                {state?.tasks.slice(0, 200).map((t) => (
                  <Item key={t.issue} value={`#${t.issue} ${t.title}`} onSelect={() => go(`/issues/${t.issue}`)}>
                    <span className="w-10 font-mono text-[12px] text-ink-3">#{t.issue}</span> {t.title}
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading="Views">
                {['Mine', 'Collaborator', 'Money-path', 'Blocked'].map((v) => (
                  <Item key={v} onSelect={() => go(`/issues?view=${encodeURIComponent(v)}`)}>
                    <ListChecks className="size-4" /> Issues: {v}
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading="Actions">
                <Item
                  onSelect={() => {
                    toggleTheme();
                    setOpen(false);
                  }}
                >
                  <Moon className="size-4" /> Toggle dark mode
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Item({ children, onSelect, hint, value }: { children: React.ReactNode; onSelect: () => void; hint?: string; value?: string }) {
  return (
    <Command.Item onSelect={onSelect} {...(value ? { value } : {})} className="flex h-9 cursor-pointer items-center gap-2 rounded-control px-2 text-[13.5px] text-ink data-[selected=true]:bg-hover-2">
      {children}
      {hint && (
        <span className="ml-auto">
          <Kbd>{hint}</Kbd>
        </span>
      )}
    </Command.Item>
  );
}

/** The hub's sign-in page: one way in, with GitHub; what you may do then is your role on each instance's repo. */
export function SignInPage({ brand, local = false }: { brand?: string; local?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6" data-testid="sign-in">
      <div className="w-[min(380px,100%)] rounded-card bg-surface p-6 shadow-card">
        <h1 className="text-[17px] font-semibold text-ink">Sign in{brand ? ` to ${brand}` : ''}</h1>
        <p className="mt-2 text-[13px] leading-5 text-ink-2">
          Sign in with your GitHub account. You see the instances whose repo you can read; what you may do on each follows your permission there (admin: owner; write: writer; read: viewer).
        </p>
        <a href="/auth/login" data-testid="sign-in-github" className="mt-5 flex h-9 items-center justify-center rounded-control bg-ink text-[13.5px] font-medium text-surface hover:opacity-90">
          Sign in with GitHub
        </a>
        {local && (
          <div className="mt-6 border-t border-line pt-4" data-testid="sign-in-key">
            <p className="text-[12.5px] leading-5 text-ink-2">On this machine, before the sign-in App is set up: the owner's dashboard key.</p>
            <KeyForm hub />
          </div>
        )}
      </div>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: 'owner', writer: 'writer', viewer: 'viewer' };

/**
 * Who this page is for and their role here; a signed-in person can sign out (the key has no session).
 * WHY (#468): the key with no person named is "break-glass" only on the hub's break-glass port; on a checkout's (or an
 * instance's) own dashboard it is simply the owner on this machine, and "break-glass" there read as an alarm.
 */
export function WhoAmI({ state, onSignOut, hubPage = servedByHub }: { state: Pick<State, 'user' | 'role' | 'via'>; onSignOut?: () => void; hubPage?: boolean }) {
  const glass = state.via === 'break-glass';
  const how = !glass ? null : hubPage ? 'break-glass' : 'this machine';
  return (
    <div className="mx-2 flex items-center gap-2 px-2 pt-2 text-[11.5px] text-ink-3" data-testid="who-am-i">
      <span className="min-w-0 truncate" title={!glass ? (state.role === 'viewer' ? 'signed in with GitHub; read-only here' : 'signed in with GitHub') : hubPage ? "the owner's break-glass on this machine" : "this dashboard's key, on this machine"}>
        <span className="font-medium text-ink-2" data-testid="who-login">@{state.user}</span>
        {state.role && (
          <span data-testid="who-role">
            {' · '}
            {ROLE_LABEL[state.role] ?? state.role}
            {how ? ` (${how})` : ''}
          </span>
        )}
      </span>
      {!glass && onSignOut && (
        <button data-testid="sign-out" onClick={onSignOut} className="primitive-icon-button ml-auto size-7 text-ink-3 hover:bg-hover-2 hover:text-ink" title="Sign out" aria-label="Sign out">
          <LogOut className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function App() {
  // Known before anything asks the server for state, so a signed-out page makes no call that would be refused.
  // And the scope (which instance this page shows), so every view can start from what was kept for it.
  const [signIn, setSignIn] = useState<boolean | null>(null);
  useEffect(() => {
    void needsSignIn.then((n) => (n ? setSignIn(n) : instanceScope.then(() => setSignIn(n))));
  }, []);
  if (signIn === null) return <Loading />;
  if (signIn) return <SignInPage local={onLoopback} />;
  if (keyMissing) return <KeyPage />;
  return <Dashboard />;
}

/**
 * The dashboard for the scope shown. Keyed on it: an instance switch (no reload) mounts it again, so no view holds
 * the last instance's data, and each starts from what was kept for the new one (web/src/cache.ts). The status dots
 * are the hub's, the same whichever instance is shown, so they stay across a switch.
 */
function Dashboard() {
  const scope = useScope();
  const health = useHealth();
  return <InstanceDashboard key={scopeKey(scope)} health={health} />;
}

/** The views likely to be opened next, by page: the Board's, the Overview's and the PR page's. */
const NEXT_VIEWS = ['/api/board', '/api/test-runs', '/api/prs'];

/**
 * Once the page shown has its state, in the background: the other pages' code, then this instance's likely next
 * views, then each other instance's state and board (only what isn't kept yet). Cancelled when the page goes.
 */
function usePrefetch(ready: boolean, current: string | null) {
  useEffect(() => {
    if (!ready) return;
    const tasks: (() => Promise<unknown>)[] = PAGE_FOR.map(([, p]) => () => p.preload());
    const want = (path: string, inst?: string | null) => {
      tasks.push(() => (peek(viewUrl(path, inst)) ? Promise.resolve() : prefetchView(path, inst)));
    };
    for (const v of NEXT_VIEWS) want(v);
    for (const i of hubNow()?.instances ?? []) {
      if (!i.up || i.name === current) continue;
      want('/api/state', i.name);
      want('/api/board', i.name);
      want('/api/test-runs', i.name);
    }
    let cancel = () => {};
    // After the page's own first paint and its first requests.
    const stopIdle = idle(() => (cancel = background(tasks)), 1000);
    return () => {
      stopIdle();
      cancel();
    };
  }, [ready, current]);
}

/** The small "updating…" mark while a view is shown from what was kept and its fresh answer is on its way. */
function UpdatingMark() {
  const updating = useUpdating();
  if (!updating) return null;
  return (
    <div className="pointer-events-none fixed right-3 top-3 z-30 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-3 shadow-btn" role="status" data-testid="updating">
      updating…
    </div>
  );
}

function InstanceDashboard({ health }: { health: Health | null }) {
  const path = useRoute();
  const scope = useScope();
  const { state, error, live, pulse, refresh } = useLiveState();
  usePrefetch(!!state, scope?.current ?? null);
  // The Claude usage limit: every instance's pause (a banner on every page) and usage (the Overview's lines).
  const { usage, answered: usageAnswered } = useUsage(state?.lastId);
  const now = useNow(usage.some((u) => u.paused));
  const [theme, toggleTheme] = useTheme();
  const [menu, setMenu] = useState(false);
  // The narrow-screen navigation drawer: closed on every change of page.
  const [nav, setNav] = useState(false);
  useEffect(() => setNav(false), [path]);
  const [voice] = useVoicePrefs();
  // The `g` keys: every page's, a group's tabs included.
  const navNow = useRef(pagesFor(null));
  navNow.current = pagesFor(state);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMenu((m) => !m);
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (Date.now() < chordUntil) {
        const n = navNow.current.find((x) => x.chord === e.key);
        chordUntil = 0;
        if (n) {
          e.preventDefault();
          navigate(n.to);
        }
        return;
      }
      if (e.key === 'g') chordUntil = Date.now() + 1200;
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    if (state) document.title = `${state.project.name} · ${state.brand.name}`;
  }, [state]);

  const counts = useMemo(() => navCounts(state), [state]);

  const issueMatch = path.match(/^\/work\/issues\/(\d+)/);
  const runMatch = path.match(/^\/runs\/([A-Za-z0-9_-]+)$/);
  const decisionMatch = path.match(/^\/needs-you\/decisions\/([A-Za-z0-9._-]+)$/);
  let page: React.ReactNode;
  // Can't load: still a header, so the menu (and every other page) stays reachable on a narrow screen.
  if (!state) page = error ? <><Header title="Can't load" /><div className="p-8 text-[13px] text-red">Can't load: {error}</div></> : <Loading />;
  // The page waits for the usage's first answer too: a pause's banner goes above it, and appearing after the page
  // would move every control on it (#455: 83 px). The usage is asked for at the same time as the state; a usage that
  // hasn't answered in USAGE_WAIT_MS (3 s) no longer holds the page.
  else if (!usageAnswered) page = <Loading />;
  // WHY: setup mode (no config yet) serves the first-run page alone; any other page's address says what it needs (#468).
  else if (state.setupMode) page = path === '/' || path === '/first-run' ? <FirstRunPage state={state} /> : <SetupModeHidden path={path} />;
  else if (path === '/needs-you/inbox') page = <InboxPage state={state} />;
  else if (path === '/needs-you/waiting') page = <WaitingPage state={state} />;
  else if (path === '/needs-you/decisions') page = <Decisions state={state} />;
  else if (decisionMatch) page = <DecisionDetailPage state={state} id={decisionMatch[1]!} />;
  else if (path === '/settings/setup') page = <SetupPage />;
  else if (path === '/first-run') page = <FirstRunPage state={state} />;
  else if (runMatch) page = <RunDetail id={runMatch[1]!} refused={runsRefusal(state)} />;
  else if (issueMatch) page = <IssueDetail state={state} issue={Number(issueMatch[1])} />;
  else if (path.startsWith('/work/issues')) page = <Issues state={state} />;
  else if (path === '/shipping/land') page = <Landing state={state} />;
  else if (path === '/work/prs') page = <PullRequests state={state} />;
  else if (path === '/agents') page = <Agents state={state} />;
  else if (path === '/extend' || path.startsWith('/extend/')) page = <ExtendPage state={state} path={path} />;
  else if (path === '/experiments' || path.startsWith('/experiments/')) page = <ExperimentsPage state={state} path={path} />;
  else if (path === '/agents/activity') page = <ActivityPage state={state} />;
  else if (path === '/work/intake') page = <IntakePage state={state} />;
  else if (path === '/shipping/deploys') page = <Deploys state={state} />;
  else if (path === '/machine/reports') page = <Reports state={state} pulse={pulse} />;
  else if (path === '/settings') page = <SettingsPage owner={state.role === 'owner'} brand={state.brand.name} />;
  else if (path === '/machine/logs') page = <LogsPage refused={logsRefusal(state)} />;
  else if (path === '/machine/health') page = <HealthPage />;
  else if (path === '/machine') page = <MachinePage state={state} />;
  else if (path === '/overview') page = <Overview state={state} pulse={pulse} usage={usage} now={now} />;
  else page = <BoardPage state={state} pulse={pulse} />;

  const sidebar = { state, all: !!scope?.all, path, counts, health, live, theme, toggleTheme, openSearch: () => (setNav(false), setMenu(true)), switcher: <InstanceSwitcher status={health?.status ?? {}} why={health?.why} live={health?.hub} /> };
  return (
    <NavMenu.Provider value={{ open: nav, setOpen: setNav }}>
      <div className="flex h-full">
        <aside className="flex w-56 shrink-0 flex-col bg-canvas max-md:hidden">
          <SidebarBody {...sidebar} />
        </aside>
        <main className="min-w-0 flex-1 scroll-pt-14 overflow-y-auto max-md:pb-20">
          {state && <StopBanner state={state} />}
          <UsageBanner usage={usage} now={now} />
          {state && <MainWatchAlert protection={state.protection} onCleared={() => void refresh()} />}
          <GroupTabs.Provider value={tabsAt(path, state, counts)}>
            <Entrances key={path}>
              <Suspense fallback={<Loading />}>{page}</Suspense>
            </Entrances>
          </GroupTabs.Provider>
        </main>
        <UpdatingMark />
        <NavDrawer open={nav} setOpen={setNav}>
          <SidebarBody {...sidebar} />
        </NavDrawer>
        <CommandMenu open={menu} setOpen={setMenu} state={state} toggleTheme={toggleTheme} />
        {state && <ChatPanel cli={state.brand.cli} role={state.role} user={state.user} />}
        {state && <WakeWord role={state.role} brand={state.brand.name} />}
        {state && <VoiceControl state={state} prefs={voice} />}
      </div>
    </NavMenu.Provider>
  );
}

type Counts = Partial<Record<string, number>>;
type Health = { hub: HubInfo | null; status: Record<string, DotStatus>; why?: Record<string, string> };

/**
 * The sidebar's contents: the project and its status dot (off a hub), the instance list (on a hub), Search, the pages,
 * who is signed in, the live indicator and the theme toggle. The desktop sidebar and the narrow-screen drawer show the
 * same one. `all`: "All instances" is chosen on a hub, so the header says that, not the instance whose state this is (#562).
 */
export function SidebarBody({ state, all = false, path, counts, health, live, theme, toggleTheme, openSearch, switcher }: { state: State | null; all?: boolean; path: string; counts: Counts; health: Health | null; live: boolean; theme: string; toggleTheme: () => void; openSearch: () => void; switcher: ReactNode }) {
  return (
    <>
      <div className="flex h-12 items-center gap-2 px-4">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface">{state?.brand.name[0] ?? '·'}</div>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium leading-4 text-ink" data-testid="sidebar-title">
            {all ? 'All instances' : (state?.project.name ?? '…')}
          </div>
          <div className="truncate text-[11px] leading-4 text-ink-3">{state?.brand.name}</div>
        </div>
        {/* Off a hub, this instance's status dot (on a hub, each instance's row has its own). */}
        {health && !health.hub && (
          <a href="/machine/health" className="ml-auto" onClick={(e) => (e.preventDefault(), navigate('/machine/health'))} title="Health">
            <StatusDot status={health.status[''] ?? 'green'} why={health.why?.['']} testId="instance-status-dot" />
          </a>
        )}
      </div>
      {switcher}
      <button data-testid="search-button" onClick={openSearch} className="mx-2 mt-2 flex h-8 items-center gap-2 rounded-control bg-surface px-2 text-[12.5px] text-ink-3 shadow-btn transition-colors hover:text-ink">
        <Search className="size-3.5" /> Search <span className="ml-auto"><Kbd>⌘K</Kbd></span>
      </button>
      <nav className="mt-3 flex flex-col gap-px px-2" aria-label="Pages">
        {navFor(state).map((n) => (
          <SidebarRow
            key={n.to}
            href={n.to}
            icon={<n.icon className="size-4" />}
            label={n.label}
            count={counts[n.testId]}
            countTone={WARN.has(n.testId) ? 'warn' : undefined}
            active={n === FIRST_RUN_NAV ? path === '/' || path === '/first-run' : placeOf(path)?.row === n}
            onSelect={() => navigate(n.to)}
            testId={n.testId}
          />
        ))}
      </nav>
      {state && (
        <div className="mt-auto border-t border-line">
          <WhoAmI state={state} onSignOut={() => void signOut()} />
        </div>
      )}
      <div className={cx('mx-2 mb-2 flex items-center gap-2 px-2 pt-2 text-[11.5px] text-ink-3', !state && 'mt-auto border-t border-line pt-3')}>
        <span data-testid="live-indicator" className={cx('inline-block size-2 rounded-full', live ? 'bg-green' : 'bg-red')} title={live ? 'live: updates stream from the event log' : 'disconnected; retrying'} />
        {live ? 'Live' : 'Reconnecting'}
        <span className="ml-auto flex items-center gap-1 tabular-nums">
          <Activity className="size-3" /> {state?.lastId ?? 0}
        </span>
        <button data-testid="theme-toggle" onClick={toggleTheme} className="primitive-icon-button size-7 text-ink-3 hover:bg-hover-2 hover:text-ink" title="Toggle theme" aria-label="Toggle theme">
          {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
      </div>
    </>
  );
}

/** Whether the narrow-screen navigation drawer is open; the page header's menu button opens it. */
export const NavMenu = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null);

/** The id of the drawer the menu button controls. */
export const NAV_DRAWER_ID = 'nav-drawer';

/** On a narrow screen (under 768 px, where the sidebar is hidden): the button in the page header that opens the navigation drawer. */
export function MenuButton() {
  const menu = useContext(NavMenu);
  if (!menu) return null;
  return (
    <button
      type="button"
      data-testid="nav-menu"
      className="primitive-icon-button -ml-2 shrink-0 text-ink-2 hover:bg-hover-2 hover:text-ink md:hidden"
      aria-label="Open navigation"
      aria-haspopup="dialog"
      aria-expanded={menu.open}
      aria-controls={NAV_DRAWER_ID}
      onClick={() => menu.setOpen(!menu.open)}
    >
      <Menu className="size-5" />
    </button>
  );
}

/**
 * The sidebar as a drawer on a narrow screen, over the page with an overlay. Focus moves into it and back to the menu
 * button after; it closes on the overlay, Escape, its close button and a change of page (the Dashboard closes it), and
 * when the screen widens to where the sidebar shows.
 */
export function NavDrawer({ open, setOpen, children }: { open: boolean; setOpen: (open: boolean) => void; children: ReactNode }) {
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia('(min-width: 768px)');
    const on = () => wide.matches && setOpen(false);
    on();
    wide.addEventListener('change', on);
    return () => wide.removeEventListener('change', on);
  }, [open, setOpen]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 md:hidden" style={{ animation: 'fade-in 160ms ease-out both' }} data-testid="nav-drawer-overlay" />
      <Dialog.Content
        id={NAV_DRAWER_ID}
        data-testid="nav-drawer"
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          // Back to the menu button: the one that opened the drawer, or the new page's after a change of page.
          e.preventDefault();
          document.querySelector<HTMLElement>('[data-testid="nav-menu"]')?.focus();
        }}
        className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col overflow-y-auto bg-canvas shadow-overlay md:hidden"
        style={{ animation: 'drawer-in 200ms cubic-bezier(0.23,1,0.32,1) both' }}
      >
        <div className="flex items-center justify-between px-2 pt-2">
          <Dialog.Title className="px-2 text-[12px] font-medium text-ink-3">Navigation</Dialog.Title>
          <Dialog.Close className="primitive-icon-button text-ink-3 hover:bg-hover-2 hover:text-ink" aria-label="Close navigation" data-testid="nav-drawer-close">
            <X className="size-5" />
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * On a hub: its instances as sidebar rows (only those this person has a role on); the selected one is active, one
 * that isn't answering is marked and can't be picked. With two or more, an explicit "All instances" row, off unless
 * chosen: the Board and its test runs then show every instance, each item labelled; every other page stays on the
 * selected instance.
 */
export function InstanceList({ hub: info, current, all = false, onSelect, onSelectAll = () => {}, status = {}, why = {} }: { hub: HubInfo; current: string; all?: boolean; onSelect: (name: string) => void; onSelectAll?: () => void; status?: Record<string, DotStatus>; why?: Record<string, string> }) {
  return (
    <nav className="mt-1 flex flex-col gap-px px-2" aria-label="Instances" data-instance-switcher data-testid="instance-switcher" data-scope={all ? 'all' : current}>
      <div className="px-2 pt-1 pb-1 text-[11.5px] font-medium text-ink-3">Instances</div>
      {info.instances.map((i) => (
        <SidebarRow
          key={i.name}
          icon={<StatusDot status={i.up ? (status[i.name] ?? 'green') : 'red'} why={i.up ? why[i.name] : (i.error ?? "its dashboard isn't answering")} testId="instance-dot" />}
          label={i.up ? i.name : `${i.name} (not answering)`}
          title={i.error ?? undefined}
          active={!all && i.name === current}
          disabled={!i.up && i.name !== current}
          onSelect={() => (all || i.name !== current) && onSelect(i.name)}
          testId="instance-row"
        />
      ))}
      {info.instances.length > 1 && (
        <SidebarRow icon={<Layers size={15} />} label="All instances" title="The Board and its test runs for every instance you have a role on, each labelled" active={all} onSelect={() => !all && onSelectAll()} testId="instance-all" />
      )}
      {all && (
        <div className="px-2 pt-1 text-[11.5px] text-ink-3" data-testid="instance-all-note">
          The Board shows every instance; the other pages show {current}.
        </div>
      )}
    </nav>
  );
}

/**
 * On a hub: which instance this page shows (or All instances, for the Board), and a switch to the others (each served
 * by its own dashboard). `live`: the hub's list as the last health refresh read it, so an instance that was down at
 * page load and is up again can be picked without a reload.
 */
function InstanceSwitcher({ status, why, live }: { status: Record<string, DotStatus>; why?: Record<string, string> | undefined; live?: HubInfo | null | undefined }) {
  const scope = useScope();
  const info = live ?? hubNow();
  if (!info || !scope?.current) return null;
  return <InstanceList hub={info} current={scope.current} all={scope.all} onSelect={selectInstance} onSelectAll={selectAllInstances} status={status} {...(why ? { why } : {})} />;
}

/**
 * Each instance's status dot (green, amber, red; grey when its status couldn't be read) from its watchdog incidents,
 * read again every minute, with the hub's list asked again each time (healthPass).
 */
function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let live = true;
    let first = true;
    // The first pass uses the list this page loaded with; every later one asks the hub again.
    const load = () => {
      const pass = first ? healthPass(() => hub) : healthPass();
      first = false;
      void pass.then((x) => live && setHealth(x));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return health;
}

/** Read-only: an emergency stop in force on this machine, shown on every page. It is lifted on the machine itself. */
export function StopBanner({ state }: { state: State }) {
  const e = state.emergency;
  if (!e?.inForce) return null;
  return (
    <div role="alert" className="mx-6 mt-4 rounded-card bg-red-tint px-4 py-3 text-[13px] shadow-[0_0_0_1px_var(--red-tint)]" data-emergency-stop data-testid="emergency-stop">
      <span className="font-semibold text-red">Emergency stop in force</span>
      <span className="text-ink-2">
        {' '}
        since {e.inForce.at ? ago(e.inForce.at) : 'an unknown time'}, by {e.inForce.by}: {e.inForce.reason}.{' '}
        {e.halted ? `This coordinator halted ${e.halted.running} running agent(s) ${ago(e.halted.at)} and starts none.` : "This coordinator hasn't confirmed it yet."} Agents on this
        machine stay stopped until it's lifted on the machine with <code className="rounded-chip bg-surface px-1 font-mono text-[12px] shadow-hairline">{state.brand.cli} resume-all</code>.
      </span>
    </div>
  );
}

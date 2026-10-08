import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Activity, BarChart3, Bot, GitMerge, Gauge, History, Inbox as InboxIcon, ListChecks, Moon, Rocket, Search, Settings as SettingsIcon, Sun, Vote } from 'lucide-react';
import { useLiveState, type State } from './api';
import { Kbd, cx } from './components/ui';
import { Overview } from './pages/Overview';
import { InboxPage } from './pages/Inbox';
import { Decisions } from './pages/Decisions';
import { Issues } from './pages/Issues';
import { IssueDetail } from './pages/IssueDetail';
import { Landing } from './pages/Landing';
import { Agents } from './pages/Agents';
import { ActivityPage } from './pages/Activity';
import { Deploys } from './pages/Deploys';
import { Reports } from './pages/Reports';
import { SettingsPage } from './pages/Settings';

export function navigate(to: string) {
  if (window.location.pathname === to) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
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

const NAV = [
  { to: '/', label: 'Overview', icon: Gauge, chord: 'o' },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, chord: 'i' },
  { to: '/decisions', label: 'Decisions', icon: Vote, chord: 'd' },
  { to: '/issues', label: 'Issues', icon: ListChecks, chord: 's' },
  { to: '/land', label: 'Land queue', icon: GitMerge, chord: 'l' },
  { to: '/agents', label: 'Agents', icon: Bot, chord: 'a' },
  { to: '/activity', label: 'Activity', icon: History, chord: 'e' },
  { to: '/deploys', label: 'Deploys', icon: Rocket, chord: 'y' },
  { to: '/reports', label: 'Reports', icon: BarChart3, chord: 'r' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, chord: ',' },
];

function CommandMenu({ open, setOpen, state, toggleTheme }: { open: boolean; setOpen: (v: boolean) => void; state: State | null; toggleTheme: () => void }) {
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Command label="Command menu" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted-foreground" />
              <Command.Input autoFocus placeholder="Go to a page, an issue, or run an action…" className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="p-6 text-center text-sm text-muted-foreground">No results.</Command.Empty>
              <Command.Group heading="Pages">
                {NAV.map((n) => (
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
                    <span className="w-10 font-mono text-xs text-muted-foreground">#{t.issue}</span> {t.title}
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
    <Command.Item onSelect={onSelect} {...(value ? { value } : {})} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm data-[selected=true]:bg-accent">
      {children}
      {hint && (
        <span className="ml-auto">
          <Kbd>{hint}</Kbd>
        </span>
      )}
    </Command.Item>
  );
}

export function App() {
  const path = useRoute();
  const { state, error, live, pulse } = useLiveState();
  const [theme, toggleTheme] = useTheme();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMenu((m) => !m);
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (Date.now() < chordUntil) {
        const n = NAV.find((x) => x.chord === e.key);
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

  const counts = useMemo(
    () => ({
      '/inbox': state ? state.inbox.decisions.length + state.inbox.blocked.length : 0,
      '/decisions': state?.decisions.filter((d) => !d.answer).length ?? 0,
      '/issues': state?.tasks.filter((t) => !['done', 'released', 'triage'].includes(t.status)).length ?? 0,
      '/land': state?.landQueue.length ?? 0,
      '/agents': state?.runs.active.length ?? 0,
    }),
    [state],
  );

  const issueMatch = path.match(/^\/issues\/(\d+)/);
  let page: React.ReactNode;
  if (!state) page = <div className="p-8 text-sm text-muted-foreground">{error ? `Can't load: ${error}` : 'Loading…'}</div>;
  else if (path === '/inbox') page = <InboxPage state={state} />;
  else if (path === '/decisions') page = <Decisions state={state} />;
  else if (issueMatch) page = <IssueDetail state={state} issue={Number(issueMatch[1])} />;
  else if (path.startsWith('/issues')) page = <Issues state={state} />;
  else if (path === '/land') page = <Landing state={state} />;
  else if (path === '/agents') page = <Agents state={state} />;
  else if (path === '/activity') page = <ActivityPage state={state} />;
  else if (path === '/deploys') page = <Deploys state={state} />;
  else if (path === '/reports') page = <Reports state={state} pulse={pulse} />;
  else if (path === '/settings') page = <SettingsPage />;
  else page = <Overview state={state} pulse={pulse} />;

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/40 max-md:hidden">
        <div className="flex h-12 items-center gap-2 border-b px-4">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">{state?.brand.name[0] ?? '·'}</div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-4">{state?.project.name ?? '…'}</div>
            <div className="truncate text-[11px] text-muted-foreground leading-4">{state?.brand.name}</div>
          </div>
        </div>
        <button onClick={() => setMenu(true)} className="mx-3 mt-3 flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-xs text-muted-foreground hover:bg-accent">
          <Search className="size-3.5" /> Search <span className="ml-auto"><Kbd>⌘K</Kbd></span>
        </button>
        <nav className="mt-3 flex flex-col gap-0.5 px-2">
          {NAV.map((n) => {
            const active = n.to === '/' ? path === '/' : path.startsWith(n.to);
            const count = counts[n.to as keyof typeof counts];
            return (
              <a
                key={n.to}
                href={n.to}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(n.to);
                }}
                className={cx('flex h-8 items-center gap-2 rounded-md px-2 text-sm', active ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
              >
                <n.icon className="size-4" /> {n.label}
                {!!count && <span className={cx('ml-auto rounded px-1.5 text-[11px] font-medium', n.to === '/decisions' || n.to === '/inbox' ? 'bg-warn/25 text-foreground' : 'text-muted-foreground')}>{count}</span>}
              </a>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center gap-2 border-t px-4 py-3 text-[11px] text-muted-foreground">
          <span className={cx('inline-block size-2 rounded-full', live ? 'bg-ok' : 'bg-danger')} title={live ? 'live: updates stream from the event log' : 'disconnected; retrying'} />
          {live ? 'Live' : 'Reconnecting'}
          <span className="ml-auto flex items-center gap-1">
            <Activity className="size-3" /> {state?.lastId ?? 0}
          </span>
          <button onClick={toggleTheme} className="rounded p-1 hover:bg-accent" title="Toggle theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{page}</main>
      <CommandMenu open={menu} setOpen={setMenu} state={state} toggleTheme={toggleTheme} />
    </div>
  );
}

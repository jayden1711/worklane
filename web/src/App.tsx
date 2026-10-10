import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Activity, BarChart3, Bot, GitMerge, Gauge, History, ScrollText, Inbox as InboxIcon, ListChecks, Moon, Rocket, Search, Settings as SettingsIcon, Sun, Vote } from 'lucide-react';
import { hub, hubInstance, selectInstance, useLiveState, type HubInfo, type State } from './api';
import { Loading, SidebarRow } from './components/patterns';
import { ago, Kbd, cx } from './components/ui';
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
import { LogsPage } from './pages/Logs';
import { RunDetail } from './pages/RunDetail';

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
  { to: '/logs', label: 'Logs', icon: ScrollText, chord: 'j' },
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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-window bg-surface shadow-overlay" style={{ animation: 'pop-in 160ms cubic-bezier(0.23,1,0.32,1) both' }} aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Command label="Command menu" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-ink-3" />
              <Command.Input autoFocus placeholder="Go to a page, an issue, or run an action…" className="h-11 w-full bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:text-ink-3" />
            </div>
            <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
              <Command.Empty className="p-6 text-center text-[13px] text-ink-3">No results.</Command.Empty>
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
  const runMatch = path.match(/^\/runs\/([A-Za-z0-9_-]+)$/);
  let page: React.ReactNode;
  if (!state) page = error ? <div className="p-8 text-[13px] text-red">Can't load: {error}</div> : <Loading />;
  else if (path === '/inbox') page = <InboxPage state={state} />;
  else if (path === '/decisions') page = <Decisions state={state} />;
  else if (runMatch) page = <RunDetail id={runMatch[1]!} />;
  else if (issueMatch) page = <IssueDetail state={state} issue={Number(issueMatch[1])} />;
  else if (path.startsWith('/issues')) page = <Issues state={state} />;
  else if (path === '/land') page = <Landing state={state} />;
  else if (path === '/agents') page = <Agents state={state} />;
  else if (path === '/activity') page = <ActivityPage state={state} />;
  else if (path === '/deploys') page = <Deploys state={state} />;
  else if (path === '/reports') page = <Reports state={state} pulse={pulse} />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (path === '/logs') page = <LogsPage />;
  else page = <Overview state={state} pulse={pulse} />;

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col bg-canvas max-md:hidden">
        <div className="flex h-12 items-center gap-2 px-4">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface">{state?.brand.name[0] ?? '·'}</div>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium leading-4 text-ink">{state?.project.name ?? '…'}</div>
            <div className="truncate text-[11px] leading-4 text-ink-3">{state?.brand.name}</div>
          </div>
        </div>
        <InstanceSwitcher />
        <button onClick={() => setMenu(true)} className="mx-2 mt-2 flex h-8 items-center gap-2 rounded-control bg-surface px-2 text-[12.5px] text-ink-3 shadow-btn transition-colors hover:text-ink">
          <Search className="size-3.5" /> Search <span className="ml-auto"><Kbd>⌘K</Kbd></span>
        </button>
        <nav className="mt-3 flex flex-col gap-px px-2" aria-label="Pages">
          {NAV.map((n) => (
            <SidebarRow
              key={n.to}
              href={n.to}
              icon={<n.icon className="size-4" />}
              label={n.label}
              count={counts[n.to as keyof typeof counts]}
              countTone={n.to === '/decisions' || n.to === '/inbox' ? 'warn' : undefined}
              active={n.to === '/' ? path === '/' : path.startsWith(n.to)}
              onSelect={() => navigate(n.to)}
            />
          ))}
        </nav>
        <div className="mx-2 mt-auto mb-2 flex items-center gap-2 border-t border-line px-2 pt-3 text-[11.5px] text-ink-3">
          <span className={cx('inline-block size-2 rounded-full', live ? 'bg-green' : 'bg-red')} title={live ? 'live: updates stream from the event log' : 'disconnected; retrying'} />
          {live ? 'Live' : 'Reconnecting'}
          <span className="ml-auto flex items-center gap-1 tabular-nums">
            <Activity className="size-3" /> {state?.lastId ?? 0}
          </span>
          <button onClick={toggleTheme} className="primitive-icon-button size-7 text-ink-3 hover:bg-hover-2 hover:text-ink" title="Toggle theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {state && <StopBanner state={state} />}
        {page}
      </main>
      <CommandMenu open={menu} setOpen={setMenu} state={state} toggleTheme={toggleTheme} />
    </div>
  );
}

/** On a hub: its instances as sidebar rows; the current one is active, one that isn't answering is marked and can't be picked. */
export function InstanceList({ hub: info, current, onSelect }: { hub: HubInfo; current: string; onSelect: (name: string) => void }) {
  return (
    <nav className="mt-1 flex flex-col gap-px px-2" aria-label="Instances" data-instance-switcher>
      <div className="px-2 pt-1 pb-1 text-[11.5px] font-medium text-ink-3">Instances</div>
      {info.instances.map((i) => (
        <SidebarRow
          key={i.name}
          icon={<span className={cx('size-2 rounded-full', i.up ? 'bg-green' : 'bg-red')} />}
          label={i.up ? i.name : `${i.name} (not answering)`}
          title={i.error ?? undefined}
          active={i.name === current}
          disabled={!i.up && i.name !== current}
          onSelect={() => i.name !== current && onSelect(i.name)}
        />
      ))}
    </nav>
  );
}

/** On a hub: which instance this page shows, and a switch to the others (each served by its own dashboard). */
function InstanceSwitcher() {
  const [info, setInfo] = useState<{ hub: HubInfo; current: string } | null>(null);
  useEffect(() => {
    void Promise.all([hub, hubInstance]).then(([h, current]) => h && current && setInfo({ hub: h, current }));
  }, []);
  if (!info) return null;
  return <InstanceList hub={info.hub} current={info.current} onSelect={selectInstance} />;
}

/** Read-only: an emergency stop in force on this machine, shown on every page. It is lifted on the machine itself. */
export function StopBanner({ state }: { state: State }) {
  const e = state.emergency;
  if (!e?.inForce) return null;
  return (
    <div role="alert" className="mx-6 mt-4 rounded-card bg-red-tint px-4 py-3 text-[13px] shadow-[0_0_0_1px_var(--red-tint)]" data-emergency-stop>
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

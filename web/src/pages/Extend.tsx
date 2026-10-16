// WHY: one place for what an instance does beyond its issues (Automations, and Plugins as its own tab),
// so neither adds a page of its own. The sidebar lists Extend for owners and writers only (App.tsx NAV roles); a tab
// is drawn only where its feature exists, so there is never a dead tab.
import { type State } from '../api';
import { navigate } from '../App';
import { AutomationsTab } from '../components/Automations';
import { Header } from '../components/Header';
import { PluginsTab } from '../components/Plugins';
import { cx } from '../components/ui';

/** The tabs, in order: each its own address. */
export const EXTEND_TABS = [
  { id: 'automations', label: 'Automations', to: '/extend/automations' },
  { id: 'plugins', label: 'Plugins', to: '/extend/plugins' },
] as const;

export function ExtendPage({ state, path }: { state: State; path: string }) {
  const m = path.match(/^\/extend(?:\/([a-z]+))?(?:\/([a-z][a-z0-9-]{0,39}))?\/?$/);
  const tab = EXTEND_TABS.find((t) => t.id === m?.[1]) ?? EXTEND_TABS[0];
  const writer = state.role === 'owner' || state.role === 'writer';
  return (
    <div data-testid="page-extend">
      <Header title="Extend" sub="what this instance does beyond its issues" />
      <div className="space-y-4 p-4 sm:p-6">
        <nav className="flex gap-1 border-b border-line" aria-label="Extend" data-testid="extend-tabs">
          {EXTEND_TABS.map((t) => (
            <a
              key={t.id}
              href={t.to}
              onClick={(e) => (e.preventDefault(), navigate(t.to))}
              className={cx('-mb-px border-b-2 px-3 py-1.5 text-[12.5px]', t.id === tab.id ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink')}
              aria-current={t.id === tab.id ? 'page' : undefined}
              data-testid={`extend-tab-${t.id}`}
            >
              {t.label}
            </a>
          ))}
        </nav>
        {!writer ? (
          <p className="text-[12.5px] text-ink-3" data-testid="extend-refused">
            Extend is for the instance's owners and writers (write on its repo).
          </p>
        ) : (
          <>
            {tab.id === 'automations' && <AutomationsTab state={state} id={m?.[1] === 'automations' ? (m[2] ?? null) : null} />}
            {tab.id === 'plugins' && <PluginsTab state={state} />}
          </>
        )}
      </div>
    </div>
  );
}

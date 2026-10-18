// WHY (#581): Experiments is its own sidebar item, not an Extend tab (the owner chose a top-level item; this supersedes
// "a third tab under Extend"). The sidebar lists it for owners and writers where root's file turns experiments on
// (App.tsx NAV `when`); the page itself opens at its address for them whatever the setup, so "not set up yet" and the
// root commands stay reachable. A viewer gets nothing from the server (403), so the page says whose it is.
import { type State } from '../api';
import { ExperimentsPanel } from '../components/Experiments';
import { Header } from '../components/Header';

export function ExperimentsPage({ state, path }: { state: State; path: string }) {
  const study = path.match(/^\/experiments\/([a-z][a-z0-9-]{0,39})\/?$/)?.[1] ?? null;
  const writer = state.role === 'owner' || state.role === 'writer';
  return (
    <div data-testid="page-experiments">
      <Header title="Experiments" sub="studies that improve one number, one sandboxed job at a time" />
      <div className="space-y-4 p-4 sm:p-6">
        {writer ? (
          <ExperimentsPanel state={state} id={study} />
        ) : (
          <p className="text-[12.5px] text-ink-3" data-testid="experiments-refused">
            Experiments are for the instance's owners and writers (write on its repo).
          </p>
        )}
      </div>
    </div>
  );
}

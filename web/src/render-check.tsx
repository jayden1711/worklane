// Server-side render entry for the render checks (test/web-render.test.ts): each page
// rendered to static markup from a given state, so a test can see that every page
// still shows its data. Not part of the served UI.
import { renderToStaticMarkup } from 'react-dom/server';
import type { CheckRun, HubInfo, State } from './api';
import { InstanceList, StopBanner } from './App';
import { ActivityPage } from './pages/Activity';
import { Agents } from './pages/Agents';
import { Decisions } from './pages/Decisions';
import { Deploys } from './pages/Deploys';
import { InboxPage } from './pages/Inbox';
import { Checks, IssueDetail } from './pages/IssueDetail';
import { Issues } from './pages/Issues';
import { Landing } from './pages/Landing';
import { LogsPage } from './pages/Logs';
import { Overview } from './pages/Overview';
import { Reports } from './pages/Reports';
import { RunDetail, RunList } from './pages/RunDetail';
import { SettingsPage } from './pages/Settings';

export const pages = {
  overview: (s: State) => <Overview state={s} pulse={0} />,
  inbox: (s: State) => <InboxPage state={s} />,
  decisions: (s: State) => <Decisions state={s} />,
  issues: (s: State) => <Issues state={s} />,
  land: (s: State) => <Landing state={s} />,
  agents: (s: State) => <Agents state={s} />,
  activity: (s: State) => <ActivityPage state={s} />,
  deploys: (s: State) => <Deploys state={s} />,
  reports: (s: State) => <Reports state={s} pulse={0} />,
  logs: () => <LogsPage />,
  settings: () => <SettingsPage />,
  run: () => <RunDetail id="x" />,
};

export function renderPage(name: keyof typeof pages, state: State): string {
  return renderToStaticMarkup(pages[name](state));
}

export const renderIssue = (state: State, issue: number) => renderToStaticMarkup(<IssueDetail state={state} issue={issue} />);
export const renderChecks = (runs: CheckRun[]) => renderToStaticMarkup(<Checks runs={runs} />);
export const renderRunList = (issue: number) => renderToStaticMarkup(<RunList issue={issue} lastId={0} />);
export const renderInstances = (hub: HubInfo, current: string) => renderToStaticMarkup(<InstanceList hub={hub} current={current} onSelect={() => {}} />);
export const renderStopBanner = (state: State) => renderToStaticMarkup(<StopBanner state={state} />);

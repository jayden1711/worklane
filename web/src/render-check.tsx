// Server-side render entry for the render checks (test/web-render.test.ts): each page
// rendered to static markup from a given state, so a test can see that every page
// still shows its data. Not part of the served UI.
import { renderToStaticMarkup } from 'react-dom/server';
import type { AddProjectData, AsksView, ChatAnswerFile, CheckRun, HealthView, HubInfo, IntakeView as IntakeViewData, PrsView, Protection, State, Throughput, Trust, Waiting } from './api';
import { HealthPanelView, type InstanceHealth } from './components/HealthPanel';
import { ChatAnswerView } from './components/ChatPanel';
import { InstanceList, SignInPage, StopBanner, WhoAmI } from './App';
import { AuditLogView, type AuditEntry } from './components/AuditLog';
import { ConsolePanel, LiveFeedView, type ConsoleData, type FeedItem, type LiveList } from './components/LiveRun';
import { MachineSettingsView, type MachineData } from './components/MachineSettings';
import { UpdatesPanelView, type UpdatesPanelData } from './components/UpdatesPanel';
import { TestRunsView, type TestRunsData } from './components/TestRuns';
import { ThroughputPanel, ThroughputView } from './components/ThroughputPanel';
import { TrustView } from './components/TrustPanel';
import { InstanceSettingsView, type InstanceSettingsData } from './components/InstanceSettings';
import { ActivityPage } from './pages/Activity';
import { Agents } from './pages/Agents';
import { Decisions } from './pages/Decisions';
import { Deploys } from './pages/Deploys';
import { InboxPage } from './pages/Inbox';
import { IntakeHealthSection, IntakePage, IntakeReports } from './pages/Intake';
import { WaitingPage, WaitingView } from './pages/Waiting';
import { Checks, IssueDetail } from './pages/IssueDetail';
import { Issues } from './pages/Issues';
import { Landing } from './pages/Landing';
import { LogsPage } from './pages/Logs';
import { Overview } from './pages/Overview';
import { PullRequests, PullRequestsView } from './pages/PullRequests';
import { Reports } from './pages/Reports';
import { RunDetail, RunList, RunResearchView, RunsRefused, type RunResearchData } from './pages/RunDetail';
import { SettingsPage } from './pages/Settings';
import { BoardPage, BoardTestRuns, BoardView, type InstanceBoard } from './pages/Board';
import { MachinePage, MachineSlots } from './pages/Machine';
import { MainWatchAlert, ProtectionStatus } from './components/Protection';
import { AddProjectView, SetupConsoleView } from './pages/Setup';

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
  prs: (s: State) => <PullRequests state={s} />,
  board: (s: State) => <BoardPage state={s} pulse={0} />,
  machine: (s: State) => <MachinePage state={s} />,
};

export function renderPage(name: keyof typeof pages, state: State): string {
  return renderToStaticMarkup(pages[name](state));
}

export const renderIssue = (state: State, issue: number) => renderToStaticMarkup(<IssueDetail state={state} issue={issue} />);
export const renderChecks = (runs: CheckRun[]) => renderToStaticMarkup(<Checks runs={runs} />);
export const renderRunList = (issue: number) => renderToStaticMarkup(<RunList issue={issue} lastId={0} />);
export const renderInstances = (hub: HubInfo, current: string, all = false) => renderToStaticMarkup(<InstanceList hub={hub} current={current} all={all} onSelect={() => {}} />);
export const renderPrs = (view: PrsView) => renderToStaticMarkup(<PullRequestsView view={view} />);
export { probeHub } from './api';
export const renderHealth = (view: HealthView, instances?: InstanceHealth[]) => renderToStaticMarkup(<HealthPanelView view={view} {...(instances ? { instances } : {})} />);
export const renderInstanceSettings = (data: InstanceSettingsData) => renderToStaticMarkup(<InstanceSettingsView data={data} />);
export { boundsOf, LABEL, parseEntry, showValue } from './components/InstanceSettings';
export const renderMachine = (data: MachineData) => renderToStaticMarkup(<MachineSettingsView data={data} />);
export const renderUpdatesPanel = (data: UpdatesPanelData) => renderToStaticMarkup(<UpdatesPanelView data={data} />);
export { duration } from './components/UpdatesPanel';
export const renderLiveFeed = (items: FeedItem[], ended: boolean) => renderToStaticMarkup(<LiveFeedView items={items} ended={ended} />);
export const renderConsole = (data: ConsoleData) => renderToStaticMarkup(<ConsolePanel data={data} run="r" />);
export const renderAgents = (state: State, live: LiveList | null) => renderToStaticMarkup(<Agents state={state} live={live} />);
export const renderStopBanner = (state: State) => renderToStaticMarkup(<StopBanner state={state} />);
export const renderProtection = (protection: Protection, brand: string) => renderToStaticMarkup(<ProtectionStatus protection={protection} brand={brand} />);
export const renderMainWatchAlert = (protection: Protection) => renderToStaticMarkup(<MainWatchAlert protection={protection} />);
export const renderChatAnswer = (f: ChatAnswerFile, cli: string) => renderToStaticMarkup(<ChatAnswerView f={f} cli={cli} />);
export const renderProposedSetting = (data: InstanceSettingsData, proposed: { key: string; value: unknown }) => renderToStaticMarkup(<InstanceSettingsView data={data} proposed={proposed} />);
export { actionHref, citationHref } from './components/ChatPanel';
export { proposedSetting } from './components/InstanceSettings';
export const renderIntake = (data: IntakeViewData, view?: string) => renderToStaticMarkup(<IntakeReports data={data} {...(view ? { view } : {})} />);
export const renderIntakeHealth = (health: IntakeViewData['health']) => renderToStaticMarkup(<IntakeHealthSection health={health} />);
export const renderIntakePage = (state: State) => renderToStaticMarkup(<IntakePage state={state} />);
export { intakeRefusal } from './pages/Intake';
export const renderThroughput = (t: Throughput) => renderToStaticMarkup(<ThroughputView t={t} />);
export const renderThroughputPanel = (state: State) => renderToStaticMarkup(<ThroughputPanel state={state} />);
export const renderTrust = (t: Trust) => renderToStaticMarkup(<TrustView t={t} />);
export const renderRunsRefused = (message: string) => renderToStaticMarkup(<RunsRefused message={message} />);
export { runsRefusal, runsRefused } from './pages/RunDetail';
export const renderRunResearch = (data: RunResearchData) => renderToStaticMarkup(<RunResearchView data={data} />);
export const renderWaiting = (w: Waiting, now?: number) => renderToStaticMarkup(<WaitingView w={w} {...(now !== undefined ? { now } : {})} />);
export const renderWaitingPage = (state: State) => renderToStaticMarkup(<WaitingPage state={state} />);
export const renderSignIn = () => renderToStaticMarkup(<SignInPage />);
export const renderWhoAmI = (state: Pick<State, 'user' | 'role' | 'via'>) => renderToStaticMarkup(<WhoAmI state={state} onSignOut={() => {}} />);
export const renderAudit = (entries: AuditEntry[]) => renderToStaticMarkup(<AuditLogView entries={entries} />);
export { probeMe } from './api';
export const renderBoard = (boards: InstanceBoard[], now?: number) => renderToStaticMarkup(<BoardView boards={boards} {...(now !== undefined ? { now } : {})} />);
export const renderBoardTestRuns = (boards: InstanceBoard[]) => renderToStaticMarkup(<BoardTestRuns boards={boards} />);
export { loadBoards } from './pages/Board';
export { onInstance, scopeOf } from './api';
export const renderMachineSlots = (slots: State['slots']) => renderToStaticMarkup(<MachineSlots slots={slots} />);
export const renderTestRuns = (data: TestRunsData, compact = false) => renderToStaticMarkup(<TestRunsView data={data} compact={compact} />);
export { elapsed } from './pages/Board';
export const renderSetup = (data: AsksView) => renderToStaticMarkup(<SetupConsoleView data={data} />);
export const renderAddProject = (data: AddProjectData) => renderToStaticMarkup(<AddProjectView data={data} />);
export { keyData } from './pages/Setup';
export { addProjectInvalid } from './api';

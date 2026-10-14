// Server-side render entry for the render checks (test/web-render.test.ts): each page
// rendered to static markup from a given state, so a test can see that every page
// still shows its data. Not part of the served UI.
import { renderToStaticMarkup } from 'react-dom/server';
import type { TailscaleAction, TailscaleData } from './api';
import type { DiscordBot, DiscordIntakePlan, DiscordSetup, DiscordFormValue, ClaudeSigninData, SetupStepView, ConfigChange, PolicyChange, DeployGate, AddProjectData, RepoPickerData, AsksView, ClaudeAccountData, ChatAnswerFile, CheckRun, FirstRun, Flaky, GhLoginView, HarnessEvals, Learnings, HealthStatus, HealthView, HubInfo, InstanceIncidents, IntakeView as IntakeViewData, PrsView, Protection, State, Throughput, Trust, Waiting, Metrics, Constraints } from './api';
import { HealthPanelView, type InstanceHealth } from './components/HealthPanel';
import { DeployGateStatus } from './components/DeployGate';
import { ChatAnswerView } from './components/ChatPanel';
import { ComposerMic, MicInterim } from './voice/Mic';
import { VoiceSettings, VoiceSettingsView, type OnDeviceStatus, type VoiceCount } from './voice/VoiceSettings';
import { TalkStatus } from './voice/TalkBack';
import type { VoicePrefs } from './voice/prefs';
import type { Support } from './voice/speech';
import { InstanceList, NAV, NavDrawer, NavMenu, SidebarBody, SignInPage, StopBanner, WhoAmI } from './App';
import { Header } from './pages/Overview';
import { AuditLogView, type AuditEntry } from './components/AuditLog';
import { ConsolePanel, LiveFeedView, type ConsoleData, type FeedItem, type LiveList } from './components/LiveRun';
import { MachineSettingsView, type MachineData } from './components/MachineSettings';
import { UpdaterSetupView } from './components/UpdaterSetup';
import { UpdatesPanelView, type UpdatesPanelData } from './components/UpdatesPanel';
import { TestRunsView, type TestRunsData } from './components/TestRuns';
import { ThroughputPanel, ThroughputView } from './components/ThroughputPanel';
import { TrustView } from './components/TrustPanel';
import { ConstraintsPanel, ConstraintsView } from './components/ConstraintsPanel';
import { MetricsPanel, MetricsView } from './components/MetricsPanel';
import { FlakyView } from './components/FlakyPanel';
import { HarnessEvalsView } from './components/HarnessEvalsPanel';
import { LearningsView } from './components/LearningsPanel';
import { InstanceSettingsView, type InstanceSettingsData } from './components/InstanceSettings';
import { ActivityPage } from './pages/Activity';
import { Agents } from './pages/Agents';
import { Decisions } from './pages/Decisions';
import { Deploys } from './pages/Deploys';
import { InboxPage } from './pages/Inbox';
import { IntakeHealthSection, IntakePage, IntakeReports } from './pages/Intake';
import { WaitingPage, WaitingView } from './pages/Waiting';
import { FirstRunPage, FirstRunView } from './pages/FirstRun';
import { RepoConfigForm } from './components/RepoConfigForm';
import { ClaudeSigninView } from './components/ClaudeSignin';
import { SetupScreensView, withScreen } from './components/SetupScreens';
import { DiscordSetupView } from './components/DiscordSetup';
import { KeyForm, KeyPage } from './components/DashboardKey';
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
import { ClaudeAccountView } from './components/ClaudeAccount';
import { TailscaleSetupView } from './components/TailscaleSetup';
export { tailscaleBusy, tailscaleStepEnded } from './components/TailscaleSetup';
export { accountBusy } from './components/ClaudeAccount';
import { HealthPage, HealthView as IncidentsHealthView } from './pages/Health';
import { UsageBanner, UsageLines } from './components/Usage';
import type { UsageInfo } from './api';

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
  health: () => <HealthPage />,
};

export function renderPage(name: keyof typeof pages, state: State): string {
  return renderToStaticMarkup(pages[name](state));
}

export const renderIssue = (state: State, issue: number) => renderToStaticMarkup(<IssueDetail state={state} issue={issue} />);
export const renderChecks = (runs: CheckRun[]) => renderToStaticMarkup(<Checks runs={runs} />);
export const renderRunList = (issue: number) => renderToStaticMarkup(<RunList issue={issue} lastId={0} />);
export const renderInstances = (hub: HubInfo, current: string, all = false, status?: Record<string, HealthStatus>) => renderToStaticMarkup(<InstanceList hub={hub} current={current} all={all} onSelect={() => {}} {...(status ? { status } : {})} />);
export const renderHealthPage = (all: InstanceIncidents[], target?: string) => renderToStaticMarkup(<IncidentsHealthView all={all} {...(target ? { target } : {})} />);
export { loadIncidents, mergeIncidents, statusOf } from './api';
export const renderPrs = (view: PrsView) => renderToStaticMarkup(<PullRequestsView view={view} />);
export { probeHub } from './api';
export const renderHealth = (view: HealthView, instances?: InstanceHealth[]) => renderToStaticMarkup(<HealthPanelView view={view} {...(instances ? { instances } : {})} />);
export const renderInstanceSettings = (data: InstanceSettingsData) => renderToStaticMarkup(<InstanceSettingsView data={data} />);
export { boundsOf, LABEL, parseEntry, showValue } from './components/InstanceSettings';
export const renderMachine = (data: MachineData) => renderToStaticMarkup(<MachineSettingsView data={data} />);
/** The Updater setup steps alone; `review` opens one step's review as the server answered it. */
export const renderUpdaterSetup = (data: MachineData, review: Parameters<typeof UpdaterSetupView>[0]['initialReview'] = null) => renderToStaticMarkup(<UpdaterSetupView data={data} initialReview={review} />);
export const renderUpdatesPanel = (data: UpdatesPanelData) => renderToStaticMarkup(<UpdatesPanelView data={data} />);
export { duration } from './components/UpdatesPanel';
export const renderLiveFeed = (items: FeedItem[], ended: boolean) => renderToStaticMarkup(<LiveFeedView items={items} ended={ended} />);
export const renderConsole = (data: ConsoleData) => renderToStaticMarkup(<ConsolePanel data={data} run="r" />);
export const renderAgents = (state: State, live: LiveList | null) => renderToStaticMarkup(<Agents state={state} live={live} />);
export const renderStopBanner = (state: State) => renderToStaticMarkup(<StopBanner state={state} />);
export const renderDeployGate = (gate: DeployGate) => renderToStaticMarkup(<DeployGateStatus gate={gate} />);
export const renderProtection = (protection: Protection, brand: string) => renderToStaticMarkup(<ProtectionStatus protection={protection} brand={brand} />);
export const renderMainWatchAlert = (protection: Protection) => renderToStaticMarkup(<MainWatchAlert protection={protection} />);
export const renderChatAnswer = (f: ChatAnswerFile, cli: string) => renderToStaticMarkup(<ChatAnswerView f={f} cli={cli} />);
export const renderProposedSetting = (data: InstanceSettingsData, proposed: { key: string; value: unknown }) => renderToStaticMarkup(<InstanceSettingsView data={data} proposed={proposed} />);
export { actionHref, citationHref } from './components/ChatPanel';
export const renderComposerMic = (role: string | undefined, prefs: VoicePrefs, support: Support | null, listening = false) => renderToStaticMarkup(<ComposerMic role={role} prefs={prefs} support={support} listening={listening} onToggle={() => {}} />);
export const renderMicInterim = (listening: boolean, interim: string, error: string | null = null) => renderToStaticMarkup(<MicInterim listening={listening} interim={interim} error={error} />);
export const renderVoiceSettings = (owner: boolean) => renderToStaticMarkup(<VoiceSettings owner={owner} />);
export const renderVoiceSettingsView = (prefs: VoicePrefs, status: OnDeviceStatus | null) => renderToStaticMarkup(<VoiceSettingsView prefs={prefs} status={status} lang="en-US" onChange={() => {}} onInstall={() => {}} />);
export { checkSupport, Dictation, insertAt, intoBox, NO_ON_DEVICE, speechCtor } from './voice/speech';
export { mayDictate } from './voice/Mic';
export { readVoicePrefs, VOICE_DEFAULTS } from './voice/prefs';
export const renderTalkStatus = (role: string | undefined, prefs: VoicePrefs, speaking: boolean, note: string | null = null) => renderToStaticMarkup(<TalkStatus role={role} prefs={prefs} speaking={speaking} note={note} onStop={() => {}} />);
export const renderVoiceSettingsVoices = (prefs: VoicePrefs, voices: VoiceCount) => renderToStaticMarkup(<VoiceSettingsView prefs={prefs} status={null} lang="en-US" onChange={() => {}} onInstall={() => {}} voices={voices} />);
export { mayTalk } from './voice/TalkBack';
export { countVoices } from './voice/VoiceSettings';
export { pickVoice, spokenText, stopSpeaking, TalkBack, CODE_OMITTED, SECRET_OMITTED, NO_LOCAL_VOICE } from './voice/talk';
export { proposedSetting } from './components/InstanceSettings';
export const renderIntake = (data: IntakeViewData, view?: string) => renderToStaticMarkup(<IntakeReports data={data} {...(view ? { view } : {})} />);
export const renderIntakeHealth = (health: IntakeViewData['health']) => renderToStaticMarkup(<IntakeHealthSection health={health} />);
export const renderIntakePage = (state: State) => renderToStaticMarkup(<IntakePage state={state} />);
export { intakeRefusal } from './pages/Intake';
export const renderThroughput = (t: Throughput) => renderToStaticMarkup(<ThroughputView t={t} />);
export const renderThroughputPanel = (state: State) => renderToStaticMarkup(<ThroughputPanel state={state} />);
export const renderTrust = (t: Trust) => renderToStaticMarkup(<TrustView t={t} />);
export const renderConstraints = (c: Constraints) => renderToStaticMarkup(<ConstraintsView c={c} />);
export const renderConstraintsPanel = (state: State) => renderToStaticMarkup(<ConstraintsPanel state={state} />);
export const renderMetrics = (m: Metrics) => renderToStaticMarkup(<MetricsView m={m} />);
export const renderMetricsPanel = (state: State) => renderToStaticMarkup(<MetricsPanel state={state} />);
export const renderFlaky = (f: Flaky) => renderToStaticMarkup(<FlakyView f={f} />);
export const renderHarnessEvals = (h: HarnessEvals) => renderToStaticMarkup(<HarnessEvalsView h={h} />);
export const renderLearnings = (l: Learnings) => renderToStaticMarkup(<LearningsView l={l} />);
export const renderRunsRefused = (message: string) => renderToStaticMarkup(<RunsRefused message={message} />);
export { runsRefusal, runsRefused } from './pages/RunDetail';
export const renderRunResearch = (data: RunResearchData) => renderToStaticMarkup(<RunResearchView data={data} />);
export const renderWaiting = (w: Waiting, now?: number) => renderToStaticMarkup(<WaitingView w={w} {...(now !== undefined ? { now } : {})} />);
export const renderWaitingPage = (state: State) => renderToStaticMarkup(<WaitingPage state={state} />);
export const renderFirstRun = (f: FirstRun, o: { open?: string; confirming?: boolean; actionConfirming?: boolean; policyChanges?: PolicyChange[]; configChanges?: ConfigChange[]; rerun?: string; draftConfirming?: boolean; signin?: ClaudeSigninData; discord?: DiscordSetup; ghLogin?: GhLoginView } = {}) => renderToStaticMarkup(<FirstRunView f={f} rerun={o.rerun ?? null} initialOpen={o.open ?? null} initialConfirming={!!o.confirming} initialActionConfirming={!!o.actionConfirming} initialPolicyChanges={o.policyChanges ?? null} initialConfigChanges={o.configChanges ?? null} initialDraftConfirming={!!o.draftConfirming} signin={o.signin ?? null} initialGhLogin={o.ghLogin ?? null} onRecheck={() => {}} {...(o.discord ? { discord: <DiscordSetupView v={o.discord} /> } : {})} />);
export const renderClaudeSignin = (v: ClaudeSigninData, o: { confirming?: boolean } = {}) => renderToStaticMarkup(<ClaudeSigninView v={v} initialConfirming={!!o.confirming} onChanged={() => {}} />);
export const renderDiscordSetup = (v: DiscordSetup, o: { bot?: DiscordBot; botError?: string; tokenConfirming?: boolean; plan?: DiscordIntakePlan; values?: Record<string, DiscordFormValue> } = {}) =>
  renderToStaticMarkup(<DiscordSetupView v={v} bot={o.bot ?? null} botError={o.botError ?? null} initialTokenConfirming={!!o.tokenConfirming} initialPlan={o.plan ?? null} {...(o.values ? { initialValues: o.values } : {})} />);
export const renderFirstRunPage = (state: State) => renderToStaticMarkup(<FirstRunPage state={state} />);
export const renderSetupScreens = (steps: SetupStepView[]) => renderToStaticMarkup(<SetupScreensView steps={withScreen(steps)} />);
export const renderSignIn = (local = false) => renderToStaticMarkup(<SignInPage local={local} />);
export const renderKeyPage = () => renderToStaticMarkup(<KeyPage />);
export const renderKeyForm = (error: string | null = null) => renderToStaticMarkup(<KeyForm hub={false} initialError={error} />);
export { needsKey, tryKey } from './api';
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
export const renderAddProject = (data: AddProjectData, picker?: RepoPickerData | null) => renderToStaticMarkup(<AddProjectView data={data} picker={picker === undefined ? null : picker} />);
export { keyData } from './pages/Setup';
export { addProjectInvalid } from './api';
export const renderClaudeAccount = (data: ClaudeAccountData, now?: number) => renderToStaticMarkup(<ClaudeAccountView data={data} {...(now !== undefined ? { now } : {})} />);
export const renderTailscaleSetup = (data: TailscaleData, o: { confirming?: TailscaleAction } = {}) => renderToStaticMarkup(<TailscaleSetupView data={data} initialConfirming={o.confirming ?? null} />);
export const renderUsageBanner = (usage: UsageInfo[], now: number) => renderToStaticMarkup(<UsageBanner usage={usage} now={now} />);
export const renderUsageLines = (usage: UsageInfo[], now: number) => renderToStaticMarkup(<UsageLines usage={usage} now={now} />);
export const renderOverviewWithUsage = (state: State, usage: UsageInfo[], now: number) => renderToStaticMarkup(<Overview state={state} pulse={0} usage={usage} now={now} />);
export { countdown } from './components/Usage';
/** The page header with its menu button and the narrow-screen navigation drawer, open; on a hub, its instances with their dots. */
export const renderNavDrawer = (state: State, o: { open?: boolean; hub?: HubInfo; status?: Record<string, HealthStatus> } = {}) => {
  const open = o.open ?? true;
  const status = o.status ?? {};
  const switcher = o.hub ? <InstanceList hub={o.hub} current={o.hub.instances[0]!.name} onSelect={() => {}} status={status} /> : null;
  return renderToStaticMarkup(
    <NavMenu.Provider value={{ open, setOpen: () => {} }}>
      <Header title="Board" />
      <NavDrawer open={open} setOpen={() => {}}>
        <SidebarBody state={state} path="/" counts={{}} health={{ hub: o.hub ?? null, status }} live theme="light" toggleTheme={() => {}} openSearch={() => {}} switcher={switcher} />
      </NavDrawer>
    </NavMenu.Provider>,
  );
};
export const renderHeader = (title: string) => renderToStaticMarkup(<Header title={title} />);
export const navRows = NAV.map((n) => ({ to: n.to, label: n.label, testId: n.testId }));

export const renderRepoConfigForm = (c: FirstRun['repoConfig'], o: { proposed?: string; mergePlan?: { command: string; then: string }; seen?: string[]; seenNote?: string; seenLoaded?: boolean } = {}) =>
  renderToStaticMarkup(<RepoConfigForm c={c as Extract<FirstRun['repoConfig'], { values: unknown }>} canEdit initialProposed={o.proposed ?? null} initialMergePlan={o.mergePlan ?? null} initialSeen={o.seen ?? []} initialSeenNote={o.seenNote ?? null} initialSeenLoaded={!!o.seenLoaded} />);

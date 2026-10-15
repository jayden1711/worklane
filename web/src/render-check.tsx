// Server-side render entry for the render checks (test/web-render.test.ts): each page
// rendered to static markup from a given state, so a test can see that every page
// still shows its data. Not part of the served UI.
import { renderToStaticMarkup } from 'react-dom/server';
import type { TailscaleAction, TailscaleData } from './api';
import type { GoalGraph, DiscordBot, DiscordIntakePlan, DiscordSetup, DiscordFormValue, ClaudeSigninData, SetupStepView, ConfigChange, PolicyChange, DeployGate, AddProjectData, RepoPickerData, AsksView, ClaudeAccountData, ChatAnswerFile, CheckRun, FirstRun, Flaky, GhLoginView, HarnessEvals, Learnings, CoordinatorError, DotStatus, HealthView, HubInfo, InstanceIncidents, IntakeView as IntakeViewData, PrsView, Protection, State, Throughput, Trust, Waiting, Metrics, Constraints } from './api';
import { HealthPanelView, type InstanceHealth } from './components/HealthPanel';
import { DeployGateStatus } from './components/DeployGate';
import { ChatAnswerView } from './components/ChatPanel';
import { AttachButton, AttachmentList, DropHint, SentAttachments, type Pending } from './components/ChatAttachments';
import type { ChatAttachment } from './api';
import { ConversationSidebarView, ConversationThreadView, ProjectEditorView, type ChatView } from './components/Conversations';
import type { ChatProject, ConversationData, ConversationItem, ProjectItem } from './api';
import { ComposerMic, MicInterim } from './voice/Mic';
import { VoiceSettings, VoiceSettingsView, type OnDeviceStatus, type VoiceCount } from './voice/VoiceSettings';
import { TalkStatus } from './voice/TalkBack';
import { VoiceBanner, VoiceButton, VoiceControl, type BannerView } from './voice/VoiceControl';
import type { VoicePrefs } from './voice/prefs';
import type { Support } from './voice/speech';
import { WakeIndicator } from './voice/WakeIndicator';
import { InstanceList, NAV, NavDrawer, NavMenu, SetupModeHidden, SidebarBody, SignInPage, StopBanner, WhoAmI } from './App';
import { Header } from './components/Header';
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
import { FirstTaskForm, IgnoredIssues } from './components/FirstTask';
import { RepoConfigForm } from './components/RepoConfigForm';
import type { StarterCi as StarterCiView } from './api';
import { StarterCi } from './components/StarterCi';
import { CiNote } from './components/CiNote';
import { ClaudeSigninView } from './components/ClaudeSignin';
import { SetupScreensView, withScreen } from './components/SetupScreens';
import { DiscordSetupView } from './components/DiscordSetup';
import { KeyForm, KeyPage } from './components/DashboardKey';
import { Checks, IssueDetail } from './pages/IssueDetail';
import { GoalGraphView } from './components/GoalGraph';
import { Issues } from './pages/Issues';
import { Landing } from './pages/Landing';
import { LogsPage } from './pages/Logs';
import { CoordinatorErrors, Overview } from './pages/Overview';
import { PullRequests, PullRequestsView } from './pages/PullRequests';
import { Reports } from './pages/Reports';
import { RunDetail, RunList, RunResearchView, RunsRefused, RunWhy, type RunResearchData } from './pages/RunDetail';
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
import { DecisionDetailView, DETAIL_SECTIONS } from './pages/DecisionDetail';
import type { DecisionDetail, DecisionDiff, DecisionPrBody } from './api';
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

export const renderGoalGraph = (graph: GoalGraph) => renderToStaticMarkup(<GoalGraphView graph={graph} />);
export const renderIssue = (state: State, issue: number) => renderToStaticMarkup(<IssueDetail state={state} issue={issue} />);
export const renderChecks = (runs: CheckRun[]) => renderToStaticMarkup(<Checks runs={runs} />);
export const renderRunList = (issue: number) => renderToStaticMarkup(<RunList issue={issue} lastId={0} />);
export const renderInstances = (hub: HubInfo, current: string, all = false, status?: Record<string, DotStatus>, why?: Record<string, string>) => renderToStaticMarkup(<InstanceList hub={hub} current={current} all={all} onSelect={() => {}} {...(status ? { status } : {})} {...(why ? { why } : {})} />);
export const renderHealthPage = (all: InstanceIncidents[], target?: string) => renderToStaticMarkup(<IncidentsHealthView all={all} {...(target ? { target } : {})} />);
export { healthPass, loadIncidents, mergeIncidents, nextHub, refreshHub, statusOf, whyOf } from './api';
/** The Overview's coordinator errors (current ones grouped, earlier ones folded), at a given time. */
export const renderCoordinatorErrors = (errors: CoordinatorError[] | undefined, earlier: CoordinatorError[] = [], count?: number, now = Date.now()) => renderToStaticMarkup(<CoordinatorErrors errors={errors} earlier={earlier} count={count} now={now} />);
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
export const renderAttachmentList = (items: Pending[]) => renderToStaticMarkup(<AttachmentList items={items} onRemove={() => {}} onAnyway={() => {}} />);
export const renderAttachButton = (role: string | undefined, disabled = false) => renderToStaticMarkup(<AttachButton role={role} disabled={disabled} accept={['png', 'pdf']} onFiles={() => {}} />);
export const renderDropHint = (active: boolean) => renderToStaticMarkup(<DropHint active={active} />);
export const renderSentAttachments = (items: ChatAttachment[]) => renderToStaticMarkup(<SentAttachments items={items} instance={null} />);
export { filesOf, fmtSize, mayAttach, precheck, safeBlob } from './components/ChatAttachments';
export const renderConversationSidebar = (conversations: ConversationItem[], projects: ProjectItem[], view: ChatView = { kind: 'quick' }) => renderToStaticMarkup(<ConversationSidebarView conversations={conversations} projects={projects} view={view} onSelect={() => {}} onNew={() => {}} onRename={() => {}} onDelete={() => {}} />);
export const renderConversationThread = (data: ConversationData) => renderToStaticMarkup(<ConversationThreadView data={data} cli="wl" />);
export const renderProjectEditor = (project: ChatProject | null, owner: boolean, me: string) => renderToStaticMarkup(<ProjectEditorView project={project} owner={owner} me={me} attach={<span data-slot="attach" />} onSave={() => {}} onDelete={() => {}} onNewConversation={() => {}} />);
export { mayConverse } from './components/Conversations';
export { attachmentNameHeader } from './api';
export const renderChatAnswer = (f: ChatAnswerFile, cli: string) => renderToStaticMarkup(<ChatAnswerView f={f} cli={cli} />);
export const renderProposedSetting = (data: InstanceSettingsData, proposed: { key: string; value: unknown }) => renderToStaticMarkup(<InstanceSettingsView data={data} proposed={proposed} />);
export { actionHref, citationHref } from './components/ChatPanel';
export const renderComposerMic = (role: string | undefined, prefs: VoicePrefs, support: Support | null, listening = false) => renderToStaticMarkup(<ComposerMic role={role} prefs={prefs} support={support} listening={listening} onToggle={() => {}} />);
export const renderMicInterim = (listening: boolean, interim: string, error: string | null = null) => renderToStaticMarkup(<MicInterim listening={listening} interim={interim} error={error} />);
export const renderVoiceSettings = (owner: boolean, brand?: string) => renderToStaticMarkup(<VoiceSettings owner={owner} brand={brand} />);
export const renderVoiceSettingsView = (prefs: VoicePrefs, status: OnDeviceStatus | null, brand?: string, wakeModel: string | null = null) => renderToStaticMarkup(<VoiceSettingsView prefs={prefs} status={status} lang="en-US" onChange={() => {}} onInstall={() => {}} brand={brand} wakeModel={wakeModel} />);
export const renderWakeIndicator = (micOpen: boolean, phrase: string) => renderToStaticMarkup(<WakeIndicator micOpen={micOpen} phrase={phrase} onOff={() => {}} />);
export { mayWake, NO_WAKE_MODEL, registerWakeEngine, startOnWake, wakeEngine, WakeListener, wakePhrase } from './voice/wake';
export { checkSupport, Dictation, insertAt, intoBox, NO_ON_DEVICE, speechCtor } from './voice/speech';
export { mayDictate } from './voice/Mic';
export { readVoicePrefs, VOICE_DEFAULTS } from './voice/prefs';
export const renderTalkStatus = (role: string | undefined, prefs: VoicePrefs, speaking: boolean, note: string | null = null) => renderToStaticMarkup(<TalkStatus role={role} prefs={prefs} speaking={speaking} note={note} onStop={() => {}} />);
export const renderVoiceSettingsVoices = (prefs: VoicePrefs, voices: VoiceCount) => renderToStaticMarkup(<VoiceSettingsView prefs={prefs} status={null} lang="en-US" onChange={() => {}} onInstall={() => {}} voices={voices} />);
export { mayTalk } from './voice/TalkBack';
export { countVoices } from './voice/VoiceSettings';
export { pickVoice, spokenText, stopSpeaking, TalkBack, CODE_OMITTED, SECRET_OMITTED, NO_LOCAL_VOICE } from './voice/talk';
export const renderVoiceBanner = (view: BannerView | null) => renderToStaticMarkup(<VoiceBanner view={view} onConfirm={() => {}} onCancel={() => {}} />);
export const renderVoiceButton = (show: boolean, support: Support | null, listening = false) => renderToStaticMarkup(<VoiceButton show={show} support={support} listening={listening} onToggle={() => {}} />);
export const renderVoiceControl = (state: State, prefs: VoicePrefs) => renderToStaticMarkup(<VoiceControl state={state} prefs={prefs} ctor={null} />);
export { approvalFor, bannerText, CONFIRM_WINDOW_MS, mayUseVoice, parseHeard, tabState, voiceActive, VoiceCommands } from './voice/commands';
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
export const renderKeyPage = (help: { file: string; copy: string | null } | null = null) => renderToStaticMarkup(<KeyPage help={help} />);
export const renderKeyForm = (error: string | null = null) => renderToStaticMarkup(<KeyForm hub={false} initialError={error} />);
export { needsKey, tryKey } from './api';
export const renderWhoAmI = (state: Pick<State, 'user' | 'role' | 'via'>, o: { hubPage?: boolean } = {}) => renderToStaticMarkup(<WhoAmI state={state} onSignOut={() => {}} hubPage={!!o.hubPage} />);
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
/** A decision's detail page from its data; `prBody` and `diff` as already read (undefined: not asked yet). */
export const renderDecisionDetail = (d: DecisionDetail, prBody?: DecisionPrBody | { error: string } | null, diff?: DecisionDiff | { error: string } | null) =>
  renderToStaticMarkup(<DecisionDetailView d={d} {...(prBody !== undefined ? { prBody } : {})} {...(diff !== undefined ? { diff } : {})} />);
export { DETAIL_SECTIONS };
export const renderRunWhy = (detail?: string) => renderToStaticMarkup(<RunWhy detail={detail} />);
export const renderUsageLines = (usage: UsageInfo[], now: number) => renderToStaticMarkup(<UsageLines usage={usage} now={now} />);
export const renderOverviewWithUsage = (state: State, usage: UsageInfo[], now: number) => renderToStaticMarkup(<Overview state={state} pulse={0} usage={usage} now={now} />);
export { countdown } from './components/Usage';
/** The page header with its menu button and the narrow-screen navigation drawer, open; on a hub, its instances with their dots. */
export const renderNavDrawer = (state: State, o: { open?: boolean; hub?: HubInfo; status?: Record<string, DotStatus>; why?: Record<string, string> } = {}) => {
  const open = o.open ?? true;
  const status = o.status ?? {};
  const switcher = o.hub ? <InstanceList hub={o.hub} current={o.hub.instances[0]!.name} onSelect={() => {}} status={status} /> : null;
  return renderToStaticMarkup(
    <NavMenu.Provider value={{ open, setOpen: () => {} }}>
      <Header title="Board" />
      <NavDrawer open={open} setOpen={() => {}}>
        <SidebarBody state={state} path="/" counts={{}} health={{ hub: o.hub ?? null, status, ...(o.why ? { why: o.why } : {}) }} live theme="light" toggleTheme={() => {}} openSearch={() => {}} switcher={switcher} />
      </NavDrawer>
    </NavMenu.Provider>,
  );
};
export const renderSetupModeHidden = (path: string) => renderToStaticMarkup(<SetupModeHidden path={path} />);
export { nextStep } from './pages/FirstRun';
/** #468: Your first task's form (its picks loaded, a preview shown), and the Issues page's "Not picked up". */
export const renderFirstTask = (info: unknown, o: { canEdit?: boolean; preview?: { title: string; body: string } } = {}) => renderToStaticMarkup(<FirstTaskForm canEdit={o.canEdit ?? true} initial={info as never} initialPreview={o.preview ?? null} onDone={() => {}} />);
export const renderIgnored = (data: unknown) => renderToStaticMarkup(<IgnoredIssues initial={data as never} />);
export const renderHeader = (title: string) => renderToStaticMarkup(<Header title={title} />);
export const navRows = NAV.map((n) => ({ to: n.to, label: n.label, testId: n.testId }));

export const renderRepoConfigForm = (c: FirstRun['repoConfig'], o: { proposed?: string; mergePlan?: { command: string; then: string }; seen?: string[]; seenNote?: string; seenLoaded?: boolean; starter?: StarterCiView; starterOpen?: boolean } = {}) =>
  renderToStaticMarkup(<RepoConfigForm c={c as Extract<FirstRun['repoConfig'], { values: unknown }>} canEdit initialProposed={o.proposed ?? null} initialMergePlan={o.mergePlan ?? null} initialSeen={o.seen ?? []} initialSeenNote={o.seenNote ?? null} initialSeenLoaded={!!o.seenLoaded} initialStarter={o.starter ?? null} initialStarterOpen={!!o.starterOpen} />);

// What a live panel keeps when a look fails (web/src/refresh.tsx), for the tests to call.
export { afterLoad, NOTHING_YET } from './refresh';
export { ApiError, isRefusal } from './api';

/** The starter CI outside the Repo config form (a server's instance, #469). */
export const renderStarterCi = (v: StarterCiView, inForm = false) => renderToStaticMarkup(<StarterCi canEdit initialView={v} inForm={inForm} />);

/** The No CI note on the PR and Land pages (#469). */
export const renderCiNote = (ci: Parameters<typeof CiNote>[0]['ci']) => renderToStaticMarkup(<CiNote ci={ci} />);

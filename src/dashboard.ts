// The local dashboard server: static UI plus a small API over the event
// log. It binds to loopback only and requires a per-install token, which only
// two kinds of caller hold: the hub, which names the signed-in person on each
// request (their role here is then read from their permission on this
// instance's repo, never taken from the caller), and the owner on this machine
// (the break-glass: no person named, never through a proxy; it grants owner).
// It reads the log read-only, pushes changes over one SSE stream, and records
// every write a person makes (answers, settings, chat, console) in the audit.
// See dashboard-auth.ts.
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReadOnly } from './events/read-only.js';
import { BRAND } from './brand.js';
import { starterCiView } from './starter-ci.js';
import { CI_NONE_MEANS, ciIsNone } from './ci-none.js';

/** Which CI judges a PR, and under No CI what that means (#469): the PR, land and Settings pages say it. */
const ciMode = (cfg: Config) => (ciIsNone(cfg.project) ? { kind: 'none' as const, means: CI_NONE_MEANS } : { kind: 'github' as const, means: null });
import { GITHUB_API } from './github-hosts.js';
import { AVATAR_ROUTE, Avatars, peopleOf, type AvatarOptions } from './avatars.js';
import { loadConfig, loadConfigAt, type Config } from './config/load.js';
import { fastForwardCheckout, systemGit, type GitRun } from './checkout-sync.js';
import { EventLog } from './events/log.js';
import { EventCache } from './events/cache.js';
import { compress, compressibleType, MIN_COMPRESS_BYTES, mayCompressApi, requestEncoding, StaticCompressed, type Encoding } from './dashboard-compress.js';
import { dashboardProof, NONCE, PROOF_PATH } from './dashboard-proof.js';
import { localDay } from './local-day.js';
import { redactString } from './events/redact.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { acceptGit, acceptMerge, protectionView, type AcceptGit, type AcceptTarget } from './main-watch.js';
import { deployGateView } from './deploy-gate/gate.js';
import { checkResults, inbox, prsView, project } from './projection.js';
import { instancesDir, loadInstance, readPolicy } from './instance.js';
import { backlogFor, instanceEnv, instanceId, instanceTokens, instanceUnit, localServiceSpec, siteForInstance, siteForRoot } from './service.js';
import { askChat, ChatError, chatAnswer, validateDraft, type ChatAnswer, type ChatAnswerFile } from './chat.js';
import { handleConversationRoute } from './chat-routes.js';
import { mayDownload, mayRemove, sharers } from './chat-conversations.js';
import { ATTACHMENT_EXTENSIONS, AttachmentError, attachmentCaps, attachmentsFor, attachmentBytes, attachmentView, downloadHeaders, MAX_ATTACHMENTS, readAttachment, removeAttachment, SCANNED_KINDS, storeUpload, type AttachmentCaps } from './chat-attachments.js';
import { mayAnswer, type Backlog } from './backlog/types.js';
import { FIRST_TASK_TEMPLATE, FirstTaskError, firstTaskBody, ignoredIssues, READY_LABEL, type IgnoredIssue } from './first-task.js';
import { answerDecision, auditWrite } from './decide.js';
import { BY_VOICE, VOICE_MAX_CHARS, voiceClaim, voiceExclusion, voiceRefusal } from './voice.js';
import { submitVoiceIntake, voiceIntakeRefusal } from './intake/voice.js';
import { readRun, runsForIssue } from './run-record.js';
import { decisionDetail, decisionDiff, prSections } from './decision-detail.js';
import { emergencyStop, slotStatus, type EmergencyStop } from './slots.js';
import { testRunsView } from './testrun/status.js';
import { gpuFilePath, gpuOptIn } from './testrun/gpu.js';
import { testSlotCap, testSlotsHeld } from './testrun/slots.js';
import { FULL_RUN_LOCK } from './testrun/run.js';
import { healthView } from './health.js';
import { usageView } from './usage-limit.js';
import { authHoldsOf } from './claude-auth-failure.js';
import { requestAuthRecheck } from './claude-auth-recheck.js';
import { ConsoleError, liveRuns, sendMessage, stopRun } from './console.js';
import { readFeed, type FeedItem } from './run-feed.js';
import { copyFileCommand, cpuCount, diskFree, flockHolders, installService, loopbackPeerIsMe, serviceChange, stableNodePath, type ServiceSpec } from './os/index.js';
import { diskFloorCheck } from './governor-holds.js';
import { machineStats, processGroupUsage, type MachineStats, type ProcessGroupUsage } from './os/stats.js';
import { boardForViewer, boardView } from './board.js';
import { goalGraph } from './goal-graph.js';
import { MACHINE_CHANGES, MACHINE_HELPER, machineChanges, SLOTS_MAX, SLOTS_MIN, TEST_SLOTS_MAX, TEST_SLOTS_MIN, addProjectCommand } from './machine.js';
import { isMachineOwner, MACHINE_OWNERS_FILE, machineOwners } from './machine-owners.js';
import { MachineRequestError, machineRequests, requestAddProject, requestMachineChange, settingArgs, MACHINE_EVENTS, type MachineRequest } from './machine-requests.js';
import { ENGINE_CURRENT, installedEngine, lastCheck, UPDATES_CONFIG, UPDATES_LOG, UPDATES_STATE, updateLog, updatesPanel, updateSettings, type UpdatesDrain } from './updates.js';
import { updateDrain } from './update-drain.js';
import { updaterPlan, updaterSetup } from './updater-setup.js';
import { applySettings, changeSetting, currentValue, loadLimits, SETTING_KEYS, SettingsError, type SettingKey } from './settings.js';
import { researchForRun } from './research.js';
import { PolicyFile } from './instance.js';
import { parseDocument } from 'yaml';
import { buildReport } from './reports.js';
import { intakeHealth, intakeReports } from './intake/view.js';
import { throughput } from './throughput.js';
import { constraintsView } from './checks-from-feedback.js';
import { digestMarkdown, waitingOnYou } from './digest.js';
import { forViewers, stateForViewer, viewerActivity, viewerMaySee, VIEWER_EVENTS } from './viewer-events.js';
import { METRICS_DEFINITIONS, trustForViewer, trustView } from './trust.js';
import { deliveryMetrics } from './merge-metrics.js';
import { flakyView, releaseByOwner } from './flaky.js';
import { harnessEvalView } from './harness-evals/score.js';
import { learningsView, promoteRefusal } from './learnings.js';
import { assertLoopbackHost, breakGlassAllowed, DEVICE_HEADER, DEVICE_VIEWS, FRESH_HEADER, cachedRoles, isOwner, isWriter, LOGIN_HEADER, mayAnswerKind, repoPermission, validLogin, type ConsoleSession, type Role, type RoleOf, type SessionOf } from './dashboard-auth.js';
import { handleAskRoute } from './console/routes.js';
import { ADD_PROJECT_EVENTS, addProjectManual, addProjectView } from './console/add-project.js';
import { listInstallableRepos } from './setup/repo-picker.js';
import { engineRoot, firstRunLiveView, INIT_FILE, serverInitFile } from './init.js';
import { SETUP_STEPS, type DetectCache, type SetupContext, type SetupProbe } from './setup-steps.js';

/** The steps skipped on the first-run page, in the dashboard's state dir. */
export const SKIPS_FILE = 'first-run-skips.json';
import { applyPolicy, planPolicy, policyForm, PolicyEditError } from './policy-edit.js';
import { ConfigChangeError, configPrMerge, planConfigChange, proposeConfigChange, repoConfigForm } from './config-change.js';
import { configReady, newDraftJob, originPlan, pushableRepos, saveAnswers, setOrigin, setupPrMerge, SetupModeError, startDraft, type Run as SetupRun } from './setup-mode.js';
import { systemProbe } from './setup-steps.js';
import { gitRemoteRepo } from './install.js';
import type { InitIo } from './init.js';
import { actionPlan, ACTIONS, isActionId, systemActionDeps, type ActionDeps, type ActionId, type ActionPlan } from './setup-actions.js';
import { ClaudeSignin, claudeServerView, systemSigninDeps, type SigninDeps } from './claude-signin.js';
import { GhLogin, GhLoginError, type GhLoginDeps } from './gh-login.js';
import { applyIntake, botView, DISCORD_CREDENTIAL, DiscordSetupError, discordSetupView, discordTokenRule, planIntake, listingRunner, tokenAsk, tokenState, type BotView, type DiscordListingStandIn } from './intake/discord-setup.js';
import { INTAKE_FILE } from './intake/config.js';
import { checkRootStep } from './console/root-steps.js';
import { handleProfileRoute, isProfileRoute, refuseUnidentified } from './claude-profiles-routes.js';
import { profilesView } from './claude-profiles.js';
import { CLAUDE_ACCOUNT_DIR, claudeAccountView, ClaudeTokenError, mayViewClaudeAccount, requestClaudeAccount, storeSwitchToken } from './claude-account.js';
import { isTailscaleAction, mayViewTailscale, noTailscaleView, requestTailscale, stepsStamp, TAILSCALE_DIR, tailscaleStatus, tailscaleView, type TailscaleStatus } from './tailscale-setup.js';
import { readSecretBody } from './console/secrets.js';
import { AskError, asksFrom, ASK_EVENTS } from './console/asks.js';
import { incidentsView } from './watchdog/view.js';
import { effectiveRouting, ROUTING } from './routing.js';
import { refuseKeyInUrl } from './dashboard-key-url.js';
import { handleSiri, siriGatewayToken } from './siri/instance.js';
import { siriDevicesRoute } from './siri/manage.js';
import { RateLimits } from './siri/tokens.js';

/**
 * What the Settings page shows: the config's shape and choices, read-only.
 * Commands, connection fingerprints and deploy details stay out; editing
 * happens in the project's config folder, through review like any change.
 */
/** The settings as a viewer (read on the repo) sees them: the project part the Settings page shows them, nothing else. */
/** The disk floor on this machine now (src/governor-holds.ts), as doctor checks it: Settings' and First run's numbers; null when it can't be measured. */
export function diskFloorNow(o: Pick<DashboardOptions, 'root' | 'cfg'>, measure: (path: string) => { freeGb: number; totalGb: number } = diskFree) {
  try {
    return diskFloorCheck(measure(o.root), o.cfg.project.governor, o.cfg.tests.worktree.est_size_gb);
  } catch {
    return null;
  }
}

export function settingsForViewer(cfg: Config) {
  const v = settingsView(cfg);
  return { configDir: v.configDir, project: v.project, owners: v.owners, reports: v.reports, forViewer: true as const };
}

/** WHY: the dashboard's cfg is the repo's; the panel shows what runs, so the instance's settings go over it (item 32). */
export function routingInEffect(o: Pick<DashboardOptions, 'policyFile' | 'cfg'>) {
  let cfg = o.cfg;
  try {
    if (o.policyFile) cfg = applySettings(o.cfg, PolicyFile.parse(parseDocument(readFileSync(o.policyFile, 'utf8')).toJS()).settings);
  } catch {
    // WHY: the Instance settings panel reports an unreadable policy; this panel still shows the repo's routing.
  }
  return effectiveRouting(cfg.agents).map((r) => ({ ...r, task: ROUTING[r.key].task }));
}

export function settingsView(cfg: Config, routing = routingInEffect({ cfg, policyFile: null })) {
  return {
    configDir: BRAND.configDir,
    project: { name: cfg.project.project.name, repo: cfg.project.project.repo, landMode: cfg.project.land_mode, runtime: cfg.project.agent_runtime, ci: ciMode(cfg) },
    owners: cfg.project.owners,
    reports: cfg.project.reports,
    governor: cfg.project.governor,
    agents: {
      budget: cfg.agents.daily_budget_usd,
      roles: Object.entries(cfg.agents.roles).map(([name, r]) => ({ name, enabled: r!.enabled, model: r!.model, count: r!.count ?? null })),
    },
    routing,
    tests: { gates: cfg.tests.gates, batchMax: cfg.tests.land.batch_max, nightlyAt: cfg.tests.nightly_at ?? null, tiers: Object.keys(cfg.tests.tiers ?? {}), baselineParser: !!cfg.tests.failures },
    review: cfg.review ? { levels: Object.fromEntries(Object.entries(cfg.review.levels).map(([k, v]) => [k, (v as { when: string[] }).when]))} : null,
    guardrails: { rules: cfg.guardrails.rules.length, protectedPaths: cfg.guardrails.protected_paths, secretPaths: cfg.guardrails.secret_paths.length, network: cfg.guardrails.network ? 'restricted' : 'open', preApproved: cfg.guardrails.pre_approved },
    deploy: cfg.deploy ? { environments: cfg.deploy.environments.map((e) => ({ name: e.name, production: e.production })), prodRead: !!cfg.deploy.prod_read } : null,
  };
}


/** The updater's drain in force now (src/update-drain.ts), with what is still finishing; null when none. Read-only. */
export function drainView(dir?: string, now = Date.now()): UpdatesDrain | null {
  const d = updateDrain(dir, now);
  if (!d) return null;
  const slots = slotStatus(dir);
  return { since: d.since, until: d.until, to: d.to, testRuns: testSlotsHeld(dir).length + (slots.fullRun ? 1 : 0), agents: slots.agents.length };
}

export interface DashboardOptions {
  root: string;
  cfg: Config;
  /** The disk's free and total GB at a path, for the disk floor's numbers (tests stand in for it); absent: the real one. */
  diskFree?: (path: string) => { freeGb: number; totalGb: number };
  eventsDb: string;
  stateDir: string;
  /** The login recorded for the break-glass (the token used on this machine with no person named): the owner's. */
  user: string;
  /**
   * A signed-in person's role on this instance, from their permission on its repo (cached at most 5 minutes);
   * none when unset, so every person the hub names is refused.
   */
  roleOf?: RoleOf;
  /** The instance's intake.yaml (in its home): voice intake is taken only when it turns voice on. None: no voice intake. */
  intakeFile?: string;
  /** The instance this server serves (recorded in the audit); none for a checkout. */
  instance?: string;
  /**
   * Who is asking, for routes that need a ConsoleSession (the setup console): `dashboardSession` when unset, the
   * identity this server resolved for the request (login and role from the repo; sign-in time from the hub).
   */
  session?: SessionOf;
  /** Where it listens: loopback only (127.0.0.1 when unset); anything else is refused. */
  host?: string;
  port?: number;
  webDir?: string;
  pollMs?: number;
  /** Where the coordinator's service log is (the Logs page); none when unset. */
  logs?: LogSource;
  /** Reads a unit's journal; journalctl as this user when unset. */
  journalReader?: JournalReader;
  /** The machine's slots directory (agent slots and the emergency STOP file); the usual one when unset. */
  slotsDir?: string;
  /**
   * Who this instance's coordinator is on the machine (its user@host, which starts its test slots' owner); this
   * process's when unset (an instance's dashboard runs as its coordinator user). Tests set it.
   */
  actor?: string;
  /** The full-run lock whose holders the test-runs view shows (tests). */
  /** Root's GPU opt-in file and the uid that must own it (tests: their own; src/testrun/gpu.ts). */
  gpuFile?: string;
  gpuFileUid?: number;
  testRunLock?: string;
  /** The instance's policy file (its auto-merge kill switch and settings); none for a checkout. */
  policyFile?: string | null;
  /** The machine and service stats for the health view; the OS adapter's machineStats when unset. */
  machineStats?: () => MachineStats | null;
  /** What running agents' process groups use now, for the board; the OS adapter's processGroupUsage when unset. */
  processUsage?: (pgids: number[]) => Map<number, ProcessGroupUsage>;
  /** The backlog a confirmed chat draft is filed to (the instance's); made when first needed. */
  backlog?: () => Backlog;
  /** The machine's limits file for settings; the system one when unset. */
  limitsPath?: string;
  /** gitleaks over an uploaded chat attachment (src/chat-attachments.ts); null: the engine's patterns only. Tests set it. */
  attachmentScan?: ((path: string) => Promise<string[]>) | null;
  /** Machine settings: where the helper's change log and the updater's files are (the system's when unset). Changes go to the coordinator (src/machine-requests.ts); this server never runs sudo. */
  machine?: { changesPath?: string; updatesConfigPath?: string; updatesLogPath?: string; updatesStatePath?: string; enginePath?: string; signersPath?: string; pendingSignersPath?: string; helperRulesPath?: string };
  /** The git the main watch's accept reads (tests); the instance's clone, as the watch reads it, when unset. */
  acceptGit?: AcceptGit;
  /** Where pasted secrets go: the coordinator user's home (src/console/secrets.ts); this process's home when unset. */
  secretsHome?: string;
  /** The machine owners file (src/machine-owners.ts); the system's when unset (tests). */
  machineOwnersFile?: string;
  /** Where claude-account.sh writes status.json and switch.jsonl (src/claude-account.ts); the system's when unset (tests). */
  claudeAccountDir?: string;
  /** Where tailscale.sh writes steps.jsonl and the login link, and what its status says (src/tailscale-setup.ts); the system's when unset (tests). */
  tailscaleDir?: string;
  tailscaleStatus?: () => Promise<TailscaleStatus | null>;
  /** What the first-run page's live checks ask of the machine (src/setup-steps.ts); the real one when unset (tests). */
  setupProbe?: SetupProbe;
  /** The machine paths and instance facts those checks read (tests). */
  setupContext?: Partial<Pick<SetupContext, 'machine' | 'instanceFacts'>>;
  /** The first-run page's Start: installs and starts the coordinator's service; the OS adapter's installService when unset (tests). */
  startService?: (spec: ServiceSpec) => { path: string; started: boolean; detail: string };
  /** WHY: tests stand in for the checkout's git (src/checkout-sync.ts); git in the checkout when unset. */
  checkoutGit?: GitRun;
  /** WHY: tests stand in for what the first-run page's Fix actions do to the machine (src/setup-actions.ts). */
  setupActions?: Partial<ActionDeps>;
  /** WHY: tests stand in for claude auth login and claude auth status (src/claude-signin.ts). */
  claudeSignin?: Partial<SigninDeps>;
  /** WHY: a checkout with no config yet (src/setup-mode.ts): the first-run page alone; tests stand in for its commands. */
  setupMode?: { run?: SetupRun; io?: InitIo };
  /** WHY: tests stand in for gh in Connect GitHub's device login (src/gh-login.ts). */
  ghLogin?: Partial<GhLoginDeps>;
  /**
   * WHY: tests and CI answer the bot's channel listing in-process instead of its child process (src/intake/discord-setup.ts),
   * only through a stand-in made in code by discordListingStandIn; anything else here is refused. Unset: this engine's own
   * cli.js, by absolute path.
   */
  discordListing?: DiscordListingStandIn;
  /** People's pictures (src/avatars.ts): a stand-in for GitHub, in code, for tests. */
  avatars?: AvatarOptions;
}

/** What the first-run page's Start does, shown before it does it (GET /api/first-run's start). */
export type FirstRunStart =
  /** Local mode: this user's own service, through the same spec as `up` (src/service.ts localServiceSpec). */
  | { kind: 'local'; label: string; file: string; manager: string; commands: string[]; program: string[]; log: string }
  /** A server instance: nothing here may start it; the command an owner runs, and why. */
  | { kind: 'owner-command'; unit: string; command: string; why: string }
  | { kind: 'unsupported'; why: string };

export function firstRunStart(o: { root: string; cfg: Config; instance?: string | null; setupMode?: unknown }): FirstRunStart {
  if (o.setupMode) return { kind: 'unsupported', why: "the coordinator starts from this checkout's own config, and it has none yet: finish the repo config first" };
  if (o.instance) {
    const unit = instanceUnit(o.instance);
    // The machine helper's commands run through the coordinator (src/machine-requests.ts), and the coordinator is the
    // thing that isn't running: its add-project would start the unit, but nothing would pick the request up.
    const helper = checkRootStep('add-project', [o.instance, o.cfg.project.project.repo]);
    return {
      kind: 'owner-command',
      unit,
      command: `sudo bash ${join(engineRoot(), 'scripts', 'setup', 'service.sh')} ${o.instance}`,
      why: `the dashboard never runs sudo, and the machine helper's commands${helper.allowed ? ' (add-project would start it)' : ''} are run by the coordinator, which is what isn't running: an owner runs this at a root shell on the machine`,
    };
  }
  const spec = localServiceSpec(o.root, o.cfg);
  const change = serviceChange(spec.label);
  if (!change) return { kind: 'unsupported', why: 'agents need macOS, Linux or WSL2; on native Windows run the coordinator on another machine' };
  return { kind: 'local', label: spec.label, file: change.path, manager: change.manager, commands: change.commands, program: spec.program, log: spec.logFile };
}

/**
 * The emergency stop as the dashboard shows it, read-only: whether one is in
 * force on this machine now (the STOP file), and whether this instance's
 * coordinator has halted for it (its own emergency.stop event since then).
 */
export function stopStatus(inForce: EmergencyStop | null, record: { lastStop: { at: string; by: string; reason: string; running: number } | null; lastResume: string | null }) {
  const since = inForce?.at ? Date.parse(inForce.at) : NaN;
  const halted = !!inForce && !!record.lastStop && (Number.isNaN(since) || Date.parse(record.lastStop.at) >= since) && !(record.lastResume && Date.parse(record.lastResume) > Date.parse(record.lastStop.at));
  return {
    inForce,
    /** This coordinator acknowledged it: halted its agents (how many were running) and starts none. */
    halted: halted ? { at: record.lastStop!.at, running: record.lastStop!.running } : null,
    lastStop: record.lastStop,
    lastResume: record.lastResume,
  };
}

export { mayAnswer };

/** What a slot or lock held by anyone but this instance shows as: that it is held, never by whom or for what. */
export const ELSEWHERE = 'another instance or job on this machine';

/**
 * The machine's slot and lock holders as one instance's dashboard may show them. The slots are shared by every
 * instance on the machine, and a holder's owner names its project, issue or run; so only this instance's own
 * holders keep it (its agent slots and land gate, `<cli> <project> ...`; its test slots, `<actor> ...`). Any
 * other holder is counted, with its slot and since when, as held elsewhere: no owner, no pid. Fails closed: a
 * holder that doesn't name this instance is someone else's.
 */
export function ownHolders(o: { project: string; actor: string }) {
  const mine = (owner: string) => owner.startsWith(`${BRAND.cli} ${o.project} `) || owner.startsWith(`${o.actor} `);
  return <T extends { owner: string; acquiredAt: string; pid?: number }>(h: T): T | { owner: string; acquiredAt: string; elsewhere: true } & Omit<T, 'owner' | 'pid'> => {
    if (mine(h.owner)) return h;
    const { owner: _owner, pid: _pid, ...rest } = h;
    return { ...rest, owner: ELSEWHERE, elsewhere: true };
  };
}

/** Who is asking: a signed-in person the hub named (their role read from the repo), or the owner's break-glass. */
export interface Who {
  login: string;
  role: Role;
  via: 'session' | 'break-glass';
  /** Whether the hub identified this request's device as an allowed console device (a write's only; false for the break-glass). */
  deviceOk: boolean;
}

/** The identity each request was resolved to, for as long as the request lives. */
const resolved = new WeakMap<IncomingMessage, ConsoleSession>();

/**
 * The session behind a request on an instance's dashboard, once the server has resolved it (after the token
 * check): the person and their role from the repo, the hub's sign-in time. CSRF is the hub's to check (it
 * refuses a write without the session's token before forwarding), and the break-glass is a bearer token, not
 * a cookie, so csrfOk is true for any request that got here. Null before or without that.
 */
export const dashboardSession: SessionOf = (req) => resolved.get(req) ?? null;

/** Who may read the next report's preview (spend, and the throughput section): the instance's owners and writers. */
export const mayReadReports = (role: Role | null | undefined) => isWriter(role);
/** Who may read intake reports (redacted, but people's words): the instance's owners and writers. */
export const mayReadIntake = (role: Role | null | undefined) => isWriter(role);
/** Who may read throughput (what runs cost, where PRs waited): the instance's owners and writers. */
export const mayReadThroughput = (role: Role | null | undefined) => isWriter(role);
/** Who may read what waits on the owner (the digest): the instance's owners and writers. */
export const mayReadDigest = (role: Role | null | undefined) => isWriter(role);
/**
 * Who may read agent runs (every route under /api/runs: a run's record, its live feed, a research run's
 * searches and pages): the instance's owners and writers. Writing to a run (a console message, a stop)
 * stays the owner's alone, checked on those routes as well.
 */
export const mayReadRuns = (role: Role | null | undefined) => isWriter(role);

/** Why a reader is refused something that is the owners' and writers' to read. */
const writersOnly = (what: string, who: Who) => `${what} for the instance's owners and writers (admin or write on its repo); @${who.login} is a ${who.role}`;

/**
 * Every path that serves agent runs, which the run-reading gate covers whatever route is added there:
 * everything under /api/runs, the list of live runs (/api/live), and the Board's Watch (/api/board/watch/<run>).
 */
export const isRunsPath = (pathname: string) => pathname === '/api/runs' || pathname.startsWith('/api/runs/') || pathname === '/api/live' || pathname.startsWith('/api/board/watch/');

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

/**
 * A page of the engine's docs on its public repository, from package.json (docs aren't in the package);
 * null when the package names no https repository.
 */
export function docsUrl(page: string, repository: unknown = enginePackage().repository): string | null {
  const raw = typeof repository === 'string' ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof raw !== 'string') return null;
  const base = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\/[^/\s]+\/[^\s]+$/.test(base) ? `${base}/blob/main/docs/${page}.md` : null;
}
const enginePackage = (): { repository?: unknown } => JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { repository?: unknown };

/**
 * Which log and state a dashboard reads. A project checkout's own, or, with
 * an instance, that instance's: run it as the instance's coordinator user,
 * the only user that can read (and, for answers, write) the instance's log.
 */
export function dashboardSite(root: string, instance?: string, dir = instancesDir()): { root: string; cfg: Config; eventsDb: string; stateDir: string; port: number; logs: LogSource; policyFile: string | null; backlog: () => Backlog; roleOf?: RoleOf; intakeFile?: string } {
  const i = instance ? loadInstance(instance, dir) : null;
  const s = i ? siteForInstance(i) : siteForRoot(root);
  // An instance's service on Linux is the systemd unit the setup scripts install; elsewhere the coordinator writes its own log file.
  const logs = { unit: instance ? `${BRAND.cli}-${instance}.service` : null, file: join(s.stateDir, 'coordinator.log') };
  // The backlog the coordinator files to, made when first needed: an instance's with its App's tokens.
  const backlog = () => (i ? backlogFor(s.cfg, s.root, s.stateDir, instanceTokens(i, instanceEnv(i))) : backlogFor(s.cfg, s.root, s.stateDir));
  // A signed-in person's role here: their permission on the instance's repo, read with the instance's own token.
  const roleOf = i ? cachedRoles(repoPermission({ repo: i.repo.repo, token: instanceTokens(i, instanceEnv(i)), api: GITHUB_API })) : undefined;
  return { root: s.root, cfg: s.cfg, eventsDb: s.logPath, stateDir: s.stateDir, port: instance ? instancePort(instance) : LOCAL_DASHBOARD_PORT, logs, policyFile: i ? join(i.home, 'policy.yaml') : null, backlog, ...(roleOf ? { roleOf } : {}), ...(i ? { intakeFile: join(i.home, INTAKE_FILE) } : {}) };
}

/**
 * A chat answer as this dashboard's user may see it: the owner gets it whole; anyone else the answer and its
 * citations, never a draft or a proposal (the coordinator answers them read-only already; this holds it here too).
 */
export function chatAnswerFor(f: ChatAnswerFile, owner: boolean): ChatAnswerFile {
  if (owner || f.state !== 'answered') return f;
  return { ...f, answer: { ...f.answer, issueDraft: null, actions: [], refusedActions: [], readOnly: true } };
}

/** Where a filed chat draft is recorded, so the same draft is never filed twice. */
const filedPath = (stateDir: string, id: string) => join(stateDir, 'chat', 'filed', `${id}.json`);

/**
 * What the health view reads: the OS adapter's snapshot of the machine, the
 * harness's slice and this instance's service (when there is one), and the
 * volumes of the checkout and the state dir.
 */
export function healthStats(o: { serviceUnit: string | null; root: string; stateDir: string }): MachineStats {
  return machineStats({ units: [`${BRAND.cli}.slice`, ...(o.serviceUnit ? [o.serviceUnit] : [])], paths: [...new Set([o.root, o.stateDir])] });
}

/**
 * The machine-wide settings as the Settings page shows them: the agent slot cap now (and its bounds), whether
 * engine updates are on (null when the updater isn't set up here), who may change them, and their history:
 * the helper's change log and the updater's log, newest first.
 */
export function machineView(o: Pick<DashboardOptions, 'cfg' | 'user' | 'slotsDir' | 'machine' | 'machineOwnersFile'> & { role?: Role | null; breakGlass?: boolean; deviceOk?: boolean; requests?: MachineRequest[] }) {
  const owner = o.cfg.project.owners.default;
  const slots = slotStatus(o.slotsDir);
  const updates = updateSettings(o.machine?.updatesConfigPath ?? UPDATES_CONFIG);
  const ownersFile = o.machineOwnersFile ?? MACHINE_OWNERS_FILE;
  const machineOwner = !!o.breakGlass || isMachineOwner(o.user, ownersFile);
  return {
    owner,
    user: o.user,
    /** The machine's owners (src/machine-owners.ts): only they (or the break-glass) may change these. */
    machineOwners: machineOwners(ownersFile),
    /** Whether this person is one of them (true on the break-glass). */
    machineOwner,
    /** An instance owner who is a machine owner; the server checks the device again on each change. */
    canChange: isOwner(o.role) && machineOwner,
    /** What a change needs besides, for the page to say (nothing on the break-glass). */
    needs: o.breakGlass ? null : 'one of the console\'s allowed devices',
    /** Whether this request came from one (the hub says, on this view's read as on a change; always on the break-glass). */
    deviceReady: !!o.breakGlass || !!o.deviceOk,
    helper: MACHINE_HELPER,
    slots: { cap: slots.cap, running: slots.agents.length, min: SLOTS_MIN, max: SLOTS_MAX },
    testSlots: { cap: testSlotCap(o.slotsDir), running: testSlotsHeld(o.slotsDir).length, min: TEST_SLOTS_MIN, max: TEST_SLOTS_MAX },
    updates: updates ? { configured: true as const, enabled: updates.enabled, branch: updates.branch, requiredChecks: updates.required_checks } : { configured: false as const, enabled: null },
    /** The updater's setup (src/updater-setup.ts): installed or not, its channel, the release signers listed, and the same steps as a script. */
    updater: updaterSetup({ ...(o.machine?.updatesConfigPath ? { updatesConfigPath: o.machine.updatesConfigPath } : {}), ...(o.machine?.signersPath ? { signersPath: o.machine.signersPath } : {}), ...(o.machine?.pendingSignersPath ? { pendingPath: o.machine.pendingSignersPath } : {}) }),
    changes: machineChanges(o.machine?.changesPath ?? MACHINE_CHANGES).reverse(),
    history: updateLog(o.machine?.updatesLogPath ?? UPDATES_LOG).reverse(),
    /** Changes asked for here, for the coordinator to run: pending, running, then done, failed, refused or interrupted. Newest first. */
    requests: (o.requests ?? []).filter((r) => r.via === 'settings').slice(-20).reverse(),
  };
}

/** The runs live now, for the Agents page; their held messages' text only for the owner, who may control them. */
export function liveView(o: Pick<DashboardOptions, 'stateDir' | 'cfg' | 'user'> & { role?: Role | null }) {
  const owner = o.cfg.project.owners.default;
  const canControl = isOwner(o.role);
  return { owner, canControl, runs: liveRuns(o.stateDir).map((r) => ({ ...r, pending: canControl ? r.pending : r.pending.map((m) => ({ id: m.id, by: m.by, at: m.at, text: '' })) })) };
}

/**
 * A run's feed after `after`; while the run is live but its feed isn't written yet, nothing so far (not an error).
 * Reading it is the runs gate's to allow (the owner and the writers), as for the rest of a run's record; only a
 * message or a stop is the owner's alone (sendMessage, stopRun).
 */
function feedOrWait(o: Pick<DashboardOptions, 'stateDir'>, run: string, after: number): { items: FeedItem[]; ended: boolean } {
  const f = readFeed(o.stateDir, run, after);
  if (f) return f;
  if (liveRuns(o.stateDir).some((r) => r.run === run)) return { items: [], ended: false };
  throw new ConsoleError(`no feed for run ${run}`);
}

/**
 * What the run page's console needs: whether the run is live, whether this user may message it (the owner and the
 * writers) or stop it (the owner), its messages held until the agent's turn ends, and the console's events for it
 * (queued, delivered, dropped, stopped, refused), oldest first. Messages' text stays the owner's to read.
 */
export function consoleView(o: Pick<DashboardOptions, 'stateDir' | 'cfg' | 'user' | 'eventsDb'> & { role?: Role | null }, run: string) {
  const owner = o.cfg.project.owners.default;
  const canControl = isOwner(o.role);
  const live = liveRuns(o.stateDir).find((r) => r.run === run) ?? null;
  const events = readEvents(o.eventsDb)
    .filter((e) => e.type.startsWith('console.') && ((e.payload as { run?: string }).run === run))
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return { at: e.ts, type: e.type.slice('console.'.length), id: (p.id as string | undefined) ?? null, by: (p.by as string | undefined) ?? null, text: canControl ? ((p.text as string | undefined) ?? null) : null, why: (p.why as string | undefined) ?? null };
    });
  const settled = new Set(events.filter((e) => e.type === 'message_delivered' || e.type === 'message_dropped').map((e) => e.id));
  const held = events.filter((e) => e.type === 'message_queued' && !settled.has(e.id));
  return { owner, canControl, canMessage: isWriter(o.role), live: !!live, pending: canControl ? (live?.pending ?? []) : [], held, events };
}

/**
 * Where each instance setting lives in the repo's config, or null when the repo's config can't set it.
 * Every setting key must say (a Record over SettingKey): a new key without a place doesn't compile.
 */
const REPO_PLACE: Record<SettingKey, { file: string; path: string[] } | null> = {
  workers: { file: 'agents.yaml', path: ['roles', 'workers', 'count'] },
  daily_budget_usd: { file: 'agents.yaml', path: ['daily_budget_usd'] },
  'ci_repair.enabled': { file: 'agents.yaml', path: ['roles', 'ci_repair', 'enabled'] },
  'ci_repair.max_fixes_per_pr': { file: 'agents.yaml', path: ['roles', 'ci_repair', 'max_fixes_per_pr'] },
  run_windows: { file: 'config.yaml', path: ['agent_runtime', 'run_windows'] },
  stuck_guard: null,
  'research.max_searches_per_day': null,
  'research.max_fetches_per_day': null,
  'research.max_usd_per_day': null,
  'research.repo_access': null,
  // Intake's caps default from intake.yaml in the instance home, never from the repo's config.
  'intake.reports_per_sender_per_day': null,
  'intake.drafts_per_day': null,
  'intake.max_usd_per_day': null,
  'chat_attachments.max_file_mb': null,
  'chat_attachments.max_message_mb': null,
  'chat_attachments.retention_days': null,
};

const defines = (obj: unknown, path: string[]): boolean => {
  let at = obj;
  for (const k of path) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, k)) return false;
    at = (at as Record<string, unknown>)[k];
  }
  return at !== undefined && at !== null;
};

/** The repo's config files as written, before the schema's defaults: what the repo itself defines. Unreadable: none. */
export function repoConfigFiles(dir: string): (file: string) => unknown {
  const cache = new Map<string, unknown>();
  return (file) => {
    if (!cache.has(file)) {
      let raw: unknown;
      try {
        raw = parseDocument(readFileSync(join(dir, file), 'utf8')).toJS();
      } catch {
        raw = undefined;
      }
      cache.set(file, raw);
    }
    return cache.get(file);
  };
}

/**
 * Where a setting's value in effect comes from: the instance's policy when it sets the key (its dotted path),
 * else the repo's config when that defines it, else the engine's own default.
 */
export function settingSource(key: SettingKey, instance: unknown, repo: (file: string) => unknown): 'instance' | 'repo' | 'engine' {
  if (defines(instance, key.split('.'))) return 'instance';
  const place = REPO_PLACE[key];
  return place && defines(repo(place.file), place.path) ? 'repo' : 'engine';
}

/** The instance's agents (workers) in effect: its policy's setting, else the repo's; read only, for the Trust panel. */
export function instanceAgents(o: Pick<DashboardOptions, 'policyFile' | 'cfg'>): number {
  let settings = {};
  try {
    if (o.policyFile) settings = PolicyFile.parse(parseDocument(readFileSync(o.policyFile, 'utf8')).toJS()).settings;
  } catch {
    // an unreadable policy: the repo's value
  }
  return Number(currentValue(o.cfg, settings, 'workers'));
}

/**
 * The Settings page's instance section: each setting's value in effect and where it comes from (the
 * instance's policy, the repo's config, or the engine's default), the bounds a new value must keep (the machine's limits and
 * the policy's own ceilings), and whether this dashboard's user, the owner, may change them.
 */
export function instanceSettingsView(o: Pick<DashboardOptions, 'policyFile' | 'cfg' | 'user' | 'limitsPath'> & { role?: Role | null }) {
  const owner = o.cfg.project.owners.default;
  const base = { owner, user: o.user, canChange: !!o.policyFile && isOwner(o.role), keys: [...SETTING_KEYS] };
  if (!o.policyFile) return { ...base, available: false as const, why: "settings belong to an instance: this dashboard serves a checkout, whose config comes from the repo" };
  let limits: ReturnType<typeof loadLimits> | null = null;
  let limitsError: string | null = null;
  try {
    limits = loadLimits(o.limitsPath);
  } catch (e) {
    limitsError = (e as Error).message;
  }
  let policy: PolicyFile;
  try {
    policy = PolicyFile.parse(parseDocument(readFileSync(o.policyFile, 'utf8')).toJS());
  } catch (e) {
    return { ...base, canChange: false, available: false as const, why: `the instance policy can't be read: ${(e as Error).message.split('\n')[0]}` };
  }
  const s = policy.settings;
  const repo = repoConfigFiles(o.cfg.dir);
  return {
    ...base,
    canChange: base.canChange && !limitsError,
    available: true as const,
    limits,
    limitsError,
    ceilings: { max_workers: policy.agents.max_workers, daily_usd: policy.budget.daily_usd },
    settings: SETTING_KEYS.map((key) => ({ key, value: currentValue(o.cfg, s, key), source: settingSource(key, s, repo) })),
  };
}

/** A research run for its page: each search, each fetch (refused or not), and every cap it stopped at. */
export function researchView(events: { type: string; payload: unknown }[], run: string) {
  const capped = events.filter((e) => e.type === 'research.capped' && (e.payload as { run?: string | null }).run === run).map((e) => String((e.payload as { why?: string }).why ?? ''));
  return { ...researchForRun(events, run), capped };
}

/** Open PRs, and those needing a person: waiting on their review, or a CI fix that gave up. */
export const prCounts = (prs: { state: string; phase: string }[]) => ({
  open: prs.filter((p) => p.state === 'open').length,
  needYou: prs.filter((p) => p.phase === 'waiting' || p.phase === 'gave_up').length,
});

/**
 * Whether this instance merges its own PRs now, read-only, from the same three
 * places the coordinator reads: the instance policy's kill switch (auto_merge,
 * re-read every time), the repo's review.yaml merge.auto, and the stop file a
 * red main after an auto-merge leaves until the operator clears it. Without an
 * instance (a checkout) there is no policy, so nothing auto-merges.
 */
export function autoMergeState(o: { policyFile: string | null; repoAuto: boolean | null; stateDir: string }) {
  let policy: boolean | null = null;
  let policyProblem: string | null = null;
  if (o.policyFile) {
    const r = readPolicy(o.policyFile);
    if (r.policy) policy = r.policy.auto_merge;
    else {
      policy = false;
      policyProblem = `the instance policy can't be read (${r.errors.map((e) => e.message).join('; ') || 'unreadable'}), so auto-merge counts as off`;
    }
  }
  const stopFile = join(o.stateDir, 'auto-merge-stopped.json');
  let stopped: string | null = null;
  if (existsSync(stopFile)) {
    try {
      stopped = String((JSON.parse(readFileSync(stopFile, 'utf8')) as { reason?: string }).reason ?? 'stopped');
    } catch {
      stopped = 'the stop file is unreadable';
    }
  }
  const on = policy === true && o.repoAuto !== false && !stopped;
  const why = !o.policyFile
    ? 'no instance: only an instance merges its own PRs'
    : policy !== true
      ? (policyProblem ?? "the instance policy's kill switch (auto_merge) is off")
      : o.repoAuto === false
        ? "the repo's review.yaml turns auto-merge off"
        : stopped
          ? `stopped: ${stopped}; the operator clears it`
          : 'on: PRs the merge rules allow merge themselves';
  return { on, policy, repo: o.repoAuto, stopped, why };
}

/**
 * How the default branch is guarded, for the dashboard: "GitHub enforced" or the harness's own guard, the main watch (or off,
 * or not known yet), the last commit the watch checked, and, while an unaccounted commit's stop is in force, its alert.
 * Read-only, from the watch's state file and the log. A viewer is sent the mode only (viewer-events.ts).
 */
export function protectionState(o: { stateDir: string; repo: string; events: StoredEvent[]; role: Role | null }) {
  const view = protectionView(join(o.stateDir, 'main-watch.json'), o.repo);
  const stop = readStopFile(o.stateDir);
  const last = o.events.filter((e) => e.type === 'main_watch.unaccounted').at(-1);
  const p = last?.payload as EventPayload<'main_watch.unaccounted'> | undefined;
  const alert = stop && stop.by === 'main_watch' && p ? { at: last!.ts, sha: p.sha, url: p.url, reason: p.reason, number: p.number, revert: p.revert } : null;
  // Each acceptance, and the commit the watch applied it to (main_watch.accepted), if it has yet.
  const applied = new Map(o.events.filter((e) => e.type === 'main_watch.accepted').map((e) => [(e.payload as EventPayload<'main_watch.accepted'>).id, (e.payload as EventPayload<'main_watch.accepted'>).sha]));
  const accepted = view.accepted.map((a) => ({ id: a.id, sha: a.sha, pr: a.pr, head: a.head, by: a.by, reason: a.reason, at: a.at, appliedTo: applied.get(a.id) ?? null }));
  return { ...view, accepted, alert, directPush: lastDirectPush(o.events), stopped: stop?.reason ?? null, canClear: isOwner(o.role) && !!stop, canAccept: isOwner(o.role) && view.mode === 'main_watch' };
}

/**
 * The last commit that landed without a PR, and its ops-channel alert (src/direct-push-alert.ts): posted, how many
 * owners it mentioned, and why nobody was (or why it wasn't posted, or that the alert is off); null when none.
 */
export function lastDirectPush(events: StoredEvent[]) {
  const e = events.filter((x) => x.type === 'main_watch.direct_push').at(-1);
  if (!e) return null;
  const p = e.payload as EventPayload<'main_watch.direct_push'>;
  const a = events
    .filter((x) => x.type === 'main_watch.direct_push_alert')
    .map((x) => x.payload as EventPayload<'main_watch.direct_push_alert'>)
    .filter((x) => x.sha === p.sha)
    .at(-1);
  const status = !p.alert ? 'off' : !a ? 'pending' : a.ok ? 'posted' : 'not_posted';
  const note = !p.alert ? 'the direct-push alert is off (config.yaml main_watch.direct_push_alert: false)' : (a?.note ?? null);
  return { at: e.ts, sha: p.sha, url: p.url, kind: p.kind, pusher: p.pusher, status, mentioned: a?.mentioned ?? 0, note };
}

/** The PRs whose merge the main watch has judged already (accounted, accepted or not): none of them can be accepted. */
export function judgedPrs(events: StoredEvent[]): number[] {
  const out = new Set<number>();
  for (const e of events) {
    if (e.type !== 'main_watch.checked' && e.type !== 'main_watch.unaccounted' && e.type !== 'main_watch.accepted') continue;
    const n = (e.payload as { number: number | null }).number;
    if (n) out.add(n);
  }
  return [...out];
}

/** What an accept request names: `pr` (a number), or `sha`; null when neither, or both. */
export function acceptTarget(body: { sha?: unknown; pr?: unknown }): AcceptTarget | null {
  const hasSha = body.sha !== undefined && body.sha !== null && body.sha !== '';
  const hasPr = body.pr !== undefined && body.pr !== null && body.pr !== '';
  if (hasSha === hasPr) return null;
  return hasSha ? { sha: String(body.sha) } : { pr: Number(body.pr) };
}

function readStopFile(stateDir: string): { reason: string; by: string | null } | null {
  const file = join(stateDir, 'auto-merge-stopped.json');
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { reason?: unknown; by?: unknown };
    return { reason: String(j.reason ?? 'stopped'), by: typeof j.by === 'string' ? j.by : null };
  } catch {
    return { reason: 'the stop file is unreadable', by: null };
  }
}

/** An admin resumes auto-merge from the dashboard: the stop file goes, and merge.resumed records who did. */
export function clearAutoMergeStop(o: { stateDir: string; eventsDb: string; by: string }): { ok: true; reason: string } | { ok: false; error: string } {
  const stop = readStopFile(o.stateDir);
  if (!stop) return { ok: false, error: 'auto-merge is not stopped' };
  rmSync(join(o.stateDir, 'auto-merge-stopped.json'), { force: true });
  const log = new EventLog(o.eventsDb);
  try {
    log.append('merge.resumed', { detail: `@${o.by} cleared the stop on the dashboard (${stop.reason.slice(0, 300)})` }, o.by, 'human');
  } finally {
    log.close();
  }
  return { ok: true, reason: stop.reason };
}

/** Where the coordinator's service output is:its systemd unit's journal and/or the log file a launchd or user service writes. */
export interface LogSource {
  unit: string | null;
  file: string | null;
}

export interface LogEntry {
  at: string | null;
  /** syslog priority (0 emergency .. 7 debug), when the journal gives one. */
  priority: number | null;
  message: string;
}

export interface ServiceLog {
  source: 'journal' | 'file' | 'none';
  unit: string | null;
  entries: LogEntry[];
  /** Why nothing could be read, and what fixes it. */
  problem: string | null;
}

/** Reads a unit's journal as the current user. Injected in tests. */
export type JournalReader = (unit: string, lines: number) => { status: number | null; stdout: string; stderr: string };

const journalctl: JournalReader = (unit, lines) => {
  const r = spawnSync('journalctl', ['--unit', unit, '--output', 'json', '--lines', String(lines), '--no-pager', '--quiet'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
};

const clip = (s: string) => redactString(s.length > 2000 ? `${s.slice(0, 2000)} …` : s);

/**
 * The coordinator's service log, read-only, as the dashboard's user (the
 * instance's coordinator user): its unit's journal, or else its log file.
 * An unprivileged user reads only journal files it owns: with the journal
 * kept on disk and split per user (systemd's default), that is exactly its
 * own service's lines, and no other instance's.
 */
export function readServiceLog(src: LogSource, lines = 200, read: JournalReader = journalctl): ServiceLog {
  let problem: string | null = null;
  if (src.unit) {
    const r = read(src.unit, lines);
    if (r.status === 0) {
      const entries: LogEntry[] = [];
      for (const l of r.stdout.split('\n')) {
        if (!l.trim()) continue;
        try {
          const j = JSON.parse(l) as { MESSAGE?: string | number[] | null; PRIORITY?: string; __REALTIME_TIMESTAMP?: string };
          const msg = typeof j.MESSAGE === 'string' ? j.MESSAGE : Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString('utf8') : '';
          const us = Number(j.__REALTIME_TIMESTAMP);
          entries.push({ at: Number.isFinite(us) && us > 0 ? new Date(us / 1000).toISOString() : null, priority: j.PRIORITY !== undefined && /^\d$/.test(j.PRIORITY) ? Number(j.PRIORITY) : null, message: clip(msg) });
        } catch {
          // not a journal record
        }
      }
      if (entries.length) return { source: 'journal', unit: src.unit, entries, problem: null };
      problem = `no lines of ${src.unit} this user can read. Either the service hasn't logged yet, or the journal isn't kept on disk split per user, so the service's own user can't read its lines: run scripts/setup/journal.sh on the machine (as an admin).`;
    } else {
      problem = `journalctl couldn't read ${src.unit}: ${(r.stderr || `exit ${r.status}`).trim().split('\n').pop()}`;
    }
  }
  if (src.file && existsSync(src.file)) {
    const text = readFileSync(src.file, 'utf8');
    const entries = text.split('\n').filter((l) => l.trim()).slice(-lines).map((message) => ({ at: null, priority: null, message: clip(message) }));
    return { source: 'file', unit: src.unit, entries, problem: entries.length ? null : problem };
  }
  return { source: 'none', unit: src.unit, entries: [], problem: problem ?? 'no service log found: the coordinator runs in the foreground or as a service without a log file' };
}

/** WHY: a checkout's dashboard and `dashboard --detach` (src/dashboard-detach.ts) must agree, or a rerun prints another URL. */
export const LOCAL_DASHBOARD_PORT = 4317;
/** An instance's dashboard port, the same every time (so a tunnel to it can be set up once): 4400-4899, from its name. */
export const instancePort = (name: string) => 4400 + (createHash('sha256').update(name).digest().readUInt32BE(0) % 500);

/** Where the built web UI is served from: dist/web next to this module's dist/src (`npm run build:web` writes it there). */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

/** Whether the web UI is built where the dashboard serves it. */
export const webUiBuilt = (dir = DEFAULT_WEB_DIR) => existsSync(join(dir, 'index.html'));

/**
 * Whether a request carries this token in its bearer header, compared in constant time. INVARIANT: never from the
 * URL; a key in a URL is refused before this is asked (src/dashboard-key-url.ts).
 */
export function tokenGiven(req: IncomingMessage, _url: URL, token: string): boolean {
  const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The built UI; anything unknown falls back to index.html (client-side routes). Never a file outside webDir. */
/** The marker a hub puts on the page it serves, so the UI asks for the hub's instances only there (else /api/hub is a 404). */
export const HUB_MARKER = '<meta name="dashboard-hub" content="1">';

/**
 * The dashboard page's content security policy, on the hub and on an instance's own server: everything from this
 * origin only. People's pictures come from this server too (src/avatars.ts), read with the page's own auth and shown
 * from a blob: URL the page made; no outside host is in any directive (#462).
 */
export const PAGE_CSP = "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function serveStatic(webDir: string, url: URL, res: ServerResponse, opts: { hub?: boolean } = {}): void {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = resolve(webDir, rel);
  if (!file.startsWith(resolve(webDir) + sep) && file !== resolve(webDir)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || !extname(file)) file = join(webDir, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('dashboard UI not built: run `npm run build:web` in the engine');
    return;
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const html = extname(file) === '.html';
  // WHY: vite names every file under assets/ by its content's hash, so a name is never reused for other bytes.
  const hashed = !html && file.startsWith(resolve(webDir, 'assets') + sep);
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': html ? 'no-store' : hashed ? IMMUTABLE : 'max-age=3600' };
  const enc = compressibleType(type) ? requestEncoding(res.req) : null;
  if (compressibleType(type)) headers.vary = 'accept-encoding';
  if (html) {
    headers['content-security-policy'] = PAGE_CSP;
    const page = readFileSync(file, 'utf8');
    const body = Buffer.from(opts.hub ? (page.includes('</head>') ? page.replace('</head>', `${HUB_MARKER}</head>`) : `${HUB_MARKER}${page}`) : page);
    return send(res, 200, headers, body, enc);
  }
  const st = statSync(file);
  if (!enc || st.size < MIN_COMPRESS_BYTES) return send(res, 200, headers, readFileSync(file), null);
  staticCompressed.get(file, `${st.size}:${st.mtimeMs}`, () => readFileSync(file), enc).then(
    (body) => {
      res.writeHead(200, { ...headers, 'content-encoding': enc, 'content-length': String(body.length) });
      res.end(body);
    },
    () => send(res, 200, headers, readFileSync(file), null),
  );
}

/** Content-hashed built files: the same name is always the same bytes, so a browser keeps them a year without asking. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

const staticCompressed = new StaticCompressed();

/**
 * Compress the built UI's assets now, in the background (zlib's pool), so the first person to load it doesn't wait for
 * it: the hub does this when it starts. Anything that fails is compressed on its first request instead.
 */
export function warmStatic(webDir: string): void {
  const dir = join(webDir, 'assets');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const file = join(dir, n);
    if (!compressibleType(MIME[extname(file)] ?? '')) continue;
    try {
      const st = statSync(file);
      if (st.size < MIN_COMPRESS_BYTES) continue;
      for (const enc of ['br', 'gzip'] as const) staticCompressed.get(file, `${st.size}:${st.mtimeMs}`, () => readFileSync(file), enc).catch(() => {});
    } catch {
      // compressed on its first request instead
    }
  }
}

/** Send a body, compressed with `enc` when given and worth it. */
function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer, enc: Encoding | null) {
  if (enc && body.length >= MIN_COMPRESS_BYTES) {
    const out = compress(body, enc);
    res.writeHead(status, { ...headers, 'content-encoding': enc, 'content-length': String(out.length) });
    return void res.end(out);
  }
  res.writeHead(status, { ...headers, 'content-length': String(body.length) });
  res.end(body);
}

/** Whether a request's Host header names this loopback port (not a DNS name that was pointed at 127.0.0.1). */
export function loopbackHostHeader(host: string | undefined, port: number | undefined): boolean {
  return port !== undefined && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes((host ?? '').toLowerCase());
}

/** GET: the key page's help (the key file's path and a copy command), loopback only, never the key. */
export const KEY_HELP_PATH = '/api/key-help';

export function dashboardToken(stateDir: string): string {
  const f = join(stateDir, 'dashboard-token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  mkdirSync(stateDir, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}

function readEvents(dbPath: string, after = 0): StoredEvent[] {
  if (!existsSync(dbPath)) return [];
  const db = openReadOnly(dbPath);
  try {
    const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(after) as { id: number; ts: string; type: string; actor: string; source: string; payload: string }[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }) as StoredEvent);
  } finally {
    db.close();
  }
}

/**
 * A JSON answer, never stored by a browser or a proxy. Compressed only for a view COMPRESSIBLE_API lists (the BREACH
 * check, src/dashboard-compress.ts) and a client that accepts it.
 */
export function json(res: ServerResponse, status: number, body: unknown) {
  const req = res.req as IncomingMessage | undefined;
  const view = mayCompressApi(new URL(req?.url ?? '/', 'http://127.0.0.1').pathname);
  send(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(view ? { vary: 'accept-encoding' } : {}) }, Buffer.from(JSON.stringify(body)), view ? requestEncoding(req) : null);
}

/** The chat attachments' caps in force: the instance's policy settings, else the engine's defaults. */
export function chatAttachmentCaps(o: Pick<DashboardOptions, 'policyFile'>): AttachmentCaps {
  try {
    return attachmentCaps(o.policyFile ? PolicyFile.parse(parseDocument(readFileSync(o.policyFile, 'utf8')).toJS()).settings : {});
  } catch {
    return attachmentCaps({});
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function startDashboard(opts: DashboardOptions): Promise<{ server: Server; url: string; keyFile: string; token: string; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  try {
    assertLoopbackHost(host);
  } catch (e) {
    return Promise.reject(e);
  }
  const token = dashboardToken(opts.stateDir);
  // Siri (src/siri/): a server instance's own gateway token, for the hub's Siri gateway only; never the dashboard token.
  const siriToken = opts.instance ? siriGatewayToken(opts.stateDir, token) : null;
  const siriLimits = new RateLimits();
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const viewsFile = join(opts.stateDir, 'dashboard-views.json');
  /**
   * Each live-stream client, with its role: a viewer is told only of the event types it may see. A signed-in
   * person's role is read again (from the role cache) before each change goes out, so someone removed from the
   * repo stops getting this instance's changes once the cache says so, even on a stream opened before.
   */
  const clients = new Map<ServerResponse, { role: Role; login: string | null }>();
  // The log as this process keeps it: read whole once, then only what was appended (src/events/cache.ts).
  const eventCache = new EventCache(opts.eventsDb);
  let lastId = eventCache.lastId();
  // A held PR's body as GitHub had it, for a decision's fail-without and never sections: asked at most once a minute per PR.
  const prBodies = new Map<number, { at: number; body: Promise<string | null> }>();

  const owners = opts.cfg.project.owners;
  const avatars = new Avatars(join(opts.stateDir, 'avatars'), opts.avatars);
  /** Whether a person is one this instance knows (so their picture may be fetched): its people, the asker, a machine owner. */
  const knowsPerson = (login: string, who: Who) => {
    const l = login.toLowerCase();
    if (l === who.login.toLowerCase() || isMachineOwner(login, opts.machineOwnersFile ?? MACHINE_OWNERS_FILE)) return true;
    const today = localDay();
    const p = eventCache.memo(`project ${today}`, (ev) => project(ev, today));
    return peopleOf({ owners: opts.cfg.project.owners, tasks: p.tasks, decisions: p.decisions }).has(l);
  };
  const repo = opts.cfg.project.project.repo;
  /** The machine's slot holders as this instance may show them: its own, and the rest as held elsewhere. */
  const holder = ownHolders({ project: opts.cfg.project.project.name, actor: opts.actor ?? instanceId() });
  /** The first-run page's live checks, kept between polls: local checks for 10 s, GitHub's for 2 min (its rate limit is shared). */
  const setupCache: DetectCache = new Map();
  let lastFresh = 0;
  const actionDeps = (): ActionDeps => ({ ...systemActionDeps(), ...opts.setupActions });
  /**
   * The config the first-run page acts on: a checkout's as its working tree has it now (a merged config PR comes in by
   * a fast-forward, so the next step sees it without a restart), else the one this dashboard started with (a server
   * instance's, and setup mode's stand-in). A config that doesn't load now keeps the one it started with.
   */
  const liveCfg = (): Config => {
    if (opts.instance || opts.setupMode) return opts.cfg;
    try {
      return loadConfig(opts.root);
    } catch {
      return opts.cfg;
    }
  };
  const actionContext = (cfg: Config = liveCfg()) => ({ mode: opts.instance ? ('server' as const) : ('local' as const), root: opts.root, cfg });
  const checkoutGit = (): GitRun => opts.checkoutGit ?? systemGit(opts.root);
  // INVARIANT: in setup mode the config is a stand-in, so only a fix that doesn't read it may run.
  const planFor = (id: ActionId, cfg: Config = liveCfg()): ActionPlan =>
    opts.setupMode && id !== 'install-tools' ? { id, step: ACTIONS[id].step, label: ACTIONS[id].label, available: false, why: "this checkout has no config yet: finish the repo config first", changes: [], commands: [] } : actionPlan(id, actionContext(cfg), actionDeps());
  const setupRun = (): SetupRun => opts.setupMode?.run ?? ((cmd, args, o) => systemProbe().run(cmd, args, o));
  const draft = newDraftJob();
  /**
   * WHY (#468): the Issues page's "not picked up" list: ONE read of the open issues (Backlog.openIssues), kept two
   * minutes for everyone (GitHub's rate limit is shared with the coordinator), with the reasons from the events.
   */
  let ignoredCache: { at: number; issues: IgnoredIssue[]; error: string | null } | null = null;
  const ignoredNow = async (): Promise<{ at: number; issues: IgnoredIssue[]; error: string | null }> => {
    if (ignoredCache && Date.now() - ignoredCache.at < 120_000) return ignoredCache;
    const b = opts.backlog?.();
    if (!b?.openIssues) return (ignoredCache = { at: Date.now(), issues: [], error: 'this dashboard has no backlog to list issues from' });
    try {
      const open = await b.openIssues();
      ignoredCache = { at: Date.now(), issues: ignoredIssues(open, eventCache.all(), { repo }), error: null };
    } catch (e) {
      ignoredCache = { at: Date.now(), issues: ignoredCache?.issues ?? [], error: `GitHub didn't answer: ${(e as Error).message.split('\n')[0]}` };
    }
    return ignoredCache;
  };
  /** The test files the repo's runner can name (the first-task form's picker): tracked files that look like tests. */
  const testFiles = (): string[] => {
    const r = spawnSync('git', ['ls-files'], { cwd: opts.root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').filter((f) => /(^|\/)(tests?|__tests__|spec)\/.+\.[a-z]+$|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/.test(f)).slice(0, 300);
  };
  const readSkips = (): string[] => {
    try {
      const j = JSON.parse(readFileSync(join(opts.stateDir, SKIPS_FILE), 'utf8')) as { skipped?: unknown };
      return Array.isArray(j.skipped) ? j.skipped.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  // INVARIANT: one Fix action at a time, so two clicks can't install or write the same files at once.
  let actionRunning: string | null = null;
  // The first-run page's Sign in to Claude (local mode): one claude auth login at a time, audited when it ends.
  let signinBy: Who | null = null;
  const signin = new ClaudeSignin({ ...systemSigninDeps(), ...opts.claudeSignin }, (state, detail) => {
    setupCache.delete('claude-login');
    if (signinBy) audit(signinBy, 'first_run.claude_signin_ended', { state, detail: detail.slice(0, 300) });
  });
  /** Connect GitHub's device login (local mode): made on first use, one at a time. */
  let ghLogin: GhLogin | null = null;
  // What tailscale.sh status says (src/tailscale-setup.ts), kept 3 s (it runs tailscale twice); asked afresh before a step is
  // recorded, and whenever the step's progress file has changed since: a step that just ended is shown with the status
  // it left behind, never one read before it, so the next step is offered on the same read that shows it done.
  let tailscaleCache: { at: number; stamp: string; status: TailscaleStatus | null } | null = null;
  const tailscaleNow = async (fresh = false) => {
    const stamp = stepsStamp(opts.tailscaleDir ?? TAILSCALE_DIR);
    if (!fresh && tailscaleCache && tailscaleCache.stamp === stamp && Date.now() - tailscaleCache.at < 3_000) return tailscaleCache.status;
    const status = await (opts.tailscaleStatus ?? tailscaleStatus)();
    tailscaleCache = { at: Date.now(), stamp, status };
    return status;
  };
  // The first-run page's Discord step (src/intake/discord-setup.ts), a server instance's only. The bot's own view
  // (its application and channels) comes from a child process that reads the token itself: this process never does.
  // Kept a minute, and one listing at a time, so the page's polls don't spend Discord's rate limit.
  const instanceHome = opts.instance && opts.policyFile ? dirname(opts.policyFile) : null;
  // INVARIANT: the engine's own cli.js by absolute path, or a stand-in set in code (tests, CI); anything else throws.
  const discordCli = listingRunner(opts.discordListing);
  let bot: { at: number; view: BotView } | null = null;
  let botLoading: Promise<BotView> | null = null;
  const botNow = (fresh: boolean): Promise<BotView> => {
    if (bot && Date.now() - bot.at < (fresh ? 5_000 : 60_000)) return Promise.resolve(bot.view);
    botLoading ??= botView(opts.instance!, discordCli)
      .then((view) => ((bot = { at: Date.now(), view }), view))
      .finally(() => (botLoading = null));
    return botLoading;
  };
  // A pasted bot token (the setup console's paste box): its shape checked, then credentials.yaml pointed at the file.
  const secretRules = instanceHome
    ? {
        [DISCORD_CREDENTIAL]: discordTokenRule({
          instance: opts.instance!,
          credentialsFile: join(instanceHome, 'credentials.yaml'),
          onStored: () => {
            bot = null;
            setupCache.delete('discord');
          },
        }),
      }
    : null;

  /**
   * Who is asking, or why not. The token is required either way. With a person named (the hub signed them in),
   * their role is their permission on this instance's repo, never one the caller sends; without, it is the
   * owner's break-glass, accepted only from this machine's loopback and never through a proxy.
   */
  const identify = async (req: IncomingMessage, url: URL): Promise<Who | { status: number; error: string; login?: string }> => {
    if (!tokenGiven(req, url, token)) return { status: 401, error: 'missing or wrong key; sign in through the hub, or give the key on the page (its file is printed by `dashboard` on this machine)' };
    const named = req.headers[LOGIN_HEADER];
    if (named !== undefined) {
      if (!validLogin(named)) return { status: 400, error: 'not a GitHub login' };
      const fresh = url.pathname === '/api/role' && req.headers[FRESH_HEADER] === '1';
      const role = opts.roleOf ? await opts.roleOf(named, { fresh }) : null;
      if (!role) return { status: 403, login: named, error: `@${named} has no access to this instance: it needs at least read access to ${repo}` };
      return { login: named, role, via: 'session', deviceOk: req.headers[DEVICE_HEADER] === '1' };
    }
    if (!breakGlassAllowed(req)) return { status: 403, error: "the token is the owner's break-glass: accepted only on this machine, never through a proxy" };
    return { login: opts.user || owners.default, role: 'owner', via: 'break-glass', deviceOk: false };
  };

  /** Every write a person makes, recorded with who (login and role), how they came in, the instance and what was done. */
  const audit = (who: Who, action: string, detail: Record<string, unknown>) => {
    const log = new EventLog(opts.eventsDb);
    try {
      auditWrite(log, who, opts.instance ?? null, action, detail);
    } finally {
      log.close();
    }
  };

  const state = (who: Who) => {
    const events = eventCache.all();
    // Folds of the events alone, kept until the log changes (the projection's "today" is part of its key).
    const today = localDay();
    const p = eventCache.memo(`project ${today}`, (ev) => project(ev, today));
    const posted = eventCache.memo('plan.posted', (ev) => ev.filter((e) => e.type === 'plan.posted').map((e) => e.payload as EventPayload<'plan.posted'>));
    const slots = slotStatus(opts.slotsDir);
    const full = {
      brand: { name: BRAND.name, cli: BRAND.cli },
      setupMode: !!opts.setupMode,
      project: { name: opts.cfg.project.project.name, repo: opts.cfg.project.project.repo, landMode: opts.cfg.project.land_mode, ci: ciMode(opts.cfg) },
      user: who.login,
      role: who.role,
      via: who.via,
      owners: opts.cfg.project.owners,
      budget: opts.cfg.agents.daily_budget_usd,
      slots: { cap: slots.cap, running: slots.agents.length, agents: slots.agents.map(holder), fullRun: slots.fullRun ? holder(slots.fullRun) : null },
      ...p,
      // The Activity feed: a viewer's is built from the allowlisted events only, as /api/events gives them.
      activity: isWriter(who.role) ? p.activity : eventCache.memo('viewerActivity', viewerActivity),
      // For an owner, why voice may never approve each one (src/voice.ts), so the page says so before anyone speaks.
      decisions: p.decisions.map((d) => ({ ...d, canAnswer: mayAnswerKind(d.kind, who.role), ...(isOwner(who.role) ? { voiceRefused: voiceExclusion(d, posted) } : {}) })),
      // Whether this viewer may read intake reports, so the page asks for them only when it will get them.
      canReadIntake: mayReadIntake(who.role),
      // Whether this viewer may read the throughput panel, so the page asks for it only when it will get it.
      canReadThroughput: mayReadThroughput(who.role),
      // Whether this viewer may read the report preview, so the page asks for it only when it will get it.
      canReadReports: mayReadReports(who.role),
      // Whether this viewer may read agent runs, so the page asks for them only when it will get them.
      canReadRuns: mayReadRuns(who.role),
      // Whether this viewer may read what waits on the owner, so the page asks only when it will get it.
      canReadDigest: mayReadDigest(who.role),
      // Whether this viewer may write at all (viewers are read-only), and see the audit log (owners only).
      canWrite: isWriter(who.role),
      canReadAudit: isOwner(who.role),
      // Whether this viewer may read the service log and the machine settings (the owners' and writers').
      canReadLogs: isWriter(who.role),
      canReadMachine: isWriter(who.role),
      // Every cost figure is Claude Code's own estimate of a run's cost, not money billed.
      costBasis: 'estimate' as const,
      emergency: stopStatus(emergencyStop(opts.slotsDir), p.emergency),
      inbox: inbox(p, who.login),
      // For the sidebar: open PRs, and how many wait for a person or gave up on CI.
      prCounts: prCounts(eventCache.memo('prsView', prsView).prs),
      // How the default branch is guarded, and an unaccounted commit's alert (a viewer gets the mode only).
      protection: protectionState({ stateDir: opts.stateDir, repo, events, role: who.role }),
      // The pre-deploy gate (tests.yaml deploy_gate): where the deploy branch is, the last held commit and why; and
      // whether it is on, with what turning it on would do while it is off.
      ...(opts.cfg.tests.deploy_gate
        ? {
            deployGate: {
              ...deployGateView(opts.stateDir, events, repo, opts.cfg.tests.deploy_gate.branch),
              enabled: opts.cfg.tests.deploy_gate.enabled,
              tiers: opts.cfg.tests.deploy_gate.tiers,
              postDeploy: !!opts.cfg.tests.deploy_gate.post_deploy,
            },
          }
        : {}),
    };
    // A viewer gets an allowlist of the state (viewer-events.ts): no costs, spend, budget or agent runs.
    return isWriter(who.role) ? full : stateForViewer(full);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Every route, the page itself included: a key in the URL is refused, never accepted.
    if (refuseKeyInUrl(url, res, siriToken ? [token, siriToken] : [token])) return;
    try {
      // Siri's three routes (src/siri/instance.ts), before and instead of the dashboard's own auth: only the Siri
      // gateway token works there, and nothing under /api/siri falls through to any other route.
      if (url.pathname === '/api/siri' || url.pathname.startsWith('/api/siri/')) {
        if (!siriToken) return json(res, 404, { error: 'not found' });
        return void (await handleSiri(req, res, url, { stateDir: opts.stateDir, instance: opts.instance ?? null, ...(opts.intakeFile ? { intakeFile: opts.intakeFile } : {}), eventsDb: opts.eventsDb, gatewayToken: siriToken, limits: siriLimits }));
      }
      // No key asked or given: `dashboard --detach` checks this is its checkout's dashboard by a proof of the key over
      // its nonce and the port it reached (src/dashboard-proof.ts). The key itself is never sent to a port (#448).
      if (url.pathname === PROOF_PATH && req.method === 'GET') {
        const nonce = url.searchParams.get('nonce') ?? '';
        if (!NONCE.test(nonce)) return json(res, 400, { error: 'nonce: 64 hex characters' });
        return json(res, 200, { proof: dashboardProof(token, req.socket.localPort ?? 0, nonce) });
      }
      // The key page's help, before any key: where the key's file is and a command that copies it (#467), never the key.
      // Only to a process on this machine, never through a proxy or the hub, and only under a loopback Host, so a site
      // the browser reached through DNS rebinding can't read it. On Linux, only this OS user's own process (the kernel's
      // socket table); on macOS and Windows any local process can read the path (never the key: the file is 0600).
      if (url.pathname === KEY_HELP_PATH && req.method === 'GET') {
        const local = req.socket.localPort;
        const me = req.socket.remotePort !== undefined && local !== undefined ? loopbackPeerIsMe(req.socket.remotePort, local) : false;
        if (!breakGlassAllowed(req) || !loopbackHostHeader(req.headers.host, local) || me === false) return json(res, 404, { error: 'not here' });
        const file = join(opts.stateDir, 'dashboard-token');
        return json(res, 200, { file, copy: copyFileCommand(file) });
      }
      if (url.pathname.startsWith('/api/')) {
        const id = await identify(req, url);
        // The hub asks this of each instance, to list only the ones the person has a role on.
        if (!('status' in id)) resolved.set(req, { login: id.login, role: id.role, csrfOk: true, breakGlass: id.via === 'break-glass', deviceOk: id.deviceOk });
        const sessionOf = opts.session ?? dashboardSession;
        if (url.pathname === '/api/role' && req.method === 'GET') {
          if ('status' in id) return id.status === 403 && id.login ? json(res, 200, { login: id.login, role: null }) : json(res, id.status, { error: id.error });
          const s = sessionOf(req, opts.instance ?? opts.cfg.project.project.name);
          return json(res, 200, { login: s?.login ?? null, role: s?.role ?? null, via: id.via });
        }
        // The agents' Claude account profiles (src/claude-profiles-routes.ts): a refusal is audited even with no session.
        if (req.method === 'POST' && isProfileRoute(url.pathname) && 'status' in id && id.status === 403) {
          const r = refuseUnidentified(req, { eventsDb: opts.eventsDb, instance: opts.instance ?? opts.cfg.project.project.name }, url.pathname, id);
          return json(res, r.status, r.body);
        }
        if ('status' in id) return json(res, id.status, { error: id.error });
        const who = id;
        const isOwnerHere = isOwner(who.role);
        if (req.method === 'POST' && isProfileRoute(url.pathname)) {
          const r = await handleProfileRoute(req, url, who, { eventsDb: opts.eventsDb, instance: opts.instance ?? opts.cfg.project.project.name, repo, accountDir: opts.claudeAccountDir ?? CLAUDE_ACCOUNT_DIR, ...(opts.machineOwnersFile ? { ownersFile: opts.machineOwnersFile } : {}), ...(opts.secretsHome ? { secretsHome: opts.secretsHome } : {}), audit, readBody });
          return json(res, r.status, r.body);
        }
        // Accept a commit as a bootstrap merge (src/main-watch.ts acceptMerge): an admin's only, like clearing the stop,
        // and every attempt is audited, refusals too (a viewer's as well, so this comes before the viewers' refusal).
        if (url.pathname === '/api/main-watch/accept' && req.method === 'POST') {
          const body = (await readBody(req)) as { sha?: unknown; pr?: unknown; reason?: unknown };
          const target = acceptTarget(body);
          const reason = typeof body.reason === 'string' ? body.reason.slice(0, 600) : '';
          const refuse = (status: number, error: string) => {
            audit(who, 'main_watch.accept_refused', { target, reason, status, error });
            return json(res, status, { error });
          };
          if (!isOwnerHere) return refuse(403, `only the instance's owners (admin on ${repo}) may accept a commit as a bootstrap merge; @${who.login} is a ${who.role}`);
          if (!target) return refuse(400, 'name either a commit sha or a PR number');
          const branch = opts.cfg.project.project.default_branch;
          const r = acceptMerge({ stateFile: join(opts.stateDir, 'main-watch.json'), git: opts.acceptGit ?? acceptGit(opts.root, 'origin', branch), branch, target, reason, by: who.login, judgedPrs: judgedPrs(eventCache.all()) });
          if (!r.ok) return refuse(r.status, r.error);
          const a = r.acceptance;
          audit(who, 'main_watch.accept', { id: a.id, sha: a.sha, pr: a.pr, head: a.head, base: a.base, reason: a.reason });
          return json(res, 200, { ok: true, acceptance: a });
        }
        // Viewers are read-only: every write is refused before any route sees it, whatever route is added later.
        if (req.method !== 'GET' && req.method !== 'HEAD' && !isWriter(who.role)) return json(res, 403, { error: `@${who.login} is a viewer here (read on ${repo}): read-only` });
        if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state(who));
        // A person's picture from this server, never from GitHub in the browser (#462); and, for the hub, whether a
        // login is a person this instance knows, so the hub fetches only theirs.
        const avatar = url.pathname.match(AVATAR_ROUTE);
        if (avatar && req.method === 'GET') return void (await avatars.serve(req, res, avatar[1]!, url.searchParams.get('size'), (l) => knowsPerson(l, who)));
        const person = url.pathname.match(/^\/api\/people\/([^/]+)$/);
        if (person && req.method === 'GET') return json(res, 200, { known: validLogin(person[1]) && knowsPerson(person[1]!, who) });
        // The Board: every task in flight by stage, with the actions this person may take on each (src/board.ts).
        // Everyone with a role reads it; a viewer gets only the allowlisted card fields (no runs, agents or costs).
        // Each action is refused again by the route it calls (decide, the console).
        if (url.pathname === '/api/board' && req.method === 'GET') {
          const slots = slotStatus(opts.slotsDir);
          const board = boardView({ events: eventCache.all(), instance: opts.instance ?? opts.cfg.project.project.name, role: who.role, canReadDigest: mayReadDigest(who.role), live: liveRuns(opts.stateDir), slots: { cap: slots.cap, running: slots.agents.length }, usage: opts.processUsage ?? ((g) => processGroupUsage(g)) });
          return json(res, 200, who.role === 'owner' || who.role === 'writer' ? board : boardForViewer(board));
        }
        // The test runs (src/testrun/): everyone with a role reads them; a viewer gets tier pass or fail only.
        if (url.pathname === '/api/test-runs' && req.method === 'GET') {
          const held = testSlotsHeld(opts.slotsDir);
          // Root's GPU opt-in for this instance, read-only (src/testrun/gpu.ts): only a root shell changes it.
          const name = opts.instance ?? opts.cfg.project.project.name;
          return json(res, 200, testRunsView({ events: eventCache.all(), configured: !!opts.cfg.tests.test_run, writer: isWriter(who.role), cap: testSlotCap(opts.slotsDir), slots: held.map((h) => holder({ slot: h.slot, owner: h.owner, acquiredAt: h.acquiredAt })), lock: { path: opts.testRunLock ?? FULL_RUN_LOCK, holders: flockHolders(opts.testRunLock ?? FULL_RUN_LOCK) }, gpu: gpuOptIn(name, opts.gpuFile ?? gpuFilePath(), opts.gpuFileUid ?? 0), instance: name }));
        }
        // The audit log: every write made on this dashboard, newest first; the owners' to read.
        if (url.pathname === '/api/audit' && req.method === 'GET') {
          if (!isOwnerHere) return json(res, 403, { error: `the audit log is for the instance's owners (admin on ${repo}); @${who.login} is a ${who.role}` });
          return json(res, 200, { entries: eventCache.all().filter((e) => e.type === 'dashboard.audit').reverse().slice(0, 500).map((e) => ({ id: e.id, at: e.ts, ...(e.payload as object) })) });
        }
        // The setup console's asks (src/console/routes.ts): its own body handling, so a pasted secret never reaches readBody or the error below.
        if (await handleAskRoute(req, res, url, { eventsDb: opts.eventsDb, instance: opts.instance ?? opts.cfg.project.project.name, session: sessionOf, ...(opts.secretsHome ? { secretsHome: opts.secretsHome } : {}), ...(opts.machineOwnersFile ? { machineOwnersFile: opts.machineOwnersFile } : {}), ...(secretRules ? { secretRules } : {}) })) return;
        // The next report's preview (with the throughput section, which the posted report leaves out): the owner's and
        // the writers', like the throughput it carries.
        if (url.pathname === '/api/report' && req.method === 'GET') {
          if (!mayReadReports(who.role)) return json(res, 403, { error: writersOnly('the report preview is', who) });
          const events = eventCache.all();
          const last = [...events].reverse().find((e) => e.type === 'report.posted');
          return json(res, 200, { report: buildReport(events, opts.cfg, { since: last ? new Date(last.ts) : new Date(Date.now() - 12 * 3_600_000), throughput: true }).markdown });
        }
        // Settings: agents, budgets, tests, guardrails and deploys are the owners' and writers'; a viewer gets the project part.
        // discordSetup: whether this dashboard has the First run page's Discord step (a server instance's only).
        if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, isWriter(who.role) ? { ...settingsView(opts.cfg, routingInEffect(opts)), discordSetup: !!instanceHome, diskFloor: diskFloorNow(opts, opts.diskFree) } : settingsForViewer(opts.cfg));
        if (url.pathname === '/api/events' && req.method === 'GET') {
          const all = eventCache.after(Number(url.searchParams.get('after') ?? 0)).filter((e) => e.type !== 'coordinator.tick');
          // A viewer sees only the allowlisted event types and fields (viewer-events.ts): never runs, agents or costs.
          const evs = isWriter(who.role) ? all : forViewers(all);
          const issue = url.searchParams.get('issue');
          // One issue's whole history, or the recent tail of everything.
          return json(res, 200, issue ? evs.filter((e) => (e.payload as { issue?: number }).issue === Number(issue)) : evs.slice(-500));
        }
        if (url.pathname === '/api/logs' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the service log is', who) });
          const lines = Math.min(1000, Math.max(1, Number(url.searchParams.get('lines') ?? 200) || 200));
          return json(res, 200, readServiceLog(opts.logs ?? { unit: null, file: null }, lines, opts.journalReader));
        }
        // Agent runs are the owner's and the writers' to read: one gate in front of every path that serves them.
        if (isRunsPath(url.pathname) && !mayReadRuns(who.role)) return json(res, 403, { error: writersOnly('agent runs are', who) });
        // The Board's Watch: the run's live feed so far, for those the runs gate lets through (the owner and the writers).
        const watch = url.pathname.match(/^\/api\/board\/watch\/([A-Za-z0-9_-]+)$/);
        if (watch && req.method === 'GET') {
          try {
            return json(res, 200, feedOrWait(opts, watch[1]!, Number(url.searchParams.get('after') ?? -1)));
          } catch (e) {
            if (e instanceof ConsoleError) return json(res, 404, { error: e.message });
            throw e;
          }
        }
        // Agent runs, as the runner recorded them in this state dir: an issue's list, or one run in full.
        if (url.pathname === '/api/runs' && req.method === 'GET') {
          const issue = Number(url.searchParams.get('issue'));
          if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { error: 'issue must be a number' });
          return json(res, 200, runsForIssue(opts.stateDir, issue));
        }
        // WHY (#468): "Your first task": the form's picks (the repo's test files) and the template; and the form's issue,
        // built and checked with the coordinator's own parser, then (confirmed) filed with `ready`. A checkout's only:
        // on a server an issue filed here would be the App's, which the coordinator doesn't take as a writer's.
        if (url.pathname === '/api/first-run/first-task') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('your first task is', who) });
          const why = "on a server an issue filed from this page would be its GitHub App's, which the coordinator doesn't count as a writer's: file it on GitHub with the template, and add ready";
          if (req.method === 'GET') return json(res, 200, { local: !opts.instance, why: opts.instance ? why : null, template: FIRST_TASK_TEMPLATE, tests: opts.instance ? [] : testFiles(), runner: opts.cfg.tests.runner });
          if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
          const body = ((await readBody(req)) ?? {}) as { values?: unknown; confirm?: unknown };
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.first_task_refused', { why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (opts.instance) return refused(400, `not from here: ${why}`);
          if (!opts.backlog) return refused(400, 'this dashboard has no backlog to file to');
          let issue: { title: string; body: string };
          try {
            issue = firstTaskBody((body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, unknown>);
          } catch (e) {
            if (e instanceof FirstTaskError) return refused(400, e.message);
            throw e;
          }
          if (body.confirm !== true) return json(res, 200, { ok: true, ...issue, label: 'ready', confirmed: false });
          const b = opts.backlog();
          const created = await b.ensureLabels([READY_LABEL]);
          const number = await b.createIssue(issue.title, issue.body, ['ready']);
          setupCache.delete('first-task');
          ignoredCache = null;
          audit(who, 'first_run.first_task_filed', { issue: number, label_created: created.includes('ready') });
          return json(res, 200, { ok: true, number, url: opts.cfg.project.backlog === 'github' ? `https://github.com/${repo}/issues/${number}` : null, labelCreated: created.includes('ready'), confirmed: true });
        }
        // WHY (#468): why each open issue isn't being worked on (anyone may read it; the fix is a writer's, locally).
        if (url.pathname === '/api/issues/ignored' && req.method === 'GET') {
          const v = await ignoredNow();
          return json(res, 200, { ...v, canFix: isWriter(who.role) && !opts.instance, local: !opts.instance });
        }
        const readyFix = url.pathname.match(/^\/api\/issues\/(\d+)\/ready$/);
        if (readyFix && req.method === 'POST') {
          const n = Number(readyFix[1]);
          if (!isWriter(who.role)) return json(res, 403, { error: `only the project's writers may mark an issue ready; @${who.login} is a ${who.role}` });
          // On a server the label would be added by the App, which the coordinator doesn't count as a writer's.
          if (opts.instance) return json(res, 400, { error: "on a server, add ready on GitHub: added from here it would be the App's, which the coordinator doesn't count as a writer's" });
          if (!opts.backlog) return json(res, 400, { error: 'this dashboard has no backlog' });
          const b = opts.backlog();
          await b.ensureLabels([READY_LABEL]);
          await b.addLabels(n, ['ready']);
          ignoredCache = null;
          audit(who, 'issue.ready_added', { issue: n });
          return json(res, 200, { ok: true, issue: n });
        }
        // The chat: ask a question (a request the coordinator answers), poll for the answer, and, for the owner,
        // file a draft it proposed: the stored draft, validated again here, with `ready`, through this instance's backlog.
        // Chat attachments (src/chat-attachments.ts): the owners' and writers' only, to upload, read or remove; a
        // viewer is refused on every one, downloads included. The file streams to the instance's state, never a
        // buffer; it is served with its allowlisted type, nosniff, and as a download unless it is an image.
        const attachPath = url.pathname.match(/^\/api\/chat\/attachments(?:\/(limits|att-[a-f0-9]{32}))?$/);
        if (attachPath) {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('chat attachments are', who) });
          const caps = chatAttachmentCaps(opts);
          const sub = attachPath[1];
          if (sub === 'limits' && req.method === 'GET') return json(res, 200, { maxFileMb: caps.max_file_mb, maxMessageMb: caps.max_message_mb, retentionDays: caps.retention_days, maxFiles: MAX_ATTACHMENTS, extensions: ATTACHMENT_EXTENSIONS });
          if (!sub && req.method === 'POST') {
            let name = '';
            try {
              name = decodeURIComponent(String(req.headers['x-attachment-name'] ?? ''));
            } catch {
              return json(res, 400, { error: 'the file name header is not URI-encoded' });
            }
            const length = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
            try {
              const m = await storeUpload({ stateDir: opts.stateDir, name, body: req, declaredLength: Number.isFinite(length) ? length : null, caps, by: who.login, anyway: req.headers['x-attach-anyway'] === '1', ...(opts.attachmentScan !== undefined ? { gitleaks: opts.attachmentScan } : {}) });
              // Only what the attachment is: never its content, nor (on a secret warning) what matched.
              audit(who, 'chat.attachment_added', { id: m.id, name: redactString(m.name), type: m.kind, size: m.size, sha256: m.sha256 });
              return json(res, 200, { attachment: attachmentView(m), secretKinds: m.secretKinds, scanned: SCANNED_KINDS.includes(m.kind) });
            } catch (e) {
              if (!(e instanceof AttachmentError)) throw e;
              // Refused mid-stream: answer, then drop the connection rather than read the rest of the body.
              if (!req.readableEnded) {
                res.setHeader('connection', 'close');
                res.on('finish', () => req.destroy());
              }
              return json(res, e.status, { error: e.message, ...(e.secretKinds.length ? { secret: { kinds: e.secretKinds } } : {}) });
            }
          }
          const m = sub && sub !== 'limits' ? readAttachment(opts.stateDir, sub) : null;
          if (sub && sub !== 'limits' && !m) return json(res, 404, { error: 'no such attachment (it may have expired)' });
          if (m && req.method === 'GET') {
            // Its uploader, or someone who can see a Project that holds it (src/chat-conversations.ts): anyone else is
            // refused even knowing the id, owners included.
            if (!mayDownload(opts.stateDir, m, who.login, await sharers(opts.stateDir, opts.roleOf))) return json(res, 403, { error: 'only who attached it, or someone who can see a project that holds it, may open an attachment' });
            res.writeHead(200, downloadHeaders(m));
            return void res.end(attachmentBytes(opts.stateDir, m.id));
          }
          if (m && req.method === 'DELETE') {
            // Its uploader, or the creator of a Project holding it: nobody else, owners included (src/chat-conversations.ts).
            if (!mayRemove(opts.stateDir, m, who.login)) return json(res, 403, { error: 'only who attached it, or the creator of a project that holds it, may remove an attachment' });
            removeAttachment(opts.stateDir, m.id);
            audit(who, 'chat.attachment_removed', { id: m.id });
            return json(res, 200, { ok: true });
          }
          return json(res, 405, { error: 'not a method here' });
        }
        if (url.pathname === '/api/chat' && req.method === 'POST') {
          const body = (await readBody(req)) as { question?: string; key?: unknown; attachments?: unknown };
          try {
            const attached = attachmentsFor(opts.stateDir, body.attachments, chatAttachmentCaps(opts), who.login).map((m) => m.id);
            // `key`: the client's request key, so a retried POST is the same question, not a second turn.
            const asked = askChat({ stateDir: opts.stateDir, question: String(body.question ?? ''), by: who.login, ...(body.key !== undefined ? { key: String(body.key) } : {}), ...(attached.length ? { attachments: attached } : {}) });
            audit(who, 'chat.asked', { id: asked.id, ...(attached.length ? { attachments: attached } : {}) });
            return json(res, 200, asked);
          } catch (e) {
            if (e instanceof ChatError) return json(res, 400, { error: e.message });
            if (e instanceof AttachmentError) return json(res, e.status, { error: e.message });
            throw e;
          }
        }
        // The confirm flow that files a chat answer's draft (a single-shot answer's, or a conversation turn's): the
        // owner's only; the stored draft, validated again here, with `ready`, through this instance's backlog; once.
        const fileDraft = async (id: string, answer: ChatAnswer | null): Promise<{ status: number; body: unknown }> => {
          if (!isOwnerHere) return { status: 403, body: { error: `only the instance's owners (admin on ${repo}) may file a draft; @${who.login} is a ${who.role}` } };
          if (!answer?.issueDraft) return { status: 400, body: { error: 'this answer has no issue draft' } };
          if (existsSync(filedPath(opts.stateDir, id))) return { status: 409, body: { error: 'this draft was filed already', ...(JSON.parse(readFileSync(filedPath(opts.stateDir, id), 'utf8')) as object) } };
          // The draft as the answer file has it, never one from the request, checked again as the harness will.
          const d = validateDraft(answer.issueDraft.title, answer.issueDraft.body);
          if (!d.ok) return { status: 400, body: { error: `the draft isn't one the harness can take: ${d.why}` } };
          if (!opts.backlog) return { status: 400, body: { error: 'this dashboard has no backlog to file to' } };
          // Claimed before filing (created only if absent), so two confirms at once file it once; released if filing fails.
          mkdirSync(join(opts.stateDir, 'chat', 'filed'), { recursive: true });
          try {
            writeFileSync(filedPath(opts.stateDir, id), JSON.stringify({ filing: true, at: new Date().toISOString(), by: who.login }), { mode: 0o600, flag: 'wx' });
          } catch {
            return { status: 409, body: { error: 'this draft is being filed already' } };
          }
          let number: number;
          try {
            number = await opts.backlog().createIssue(d.title, d.body, ['ready']);
          } catch (e) {
            rmSync(filedPath(opts.stateDir, id), { force: true });
            throw e;
          }
          writeFileSync(filedPath(opts.stateDir, id), JSON.stringify({ number, at: new Date().toISOString(), by: who.login }), { mode: 0o600 });
          audit(who, 'chat.draft_filed', { id, issue: number });
          return { status: 200, body: { ok: true, number } };
        };
        const filedOf = (id: string) => {
          const rec = existsSync(filedPath(opts.stateDir, id)) ? (JSON.parse(readFileSync(filedPath(opts.stateDir, id), 'utf8')) as { number?: number }) : null;
          return typeof rec?.number === 'number' ? { number: rec.number } : null;
        };
        // Conversations and Projects (src/chat-routes.ts): owners' and writers' only, each conversation its creator's.
        if (await handleConversationRoute(req, res, url, { stateDir: opts.stateDir, who, roleOf: opts.roleOf, caps: chatAttachmentCaps(opts), readBody, json, audit: (action, detail) => audit(who, action, detail), answerFor: chatAnswerFor, filed: filedOf, fileDraft })) return;
        const chat = url.pathname.match(/^\/api\/chat\/([0-9]+-[a-f0-9]+)(\/file-issue)?$/);
        if (chat) {
          const f = chatAnswer(opts.stateDir, chat[1]!);
          if (!f) return json(res, 404, { error: `no chat question ${chat[1]}` });
          if (!chat[2] && req.method === 'GET') return json(res, 200, { ...chatAnswerFor(f, isOwnerHere), owner: isOwnerHere, filed: filedOf(chat[1]!) });
          if (chat[2] && req.method === 'POST') {
            const r = await fileDraft(chat[1]!, f.state === 'answered' ? f.answer : null);
            return json(res, r.status, r.body);
          }
        }
        // A research run's searches and fetches (refusals marked) and where it stopped at a cap; who may read it
        // is the runs gate's to say (the owner and the writers), as for the rest of the run.
        const research = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/research$/);
        if (research && req.method === 'GET') return json(res, 200, researchView(eventCache.all(), research[1]!));
        // The console: the live runs, one run's live feed (SSE while it runs), and the owner's message and stop.
        if (url.pathname === '/api/live' && req.method === 'GET') return json(res, 200, liveView({ ...opts, user: who.login, role: who.role }));
        const con = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/(feed|live|console|message|stop)$/);
        if (con) {
          const [, run, what] = con as unknown as [string, string, string];
          const consoleError = (e: unknown) => {
            if (!(e instanceof ConsoleError)) throw e;
            return json(res, /only the owner/.test(e.message) ? 403 : /isn't live|no feed/.test(e.message) ? 404 : 400, { error: e.message });
          };
          if (what === 'console' && req.method === 'GET') return json(res, 200, consoleView({ ...opts, user: who.login, role: who.role }, run));
          if (what === 'feed' && req.method === 'GET') {
            try {
              return json(res, 200, feedOrWait(opts, run, Number(url.searchParams.get('after') ?? -1)));
            } catch (e) {
              return consoleError(e);
            }
          }
          if (what === 'live' && req.method === 'GET') {
            let after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? -1);
            if (!Number.isInteger(after)) after = -1;
            try {
              feedOrWait(opts, run, after); // the run must have a feed or be live
            } catch (e) {
              return consoleError(e);
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
            res.write('retry: 2000\nevent: hello\ndata: {}\n\n');
            let done = false;
            const tick = () => {
              if (done) return;
              let f: { items: FeedItem[]; ended: boolean };
              try {
                f = feedOrWait(opts, run, after);
              } catch {
                return;
              }
              for (const it of f.items) {
                res.write(`id: ${it.seq}\nevent: item\ndata: ${JSON.stringify(it)}\n\n`);
                after = it.seq;
              }
              if (f.ended) {
                done = true;
                clearInterval(poll);
                clearInterval(keep);
                res.write('event: end\ndata: {}\n\n');
                res.end();
              }
            };
            const poll = setInterval(tick, opts.pollMs ?? 500);
            const keep = setInterval(() => !done && res.write(': ping\n\n'), 25_000);
            req.on('close', () => {
              done = true;
              clearInterval(poll);
              clearInterval(keep);
            });
            tick();
            return;
          }
          if ((what === 'message' || what === 'stop') && req.method === 'POST') {
            const body = (await readBody(req)) as { text?: string };
            try {
              const r = what === 'message' ? sendMessage({ stateDir: opts.stateDir, cfg: opts.cfg, run, text: String(body.text ?? ''), by: who.login, owner: isOwnerHere, writer: isWriter(who.role) }) : stopRun({ stateDir: opts.stateDir, cfg: opts.cfg, run, by: who.login, owner: isOwnerHere });
              audit(who, what === 'message' ? 'console.message' : 'console.stop', { run, request: r.id });
              return json(res, 200, { ok: true, ...r });
            } catch (e) {
              return consoleError(e);
            }
          }
        }
        if (url.pathname.startsWith('/api/runs/') && req.method === 'GET') {
          const run = readRun(opts.stateDir, decodeURIComponent(url.pathname.slice('/api/runs/'.length)));
          return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
        }
        // Pull requests the harness opened, their checks, fix runs and merge calls, and this instance's auto-merge state.
        if (url.pathname === '/api/prs' && req.method === 'GET') {
          return json(res, 200, { ...prsView(eventCache.all()), autoMerge: autoMergeState({ policyFile: opts.policyFile ?? null, repoAuto: opts.cfg.review?.merge.auto ?? null, stateDir: opts.stateDir }) });
        }
        // Machine health: memory, CPU and disk, check times and slowdowns, the runs' usage per day, suggestions.
        // Intake: each report (redacted) and what became of it, and the numbers for the health panel. The owner's
        // and the writers' to read, like the runs.
        if (url.pathname === '/api/intake' && req.method === 'GET') {
          if (!mayReadIntake(who.role)) return json(res, 403, { error: writersOnly('intake reports are', who) });
          const events = eventCache.all();
          return json(res, 200, { reports: intakeReports(events), health: intakeHealth(events) });
        }
        // Throughput: merged PRs, cost per merged PR by stage, where PRs waited for the owner, the top costs with a
        // tuning each. The owner's and the writers' to read, like the runs it is made of.
        if (url.pathname === '/api/throughput' && req.method === 'GET') {
          if (!mayReadThroughput(who.role)) return json(res, 403, { error: writersOnly('throughput is', who) });
          return json(res, 200, throughput(eventCache.all()));
        }
        // Repeated feedback (src/checks-from-feedback.ts): the constraints people's "no"s cluster into, each with its
        // count, its evidence links and its proposal. People's words, so the owner's and the writers', like the runs.
        if (url.pathname === '/api/constraints' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('repeated feedback is', who) });
          const c = opts.cfg.project.checks_from_feedback;
          return json(res, 200, constraintsView(eventCache.all(), { writers: opts.cfg.project.owners.writers, enabled: c.enabled, minSightings: c.min_sightings, maxPerWeek: c.max_proposals_per_week, now: new Date() }));
        }
        // Trust (src/trust.ts): read-only measurement, so GET only; nothing it serves changes slots, caps or merges.
        // A viewer gets only the figures the viewer-events allowlist permits, and never cost.
        if (url.pathname === '/api/trust') {
          if (req.method !== 'GET') return json(res, 405, { error: 'the trust numbers are read-only' });
          const view = trustView(eventCache.all(), { agents: instanceAgents(opts) });
          return json(res, 200, isWriter(who.role) ? view : trustForViewer(view, VIEWER_EVENTS));
        }
        // Metrics (src/merge-metrics.ts deliveryMetrics): merges, main red, time to green, reverts and fix-forward, PR CI
        // wall-clock, agent startup, flake rate and the slow tests. Read-only, the owner's and the writers' (test names
        // and CI timings, like throughput).
        if (url.pathname === '/api/metrics') {
          if (req.method !== 'GET') return json(res, 405, { error: 'the metrics are read-only' });
          if (!mayReadThroughput(who.role)) return json(res, 403, { error: writersOnly('the metrics are', who) });
          return json(res, 200, { ...deliveryMetrics(eventCache.all(), { budgetS: opts.cfg.project.metrics.slow_test_budget_s }), definitions: METRICS_DEFINITIONS });
        }
        // Flaky tests (src/flaky.ts): what is quarantined, why, its issue and sightings, and the flake rate. The owners'
        // and writers' to read; only an owner clears a test from quarantine, audited.
        // Harness evals (src/harness-evals/): each run's success rate, cost, wall-clock and human interventions, and the
        // change from its baseline. What runs cost: the owners' and writers', like the flaky tests and throughput.
        if (url.pathname === '/api/harness-evals' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: `the harness evals are for the instance's owners and writers; @${who.login} is a ${who.role}` });
          return json(res, 200, { ...harnessEvalView(eventCache.all()), enabled: opts.cfg.project.harness_evals.enabled });
        }
        if (url.pathname === '/api/flaky' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: `the flaky tests are for the instance's owners and writers; @${who.login} is a ${who.role}` });
          return json(res, 200, { ...flakyView(eventCache.all(), { now: new Date(), releaseAfter: opts.cfg.project.flaky.release_after_passes }), canClear: isOwnerHere });
        }
        if (url.pathname === '/api/flaky/clear' && req.method === 'POST') {
          const body = (await readBody(req)) as { test?: unknown };
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may clear a test from quarantine; @${who.login} is a ${who.role}` });
          const log = new EventLog(opts.eventsDb);
          try {
            const r = releaseByOwner(log, body.test, who.login);
            if (!r.ok) return json(res, r.status, { error: r.error });
            audit(who, 'flaky.cleared', { test: body.test });
            return json(res, 200, { ok: true });
          } finally {
            log.close();
          }
        }
        // WHY: item 33 (src/learnings.ts). Read like the flaky tests; a promote is the owner's alone, by the same
        // isOwnerHere check as clearing a flaky test, and only records the request: the coordinator files the PR.
        if (url.pathname === '/api/learnings' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the learnings are', who) });
          return json(res, 200, { ...learningsView(eventCache.all()), canPromote: isOwnerHere });
        }
        if (url.pathname === '/api/learnings/promote' && req.method === 'POST') {
          const body = (await readBody(req)) as { fingerprint?: unknown; line?: unknown };
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may promote a learning to AGENTS.md; @${who.login} is a ${who.role}` });
          const log = new EventLog(opts.eventsDb);
          try {
            const refused = promoteRefusal(learningsView(log.read()), body.fingerprint, body.line);
            if (refused) return json(res, refused.status, { error: refused.error });
            log.append('learning.promote_requested', { fingerprint: body.fingerprint as string, line: (body.line as string).trim(), by: who.login }, who.login, 'human');
            audit(who, 'learning.promoted', { fingerprint: body.fingerprint });
            return json(res, 200, { ok: true });
          } finally {
            log.close();
          }
        }
        // A decision's (or held PR's) detail, asked when its page opens (src/decision-detail.ts): a viewer gets only a
        // viewer's fields; …/diff is the owners' (from this checkout's git), …/pr the owners' and writers' (the PR body).
        if (url.pathname.startsWith('/api/decisions/') && req.method === 'GET') {
          const [raw = '', part, ...more] = url.pathname.slice('/api/decisions/'.length).split('/');
          if (more.length || (part !== undefined && part !== 'diff' && part !== 'pr')) return json(res, 404, { error: 'no such view' });
          const detail = decisionDetail(decodeURIComponent(raw), { events: eventCache.all(), role: who.role, prs: eventCache.memo('prsView', prsView).prs, root: opts.root, review: opts.cfg.review, runs: (n) => (part === undefined ? runsForIssue(opts.stateDir, n) : []) });
          if (!detail) return json(res, 404, { error: 'no such decision' });
          if (part === undefined) return json(res, 200, detail);
          if (part === 'diff') {
            if (!isOwnerHere) return json(res, 403, { error: `a change's diff is for the instance's owners (admin on ${repo}); @${who.login} is a ${who.role}` });
            const c = detail.change;
            return json(res, 200, c?.base && c.head ? await decisionDiff(opts.root, c.base, c.head) : { diff: null, why: 'no commits recorded for this change' });
          }
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly("a PR's body is", who) });
          const pr = detail.pr;
          if (!pr) return json(res, 200, { pr: null, failWithout: null, never: null, why: 'no PR' });
          if (!opts.backlog) return json(res, 200, { pr: pr.number, failWithout: null, never: null, why: 'this dashboard has no backlog to read the PR from' });
          const kept = prBodies.get(pr.number);
          const body = kept && Date.now() - kept.at < 60_000 ? kept.body : opts.backlog().pullRequest(pr.number).then((p) => p.body ?? null);
          if (body !== kept?.body) prBodies.set(pr.number, { at: Date.now(), body });
          try {
            return json(res, 200, { pr: pr.number, ...prSections(await body), why: null });
          } catch (e) {
            prBodies.delete(pr.number);
            return json(res, 200, { pr: pr.number, failWithout: null, never: null, why: `couldn't read the PR: ${(e as Error).message}` });
          }
        }
        // Waiting on you: every owner-held state open now, with how long it has waited, and the digest's Markdown
        // (what the daily GitHub comment posts). The owner's and the writers', like runs.
        if (url.pathname === '/api/waiting' && req.method === 'GET') {
          if (!mayReadDigest(who.role)) return json(res, 403, { error: writersOnly('what waits on the owner is', who) });
          const digest = waitingOnYou(eventCache.all());
          return json(res, 200, { ...digest, markdown: digestMarkdown(digest, { project: opts.cfg.project.project.name }) });
        }
        // Usage: the Claude usage-limit pause in force (its reset time, for the banner's countdown) and today's runs and
        // limit hits, for the Overview's usage line. Everyone with a role reads it: no costs, no run detail.
        if (url.pathname === '/api/usage' && req.method === 'GET') {
          const v = usageView(eventCache.all());
          // Logins the API refused (src/claude-auth-failure.ts): the account as Claude names it and Claude's message
          // (redacted), never a token; the owner may ask for a re-check.
          const signin = authHoldsOf(eventCache.all()).map((h) => ({ login: h.login, detail: h.detail, since: h.since, lastCheck: h.lastCheck }));
          return json(res, 200, { instance: opts.instance ?? opts.cfg.project.project.name, ...v, paused: v.paused ? { since: v.paused.since, resetAt: v.paused.resetAt, source: v.paused.source, kind: v.paused.kind } : null, signinFailed: signin, canRecheckSignin: isOwnerHere });
        }
        // The owner's re-check of a refused Claude login: recorded for the coordinator (which runs the one tiny call as
        // the agent user), never run here. One a minute at most, however often it is asked.
        if (url.pathname === '/api/claude-auth/recheck' && req.method === 'POST') {
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may re-check the Claude sign-in; @${who.login} is a ${who.role}` });
          requestAuthRecheck(opts.stateDir, who.login);
          audit(who, 'claude_auth.recheck', {});
          return json(res, 202, { ok: true, note: 'the coordinator checks the login on its next tick, with one minimal real call' });
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
          let stats: MachineStats | null = null;
          try {
            stats = (opts.machineStats ?? (() => healthStats({ serviceUnit: opts.logs?.unit ?? null, root: opts.root, stateDir: opts.stateDir })))();
          } catch {
            // no stats: the view says unknown
          }
          const view = healthView(eventCache.all(), stats, { cores: cpuCount(), diskLabels: { [opts.root]: 'the checkout', [opts.stateDir]: 'the state dir' } });
          // Costs are the owners' and writers': a viewer's usage per day has no estimated cost.
          const usage = isWriter(who.role) ? view.usage : { ...view.usage, days: view.usage.days.map(({ estimatedUsd: _cost, ...d }) => d) };
          // WHY: the proxy's internal host is the machine's network layout: writers only, as costs are.
          return json(res, 200, { ...view, usage, network: isWriter(who.role) ? view.network : null, docs: { backups: docsUrl('backups') } });
        }
        // The watchdog's incidents about this instance and the machine (src/watchdog/), and this instance's status
        // dot. Everyone with a role reads it; a viewer gets the allowlisted fields only (no detail, tried or fix).
        if (url.pathname === '/api/health/incidents' && req.method === 'GET') return json(res, 200, incidentsView({ ...(opts.slotsDir ? { dir: opts.slotsDir } : {}), instance: opts.instance ?? null, full: isWriter(who.role) }));
        // The instance's own settings (policy.yaml): what's in effect, the bounds, and, for the owner, a change.
        if (url.pathname === '/api/instance-settings' && req.method === 'GET') return json(res, 200, instanceSettingsView({ ...opts, user: who.login, role: who.role }));
        if (url.pathname === '/api/instance-settings' && req.method === 'POST') {
          if (!opts.policyFile) return json(res, 400, { error: 'settings are an instance\'s: this dashboard serves a checkout' });
          const body = (await readBody(req)) as { key?: string; value?: unknown };
          try {
            const r = changeSetting({ policyPath: opts.policyFile, cfg: opts.cfg, eventsDb: opts.eventsDb, key: String(body.key ?? ''), value: body.value, by: who.login, owner: isOwnerHere, ...(opts.limitsPath ? { limitsPath: opts.limitsPath } : {}) });
            audit(who, 'settings.changed', { key: String(body.key ?? ''), from: r.from, to: r.to });
            return json(res, 200, { ok: true, ...r });
          } catch (e) {
            if (e instanceof SettingsError) return json(res, /only the owner/.test(e.message) ? 403 : 400, { error: e.message });
            throw e;
          }
        }
        // The first-run page: every setup step checked live (src/setup-steps.ts, the same checks doctor runs), what init
        // recorded, what this mode can't do, and what Start would change. Re-check (?fresh=1) checks everything again,
        // at most every 3 s.
        if (url.pathname === '/api/first-run' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the first-run checklist is', who) });
          const fresh = url.searchParams.get('fresh') === '1' && Date.now() - lastFresh > 3_000;
          if (fresh) lastFresh = Date.now();
          const live = { ...(opts.setupProbe ? { probe: opts.setupProbe } : {}), stateDir: opts.stateDir, policyFile: opts.policyFile ?? null, cache: setupCache, fresh, localMs: 10_000, netMs: 120_000, context: { ...opts.setupContext, skipped: readSkips() } };
          // A server instance's record is the machine's (src/init.ts serverInitFile), readable by its coordinator group.
          const view = await firstRunLiveView(opts.instance ? serverInitFile(opts.instance) : join(opts.stateDir, INIT_FILE), { root: opts.root, repo: opts.setupMode ? (gitRemoteRepo(opts.root) ?? '') : opts.cfg.project.project.repo, instance: opts.instance ?? null, live });
          // Each open action's plan, shown before its button does anything (all local reads: no network).
          const actions: Record<string, ActionPlan> = {};
          // WHY: a done step's fix can be run again (from Settings' Setup list), so every action's plan is here.
          const cfgNow = liveCfg();
          for (const s of view.setup?.groups.flatMap((g) => g.steps) ?? []) if (s.fix.kind === 'action' && isActionId(s.fix.action)) actions[s.fix.action] = planFor(s.fix.action, cfgNow);
          const policy = opts.policyFile ? policyForm(opts.policyFile, opts.limitsPath) : null;
          // A checkout's config as the default branch has it (what a change is proposed against); a server's is add-project's.
          let repoConfig: ReturnType<typeof repoConfigForm> | { error: string } | null = null;
          if (!opts.instance) {
            try {
              repoConfig = repoConfigForm(loadConfigAt(opts.root, `origin/${opts.cfg.project.project.default_branch}`));
            } catch (e) {
              repoConfig = { error: (e as Error).message.split('\n').slice(0, 2).join(' ') };
            }
          }
          const setup = opts.setupMode ? { setupMode: true, configReady: configReady(opts.root), draft } : { setupMode: false };
          return json(res, 200, { ...view, start: firstRunStart(opts), canStart: isOwnerHere, actions, canAct: isOwnerHere, policy, repoConfig: opts.setupMode ? null : repoConfig, diskFloor: opts.setupMode ? null : diskFloorNow(opts, opts.diskFree), ...setup });
        }
        // Setup mode (src/setup-mode.ts): the origin, auto-config's answers and draft, the setup PR's merge. Owners only;
        // without confirm, what it would do; every run and refusal audited.
        if (url.pathname.startsWith('/api/first-run/setup/')) {
          const what = url.pathname.slice('/api/first-run/setup/'.length);
          const file = join(opts.stateDir, INIT_FILE);
          if (!opts.setupMode) return json(res, 404, { error: 'not in setup mode: this checkout has its config' });
          if (req.method === 'GET' && what === 'repos') return isWriter(who.role) ? json(res, 200, pushableRepos(setupRun())) : json(res, 403, { error: writersOnly('the first-run checklist is', who) });
          if (req.method === 'GET' && what === 'draft') return json(res, 200, draft);
          if (req.method !== 'POST' || !['origin', 'answers', 'draft', 'merge'].includes(what)) return json(res, 404, { error: `no setup route ${what}` });
          const body = ((await readBody(req)) ?? {}) as { repo?: unknown; answers?: unknown; confirm?: unknown };
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.setup_refused', { what, why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!isOwnerHere) return refused(403, `only the owners may set this checkout up; @${who.login} is a ${who.role}`);
          try {
            if (what === 'origin') {
              const plan = originPlan(opts.root, body.repo);
              if (body.confirm !== true) return json(res, 200, { ok: true, commands: plan.commands.map((c) => c.join(' ')), confirmed: false });
              setOrigin(opts.root, plan.repo, setupRun());
              audit(who, 'first_run.setup_origin', { repo: plan.repo });
              return json(res, 200, { ok: true, repo: plan.repo, confirmed: true });
            }
            if (what === 'answers') {
              const r = saveAnswers(file, opts.root, body.answers && typeof body.answers === 'object' ? (body.answers as Record<string, unknown>) : {});
              audit(who, 'first_run.setup_answers', { saved: r.saved });
              return json(res, 200, { ok: true, ...r });
            }
            if (what === 'draft') {
              if (body.confirm !== true) return refused(400, 'Draft runs your project\'s commands on a scratch copy of the default branch: confirm it ({"confirm": true})');
              void startDraft({ root: opts.root, file, job: draft, ...(opts.setupMode.io ? { io: opts.setupMode.io } : {}) });
              audit(who, 'first_run.setup_draft', {});
              return json(res, 202, { ok: true, draft });
            }
            const m = setupPrMerge(file, opts.root, setupRun());
            if (body.confirm !== true) return json(res, 200, { ok: true, number: m.number, url: m.url, command: m.command.join(' '), confirmed: false });
            const r = setupRun()(m.command[0]!, m.command.slice(1), { cwd: opts.root });
            if (r.status !== 0) return refused(502, `GitHub didn't merge PR #${m.number}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`);
            audit(who, 'first_run.setup_merge', { number: m.number, method: m.command.at(-1) });
            // The merged config comes into this checkout as `init` brings it: a fetch and a fast-forward.
            if (!draft.running) void startDraft({ root: opts.root, file, job: draft, ...(opts.setupMode.io ? { io: opts.setupMode.io } : {}) });
            return json(res, 200, { ok: true, number: m.number, confirmed: true });
          } catch (e) {
            if (e instanceof SetupModeError) return refused(e.status, e.message);
            throw e;
          }
        }
        // The checks GitHub ran on the default branch's tip: what the Repo config form offers as required checks.
        if (url.pathname === '/api/first-run/checks-seen' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the first-run checklist is', who) });
          const branch = opts.cfg.project.project.default_branch;
          const sha = spawnSync('git', ['rev-parse', `origin/${branch}`], { cwd: opts.root, encoding: 'utf8' }).stdout.trim();
          if (!/^[0-9a-f]{40}$/.test(sha)) return json(res, 200, { checks: [], error: `origin/${branch} isn't fetched here` });
          const gh = actionDeps().gh;
          const runs = gh(['api', `repos/${repo}/commits/${sha}/check-runs`, '--jq', '.check_runs[].name']);
          const statuses = gh(['api', `repos/${repo}/commits/${sha}/status`, '--jq', '.statuses[].context']);
          if (runs.status !== 0 && statuses.status !== 0) return json(res, 200, { checks: [], error: `GitHub didn't answer: ${runs.stderr.trim().split('\n')[0] ?? ''}` });
          const checks = [...new Set([runs, statuses].flatMap((r) => (r.status === 0 ? r.stdout.split('\n') : [])).map((s) => s.trim()).filter(Boolean))].sort();
          return json(res, 200, { checks, sha });
        }
        // The starter CI (src/starter-ci.ts, #469): a drafted workflow and GitHub's new-file page for it, and its first
        // run on the default branch. Read only: the person commits the workflow on GitHub, never the engine.
        if (url.pathname === '/api/first-run/starter-ci' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the first-run checklist is', who) });
          const gh = actionDeps().gh;
          return json(res, 200, starterCiView({ root: opts.root, repo, branch: opts.cfg.project.project.default_branch, configured: liveCfg().tests.runner.full, testRun: !!liveCfg().tests.test_run, gh: (args) => gh(args) }));
        }
        // The Repo config form (src/config-change.ts): without confirm, what the values would change on the default
        // branch (nothing written); with it, that change proposed as a PR of its own. Owners only; audited.
        if (url.pathname === '/api/first-run/repo-config' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { values?: unknown; confirm?: unknown };
          const values = body.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {};
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.config_refused', { why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (opts.instance) return refused(400, "a server instance's config changes through its repo's PRs, not this form");
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may propose a config change; @${who.login} is a ${who.role}`);
          try {
            if (body.confirm !== true) return json(res, 200, { ok: true, changes: planConfigChange({ root: opts.root, cfg: liveCfg(), values }), confirmed: false });
            const gh = actionDeps().gh;
            const r = proposeConfigChange({ root: opts.root, cfg: liveCfg(), values, by: who.login, io: { gh: (args) => gh(args) } });
            audit(who, 'first_run.config_proposed', { changes: r.changes, branch: r.branch, url: r.url });
            return json(res, 200, { ok: true, ...r, confirmed: true });
          } catch (e) {
            if (e instanceof ConfigChangeError) return refused(400, e.message);
            return refused(500, (e as Error).message.split('\n')[0] ?? 'failed');
          }
        }
        // Merge a PR the Repo config form proposed, then bring this checkout up to the merged default branch (a
        // fast-forward only, src/checkout-sync.ts), so the next step reads the new config. Owners only; without confirm,
        // what it would run; audited.
        if (url.pathname === '/api/first-run/repo-config/merge' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { number?: unknown; confirm?: unknown };
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.config_merge_refused', { why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (opts.instance || opts.setupMode) return refused(400, opts.instance ? "a server instance's config changes through its repo's PRs, not this form" : 'in setup mode the setup PR merges from the setup card');
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may merge a config PR; @${who.login} is a ${who.role}`);
          const cfgNow = liveCfg();
          const branch = cfgNow.project.project.default_branch;
          const gh = actionDeps().gh;
          try {
            const m = configPrMerge({ repo: cfgNow.project.project.repo, base: branch, number: body.number, gh: (args) => gh(args) });
            const then = `then this checkout's ${branch} is fast-forwarded to origin's (only a fast-forward: refused if it has local changes or diverged)`;
            if (body.confirm !== true) return json(res, 200, { ok: true, number: m.number, url: m.url, command: m.command.join(' '), then, confirmed: false });
            const r = gh(m.command.slice(1));
            if (r.status !== 0) return refused(502, `GitHub didn't merge PR #${m.number}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`);
            const ff = fastForwardCheckout(branch, checkoutGit());
            setupCache.clear();
            audit(who, 'first_run.config_merged', { number: m.number, method: m.command.at(-1), synced: ff.ok, detail: ff.detail.slice(0, 300) });
            return json(res, 200, { ok: true, number: m.number, merged: true, synced: ff.ok, detail: ff.detail, confirmed: true });
          } catch (e) {
            if (e instanceof ConfigChangeError) return refused(400, e.message);
            throw e;
          }
        }
        // The Policy form (src/policy-edit.ts): without confirm, the change these values would make (nothing written);
        // with it, that change written. The owners only; refusals and writes audited.
        if (url.pathname === '/api/first-run/policy' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { values?: unknown; confirm?: unknown };
          const values = body.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {};
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.policy_refused', { why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!opts.policyFile) return refused(400, "the policy is a server instance's: this dashboard serves a checkout");
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may change its policy; @${who.login} is a ${who.role}`);
          const o = { path: opts.policyFile, cfg: opts.cfg, values, ...(opts.limitsPath ? { limitsPath: opts.limitsPath } : {}) };
          try {
            if (body.confirm !== true) return json(res, 200, { ok: true, changes: planPolicy(o).changes, confirmed: false });
            const changes = applyPolicy({ ...o, eventsDb: opts.eventsDb, by: who.login });
            setupCache.delete('policy');
            audit(who, 'first_run.policy', { changes });
            return json(res, 200, { ok: true, changes, confirmed: true });
          } catch (e) {
            if (e instanceof PolicyEditError) return refused(400, e.message);
            throw e;
          }
        }
        // Skip a step on the first-run page, or undo that: the owners only, audited. The checks themselves don't change.
        if (url.pathname === '/api/first-run/skip' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { step?: unknown; skip?: unknown };
          const step = String(body.step ?? '');
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may skip a setup step; @${who.login} is a ${who.role}` });
          if (!SETUP_STEPS.some((s) => s.id === step)) return json(res, 404, { error: `no setup step ${step.slice(0, 40)}` });
          const skips = new Set(readSkips());
          if (body.skip === false) skips.delete(step);
          else skips.add(step);
          mkdirSync(opts.stateDir, { recursive: true });
          writeFileSync(join(opts.stateDir, SKIPS_FILE), JSON.stringify({ skipped: [...skips].sort() }) + '\n', { mode: 0o600 });
          audit(who, 'first_run.skip', { step, skip: body.skip !== false });
          return json(res, 200, { ok: true, skipped: [...skips].sort() });
        }
        // A Fix action (src/setup-actions.ts): the owners only, after they confirmed the plan the page showed; every run
        // and refusal audited. Its step is checked again on the next poll.
        const actionMatch = /^\/api\/first-run\/actions\/([a-z-]+)$/.exec(url.pathname);
        if (actionMatch && req.method === 'POST') {
          const id = actionMatch[1]!;
          const body = ((await readBody(req)) ?? {}) as { confirm?: unknown };
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.action_refused', { action: id.slice(0, 40), why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!isActionId(id)) return refused(404, `no first-run action ${id}`);
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may run a first-run fix; @${who.login} is a ${who.role}`);
          const cfgNow = liveCfg();
          const plan = planFor(id, cfgNow);
          if (!plan.available) return refused(409, `not run: ${plan.why ?? 'not available here'}`);
          if (body.confirm !== true) return refused(400, `${plan.label} changes this machine: review what it shows, then confirm it ({"confirm": true})`);
          if (actionRunning) return refused(409, `${actionRunning} is running: one fix at a time`);
          actionRunning = id;
          try {
            const r = await ACTIONS[id].run(actionContext(cfgNow), actionDeps()).catch((e: Error): { ok: boolean; detail: string } => ({ ok: false, detail: e.message.split('\n')[0] ?? 'failed' }));
            setupCache.delete(plan.step);
            audit(who, 'first_run.action', { action: id, ok: r.ok, detail: r.detail.slice(0, 300) });
            return json(res, r.ok ? 200 : 500, r.ok ? { ok: true, detail: r.detail } : { error: r.detail });
          } finally {
            actionRunning = null;
          }
        }
        // Sign in to Claude (src/claude-signin.ts). Local: the relayed `claude auth login`, its link for the owners only.
        // Server: the agents' token goes into add-project's paste box (the existing paste_secret ask) or credentials.sh.
        if (url.pathname === '/api/first-run/claude-signin' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the first-run checklist is', who) });
          if (opts.instance) {
            const asks = asksFrom(eventCache.all().filter((e) => (ASK_EVENTS as readonly string[]).includes(e.type)));
            return json(res, 200, { mode: 'server', canAct: isOwnerHere, ...claudeServerView({ instance: opts.instance, asks, role: who.role, engineRoot: engineRoot(), ...(opts.claudeAccountDir ? { accountDir: opts.claudeAccountDir } : {}) }) });
          }
          return json(res, 200, { mode: 'local', canAct: isOwnerHere, ...signin.view(isOwnerHere) });
        }
        if ((url.pathname === '/api/first-run/claude-signin' || url.pathname === '/api/first-run/claude-signin/cancel') && req.method === 'POST') {
          const cancel = url.pathname.endsWith('/cancel');
          const body = ((await readBody(req)) ?? {}) as { confirm?: unknown };
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.claude_signin_refused', { why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may sign this machine in to Claude; @${who.login} is a ${who.role}`);
          // INVARIANT: a server's agents never sign in through the dashboard's own claude: their login is a pasted setup token.
          if (opts.instance) return refused(409, "a server instance's agents sign in with a token from claude setup-token, pasted into Add project's paste box or credentials.sh's hidden prompt; the dashboard never runs claude auth login there");
          if (cancel) {
            if (!signin.cancel(`cancelled by @${who.login}`)) return refused(409, 'no Claude sign-in is running');
            audit(who, 'first_run.claude_signin_cancelled', {});
            return json(res, 200, { ok: true });
          }
          if (body.confirm !== true) return refused(400, "Sign in runs claude auth login as this machine's user: review what it shows, then confirm it ({\"confirm\": true})");
          if (signin.running) return refused(409, 'a Claude sign-in is running already: one at a time');
          signinBy = who;
          signin.start();
          audit(who, 'first_run.claude_signin', { state: signin.view(false).state });
          return json(res, 200, { ok: true, ...signin.view(true) });
        }
        // Connect GitHub (local mode, src/gh-login.ts): `gh auth login --web` run for the person, its one-time code shown,
        // done once `gh auth status` says so. The instance's owners only; starting and cancelling are audited. The token
        // stays in gh's own store: nothing here reads it. A server instance works as its GitHub App, never a gh login.
        if (url.pathname === '/api/first-run/gh-login') {
          const refused = (status: number, error: string) => {
            if (req.method !== 'GET') audit(who, 'first_run.gh_login_refused', { why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may connect GitHub here; @${who.login} is a ${who.role}`);
          if (opts.instance) return refused(409, "a server instance works as its GitHub App, not a gh login: the agents' App is Add project's step");
          ghLogin ??= new GhLogin(opts.ghLogin);
          try {
            if (req.method === 'GET') {
              const v = ghLogin.poll();
              if (v.state === 'done') setupCache.delete('gh-login');
              return json(res, 200, v);
            }
            if (req.method === 'POST') {
              const v = ghLogin.start();
              audit(who, 'first_run.gh_login', { state: v.state === 'done' ? 'signed-in-already' : 'started' });
              return json(res, 200, v);
            }
            if (req.method === 'DELETE') {
              const v = ghLogin.cancel();
              audit(who, 'first_run.gh_login', { state: 'cancelled' });
              return json(res, 200, v);
            }
            return json(res, 405, { error: 'GET, POST or DELETE' });
          } catch (e) {
            if (e instanceof GhLoginError) return refused(e.status, e.message);
            throw e;
          }
        }
        // The Discord step (src/intake/discord-setup.ts). Reading it, loading the bot's channels and reviewing a change
        // write nothing; the owners only act, each write confirmed, and every write and refusal is audited.
        if (url.pathname === '/api/first-run/discord' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the first-run checklist is', who) });
          if (!instanceHome) return json(res, 200, { available: false, why: "Discord intake is a server instance's: this dashboard serves a checkout, and local mode has no Discord wiring" });
          const all = asksFrom(eventCache.all().filter((e) => (ASK_EVENTS as readonly string[]).includes(e.type)));
          return json(res, 200, discordSetupView({ instance: opts.instance!, home: instanceHome, asks: all, role: who.role, engineRoot: engineRoot() }));
        }
        if (url.pathname.startsWith('/api/first-run/discord/')) {
          const what = url.pathname.slice('/api/first-run/discord/'.length);
          const refused = (status: number, error: string) => {
            audit(who, 'first_run.discord_refused', { what: what.slice(0, 20), why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!instanceHome) return json(res, 400, { error: "Discord intake is a server instance's: this dashboard serves a checkout" });
          const ownersOnly = `only the instance's owners (admin on ${repo}) may set up its Discord bot; @${who.login} is a ${who.role}`;
          // The bot's application, invite link and channels, as the bot sees them. Nothing is written.
          if (what === 'channels' && req.method === 'GET') {
            if (!isOwnerHere) return json(res, 403, { error: ownersOnly });
            const t = tokenState(join(instanceHome, 'credentials.yaml'));
            if (!t.configured || !t.present) return json(res, 409, { error: t.error ?? 'no bot token is stored for this instance yet: paste it first' });
            try {
              return json(res, 200, await botNow(url.searchParams.get('fresh') === '1'));
            } catch (e) {
              if (e instanceof DiscordSetupError) return json(res, e.status, { error: e.message });
              throw e;
            }
          }
          // Open the paste box for the token: a paste_secret ask, answered through the setup console's secret route.
          if (what === 'token-ask' && req.method === 'POST') {
            const body = ((await readBody(req)) ?? {}) as { confirm?: unknown };
            if (!isOwnerHere) return refused(403, ownersOnly);
            if (body.confirm !== true) return refused(400, 'opening the paste box records an ask in this instance\'s log: confirm it ({"confirm": true})');
            const log = new EventLog(opts.eventsDb);
            try {
              const r = tokenAsk(log, opts.instance!, who.login);
              if (r.created) audit(who, 'first_run.discord_token_ask', { ask: r.ask.id });
              return json(res, 200, { ok: true, ask: { ...r.ask, canAnswer: true }, created: r.created });
            } finally {
              log.close();
            }
          }
          // intake.yaml: without confirm, the exact change these picks make (nothing written); with it, and the hash of
          // the change that was shown, that change written.
          if (what === 'intake' && req.method === 'POST') {
            const body = ((await readBody(req)) ?? {}) as { values?: unknown; confirm?: unknown; expect?: unknown };
            if (!isOwnerHere) return refused(403, ownersOnly);
            const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : {};
            try {
              const o = { path: join(instanceHome, INTAKE_FILE), values, channels: (await botNow(false)).channels };
              if (body.confirm !== true) {
                const { text: _text, ...plan } = planIntake(o);
                return json(res, 200, { ok: true, confirmed: false, ...plan });
              }
              if (typeof body.expect !== 'string') return refused(400, 'a confirm names the change it confirms (expect: the hash the review returned)');
              const { text: _text, ...plan } = applyIntake({ ...o, expect: body.expect });
              setupCache.delete('discord');
              audit(who, 'first_run.discord_intake', { file: plan.file, creates: plan.creates, changes: plan.changes });
              return json(res, 200, { ok: true, confirmed: true, ...plan });
            } catch (e) {
              if (e instanceof DiscordSetupError) return refused(e.status, e.message);
              throw e;
            }
          }
          return json(res, 404, { error: 'not found' });
        }
        // Start: the coordinator's service, as `up` starts it. The instance's owners only, after they confirmed the change
        // the page showed; recorded in the audit either way. A server instance's is an owner's root command, never run here.
        if (url.pathname === '/api/first-run/start' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { confirm?: unknown };
          const plan = firstRunStart(opts);
          const refused = (status: number, error: string, extra: Record<string, unknown> = {}) => {
            audit(who, 'first_run.start_refused', { why: error.slice(0, 300) });
            return json(res, status, { error, ...extra });
          };
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may start the coordinator; @${who.login} is a ${who.role}`);
          if (plan.kind === 'owner-command') return refused(409, `not started from here: ${plan.why}`, { command: plan.command });
          if (plan.kind === 'unsupported') return refused(409, plan.why);
          if (body.confirm !== true) return refused(400, 'Start changes this machine: review the change it shows, then confirm it ({"confirm": true})');
          const started = (opts.startService ?? installService)(localServiceSpec(opts.root, opts.cfg));
          // WHY (#468): said at install, when the only node is one an upgrade deletes.
          const nodeWhy = stableNodePath().why;
          const r = nodeWhy ? { ...started, detail: `${started.detail}; warning: ${nodeWhy}` } : started;
          setupCache.delete('service');
          audit(who, 'first_run.start', { label: plan.label, file: r.path, started: r.started, detail: r.detail.slice(0, 300) });
          return json(res, r.started ? 200 : 500, r.started ? { ok: true, ...r } : { error: `not started: ${r.detail}`, ...r });
        }
        // The setup console's Add project (src/console/add-project.ts): owners and writers see the runs, and whether
        // they may start one now. The one way to start one is POST /api/machine/add-project, below, which checks it all again.
        if (url.pathname === `/api/${DEVICE_VIEWS.addProject}` && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('adding a project is', who) });
          const requester = { login: who.login, breakGlass: who.via === 'break-glass', deviceOk: who.deviceOk };
          return json(res, 200, addProjectView(eventCache.all().filter((e) => (ADD_PROJECT_EVENTS as readonly string[]).includes(e.type)), { role: who.role, requester }, { ...(opts.machineOwnersFile ? { ownersFile: opts.machineOwnersFile } : {}), ...(opts.machine?.helperRulesPath ? { helperRulesFile: opts.machine.helperRulesPath } : {}) }));
        }
        // Add project's repo picker (src/setup/repo-picker.ts): an account's repos the agents' App can be installed on,
        // the signed-in person's own account by default. Read-only: it starts nothing, and the start checks it all again.
        if (url.pathname === `/api/${DEVICE_VIEWS.addProject}/repos` && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('adding a project is', who) });
          const login = who.via === 'break-glass' ? null : who.login;
          return json(res, 200, await listInstallableRepos({ owner: url.searchParams.get('owner') || login || '', login }));
        }
        // Machine-wide settings (the slot cap, engine updates) and their history, for owners and writers. Only the
        // instance's owner who is also a machine owner, on an allowed device (or the break-glass),
        // may ask for a change (src/machine-owners.ts); it's recorded for the coordinator, which runs the machine helper
        // (src/machine-requests.ts): this server's unit forbids sudo, and it never tries.
        const machine = () => machineView({ ...opts, user: who.login, role: who.role, breakGlass: who.via === 'break-glass', deviceOk: who.deviceOk, requests: machineRequests(eventCache.all().filter((e) => (MACHINE_EVENTS as readonly string[]).includes(e.type))) });
        // The Machine page's Updates panel: the engine installed now, the last install, any rollback or hold and why,
        // and the canary's last result (docs/canary.md). For owners and writers, like the machine settings.
        if (url.pathname === '/api/updates' && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('engine updates are', who) });
          return json(res, 200, updatesPanel(updateLog(opts.machine?.updatesLogPath ?? UPDATES_LOG), updateSettings(opts.machine?.updatesConfigPath ?? UPDATES_CONFIG), installedEngine(opts.machine?.enginePath ?? ENGINE_CURRENT), drainView(opts.slotsDir), lastCheck(opts.machine?.updatesStatePath ?? UPDATES_STATE)));
        }
        if (url.pathname === `/api/${DEVICE_VIEWS.machine}` && req.method === 'GET') {
          if (!isWriter(who.role)) return json(res, 403, { error: writersOnly('the machine settings are', who) });
          return json(res, 200, machine());
        }
        if (url.pathname === '/api/machine' && req.method === 'POST') {
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may change machine settings; @${who.login} is a ${who.role}` });
          const body = (await readBody(req)) as { what?: string; value?: unknown };
          const args = settingArgs(body.what, body.value);
          if ('error' in args) return json(res, 400, { error: args.error });
          const log = new EventLog(opts.eventsDb);
          let r: MachineRequest;
          try {
            r = requestMachineChange(log, { args, requester: { login: who.login, breakGlass: who.via === 'break-glass', deviceOk: who.deviceOk }, via: 'settings', ...(opts.machineOwnersFile ? { ownersFile: opts.machineOwnersFile } : {}) });
          } catch (e) {
            if (e instanceof MachineRequestError) return json(res, e.status, { error: e.message });
            throw e;
          } finally {
            log.close();
          }
          audit(who, 'machine.changed', { what: body.what, value: body.value, request: r.id });
          return json(res, 200, { ok: true, pending: true, request: r, machine: machine() });
        }
        // The updater's setup (src/updater-setup.ts): install it, put it on the release channel, stage a release signer
        // for an admin to confirm at a root shell (or discard a staged one). Two calls each: /review answers with
        // exactly what would run and change and records nothing; the change itself needs confirm: true. Then the same
        // gate and path as any machine change. No step here adds a signer: the helper it reaches can't.
        if ((url.pathname === '/api/machine/updater' || url.pathname === '/api/machine/updater/review') && req.method === 'POST') {
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may set the updater up; @${who.login} is a ${who.role}` });
          const body = (await readBody(req)) as { step?: unknown; principal?: unknown; key?: unknown; confirm?: unknown };
          const plan = updaterPlan(body, machine().updater);
          if ('error' in plan) return json(res, plan.status ?? 400, { error: plan.error });
          if (url.pathname.endsWith('/review')) return json(res, 200, { ok: true, plan });
          if (body.confirm !== true) return json(res, 400, { error: 'this changes the machine: review what it shows (POST /api/machine/updater/review), then confirm it ({"confirm": true})' });
          const log = new EventLog(opts.eventsDb);
          let r: MachineRequest;
          try {
            r = requestMachineChange(log, { args: plan.args, requester: { login: who.login, breakGlass: who.via === 'break-glass', deviceOk: who.deviceOk }, via: 'settings', ...(opts.machineOwnersFile ? { ownersFile: opts.machineOwnersFile } : {}) });
          } catch (e) {
            if (e instanceof MachineRequestError) return json(res, e.status, { error: e.message });
            throw e;
          } finally {
            log.close();
          }
          // A public key and its principal are not secrets: the audit says exactly what was staged, and by whom.
          audit(who, 'machine.updater', { step: plan.step, args: plan.args, ...(plan.signer ? { fingerprint: plan.signer.fingerprint } : {}), request: r.id });
          return json(res, 200, { ok: true, pending: true, request: r, machine: machine() });
        }
        // Add a project to this machine: the machine helper's add-project, run by the coordinator (it streams each step
        // into this log as add_project.step). The same gate as any machine change: this instance's owner, and a machine
        // owner on an allowed device (or the break-glass).
        if (url.pathname === '/api/machine/add-project' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { name?: unknown; repo?: unknown };
          // A refusal is audited too: what was asked for (cut short), and why.
          const refused = (status: number, error: string) => {
            audit(who, 'machine.add_project_refused', { name: String(body.name ?? '').slice(0, 40), repo: String(body.repo ?? '').slice(0, 200), why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) may add a project; @${who.login} is a ${who.role}`);
          // This machine's sudo rule leaves add-project out: no request (it could only fail at sudo); the root command instead.
          const manual = addProjectManual(opts.machine?.helperRulesPath ? { helperRulesFile: opts.machine.helperRulesPath } : {});
          if (manual) return refused(409, `${manual.why}: ${addProjectCommand(typeof body.name === 'string' ? body.name.trim() : '', typeof body.repo === 'string' ? body.repo.trim() : '')}`);
          const log = new EventLog(opts.eventsDb);
          let r: MachineRequest;
          try {
            r = requestAddProject(log, { name: body.name, repo: body.repo, requester: { login: who.login, breakGlass: who.via === 'break-glass', deviceOk: who.deviceOk }, ...(opts.machineOwnersFile ? { ownersFile: opts.machineOwnersFile } : {}) });
          } catch (e) {
            if (e instanceof MachineRequestError) return refused(e.status, e.message);
            throw e;
          } finally {
            log.close();
          }
          audit(who, 'machine.add_project', { name: r.args[1], repo: r.args[2], request: r.id });
          return json(res, 200, { ok: true, pending: true, request: r });
        }
        // The agents' Claude account (src/claude-account.ts): the machine owners' panel. Each agent user's account and
        // expiry, and the switch, followed from claude-account.sh's own progress file. Hidden from everyone else.
        const accountRequester = { login: who.login, breakGlass: who.via === 'break-glass', deviceOk: who.deviceOk };
        const accountDir = opts.claudeAccountDir ?? CLAUDE_ACCOUNT_DIR;
        const ownersOpt = opts.machineOwnersFile ? { ownersFile: opts.machineOwnersFile } : {};
        if (url.pathname === `/api/${DEVICE_VIEWS.claudeAccount}` && req.method === 'GET') {
          if (!mayViewClaudeAccount(accountRequester, opts.machineOwnersFile)) return json(res, 403, { error: `the agents' Claude account is for the machine's owners; @${who.login} isn't one` });
          const events = eventCache.all().filter((e) => (MACHINE_EVENTS as readonly string[]).includes(e.type));
          return json(res, 200, { ...claudeAccountView({ dir: accountDir, events, who: { role: who.role, requester: accountRequester }, instance: opts.instance ?? opts.cfg.project.project.name, ...ownersOpt }), ...profilesView(accountDir, Date.now(), opts.instance ?? opts.cfg.project.project.name) });
        }
        // Refresh the status, or start a switch: a machine request the coordinator runs through the machine helper.
        if (url.pathname === '/api/machine/claude-account' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { action?: unknown };
          const action = String(body.action ?? '').slice(0, 20);
          if (!isOwnerHere) {
            audit(who, 'machine.claude_account_refused', { action, why: 'not an owner here' });
            return json(res, 403, { error: `only the instance's owners (admin on ${repo}) who are machine owners may switch the Claude account; @${who.login} is a ${who.role}` });
          }
          const log = new EventLog(opts.eventsDb);
          let r: MachineRequest;
          try {
            r = requestClaudeAccount(log, { action: body.action, requester: accountRequester, dir: accountDir, ...ownersOpt });
          } catch (e) {
            if (e instanceof MachineRequestError) {
              auditWrite(log, who, opts.instance ?? null, 'machine.claude_account_refused', { action, why: e.message.slice(0, 300) });
              return json(res, e.status, { error: e.message });
            }
            throw e;
          } finally {
            log.close();
          }
          audit(who, 'machine.claude_account', { action, request: r.id });
          return json(res, 200, { ok: true, pending: true, request: r });
        }
        // Tailscale and HTTPS for the hub (src/tailscale-setup.ts): the machine owners' screen, on a server instance only.
        // What tailscale says now, the four steps, the last one's progress, and, while `up` waits, its login link: for
        // a machine owner (or the break-glass) and nobody else, and never in an event or the audit.
        if (url.pathname === `/api/${DEVICE_VIEWS.tailscale}` && req.method === 'GET') {
          res.setHeader('cache-control', 'no-store');
          // A local checkout has no hub, and anyone but a machine owner has no screen: both are told only that (the
          // Machine page asks on every visit, so this is an answer, not an error).
          if (!opts.instance || !mayViewTailscale(accountRequester, opts.machineOwnersFile)) return json(res, 200, noTailscaleView(who.login, opts.instance ?? null));
          const events = eventCache.all().filter((e) => (MACHINE_EVENTS as readonly string[]).includes(e.type));
          return json(res, 200, tailscaleView({ status: await tailscaleNow(url.searchParams.get('fresh') === '1'), dir: opts.tailscaleDir ?? TAILSCALE_DIR, events, who: { role: who.role, requester: accountRequester }, instance: opts.instance, ...ownersOpt }));
        }
        // Run one step: a machine request (`tailscale <step>`, two fixed words) that the coordinator runs through the
        // machine helper, after the owner confirmed what the screen showed. Every request and refusal is audited.
        if (url.pathname === '/api/machine/tailscale' && req.method === 'POST') {
          const body = ((await readBody(req)) ?? {}) as { action?: unknown; confirm?: unknown };
          // The audit names the step only when it is one of the four: anything else a caller sent is never written down.
          const action = isTailscaleAction(body.action) ? body.action : 'not a step';
          const refused = (status: number, error: string) => {
            audit(who, 'machine.tailscale_refused', { action, why: error.slice(0, 300) });
            return json(res, status, { error });
          };
          if (!opts.instance) return refused(404, 'Tailscale for the hub is set up on a server instance; this is a local checkout');
          if (!isOwnerHere) return refused(403, `only the instance's owners (admin on ${repo}) who are machine owners may set up Tailscale; @${who.login} is a ${who.role}`);
          if (body.confirm !== true) return refused(400, 'a Tailscale step changes this machine: review what it shows, then confirm it ({"confirm": true})');
          const log = new EventLog(opts.eventsDb);
          let r: MachineRequest;
          try {
            r = requestTailscale(log, { action: body.action, status: await tailscaleNow(true), requester: accountRequester, dir: opts.tailscaleDir ?? TAILSCALE_DIR, ...ownersOpt });
          } catch (e) {
            if (e instanceof MachineRequestError) return refused(e.status, e.message);
            throw e;
          } finally {
            log.close();
          }
          tailscaleCache = null;
          audit(who, 'machine.tailscale', { action, request: r.id });
          return json(res, 200, { ok: true, pending: true, request: r });
        }
        // The new account's token, for the running switch: its own body handling, so the value never reaches readBody,
        // an error, an event or the audit (which records only that it was stored).
        if (url.pathname === '/api/claude-account/token' && req.method === 'POST') {
          if (!isOwnerHere) {
            req.resume();
            return json(res, 403, { error: `only the instance's owners who are machine owners may paste the token; @${who.login} is a ${who.role}` });
          }
          try {
            const value = await readSecretBody(req);
            storeSwitchToken({ value, instance: opts.instance ?? opts.cfg.project.project.name, who: { role: who.role, requester: accountRequester }, dir: accountDir, ...(opts.secretsHome ? { home: opts.secretsHome } : {}), ...ownersOpt });
          } catch (e) {
            if (e instanceof ClaudeTokenError || e instanceof AskError) return json(res, e.status, { error: e.message });
            return json(res, 500, { error: "the token couldn't be stored" });
          }
          audit(who, 'claude_account.token', { stored: true });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/checks' && req.method === 'GET') {
          const issue = Number(url.searchParams.get('issue'));
          if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { error: 'issue must be a number' });
          return json(res, 200, checkResults(eventCache.all(), issue));
        }
        // A goal's task graph (src/goal-graph.ts), read-only, for everyone with a role, like the goal's own page. Built
        // from the events this person may see (a viewer's are the allowlisted ones), so it shows no goal or task a
        // viewer couldn't see before; run links only for those the runs gate lets through.
        if (url.pathname === '/api/goal-graph' && req.method === 'GET') {
          const issue = Number(url.searchParams.get('issue'));
          if (!Number.isInteger(issue) || issue <= 0) return json(res, 400, { error: 'issue must be a number' });
          const all = eventCache.all();
          const runs = mayReadRuns(who.role);
          const live = runs ? liveRuns(opts.stateDir) : [];
          const runOf = (n: number) => live.find((r) => r.issue === n)?.run ?? runsForIssue(opts.stateDir, n).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id ?? null;
          return json(res, 200, goalGraph({ events: isWriter(who.role) ? all : forViewers(all), goal: issue, ...(runs ? { runOf } : {}) }));
        }
        if (url.pathname === '/api/stream' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? lastId);
          res.write(`retry: 3000\nid: ${Math.max(since, lastId)}\nevent: hello\ndata: {}\n\n`);
          clients.set(res, { role: who.role, login: who.via === 'session' ? who.login : null });
          req.on('close', () => clients.delete(res));
          return;
        }
        // Clear the auto-merge stop (a red main after an auto-merge, or the main watch's unaccounted commit): an admin's
        // only, audited, and the one way auto-merge resumes from the dashboard.
        if (url.pathname === '/api/auto-merge/clear' && req.method === 'POST') {
          if (!isOwnerHere) return json(res, 403, { error: `only the instance's owners (admin on ${repo}) may resume auto-merge; @${who.login} is a ${who.role}` });
          const r = clearAutoMergeStop({ stateDir: opts.stateDir, eventsDb: opts.eventsDb, by: who.login });
          if (!r.ok) return json(res, 409, { error: r.error });
          audit(who, 'auto_merge.cleared', { reason: r.reason });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/decide' && req.method === 'POST') {
          const body = (await readBody(req)) as { id?: string; answer?: string; voice?: unknown };
          // Said by voice (src/voice.ts): the claim only adds checks, here (an owner, a focused and visible tab) and in
          // the decide path (approve only, never what voice may not approve). Every voice refusal is audited too.
          const claim = voiceClaim(body);
          const id = String(body.id ?? '');
          const refusedByVoice = (status: number, error: string) => (audit(who, 'voice.refused', { action: 'decision.answered', id, why: error, by: BY_VOICE }), json(res, status, { error }));
          if (claim.voice) {
            const no = voiceRefusal(who, claim, repo);
            if (no) return refusedByVoice(403, no);
          }
          const log = new EventLog(opts.eventsDb);
          let r: ReturnType<typeof answerDecision>;
          try {
            // The one decide path (src/decide.ts): a chat-thread answer goes through it too.
            r = answerDecision(log, { id, answer: String(body.answer ?? ''), who, instance: opts.instance ?? null, repo, ...(claim.voice ? { voice: true } : {}) });
          } finally {
            log.close();
          }
          if (!r.ok) return claim.voice ? refusedByVoice(r.status, r.error) : json(res, r.status, { error: r.error });
          return json(res, 200, { ok: true, event: r.event });
        }
        // A spoken idea the owner confirmed (src/intake/voice.ts): left for the coordinator's intake, which takes it
        // through the same triage and approval as a Discord message. Voice only, owners only, focused and visible.
        if (url.pathname === '/api/voice/intake' && req.method === 'POST') {
          const body = (await readBody(req)) as { text?: unknown; voice?: unknown };
          const claim = voiceClaim(body);
          if (!claim.voice) return json(res, 400, { error: 'this route takes only spoken ideas; file anything else on GitHub or through the Ask panel' });
          const no = voiceRefusal(who, claim, repo) ?? voiceIntakeRefusal(opts.intakeFile);
          if (no) {
            audit(who, 'voice.refused', { action: 'intake.voice', why: no, by: BY_VOICE });
            return json(res, 403, { error: no });
          }
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return json(res, 400, { error: 'nothing was said' });
          if (text.length > VOICE_MAX_CHARS) return json(res, 400, { error: `the idea is over ${VOICE_MAX_CHARS} characters` });
          const { id: voiceId } = submitVoiceIntake({ stateDir: opts.stateDir, text, by: who.login });
          // INVARIANT: the audit names the idea by its id and length only; its words stay in the instance's state.
          audit(who, 'intake.voice', { id: voiceId, chars: text.length, by: BY_VOICE });
          return json(res, 200, { ok: true, id: voiceId });
        }
        // Settings, Siri devices (src/siri/manage.ts): the list, a new token (shown once), revoke and unbind.
        if (url.pathname === '/api/siri-devices' || url.pathname.startsWith('/api/siri-devices/')) {
          const body = req.method === 'POST' ? ((await readBody(req)) as Record<string, unknown>) : {};
          const a = siriDevicesRoute(who, req.method ?? 'GET', url.pathname, body && typeof body === 'object' ? body : {}, { stateDir: opts.stateDir, instance: opts.instance ?? null, ...(opts.intakeFile ? { intakeFile: opts.intakeFile } : {}), audit: (action, detail) => audit(who, action, detail) });
          if (a) return json(res, a.status, a.body);
        }
        if (url.pathname === '/api/views') {
          if (req.method === 'GET') return json(res, 200, existsSync(viewsFile) ? JSON.parse(readFileSync(viewsFile, 'utf8')) : []);
          if (req.method === 'PUT') {
            const views = await readBody(req);
            if (!Array.isArray(views) || views.length > 50) return json(res, 400, { error: 'views must be an array (max 50)' });
            writeFileSync(viewsFile, JSON.stringify(views, null, 2));
            audit(who, 'views.saved', { count: views.length });
            return json(res, 200, { ok: true });
          }
        }
        return json(res, 404, { error: 'not found' });
      }
      serveStatic(webDir, url, res);
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  // The coordinator writes the log from another process: poll it and fan new events out.
  const poll = setInterval(() => {
    if (!clients.size) return;
    const fresh = eventCache.after(lastId);
    if (!fresh.length) return;
    lastId = fresh.at(-1)!.id;
    const visible = fresh.filter((e) => e.type !== 'coordinator.tick');
    const change = (types: string[]) => `id: ${lastId}\nevent: change\ndata: ${JSON.stringify({ lastId, types: [...new Set(types)] })}\n\n`;
    const all = change(visible.map((e) => e.type));
    const forViewer = visible.filter((e) => viewerMaySee(e.type));
    const viewer = forViewer.length ? change(forViewer.map((e) => e.type)) : null;
    const send = (c: ServerResponse, role: Role) => {
      if (isWriter(role)) c.write(all);
      else if (viewer) c.write(viewer);
    };
    for (const [c, k] of clients) {
      if (!k.login) {
        send(c, k.role);
        continue;
      }
      // A person: their role now, or the stream ends (no role: nothing more of this instance reaches them).
      void (opts.roleOf ? opts.roleOf(k.login) : Promise.resolve(null)).then(
        (role) => {
          if (!clients.has(c)) return;
          if (!role) {
            clients.delete(c);
            return void c.end();
          }
          clients.set(c, { ...k, role });
          send(c, role);
        },
        () => {
          clients.delete(c);
          c.end();
        },
      );
    }
  }, opts.pollMs ?? 1000);
  const ping = setInterval(() => {
    for (const c of clients.keys()) c.write(': ping\n\n');
  }, 25_000);

  return new Promise((resolveStart) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveStart({
        server,
        // INVARIANT: no key in the URL; the page asks for it (keyFile names where it is).
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
        keyFile: join(opts.stateDir, 'dashboard-token'),
        token,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(poll);
            clearInterval(ping);
            signin.cancel('the dashboard stopped');
            for (const c of clients.keys()) c.end();
            server.close(() => r());
            // WHY: a browser's kept-alive socket can carry one more request (its live stream reconnecting) after
            // close() stopped listening, and close() then never finishes: setup mode's hand-over hung on it.
            server.closeAllConnections();
          }),
      });
    });
  });
}

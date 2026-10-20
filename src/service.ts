// The coordinator as a service: one per project per machine (a pid lock), never tied to a Claude session.
// It recovers on start, ticks, and backs up the log hourly with verified read-back.
import { PINS_FILE } from './experiments/store.js';
import { AUTOMATIONS_FILE, AutomationsPolicy } from './automations/schema.js';
import { githubGet } from './automations/github.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { checkRepoScope } from './github-scope.js';
import { appBotIdentity, installationTokens } from './github-app.js';
import { fileURLToPath } from 'node:url';
import { appKeyAge, appKeyWarning, tokenWarning } from './reports.js';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from './brand.js';
import { machineNetworkConfig, outboundEnv } from './network.js';
import { providerHostsAtStart } from './provider-hosts.js';
import { GITHUB_API } from './github-hosts.js';
import { accountSwitchedAt, retiredAccountGate, retiredAccountWarning, retiredLogin } from './claude-accounts-retired.js';
import { FAILOVER_INCIDENT } from './usage-limit.js';
import { FileBacklog } from './backlog/file.js';
import { GitHubBacklog } from './backlog/github.js';
import type { Backlog } from './backlog/types.js';
import { loadConfig, type Config } from './config/load.js';
import { Coordinator } from './coordinator.js';
import { backup, dirStore } from './events/backup.js';
import { maybeOffsiteBackup, OFFSITE_FILE } from './offsite-backup.js';
import { tidyState } from './state-tidy.js';
import { EventLog, storageFailure } from './events/log.js';
import { siteDiskGuard, startDiskGuard } from './disk-guard.js';
import { addStartGate } from './testrun/gate.js';
import { drainRefusal } from './update-drain.js';
import { watchdogConfig } from './watchdog/config.js';
import { projectStateDir } from './guardrails/context.js';
import { tryLock } from './locks.js';
import { slotStatus } from './slots.js';
import { guardrailSettings } from './agent-settings.js';
import { CliRunner, type AgentRunner, type CommitIdentity } from './runner.js';
import { CliAgentRunner, withCliAgents } from './cli-agents.js';
import type { CliAgentName } from './providers.js';
import { latestBaseline } from './baseline.js';
import { instanceConfigProblems, instanceProblems, instancesDir, laneRuns, researchLanes, loadInstance, readPolicy, type Instance, type InstanceSettings, type PolicyFile } from './instance.js';
import { startConfig } from './config/live.js';
import { instanceTargets, migrationGate, projectConfigFiles } from './migrations.js';
import { settingsReader } from './settings.js';
import { batchTestRuns, setupTestRuns, type TestRunSetup } from './testrun/setup.js';
import { setupDeployGate } from './deploy-gate/wire.js';
import { setupPreviews } from './preview/wire.js';
import { intakeForInstance, type IntakeWiring } from './intake/wire.js';
import { prodRead } from './prodread.js';
import { coordinatorHooksDir, writeCoordinatorHooks } from './push-guard.js';
import { stableNodePath, type ProjectRunAs, type ServiceSpec } from './os/index.js';
import { ownEnv, type EnvSource } from './os/own-env.js';
import { toolPath } from './tool-path.js';
import { cachedRoles, repoPermission, type RoleOf } from './dashboard-auth.js';
import type { CoordinatorDeps } from './coordinator/shared.js';
import { GitHubMainWatchApi } from './github/main-watch-api.js';
import { GitHubMergePostsApi } from './github/merge-posts-api.js';
import { GitHubCiMetricsApi } from './github/ci-metrics-api.js';
import { directLandStartGate, localRemote, type Protection } from './direct-land.js';
import { incidentSink, watchdogForInstance } from './watchdog/wire.js';
import type { IncidentSink } from './usage-limit.js';
import type { IntakeConfig } from './intake/report.js';
import { pluginsForRun } from './plugins/run.js';
import { readLockScope } from './managed-apps.js';
import { endRun, registerRun } from './mcp/client.js';

/** The coordinator's umask when agents run as their own user: group read/write (agents share the group), nothing for others. */
export const INSTANCE_UMASK = 0o007;

export const instanceId = () => `${userInfo().username}@${hostname().split('.')[0]}`;
export const logPath = (root: string) => join(projectStateDir(root), 'events.db');
export const serviceLabel = (cfg: Config) => `dev.${BRAND.cli}.${cfg.project.project.name.replace(/[^A-Za-z0-9-]/g, '-')}`;

/** A local coordinator unit's own variables, on top of what its service manager gives it; the Claude step uses it too (#738). */
export const localServiceEnv = (env: EnvSource = process.env): { PATH: string; HOME: string } => {
  // WHY (#786): own variables only: a HOME or PATH on Object.prototype is never the unit's, nor the Claude step's.
  const own = ownEnv(env);
  return { PATH: toolPath(own.get('PATH') ?? '', own), HOME: own.get('HOME') ?? '' };
};

/**
 * The coordinator's service for a checkout (local mode), as `up` installs it and the first-run page's Start does:
 * one spec, so the two can't start it differently.
 */
export function localServiceSpec(root: string, cfg: Config, env: NodeJS.ProcessEnv = process.env, node: string = stableNodePath().path): ServiceSpec {
  return {
    label: serviceLabel(cfg),
    // WHY (#468): Homebrew's stable $(brew --prefix)/bin/node when this node is Homebrew's, never its realpath in the
    // Cellar, which `brew upgrade` deletes from under the service; never a `node` found on PATH.
    program: [node, fileURLToPath(new URL('./cli.js', import.meta.url)), 'coordinator', 'run', '--root', root],
    workingDir: root,
    logFile: join(projectStateDir(root), 'coordinator.log'),
    // PATH reaches the prefix's bin, where local init installs tools (src/tool-path.ts), as `up` has always set it.
    env: localServiceEnv(env),
  };
}

/** An instance's coordinator unit on a server (scripts/setup installs it as root). */
export const instanceUnit = (name: string) => `${BRAND.cli}-${name}.service`;

export function backlogFor(cfg: Config, root: string, state = projectStateDir(root), token?: () => Promise<string>): Backlog {
  return cfg.project.backlog === 'github' ? new GitHubBacklog(cfg.project.project.repo, token) : new FileBacklog(join(state, 'backlog.json'));
}

const githubApi = () => GITHUB_API;

/** Where an instance's GitHub tokens come from: its App (minted, short-lived) or, as a fallback, its own gh login. */
export function instanceTokens(i: Instance, env: NodeJS.ProcessEnv): () => Promise<string> {
  const g = i.credentials.github;
  if (g.kind === 'app') return installationTokens({ appId: g.app_id, installationId: g.installation_id, keyPath: g.key_path }, [i.repo.repo], i.stateDir, fetch, githubApi());
  return async () => execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
}

/** Where a coordinator keeps its state: per repo (no instance), or in an instance's home. */
export interface Site {
  cfg: Config;
  root: string;
  stateDir: string;
  logPath: string;
  /** An instance's policy.yaml, read on each approval for writers_approve_land (#715); a local site has none. */
  policyFile?: string;
}

export const siteForRoot = (root: string): Site => ({ cfg: loadConfig(root), root, stateDir: projectStateDir(root), logPath: logPath(root) });
export const siteForInstance = (i: Instance): Site => ({ cfg: i.config, root: i.repo.path, stateDir: i.stateDir, logPath: join(i.stateDir, 'events.db'), policyFile: join(i.home, 'policy.yaml') });
export const instanceServiceLabel = (name: string) => `dev.${BRAND.cli}.instance.${name}`;

/**
 * The coordinator's environment for an instance: its own logins and nothing
 * inherited that could stand in for them. gh prefers GH_TOKEN/GITHUB_TOKEN
 * over its config dir, so those are dropped rather than silently used.
 */
export function instanceEnv(i: Instance, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];
  // The coordinator's git runs in checkouts agents can write to: none of the repo's hooks and no fsmonitor command,
  // whatever its config says. Its hooks are its own (writeCoordinatorHooks, in its instance home, this user's only):
  // the pre-push hook that refuses the default branch, and nothing else. Not written yet: no hooks at all.
  const git: [string, string][] = [
    ['core.hooksPath', coordinatorHooksDir(i.home)],
    ['core.fsmonitor', 'false'],
  ];
  if (i.credentials.github.kind === 'gh-config-dir') {
    env.GH_CONFIG_DIR = i.credentials.github.path;
  } else {
    // App mode: gh has no login to fall back on, and git gets each token from the App through a credential helper.
    env.GH_CONFIG_DIR = join(i.stateDir, 'no-gh-login');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    git.push(['credential.helper', ''], ['credential.helper', `!"${process.execPath}" "${cli}" git-credential`]);
  }
  env.GIT_CONFIG_COUNT = String(git.length);
  git.forEach(([k, v], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
  });
  if (i.credentials.claude) env.CLAUDE_CONFIG_DIR = i.credentials.claude.config_dir;
  env[`${BRAND.envPrefix}_INSTANCE`] = i.name;
  // INVARIANT: no inherited variable decides where the coordinator's children (gh, git, claude) send credentials;
  // only root's network.json sets a proxy (src/network.ts). This env becomes the coordinator's process.env.
  return outboundEnv(env);
}

/** Write the instance coordinator's own git hooks dir from the config in effect (push-guard.ts). */
export function writeInstanceHooks(i: Pick<Instance, 'home' | 'config'>): string {
  const engine = fileURLToPath(new URL('./cli.js', import.meta.url));
  return writeCoordinatorHooks(i.home, { defaultBranch: i.config.project.project.default_branch, directLand: i.config.project.land_mode === 'direct', node: process.execPath, engine });
}

/**
 * How an instance's agents are billed: an API key only when its credentials.yaml names one (agent_api_key, which
 * only the owner sets, with credentials.sh); otherwise the agent user's Claude subscription login. The repo's own
 * agent_runtime doesn't decide this for an instance. The key never enters an environment (instanceEnv strips it).
 */
export function instanceRuntime(i: { credentials: { agent_api_key?: string | undefined } }): { runtime: 'cli' | 'api_key'; apiKeyFile?: string } {
  return i.credentials.agent_api_key ? { runtime: 'api_key', apiKeyFile: i.credentials.agent_api_key } : { runtime: 'cli' };
}

/** Run an instance's coordinator. Refuses to start without the instance's own credentials. */
export async function runInstanceCoordinator(name: string, opts: { once?: boolean; intervalMs?: number } = {}): Promise<number> {
  // Before the config is loaded: a file an older engine wrote, or a newer one, says what to do rather than failing to parse.
  const gate = migrationGate(instanceTargets(join(instancesDir(), name)));
  if (gate) {
    console.error(`instance ${name} not started: ${gate}`);
    return 1;
  }
  // Account profiles, failover and the switch were removed (#736): a failover notice an older engine left would never
  // close, and an instance whose runs were on another profile starts no run on any login (the engine never moves one).
  incidentSink(name).resolveIncident(FAILOVER_INCIDENT, name);
  const retired = retiredAccountGate(name);
  if (retired) {
    console.error(`instance ${name} not started: ${retired}`);
    return 1;
  }
  const leftover = retiredAccountWarning();
  if (leftover) console.error(leftover);
  let i = loadInstance(name);
  const missing = instanceProblems(i);
  if (missing.length) {
    console.error(`instance ${name} not started:\n${missing.map((m) => `  ${m}`).join('\n')}`);
    return 1;
  }
  // Agents' guardrails: checked here so a missing install stops the instance at start, and again for every run.
  try {
    guardrailSettings(i.home, i.name, i.repo.path);
  } catch (e) {
    console.error(`instance ${name} not started: ${(e as Error).message}`);
    return 1;
  }
  // The coordinator's own git hooks (core.hooksPath in instanceEnv): the pre-push hook that refuses the default branch.
  writeInstanceHooks(i);
  const env = instanceEnv(i);
  // WHY: a refused network.json means children go direct; say so at start, as the Health page does.
  const net = machineNetworkConfig();
  if (net.error) console.error(net.error);
  if (net.proxy) console.error(`outbound proxy: ${net.proxy.host} (from ${net.proxy.file})`);
  if (net.ca) console.error(`custom CA: ${net.ca.path}, ${net.ca.count} certificate(s)`);
  // The GitHub credential must reach this instance's repo and nothing else.
  const tokens = instanceTokens(i, env);
  let token = '';
  let failure = '';
  try {
    token = await tokens();
  } catch (e) {
    failure = (e as Error).message.split('\n')[0]!;
  }
  const scope = token ? await checkRepoScope(token, [i.repo.repo], fetch, githubApi()) : { ok: false as const, why: `no GitHub token for the instance (${failure || 'empty'})` };
  if (!scope.ok) {
    console.error(`instance ${name} not started: ${scope.why}`);
    return 1;
  }
  // Agents run as another user in the same group: worktrees and slot files must be group-writable both ways.
  // Nothing the coordinator makes is for anyone outside its group: no access for others.
  if (i.runAs) process.umask(INSTANCE_UMASK);
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  // The default branch's config (instance credentials), not the stale checkout copy (src/config/live.ts); hooks too.
  const home = i.home;
  const policyNow = (fallback: PolicyFile) => readPolicy(join(home, 'policy.yaml')).policy ?? fallback;
  const check = (c: Config) => instanceConfigProblems(c, i.repo.repo, policyNow(i.policy));
  const start = startConfig({ repo: i.repo.path, remote: 'origin', fallback: i.config, check });
  if (start.note) console.error(start.note);
  i = { ...i, config: start.cfg };
  // WHY (#392): root's provider hosts, or that there are none (provider runs off), and each configured provider they refuse.
  for (const line of providerHostsAtStart(i.config.agents)) console.error(line);
  writeInstanceHooks(i);
  const liveConfig = { tree: start.tree, check };
  const gh = i.credentials.github;
  const warn = gh.kind === 'app' ? appKeyWarning(appKeyAge(gh.key_path)) : tokenWarning(scope.expiresAt);
  if (warn) console.error(warn.replaceAll('**', ''));
  // App tokens renew themselves every hour; only a personal access token can expire on its owner.
  const expiry = i.credentials.github.kind === 'app' ? undefined : scope.expiresAt;
  // The App's own bot user, read once with the App's credentials: the commit identity when instance.yaml sets none, and
  // (#733) the one account a merge whose record a crash cut off is taken for, never from commit_identity. A token install
  // has none, and a failed lookup leaves none: such merges then stay unaccounted (the stop, and the owner's review), and
  // the coordinator records that reconciliation is off until a restart.
  let appBot: Awaited<ReturnType<typeof appBotIdentity>> | null = null;
  let appBotError: string | null = null;
  if (gh.kind === 'app') {
    try {
      appBot = await appBotIdentity({ appId: gh.app_id, installationId: gh.installation_id, keyPath: gh.key_path }, fetch, githubApi());
    } catch (e) {
      appBotError = (e as Error).message;
    }
  }
  // Every commit carries one identity: instance.yaml's, else the App's bot, never one an agent picks.
  let identity: CommitIdentity;
  if (i.commitIdentity) identity = i.commitIdentity;
  else if (gh.kind === 'app') {
    if (!appBot) {
      console.error(`instance ${name} not started: no commit identity (${appBotError ?? 'no App bot user'}); set commit_identity in instance.yaml`);
      return 1;
    }
    identity = { name: appBot.name, email: appBot.email };
  } else identity = { name: `${BRAND.cli}-${i.name}`, email: `${BRAND.cli}-${i.name}@users.noreply.invalid` };
  console.error(`commits as: ${identity.name} <${identity.email}>`);
  const engineBot = appBot ? { login: appBot.name, id: appBot.id } : null;
  if (appBotError) console.error(`the App's bot user could not be read (${appBotError}): merge reconciliation is off until a restart reads it`);
  // Whose repo this is, for the self-modification locks (#665): root's word only (src/managed-apps.ts), asked again for
  // every review level, so root's change applies without a restart. The repo is instance.yaml's, outside the repo.
  const lockScope = ((inst: string, repo: string) => () => readLockScope(inst, repo).scope)(i.name, i.repo.repo);
  console.error(`self-modification locks: ${readLockScope(i.name, i.repo.repo).why}`);
  const testRun: TestRunSetup = { instance: i.name, repo: i.repo.repo, token: tokens, api: githubApi(), ...(gh.kind === 'app' ? { app: { appId: gh.app_id, installationId: gh.installation_id, keyPath: gh.key_path } } : {}) };
  // Intake (docs/intake.md): this instance's own intake.yaml and bot token only; none means intake off.
  // A production intake source reads only through the owner's production read path, when the project has one.
  const pr = i.config.deploy?.prod_read;
  const intake = () => intakeForInstance({ home: i.home, repo: i.repo.repo, instance: i.name, tokenFile: i.credentials.intake?.discord_token, slackAppTokenFile: i.credentials.intake?.slack_app_token, slackBotTokenFile: i.credentials.intake?.slack_bot_token, linearKeyFile: i.credentials.intake?.linear_api_key, githubToken: tokens, githubApi: githubApi(), stateDir: i.stateDir, prodRead: pr ? (sql: string) => prodRead(pr, sql, i.repo.path) : undefined });
  // The main watch (GitHub only), and whose PRs get the full run: both from repo permissions, read with the instance's own token.
  const roleOf = cachedRoles(repoPermission({ repo: i.repo.repo, token: tokens, api: githubApi() }));
  const watchApi = new GitHubMainWatchApi(i.repo.repo, tokens, fetch, githubApi());
  const mainWatch = i.config.project.backlog === 'github' ? { api: watchApi, setting: () => loadInstance(name).policy.main_watch, engineBot, ...(appBotError ? { engineBotError: appBotError } : {}) } : undefined;
  // Every merge to the default branch, posted in the ops channel (src/merge-posts.ts): GitHub only.
  const mergePosts = i.config.project.backlog === 'github' ? { api: new GitHubMergePostsApi(i.repo.repo, tokens, fetch, githubApi()) } : undefined;
  // CI timings for the metrics (src/ci-metrics.ts): GitHub only, read-only.
  const ciMetrics = i.config.project.backlog === 'github' ? { api: new GitHubCiMetricsApi(i.repo.repo, tokens, fetch, githubApi()) } : undefined;
  // The watchdog (src/watchdog/): this instance's checks, plus the machine's if elected. Each run's login: its user's
  // own, with every ~/.claude-profiles an older engine left on the run's denied reads (src/claude-accounts-retired.ts).
  const login = i.runAs ? retiredLogin({ agentUser: i.runAs.user }) : undefined;
  const agentAs = i.runAs;
  const watchdog = (log: EventLog, intakeConfig: () => IntakeConfig | null) => watchdogForInstance({ instance: i.name, stateDir: i.stateDir, log, env, ...(agentAs && login ? { runAs: () => login.resolve(agentAs) } : {}), tokens, intake: intakeConfig, ...(i.credentials.intake?.discord_token ? { discordTokenFile: i.credentials.intake.discord_token } : {}), say: (l) => console.error(l) });
  // land_mode direct only on a branch GitHub protects (direct-land.ts): checked at start-up and before every direct land.
  // WHY: item 38. A build routed to another vendor's CLI (policy opt-in only) runs as the lane's agent user, never as this one.
  const lanes = laneRuns(i);
  const vendor = (agent: CliAgentName) => new CliAgentRunner(agent, { runAs: (lane) => lanes[lane]?.runAs, identity });
  // Approved plugins (src/plugins/run.ts): root's allowlist and store, checked before every run.
  const plugins = ({ role }: { role: string }) => pluginsForRun({ instance: i.name, instanceHome: i.home, role });
  const claude = new CliRunner(instanceRuntime(i).runtime, process.env, 'claude', i.runAs ?? undefined, allLanes(i), identity, {}, () => guardrailSettings(i.home, i.name, i.repo.path), instanceRuntime(i).apiKeyFile, login, plugins, { instance: i.name, register: (role, ttlMs) => registerRun(i.name, role, ttlMs), end: (ticket) => endRun(i.name, ticket) });
  return runSite(siteForInstance(i), { ...opts, instance: i.name, label: `instance ${name}`, lockScope, protection: watchApi, offsiteConfig: join(i.home, OFFSITE_FILE), ...(i.credentials.provider_keys ? { providerKeys: i.credentials.provider_keys } : {}), testRun, intake, roleOf, liveConfig, watchdog, incidents: incidentSink(i.name), accountSwitched: () => accountSwitchedAt(i.name), superfan: superfanView(i.name, i.stateDir), ...(i.runAs ? { experiments: { instance: i.name, pinsFile: join(i.home, PINS_FILE) } } : {}), automations: { file: join(i.home, AUTOMATIONS_FILE), policy: () => readPolicy(join(i.home, 'policy.yaml')).policy?.automations ?? AutomationsPolicy.parse(undefined) }, ...(mainWatch ? { mainWatch } : {}), ...(mergePosts ? { mergePosts } : {}), ...(ciMetrics ? { ciMetrics } : {}) }, withCliAgents(claude, { codex: vendor('codex'), gemini: vendor('gemini') }), expiry, tokens, i.runAs ?? undefined, gh.kind === 'app' ? gh.key_path : undefined, identity, () => loadInstance(name).policy.auto_merge, settingsReader(join(i.home, 'policy.yaml')));
}

/** An instance's superfan view: its name, and its service log as the dashboard's Logs page reads it (never sudo). */
export function superfanView(name: string, stateDir: string): NonNullable<CoordinatorDeps['superfan']> {
  return { name, journal: async () => (await import('./dashboard.js')).readServiceLog({ unit: `${BRAND.cli}-${name}.service`, file: join(stateDir, 'coordinator.log') }, 200) };
}

/** The policy's lanes plus the built-in research lanes (no repo access by default; see researchLanes). */
function allLanes(i: ReturnType<typeof loadInstance>) {
  const lanes = laneRuns(i);
  return { ...lanes, ...researchLanes(i, lanes.default) };
}

export function runCoordinator(root: string, opts: { once?: boolean; intervalMs?: number; backupDir?: string } = {}): Promise<number> {
  const gate = migrationGate({ configFiles: projectConfigFiles(root), eventsDb: logPath(root) });
  if (gate) {
    console.error(`coordinator not started: ${gate}`);
    return Promise.resolve(1);
  }
  const checkout = siteForRoot(root);
  // The config as the default branch has it, not the checkout's copy; the coordinator then follows it (src/config/live.ts).
  const start = startConfig({ repo: root, remote: 'origin', fallback: checkout.cfg });
  if (start.note) console.error(start.note);
  const site = { ...checkout, cfg: start.cfg };
  // A remote on GitHub: its protection, asked with the gh login (direct-land.ts); a local path has none to ask.
  const protection = localRemote(root, 'origin') ? undefined : new GitHubMainWatchApi(site.cfg.project.project.repo, async () => execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim(), fetch, githubApi());
  return runSite(site, { ...opts, label: 'coordinator', liveConfig: { tree: start.tree }, ...(protection ? { protection } : {}) });
}

/** How long a shutdown (SIGTERM, SIGINT) may take before the process exits anyway, naming what was still pending. */
export const SHUTDOWN_MS = 20_000;

/** A sleep that a shutdown ends at once. */
function wakeableSleep() {
  let wake = () => {};
  return {
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        wake = () => {
          clearTimeout(t);
          r();
        };
      }),
    wake: () => wake(),
  };
}

export async function runSite(site: Site, opts: { /** The instance's name (its incidents' `instance`); absent: a local site, which raises none. */ instance?: string; once?: boolean; intervalMs?: number; backupDir?: string; offsiteConfig?: string; shutdownMs?: number; providerKeys?: Record<string, string>; testRun?: TestRunSetup; intake?: () => IntakeWiring | null; roleOf?: RoleOf; mainWatch?: CoordinatorDeps['mainWatch']; mergePosts?: CoordinatorDeps['mergePosts']; ciMetrics?: CoordinatorDeps['ciMetrics']; protection?: Protection; liveConfig?: CoordinatorDeps['liveConfig']; label?: string; watchdog?: (log: EventLog, intake: () => IntakeConfig | null) => { stop: () => void }; incidents?: IncidentSink; accountSwitched?: () => string | null; superfan?: CoordinatorDeps['superfan']; experiments?: CoordinatorDeps['experiments']; lockScope?: CoordinatorDeps['lockScope']; /** Automations: the instance's file and policy (GitHub's GET is built here, from `tokens`). */ automations?: { file: string; policy: () => AutomationsPolicy } }, runner?: AgentRunner, tokenExpiresAt?: string | null, tokens?: () => Promise<string>, commandsAs?: ProjectRunAs, appKeyPath?: string, commitIdentity?: CommitIdentity, autoMerge?: () => boolean, settings?: () => { settings: InstanceSettings; error: string | null }): Promise<number> {
  const { cfg, root, stateDir: state } = site;
  const lock = tryLock(join(state, 'coordinator.lock'), `coordinator ${instanceId()}`);
  if (!('lock' in lock)) {
    console.error(`another coordinator is running for this project (pid ${lock.holder?.pid})`);
    return 1;
  }
  // Agents run as their own user: their task files go beside the checkout (/srv/<cli>/<name>/tasks), in the group
  // the checkout shares with them, readable but not writable by them. The coordinator's own state stays private.
  const agentTasks = commandsAs ? { dir: join(dirname(root), 'tasks'), gid: statSync(root).gid } : undefined;
  // Before anything reads or writes it: state/ as this engine keeps it, whatever an older engine left.
  const tidied = tidyState(state, agentTasks ? { agentTasksDir: agentTasks.dir } : {});
  // INVARIANT: a write the full disk refuses never kills the coordinator: it waits in memory, in order, and the disk
  // guard writes it again, holds new work meanwhile, and raises the disk_full incident (src/disk-guard.ts).
  const log = new EventLog(site.logPath, { buffer: {} });
  let inFlight = (): number | undefined => undefined;
  const disk = siteDiskGuard({
    log,
    stateDir: state,
    testRuns: !!opts.testRun,
    instance: opts.instance ?? null,
    actor: instanceId(),
    floor: () => {
      const c = watchdogConfig();
      return { gb: c.minFreeGb, pct: c.minFreePct };
    },
    inFlight: () => inFlight(),
  });
  const stopDisk = startDiskGuard(disk);
  // INVARIANT: every test run this process starts (PR runs, batches, the flaky re-run, fix-forward's probes, the deploy
  // gate) and every preview passes this one gate (src/testrun/gate.ts); the disk guard is its `disk` source.
  const ungateDisk = addStartGate('disk', () => disk.held());
  // `drain`: while the engine updater drains the machine (src/update-drain.ts, root's flag until its expiry), no new
  // test run starts.
  const ungateDrain = addStartGate('drain', drainRefusal);
  // land_mode direct pushes the default branch itself: never on a branch GitHub doesn't protect (direct-land.ts).
  const refused = await directLandStartGate({ landMode: cfg.project.land_mode, api: opts.protection, local: localRemote(root, 'origin'), repo: cfg.project.project.repo, branch: cfg.project.project.default_branch, label: opts.label ?? 'coordinator', log, actor: instanceId() });
  if (refused) {
    console.error(refused);
    ungateDisk();
    ungateDrain();
    stopDisk();
    log.close();
    lock.lock.release();
    return 1;
  }
  // Intake connects only once this process holds the instance's lock: never a second bot for one instance.
  const intake = opts.intake?.() ?? null;
  // Discord connects after its start-up checks (no other instance on the machine in its channels; every
  // discord.owners entry an admin); a refusal leaves Discord off and says why, and the instance runs on.
  if (intake) await intake.start();
  // The same instance root keeps its dependency cache, in the group its agents share.
  const depCacheRoot = commandsAs ? { dir: dirname(root), gid: statSync(root).gid } : undefined;
  // The coordinator's own test runs of every PR (tests.yaml test_run). While the sandbox's check fails they are set up
  // but refuse every run, and the check is run again until it passes (src/testrun/sandbox-watch.ts).
  const testRuns = opts.testRun ? await setupTestRuns(cfg, opts.testRun, { log, actor: instanceId(), root, stateDir: state }) : undefined;
  // The tracker: one for the coordinator and the post-deploy check's follow-up issues.
  const backlog = backlogFor(cfg, root, state, tokens);
  // The pre-deploy gate (tests.yaml deploy_gate): only through the test runs just set up, and only while their sandbox's check passes.
  const deployGate = opts.testRun ? setupDeployGate(cfg, opts.testRun, { log, actor: instanceId(), root, stateDir: state, testRunsReady: !!testRuns, backlog, ...(opts.incidents ? { incidents: opts.incidents } : {}) }) : undefined;
  const previews = opts.testRun ? setupPreviews(cfg, opts.testRun, { log, actor: instanceId(), stateDir: state }) : undefined;
  const coordinator = new Coordinator({ disk, cfg, log, backlog, runner: runner ?? new CliRunner(cfg.project.agent_runtime.kind), repo: root, instance: instanceId(), stateDir: state, ...(agentTasks ? { agentTasks } : {}), ...(depCacheRoot ? { depCacheRoot } : {}), ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}), ...(commandsAs ? { commandsAs } : {}), ...(appKeyPath ? { appKeyPath } : {}), ...(commitIdentity ? { commitIdentity } : {}), ...(autoMerge ? { autoMerge } : {}), ...(settings ? { settings } : {}), ...(opts.providerKeys ? { providerKeys: opts.providerKeys } : {}), ...(testRuns ? { prTestRuns: testRuns, testRuns: batchTestRuns(cfg.tests.test_run!, testRuns.stopped.signal) } : {}), ...(deployGate ? { deployGate } : {}), ...(previews ? { previews } : {}), ...(intake ? { intake: { config: intake.config, sources: intake.sources, name: intake.name, ...(intake.roleOf ? { roleOf: intake.roleOf } : {}) } } : {}), ...(opts.roleOf ? { roleOf: opts.roleOf } : {}), ...(opts.mainWatch ? { mainWatch: opts.mainWatch } : {}), ...(opts.mergePosts ? { mergePosts: opts.mergePosts } : {}), ...(opts.ciMetrics ? { ciMetrics: opts.ciMetrics } : {}),...(opts.protection ? { protection: opts.protection } : {}), ...(opts.incidents ? { incidents: opts.incidents } : {}), ...(opts.accountSwitched ? { accountSwitched: opts.accountSwitched } : {}), ...(opts.liveConfig ? { liveConfig: opts.liveConfig } : {}), ...(opts.superfan ? { superfan: opts.superfan } : {}), ...(opts.experiments ? { experiments: opts.experiments } : {}), ...(opts.lockScope ? { lockScope: opts.lockScope } : {}), writersApproveLand: site.policyFile ? () => readPolicy(site.policyFile!).policy?.writers_approve_land === true : () => true, ...(opts.automations ? { automations: { ...opts.automations, ...(tokens && !localRemote(root, 'origin') ? { github: githubGet({ api: githubApi(), token: tokens }) } : {}) } } : {}) });
  inFlight = () => coordinator.pending().filter((p) => !p.startsWith('tick step')).length;
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  log.append('coordinator.started', { instance: instanceId(), pid: process.pid, version }, instanceId());
  if (tidied.tightened.length || tidied.removedTasks.length) log.append('state.tidied', { tightened: tidied.tightened.length, paths: tidied.tightened.slice(0, 20), removed_tasks: tidied.removedTasks.length }, instanceId());
  const requeued = await coordinator.recover();
  if (requeued.length) console.log(`recovered: requeued ${requeued.map((n) => `#${n}`).join(', ')}`);
  // Shutdown (SIGTERM, SIGINT): nothing new starts; in-flight work is aborted and requeued (Coordinator.stop); the
  // watchdog steps down, timers stop, log and lock are released. Anything pending after shutdownMs is named, then exit.
  let stopping = false;
  const nap = wakeableSleep();
  let watchdog: { stop: () => void } | null = null;
  let deadline: NodeJS.Timeout | undefined;
  const stoppingSince = { at: 0 };
  const forceExit = (why: string) => {
    const pending = coordinator.pending();
    const message = `shutdown: ${why}; exiting with ${pending.length ? `still pending: ${pending.join(', ')}` : 'nothing named pending'}`;
    console.error(message);
    try {
      log.append('coordinator.stopped', { instance: instanceId(), clean: false, ms: Date.now() - stoppingSince.at, pending }, instanceId());
      log.close();
    } catch {
      // the log is already closed: the message above still says why
    }
    lock.lock.release();
    process.exit(1);
  };
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return forceExit(`${signal} again`);
    stopping = true;
    stoppingSince.at = Date.now();
    console.error(`${signal}: stopping (aborting runs in flight; their tasks requeue)`);
    log.append('coordinator.stopping', { instance: instanceId(), signal, pending: coordinator.pending() }, instanceId());
    watchdog?.stop();
    clearInterval(watch);
    coordinator.stop();
    nap.wake();
    // Kept referenced: work that hangs on nothing the event loop holds still ends here, not in a silent exit.
    deadline = setTimeout(() => forceExit(`not stopped after ${Math.round((opts.shutdownMs ?? SHUTDOWN_MS) / 1000)} s`), opts.shutdownMs ?? SHUTDOWN_MS);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const backupDir = opts.backupDir ?? ownEnv().get(`${BRAND.envPrefix}_BACKUP_DIR`) ?? join(state, 'backups');
  const offsiteConfig = opts.offsiteConfig ?? ownEnv().get(`${BRAND.envPrefix}_OFFSITE_BACKUP`);
  // An emergency stop takes effect within seconds, not at the next tick.
  // The console's requests (message, stop), chat questions and intake (which pulls its sources on its own, slower
  // clock) are taken on the same short timer. Discord chat and decision-thread messages don't wait for it: each wakes
  // the coordinator as it arrives (src/coordinator/quick-replies.ts); this timer is their fallback.
  // WHY: a full disk thrown from this timer (a state file it writes) would kill the process: said in the journal, and
  // the next beat tries again. Anything else still throws, as before.
  const diskOnly = (e: unknown) => {
    if (!storageFailure(e)) throw e;
    console.error(`coordinator: ${storageFailure(e)}; tried again in 5 s`);
  };
  const watch = setInterval(() => {
    try {
      coordinator.checkEmergency();
      coordinator.checkConsole();
    } catch (e) {
      diskOnly(e);
    }
    coordinator.checkChat().catch(diskOnly);
    coordinator.checkIntake().catch(diskOnly);
  }, 5_000);
  watch.unref();
  watchdog = opts.once ? null : (opts.watchdog?.(log, () => intake?.config() ?? null) ?? null);
  let lastBackup = 0;
  try {
    while (!stopping) {
      await coordinator.tick();
      if (!stopping && Date.now() - lastBackup > 3600_000) {
        const b = await backup(log, dirStore(backupDir));
        if (!b.ok) log.append('coordinator.error', { instance: instanceId(), where: 'backup', kind: 'backup_failed', message: b.error ?? 'unknown' }, instanceId());
        // Off the machine too, when the owner set it up: encrypted, and verified by reading the remote copy back.
        if (offsiteConfig) await maybeOffsiteBackup(log, offsiteConfig, instanceId()).catch((e: Error) => log.append('coordinator.error', { instance: instanceId(), where: 'offsite backup', kind: 'error', message: e.message.slice(0, 500) }, instanceId()));
        lastBackup = Date.now();
      }
      if (opts.once || stopping) break;
      await nap.sleep((opts.intervalMs ?? 60_000) + Math.random() * 5_000);
    }
    await coordinator.idle();
    if (stopping) log.append('coordinator.stopped', { instance: instanceId(), clean: true, ms: Date.now() - stoppingSince.at, pending: [] }, instanceId());
  } finally {
    clearTimeout(deadline);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    clearInterval(watch);
    watchdog?.stop();
    intake?.stop();
    ungateDisk();
    ungateDrain();
    stopDisk();
    // WHY: events still waiting for room get one last try; what can't be written is named in the journal, not lost silently.
    const left = log.buffered().count;
    if (left) {
      const r = log.flush();
      if (r.error) console.error(`coordinator: ${left} events couldn't be written before exit (${r.error}); they are lost`);
    }
    log.close();
    lock.lock.release();
  }
  return 0;
}

/** A plain-text status summary from the event log (the dashboard reads the same log). */
export function status(root: string): string {
  const cfg = loadConfig(root);
  const log = new EventLog(logPath(root));
  try {
    const ev = log.read();
    const day = new Date().toISOString().slice(0, 10);
    const spent = ev.filter((e) => e.type === 'run.cost' && e.ts.startsWith(day)).reduce((s, e) => s + (e.payload as { usd: number }).usd, 0);
    const byIssue = new Map<number, string>();
    for (const e of ev) {
      const n = (e.payload as { issue?: number }).issue;
      if (typeof n === 'number') byIssue.set(n, e.type);
    }
    const open = [...byIssue].filter(([, t]) => !['issue.released', 'issue.closed', 'deploy.verified'].includes(t));
    const decisions = ev.filter((e) => e.type === 'decision.asked').filter((q) => !ev.some((a) => a.type === 'decision.answered' && (a.payload as { id: string }).id === (q.payload as { id: string }).id));
    const slots = slotStatus();
    const started = ev.filter((e) => e.type === 'coordinator.started').at(-1);
    const lastTick = ev.filter((e) => e.type === 'coordinator.tick').at(-1);
    const base = latestBaseline(log);
    const baseLine = base
      ? `main baseline: ${base.failing.length} failing at ${base.sha.slice(0, 8)} (recorded ${base.recordedAt})${base.failing.length ? `: ${base.failing.slice(0, 8).join(', ')}${base.failing.length > 8 ? ', ...' : ''}` : ''}`
      : `main baseline: none recorded (landing blocks on any red until \`${BRAND.cli} baseline record\`)`;
    return [
      `${BRAND.name}: ${cfg.project.project.name} (${cfg.project.project.repo}), land mode ${cfg.project.land_mode}`,
      `coordinator: ${started ? `started ${started.ts} by ${started.actor}` : 'never started'}; last tick ${lastTick?.ts ?? 'never'}`,
      `agents running on this machine: ${slots.agents.length} of ${slots.cap}`,
      `spend today: $${spent.toFixed(2)} of $${cfg.agents.daily_budget_usd}`,
      baseLine,
      `in progress: ${open.length ? open.map(([n, t]) => `#${n} (${t})`).join(', ') : 'none'}`,
      `decisions waiting: ${decisions.length ? decisions.map((d) => `${(d.payload as { id: string }).id} for @${(d.payload as { owner: string }).owner}: ${(d.payload as { question: string }).question}`).join('; ') : 'none'}`,
    ].join('\n');
  } finally {
    log.close();
  }
}

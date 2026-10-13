// The coordinator as a long-running process: one per project per machine
// (a pid lock), started by the OS service manager so it never depends on a
// Claude session. It recovers on start, ticks, and backs up the log hourly
// with verified read-back.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { checkRepoScope } from './github-scope.js';
import { appBotIdentity, installationTokens } from './github-app.js';
import { fileURLToPath } from 'node:url';
import { appKeyAge, appKeyWarning, tokenWarning } from './reports.js';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from './brand.js';
import { FileBacklog } from './backlog/file.js';
import { GitHubBacklog } from './backlog/github.js';
import type { Backlog } from './backlog/types.js';
import { loadConfig, type Config } from './config/load.js';
import { Coordinator } from './coordinator.js';
import { backup, dirStore } from './events/backup.js';
import { maybeOffsiteBackup, OFFSITE_FILE } from './offsite-backup.js';
import { tidyState } from './state-tidy.js';
import { EventLog } from './events/log.js';
import { projectStateDir } from './guardrails/context.js';
import { tryLock } from './locks.js';
import { slotStatus } from './slots.js';
import { guardrailSettings } from './agent-settings.js';
import { CliRunner, type CommitIdentity, type RunAs } from './runner.js';
import { latestBaseline } from './baseline.js';
import { instanceConfigProblems, instanceProblems, instancesDir, laneRuns, researchLanes, loadInstance, readPolicy, type Instance, type InstanceSettings, type PolicyFile } from './instance.js';
import { startConfig } from './config/live.js';
import { instanceTargets, migrationGate, projectConfigFiles } from './migrations.js';
import { settingsReader } from './settings.js';
import { batchTestRuns, setupTestRuns, type TestRunSetup } from './testrun/setup.js';
import { intakeForInstance, type IntakeWiring } from './intake/wire.js';
import { prodRead } from './prodread.js';
import { coordinatorHooksDir, writeCoordinatorHooks } from './push-guard.js';
import { cachedRoles, repoPermission, type RoleOf } from './dashboard-auth.js';
import type { CoordinatorDeps } from './coordinator/shared.js';
import { GitHubMainWatchApi } from './github/main-watch-api.js';
import { directLandStartGate, localRemote, type Protection } from './direct-land.js';

/** The coordinator's umask when agents run as their own user: group read/write (agents share the group), nothing for others. */
export const INSTANCE_UMASK = 0o007;

export const instanceId = () => `${userInfo().username}@${hostname().split('.')[0]}`;
export const logPath = (root: string) => join(projectStateDir(root), 'events.db');
export const serviceLabel = (cfg: Config) => `dev.${BRAND.cli}.${cfg.project.project.name.replace(/[^A-Za-z0-9-]/g, '-')}`;

export function backlogFor(cfg: Config, root: string, state = projectStateDir(root), token?: () => Promise<string>): Backlog {
  return cfg.project.backlog === 'github' ? new GitHubBacklog(cfg.project.project.repo, token) : new FileBacklog(join(state, 'backlog.json'));
}

const githubApi = () => process.env[`${BRAND.envPrefix}_GITHUB_API`] ?? 'https://api.github.com';

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
}

export const siteForRoot = (root: string): Site => ({ cfg: loadConfig(root), root, stateDir: projectStateDir(root), logPath: logPath(root) });
export const siteForInstance = (i: Instance): Site => ({ cfg: i.config, root: i.repo.path, stateDir: i.stateDir, logPath: join(i.stateDir, 'events.db') });
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
  return env;
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
export function instanceRuntime(i: Pick<Instance, 'credentials'>): { runtime: 'cli' | 'api_key'; apiKeyFile?: string } {
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
  // The config as the default branch has it (fetched with the instance's own credentials), not the checkout's copy,
  // which nothing updates: the coordinator then follows it (src/config/live.ts). Hooks are rewritten for it.
  const home = i.home;
  const policyNow = (fallback: PolicyFile) => readPolicy(join(home, 'policy.yaml')).policy ?? fallback;
  const check = (c: Config) => instanceConfigProblems(c, i.repo.repo, policyNow(i.policy));
  const start = startConfig({ repo: i.repo.path, remote: 'origin', fallback: i.config, check });
  if (start.note) console.error(start.note);
  i = { ...i, config: start.cfg };
  writeInstanceHooks(i);
  const liveConfig = { tree: start.tree, check };
  const gh = i.credentials.github;
  const warn = gh.kind === 'app' ? appKeyWarning(appKeyAge(gh.key_path)) : tokenWarning(scope.expiresAt);
  if (warn) console.error(warn.replaceAll('**', ''));
  // App tokens renew themselves every hour; only a personal access token can expire on its owner.
  const expiry = i.credentials.github.kind === 'app' ? undefined : scope.expiresAt;
  // Every commit carries one identity: instance.yaml's, else the App's bot, never one an agent picks.
  let identity: CommitIdentity;
  try {
    identity = i.commitIdentity ?? (gh.kind === 'app' ? await appBotIdentity({ appId: gh.app_id, installationId: gh.installation_id, keyPath: gh.key_path }, fetch, githubApi()) : { name: `${BRAND.cli}-${i.name}`, email: `${BRAND.cli}-${i.name}@users.noreply.invalid` });
  } catch (e) {
    console.error(`instance ${name} not started: no commit identity (${(e as Error).message}); set commit_identity in instance.yaml`);
    return 1;
  }
  console.error(`commits as: ${identity.name} <${identity.email}>`);
  const testRun: TestRunSetup = { instance: i.name, repo: i.repo.repo, token: tokens, api: githubApi(), ...(gh.kind === 'app' ? { app: { appId: gh.app_id, installationId: gh.installation_id, keyPath: gh.key_path } } : {}) };
  // Intake (docs/intake.md): this instance's own intake.yaml and bot token only; none means intake off.
  // A production intake source reads only through the owner's production read path, when the project has one.
  const pr = i.config.deploy?.prod_read;
  const intake = () => intakeForInstance({ home: i.home, repo: i.repo.repo, instance: i.name, tokenFile: i.credentials.intake?.discord_token, githubToken: tokens, githubApi: githubApi(), stateDir: i.stateDir, prodRead: pr ? (sql: string) => prodRead(pr, sql, i.repo.path) : undefined });
  // The main watch (GitHub only), and whose PRs get the full run: both from repo permissions, read with the instance's own token.
  const roleOf = cachedRoles(repoPermission({ repo: i.repo.repo, token: tokens, api: githubApi() }));
  const watchApi = new GitHubMainWatchApi(i.repo.repo, tokens, fetch, githubApi());
  const mainWatch = i.config.project.backlog === 'github' ? { api: watchApi, setting: () => loadInstance(name).policy.main_watch } : undefined;
  // land_mode direct only on a branch GitHub protects (direct-land.ts): checked at start-up and before every direct land.
  return runSite(siteForInstance(i), { ...opts, label: `instance ${name}`, protection: watchApi, offsiteConfig: join(i.home, OFFSITE_FILE), ...(i.credentials.provider_keys ? { providerKeys: i.credentials.provider_keys } : {}), testRun, intake, roleOf, liveConfig, ...(mainWatch ? { mainWatch } : {}) }, new CliRunner(instanceRuntime(i).runtime, process.env, 'claude', i.runAs ?? undefined, allLanes(i), identity, {}, () => guardrailSettings(i.home, i.name, i.repo.path), instanceRuntime(i).apiKeyFile), expiry, tokens, i.runAs ?? undefined, gh.kind === 'app' ? gh.key_path : undefined, identity, () => loadInstance(name).policy.auto_merge, settingsReader(join(i.home, 'policy.yaml')));
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

async function runSite(site: Site, opts: { once?: boolean; intervalMs?: number; backupDir?: string; offsiteConfig?: string; providerKeys?: Record<string, string>; testRun?: TestRunSetup; intake?: () => IntakeWiring | null; roleOf?: RoleOf; mainWatch?: CoordinatorDeps['mainWatch']; protection?: Protection; liveConfig?: CoordinatorDeps['liveConfig']; label?: string }, runner?: CliRunner, tokenExpiresAt?: string | null, tokens?: () => Promise<string>, commandsAs?: RunAs, appKeyPath?: string, commitIdentity?: CommitIdentity, autoMerge?: () => boolean, settings?: () => { settings: InstanceSettings; error: string | null }): Promise<number> {
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
  const log = new EventLog(site.logPath);
  // land_mode direct pushes the default branch itself: never on a branch GitHub doesn't protect (direct-land.ts).
  const refused = await directLandStartGate({ landMode: cfg.project.land_mode, api: opts.protection, local: localRemote(root, 'origin'), repo: cfg.project.project.repo, branch: cfg.project.project.default_branch, label: opts.label ?? 'coordinator', log, actor: instanceId() });
  if (refused) {
    console.error(refused);
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
  // The coordinator's own test runs of every PR (tests.yaml test_run), once the sandbox's check passed.
  const testRuns = opts.testRun ? await setupTestRuns(cfg, opts.testRun, { log, actor: instanceId(), root, stateDir: state }) : undefined;
  const coordinator = new Coordinator({ cfg, log, backlog: backlogFor(cfg, root, state, tokens), runner: runner ?? new CliRunner(cfg.project.agent_runtime.kind), repo: root, instance: instanceId(), stateDir: state, ...(agentTasks ? { agentTasks } : {}), ...(depCacheRoot ? { depCacheRoot } : {}), ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}), ...(commandsAs ? { commandsAs } : {}), ...(appKeyPath ? { appKeyPath } : {}), ...(commitIdentity ? { commitIdentity } : {}), ...(autoMerge ? { autoMerge } : {}), ...(settings ? { settings } : {}), ...(opts.providerKeys ? { providerKeys: opts.providerKeys } : {}), ...(testRuns ? { prTestRuns: testRuns, testRuns: batchTestRuns(cfg.tests.test_run!, testRuns.stopped.signal) } : {}), ...(intake ? { intake: { config: intake.config, sources: intake.sources, name: intake.name, ...(intake.roleOf ? { roleOf: intake.roleOf } : {}) } } : {}), ...(opts.roleOf ? { roleOf: opts.roleOf } : {}), ...(opts.mainWatch ? { mainWatch: opts.mainWatch } : {}), ...(opts.protection ? { protection: opts.protection } : {}), ...(opts.liveConfig ? { liveConfig: opts.liveConfig } : {}) });
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  log.append('coordinator.started', { instance: instanceId(), pid: process.pid, version }, instanceId());
  if (tidied.tightened.length || tidied.removedTasks.length) log.append('state.tidied', { tightened: tidied.tightened.length, paths: tidied.tightened.slice(0, 20), removed_tasks: tidied.removedTasks.length }, instanceId());
  const requeued = await coordinator.recover();
  if (requeued.length) console.log(`recovered: requeued ${requeued.map((n) => `#${n}`).join(', ')}`);
  let stopping = false;
  const stop = () => {
    stopping = true;
    coordinator.stop();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const backupDir = opts.backupDir ?? process.env[`${BRAND.envPrefix}_BACKUP_DIR`] ?? join(state, 'backups');
  const offsiteConfig = opts.offsiteConfig ?? process.env[`${BRAND.envPrefix}_OFFSITE_BACKUP`];
  // An emergency stop takes effect within seconds, not at the next tick.
  // The console's requests (message, stop), chat questions and intake (which pulls its sources on its own, slower
  // clock) are taken on the same short timer. Discord chat and decision-thread messages don't wait for it: each wakes
  // the coordinator as it arrives (src/coordinator/quick-replies.ts); this timer is their fallback.
  const watch = setInterval(() => {
    coordinator.checkEmergency();
    coordinator.checkConsole();
    void coordinator.checkChat();
    void coordinator.checkIntake();
  }, 5_000);
  watch.unref();
  let lastBackup = 0;
  try {
    do {
      await coordinator.tick();
      if (Date.now() - lastBackup > 3600_000) {
        const b = await backup(log, dirStore(backupDir));
        if (!b.ok) log.append('coordinator.error', { instance: instanceId(), where: 'backup', kind: 'backup_failed', message: b.error ?? 'unknown' }, instanceId());
        // Off the machine too, when the owner set it up: encrypted, and verified by reading the remote copy back.
        if (offsiteConfig) await maybeOffsiteBackup(log, offsiteConfig, instanceId()).catch((e: Error) => log.append('coordinator.error', { instance: instanceId(), where: 'offsite backup', kind: 'error', message: e.message.slice(0, 500) }, instanceId()));
        lastBackup = Date.now();
      }
      if (opts.once) break;
      await new Promise((r) => setTimeout(r, (opts.intervalMs ?? 60_000) + Math.random() * 5_000));
    } while (!stopping);
    await coordinator.idle();
  } finally {
    clearInterval(watch);
    intake?.stop();
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

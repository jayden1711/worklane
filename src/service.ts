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
import { CliRunner, type CommitIdentity, type RunAs } from './runner.js';
import { latestBaseline } from './baseline.js';
import { instanceProblems, laneRuns, loadInstance, type Instance, type InstanceSettings } from './instance.js';
import { settingsReader } from './settings.js';

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
  // The coordinator's git runs in checkouts agents can write to: no hooks, no fsmonitor command, whatever the repo's config says.
  const git: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
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

/** Run an instance's coordinator. Refuses to start without the instance's own credentials. */
export async function runInstanceCoordinator(name: string, opts: { once?: boolean; intervalMs?: number } = {}): Promise<number> {
  const i = loadInstance(name);
  const missing = instanceProblems(i);
  if (missing.length) {
    console.error(`instance ${name} not started:\n${missing.map((m) => `  ${m}`).join('\n')}`);
    return 1;
  }
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
  return runSite(siteForInstance(i), { ...opts, offsiteConfig: join(i.home, OFFSITE_FILE) }, new CliRunner(i.config.project.agent_runtime.kind, process.env, 'claude', i.runAs ?? undefined, laneRuns(i), identity), expiry, tokens, i.runAs ?? undefined, gh.kind === 'app' ? gh.key_path : undefined, identity, () => loadInstance(name).policy.auto_merge, settingsReader(join(i.home, 'policy.yaml')));
}

export function runCoordinator(root: string, opts: { once?: boolean; intervalMs?: number; backupDir?: string } = {}): Promise<number> {
  return runSite(siteForRoot(root), opts);
}

async function runSite(site: Site, opts: { once?: boolean; intervalMs?: number; backupDir?: string; offsiteConfig?: string }, runner?: CliRunner, tokenExpiresAt?: string | null, tokens?: () => Promise<string>, commandsAs?: RunAs, appKeyPath?: string, commitIdentity?: CommitIdentity, autoMerge?: () => boolean, settings?: () => { settings: InstanceSettings; error: string | null }): Promise<number> {
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
  const coordinator = new Coordinator({ cfg, log, backlog: backlogFor(cfg, root, state, tokens), runner: runner ?? new CliRunner(cfg.project.agent_runtime.kind), repo: root, instance: instanceId(), stateDir: state, ...(agentTasks ? { agentTasks } : {}), ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}), ...(commandsAs ? { commandsAs } : {}), ...(appKeyPath ? { appKeyPath } : {}), ...(commitIdentity ? { commitIdentity } : {}), ...(autoMerge ? { autoMerge } : {}), ...(settings ? { settings } : {}) });
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
  // The console's requests (message, stop) and chat questions are taken on the same short timer.
  const watch = setInterval(() => {
    coordinator.checkEmergency();
    coordinator.checkConsole();
    void coordinator.checkChat();
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
    const open = [...byIssue].filter(([, t]) => !['issue.released', 'deploy.verified'].includes(t));
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

import type { Backlog } from './backlog/types.js';
import { type Config } from './config/load.js';
import { EventLog } from './events/log.js';
import { type AgentRunner, type CommitIdentity, type RunAs } from './runner.js';
import { type Instance, type InstanceSettings } from './instance.js';
import { type TestRunSetup } from './testrun/setup.js';
import { type IntakeWiring } from './intake/wire.js';
import type { ServiceSpec } from './os/index.js';
import { type RoleOf } from './dashboard-auth.js';
import type { CoordinatorDeps } from './coordinator/shared.js';
import { type Protection } from './direct-land.js';
import type { IncidentSink } from './usage-limit.js';
import type { IntakeConfig } from './intake/report.js';
/** The coordinator's umask when agents run as their own user: group read/write (agents share the group), nothing for others. */
export declare const INSTANCE_UMASK = 7;
export declare const instanceId: () => string;
export declare const logPath: (root: string) => string;
export declare const serviceLabel: (cfg: Config) => string;
/**
 * The coordinator's service for a checkout (local mode), as `up` installs it and the first-run page's Start does:
 * one spec, so the two can't start it differently.
 */
export declare function localServiceSpec(root: string, cfg: Config, env?: NodeJS.ProcessEnv): ServiceSpec;
/** An instance's coordinator unit on a server (scripts/setup installs it as root). */
export declare const instanceUnit: (name: string) => string;
export declare function backlogFor(cfg: Config, root: string, state?: string, token?: () => Promise<string>): Backlog;
/** Where an instance's GitHub tokens come from: its App (minted, short-lived) or, as a fallback, its own gh login. */
export declare function instanceTokens(i: Instance, env: NodeJS.ProcessEnv): () => Promise<string>;
/** Where a coordinator keeps its state: per repo (no instance), or in an instance's home. */
export interface Site {
    cfg: Config;
    root: string;
    stateDir: string;
    logPath: string;
}
export declare const siteForRoot: (root: string) => Site;
export declare const siteForInstance: (i: Instance) => Site;
export declare const instanceServiceLabel: (name: string) => string;
/**
 * The coordinator's environment for an instance: its own logins and nothing
 * inherited that could stand in for them. gh prefers GH_TOKEN/GITHUB_TOKEN
 * over its config dir, so those are dropped rather than silently used.
 */
export declare function instanceEnv(i: Instance, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Write the instance coordinator's own git hooks dir from the config in effect (push-guard.ts). */
export declare function writeInstanceHooks(i: Pick<Instance, 'home' | 'config'>): string;
/**
 * How an instance's agents are billed: an API key only when its credentials.yaml names one (agent_api_key, which
 * only the owner sets, with credentials.sh); otherwise the agent user's Claude subscription login. The repo's own
 * agent_runtime doesn't decide this for an instance. The key never enters an environment (instanceEnv strips it).
 */
export declare function instanceRuntime(i: Pick<Instance, 'credentials'>): {
    runtime: 'cli' | 'api_key';
    apiKeyFile?: string;
};
/** Run an instance's coordinator. Refuses to start without the instance's own credentials. */
export declare function runInstanceCoordinator(name: string, opts?: {
    once?: boolean;
    intervalMs?: number;
}): Promise<number>;
/**
 * What an instance's superfan reads beyond its event log and the incident store: its name, and its own service log,
 * read the way the dashboard's Logs page reads it (its unit's journal as the coordinator's user, else its log file;
 * never sudo). Imported when first read: the dashboard module imports this one.
 */
export declare function superfanView(name: string, stateDir: string): NonNullable<CoordinatorDeps['superfan']>;
export declare function runCoordinator(root: string, opts?: {
    once?: boolean;
    intervalMs?: number;
    backupDir?: string;
}): Promise<number>;
/** How long a shutdown (SIGTERM, SIGINT) may take before the process exits anyway, naming what was still pending. */
export declare const SHUTDOWN_MS = 20000;
export declare function runSite(site: Site, opts: {
    instance?: string;
    once?: boolean;
    intervalMs?: number;
    backupDir?: string;
    offsiteConfig?: string;
    shutdownMs?: number;
    providerKeys?: Record<string, string>;
    testRun?: TestRunSetup;
    intake?: () => IntakeWiring | null;
    roleOf?: RoleOf;
    mainWatch?: CoordinatorDeps['mainWatch'];
    mergePosts?: CoordinatorDeps['mergePosts'];
    ciMetrics?: CoordinatorDeps['ciMetrics'];
    protection?: Protection;
    liveConfig?: CoordinatorDeps['liveConfig'];
    label?: string;
    watchdog?: (log: EventLog, intake: () => IntakeConfig | null) => {
        stop: () => void;
    };
    incidents?: IncidentSink;
    accountSwitched?: () => string | null;
    superfan?: CoordinatorDeps['superfan'];
}, runner?: AgentRunner, tokenExpiresAt?: string | null, tokens?: () => Promise<string>, commandsAs?: RunAs, appKeyPath?: string, commitIdentity?: CommitIdentity, autoMerge?: () => boolean, settings?: () => {
    settings: InstanceSettings;
    error: string | null;
}): Promise<number>;
/** A plain-text status summary from the event log (the dashboard reads the same log). */
export declare function status(root: string): string;

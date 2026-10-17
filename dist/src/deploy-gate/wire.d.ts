import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import type { IncidentSink } from '../usage-limit.js';
import { type PostDeployConfig } from './config.js';
import { DeployGate, type DeployRefs, type GateGit } from './gate.js';
import { PostDeploy } from './post-deploy.js';
type Fetch = typeof fetch;
/** The gate's git over the coordinator's clone: both branches fetched (the deploy branch only when it exists). */
export declare function gateGit(repo: string, remote: string, main: string, deploy: string): GateGit;
/** The deploy branch's ref writes through the App's token: a fast-forward (PATCH, force false) or its creation. */
export declare function githubDeployRefs(repo: string, branch: string, token: () => Promise<string>, f?: Fetch, api?: string): DeployRefs;
export interface DeployGateSetup {
    /** owner/name */
    repo: string;
    token: () => Promise<string>;
    api?: string;
    /** The instance: its secrets hold the host's token (secretsDir). Absent (a checkout): no token, no rollback. */
    instance?: string;
    /** The coordinator user's home, where the secrets are (tests); the process's own when unset. */
    secretsHome?: string;
    /** The host's GraphQL endpoint (tests point it at a fake); else Railway's. */
    hostApi?: string;
    /** The smoke checks' HTTP (tests). */
    http?: typeof fetch;
    /** The post-deploy check's poll and retry pauses (tests). */
    postDeployPollMs?: number;
    postDeployRetryMs?: number;
    postDeployNow?: () => number;
    /** GitHub's deployments of a commit (tests); else read with the App's token. */
    github?: (sha: string) => Promise<{
        total: number;
        success: number;
    } | null>;
}
/** The host token's file: the instance's secrets, 0400, for the coordinator user only (console/secrets.ts). */
export declare function hostTokenFile(instance: string, home?: string): string;
/** The stored host token, read now, or null. Never logged. */
export declare function readHostToken(file: string | null): string | null;
/**
 * The post-deploy check, for a gate with deploy_gate.post_deploy. Without a stored token it still smoke-tests and
 * alerts, and asks the owner once (a paste_secret ask in the setup console) for the token a rollback needs.
 */
export declare function postDeployFor(config: PostDeployConfig, branch: string, s: DeployGateSetup, d: {
    log: EventLog;
    actor: string;
    stateDir: string;
    incidents?: IncidentSink;
}, markFailed: (sha: string, reason: string) => void): PostDeploy;
/**
 * The gate, when tests.yaml has deploy_gate with `enabled: true` and the test runs are set up; else undefined (and,
 * when it is on but can't start, why, in the log). Off: nothing is built, so nothing runs, moves, checks or asks.
 */
export declare function setupDeployGate(cfg: Config, s: DeployGateSetup, d: {
    log: EventLog;
    actor: string;
    root: string;
    stateDir: string;
    remote?: string;
    testRunsReady: boolean;
    incidents?: IncidentSink;
}): DeployGate | undefined;
export {};

import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import type { IncidentSink } from '../usage-limit.js';
import { type PostDeployConfig } from './config.js';
import { type DeployHost } from './railway.js';
export type PostDeployEvent = EventPayload<'deploy_gate.post_deploy'>;
export interface PostDeployDeps {
    config: PostDeployConfig;
    /** The deploy branch's name (for the posts). */
    branch: string;
    host: DeployHost;
    /** Whether the host's token is stored now (read on every pass, so a token stored later is used). */
    hasToken: () => boolean;
    /** GitHub's deployments of a commit by the host's App (the cross-check); null when GitHub couldn't be asked. */
    github: (sha: string) => Promise<{
        total: number;
        success: number;
    } | null>;
    /** Mark a commit the gate must never move the deploy branch to again. */
    markFailed: (sha: string, reason: string) => void;
    log: EventLog;
    actor: string;
    stateDir: string;
    incidents?: IncidentSink;
    /** The smoke checks' HTTP (default fetch). */
    http?: typeof fetch;
    /** How often the host is asked while waiting for the deploy (default 30 s). */
    pollMs?: number;
    /** The pause before a check's retry (default 2 s). */
    retryMs?: number;
    now?: () => number;
}
export declare class PostDeploy {
    private d;
    private lastPoll;
    private running;
    private readonly stopped;
    constructor(d: PostDeployDeps);
    private get file();
    private read;
    private write;
    private now;
    /** The commit waiting for its check, if any. */
    get pending(): {
        sha: string;
        prev: string | null;
        since: number;
    } | null;
    /**
     * The deploy branch moved from `from` to `sha`: watch for the host's deploy of it. The rollback target is `from`,
     * unless `from` failed its own check: then the last commit that passed.
     */
    start(sha: string, from: string | null): void;
    /** One pass at most every pollMs while a commit is pending; the pass is not waited for. */
    step(): void;
    idle(): Promise<void>;
    stop(): void;
    /** Where each service's latest deployment is: deployed (all SUCCESS on the commit), dead, or waiting (and why). */
    private whereIsIt;
    private pass;
    /** One check: a GET with a timeout, one retry. Never sends a cookie or a credential; never follows a redirect. */
    private smoke;
    /** Each service back to its last served deployment of `prev`: the host's rollback, else a redeploy of it. */
    private rollBack;
    private finish;
}
/** A short, redacted piece of a failing response's body: one line, no cookie or session value, no secrets the redactor knows. */
export declare function snippet(body: string): string;
/** The ops post for a check that didn't pass (null for one that did). */
export declare function postDeployMessage(p: PostDeployEvent, repo: string, branch: string): string | null;

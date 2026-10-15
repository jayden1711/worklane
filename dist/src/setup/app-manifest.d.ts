import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Asks } from '../console/asks.js';
type Fetch = typeof fetch;
export type AppKind = 'agent' | 'signin';
/**
 * The agent App's permissions, exactly: what scripts/setup/app-permissions.mjs requires and expects, with checks
 * write. Never workflows, administration or actions write (that script refuses each).
 */
export declare const AGENT_APP_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>>;
export declare const MANIFEST_START_PATH = "/setup/app-manifest/start";
export declare const MANIFEST_CALLBACK_PATH = "/setup/app-manifest/callback";
/** How long a flow's state token lives: from registering to GitHub's redirect back. */
export declare const MANIFEST_STATE_MS: number;
/** An instance name, as add-project takes it. */
export declare const INSTANCE_NAME: RegExp;
/** A GitHub user or organization name. */
export declare const GITHUB_LOGIN: RegExp;
/** The machine's user names, as scripts/setup/lib.sh makes them: wl-<name> (coordinator), wl-dash (the hub). */
export declare const coordinatorUser: (instance: string) => string;
export declare const VIEWER_USER = "wl-dash";
export declare function validRepo(repo: unknown): repo is string;
/** `<name>-<cli>` for the agent App, `<name>-<cli>-signin` for the sign-in App, within GitHub's 34 characters. */
export declare function appBaseName(instance: string, kind: AppKind): string;
/**
 * The base name, or, when GitHub already has an App by that name, the base with a short random suffix. Only public
 * Apps are visible here; GitHub's own form still refuses a taken private name, and lets the owner edit it there.
 */
export declare function availableAppName(base: string, o?: {
    api?: string;
    fetch?: Fetch;
    suffix?: () => string;
}): Promise<string>;
export interface AppManifest {
    name: string;
    url: string;
    hook_attributes: {
        url: string;
        active: false;
    };
    redirect_url: string;
    callback_urls?: string[];
    public: false;
    default_permissions: Record<string, string>;
    default_events: [];
}
/**
 * The manifest: private, no webhook (inactive), no events. The agent App gets exactly AGENT_APP_PERMISSIONS; the
 * sign-in App none, and the hub's sign-in callback.
 */
export declare function appManifest(o: {
    kind: AppKind;
    name: string;
    repo: string;
    publicUrl: string;
}): AppManifest;
/** Where the manifest is posted: the user's App settings, or the organization's. */
export declare function manifestTarget(owner: string, ownerType: 'User' | 'Organization', state: string, web?: string): string;
/** The page that posts the manifest to GitHub: one button, so nothing happens without the owner. */
export declare function manifestPage(m: AppManifest, target: string): string;
/** GitHub's install page for the App, preselecting the one repo when its ids are known. */
export declare function installUrl(slug: string, ids: {
    ownerId: number;
    repoId: number | null;
} | null, web?: string): string;
/** What GitHub's conversion returns that the runner needs. pem, clientSecret and webhookSecret are secrets. */
export interface ConvertedApp {
    id: number;
    slug: string;
    clientId: string;
    clientSecret: string;
    pem: string;
    /** GitHub's webhook secret for the App, when it made one (the manifest's webhook is inactive, so it may not). */
    webhookSecret: string | null;
    owner: string;
    htmlUrl: string;
}
/** Exchange the manifest code (one use, an hour) for the App's credentials. Errors carry the status only. */
export declare function convertManifest(code: string, o?: {
    api?: string;
    fetch?: Fetch;
}): Promise<ConvertedApp>;
export type FlowStatus = 'pending' | 'converting' | 'done' | 'delivered' | 'refused' | 'expired';
/** What the runner collects: the App, once, when done; otherwise where the flow is. */
export type FlowView = {
    status: 'done';
    by: string;
    app: ConvertedApp;
} | {
    status: Exclude<FlowStatus, 'done'>;
    error: string | null;
};
export interface Registered {
    id: string;
    name: string;
    /** The page to open (the approve link): it posts the manifest to GitHub. */
    startUrl: string;
    expiresAt: string;
}
export interface ManifestFlowsOptions {
    /** Whether a GitHub login is a machine owner (src/machine-owners.ts). */
    isMachineOwner: (login: string) => boolean;
    /** Whether the hub has sign-in: without it, only a sign-in App's flow can finish (on its state alone). */
    signIn: boolean;
    /** The hub's https origin as browsers reach it, when it knows it (sign-in set up). */
    publicUrl: string | null;
    api?: string;
    web?: string;
    fetch?: Fetch;
    now?: () => number;
}
export declare class ManifestFlows {
    private readonly o;
    private readonly flows;
    private readonly now;
    constructor(o: ManifestFlowsOptions);
    /** Register a flow for the runner (break-glass only): its manifest, a fresh state token, and the page to open. */
    register(input: {
        kind?: unknown;
        instance?: unknown;
        repo?: unknown;
        owner?: unknown;
        publicUrl?: unknown;
    }): Promise<Registered>;
    /** Whether `login` may open or finish this flow; null when they may, otherwise why not (and the status to answer with). */
    private refusal;
    private expire;
    private settle;
    /** The start page for a flow (GET, the approve link). */
    page(id: string, login: string | null): {
        status: number;
        type: 'html' | 'text';
        body: string;
        formAction?: string;
    };
    /**
     * GitHub's redirect back: the state must name a pending flow (used up on the first try, even a refused one), not
     * yet expired, and the person must be a machine owner. Then the code is exchanged, and the App held for the runner.
     */
    callback(state: string | null, code: string | null, login: string | null): Promise<{
        status: number;
        body: string;
    }>;
    /** The runner's view of a flow, waiting up to `ms` for a change. The App is handed over once, then forgotten. */
    wait(id: string, ms: number): Promise<FlowView | null>;
}
export declare class FlowError extends Error {
}
/** The hub's public routes (the start page and GitHub's redirect back); false when the path isn't one. */
export declare function handleManifestPublic(req: IncomingMessage, res: ServerResponse, url: URL, flows: ManifestFlows, login: string | null): Promise<boolean>;
/**
 * The runner's routes, on the break-glass port only (after its token check):
 *   POST /api/setup/app-manifest          {kind, instance, repo, publicUrl?}: register a flow
 *   GET  /api/setup/app-manifest/<id>     ?wait=<ms>: where it is; the App, once, when done
 */
export declare function handleManifestBreakGlass(req: IncomingMessage, res: ServerResponse, url: URL, flows: ManifestFlows): Promise<boolean>;
/** How the runner reaches the hub's pending flows. */
export interface HubLink {
    register(o: {
        kind: AppKind;
        instance: string;
        repo: string;
        publicUrl?: string;
    }): Promise<Registered>;
    wait(id: string, ms: number): Promise<FlowView>;
}
/** The hub over its break-glass port (loopback, with the hub's token, which root can read). */
export declare function breakGlassHub(o: {
    base: string;
    token: string;
    fetch?: Fetch;
}): HubLink;
/** An approve link for the owner, as the console or the terminal shows it. */
export interface ApproveLink {
    title: string;
    detail: string;
    url: string;
}
export interface RunDeps {
    hub: HubLink;
    api?: string;
    web?: string;
    fetch?: Fetch;
    /** The users secrets go to; wl-<name> and wl-dash by default. */
    users?: {
        coordinator?: string;
        viewer?: string;
    };
    homeOf?: (user: string) => string | null;
    installSecret?: (user: string, dir: string, name: string, value: string) => string;
    /** The same check as credentials.sh: app-permissions.mjs, as the coordinator user. */
    verify?: (o: {
        user: string;
        key: string;
        appId: number;
        installationId: number;
        repo: string;
    }) => Promise<{
        ok: boolean;
        output: string;
    }>;
    /** Show an approve link; returns its ask id when it is an ask. */
    onAsk?: (a: ApproveLink) => string | undefined;
    /** The step behind an ask is done (by whom). */
    onDone?: (askId: string, by: string) => void;
    /** The step behind an ask failed or timed out. */
    onFail?: (askId: string, why: string) => void;
    log?: (line: string) => void;
    /** How long to wait for each GitHub click; 15 minutes by default. */
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
}
export type RunResult = {
    ok: true;
    kind: AppKind;
    appId: number;
    slug: string;
    clientId: string;
    by: string;
    installationId?: number;
    keyPath?: string;
    credentials?: string | null;
    secretPath?: string;
} | {
    ok: false;
    step: string;
    error: string;
};
/** The agent App's secret files in its key directory: the key (credentials.sh's name), and the two other secrets. */
export declare const AGENT_SECRET_FILES: Readonly<{
    key: "private-key.pem";
    clientSecret: "client-secret";
    webhookSecret: "webhook-secret";
}>;
/** credentials.sh's paths, on top of a user's home. */
export declare const agentKeyDir: (home: string, instance: string) => string;
export declare const signInDir: (home: string) => string;
export declare const credentialsFile: (home: string, instance: string) => string;
export declare const APP_PERMISSIONS_SCRIPT: string;
/**
 * Run app-permissions.mjs as `user` (sudo when that isn't this user); it asks GitHub itself (its host is a constant
 * in the script). Its output names no secret. `node` is for a test's stand-in only: extra node arguments and
 * environment for the child, so a test can give that process a GitHub on its own machine; `spawn` is a test's too.
 */
export declare function verifyWithScript(opts?: {
    script?: string;
    node?: {
        args?: string[];
        env?: Record<string, string>;
    };
    spawn?: typeof spawn;
}): NonNullable<RunDeps['verify']>;
/**
 * The whole manifest flow for one App, headless: register with the hub, show the approve link, collect the App,
 * store its secret for its one user, and, for the agent App, the install link, the installation, the check and
 * credentials.yaml. Stops at the first failure, naming the step.
 */
export declare function runAppManifest(o: {
    instance: string;
    repo: string;
    kind: AppKind;
    publicUrl?: string;
}, d: RunDeps): Promise<RunResult>;
/**
 * The same flow from the setup console: each GitHub click is an approve_link ask in `asks`, answered (approved, by
 * the machine owner who did it) once GitHub confirms it, or withdrawn when the step fails. Returns the first ask's id
 * as soon as it exists, and the whole run.
 */
export declare function startAppManifest(o: {
    instance: string;
    repo: string;
    kind: AppKind;
    publicUrl: string;
}, d: RunDeps & {
    asks: Asks;
}): Promise<{
    askId: string;
    done: Promise<RunResult>;
}>;
export {};

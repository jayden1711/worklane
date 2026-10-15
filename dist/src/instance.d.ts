import { z } from 'zod';
import { type Config, type ConfigError } from './config/load.js';
import type { RunAs } from './runner.js';
import { sandboxSettings } from './sandbox.js';
export declare const InstanceFile: z.ZodObject<{
    version: z.ZodLiteral<1>;
    name: z.ZodString;
    repos: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        repo: z.ZodString;
    }, z.core.$strict>>;
    commit_identity: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        email: z.ZodString;
    }, z.core.$strict>>;
    run_as: z.ZodOptional<z.ZodObject<{
        agent_user: z.ZodString;
        agent_home: z.ZodString;
        claude_config_dir: z.ZodOptional<z.ZodString>;
        eval_user: z.ZodOptional<z.ZodString>;
        eval_home: z.ZodOptional<z.ZodString>;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/**
 * The operator's settings for this instance: each one set here wins over the repo's value (which is the
 * default when it's absent). Bounds come from the machine's limits file; see settings.ts.
 */
export declare const InstanceSettings: z.ZodObject<{
    workers: z.ZodOptional<z.ZodNumber>;
    daily_budget_usd: z.ZodOptional<z.ZodNumber>;
    ci_repair: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        max_fixes_per_pr: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    run_windows: z.ZodOptional<z.ZodArray<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>>>;
    research: z.ZodOptional<z.ZodObject<{
        max_searches_per_day: z.ZodOptional<z.ZodNumber>;
        max_fetches_per_day: z.ZodOptional<z.ZodNumber>;
        max_usd_per_day: z.ZodOptional<z.ZodNumber>;
        repo_access: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    model_cap: z.ZodOptional<z.ZodEnum<{
        haiku: "haiku";
        sonnet: "sonnet";
        opus: "opus";
    }>>;
    providers: z.ZodOptional<z.ZodObject<{
        local: z.ZodOptional<z.ZodBoolean>;
        hosted: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cli: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            codex: "codex";
            gemini: "gemini";
        }>>>;
    }, z.core.$strict>>;
    eval_routing: z.ZodOptional<z.ZodObject<{
        cheap_model: z.ZodOptional<z.ZodString>;
        cheap_levels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            L0: "L0";
            L1: "L1";
            L2: "L2";
            L3: "L3";
        }>>>;
        escalate: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    stuck_guard: z.ZodOptional<z.ZodEnum<{
        off: "off";
        "dry-run": "dry-run";
        on: "on";
    }>>;
    intake: z.ZodOptional<z.ZodObject<{
        reports_per_sender_per_day: z.ZodOptional<z.ZodNumber>;
        drafts_per_day: z.ZodOptional<z.ZodNumber>;
        max_usd_per_day: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type InstanceSettings = z.infer<typeof InstanceSettings>;
export declare const PolicyFile: z.ZodObject<{
    version: z.ZodLiteral<1>;
    budget: z.ZodObject<{
        daily_usd: z.ZodNumber;
    }, z.core.$strict>;
    agents: z.ZodPrefault<z.ZodObject<{
        max_workers: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    land_mode: z.ZodDefault<z.ZodEnum<{
        pr: "pr";
        direct: "direct";
    }>>;
    auto_merge: z.ZodDefault<z.ZodBoolean>;
    main_watch: z.ZodDefault<z.ZodEnum<{
        off: "off";
        auto: "auto";
    }>>;
    settings: z.ZodDefault<z.ZodObject<{
        workers: z.ZodOptional<z.ZodNumber>;
        daily_budget_usd: z.ZodOptional<z.ZodNumber>;
        ci_repair: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            max_fixes_per_pr: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        run_windows: z.ZodOptional<z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, z.core.$strict>>>;
        research: z.ZodOptional<z.ZodObject<{
            max_searches_per_day: z.ZodOptional<z.ZodNumber>;
            max_fetches_per_day: z.ZodOptional<z.ZodNumber>;
            max_usd_per_day: z.ZodOptional<z.ZodNumber>;
            repo_access: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        model_cap: z.ZodOptional<z.ZodEnum<{
            haiku: "haiku";
            sonnet: "sonnet";
            opus: "opus";
        }>>;
        providers: z.ZodOptional<z.ZodObject<{
            local: z.ZodOptional<z.ZodBoolean>;
            hosted: z.ZodOptional<z.ZodArray<z.ZodString>>;
            cli: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                codex: "codex";
                gemini: "gemini";
            }>>>;
        }, z.core.$strict>>;
        eval_routing: z.ZodOptional<z.ZodObject<{
            cheap_model: z.ZodOptional<z.ZodString>;
            cheap_levels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                L0: "L0";
                L1: "L1";
                L2: "L2";
                L3: "L3";
            }>>>;
            escalate: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        stuck_guard: z.ZodOptional<z.ZodEnum<{
            off: "off";
            "dry-run": "dry-run";
            on: "on";
        }>>;
        intake: z.ZodOptional<z.ZodObject<{
            reports_per_sender_per_day: z.ZodOptional<z.ZodNumber>;
            drafts_per_day: z.ZodOptional<z.ZodNumber>;
            max_usd_per_day: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    allow_same_user: z.ZodDefault<z.ZodBoolean>;
    sandbox: z.ZodDefault<z.ZodBoolean>;
    lanes: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        allowed_domains: z.ZodDefault<z.ZodArray<z.ZodString>>;
        run_as: z.ZodDefault<z.ZodEnum<{
            eval: "eval";
            agent: "agent";
        }>>;
    }, z.core.$strict>>>;
    network_allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    pre_approved: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const CredentialsFile: z.ZodObject<{
    version: z.ZodLiteral<1>;
    github: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"gh-config-dir">;
        path: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"app">;
        app_id: z.ZodNumber;
        installation_id: z.ZodNumber;
        key_path: z.ZodString;
    }, z.core.$strict>], "kind">;
    claude: z.ZodOptional<z.ZodObject<{
        config_dir: z.ZodString;
    }, z.core.$strict>>;
    eval_key: z.ZodOptional<z.ZodString>;
    agent_api_key: z.ZodOptional<z.ZodString>;
    provider_keys: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    intake: z.ZodOptional<z.ZodObject<{
        discord_token: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type PolicyFile = z.infer<typeof PolicyFile>;
export type CredentialsFile = z.infer<typeof CredentialsFile>;
export interface Instance {
    name: string;
    runAs: {
        user: string;
        home: string;
        claudeConfigDir?: string;
        path?: string;
    } | null;
    /** Set in instance.yaml; otherwise resolved at start (the App's bot identity). */
    commitIdentity?: {
        name: string;
        email: string;
    };
    evalAs: {
        user: string;
        home: string;
        path?: string;
    } | null;
    home: string;
    stateDir: string;
    repo: {
        path: string;
        repo: string;
    };
    policy: PolicyFile;
    credentials: CredentialsFile;
    /** The repo's config, checked against the policy. */
    config: Config;
}
export declare function instancesDir(): string;
/** Every way the repo's config loosens the instance policy. A repo may only tighten it. */
export declare function policyViolations(cfg: Config, policy: PolicyFile): ConfigError[];
/** What an instance requires of its repo's config beyond the schema: its own repo, and only tightening its policy. */
export declare function instanceConfigProblems(config: Config, repo: string, policy: PolicyFile): ConfigError[];
/** Load an instance and its repo config. Throws ConfigInvalid listing every problem, including any loosening. */
export declare function loadInstance(instanceName: string, dir?: string): Instance;
/**
 * Credential references must point at something before a coordinator starts.
 * Missing means refuse to start; there is no fallback to anyone's own login.
 */
export declare function credentialProblems(c: CredentialsFile): string[];
/** Everything an instance needs on this machine before it starts: its credentials, and the agent user it runs agents as. */
export declare function instanceProblems(i: Instance): string[];
/** A policy file on its own, e.g. a copy of an instance's, to check a repo config against. */
export declare function readPolicy(file: string): {
    policy: PolicyFile | undefined;
    errors: ConfigError[];
};
/**
 * The policies of the instances on this machine that run a repo (owner/name),
 * so a change to its config can be checked against them before it merges.
 * Instances this user can't read are skipped.
 */
export declare function policiesForRepo(repo: string, dir?: string): {
    name: string;
    policy: PolicyFile | undefined;
    errors: ConfigError[];
}[];
export declare function listInstances(dir?: string): string[];
/** Create an instance home with skeleton files, readable only by its owner. Credentials stay placeholders to fill in. */
/** How a user's home is found (the OS user database); tests replace it. */
export declare let resolveHome: (user: string) => string | null;
export declare function setResolveHome(f: (user: string) => string | null): void;
export declare function initInstance(instanceName: string, repoPath: string, repo: string, dir?: string, agentUser?: string, agentHome?: string): string;
/**
 * How each lane runs: as which user, and inside which sandbox. Agent commands
 * may never read the coordinator's instance home, credential stores in the
 * running user's home, or that user's Claude login file; lanes other than
 * the eval user's may not read the eval key either.
 */
export declare function laneRuns(i: Instance): Record<string, {
    runAs?: RunAs;
    settings?: ReturnType<typeof sandboxSettings>;
}>;
/** A research lane's settings: Read/Glob/Grep deny rules, the research-mode hook, and the sandbox when the policy has it on. */
export interface ResearchLaneSettings {
    permissions: {
        deny: string[];
    };
    hooks?: object;
    /** Pinned for the run's hooks (the chat lane's root). */
    env?: Record<string, string>;
    sandbox?: ReturnType<typeof sandboxSettings>['sandbox'];
}
/**
 * The two research lanes, as the default lane's user. `research` (no repo access) denies every read of the checkout
 * (and so its worktrees), and of the instance's task and chat files, in the sandbox and in Read rules, and adds the
 * engine's hook in research mode, which refuses any file read outside the research bundles: its working directory
 * is a bundle with no project settings, so the project's own hook doesn't run there. `research-repo` may read
 * the repo like any agent. Both get their settings whether or not the policy's sandbox is on.
 */
export declare function researchLanes(i: Instance, base: {
    runAs?: RunAs;
} | undefined): Record<string, {
    runAs?: RunAs;
    settings: ResearchLaneSettings;
    ownHooks?: boolean;
}>;
/** Only an instance's credential references: for the git credential helper, which must work before the repo is cloned. */
export declare function loadInstanceCredentials(instanceName: string, dir?: string): {
    stateDir: string;
    repos: string[];
    credentials: CredentialsFile;
};
/** An instance-file problem as one line (ConfigInvalid's own message starts with the repo config's heading). */
export declare const instanceFilesProblem: (e: unknown) => string;
/**
 * An instance's setup, before its repo has a config: where its checkout is and who its agents run as, with its
 * credential references and policy. Server auto-config needs it (src/server-auto-config.ts); loadInstance needs the
 * repo config too.
 */
export declare function loadInstanceSetup(instanceName: string, dir?: string): {
    home: string;
    stateDir: string;
    repo: {
        path: string;
        repo: string;
    };
    credentials: CredentialsFile;
    policy: PolicyFile;
    runAs: RunAs | null;
};
/** How an instance's GitHub App was made, as its setup recorded it (beside the App's key): the manifest flow, or by hand. */
export type AppOrigin = 'manifest' | 'by-hand';
export declare const appOriginText: (o: AppOrigin | null) => "made through the manifest flow" | "made by hand (credentials.sh github-app)" | "how it was made is not recorded";
export declare function readAppOrigin(keyPath: string): AppOrigin | null;
/**
 * Point an instance's credentials.yaml at its GitHub App, keeping its other settings, validated against the schema
 * before anything is written (0600, renamed into place), and record how the App was made beside its key. The one
 * writer of the App entry: credentials.sh github-app (`instance set-github-app`) and the manifest flow both come here.
 */
export declare function setGithubApp(file: string, app: {
    appId: number;
    installationId: number;
    keyPath: string;
}, origin: AppOrigin): void;
/**
 * Point an instance's credentials.yaml at its chat bot's token file (intake.discord_token), keeping its other
 * settings, validated against the schema before anything is written (0600, renamed into place). The one writer of
 * that entry: credentials.sh intake-discord (`instance set-discord-token`) and the dashboard's pasted token both come
 * here. Only the file's path: the token is never read here. Refused: a path that isn't absolute, isn't a plain file,
 * or that its group or others can read (the token is the coordinator user's alone).
 */
export declare function setDiscordToken(file: string, tokenFile: string): void;

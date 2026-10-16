import { type ExpSite } from './experiments/view.js';
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AvatarOptions } from './avatars.js';
import { type Config } from './config/load.js';
import { type GitRun } from './checkout-sync.js';
import type { StoredEvent } from './events/types.js';
import { type AcceptGit, type AcceptTarget } from './main-watch.js';
import { type ChatAnswerFile } from './chat.js';
import { type AttachmentCaps } from './chat-attachments.js';
import { mayAnswer, type Backlog } from './backlog/types.js';
import { type EmergencyStop } from './slots.js';
import { type ServiceSpec } from './os/index.js';
import { type MachineStats, type ProcessGroupUsage } from './os/stats.js';
import { type MachineRequest } from './machine-requests.js';
import { type UpdatesDrain } from './updates.js';
import { type SettingKey } from './settings.js';
import { type Role, type RoleOf, type SessionOf } from './dashboard-auth.js';
import { type SetupContext, type SetupProbe } from './setup-steps.js';
/** The steps skipped on the first-run page, in the dashboard's state dir. */
export declare const SKIPS_FILE = "first-run-skips.json";
import { type Run as SetupRun } from './setup-mode.js';
import type { InitIo } from './init.js';
import { type ActionDeps } from './setup-actions.js';
import { type SigninDeps } from './claude-signin.js';
import { type GhLoginDeps } from './gh-login.js';
import { type DiscordListingStandIn } from './intake/discord-setup.js';
import { type TailscaleStatus } from './tailscale-setup.js';
/**
 * What the Settings page shows: the config's shape and choices, read-only.
 * Commands, connection fingerprints and deploy details stay out; editing
 * happens in the project's config folder, through review like any change.
 */
/** The settings as a viewer (read on the repo) sees them: the project part the Settings page shows them, nothing else. */
/** The disk floor on this machine now (src/governor-holds.ts), as doctor checks it: Settings' and First run's numbers; null when it can't be measured. */
export declare function diskFloorNow(o: Pick<DashboardOptions, 'root' | 'cfg'>, measure?: (path: string) => {
    freeGb: number;
    totalGb: number;
}): {
    level: "ok" | "warn";
    detail: string;
    room: import("./governor-holds.js").DiskRoom;
} | null;
export declare function settingsForViewer(cfg: Config): {
    configDir: ".worklane";
    project: {
        name: string;
        repo: string;
        landMode: "pr" | "direct";
        runtime: {
            kind: "cli" | "api_key";
            max_concurrency: number;
            run_windows: {
                from: string;
                to: string;
            }[];
        };
        ci: {
            kind: "none";
            means: string;
        } | {
            kind: "github";
            means: null;
        };
    };
    owners: {
        default: string;
        writers: string[];
        areas: {
            name: string;
            owner: string;
            paths: string[];
            labels: string[];
        }[];
    };
    reports: {
        times: string[];
        to: string[];
    };
    forViewer: true;
};
/** WHY: the dashboard's cfg is the repo's; the panel shows what runs, so the instance's settings go over it (item 32). */
export declare function routingInEffect(o: Pick<DashboardOptions, 'policyFile' | 'cfg'>): {
    task: string;
    key: "research" | "chat" | "build" | "planner" | "intake_triage" | "intake_replier" | "intake_summary" | "intake_thread" | "stage_judge" | "eval_answer" | "build_high_risk" | "high_risk_labels" | "escalate_after" | "reflection" | "eval_cheap" | "eval_cheap_levels" | "eval_escalate" | "eval_cross_family";
    value: string | number | boolean | string[] | import("./review.js").Level[];
    from: string | null;
}[];
export declare function settingsView(cfg: Config, routing?: {
    task: string;
    key: "research" | "chat" | "build" | "planner" | "intake_triage" | "intake_replier" | "intake_summary" | "intake_thread" | "stage_judge" | "eval_answer" | "build_high_risk" | "high_risk_labels" | "escalate_after" | "reflection" | "eval_cheap" | "eval_cheap_levels" | "eval_escalate" | "eval_cross_family";
    value: string | number | boolean | string[] | import("./review.js").Level[];
    from: string | null;
}[]): {
    configDir: ".worklane";
    project: {
        name: string;
        repo: string;
        landMode: "pr" | "direct";
        runtime: {
            kind: "cli" | "api_key";
            max_concurrency: number;
            run_windows: {
                from: string;
                to: string;
            }[];
        };
        ci: {
            kind: "none";
            means: string;
        } | {
            kind: "github";
            means: null;
        };
    };
    owners: {
        default: string;
        writers: string[];
        areas: {
            name: string;
            owner: string;
            paths: string[];
            labels: string[];
        }[];
    };
    reports: {
        times: string[];
        to: string[];
    };
    governor: {
        min_free_disk_pct: number;
        min_free_disk_gb: number;
        max_load?: number | undefined;
    };
    agents: {
        budget: number;
        roles: {
            name: string;
            enabled: boolean;
            model: string;
            count: number | null;
        }[];
    };
    routing: {
        task: string;
        key: "research" | "chat" | "build" | "planner" | "intake_triage" | "intake_replier" | "intake_summary" | "intake_thread" | "stage_judge" | "eval_answer" | "build_high_risk" | "high_risk_labels" | "escalate_after" | "reflection" | "eval_cheap" | "eval_cheap_levels" | "eval_escalate" | "eval_cross_family";
        value: string | number | boolean | string[] | import("./review.js").Level[];
        from: string | null;
    }[];
    tests: {
        gates: {
            land: string[];
            money_path: string[];
            nightly: string[];
        };
        batchMax: number;
        nightlyAt: string | null;
        tiers: string[];
        baselineParser: boolean;
    };
    review: {
        levels: {
            [k: string]: string[];
        };
    } | null;
    guardrails: {
        rules: number;
        protectedPaths: string[];
        secretPaths: number;
        network: string;
        preApproved: string[];
    };
    deploy: {
        environments: {
            name: string;
            production: boolean;
        }[];
        prodRead: boolean;
    } | null;
};
/** The updater's drain in force now (src/update-drain.ts), with what is still finishing; null when none. Read-only. */
export declare function drainView(dir?: string, now?: number): UpdatesDrain | null;
export interface DashboardOptions {
    root: string;
    cfg: Config;
    /** The disk's free and total GB at a path, for the disk floor's numbers (tests stand in for it); absent: the real one. */
    diskFree?: (path: string) => {
        freeGb: number;
        totalGb: number;
    };
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
    /** Root's network grants (src/testrun/network.ts), for tests; default /etc/<cli>/testrun-network.json, root's. */
    networkFile?: string;
    networkFileUid?: number;
    testRunLock?: string;
    /** The instance's policy file (its auto-merge kill switch and settings); none for a checkout. */
    policyFile?: string | null;
    /** The instance's automations.yaml (in its home): Extend -> Automations reads and, through Review -> Confirm, writes it. None: a checkout (no automations). */
    automationsFile?: string;
    /** Extend -> Experiments: the instance's checkout, default branch, name and pins file (server mode only). None: no experiments here. */
    experiments?: ExpSite;
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
    machine?: {
        changesPath?: string;
        updatesConfigPath?: string;
        updatesLogPath?: string;
        updatesStatePath?: string;
        enginePath?: string;
        signersPath?: string;
        pendingSignersPath?: string;
        helperRulesPath?: string;
    };
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
    startService?: (spec: ServiceSpec) => {
        path: string;
        started: boolean;
        detail: string;
    };
    /** WHY: tests stand in for the checkout's git (src/checkout-sync.ts); git in the checkout when unset. */
    checkoutGit?: GitRun;
    /** WHY: tests stand in for what the first-run page's Fix actions do to the machine (src/setup-actions.ts). */
    setupActions?: Partial<ActionDeps>;
    /** WHY: tests stand in for claude auth login and claude auth status (src/claude-signin.ts). */
    claudeSignin?: Partial<SigninDeps>;
    /** WHY: a checkout with no config yet (src/setup-mode.ts): the first-run page alone; tests stand in for its commands. */
    setupMode?: {
        run?: SetupRun;
        io?: InitIo;
    };
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
{
    kind: 'local';
    label: string;
    file: string;
    manager: string;
    commands: string[];
    program: string[];
    log: string;
}
/** A server instance: nothing here may start it; the command an owner runs, and why. */
 | {
    kind: 'owner-command';
    unit: string;
    command: string;
    why: string;
} | {
    kind: 'unsupported';
    why: string;
};
export declare function firstRunStart(o: {
    root: string;
    cfg: Config;
    instance?: string | null;
    setupMode?: unknown;
}): FirstRunStart;
/**
 * The emergency stop as the dashboard shows it, read-only: whether one is in
 * force on this machine now (the STOP file), and whether this instance's
 * coordinator has halted for it (its own emergency.stop event since then).
 */
export declare function stopStatus(inForce: EmergencyStop | null, record: {
    lastStop: {
        at: string;
        by: string;
        reason: string;
        running: number;
    } | null;
    lastResume: string | null;
}): {
    inForce: EmergencyStop | null;
    /** This coordinator acknowledged it: halted its agents (how many were running) and starts none. */
    halted: {
        at: string;
        running: number;
    } | null;
    lastStop: {
        at: string;
        by: string;
        reason: string;
        running: number;
    } | null;
    lastResume: string | null;
};
export { mayAnswer };
/** What a slot or lock held by anyone but this instance shows as: that it is held, never by whom or for what. */
export declare const ELSEWHERE = "another instance or job on this machine";
/**
 * The machine's slot and lock holders as one instance's dashboard may show them. The slots are shared by every
 * instance on the machine, and a holder's owner names its project, issue or run; so only this instance's own
 * holders keep it (its agent slots and land gate, `<cli> <project> ...`; its test slots, `<actor> ...`). Any
 * other holder is counted, with its slot and since when, as held elsewhere: no owner, no pid. Fails closed: a
 * holder that doesn't name this instance is someone else's.
 */
export declare function ownHolders(o: {
    project: string;
    actor: string;
}): <T extends {
    owner: string;
    acquiredAt: string;
    pid?: number;
}>(h: T) => T | ({
    owner: string;
    acquiredAt: string;
    elsewhere: true;
} & Omit<T, "owner" | "pid">);
/** Who is asking: a signed-in person the hub named (their role read from the repo), or the owner's break-glass. */
export interface Who {
    login: string;
    role: Role;
    via: 'session' | 'break-glass';
    /** Whether the hub identified this request's device as an allowed console device (a write's only; false for the break-glass). */
    deviceOk: boolean;
}
/**
 * The session behind a request on an instance's dashboard, once the server has resolved it (after the token
 * check): the person and their role from the repo, the hub's sign-in time. CSRF is the hub's to check (it
 * refuses a write without the session's token before forwarding), and the break-glass is a bearer token, not
 * a cookie, so csrfOk is true for any request that got here. Null before or without that.
 */
export declare const dashboardSession: SessionOf;
/** Who may read the next report's preview (spend, and the throughput section): the instance's owners and writers. */
export declare const mayReadReports: (role: Role | null | undefined) => role is "owner" | "writer";
/** Who may read intake reports (redacted, but people's words): the instance's owners and writers. */
export declare const mayReadIntake: (role: Role | null | undefined) => role is "owner" | "writer";
/** Who may read throughput (what runs cost, where PRs waited): the instance's owners and writers. */
export declare const mayReadThroughput: (role: Role | null | undefined) => role is "owner" | "writer";
/** Who may read what waits on the owner (the digest): the instance's owners and writers. */
export declare const mayReadDigest: (role: Role | null | undefined) => role is "owner" | "writer";
/**
 * Who may read agent runs (every route under /api/runs: a run's record, its live feed, a research run's
 * searches and pages): the instance's owners and writers. Writing to a run (a console message, a stop)
 * stays the owner's alone, checked on those routes as well.
 */
export declare const mayReadRuns: (role: Role | null | undefined) => role is "owner" | "writer";
/**
 * Every path that serves agent runs, which the run-reading gate covers whatever route is added there:
 * everything under /api/runs, the list of live runs (/api/live), and the Board's Watch (/api/board/watch/<run>).
 */
export declare const isRunsPath: (pathname: string) => boolean;
/**
 * A page of the engine's docs on its public repository, from package.json (docs aren't in the package);
 * null when the package names no https repository.
 */
export declare function docsUrl(page: string, repository?: unknown): string | null;
/**
 * The options a site's own dashboard starts with (cli.ts `dashboard`): its log, state, policy, intake and automations
 * files, backlog and roles. INVARIANT: one list, so an instance's file reaches its dashboard's routes (#522: the
 * automations file did not, and Extend said "a checkout" on every instance).
 */
export declare function siteOptions(site: ReturnType<typeof dashboardSite>): {
    automationsFile?: string;
    intakeFile?: string;
    roleOf?: RoleOf;
    root: string;
    logs: LogSource;
    policyFile: string | null;
    backlog: () => Backlog;
    eventsDb: string;
    stateDir: string;
};
/**
 * Which log and state a dashboard reads. A project checkout's own, or, with
 * an instance, that instance's: run it as the instance's coordinator user,
 * the only user that can read (and, for answers, write) the instance's log.
 */
export declare function dashboardSite(root: string, instance?: string, dir?: string): {
    root: string;
    cfg: Config;
    eventsDb: string;
    stateDir: string;
    port: number;
    logs: LogSource;
    policyFile: string | null;
    backlog: () => Backlog;
    roleOf?: RoleOf;
    intakeFile?: string;
    automationsFile?: string;
    experiments?: ExpSite;
};
/**
 * A chat answer as this dashboard's user may see it: the owner gets it whole; anyone else the answer and its
 * citations, never a draft or a proposal (the coordinator answers them read-only already; this holds it here too).
 */
export declare function chatAnswerFor(f: ChatAnswerFile, owner: boolean): ChatAnswerFile;
/**
 * What the health view reads: the OS adapter's snapshot of the machine, the
 * harness's slice and this instance's service (when there is one), and the
 * volumes of the checkout and the state dir.
 */
export declare function healthStats(o: {
    serviceUnit: string | null;
    root: string;
    stateDir: string;
}): MachineStats;
/**
 * The machine-wide settings as the Settings page shows them: the agent slot cap now (and its bounds), whether
 * engine updates are on (null when the updater isn't set up here), who may change them, and their history:
 * the helper's change log and the updater's log, newest first.
 */
export declare function machineView(o: Pick<DashboardOptions, 'cfg' | 'user' | 'slotsDir' | 'machine' | 'machineOwnersFile'> & {
    role?: Role | null;
    breakGlass?: boolean;
    deviceOk?: boolean;
    requests?: MachineRequest[];
}): {
    owner: string;
    user: string;
    /** The machine's owners (src/machine-owners.ts): only they (or the break-glass) may change these. */
    machineOwners: string[];
    /** Whether this person is one of them (true on the break-glass). */
    machineOwner: boolean;
    /** An instance owner who is a machine owner; the server checks the device again on each change. */
    canChange: boolean;
    /** What a change needs besides, for the page to say (nothing on the break-glass). */
    needs: string | null;
    /** Whether this request came from one (the hub says, on this view's read as on a change; always on the break-glass). */
    deviceReady: boolean;
    helper: string;
    slots: {
        cap: number;
        running: number;
        min: number;
        max: number;
    };
    testSlots: {
        cap: number;
        running: number;
        min: number;
        max: number;
    };
    updates: {
        configured: true;
        enabled: boolean;
        branch: string;
        requiredChecks: string[];
    } | {
        configured: false;
        enabled: null;
        branch?: never;
        requiredChecks?: never;
    };
    /** The updater's setup (src/updater-setup.ts): installed or not, its channel, the release signers listed, and the same steps as a script. */
    updater: import("./updater-setup.js").UpdaterSetup;
    changes: import("./machine.js").MachineChange[];
    history: import("./updates.js").UpdateEntry[];
    /** Changes asked for here, for the coordinator to run: pending, running, then done, failed, refused or interrupted. Newest first. */
    requests: MachineRequest[];
};
/** The runs live now, for the Agents page; their held messages' text only for the owner, who may control them. */
export declare function liveView(o: Pick<DashboardOptions, 'stateDir' | 'cfg' | 'user'> & {
    role?: Role | null;
}): {
    owner: string;
    canControl: boolean;
    runs: {
        pending: import("./console.js").PendingMessage[];
        run: string;
        issue: number | null;
        role: string;
        model: string;
        startedAt: string;
    }[];
};
/**
 * What the run page's console needs: whether the run is live, whether this user may message it (the owner and the
 * writers) or stop it (the owner), its messages held until the agent's turn ends, and the console's events for it
 * (queued, delivered, dropped, stopped, refused), oldest first. Messages' text stays the owner's to read.
 */
export declare function consoleView(o: Pick<DashboardOptions, 'stateDir' | 'cfg' | 'user' | 'eventsDb'> & {
    role?: Role | null;
}, run: string): {
    owner: string;
    canControl: boolean;
    canMessage: boolean;
    live: boolean;
    pending: import("./console.js").PendingMessage[];
    held: {
        at: string;
        type: string;
        id: string | null;
        by: string | null;
        text: string | null;
        why: string | null;
    }[];
    events: {
        at: string;
        type: string;
        id: string | null;
        by: string | null;
        text: string | null;
        why: string | null;
    }[];
};
/** The repo's config files as written, before the schema's defaults: what the repo itself defines. Unreadable: none. */
export declare function repoConfigFiles(dir: string): (file: string) => unknown;
/**
 * Where a setting's value in effect comes from: the instance's policy when it sets the key (its dotted path),
 * else the repo's config when that defines it, else the engine's own default.
 */
export declare function settingSource(key: SettingKey, instance: unknown, repo: (file: string) => unknown): 'instance' | 'repo' | 'engine';
/** The instance's agents (workers) in effect: its policy's setting, else the repo's; read only, for the Trust panel. */
export declare function instanceAgents(o: Pick<DashboardOptions, 'policyFile' | 'cfg'>): number;
/**
 * The Settings page's instance section: each setting's value in effect and where it comes from (the
 * instance's policy, the repo's config, or the engine's default), the bounds a new value must keep (the machine's limits and
 * the policy's own ceilings), and whether this dashboard's user, the owner, may change them.
 */
export declare function instanceSettingsView(o: Pick<DashboardOptions, 'policyFile' | 'cfg' | 'user' | 'limitsPath'> & {
    role?: Role | null;
}): {
    available: false;
    why: string;
    owner: string;
    user: string;
    canChange: boolean;
    keys: ("workers" | "run_windows" | "daily_budget_usd" | "stuck_guard" | "ci_repair.enabled" | "ci_repair.max_fixes_per_pr" | "research.max_searches_per_day" | "research.max_fetches_per_day" | "research.max_usd_per_day" | "research.repo_access" | "intake.reports_per_sender_per_day" | "intake.drafts_per_day" | "intake.max_usd_per_day" | "chat_attachments.max_file_mb" | "chat_attachments.max_message_mb" | "chat_attachments.retention_days")[];
} | {
    canChange: boolean;
    available: true;
    limits: {
        workers: {
            min: number;
            max: number;
        };
        daily_budget_usd: {
            max: number;
        };
        max_fixes_per_pr: {
            max: number;
        };
        research: {
            max_searches_per_day: number;
            max_fetches_per_day: number;
            max_usd_per_day: number;
        };
        intake: {
            reports_per_sender_per_day: number;
            drafts_per_day: number;
            max_usd_per_day: number;
        };
    } | null;
    limitsError: string | null;
    ceilings: {
        max_workers: number;
        daily_usd: number;
    };
    settings: {
        key: "workers" | "run_windows" | "daily_budget_usd" | "stuck_guard" | "ci_repair.enabled" | "ci_repair.max_fixes_per_pr" | "research.max_searches_per_day" | "research.max_fetches_per_day" | "research.max_usd_per_day" | "research.repo_access" | "intake.reports_per_sender_per_day" | "intake.drafts_per_day" | "intake.max_usd_per_day" | "chat_attachments.max_file_mb" | "chat_attachments.max_message_mb" | "chat_attachments.retention_days";
        value: unknown;
        source: "repo" | "instance" | "engine";
    }[];
    owner: string;
    user: string;
    keys: ("workers" | "run_windows" | "daily_budget_usd" | "stuck_guard" | "ci_repair.enabled" | "ci_repair.max_fixes_per_pr" | "research.max_searches_per_day" | "research.max_fetches_per_day" | "research.max_usd_per_day" | "research.repo_access" | "intake.reports_per_sender_per_day" | "intake.drafts_per_day" | "intake.max_usd_per_day" | "chat_attachments.max_file_mb" | "chat_attachments.max_message_mb" | "chat_attachments.retention_days")[];
};
/** A research run for its page: each search, each fetch (refused or not), and every cap it stopped at. */
export declare function researchView(events: {
    type: string;
    payload: unknown;
}[], run: string): {
    capped: string[];
    searches: string[];
    fetches: {
        url: string;
        host: string;
        refused: string | null;
    }[];
};
/** Open PRs, and those needing a person: waiting on their review, or a CI fix that gave up. */
export declare const prCounts: (prs: {
    state: string;
    phase: string;
}[]) => {
    open: number;
    needYou: number;
};
/**
 * Whether this instance merges its own PRs now, read-only, from the same three
 * places the coordinator reads: the instance policy's kill switch (auto_merge,
 * re-read every time), the repo's review.yaml merge.auto, and the stop file a
 * red main after an auto-merge leaves until the operator clears it. Without an
 * instance (a checkout) there is no policy, so nothing auto-merges.
 */
export declare function autoMergeState(o: {
    policyFile: string | null;
    repoAuto: boolean | null;
    stateDir: string;
}): {
    on: boolean;
    policy: boolean | null;
    repo: boolean | null;
    stopped: string | null;
    why: string;
};
/**
 * How the default branch is guarded, for the dashboard: "GitHub enforced" or the harness's own guard, the main watch (or off,
 * or not known yet), the last commit the watch checked, and, while an unaccounted commit's stop is in force, its alert.
 * Read-only, from the watch's state file and the log. A viewer is sent the mode only (viewer-events.ts).
 */
export declare function protectionState(o: {
    stateDir: string;
    repo: string;
    events: StoredEvent[];
    role: Role | null;
}): {
    accepted: {
        id: string;
        sha: string | null;
        pr: number | null;
        head: string | null;
        by: string;
        reason: string;
        at: string;
        appliedTo: string | null;
    }[];
    alert: {
        at: string;
        sha: string;
        url: string;
        reason: string;
        number: number | null;
        revert: string | null;
    } | null;
    directPush: {
        at: string;
        sha: string;
        url: string;
        kind: "direct" | "rewrite";
        pusher: string | null;
        status: string;
        mentioned: number;
        note: string | null;
    } | null;
    stopped: string | null;
    canClear: boolean;
    canAccept: boolean;
    mode: "unknown" | import("./main-watch.js").ProtectionMode;
    detail: string;
    lastChecked: {
        sha: string;
        url: string;
        at: string | null;
    } | null;
};
/**
 * The last commit that landed without a PR, and its ops-channel alert (src/direct-push-alert.ts): posted, how many
 * owners it mentioned, and why nobody was (or why it wasn't posted, or that the alert is off); null when none.
 */
export declare function lastDirectPush(events: StoredEvent[]): {
    at: string;
    sha: string;
    url: string;
    kind: "direct" | "rewrite";
    pusher: string | null;
    status: string;
    mentioned: number;
    note: string | null;
} | null;
/** The PRs whose merge the main watch has judged already (accounted, accepted or not): none of them can be accepted. */
export declare function judgedPrs(events: StoredEvent[]): number[];
/** What an accept request names: `pr` (a number), or `sha`; null when neither, or both. */
export declare function acceptTarget(body: {
    sha?: unknown;
    pr?: unknown;
}): AcceptTarget | null;
/** An admin resumes auto-merge from the dashboard: the stop file goes, and merge.resumed records who did. */
export declare function clearAutoMergeStop(o: {
    stateDir: string;
    eventsDb: string;
    by: string;
}): {
    ok: true;
    reason: string;
} | {
    ok: false;
    error: string;
};
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
export type JournalReader = (unit: string, lines: number) => {
    status: number | null;
    stdout: string;
    stderr: string;
};
/**
 * The coordinator's service log, read-only, as the dashboard's user (the
 * instance's coordinator user): its unit's journal, or else its log file.
 * An unprivileged user reads only journal files it owns: with the journal
 * kept on disk and split per user (systemd's default), that is exactly its
 * own service's lines, and no other instance's.
 */
export declare function readServiceLog(src: LogSource, lines?: number, read?: JournalReader): ServiceLog;
/** WHY: a checkout's dashboard and `dashboard --detach` (src/dashboard-detach.ts) must agree, or a rerun prints another URL. */
export declare const LOCAL_DASHBOARD_PORT = 4317;
/** An instance's dashboard port, the same every time (so a tunnel to it can be set up once): 4400-4899, from its name. */
export declare const instancePort: (name: string) => number;
/** Where the built web UI is served from: dist/web next to this module's dist/src (`npm run build:web` writes it there). */
export declare const DEFAULT_WEB_DIR: string;
/** Whether the web UI is built where the dashboard serves it. */
export declare const webUiBuilt: (dir?: string) => boolean;
/**
 * Whether a request carries this token in its bearer header, compared in constant time. INVARIANT: never from the
 * URL; a key in a URL is refused before this is asked (src/dashboard-key-url.ts).
 */
export declare function tokenGiven(req: IncomingMessage, _url: URL, token: string): boolean;
/** The built UI; anything unknown falls back to index.html (client-side routes). Never a file outside webDir. */
/** The marker a hub puts on the page it serves, so the UI asks for the hub's instances only there (else /api/hub is a 404). */
export declare const HUB_MARKER = "<meta name=\"dashboard-hub\" content=\"1\">";
/**
 * The dashboard page's content security policy, on the hub and on an instance's own server: everything from this
 * origin only. People's pictures come from this server too (src/avatars.ts), read with the page's own auth and shown
 * from a blob: URL the page made; no outside host is in any directive (#462).
 */
export declare const PAGE_CSP = "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export declare function serveStatic(webDir: string, url: URL, res: ServerResponse, opts?: {
    hub?: boolean;
}): void;
/** Content-hashed built files: the same name is always the same bytes, so a browser keeps them a year without asking. */
export declare const IMMUTABLE = "public, max-age=31536000, immutable";
/**
 * Compress the built UI's assets now, in the background (zlib's pool), so the first person to load it doesn't wait for
 * it: the hub does this when it starts. Anything that fails is compressed on its first request instead.
 */
export declare function warmStatic(webDir: string): void;
/** Whether a request's Host header names this loopback port (not a DNS name that was pointed at 127.0.0.1). */
export declare function loopbackHostHeader(host: string | undefined, port: number | undefined): boolean;
/** GET: the key page's help (the key file's path and a copy command), loopback only, never the key. */
export declare const KEY_HELP_PATH = "/api/key-help";
export declare function dashboardToken(stateDir: string): string;
/**
 * A JSON answer, never stored by a browser or a proxy. Compressed only for a view COMPRESSIBLE_API lists (the BREACH
 * check, src/dashboard-compress.ts) and a client that accepts it.
 */
export declare function json(res: ServerResponse, status: number, body: unknown): void;
/** The chat attachments' caps in force: the instance's policy settings, else the engine's defaults. */
export declare function chatAttachmentCaps(o: Pick<DashboardOptions, 'policyFile'>): AttachmentCaps;
export declare function startDashboard(opts: DashboardOptions): Promise<{
    server: Server;
    url: string;
    keyFile: string;
    token: string;
    close: () => Promise<void>;
}>;

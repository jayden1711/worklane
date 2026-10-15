import { type Config } from './config/load.js';
export type Mode = 'local' | 'server';
export declare const MODES: readonly Mode[];
export interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
/** What the detectors may ask of the machine: read-only commands and the service manager. Tests stand in for it. */
export interface SetupProbe {
    which(cmd: string): string | null;
    run(cmd: string, args: string[], o?: {
        cwd?: string;
    }): RunResult;
    /** This user's service (local mode's coordinator) running now; null where there is no service manager to ask. */
    serviceRunning(label: string): boolean | null;
    /** A system unit (a server instance's coordinator, the dashboard hub) active now; null off Linux. */
    systemUnitActive(unit: string): boolean | null;
    /** Linux: whether this user's services outlive a login session; null elsewhere. */
    linger(): boolean | null;
}
export declare function systemProbe(): SetupProbe;
/** The machine-wide files a server's steps are read from (tests point them elsewhere). */
export interface MachinePaths {
    /** The engine this process runs: its package.json. */
    enginePackage: string;
    engine: string;
    helper: string;
    machineOwners: string;
    updatesConfig: string;
    allowedSigners: string;
    hubUnitFile: string;
    fullRunLock: string;
    /** claude-account.sh's status.json: each agent user's stored login and `claude auth status`, never the token. */
    claudeAccountDir: string;
}
export declare const MACHINE_PATHS: MachinePaths;
export declare const HUB_UNIT: string;
/** The hub in setup mode (src/hub-setup.ts; dashboards.sh --setup): before the sign-in App exists. */
export declare const HUB_SETUP_UNIT: string;
/** What a server instance's steps read from it: its credentials and its home. */
export interface InstanceFacts {
    home: string;
    credentials: {
        github: {
            kind: 'app';
            key_path: string;
        } | {
            kind: 'gh-config-dir';
            path: string;
        };
        claude?: {
            config_dir: string;
        } | undefined;
        agent_api_key?: string | undefined;
        intake?: {
            discord_token?: string | undefined;
        } | undefined;
    };
}
export interface SetupContext {
    mode: Mode;
    /** The checkout: local mode's repo, or a server instance's clone. */
    root: string;
    /** owner/name on GitHub, when known. */
    repo: string | null;
    instance: string | null;
    /** Where the checkout's (or instance's) machine-local state is: the main watch's file. */
    stateDir: string;
    /** A server instance's policy.yaml. */
    policyFile: string | null;
    /** Auto-config's open questions and its setup PR, as init recorded them (local mode). */
    openQuestions: number;
    setupPr: string | null;
    /**
     * Server mode: add-project's last state and detail per step, as init recorded them (src/init.ts). What the
     * coordinator's user can't see for itself (the agent user's Claude login, a step left waiting) is read from here.
     */
    handoff?: Record<string, string>;
    handoffDetail?: Record<string, string>;
    machine?: Partial<MachinePaths>;
    /** A server instance's credentials and home; loadInstance when unset. */
    instanceFacts?: () => InstanceFacts | {
        error: string;
    };
    /** Steps skipped on the first-run page (src/dashboard.ts). */
    skipped?: readonly string[];
}
export interface Detected {
    done: boolean;
    detail: string;
}
/** How the first-run page fixes a step that isn't done. */
export type Fix = 
/** A dashboard screen does it: the button opens it. */
{
    kind: 'screen';
    path: string;
    label: string;
}
/** No screen yet: the page shows what a person does today, and says one is coming. */
 | {
    kind: 'coming';
}
/** Only on the provider's own page (a login, a consent): a direct link, and the page detects when it's done. */
 | {
    kind: 'outside';
    url: string | null;
    label: string;
    why: string;
    command?: string;
}
/** Only in a terminal (root consent, sudo, a shell profile): the command, and why it can't be a button. */
 | {
    kind: 'terminal';
    command: string;
    why: string;
}
/** The Start button: the coordinator's service. */
 | {
    kind: 'start';
}
/** WHY: a step the dashboard does itself (src/setup-actions.ts): its plan shown first, then confirmed by an owner. */
 | {
    kind: 'action';
    action: string;
    label: string;
}
/** WHY: the Claude sign-in (src/claude-signin.ts): local mode relays `claude auth login`; a server pastes a setup token. */
 | {
    kind: 'signin';
    label: string;
}
/** WHY: a fix that needs values (the policy's): a form on the page, its change shown before it is written. */
 | {
    kind: 'form';
    form: 'policy' | 'repo-config' | 'setup-origin' | 'setup-config';
    label: string;
}
/** WHY: Connect GitHub (src/gh-login.ts): gh's device login run for the person, its one-time code relayed to the page. */
 | {
    kind: 'gh-login';
    label: string;
    command: string;
}
/** WHY: the Discord step (src/intake/discord-setup.ts): token, invite, channel picks, intake.yaml after a shown diff. */
 | {
    kind: 'discord';
    label: string;
};
export type GroupId = 'install' | 'tools' | 'claude' | 'github' | 'repo-config' | 'coordinator' | 'protection' | 'policy' | 'discord' | 'tailscale' | 'updates' | 'extras' | 'service';
export interface GroupDef {
    id: GroupId;
    title: string;
    optional: boolean;
    modes: readonly Mode[];
    /** One of init's walked steps (init does this group's work, in this order). */
    walked: boolean;
}
/** The groups, in order. init's checklist is the walked ones, in this order (src/init.ts STEPS). */
export declare const GROUPS: readonly GroupDef[];
/** How many installs reach a step (the audit's estimate from where it sits on the path, not usage data). */
export type Reach = 'all' | 'most' | 'some' | 'few';
export interface SetupStep {
    id: string;
    group: GroupId;
    /** The rows of the first-run audit's table this step covers. */
    rows: number[];
    title: string;
    modes: readonly Mode[];
    /** Recommended, not required: shown, never blocks. */
    optional: boolean;
    /**
     * The modes in which init's walk needs this step for its group to be done (init stops there until it is). Doctor's
     * line for the group (`setup <group>`) fails until every such step is done; any step not done is a warning on its
     * own line (`setup step <id>`).
     */
    walk?: readonly Mode[];
    reach: Reach;
    /** What a person does about it today, without a screen. */
    today: string;
    fix: Fix;
    /** WHY: every screen has a way to do the same without the page (a command or a config key), shown on it and in docs/dashboard.md. */
    automation?: string;
    /** It asks GitHub (or another service) over the network: checked less often, to spare the API's rate limit. */
    network?: boolean;
    detect: (c: Checking) => Detected | null;
}
/** A detector's view of the context: the context, the probe, and the config loaded once per check. */
export interface Checking {
    c: SetupContext;
    p: SetupProbe;
    m: MachinePaths;
    cfg: () => Config | {
        error: string;
    };
    inst: () => InstanceFacts | {
        error: string;
    };
}
export declare const REQUIRED_TOOLS: Record<Mode, string[]>;
/** The tools step: Node new enough, and each required tool on PATH. */
export declare function detectTools(mode: Mode, p: Pick<SetupProbe, 'which'>, node?: string): Detected & {
    missing: string[];
};
/** Claude Code signed in, per `claude auth status` (local mode: the person's own login). */
export declare function detectClaudeLogin(p: Pick<SetupProbe, 'which' | 'run'>): Detected;
/** gh signed in, per `gh auth status`, and able to push to the repo. */
export declare function detectGithubLogin(p: Pick<SetupProbe, 'which' | 'run'>, repo: string | null): Detected;
/** The checkout's config folder: there, valid, and its hooks for local runs installed (init's repo-config step). */
export declare function detectRepoConfig(root: string, openQuestions: number, setupPr: string | null): Detected;
/** The tailnet, per `tailscale status --json`; null when not on one. */
export declare function detectTailscale(p: Pick<SetupProbe, 'which' | 'run'>): (Detected & {
    dnsName: string | null;
    json: Record<string, unknown> | null;
}) | null;
/** The registry: every step of the audit's table (rows 1-33), in the order the page shows them. */
export declare const SETUP_STEPS: readonly SetupStep[];
export interface StepView {
    id: string;
    group: GroupId;
    rows: number[];
    title: string;
    optional: boolean;
    /** init's walk needs it for its group, in this mode. */
    walk: boolean;
    reach: Reach;
    done: boolean;
    detail: string;
    today: string;
    fix: Fix;
    automation: string | null;
    /** The person skipped it on the first-run page: shown as skipped, not counted as left; doctor and init still check it. */
    skipped: boolean;
    network: boolean;
    checkedAt: string;
}
export interface GroupView {
    id: GroupId;
    title: string;
    optional: boolean;
    /** Every required step in it done (an optional group: every step). */
    done: boolean;
    /** Every step init's walk needs here done: what doctor's line for the group says (ok, or not). */
    ready: boolean;
    steps: StepView[];
}
export interface SetupView {
    mode: Mode;
    groups: GroupView[];
    /** Steps done, of all that apply. */
    done: number;
    total: number;
    /** Required steps not done yet. */
    requiredLeft: number;
}
/** A detector's answer, kept between checks (the dashboard's poll). */
export type DetectCache = Map<string, {
    at: number;
    key: string;
    r: Detected | null;
}>;
/**
 * Check every step that applies to this mode, now. With a cache (the dashboard), a step checked within its time to
 * live is reused: network steps for `netMs`, the rest for `localMs`; `fresh` (Re-check) checks them all again.
 */
export declare function checkSetup(c: SetupContext, p: SetupProbe, o?: {
    cache?: DetectCache;
    fresh?: boolean;
    localMs?: number;
    netMs?: number;
    now?: () => number;
}): SetupView;
/** The level doctor shows a step's own line at: ok when done, as the page shows it; a warning when not. */
export declare const stepLevel: (s: Pick<StepView, "done">) => "ok" | "warn";
/** The level of doctor's line for one of init's walked groups: ok when ready, as the page's group says; else fail (an optional group: warn). */
export declare const groupLevel: (g: Pick<GroupView, "ready" | "optional">) => "ok" | "warn" | "fail";
/**
 * checkSetup in a worker thread (src/setup-worker.ts), with the real probe: the dashboard's way, so its server keeps
 * answering while the commands run. The context must be plain data (no instanceFacts function: the worker loads
 * the instance itself). The cache comes back updated.
 */
export declare function checkSetupOffThread(c: Omit<SetupContext, 'instanceFacts'>, o: {
    cache: DetectCache;
    fresh?: boolean;
    localMs?: number;
    netMs?: number;
}): Promise<SetupView>;

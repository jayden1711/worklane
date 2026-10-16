import { type AutoConfigState, type Question, type Verification } from './auto-config.js';
import { type HandOff } from './npx-engine.js';
import { isRoot } from './os/index.js';
import { MODES, type DetectCache, type Mode, type RunResult, type SetupContext, type SetupProbe, type SetupView } from './setup-steps.js';
import { type Download, type InstallableTool, type ToolInstall } from './tool-install.js';
export { MODES, type Mode, type RunResult };
export type StepId = 'tools' | 'claude' | 'github' | 'repo-config' | 'coordinator' | 'protection' | 'discord' | 'tailscale';
export type StepStatus = 'pending' | 'done' | 'skipped' | 'failed';
export interface StepDef {
    id: StepId;
    title: string;
    optional: boolean;
    modes: readonly Mode[];
}
/**
 * The checklist, in order: the registry's walked groups (src/setup-steps.ts), so init, doctor and the page share one
 * list. Server mode's Coordinator running is add-project's last steps (the coordinator's service, test user, machine
 * helper, dashboards); local mode starts the coordinator with `up` after init, so it has no such step.
 */
export declare const STEPS: readonly StepDef[];
export declare const stepsFor: (mode: Mode) => StepDef[];
export interface StepRecord {
    status: StepStatus;
    detail: string;
    /** When it last changed. */
    at: string;
}
export interface InitState {
    version: 1;
    mode: Mode;
    /** local: the repo's directory; server: owner/name. */
    target: string;
    /** owner/name on GitHub, when known. */
    repo: string | null;
    /** server: the instance's name. */
    instance: string | null;
    steps: Partial<Record<StepId, StepRecord>>;
    /** server: add-project.sh's last state per step. */
    handoff: Record<string, string>;
    /** server: add-project.sh's last detail per step (how the App was made, the setup PR it waits for). */
    handoffDetail?: Record<string, string>;
    /** Local mode: auto-config's answers, open questions, command results and setup PR (src/auto-config.ts). */
    autoConfig?: AutoConfigState;
    updatedAt: string;
    finishedAt: string | null;
}
export declare const INIT_FILE = "init.json";
/** Local mode's state: beside the project's other machine-local state (the dashboard's state dir for it). */
export declare const localInitFile: (root: string) => string;
/**
 * Server mode's state, per instance: written by root (init runs add-project.sh as root), in the machine's state
 * (machineInitDir(), 0755), each file root's and readable by that instance's coordinator group only (0640), so
 * `doctor` run as the coordinator, and the instance's dashboard, show what init recorded. No secret is in it.
 */
export declare const serverInitFile: (instance: string) => string;
/** The machine's init records (tests point it elsewhere). */
export declare const machineInitDir: () => string;
/** Where an engine before this kept it: root's own state, which the coordinator can't read. Read once, to carry it over. */
export declare const legacyServerInitFile: (instance: string) => string;
export declare function readInitState(file: string): InitState | null;
/** Why a state file that is there can't be read (as this user), or null: doctor says so rather than "not reached". */
export declare function initStateUnreadable(file: string): string | null;
export declare function writeInitState(file: string, s: InitState): void;
/** Server mode: write the state, then open it to the instance's coordinator group (read only). */
export declare function writeServerInitState(file: string, s: InitState, instance: string): void;
export interface Unavailable {
    feature: string;
    why: string;
}
/** What this mode can't do, each with why. Server mode has everything; local mode lacks what needs root or other users. */
export declare function unavailableIn(mode: Mode, has?: (cmd: string) => boolean): Unavailable[];
/** Everything a step does to the world, so tests can stand in for it. */
export interface InitIo {
    which(cmd: string): string | null;
    run(cmd: string, args: string[], o?: {
        cwd?: string;
    }): RunResult;
    /** Run a command on the person's terminal (a login): its exit status. */
    interactive(cmd: string, args: string[]): Promise<number>;
    /** Ask on the terminal; null when there is none (then nothing interactive happens). */
    ask(question: string): Promise<string | null>;
    say(line: string): void;
    download: Download;
    /** The pinned install for a missing tool (src/tool-install.ts), or null where none is pinned. */
    plan(tool: InstallableTool, prefix: string): ToolInstall | null;
    /** Server mode: run add-project.sh, reporting each step line; its exit status and each step's last state and detail. */
    addProject(name: string, repo: string, timeoutMinutes?: number): Promise<{
        code: number;
        steps: Record<string, string>;
        details?: Record<string, string>;
        last: string;
    }>;
}
export interface InitContext {
    mode: Mode;
    /** local: the repo directory. */
    root: string | null;
    repo: string | null;
    instance: string | null;
    /** Where installs go (bin/ under it). */
    prefix: string;
    /** Whether to go ahead without asking (installs). Logins still need a terminal. */
    yes: boolean;
    /** Is there a terminal to ask on and run logins in? */
    interactive: boolean;
    io: InitIo;
    state: InitState;
    /** Answers to auto-config's questions given on the command line (`--answer id=choice`). */
    answers?: Record<string, string>;
    /** Keep the state now (runInit sets it): auto-config saves each answer and result as it comes. */
    save?: () => void;
    /** Server mode: how long add-project waits for a GitHub click or the setup PR's merge, in minutes (its default: 15). */
    timeout?: number;
    /** Server mode: add-project's run in this init, once it has run (it runs at most once). */
    handedOff?: {
        code: number;
        last: string;
    };
    /** WHY (#468): the first-run page's draft: hold the drafted config for its preview instead of proposing it at once. */
    hold?: boolean;
}
export interface StepResult {
    status: Exclude<StepStatus, 'pending'>;
    detail: string;
    /** Failed only for want of a CI choice (#469): the wizard makes it (init's exit CI_CHOICE_EXIT). */
    ciChoice?: true;
}
/**
 * init's exit when everything before it is done and only the CI choice is missing (#469): bootstrap then still starts
 * the dashboard and prints the wizard's URL, where the choice is made (Required checks named).
 */
export declare const CI_CHOICE_EXIT = 5;
/**
 * Auto-config, for a checkout with no config folder: detect the project's commands on the default branch, ask what
 * can't be settled without the person, run each command there, and propose the config as a PR from its own branch
 * (src/auto-config.ts). null: the config is on the default branch now (its PR merged) and this checkout has it, so
 * the hooks can be installed from it.
 */
export type AutoConfig = (c: InitContext) => Promise<StepResult | null>;
export declare const autoConfig: AutoConfig;
export interface ChecklistItem extends StepDef {
    status: StepStatus;
    detail: string;
    at: string | null;
}
/** The checklist from a state file alone (the dashboard): each step's recorded status, pending when not reached. */
export declare function recordedChecklist(state: InitState | null, mode: Mode): ChecklistItem[];
export declare function newState(mode: Mode, target: string, repo: string | null, instance: string | null): InitState;
/**
 * Walk the checklist. Exit status: 0 when every required step is done, 1 when one stopped the walk (the state says
 * which, and what to do).
 */
export declare function runInit(c: InitContext, file: string): Promise<number>;
/** The engine's own checkout (where scripts/ lives), from this module's place in dist/src/. */
export declare const engineRoot: () => string;
/** The real world: commands, the terminal, downloads and add-project.sh. */
export declare function systemIo(o: {
    interactive: boolean;
}): InitIo;
/** The GitHub repo a local checkout works on: its origin on github.com, else its config's project.repo. */
export declare function localRepo(root: string): string | null;
export interface InitArgs {
    target: string | undefined;
    mode: Mode | undefined;
    instance: string | undefined;
    yes: boolean;
    reset: boolean;
    /** Where the CLI was run (local mode's default repo). */
    cwd: string;
    prefix: string;
    interactive: boolean;
    /** `--answer id=choice`, for auto-config's questions. */
    answers?: Record<string, string>;
    /** Server mode: add-project's --timeout, in minutes. */
    timeout?: number;
}
/**
 * `init`: the mode (asked when not given), the context, then the walk. Local mode run through npx hands over to an
 * install of its own first (src/npx-engine.ts).
 */
export declare function initCommand(a: InitArgs, io?: InitIo, root?: typeof isRoot, handOff?: HandOff): Promise<number>;
/** The dashboard's first-run page (GET /api/first-run): the checklist as init recorded it, and what the mode can't do. */
export interface FirstRunView {
    /** Whether init has run for this checkout or instance. */
    recorded: boolean;
    mode: Mode | null;
    steps: ChecklistItem[];
    done: number;
    total: number;
    unavailable: Unavailable[];
    updatedAt: string | null;
    finishedAt: string | null;
    /** The command that walks (or resumes) the checklist. */
    command: string;
    /** Auto-config (local mode): the questions still open, each command's result on the default branch, the setup PR. */
    autoConfig: {
        questions: Question[];
        verified: Verification[];
        pr: {
            number: number | null;
            url: string;
        } | null;
        answer: string;
    } | null;
    /** Every setup step that applies to the mode, checked live from the real state (src/setup-steps.ts); doctor shows the same. */
    setup: SetupView | null;
}
/** How the page checks the steps live: the probe (none: the real one, off the main thread), where the state is, and the poll's cache. */
export interface FirstRunLive {
    probe?: SetupProbe;
    stateDir: string;
    policyFile: string | null;
    cache?: DetectCache;
    fresh?: boolean;
    localMs?: number;
    netMs?: number;
    context?: Partial<Pick<SetupContext, 'machine' | 'instanceFacts' | 'skipped'>>;
}
/** The setup context for a checkout or an instance, with what init recorded (auto-config's questions and PR). */
export declare function setupContext(state: InitState | null, o: {
    mode: Mode;
    root: string;
    repo: string | null;
    instance: string | null;
    stateDir: string;
    policyFile: string | null;
}): SetupContext;
/**
 * The first-run view with every step checked live (the dashboard's): a checkout without a recorded mode is local, an
 * instance's is server. With no probe given, the real one runs in a worker so the dashboard keeps answering.
 */
export declare function firstRunLiveView(file: string, o: {
    root: string;
    repo: string;
    instance: string | null;
    has?: (cmd: string) => boolean;
    live: FirstRunLive;
}): Promise<FirstRunView>;
export declare function firstRunView(file: string, o: {
    root: string;
    repo: string;
    instance: string | null;
    has?: (cmd: string) => boolean;
    setup?: SetupView | null;
}): FirstRunView;

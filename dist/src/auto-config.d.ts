import type { Config } from './config/load.js';
import type { RunAs } from './runner.js';
export type Slot = 'setup' | 'full' | 'changed' | 'one';
export declare const SLOTS: readonly Slot[];
export interface Choice {
    id: string;
    label: string;
    /** The command this choice sets, when it sets one. */
    command?: string;
}
export interface Question {
    id: string;
    ask: string;
    choices: Choice[];
    /** Whether a typed command is also an answer (`custom:<command>`). */
    custom: boolean;
    /** The command a "fails on the default branch" question is about. */
    about?: string;
}
export interface Answer {
    choice: string;
    /** A typed command (choice `custom`). */
    command?: string;
}
export interface Verification {
    slot: Slot;
    command: string;
    /** The default branch's commit it ran on. */
    base: string;
    /** Exit status; null: it was stopped at the time limit, or didn't start. */
    code: number | null;
    passed: boolean;
    ms: number;
    tail: string;
    at: string;
}
export interface AutoConfigState {
    /** Answers to the detection questions, by question id. */
    answers: Record<string, Answer>;
    /** Commands set by answering "fails on the default branch" (null: left out). */
    overrides: Partial<Record<Slot, string | null>>;
    /** Commands kept although they failed on the default branch ("use it anyway"). */
    accepted: string[];
    /** The questions still open, as last asked (the checklist and the First-run page show them). */
    questions: Question[];
    verified: Verification[];
    base: string | null;
    /** The setup PR, once opened; `head`: the commit this run pushed for it (null: an open PR kept from before, not pushed here). */
    pr: {
        number: number | null;
        url: string;
        branch: string;
        head?: string | null;
    } | null;
    /**
     * WHY (#468): the drafted config held for the person to preview before any PR (the dashboard's draft): the top-level
     * YAML files as drafted (and edited on the page), the commit it was drafted on, and the PR body. Absent from the
     * terminal's init, which proposes at once.
     */
    draft?: HeldDraft | null;
}
export interface HeldDraft {
    /** The default branch and the commit the draft was made (and its commands run) on. */
    branch: string;
    base: string;
    owner: string | null;
    /** The config folder's top-level *.yaml files, by name. */
    yaml: Record<string, string>;
    body: string;
    at: string;
}
export declare const emptyAutoConfig: () => AutoConfigState;
/** The branch the scaffold is proposed from (scripts/setup/checkout.sh pushes the same one on a server). */
export declare const SETUP_BRANCH: string;
interface Cand {
    command: string;
    from: string;
}
/** What the repo is, from its tracked files at `dir`. Questions it can't settle without the person are in `questions`. */
export interface Detection {
    ecosystems: string[];
    full: Cand[];
    changed: Cand | null;
    one: Cand | null;
    setup: string[];
    all: Cand | null;
    monorepo: string | null;
    testFiles: string[];
    testGlobs: string[];
    assertion: string | null;
    appPaths: string[];
    questions: Question[];
    notes: string[];
}
/** Globs for the test files that are there: `<top dir>/**​/<pattern>`, or the pattern alone at the root. */
export declare function testGlobsOf(testFiles: string[]): string[];
export declare function detectProject(dir: string, files: string[], answers?: Record<string, Answer>): Detection;
/** "No tests yet": the gates run this, which passes, until a real command is set. */
export declare const NO_TESTS = "true";
export interface Plan {
    detection: Detection;
    /** Questions with no answer yet. Nothing is drafted or run while there are any. */
    open: Question[];
    commands: Record<Slot, string | null>;
    notes: string[];
}
export declare function planFrom(d: Detection, s: Pick<AutoConfigState, 'answers' | 'overrides'>): Plan;
/** The "fails on the default branch" question for a slot's command. */
export declare function failureQuestion(slot: Slot, command: string, d: Detection): Question;
/** Record an answer: a detection question's in `answers`; a failure question's as an override, or as accepted. */
export declare function applyAnswer(s: AutoConfigState, q: Question, a: Answer): string | null;
/** An answer as typed: a choice's id or number, or `custom:<command>`. */
export declare function parseAnswer(q: Question, text: string): Answer | null;
/** tests.yaml as drafted: the commands, the test globs and the worktree setup; validated against the schema. */
export declare function draftTests(p: Plan, verified: Verification[]): string;
export interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
/** What auto-config does to the world: git, gh (the person's own login), the terminal. Commands run through sh. */
export interface AutoConfigIo {
    git(args: string[], cwd: string): RunResult;
    /** gh's command line (local mode), or the same few calls answered over GitHub's REST API (src/server-auto-config.ts). */
    gh(args: string[], cwd: string): RunResult | Promise<RunResult>;
    /** null: there's no terminal to ask on. */
    ask(question: string): Promise<string | null>;
    say(line: string): void;
}
export interface AutoConfigOptions {
    root: string;
    repo: string;
    io: AutoConfigIo;
    state: AutoConfigState;
    /** Answers given up front (`init --answer id=choice`). */
    given?: Record<string, string>;
    /** Each command's time limit (default 15 minutes). */
    timeoutMs?: number;
    /** Keep the state (each answer and result is saved as it comes). */
    save(): void;
    /** Server mode: the drafted commands run as the instance's agent user, never as the user holding the credentials. */
    runAs?: RunAs;
    /** Where the scratch worktree goes (default: under the project's state dir), and where its ownership record is kept. */
    worktreeRoot?: string;
    worktreeStateDir?: string;
    /** The config's owner when gh can't say who is running it (an App's token has no user): the machine's first owner. */
    owner?: string;
    /** Fit the drafted config folder to its setting before it is validated (a server instance's policy: budget, workers). */
    adjust?(cfgDir: string): void;
    /** Problems beyond the schema (an instance's policy), each one line: any stops the proposal. */
    check?(cfg: Config): string[];
    /** WHY (#468): draft and hold it for a preview (state.draft); no branch is pushed and no PR opened until proposeHeldDraft. */
    hold?: boolean;
}
export type AutoConfigResult = {
    kind: 'questions';
    open: Question[];
    detail: string;
} | {
    kind: 'proposed';
    detail: string;
} | {
    kind: 'drafted';
    detail: string;
} | {
    kind: 'merged';
    branch: string;
} | {
    kind: 'failed';
    detail: string;
};
export declare const DEFAULT_TIMEOUT_MS: number;
/**
 * Detect, ask, verify on the default branch, and propose the config as a PR. Resumable: answers and results are in
 * the state, and an open PR is checked rather than opened again.
 */
export declare function autoConfigure(o: AutoConfigOptions): Promise<AutoConfigResult>;
/**
 * WHY (#468): Confirm on the preview. The held draft (as previewed, with any change made there) is committed on a
 * scratch worktree of the commit it was drafted on, pushed to the setup branch and opened as the setup PR, as init's
 * own proposal is. Nothing is pushed to the default branch. The draft is let go once its PR is open.
 */
export declare function proposeHeldDraft(o: Pick<AutoConfigOptions, 'io' | 'repo' | 'root' | 'state' | 'save' | 'worktreeRoot' | 'worktreeStateDir'>): Promise<AutoConfigResult>;
export {};

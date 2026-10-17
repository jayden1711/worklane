import { type AgentRunner } from './runner.js';
export interface EvalCase {
    id: string;
    title: string;
    situation: string;
    correct: string[];
    wrong: string[];
}
export declare function parseCases(md: string): EvalCase[];
/**
 * A case's rubric: fixed yes/no items, its CORRECT ones (met when the plan does it) and then its WRONG ones (met
 * when the plan doesn't). The text is the case's own, unchanged; the score is the number of items met.
 */
export interface RubricItem {
    text: string;
    /** The answer that meets it: yes for a CORRECT item, no for a WRONG one. */
    want: boolean;
}
export declare function rubricOf(c: Pick<EvalCase, 'correct' | 'wrong'>): RubricItem[];
export declare function assertNotPairwise(text: string): void;
/** The judge's answer schema: exactly one yes/no per rubric item, keyed 1..n; nothing else is accepted. */
export declare function rubricSchema(n: number): object;
/** The judge's answer, taken only as exactly n yes/no answers (keys 1..n, booleans); anything else is refused. */
export declare function acceptJudgement(raw: unknown, n: number): boolean[];
export interface CaseResult {
    id: string;
    title: string;
    pass: boolean;
    /** Samples that passed, e.g. "2/3". A case passes on a strict majority. */
    samples: string;
    correct: string;
    wrongDone: string[];
    notes: string;
}
export interface EvalResults {
    skill_sha256: string;
    model: string;
    judge: string;
    at: string;
    passed: number;
    total: number;
    cases: CaseResult[];
}
export declare const CORRECT_THRESHOLD = 0.8;
/** `skill eval`'s defaults: the judge is a different model from the one under test. */
export declare const SKILL_EVAL_DEFAULTS: {
    readonly model: "sonnet";
    readonly judge: "opus";
    readonly samples: 3;
    readonly capUsd: 20;
};
/**
 * A skill's evals, every model call through `ask` (the CLI passes the runner's: one claude per login, the
 * subscription CLI, each call's cost recorded). The same cases, prompts and judging as instruction evals.
 */
export declare function runSkillEval(skillDir: string, opts: {
    model: string;
    judge: string;
    ask: Ask;
    only?: string[];
    samples?: number;
    capUsd?: number;
}): Promise<EvalResults>;
/** Evaluated = results exist for this exact skill text and every case passed. */
export declare function skillStatus(skillDir: string): 'evaluated' | 'stale' | 'failing' | 'draft';
export declare function assertJudgeDiffers(model: string, judge: string): void;
/** A fresh directory whose name says nothing about what runs in it; readable by the agent user. */
export declare function neutralDir(): string;
/** One model call with a JSON schema: the structured answer and what it cost (the CLI's estimate). */
export interface AskRequest {
    /** The instructions under test, as the session's system prompt (absent for the judge). */
    system?: string;
    prompt: string;
    model: string;
    schema: object;
    cwd: string;
    maxBudgetUsd: number;
}
export type Ask = (req: AskRequest) => Promise<{
    structured: unknown;
    costUsd: number;
}>;
/** Ask through the installed `claude` CLI on its own login (API keys stripped: never per-token billing). */
export declare const cliAsk: Ask;
/** Ask through the coordinator's runner: as the agent user, sandboxed, no tools, like every other run. */
export declare function runnerAsk(runner: AgentRunner, onCost: (r: {
    costUsd: number;
    model: string;
    turns: number;
}) => void, stateDir?: string): Ask;
export type CaseOutcome = {
    id: string;
    title: string;
    outcome: 'pass' | 'fail' | 'not run';
    samples?: string;
    correct?: string;
    wrongDone?: string[];
    items?: {
        met: number;
        total: number;
    };
};
export interface InstructionEval {
    passed: number;
    total: number;
    /** The score: rubric items met (each by a strict majority of samples), out of every item of every case. */
    items: {
        met: number;
        total: number;
    };
    /** Samples per case. */
    samples: number;
    cases: CaseOutcome[];
    costUsd: number;
    /** The cost cap stopped it before every case ran. */
    capped: boolean;
}
/** Shared across the base and head runs of one comparison, so the cap bounds the whole eval. */
export interface Spend {
    usd: number;
    cap: number;
}
/**
 * Run every case against one version of the instructions. For each sample: the agent under test gets the
 * instructions as its system prompt and only the situation as its prompt (no rubric, no tools, a neutral
 * directory); the judge, a different model, grades the plan. A case passes on a strict majority of samples.
 * Once the spend reaches the cap, the remaining cases are "not run".
 */
export declare function evalInstructions(o: {
    instructions: string;
    cases: EvalCase[];
    model: string;
    judge: string;
    samples?: number;
    ask: Ask;
    spend: Spend;
}): Promise<InstructionEval>;
/**
 * The judge's prompt: one plan and the case's rubric, each item a yes/no question about that plan. Never two plans,
 * never "which is better": an item that compares is refused before anything is asked.
 */
export declare function judgePrompt(c: EvalCase, plan: string): string;
/** Samples per case in a before/after comparison, unless a lower number is asked for (and then reported). */
export declare const DEFAULT_SAMPLES = 3;
/** One set of cases (visible or held-out) at base and head. Scores are rubric items met (`passed` of `total`). */
export interface ScoreComparison {
    base: {
        passed: number;
        total: number;
    } | null;
    head: {
        passed: number;
        total: number;
    };
    /** Fewer items met than at the base, or any case that passed at the base and doesn't at the head. */
    dropped: boolean;
    /** The cap stopped it: not every case ran on both sides. */
    incomplete: boolean;
    changes: {
        id: string;
        title: string;
        base: CaseOutcome['outcome'] | 'new';
        head: CaseOutcome['outcome'];
    }[];
}
export interface EvalComparison extends ScoreComparison {
    target: string;
    /** The held-out set's comparison; null when there are no held-out cases (then the change can't pass). */
    heldOut: ScoreComparison | null;
    samples: number;
    costUsd: number;
}
/**
 * Base and head (null base: the instructions are new) on the visible cases and, when given, the held-out ones,
 * under one cost cap; 3 samples per case unless fewer are asked for. Held-out cases go last, so a cap that cuts the
 * run short leaves them incomplete, which never passes.
 */
export declare function compareInstructions(o: {
    target: string;
    baseText: string | null;
    headText: string;
    cases: EvalCase[];
    heldOut?: EvalCase[] | null;
    model: string;
    judge: string;
    samples?: number;
    capUsd: number;
    ask: Ask;
}): Promise<EvalComparison>;
/**
 * Whether a comparison clears the change: the held-out score decides. It must exist, run to the end and not drop;
 * a visible drop or an incomplete visible run holds it too. The visible score alone never passes a change.
 */
export declare function comparisonPasses(c: EvalComparison): boolean;
/** The report's line: both scores before -> after, the samples (noted when below the default), and the cost. */
export declare function comparisonLine(c: EvalComparison): string;
/** The per-case diff: only cases whose outcome isn't the same pass at both ends. */
export declare function comparisonDiff(c: EvalComparison): string[];
/** Instructions an agent works under, which a change can touch: a skill (in .claude/skills or the config folder's skills), AGENTS.md, a project's role prompt. */
export interface InstructionTarget {
    target: string;
    /** The instructions file, repo-relative. */
    file: string;
    /** Where its eval cases live, repo-relative. */
    cases: string;
    /** For a role: the engine's own cases, when the project has none. */
    role?: string;
}
/** The instruction targets a change touches (any file of a skill, including its cases, re-evaluates it). */
export declare function instructionTargets(changed: string[]): InstructionTarget[];
/** The engine's own eval cases for a role prompt (shipped with the engine), or null. */
export declare function engineRoleCases(role: string): string | null;

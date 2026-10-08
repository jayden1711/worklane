export interface EvalCase {
    id: string;
    title: string;
    situation: string;
    correct: string[];
    wrong: string[];
}
export declare function parseCases(md: string): EvalCase[];
export interface CaseResult {
    id: string;
    title: string;
    pass: boolean;
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
export declare function runSkillEval(skillDir: string, opts: {
    model: string;
    judge: string;
    only?: string[];
}): EvalResults;
/** Evaluated = results exist for this exact skill text and every case passed. */
export declare function skillStatus(skillDir: string): 'evaluated' | 'stale' | 'failing' | 'draft';

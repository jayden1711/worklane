/** The sections every SKILL.md must have, as headings (any level from ##), each non-empty. */
export declare const SKILL_SECTIONS: readonly ["When to use", "Inputs and access", "Steps", "Validate", "Return", "Approval"];
/** What is wrong with one SKILL.md's text ([] when it passes). */
export declare function lintSkill(text: string): string[];
/** Every tracked SKILL.md in a git checkout (forward-slash paths, relative to `root`). */
export declare function trackedSkills(root: string): string[];
/** Lint every tracked SKILL.md under `root`: the files that fail, each with its problems. */
export declare function lintSkills(root: string): {
    file: string;
    problems: string[];
}[];
/** One line per failing file, for a refusal or a report. */
export declare function skillLintReport(results: {
    file: string;
    problems: string[];
}[]): string;

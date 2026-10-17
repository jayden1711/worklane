import type { IntakeConfig } from './report.js';
export type IntakeCheck = {
    state: 'off';
    file: string;
} | {
    state: 'invalid';
    file: string;
    errors: string[];
} | {
    state: 'valid';
    file: string;
    summary: string[];
    warnings: string[];
};
/** What is on, a line per source. INVARIANT: only these fields of the file are ever printed (no ids of people). */
export declare function intakeSummary(c: IntakeConfig): string[];
/** Check one intake.yaml. Never throws: a file that can't be read is invalid, with why. */
export declare function checkIntakeFile(file: string): IntakeCheck;
export interface CheckCommandOptions {
    instance?: string | undefined;
    dir?: string;
    out?: (line: string) => void;
    err?: (line: string) => void;
}
/** The CLI command: pick the instance (as `discord channels` does), check its intake.yaml. Exit 0 valid or off, 1 invalid. */
export declare function intakeCheckCommand(o?: CheckCommandOptions): number;

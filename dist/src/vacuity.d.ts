export declare function stripComments(src: string): string;
export declare function countAssertions(src: string, pattern: string): number;
/** App files in which at least one non-top-level function ran. */
export declare function touchedAppFiles(coverageDir: string, root: string, appPaths: string[]): string[];
export interface VacuityReport {
    file: string;
    assertions: number;
    touched?: string[];
    ran?: {
        exitCode: number | null;
        error?: string;
    };
    vacuous: boolean;
    why: string[];
}
export declare function checkVacuity(root: string, file: string, opts: {
    assertionPattern: string;
    appPaths: string[];
    dynamic: boolean;
    runOne?: string | undefined;
}): VacuityReport;

import type { Backlog } from '../backlog/types.js';
import type { IncomingReport, IntakeConfig, IntakeSource } from './report.js';
export type GitHubIntakeConfig = IntakeConfig['github'];
export declare const INTAKE_LABEL: {
    readonly name: "worklane:intake";
    readonly color: "bfd4f2";
    readonly description: "Reported here: triaged by the intake, filed ready only when trusted or approved";
};
export declare class GitHubIssuesIntake {
    private o;
    readonly name: "github";
    private nextAt;
    constructor(o: {
        backlog: Pick<Backlog, 'list' | 'comment'>;
        stateDir: string;
        config: () => GitHubIntakeConfig;
        now?: () => number;
    });
    take(): Promise<IncomingReport[]>;
    reply(thread: NonNullable<IncomingReport['thread']>, text: string): Promise<boolean>;
    source(): IntakeSource;
}

interface Ev {
    type: string;
    ts: string;
    payload: unknown;
}
export interface IntakeReportRow {
    id: string;
    source: string;
    receivedAt: string;
    sender: string;
    kind: string | null;
    reproduction: string | null;
    outcome: 'filed' | 'awaiting_owner' | 'commented' | 'grouped' | 'replied' | 'asked_owner' | 'dropped' | 'rejected' | 'pending';
    issue: number | null;
    dropped: string | null;
    replies: string[];
    excerpt: string | null;
}
export interface IntakeHealth {
    perDay: {
        day: string;
        source: string;
        reports: number;
    }[];
    dropped: Record<string, number>;
    /** Minutes from a report to the merge of the fix for its issue, over reports whose fix merged. */
    reportToMerged: {
        count: number;
        medianMinutes: number | null;
    };
}
export declare function intakeReports(events: Ev[], limit?: number): IntakeReportRow[];
export declare function intakeHealth(events: Ev[], now?: Date, days?: number): IntakeHealth;
export {};

import type { IncomingReport, IntakeSource } from './report.js';
/** Leave a confirmed spoken idea for the coordinator. Returns its id. The caller has checked who and how. */
export declare function submitVoiceIntake(o: {
    stateDir: string;
    text: string;
    by: string;
    now?: Date;
}): {
    id: string;
};
/** The voice inbox as the coordinator's intake source. */
export declare class VoiceIntake {
    private o;
    readonly name: "voice";
    constructor(o: {
        stateDir: string;
    });
    take(): Promise<IncomingReport[]>;
    ack(ids: string[]): Promise<void>;
    /** Spoken ideas have no thread to reply into. */
    reply(): Promise<boolean>;
    source(): IntakeSource;
}
/**
 * Why the instance takes no spoken ideas, or null when it does: its intake.yaml (in the instance home) exists, is
 * valid and has voice.enabled. Read on every request, as the coordinator reads it on every pass.
 */
export declare function voiceIntakeRefusal(intakeFile: string | undefined): string | null;

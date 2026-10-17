/** The helper's PROTOCOL (a test keeps them alike). Bump both when a command's arguments or output change. */
export declare const EXP_PROTOCOL = 2;
export declare const EXP_HELPER: string;
/** A job's directory (its record, logs and outputs; the coordinator's group may read them). */
export declare const expJobDir: (instance: string, job: string) => string;
/** What one job asks for. Commands are the study's own; ids are root's approved sources; nothing else is a path. */
export interface JobSpec {
    STUDY: string;
    /** The scorer's sealed eval copy's tree hash (evalTreeHash): only the score step ever sees it. */
    EVAL: string;
    /** The predict step's own sealed copy (the study's eval.predict_files), or 'none'. Never the scorer's. */
    PREDICT_EVAL: string;
    /** What the result is: the scorer's score, or this helper's own timing of the train or predict step. */
    METRIC: 'score' | 'train_ms' | 'predict_ms';
    MINUTES: number;
    GPUS: number;
    OUTPUT_GB: number;
    /** How long it may wait for the GPU, in seconds (not counted against MINUTES). */
    WAIT_MAX: number;
    /** sha256 of the lockfile: the environment's cache key. */
    LOCK: string;
    DATA: string[];
    INPUTS: string;
    LABELS: string;
    BUILD: string;
    PREFLIGHT: string;
    TRAIN: string;
    PREDICT: string;
    SCORE: string;
    CONFIG: Record<string, string | number>;
    SEED: number;
}
/** The spec as the helper reads it on stdin: NAME=value, each then a NUL. Refused here when a value has a newline or NUL. */
export declare function specText(s: JobSpec): string;
/** An eval copy's tree hash, as the helper's tree_hash computes it: sha256 of "<sha256>  <path>" lines sorted by path. */
export declare function evalTreeHash(files: Record<string, Buffer | string>): string;
export interface RunRecord {
    protocol: number;
    job: string;
    outcome: 'scored' | 'crashed' | 'stopped';
    step: string | null;
    score: number | null;
    gpu_seconds: number;
    waited_s: number;
    gpus: number[];
    output_kb: number;
    /** The helper's own clock around each step (ms), never the job's. */
    timings: {
        train_ms: number;
        predict_ms: number;
        score_ms: number;
    };
}
/** The record line ("<cli>-exp: record <json>", the last of `job`'s stdout), or null when there is none or it's malformed. */
export declare function readRecord(stdout: string): RunRecord | null;

import { z } from 'zod';
export declare const STUDIES_FILE = "experiments.yaml";
/** A study's or a data source's id: also a path segment, a ref segment and an event key. */
export declare const ID: RegExp;
/** One knob a job may set. Values outside it are refused, never clamped. */
export declare const Knob: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"number">;
    min: z.ZodNumber;
    max: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"integer">;
    min: z.ZodNumber;
    max: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"enum">;
    values: z.ZodArray<z.ZodString>;
}, z.core.$strict>], "type">;
export type Knob = z.infer<typeof Knob>;
/**
 * What a study learns, all through one contract: the job writes predictions to its pred/ folder, and the scorer (its
 * own user and unit, no network) compares them with what only it can read: labels (supervised), hidden future targets
 * (self-supervised and world models), a fixed probe or hidden labels for embeddings or assignments (unsupervised), or
 * a fixed reference set and metric (generative).
 */
export declare const STUDY_KINDS: readonly ["supervised", "self_supervised", "unsupervised", "generative"];
/** Scoring that must run job-made code (an RL policy in an environment): not supported in this version. */
export declare const RL_ROLLOUT: "rl_rollout";
export declare const Study: z.ZodObject<{
    id: z.ZodString;
    goal: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<{
        supervised: "supervised";
        self_supervised: "self_supervised";
        unsupervised: "unsupervised";
        generative: "generative";
        rl_rollout: "rl_rollout";
    }>>;
    metric: z.ZodObject<{
        name: z.ZodString;
        direction: z.ZodEnum<{
            max: "max";
            min: "min";
        }>;
        min_delta: z.ZodDefault<z.ZodNumber>;
        source: z.ZodDefault<z.ZodEnum<{
            score: "score";
            train_ms: "train_ms";
            predict_ms: "predict_ms";
        }>>;
        anomaly_margin: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
    eval: z.ZodObject<{
        mode: z.ZodDefault<z.ZodLiteral<"split">>;
        predict: z.ZodString;
        score: z.ZodString;
        files: z.ZodArray<z.ZodString>;
        predict_files: z.ZodDefault<z.ZodArray<z.ZodString>>;
        inputs: z.ZodString;
        labels: z.ZodString;
    }, z.core.$strict>;
    train: z.ZodObject<{
        command: z.ZodString;
        data: z.ZodDefault<z.ZodArray<z.ZodString>>;
        env: z.ZodObject<{
            lockfile: z.ZodString;
            build: z.ZodString;
        }, z.core.$strict>;
        preflight: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    editable: z.ZodArray<z.ZodString>;
    config_schema: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"number">;
        min: z.ZodNumber;
        max: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"integer">;
        min: z.ZodNumber;
        max: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"enum">;
        values: z.ZodArray<z.ZodString>;
    }, z.core.$strict>], "type">>>;
    data_card: z.ZodDefault<z.ZodString>;
    job: z.ZodPrefault<z.ZodObject<{
        max_minutes: z.ZodDefault<z.ZodNumber>;
        gpus: z.ZodDefault<z.ZodNumber>;
        output_gb: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    budget: z.ZodObject<{
        gpu_hours_per_day: z.ZodNumber;
        agent_usd_per_day: z.ZodNumber;
        agent_usd_total: z.ZodNumber;
        max_jobs: z.ZodNumber;
    }, z.core.$strict>;
    exploration: z.ZodPrefault<z.ZodObject<{
        share: z.ZodDefault<z.ZodNumber>;
        near_miss: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    screen: z.ZodPrefault<z.ZodObject<{
        margin: z.ZodDefault<z.ZodNumber>;
        seeds: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    ladder: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        max_minutes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type Study = z.infer<typeof Study>;
export declare const StudiesFile: z.ZodObject<{
    version: z.ZodLiteral<1>;
    studies: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        goal: z.ZodString;
        kind: z.ZodDefault<z.ZodEnum<{
            supervised: "supervised";
            self_supervised: "self_supervised";
            unsupervised: "unsupervised";
            generative: "generative";
            rl_rollout: "rl_rollout";
        }>>;
        metric: z.ZodObject<{
            name: z.ZodString;
            direction: z.ZodEnum<{
                max: "max";
                min: "min";
            }>;
            min_delta: z.ZodDefault<z.ZodNumber>;
            source: z.ZodDefault<z.ZodEnum<{
                score: "score";
                train_ms: "train_ms";
                predict_ms: "predict_ms";
            }>>;
            anomaly_margin: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>;
        eval: z.ZodObject<{
            mode: z.ZodDefault<z.ZodLiteral<"split">>;
            predict: z.ZodString;
            score: z.ZodString;
            files: z.ZodArray<z.ZodString>;
            predict_files: z.ZodDefault<z.ZodArray<z.ZodString>>;
            inputs: z.ZodString;
            labels: z.ZodString;
        }, z.core.$strict>;
        train: z.ZodObject<{
            command: z.ZodString;
            data: z.ZodDefault<z.ZodArray<z.ZodString>>;
            env: z.ZodObject<{
                lockfile: z.ZodString;
                build: z.ZodString;
            }, z.core.$strict>;
            preflight: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        editable: z.ZodArray<z.ZodString>;
        config_schema: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"number">;
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"integer">;
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"enum">;
            values: z.ZodArray<z.ZodString>;
        }, z.core.$strict>], "type">>>;
        data_card: z.ZodDefault<z.ZodString>;
        job: z.ZodPrefault<z.ZodObject<{
            max_minutes: z.ZodDefault<z.ZodNumber>;
            gpus: z.ZodDefault<z.ZodNumber>;
            output_gb: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        budget: z.ZodObject<{
            gpu_hours_per_day: z.ZodNumber;
            agent_usd_per_day: z.ZodNumber;
            agent_usd_total: z.ZodNumber;
            max_jobs: z.ZodNumber;
        }, z.core.$strict>;
        exploration: z.ZodPrefault<z.ZodObject<{
            share: z.ZodDefault<z.ZodNumber>;
            near_miss: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        screen: z.ZodPrefault<z.ZodObject<{
            margin: z.ZodDefault<z.ZodNumber>;
            seeds: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        ladder: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            max_minutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type StudiesFile = z.infer<typeof StudiesFile>;
/** Every eval file of a study: the scorer's and the predict step's. No agent session ever sees any of them. */
export declare const evalFilesOf: (s: Study) => string[];
/** Every approved data source a study reads: what root's file must list for this instance before it can run. */
export declare function sourcesOf(s: Study): {
    job: string[];
    scorer: string[];
};
/** The same value whatever its keys' order: what a version is hashed over. */
export declare function canonical(v: unknown): string;
/**
 * A study's version: its definition, its eval files' sha256 and its data sources' sha256, as pinned when an owner
 * confirmed it. Any of them changing is a new version, and the best starts over.
 */
export declare function studyVersion(s: Study, evalFiles: Record<string, string>, sources: Record<string, string>): string;
/** Why a config can't run (the first problem), or null. Unknown keys and values outside a knob are refused. */
export declare function configRefusal(config: unknown, schema: Record<string, Knob>): string | null;

import { z } from 'zod';
export declare const PINS_FILE = "experiments.yaml";
export declare const Pin: z.ZodObject<{
    version: z.ZodString;
    commit: z.ZodString;
    eval_files: z.ZodRecord<z.ZodString, z.ZodString>;
    sources: z.ZodRecord<z.ZodString, z.ZodString>;
    started_by: z.ZodString;
    started_at: z.ZodString;
}, z.core.$strict>;
export type Pin = z.infer<typeof Pin>;
export declare const PinsFile: z.ZodObject<{
    version: z.ZodLiteral<1>;
    approve: z.ZodDefault<z.ZodObject<{
        above_gb: z.ZodNumber;
    }, z.core.$strict>>;
    studies: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        version: z.ZodString;
        commit: z.ZodString;
        eval_files: z.ZodRecord<z.ZodString, z.ZodString>;
        sources: z.ZodRecord<z.ZodString, z.ZodString>;
        started_by: z.ZodString;
        started_at: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type PinsFile = z.infer<typeof PinsFile>;
export declare const EMPTY_PINS: PinsFile;
/** The pins, or why they can't be read (a file anyone else can read or write is refused, as intake.yaml is). */
export declare function loadPins(file: string): {
    pins: PinsFile;
    text: string;
} | {
    error: string;
};
/** A change to the pins, as Review shows it: the lines before and after. */
export interface PinsPlan {
    before: string;
    after: string;
    next: PinsFile;
}
export declare function planPins(file: string, change: (p: PinsFile) => PinsFile): PinsPlan | {
    error: string;
};
/** Write a planned change, only if the file is still what the plan read (else: review again). */
export declare function applyPins(file: string, plan: PinsPlan): {
    ok: true;
} | {
    error: string;
};

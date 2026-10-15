import { IntakeConfig } from './report.js';
export declare const INTAKE_FILE = "intake.yaml";
/**
 * Load and check intake.yaml. Refused (`error`): unsafe permissions, bad YAML, or an invalid config, including a
 * trusted sender who isn't an allowed one. `errors` is the same refusal one problem at a time, each schema error
 * as "<path>: <message>" (`intake check` prints them). `warnings`: valid but probably not meant (Discord on,
 * nobody allowed).
 */
export declare function loadIntakeConfig(path: string): {
    config: IntakeConfig;
    warnings: string[];
} | {
    error: string;
    errors: string[];
} | null;

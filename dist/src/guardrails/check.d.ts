import type { GuardrailsConfig } from '../config/schema.js';
import { type Decision, type EvalContext } from './engine.js';
export interface CheckProblem {
    kind: 'expected_block' | 'expected_ask' | 'expected_allow' | 'untested_rule';
    example?: string;
    got?: Decision;
    rule?: string;
    message: string;
}
/** A context built only from the config's example fixtures: no real secrets, no real link files. */
export declare function exampleContext(cfg: GuardrailsConfig, root: string, agent: boolean): EvalContext;
export declare function checkGuardrails(cfg: GuardrailsConfig, root?: string): CheckProblem[];

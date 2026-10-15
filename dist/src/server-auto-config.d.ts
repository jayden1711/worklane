import { type AutoConfigResult, type AutoConfigState, type RunResult } from './auto-config.js';
import { type PolicyFile } from './instance.js';
type Fetch = typeof fetch;
export declare const githubApiBase: () => string;
/**
 * The few gh calls auto-config makes, answered over GitHub's REST API with an installation token: the default
 * branch, a PR's state, the open PR from a branch, opening a PR. `api user` has no answer (an App's token has no
 * user). Anything else is refused, so a new call can't slip through unanswered.
 */
export declare function ghOverRest(repo: string, token: () => Promise<string>, api?: string, fetchImpl?: Fetch): (args: string[]) => Promise<RunResult>;
/** Fit a drafted config folder to an instance's policy: the daily budget and the worker count no higher than it allows. */
export declare function fitToPolicy(cfgDir: string, policy: PolicyFile): void;
export declare const serverAutoConfigFile: (stateDir: string) => string;
export declare function readServerAutoConfig(stateDir: string): AutoConfigState;
export interface ServerAutoConfigLine {
    kind: AutoConfigResult['kind'];
    detail: string;
    /** The setup PR, once proposed. */
    pr: string | null;
    /** The open questions' ids, with the command that answers them. */
    questions: string[];
}
/** Run auto-config for an instance, as its coordinator user: one line saying where it stands. */
export declare function serverAutoConfig(name: string, o?: {
    answers?: Record<string, string>;
    timeoutMs?: number;
    fetchImpl?: Fetch;
    owner?: string;
}): Promise<ServerAutoConfigLine>;
export {};

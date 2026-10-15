import { type SimpleCommand } from './shell.js';
/** The hatch: set to 1 in a person's own shell, for one push. */
export declare const PUSH_GATE_HATCH_ENV = "PUSH_GATE_BOOTSTRAP";
/** `env` without the hatch (any spelling of its case). The same object, for chaining. */
export declare function withoutPushGateHatch<T extends Record<string, string | undefined>>(env: T): T;
export interface PushHookRefusal {
    rule: 'push-gate-hatch' | 'push-hook-bypass';
    reason: string;
}
/** Whether writing `path` (as given, and as resolved against the call's directory) changes git's hooks or config. */
export declare function isGitHooksOrConfigPath(path: string, resolved: string): boolean;
/**
 * Why an agent's shell command may not run: it sets, exports, passes or stores the hatch, or it skips or swaps the
 * pre-push hook (`push --no-verify`, core.hooksPath by -c, config or environment, a write into a hooks dir or a git
 * config file). `resolve` turns a written path into an absolute one.
 */
export declare function pushHookShellRefusal(command: string, commands: SimpleCommand[], resolve: (p: string) => string): PushHookRefusal | null;
/**
 * Why an agent's Edit/Write may not run: the file is a git hooks dir or config file, or it is a file a later shell or
 * push takes its environment from (a shell rc, .env, an environment.d entry) and the new text names the hatch.
 */
export declare function pushHookFileRefusal(path: string, resolved: string, input: Record<string, unknown>): PushHookRefusal | null;

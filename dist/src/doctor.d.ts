import { fileAccess, userUid } from './os/index.js';
import { type InitIo, type Mode } from './init.js';
import { type SetupContext, type SetupProbe } from './setup-steps.js';
/** off: not available in this setup's mode (said why; never a failure). */
export type Level = 'ok' | 'warn' | 'fail' | 'off';
export interface DoctorCheck {
    name: string;
    level: Level;
    detail: string;
}
/**
 * An instance's agent API key file (credentials.yaml agent_api_key): present, owned by the agent user, and open to
 * nobody else (no group or other bits). The file is never read. The coordinator user normally can't even see it
 * (it lives in the agent user's home), which is right: then this says to run doctor as root to check the mode.
 */
export declare function apiKeyCheck(file: string, agentUser: string | null, access?: typeof fileAccess, uidOf?: typeof userUid): {
    level: Level;
    detail: string;
};
export declare function doctor(rootArg: string, opts?: {
    agentshield?: boolean; /** A policy.yaml to check the config against, besides any local instance's. */
    policy?: string; /** An instance whose agent settings to check, besides those of any local instance running this repo. */
    instance?: string; /** The setup's mode, when init's state doesn't say (or to see another's). */
    mode?: Mode; /** For tests: init's world. */
    initIo?: InitIo;
}): DoctorCheck[];
/**
 * The setup steps (src/setup-steps.ts), as doctor shows them: every step that applies to the mode, checked live, the
 * same checks and the same done or not done as the dashboard's first-run page. Then what the mode can't do, each
 * with why. When init was never run and no mode is given, one line saying how to get the checklist.
 */
export declare function setupChecks(root: string, opts: {
    instance?: string;
    mode?: Mode;
    initIo?: InitIo;
    probe?: SetupProbe;
    context?: Partial<Pick<SetupContext, 'machine' | 'instanceFacts'>>;
}): DoctorCheck[];
/** AgentShield scan of hooks, MCP config and permissions (MIT, run via npx). */
export declare function agentShield(root: string): DoctorCheck;

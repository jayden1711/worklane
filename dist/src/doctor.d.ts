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
    initIo?: InitIo; /** For tests: the disk's free and total GB at a path. */
    disk?: (path: string) => {
        freeGb: number;
        totalGb: number;
    };
}): DoctorCheck[];
/**
 * GPU test runs (docs/test-runs.md "GPU"): nothing while root's file is absent (off). On for some instance but a node
 * its runs need is missing (the driver not loaded, a GPU index that isn't there): a warning, since each of those runs
 * then runs without the GPU. A file the helper would refuse: a warning too, saying so.
 */
export declare function gpuCheck(file?: string, present?: (path: string) => boolean, rootUid?: number, nodes?: (indices: number[]) => string[]): DoctorCheck | null;
/**
 * Network for test runs (docs/test-runs.md "Network"), read-only: no tier has it unless root's file lists it. Which
 * instances' tiers do, with the root command that changes it; a file the helper would refuse is a warning.
 */
export declare function networkCheck(file?: string, rootUid?: number): DoctorCheck;
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

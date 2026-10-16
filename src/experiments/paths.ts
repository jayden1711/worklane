// Where experiment jobs' state and root's experiment files live, apart from the rest so the hook (run on every tool
// call) loads only this. Every agent session is denied them by guardrail as well as by their owners and modes.
import { etcPath, expBasePath } from '../os/system-paths.js';

/** The jobs' state (eval copies, data, outputs, records) and root's files: never an agent's to read. */
export const expSecretGlobs = (): string[] => [`${expBasePath()}/**`, `${etcPath('experiments')}/**`];

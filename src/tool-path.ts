// Where the engine finds the tools it runs (gitleaks, claude, gh, ...): PATH, then the bin folder under the prefix
// that local init installs into (~/.local by default; <ENV>_PREFIX overrides it). A tool init installed there is
// found even when that folder isn't on the person's PATH, and in processes that never had their shell's PATH
// (hooks, the service). PATH comes first, so a tool someone installed themselves wins. One resolver for doctor,
// init's checklist, the secret scans and the services' PATH.
import { delimiter, join } from 'node:path';
import { BRAND } from './brand.js';
import { homeDir, which } from './os/index.js';

/** Where local init installs tools and the engine (bin/ under it). */
export const toolPrefix = (env: NodeJS.ProcessEnv = process.env) => env[`${BRAND.envPrefix}_PREFIX`] || join(homeDir(), '.local');

export const toolBin = (env: NodeJS.ProcessEnv = process.env) => join(toolPrefix(env), 'bin');

/** PATH with the prefix's bin at the end, unless it's there already. */
export function toolPath(path: string = process.env.PATH ?? '', env: NodeJS.ProcessEnv = process.env): string {
  const bin = toolBin(env);
  const dirs = path.split(delimiter).filter(Boolean);
  return dirs.includes(bin) ? dirs.join(delimiter) : [...dirs, bin].join(delimiter);
}

/** A tool's full path: on PATH, else in the prefix's bin; null when in neither. */
export const findTool = (cmd: string, env: NodeJS.ProcessEnv = process.env) => which(cmd, toolPath(env.PATH ?? '', env));

/** An environment for running tools by name: `env` with PATH reaching the prefix's bin too. */
export const withToolPath = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, PATH: toolPath(env.PATH ?? '', env) });

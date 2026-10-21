// Where the engine finds the tools it runs (gitleaks, claude, gh, ...): PATH, then the bin folder under the prefix
// that local init installs into (~/.local by default; <ENV>_PREFIX overrides it). A tool init installed there is
// found even when that folder isn't on the person's PATH, and in processes that never had their shell's PATH
// (hooks, the service). PATH comes first, so a tool someone installed themselves wins. One resolver for doctor,
// init's checklist, the secret scans and the services' PATH.
import { delimiter, join } from 'node:path';
import { BRAND } from './brand.js';
import { homeDir, which } from './os/index.js';
import { ownEnv, type EnvSource } from './os/own-env.js';

/** Where local init installs tools and the engine (bin/ under it). */
export const toolPrefix = (env: EnvSource = process.env) => ownEnv(env).get(`${BRAND.envPrefix}_PREFIX`) || join(homeDir(), '.local');

export const toolBin = (env: EnvSource = process.env) => join(toolPrefix(env), 'bin');

/** PATH with the prefix's bin at the end, unless it's there already. */
export function toolPath(path: string = ownEnv().get('PATH') ?? '', env: EnvSource = process.env): string {
  const bin = toolBin(env);
  const dirs = path.split(delimiter).filter(Boolean);
  return dirs.includes(bin) ? dirs.join(delimiter) : [...dirs, bin].join(delimiter);
}

/** A tool's full path: on PATH, else in the prefix's bin; null when in neither. */
export const findTool = (cmd: string, env: EnvSource = process.env) => {
  const own = ownEnv(env);
  return which(cmd, toolPath(own.get('PATH') ?? '', own));
};

/** An environment for running tools by name: `env` with PATH reaching the prefix's bin too (a spread copies own variables only). */
export const withToolPath = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const own = ownEnv(env);
  return { ...env, PATH: toolPath(own.get('PATH') ?? '', own) };
};

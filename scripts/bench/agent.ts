// The bench's agents (#748): the engine's own runner and claude, on the host, as the bench user, in the engine's
// sandbox. The bench user's home holds its claude login and its rootless Docker daemon can mount anything that user
// can read, so an agent gets neither (owner's update, 2026-10-18): its commands and its Read tool are denied the
// login and credential stores, XDG_RUNTIME_DIR (the daemon's socket and the user bus) and the system sockets, and
// its environment carries no DOCKER_*, XDG_RUNTIME_DIR or bus address (agentBase, auth.ts). Its commands reach no
// host (allowedDomains empty): model traffic is claude's own, outside the sandbox.
import { join } from 'node:path';
import { CliRunner, type AgentRunner } from '../../src/runner.js';
import { homeCredentialStores, sandboxSettings } from '../../src/sandbox.js';
import { agentBase, BenchAgentRunner } from './auth.js';
import { credentialPlaces } from './paths.js';

/** The runtime dir (the daemon's socket and the user bus live there). */
export const runtimeDir = (env: NodeJS.ProcessEnv, uid: number = process.getuid?.() ?? -1): string => env.XDG_RUNTIME_DIR || `/run/user/${uid}`;

/** The lane every bench agent run gets: its sandbox, and what it denies. */
export function benchLane(o: { home: string; runtimeDir: string; heldOut: string; state: string }) {
  return {
    settings: sandboxSettings({
      lane: { allowedDomains: [] },
      denyRead: [...credentialPlaces(o.home), ...homeCredentialStores(o.home), o.runtimeDir, join(o.runtimeDir, 'docker.sock'), '/run/docker.sock', '/var/run/docker.sock', o.state, o.heldOut],
    }),
  };
}

/** The bench's agents as the driver builds them: the engine's runner, on agentBase, in benchLane's sandbox. */
export function benchClaude(env: NodeJS.ProcessEnv, bin: string, lane: ReturnType<typeof benchLane>): AgentRunner {
  return new BenchAgentRunner(new CliRunner('cli', agentBase(env), bin, undefined, { default: lane }));
}

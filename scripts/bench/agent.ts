// The bench's agents (#748): the engine's own runner and claude, on the host, as the bench user, in the engine's
// sandbox. The bench user's home holds its claude login and its rootless Docker daemon can mount anything that user
// can read, so an agent gets neither (owner's update, 2026-10-18): its commands and its Read tool are denied the
// login and credential stores, XDG_RUNTIME_DIR (the daemon's socket and the user bus), the system sockets, a unix
// DOCKER_HOST's socket and the rootless daemon's data root (its containers' layers, a grading container's hidden tests
// included), and its environment carries no DOCKER_*, XDG_RUNTIME_DIR or bus address (agentBase, auth.ts). Its
// commands reach no host (allowedDomains empty): model traffic is claude's own, outside the sandbox. No retry: a
// failed run is the bench's to record, never to wait out (a usage or rate limit stops the bench: usage.ts).
import { join } from 'node:path';
import { CliRunner, type AgentRunner, type RetryOptions } from '../../src/runner.js';
import { homeCredentialStores, sandboxSettings, withDeniedReads } from '../../src/sandbox.js';
import { agentBase, BenchAgentRunner } from './auth.js';
import { credentialPlaces } from './paths.js';

/** The runtime dir (the daemon's socket and the user bus live there). */
export const runtimeDir = (env: NodeJS.ProcessEnv, uid: number = process.getuid?.() ?? -1): string => env.XDG_RUNTIME_DIR || `/run/user/${uid}`;

/** The socket a `unix://` DOCKER_HOST names, if it names one. */
export const dockerHostSocket = (dockerHost: string | undefined): string | null => {
  const m = /^unix:\/\/(\/.+)$/.exec(dockerHost ?? '');
  return m ? m[1]! : null;
};

export interface LaneInput {
  home: string;
  runtimeDir: string;
  heldOut: string;
  state: string;
  /** The bench user's DOCKER_HOST, if set: a unix socket it names is denied too. */
  dockerHost?: string | undefined;
  /** The bench user's XDG_DATA_HOME, if set: the rootless daemon's data root is under it. */
  dataHome?: string | undefined;
}

/** Every path a bench agent may not read: what benchLane denies its commands and its Read tool. */
export function benchDenied(o: LaneInput): string[] {
  const socket = dockerHostSocket(o.dockerHost);
  return [
    ...credentialPlaces(o.home),
    ...homeCredentialStores(o.home),
    o.runtimeDir,
    join(o.runtimeDir, 'docker.sock'),
    '/run/docker.sock',
    '/var/run/docker.sock',
    ...(socket ? [socket] : []),
    join(o.home, '.local', 'share', 'docker'),
    ...(o.dataHome ? [join(o.dataHome, 'docker')] : []),
    o.state,
    o.heldOut,
  ];
}

/**
 * The lane every bench agent run gets: its sandbox, and what it denies. Built with the engine's withDeniedReads, so the
 * Read tool gets both rule forms for each path: `Read(//p/**)` for what is inside a folder and `Read(//p)` for the
 * path itself (a file such as ~/.claude.json or ~/.netrc matches only the second).
 */
export function benchLane(o: LaneInput) {
  return { settings: withDeniedReads(sandboxSettings({ lane: { allowedDomains: [] }, denyRead: [] }), [...new Set(benchDenied(o))]) };
}

/** The bench's runs are tried once: no wait on a transient error (CliRunner's retry, off). */
export const NO_RETRY: RetryOptions = { budgetMs: 0 };

/** The bench's agents as the driver builds them: the engine's runner, on agentBase, in benchLane's sandbox, no retry. */
export function benchClaude(env: NodeJS.ProcessEnv, bin: string, lane: ReturnType<typeof benchLane>): AgentRunner {
  return new BenchAgentRunner(new CliRunner('cli', agentBase(env), bin, undefined, { default: lane }, undefined, NO_RETRY));
}

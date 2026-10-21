// How an approved MCP server is started: its approved code (root's store), inside its own sandbox (sandboxed.ts), with
// an environment of a minimal PATH and HOME and its own secrets only, never the broker's or anyone else's.
import { spawn, type ChildProcess } from '../os/child-process.js';
import { chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpRuntime } from '../plugins/approval.js';
import type { SandboxedConfig } from './sandboxed.js';

const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';
export const SERVER_PATH = '/usr/local/bin:/usr/bin:/bin';

/** The argv as it runs: ${CLAUDE_PLUGIN_ROOT} resolved to the approved code directory, nothing else expanded. */
export function resolveArgv(runtime: McpRuntime, codeDir: string): string[] {
  return runtime.argv.map((a) => a.split(ROOT_VAR).join(codeDir));
}

export interface LaunchOptions {
  /** The engine's own cli.js and the node that runs it (root-owned, /opt and /usr/local/bin). */
  engineCli: string;
  node: string;
  runtime: McpRuntime;
  codeDir: string;
  /** Its own secrets, by name. Never anyone else's. */
  secrets: Record<string, string>;
  network: string[];
  /** A directory of its own to write in, made fresh for this start. */
  scratchDir: string;
  /** Paths it may not read even where the OS would let it: every server's secrets, the broker's state. */
  denyRead: string[];
  /** Start as this user (root starting a quarantine run as the broker's user); unset: as this process. */
  as?: { uid: number; gid: number };
  /** Test seam: start without the sandbox. Never set by the broker or plugins.sh. */
  unsandboxed?: boolean;
}

export function launchServer(o: LaunchOptions): ChildProcess {
  mkdirSync(o.scratchDir, { recursive: true, mode: 0o700 });
  if (o.as) chownSync(o.scratchDir, o.as.uid, o.as.gid);
  const argv = resolveArgv(o.runtime, o.codeDir);
  const env = { PATH: SERVER_PATH, HOME: o.scratchDir, TMPDIR: o.scratchDir, LANG: 'C.UTF-8', ...o.secrets };
  const opts = { cwd: o.codeDir, env, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], ...(o.as ? { uid: o.as.uid, gid: o.as.gid } : {}) };
  if (o.unsandboxed) return spawn(argv[0]!, argv.slice(1), opts);
  const cfg: SandboxedConfig = { allowedDomains: o.network, denyRead: o.denyRead, allowWrite: [o.scratchDir], cwd: o.codeDir };
  const file = join(o.scratchDir, '.sandbox.json');
  writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  if (o.as) chownSync(file, o.as.uid, o.as.gid);
  return spawn(o.node, [o.engineCli, 'mcp-sandboxed', file, '--', ...argv], opts);
}

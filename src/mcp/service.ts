// `<cli> mcp-broker --instance <name>`: the instance's MCP broker, as its unit runs it (scripts/setup/mcp-broker.sh:
// <cli>-mcp@<name>.service, User=wl-<name>-mcp). Never as root, never as the coordinator or an agent: it refuses
// unless it runs as that one user.
import { chmodSync, chownSync, readFileSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllowlist, type McpRecord } from '../plugins/approval.js';
import { mcpCodeDir, NPM_TREE_LIMITS } from '../plugins/root-ops.js';
import { treeHash } from '../plugins/tree.js';
import { mcpRunPath, mcpStatePath } from '../os/system-paths.js';
import { groupGid } from '../os/index.js';
import { Broker } from './broker.js';
import { BROKER_SOCKET, CONTROL_SOCKET } from './connector.js';
import { launchServer } from './launch.js';

/** The broker's user and its two socket groups, for instance `name` (scripts/setup/mcp-broker.sh makes them). */
export const brokerUser = (name: string) => `wl-${name}-mcp`;
export const clientGroup = (name: string) => `wl-${name}-mcpc`;
export const controlGroup = (name: string) => `wl-${name}-mcpctl`;

/** A secret file: 0400, the broker user's own, in its own 0700 directory per server. */
export function readSecretFile(home: string, id: string, name: string): string | null {
  try {
    return readFileSync(join(home, 'secrets', id, name), 'utf8').replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

export async function runBroker(instance: string): Promise<number> {
  const me = userInfo().username;
  if (me !== brokerUser(instance)) {
    process.stderr.write(`mcp-broker for ${instance} runs as ${brokerUser(instance)} only (this is ${me})\n`);
    return 2;
  }
  const home = homedir();
  const engineCli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const stateDir = mcpStatePath(instance, 'state');
  const broker = new Broker({
    servers: () => {
      try {
        return readAllowlist(instance).entries.flatMap((e) => (e.record.kind === 'mcp' ? [e.record] : []));
      } catch (e) {
        process.stderr.write(`allowlist: ${(e as Error).message}; serving nothing\n`);
        return [];
      }
    },
    secret: (id, name) => readSecretFile(home, id, name),
    launch: (r: McpRecord, secrets, sessionId) => {
      const codeDir = mcpCodeDir(instance, r.id, r.runtime);
      const got = treeHash(codeDir, r.runtime.type === 'npm' ? NPM_TREE_LIMITS : undefined);
      if (got !== r.runtime.tree) throw new Error(`${r.id}: its approved code at ${codeDir} changed on disk`);
      const scratchDir = join('/tmp', `mcp-${r.id}-${sessionId}`);
      const child = launchServer({ engineCli, node: process.execPath, runtime: r.runtime, codeDir, secrets, network: r.network, scratchDir, denyRead: [join(home, 'secrets'), mcpStatePath(instance, '')] });
      child.on('exit', () => rmSync(scratchDir, { recursive: true, force: true }));
      return child;
    },
    stateDir,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const client = mcpRunPath(instance, BROKER_SOCKET);
  const control = mcpRunPath(instance, CONTROL_SOCKET);
  const servers = broker.listen(client, control);
  await Promise.all([servers.client, servers.control].map((s) => new Promise<void>((resolve) => s.on('listening', () => resolve()))));
  // Only the instance's agent user opens the client socket; only its coordinator the control socket.
  for (const [p, g] of [[client, clientGroup(instance)], [control, controlGroup(instance)]] as const) {
    const gid = groupGid(g);
    if (gid === null) {
      process.stderr.write(`no group ${g}: run mcp-broker.sh ${instance}\n`);
      return 1;
    }
    chownSync(p, -1, gid);
    chmodSync(p, 0o660);
  }
  process.stderr.write(`mcp broker for ${instance}: listening\n`);
  return new Promise(() => {});
}

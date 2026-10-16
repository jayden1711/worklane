// The coordinator's side of the broker: register a run's ticket (its role, how long it may live) and end it when the
// run ends, over the broker's control socket (0660, the instance's mcpctl group: its coordinator and the broker only).
// What the run then gets: the --mcp-config naming the connector once per approved server, the exact tool names for
// --allowedTools, and the allowedMcpServers lock that admits those connector command lines and nothing else.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { mcpRunPath } from '../os/system-paths.js';
import { connectorArgv, CONTROL_SOCKET, TICKET_VAR } from './connector.js';

export interface McpRun {
  ticket: string;
  servers: { id: string; tools: string[] }[];
}

function ask(path: string, line: object, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let buf = '';
    const t = setTimeout(() => (sock.destroy(), reject(new Error('the MCP broker did not answer'))), timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(t);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch {
        reject(new Error('the MCP broker answered something else'));
      }
    });
    sock.on('error', (e) => (clearTimeout(t), reject(e)));
  });
}

/**
 * A ticket for one run of `role`, and the approved, unblocked servers it may use. Null when the instance has no broker
 * (no MCP servers set up): the run gets none. A broker that is there but refuses or fails is an error: the run doesn't
 * start, rather than start without servers the owner approved silently.
 */
export async function registerRun(instance: string, role: string, ttlMs: number, path = mcpRunPath(instance, CONTROL_SOCKET)): Promise<McpRun | null> {
  if (!existsSync(path)) return null;
  const ticket = randomBytes(32).toString('hex');
  const r = await ask(path, { op: 'add', ticket, role, ttlMs });
  if (r.ok !== true) throw new Error(`the MCP broker refused the run: ${String(r.error ?? 'no reason')}`);
  const servers = Array.isArray(r.servers) ? (r.servers as { id: string; tools: string[] }[]).filter((s) => typeof s.id === 'string' && Array.isArray(s.tools)) : [];
  return { ticket, servers };
}

export async function endRun(instance: string, ticket: string, path = mcpRunPath(instance, CONTROL_SOCKET)): Promise<void> {
  try {
    await ask(path, { op: 'remove', ticket });
  } catch {
    // the ticket expires on its own
  }
}

/** Claude Code's name for an MCP tool: mcp__<server>__<tool>, any character outside A-Z a-z 0-9 _ - as _. */
export const toolName = (server: string, tool: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** What a run with MCP servers passes to claude. */
export function mcpRunArgs(instance: string, run: McpRun, node: string, engineCli: string): { config: object; allowedTools: string[]; allowedMcpServers: { serverCommand: string[] }[]; names: string[] } {
  const mcpServers: Record<string, object> = {};
  for (const s of run.servers) {
    const [command, ...args] = connectorArgv(node, engineCli, instance, s.id);
    mcpServers[s.id] = { type: 'stdio', command, args, env: { [TICKET_VAR]: run.ticket } };
  }
  return {
    config: { mcpServers },
    allowedTools: run.servers.flatMap((s) => s.tools.map((t) => toolName(s.id, t))),
    allowedMcpServers: run.servers.map((s) => ({ serverCommand: connectorArgv(node, engineCli, instance, s.id) })),
    names: run.servers.map((s) => s.id),
  };
}

/** The broker's blocked servers (the Plugins page): null when the instance has no broker or it doesn't answer. */
export async function brokerStatus(instance: string, path = mcpRunPath(instance, CONTROL_SOCKET)): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const r = await ask(path, { op: 'status' });
    return r.ok === true && r.blocked && typeof r.blocked === 'object' ? (r.blocked as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

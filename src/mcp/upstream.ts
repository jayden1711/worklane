// The broker's side of one upstream MCP server: started for one client session, handshaken as an MCP client, its
// tools listed (every page) into a snapshot. Nothing from the agent reaches it but approved tool calls; nothing from it
// reaches the agent but those calls' results. Its requests to the client (sampling, elicitation, roots) are refused.
import type { ChildProcess } from 'node:child_process';
import { LineChannel, type RpcMessage } from './jsonrpc.js';
import { snapshotOf, type Snapshot } from './snapshot.js';

/** The protocol revision the broker speaks to servers (MCP 2025-11-25). */
export const UPSTREAM_PROTOCOL = '2025-11-25';
const MAX_PAGES = 50;

export interface Upstream {
  child: ChildProcess;
  channel: LineChannel;
  snapshot: Snapshot;
  /** Called when the server says its tools changed: the broker re-lists and compares. */
  onListChanged: () => void;
  list(): Promise<Snapshot>;
  call(name: string, args: unknown, timeoutMs: number): Promise<unknown>;
  stop(): void;
}

/** Handshake with a started server (stdio) and list its tools. Rejects when it doesn't answer as an MCP server. */
export async function connectUpstream(child: ChildProcess, o: { clientName: string; timeoutMs?: number }): Promise<Upstream> {
  if (!child.stdout || !child.stdin) throw new Error('the server has no stdio');
  const channel = new LineChannel(child.stdout, child.stdin);
  let initResult: { serverInfo?: { name?: unknown }; instructions?: unknown } | null = null;
  const up: Upstream = {
    child,
    channel,
    snapshot: { serverName: null, instructions: null, tools: [] },
    onListChanged: () => {},
    async list() {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = (await channel.request('tools/list', cursor ? { cursor } : {}, o.timeoutMs)) as { tools?: unknown[]; nextCursor?: unknown };
        tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
        if (typeof r?.nextCursor !== 'string' || !r.nextCursor) return snapshotOf(initResult, tools);
        cursor = r.nextCursor;
      }
      throw new Error(`more than ${MAX_PAGES} pages of tools`);
    },
    call: (name, args, timeoutMs) => channel.request('tools/call', { name, arguments: args ?? {} }, timeoutMs),
    stop() {
      channel.close('stopped');
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2000).unref();
    },
  };
  channel.onMessage = (m: RpcMessage) => {
    if (m.method === 'notifications/tools/list_changed') return up.onListChanged();
    // A server's own requests (sampling, elicitation, roots/list): never forwarded, always refused.
    if (m.method !== undefined && m.id !== undefined && m.id !== null) channel.send({ id: m.id, error: { code: -32601, message: 'not available through this broker' } });
  };
  child.on('exit', () => channel.close('the server exited'));
  initResult = (await channel.request('initialize', { protocolVersion: UPSTREAM_PROTOCOL, capabilities: {}, clientInfo: { name: o.clientName, version: '1' } }, o.timeoutMs)) as typeof initResult;
  channel.send({ method: 'notifications/initialized' });
  up.snapshot = await up.list();
  return up;
}

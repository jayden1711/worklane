import { LineChannel } from './jsonrpc.js';
import { snapshotOf } from './snapshot.js';
/** The protocol revision the broker speaks to servers (MCP 2025-11-25). */
export const UPSTREAM_PROTOCOL = '2025-11-25';
const MAX_PAGES = 50;
/** Handshake with a started server (stdio) and list its tools. Rejects when it doesn't answer as an MCP server. */
export async function connectUpstream(child, o) {
    if (!child.stdout || !child.stdin)
        throw new Error('the server has no stdio');
    const channel = new LineChannel(child.stdout, child.stdin);
    let initResult = null;
    const up = {
        child,
        channel,
        snapshot: { serverName: null, instructions: null, tools: [] },
        onListChanged: () => { },
        async list() {
            const tools = [];
            let cursor;
            for (let page = 0; page < MAX_PAGES; page++) {
                const r = (await channel.request('tools/list', cursor ? { cursor } : {}, o.timeoutMs));
                tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
                if (typeof r?.nextCursor !== 'string' || !r.nextCursor)
                    return snapshotOf(initResult, tools);
                cursor = r.nextCursor;
            }
            throw new Error(`more than ${MAX_PAGES} pages of tools`);
        },
        call: (name, args, timeoutMs) => channel.request('tools/call', { name, arguments: args ?? {} }, timeoutMs),
        stop() {
            channel.close('stopped');
            try {
                child.kill('SIGTERM');
            }
            catch {
                // already gone
            }
            setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // already gone
                }
            }, 2000).unref();
        },
    };
    channel.onMessage = (m) => {
        if (m.method === 'notifications/tools/list_changed')
            return up.onListChanged();
        // A server's own requests (sampling, elicitation, roots/list): never forwarded, always refused.
        if (m.method !== undefined && m.id !== undefined && m.id !== null)
            channel.send({ id: m.id, error: { code: -32601, message: 'not available through this broker' } });
    };
    child.on('exit', () => channel.close('the server exited'));
    initResult = (await channel.request('initialize', { protocolVersion: UPSTREAM_PROTOCOL, capabilities: {}, clientInfo: { name: o.clientName, version: '1' } }, o.timeoutMs));
    channel.send({ method: 'notifications/initialized' });
    up.snapshot = await up.list();
    return up;
}
//# sourceMappingURL=upstream.js.map
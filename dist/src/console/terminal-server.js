import { WebSocketServer } from 'ws';
import { openTerminal } from './terminal.js';
import { deviceRefusal } from './terminal-devices.js';
import { TERMINAL_PROTOCOL } from '../dashboard-auth.js';
import { keyInUrl } from '../dashboard-key-url.js';
export const TERMINAL_PATH = '/api/terminal';
const MAX_INPUT = 64 * 1024;
/** Whether the request's Origin is the host it was sent to (a browser always sends Origin on a WebSocket). */
export function sameOrigin(req) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host)
        return false;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
/** Serve the terminal on this server's upgrades to TERMINAL_PATH; others are refused. Returns a closer. */
export function attachTerminal(server, o) {
    // Answer with the terminal's own subprotocol only: never the one that carries the CSRF token.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT, handleProtocols: (offered) => (offered.has(TERMINAL_PROTOCOL) ? TERMINAL_PROTOCOL : false) });
    const open = new Set();
    const onUpgrade = (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // A key in the URL is refused here too, before anything else is read or recorded from it.
        if (keyInUrl(url)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
            return;
        }
        const instance = url.searchParams.get('instance') ?? '';
        const refused = (why) => o.audit.record({ at: new Date((o.now ?? Date.now)()).toISOString(), login: '', instance, kind: 'refused', why });
        if (url.pathname !== TERMINAL_PATH || !sameOrigin(req)) {
            if (url.pathname === TERMINAL_PATH)
                refused(`a terminal request from another origin (${String(req.headers.origin ?? 'none').slice(0, 100)})`);
            socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            const say = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
            if (!o.instances.includes(instance)) {
                const why = `no instance ${instance || '(none)'} in this hub`;
                refused(why);
                say({ type: 'refused', why });
                return ws.close(1008);
            }
            const cols = Number(url.searchParams.get('cols')) || 80;
            const rows = Number(url.searchParams.get('rows')) || 24;
            const t = openTerminal({
                session: o.session(req, instance),
                instance,
                config: o.config,
                audit: o.audit,
                device: () => deviceRefusal(req, o.devices),
                send: (data) => say({ type: 'output', data }),
                closed: (why) => {
                    say({ type: 'closed', why });
                    ws.close(1000);
                },
                size: { cols, rows },
                ...(o.spawnPty ? { spawnPty: o.spawnPty } : {}),
                ...(o.exec ? { exec: o.exec } : {}),
                ...(o.now ? { now: o.now } : {}),
                ...(o.idleMs ? { idleMs: o.idleMs } : {}),
            });
            if ('refused' in t) {
                say({ type: 'refused', why: t.refused });
                return ws.close(1008);
            }
            open.add(t);
            ws.on('message', (raw) => {
                let m;
                try {
                    m = JSON.parse(String(raw));
                }
                catch {
                    return;
                }
                if (m.type === 'input' && typeof m.data === 'string')
                    t.input(m.data);
            });
            ws.on('close', () => {
                open.delete(t);
                t.close('the page closed the terminal');
            });
        });
    };
    server.on('upgrade', onUpgrade);
    return () => {
        server.off('upgrade', onUpgrade);
        for (const t of open)
            t.close('the hub stopped');
        wss.close();
    };
}
//# sourceMappingURL=terminal-server.js.map
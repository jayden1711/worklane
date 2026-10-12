// The owner terminal's WebSocket, on the hub: /api/terminal?instance=<name>. The page sends
// {"type":"input","data":"..."}; the hub sends {"type":"output","data":"..."}, then {"type":"closed","why":"..."}
// or, when it won't open, {"type":"refused","why":"..."}. The per-install token grants nothing here: only a
// fresh GitHub sign-in as the instance's owner opens it (terminal.ts). A cross-site page can't open it: the
// Origin must be this host's.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { openTerminal, type AuditSink, type Exec, type SpawnPty, type TerminalConfig, type TerminalHandle } from './terminal.js';
import type { SessionOf } from './session.js';

export interface TerminalServerOptions {
  config: TerminalConfig;
  /** The instances the hub serves; the terminal opens from one of them, as its owner. */
  instances: string[];
  session: SessionOf;
  audit: AuditSink;
  spawnPty?: SpawnPty;
  exec?: Exec;
  now?: () => number;
  idleMs?: number;
}

export const TERMINAL_PATH = '/api/terminal';
const MAX_INPUT = 64 * 1024;

/** Whether the request's Origin is the host it was sent to (a browser always sends Origin on a WebSocket). */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Serve the terminal on this server's upgrades to TERMINAL_PATH; others are refused. Returns a closer. */
export function attachTerminal(server: Server, o: TerminalServerOptions): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT });
  const open = new Set<TerminalHandle>();
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== TERMINAL_PATH || !sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      return;
    }
    const instance = url.searchParams.get('instance') ?? '';
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const say = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
      if (!o.instances.includes(instance)) {
        say({ type: 'refused', why: `no instance ${instance || '(none)'} in this hub` });
        return ws.close(1008);
      }
      const cols = Number(url.searchParams.get('cols')) || 80;
      const rows = Number(url.searchParams.get('rows')) || 24;
      const t = openTerminal({
        session: o.session(req, instance),
        instance,
        config: o.config,
        audit: o.audit,
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
        let m: { type?: unknown; data?: unknown };
        try {
          m = JSON.parse(String(raw)) as typeof m;
        } catch {
          return;
        }
        if (m.type === 'input' && typeof m.data === 'string') t.input(m.data);
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
    for (const t of open) t.close('the hub stopped');
    wss.close();
  };
}

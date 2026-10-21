// The hub's hooks gateway (docs/automations.md): a listener of its own, on loopback (HOOKS_GATEWAY_PORT), that
// `tailscale serve --https=8444` publishes on the tailnet (tailscale.sh serve-hooks; never Funnel), answering exactly
//   POST /hook/<instance>/<automation id>     a webhook delivery, passed to that instance's /api/hooks/<id>
// It holds no more than this:
// - its own server and handler: no session, cookie, CSRF, static file or sign-in route is reachable here;
// - built from each instance's hooks gateway token file only (never a dashboard token), which works on that
//   instance's /api/hooks/ routes and nowhere else; it holds no webhook secret, so it can't sign a delivery: the
//   instance checks every one (src/automations/webhook.ts);
// - a request counts only from the tailnet: the connection must be tailscaled's (the kernel says which uid opened it)
//   and serve's X-Forwarded-For one Tailscale address, which `tailscale whois` turns into a node. This machine's own
//   node is refused (a program here can't reach it through the tailnet name either);
// - ten refused deliveries from one node in ten minutes lock that node out for fifteen.
// Refusals made here go to the hub's own hooks-audit.jsonl; the instance logs the rest.
import { execFileSync } from '../os/child-process.js';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { assertLoopbackHost } from '../dashboard-auth.js';
import { identifyDevice, type DeviceOptions } from '../console/terminal-devices.js';
import { BODY_MAX, HOOK_HEADERS } from './webhook.js';

/** The gateway's loopback port, beside the break-glass (4398) and the hub (4399); 4397 was the removed Siri gateway's. */
export const HOOKS_GATEWAY_PORT = 4396;
/** The tailnet HTTPS port tailscale serve publishes it on. */
export const HOOKS_TAILNET_PORT = 8444;
export const LOCKOUT = { fails: 10, windowMs: 10 * 60_000, forMs: 15 * 60_000 } as const;
const UPSTREAM_MS = 10_000;
const PATH = /^\/hook\/([a-z][a-z0-9-]{0,40})\/([a-z][a-z0-9-]{0,39})$/;

export interface HooksGatewayInstance {
  name: string;
  /** The instance's own dashboard, on loopback. */
  port: number;
  /** Its hooks gateway token file (`hooks-gateway-token`), which the hub's viewer may read with --hooks. */
  gatewayTokenFile: string;
}

export interface HooksGatewayOptions {
  instances: HooksGatewayInstance[];
  port?: number;
  host?: string;
  auditFile: string;
  /** Tests stand in for Tailscale (whois, this machine's own node) and the kernel (peerUid). */
  whois?: (ip: string) => string;
  peerUid?: (clientPort: number, serverPort: number) => number | null;
  /** This machine's own Tailscale node id (tailscale status Self.ID), or null when it can't be told: then nothing is taken. */
  selfNode?: () => string | null;
  lockout?: { fails: number; windowMs: number; forMs: number };
  now?: () => number;
}

/** This machine's own node, from `tailscale status --json` (Self.ID), or null. */
export function tailscaleSelfNode(): string | null {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })) as { Self?: { ID?: unknown } };
    return typeof s.Self?.ID === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.Self.ID) ? s.Self.ID : null;
  } catch {
    return null;
  }
}

function readToken(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim();
    return /^[A-Za-z0-9_-]{16,128}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function answer(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startHooksGateway(o: HooksGatewayOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const host = o.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const now = o.now ?? Date.now;
  const byName = new Map(o.instances.map((i) => [i.name, i]));
  const L = o.lockout ?? LOCKOUT;
  const selfNode = o.selfNode ?? tailscaleSelfNode;
  const fails = new Map<string, number[]>();
  const locked = new Map<string, number>();
  const audit = (detail: Record<string, unknown>) => {
    try {
      appendFileSync(o.auditFile, `${JSON.stringify({ at: new Date(now()).toISOString(), ...detail })}\n`, { mode: 0o600 });
    } catch {
      // best effort; the instance's own log is the record of anything that reached it
    }
  };
  const failed = (node: string) => {
    const t = now();
    const xs = [...(fails.get(node) ?? []).filter((x) => t - x < L.windowMs), t];
    fails.set(node, xs);
    if (xs.length >= L.fails) {
      locked.set(node, t + L.forMs);
      fails.delete(node);
      audit({ kind: 'locked_out', node, minutes: L.forMs / 60_000 });
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.search) return answer(res, 400, { error: 'no query' });
      const m = PATH.exec(url.pathname);
      if (req.method !== 'POST' || !m) return answer(res, 404, { error: 'not found' });
      const dev = identifyDevice(req, { allow: [], ...(o.whois ? { whois: o.whois } : {}), ...(o.peerUid ? { peerUid: o.peerUid } : {}) } satisfies DeviceOptions);
      if (!dev.ok) {
        audit({ kind: 'refused', why: dev.why });
        return answer(res, 403, { error: 'from the tailnet only' });
      }
      const node = dev.device;
      if (!node.stableId) {
        audit({ kind: 'refused', node: node.name, why: 'Tailscale gave no stable node id' });
        return answer(res, 403, { error: 'from the tailnet only' });
      }
      const self = selfNode();
      if (self === null || self === node.stableId) {
        audit({ kind: 'refused', node: node.name, why: self === null ? "this machine's own node can't be told" : "this machine's own node" });
        return answer(res, 403, { error: 'from the tailnet only' });
      }
      const until = locked.get(node.stableId);
      if (until && now() < until) return answer(res, 429, { error: 'locked out for a while' });
      if (until) locked.delete(node.stableId);
      const inst = byName.get(m[1]!);
      const gw = inst ? readToken(inst.gatewayTokenFile) : null;
      if (!inst || !gw) {
        // The same answer as a refused delivery: nothing tells which instances exist.
        failed(node.stableId);
        audit({ kind: 'refused', node: node.name, why: inst ? "can't read the instance's hooks gateway token" : 'no such instance on this hub' });
        return answer(res, 401, { error: 'refused' });
      }
      const body = await readBody(req);
      if (body === null) return answer(res, 413, { error: 'too long' });
      const pass = (h: string) => (typeof req.headers[h] === 'string' ? { [h]: (req.headers[h] as string).slice(0, 200) } : {});
      const up = await new Promise<{ status: number; text: string } | null>((done) => {
        const r = request(
          {
            host: '127.0.0.1',
            port: inst.port,
            path: `/api/hooks/${m[2]}`,
            method: 'POST',
            timeout: UPSTREAM_MS,
            // Built here, whole: the gateway's token, the node Tailscale named, and the delivery's own three headers.
            // Never a login, a cookie or a console-device mark.
            headers: { authorization: `Bearer ${gw}`, [HOOK_HEADERS.node]: JSON.stringify({ id: node.stableId, name: node.name }), ...pass(HOOK_HEADERS.timestamp), ...pass(HOOK_HEADERS.delivery), ...pass(HOOK_HEADERS.signature), 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
          },
          (r2) => {
            const chunks: Buffer[] = [];
            r2.on('data', (c: Buffer) => chunks.push(c));
            r2.on('end', () => done({ status: r2.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8').slice(0, 400) }));
            r2.on('error', () => done(null));
          },
        );
        r.on('timeout', () => r.destroy());
        r.on('error', () => done(null));
        r.end(body);
      });
      if (!up) return answer(res, 502, { error: 'the project is not answering' });
      if (up.status === 401) failed(node.stableId);
      let v: Record<string, unknown> = {};
      try {
        v = JSON.parse(up.text) as Record<string, unknown>;
      } catch {
        // not JSON: only the status goes back
      }
      return answer(res, up.status, typeof v.delivery === 'string' ? { delivery: v.delivery } : { error: typeof v.error === 'string' ? v.error : 'refused' });
    } catch {
      if (!res.headersSent) answer(res, 500, { error: 'failed' });
      else res.end();
    }
  });
  const port = await new Promise<number>((done, fail) => {
    server.once('error', fail);
    server.listen(o.port ?? 0, host, () => {
      server.off('error', fail);
      const a = server.address();
      done(typeof a === 'object' && a ? a.port : 0);
    });
  });
  return {
    server,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

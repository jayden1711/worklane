// Headless Chrome or Chromium over the DevTools protocol, with no browser dependency: find the binary, start
// it on a temporary profile, and talk to a page over the WebSocket Node ships with (22.4+). Shared by the
// dashboard's own browser checks (scripts/dev/control-dashboard.mjs) and the project-app runner (run.ts).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeCandidates, which } from '../os/index.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy, or fail after `ms` naming what was awaited (and the last error). */
export async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000, every = 100): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

/** Chrome or Chromium on this machine: `given`, then the usual install places, then the PATH. null when there's none. */
export function findChrome(given?: string | null): string | null {
  if (given) return given;
  for (const c of chromeCandidates()) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

/** A free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? ok(a.port) : fail(new Error('no port'))));
    });
  });
}

/** Whether something already listens on this loopback port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(true));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(false)));
  });
}

/** The WebSocket Node ships with (22.4+); typed here, as @types/node doesn't declare the global. */
interface Ws {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'error' | 'close', fn: () => void, o?: { once?: boolean }): void;
  addEventListener(type: 'message', fn: (m: { data: unknown }) => void): void;
}
const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => Ws }).WebSocket;

type Params = Record<string, unknown>;

/** A minimal DevTools protocol client. */
export class Cdp {
  private next = 1;
  private pending = new Map<number, { ok: (r: Params) => void; fail: (e: Error) => void; method: string }>();
  private handlers = new Map<string, ((p: Params) => void)[]>();
  private constructor(private ws: Ws) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: Params; result?: Params; error?: { message: string } };
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail, method } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result ?? {});
      } else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {});
    });
    // A closed socket fails whatever still waits on it, rather than leaving it hanging.
    ws.addEventListener('close', () => {
      for (const { fail, method } of this.pending.values()) fail(new Error(`${method}: the DevTools connection closed`));
      this.pending.clear();
    });
  }
  static async connect(url: string): Promise<Cdp> {
    if (!WebSocketCtor) throw new Error(`this Node (${process.version}) has no WebSocket; Node 22.4 or later does`);
    const ws = new WebSocketCtor(url);
    await new Promise<void>((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error(`DevTools WebSocket ${url} refused`)), { once: true });
    });
    return new Cdp(ws);
  }
  send<T = Params>(method: string, params: Params = {}): Promise<T> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok: ok as (r: Params) => void, fail, method }));
  }
  on(method: string, fn: (p: Params) => void) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
  }
  close() {
    this.ws.close();
  }
}

export interface Browser {
  cdp: Cdp;
  proc: ChildProcess;
  /** Stop Chrome and remove its profile. Safe to call more than once. */
  close(): Promise<void>;
}

/** Start headless Chrome on a temporary profile and connect to its page. Chrome is stopped if connecting fails. */
export async function launchChrome(chrome: string, o: { width?: number; height?: number; noSandbox?: boolean; extraArgs?: string[] } = {}): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${o.width ?? 1440},${o.height ?? 1000}`,
      ...(o.noSandbox ? ['--no-sandbox'] : []),
      ...(o.extraArgs ?? []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (proc.exitCode === null && proc.signalCode === null) {
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([gone, sleep(3000)]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    const devtools = await until('Chrome to open its DevTools port', () => existsSync(portFile) && readFileSync(portFile, 'utf8').split(/\r?\n/)[0], 20_000).catch((e: Error) => {
      throw new Error(`${e.message}\nChrome said: ${stderr.trim() || '(nothing)'}`);
    });
    const target = await until('a page target', async () => ((await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page'));
    return { cdp: await Cdp.connect(target.webSocketDebuggerUrl), proc, close };
  } catch (e) {
    await close();
    throw e;
  }
}

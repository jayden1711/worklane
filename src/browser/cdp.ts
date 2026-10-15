// Headless Chrome or Chromium over the DevTools protocol, with no browser dependency: find the binary, start
// it on a temporary profile, and talk to a page over the WebSocket Node ships with (22.4+). Shared by the
// dashboard's own browser checks (scripts/dev/control-dashboard.mjs) and the project-app runner (run.ts).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import { chromeCandidates, killTree, spawnDetached, which } from '../os/index.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long the browser may take. The defaults suit a normal machine; a slow or loaded one (a shared CI runner)
 * scales them all with <PREFIX>_BROWSER_TIMEOUT_SCALE (1 to 20).
 */
export function browserTimeouts(env: NodeJS.ProcessEnv = process.env) {
  const scale = Math.min(20, Math.max(1, Number(env[`${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE`]) || 1));
  return {
    /** Chrome started until its DevTools port and page are up (once more on a retry). */
    launchMs: 30_000 * scale,
    /** One DevTools command (a navigation, a screenshot). */
    commandMs: 30_000 * scale,
    /** A flow step waiting for its target or text. */
    stepMs: 10_000 * scale,
    /** The DevTools WebSocket opening. */
    socketMs: 10_000 * scale,
  };
}

/** Processes started for browser checks (Chrome, the app) that haven't been seen to exit: none, between runs. */
const live = new Map<number, string>();
/** Record a process as running until stopTree sees it gone. */
export function track(p: ChildProcess, what: string) {
  if (p.pid !== undefined) live.set(p.pid, what);
}
/** What's still running (for tests: nothing may leak from one run into the next). */
export function liveProcesses(): { pid: number; what: string }[] {
  return [...live].map(([pid, what]) => ({ pid, what }));
}

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
      const ms = browserTimeouts().socketMs;
      const t = setTimeout(() => fail(new Error(`DevTools WebSocket ${url} didn't open in ${ms / 1000} s`)), ms);
      ws.addEventListener('open', () => (clearTimeout(t), ok()), { once: true });
      ws.addEventListener('error', () => (clearTimeout(t), fail(new Error(`DevTools WebSocket ${url} refused`))), { once: true });
    });
    return new Cdp(ws);
  }
  /** A command, failing after `ms` if Chrome never answers (a hung browser must not hang its caller). */
  send<T = Params>(method: string, params: Params = {}, ms = browserTimeouts().commandMs): Promise<T> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method}: no answer from Chrome in ${ms / 1000} s`));
      }, ms);
      const done = <A>(f: (a: A) => void) => (a: A) => (clearTimeout(t), f(a));
      this.pending.set(id, { ok: done(ok as (r: Params) => void), fail: done(fail), method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        done(fail)(new Error(`${method}: ${(e as Error).message}`));
      }
    });
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
  /**
   * Stop Chrome (all its processes) and remove its profile. Never throws: a profile that can't be removed is
   * returned as a note, as cleanup is never a reason a check fails. Safe to call more than once.
   */
  close(): Promise<string | null>;
  /** What happened starting it (a start retried). */
  notes: string[];
}

/** Stop a process and everything in its group (Chrome's renderers, an app's children), and wait until it's gone. */
export async function stopTree(p: ChildProcess, kill: () => void = () => killTree(p.pid, () => p.kill('SIGKILL'))): Promise<boolean> {
  // No pid: it never started (spawn failed), so there's nothing to stop.
  const exited = () => p.pid === undefined || p.exitCode !== null || p.signalCode !== null;
  if (!exited()) {
    const gone = new Promise((r) => p.once('exit', r));
    kill();
    await Promise.race([gone, sleep(5000)]);
    if (!exited()) {
      p.kill('SIGKILL');
      await Promise.race([gone, sleep(2000)]);
    }
  }
  // Whatever happened, its pipes must not keep this process (a test run, the coordinator) waiting.
  p.stdout?.destroy();
  p.stderr?.destroy();
  p.unref();
  if (exited() && p.pid !== undefined) live.delete(p.pid);
  return exited();
}

/** Chrome never opened its DevTools port in time: worth one more start (a loaded machine), unlike a crash. */
class PortTimeout extends Error {}

/**
 * Every Chrome this engine starts keeps its passwords and cookies' key in its own profile, never in the OS keychain:
 * on macOS a headless Chrome otherwise asks for the login keychain ("A keychain cannot be found to store Chrome").
 */
export const CHROME_NO_KEYCHAIN_ARGS = ['--use-mock-keychain', '--password-store=basic'] as const;

type LaunchOptions = { width?: number; height?: number; noSandbox?: boolean; extraArgs?: string[]; profileRoot?: string; launchMs?: number };

/**
 * Start headless Chrome on a temporary profile and connect to its page. If its DevTools port never appears (a
 * loaded machine), it's stopped and started once more, and that is noted; any other failure, or a second
 * timeout, stops it and throws.
 */
export async function launchChrome(chrome: string, o: LaunchOptions = {}): Promise<Browser> {
  try {
    return await startChrome(chrome, o);
  } catch (e) {
    if (!(e instanceof PortTimeout)) throw e;
    const b = await startChrome(chrome, o);
    b.notes.push(`Chrome was started twice: the first never opened its DevTools port (${e.message.split('\n')[0]})`);
    return b;
  }
}

async function startChrome(chrome: string, o: LaunchOptions): Promise<Browser> {
  const launchMs = o.launchMs ?? browserTimeouts().launchMs;
  const profile = mkdtempSync(join(o.profileRoot ?? tmpdir(), 'cdp-chrome-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...CHROME_NO_KEYCHAIN_ARGS,
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${o.width ?? 1440},${o.height ?? 1000}`,
      ...(o.noSandbox ? ['--no-sandbox'] : []),
      ...(o.extraArgs ?? []),
      'about:blank',
    ],
    // Its own process group, so stopping it stops its renderers and helpers too, before the profile is removed.
    { stdio: ['ignore', 'ignore', 'pipe'], detached: spawnDetached },
  );
  track(proc, 'Chrome');
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  proc.on('error', (e) => (stderr += `\n${e.message}`));
  let closed: Promise<string | null> | null = null;
  const close = () =>
    (closed ??= (async () => {
      const notes: string[] = [];
      try {
        if (!(await stopTree(proc))) notes.push(`Chrome (pid ${proc.pid}) didn't exit`);
      } catch (e) {
        notes.push(`stopping Chrome failed: ${(e as Error).message}`);
      }
      try {
        // Retried: a process that was just stopped can still be letting go of its files (ENOTEMPTY, EBUSY).
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        notes.push(`Chrome's temporary profile ${profile} wasn't removed: ${(e as Error).message.split('\n')[0]}`);
      }
      return notes.length ? notes.join('; ') : null;
    })());
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    // A Chrome that can't start, or exits early, fails now rather than at the timeout.
    const died = new Promise<never>((_, fail) => {
      proc.once('error', (e) => fail(new Error(`Chrome couldn't be started (${chrome}): ${e.message}`)));
      proc.once('exit', (code, signal) => fail(new Error(`Chrome exited (${code ?? signal}) before it opened DevTools\nChrome said: ${stderr.trim() || '(nothing)'}`)));
    });
    died.catch(() => {});
    const devtools = await Promise.race([
      died,
      until('Chrome to open its DevTools port', () => existsSync(portFile) && readFileSync(portFile, 'utf8').split(/\r?\n/)[0], launchMs).catch((e: Error) => {
        throw new PortTimeout(`${e.message}\nChrome said: ${stderr.trim() || '(nothing)'}`);
      }),
    ]);
    const target = await until('a page target', async () => ((await (await fetch(`http://127.0.0.1:${devtools}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page'), launchMs);
    return { cdp: await Cdp.connect(target.webSocketDebuggerUrl), proc, close, notes: [] };
  } catch (e) {
    await close();
    throw e;
  }
}

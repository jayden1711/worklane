// WHY: the one-command install (scripts/bootstrap.sh) ends with one wizard URL, the same on every run, and a rerun
// changes nothing: the dashboard starts in the background only when it isn't answering already.
// INVARIANT: the URL never carries the dashboard's key; it stays in its 0600 file and the page asks for it once.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BRAND } from './brand.js';

/** WHY: one fixed URL per port, so a rerun prints exactly the same one. */
export const wizardUrl = (port: number) => `http://127.0.0.1:${port}/first-run`;

export type Probe = 'ours' | 'other' | 'none';

/** INVARIANT: the key goes in a header, never the URL; only a 200 with this checkout's key is 'ours'. */
export async function probeDashboard(port: number, tokenFile: string, timeoutMs = 2_000): Promise<Probe> {
  const key = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/role`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return r.ok && key ? 'ours' : 'other';
  } catch {
    return 'none';
  }
}

export interface DetachOptions {
  root: string;
  port: number;
  tokenFile: string;
  logFile: string;
  command: string[];
  waitMs?: number;
  /** WHY: tests stand in for the probe, the start and the clock. */
  probe?: (port: number, tokenFile: string) => Promise<Probe>;
  start?: (command: string[], logFile: string) => { pid: number | null; exited: () => number | null };
  sleep?: (ms: number) => Promise<void>;
}

export interface Detached {
  url: string;
  started: boolean;
  pid?: number | null;
}

export class DetachError extends Error {}

/** WHY: its own session, so the dashboard outlives the install command that started it. */
export function startDetached(command: string[], logFile: string): { pid: number | null; exited: () => number | null } {
  const fd = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ['ignore', fd, fd] });
    let code: number | null = null;
    child.on('exit', (c) => (code = c ?? 1));
    child.on('error', () => (code = 127));
    child.unref();
    return { pid: child.pid ?? null, exited: () => code };
  } finally {
    closeSync(fd);
  }
}

export async function detachDashboard(o: DetachOptions): Promise<Detached> {
  const probe = o.probe ?? probeDashboard;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs ?? 30_000;
  const url = wizardUrl(o.port);
  const now = await probe(o.port, o.tokenFile);
  if (now === 'ours') return { url, started: false };
  if (now === 'other') throw new DetachError(`port ${o.port} answers, but not as this checkout's dashboard (another project's, or another program): stop it, or give --port`);
  mkdirSync(dirname(o.logFile), { recursive: true });
  const child = (o.start ?? startDetached)(o.command, o.logFile);
  for (let waited = 0; waited < waitMs; waited += 250) {
    await sleep(250);
    if ((await probe(o.port, o.tokenFile)) === 'ours') return { url, started: true, pid: child.pid };
    const code = child.exited();
    if (code !== null) throw new DetachError(`the dashboard stopped (exit ${code}) before it answered: see ${o.logFile}`);
  }
  throw new DetachError(`the dashboard didn't answer on port ${o.port} within ${Math.round(waitMs / 1000)} s: see ${o.logFile}`);
}

/** INVARIANT: the URL is the last line and the only one; the key's path is printed, never the key. */
export function detachedLines(d: Detached, o: { root: string; tokenFile: string; logFile: string }): string[] {
  return [
    `${BRAND.name} dashboard for ${o.root}: ${d.started ? `started in the background (pid ${d.pid ?? '?'}; its log: ${o.logFile})` : 'already running; nothing changed'}`,
    `  the page asks once for the dashboard key: it is in ${o.tokenFile} (only you can read it)`,
    d.url,
  ];
}

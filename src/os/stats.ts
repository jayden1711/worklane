// Machine stats for a health view: memory and swap, load averages, each
// service unit's memory, swap and CPU (systemd's own accounting, read with an
// unprivileged `systemctl show`), and free disk for given paths. Linux reads
// /proc and systemd; elsewhere memory, load and units are null (not measured),
// disk comes from statfs on every platform. Nothing here throws: whatever can't
// be read is null, with the reason in `unavailable`.
import { execFileSync } from './child-process.js';
import { readdirSync, readFileSync, statfsSync } from 'node:fs';

export interface MemoryStats {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

export interface UnitStats {
  unit: string;
  /** Bytes in use now; null when systemd doesn't account it (or the unit isn't running). */
  memoryCurrent: number | null;
  /** The unit's memory limit; null for none (infinity). */
  memoryMax: number | null;
  memorySwapCurrent: number | null;
  /** CPU time used since the unit started, in ns. */
  cpuUsageNSec: number | null;
  /** active, inactive, failed, ... */
  activeState: string | null;
}

export interface DiskStats {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

export interface MachineStats {
  at: string;
  platform: string;
  memory: MemoryStats | null;
  /** 1, 5 and 15 minute load averages. */
  load: [number, number, number] | null;
  units: (UnitStats | { unit: string; error: string })[] | null;
  disks: (DiskStats | { path: string; error: string })[];
  /** What couldn't be read, and why. */
  unavailable: string[];
}

/** /proc/meminfo: the four values that matter, in bytes; null if any is missing. */
export function parseMeminfo(text: string): MemoryStats | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  if (total === null || available === null || swapTotal === null || swapFree === null) return null;
  return { totalBytes: total, availableBytes: available, swapTotalBytes: swapTotal, swapFreeBytes: swapFree };
}

/** /proc/loadavg: the 1, 5 and 15 minute averages; null if malformed. */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0) ? (parts as [number, number, number]) : null;
}

/** `systemctl show -p ...` output (KEY=VALUE lines) for one unit. "[not set]" and "infinity" are null. */
export function parseSystemctlShow(unit: string, text: string): UnitStats {
  const props = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const num = (k: string): number | null => {
    const v = props.get(k);
    // systemd prints 2^64-1 for "not accounted" on some versions, "[not set]" on others.
    if (v === undefined || v === '' || v === '[not set]' || v === 'infinity' || v === '18446744073709551615') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return { unit, memoryCurrent: num('MemoryCurrent'), memoryMax: num('MemoryMax'), memorySwapCurrent: num('MemorySwapCurrent'), cpuUsageNSec: num('CPUUsageNSec'), activeState: props.get('ActiveState') || null };
}

export interface StatsDeps {
  platform?: string;
  readFile?: (path: string) => string;
  /** Runs a command, returns its stdout; throws on failure. */
  exec?: (file: string, args: string[]) => string;
  statfs?: (path: string) => { blocks: number; bsize: number; bavail: number };
  now?: () => Date;
}

const UNIT = /^[A-Za-z0-9:_.@\\-]+$/;

/** Machine stats for these service units and paths. Never throws. */
export function machineStats(o: { units?: string[]; paths?: string[] } = {}, d: StatsDeps = {}): MachineStats {
  const platform = d.platform ?? process.platform;
  const read = d.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const exec = d.exec ?? ((file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const statfs = d.statfs ?? ((p: string) => statfsSync(p));
  const unavailable: string[] = [];
  const attempt = <T>(what: string, fn: () => T | null): T | null => {
    try {
      const v = fn();
      if (v === null) unavailable.push(`${what}: unreadable`);
      return v;
    } catch (e) {
      unavailable.push(`${what}: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}`);
      return null;
    }
  };

  let memory: MemoryStats | null = null;
  let load: [number, number, number] | null = null;
  let units: MachineStats['units'] = null;
  if (platform === 'linux') {
    memory = attempt('memory', () => parseMeminfo(read('/proc/meminfo')));
    load = attempt('load', () => parseLoadavg(read('/proc/loadavg')));
    units = (o.units ?? []).map((unit) => {
      if (!UNIT.test(unit)) return { unit, error: 'not a unit name' };
      try {
        return parseSystemctlShow(unit, exec('systemctl', ['show', unit, '-p', 'MemoryCurrent,MemoryMax,MemorySwapCurrent,CPUUsageNSec,ActiveState']));
      } catch (e) {
        return { unit, error: (e as Error).message.split('\n')[0]!.slice(0, 200) };
      }
    });
  } else {
    unavailable.push(`memory, load and units: not measured on ${platform}`);
  }

  const disks = (o.paths ?? []).map((path) => {
    try {
      const st = statfs(path);
      return { path, freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
    } catch (e) {
      return { path, error: (e as Error).message.split('\n')[0]!.slice(0, 200) };
    }
  });
  return { at: (d.now ?? (() => new Date()))().toISOString(), platform, memory, load, units, disks, unavailable };
}

/** What one agent run's processes (its process group) use right now: resident memory, CPU time so far, how many. */
export interface ProcessGroupUsage {
  rssBytes: number;
  cpuSeconds: number;
  processes: number;
}

/** USER_HZ (the unit of utime and stime in /proc/<pid>/stat) and the page size: the values mainstream Linux uses. */
const CLOCK_TICKS = 100;
const PAGE_BYTES = 4096;

/**
 * One /proc/<pid>/stat line: its process group, CPU ticks (user + system) and resident pages. The command name
 * (field 2) may hold spaces and parentheses, so the fields are counted from the last ')'. Null if malformed.
 */
export function parseProcStat(text: string): { pgrp: number; ticks: number; rssPages: number } | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  // From field 3 (state) on: pgrp is field 5, utime 14, stime 15, rss 24.
  const f = text.slice(close + 1).trim().split(/\s+/);
  const pgrp = Number(f[2]);
  const ticks = Number(f[11]) + Number(f[12]);
  const rssPages = Number(f[21]);
  return Number.isInteger(pgrp) && pgrp > 0 && Number.isFinite(ticks) && Number.isFinite(rssPages) ? { pgrp, ticks, rssPages } : null;
}

/**
 * What each of these process groups uses now, from one pass over /proc (Linux; elsewhere, and for a group with no
 * readable process, nothing: not measured). An agent run starts in a process group of its own (run.started's pgid),
 * so a group is one run with everything it spawned. Never throws.
 */
export function processGroupUsage(pgids: number[], d: Pick<StatsDeps, 'platform' | 'readFile'> & { list?: () => string[] } = {}): Map<number, ProcessGroupUsage> {
  const out = new Map<number, ProcessGroupUsage>();
  const want = new Set(pgids.filter((p) => Number.isInteger(p) && p > 0));
  if ((d.platform ?? process.platform) !== 'linux' || !want.size) return out;
  const read = d.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let pids: string[];
  try {
    pids = (d.list ?? (() => readdirSync('/proc')))().filter((x) => /^\d+$/.test(x));
  } catch {
    return out;
  }
  for (const pid of pids) {
    let s: ReturnType<typeof parseProcStat>;
    try {
      s = parseProcStat(read(`/proc/${pid}/stat`));
    } catch {
      continue; // gone, or not readable as this user
    }
    if (!s || !want.has(s.pgrp)) continue;
    const u = out.get(s.pgrp) ?? { rssBytes: 0, cpuSeconds: 0, processes: 0 };
    u.rssBytes += s.rssPages * PAGE_BYTES;
    u.cpuSeconds += s.ticks / CLOCK_TICKS;
    u.processes++;
    out.set(s.pgrp, u);
  }
  return out;
}

/** A service unit's run state, for the watchdog: whether it is up, and how often its manager restarted it. */
export interface UnitState {
  unit: string;
  /** systemd's LoadState: not-found means no such unit on this machine. */
  loadState: string | null;
  /** active, activating, failed, inactive, ... */
  activeState: string | null;
  /** running, auto-restart, dead, ... */
  subState: string | null;
  /** Restarts the manager made since the unit was last started by hand; null when not reported. */
  restarts: number | null;
}

/** `systemctl show -p LoadState,ActiveState,SubState,NRestarts` output for one unit. */
export function parseUnitState(unit: string, text: string): UnitState {
  const props = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const n = Number(props.get('NRestarts'));
  return { unit, loadState: props.get('LoadState') || null, activeState: props.get('ActiveState') || null, subState: props.get('SubState') || null, restarts: props.get('NRestarts') && Number.isInteger(n) && n >= 0 ? n : null };
}

/**
 * These units' run states (Linux, systemd; an unprivileged `systemctl show` reads them). Null where units aren't
 * measured (other platforms): the caller then knows nothing, rather than that every unit is down. A unit that
 * couldn't be read is left out. Never throws.
 */
export function unitStates(units: string[], d: Pick<StatsDeps, 'platform' | 'exec'> = {}): UnitState[] | null {
  if ((d.platform ?? process.platform) !== 'linux') return null;
  const exec = d.exec ?? ((file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const out: UnitState[] = [];
  for (const unit of units) {
    if (!UNIT.test(unit)) continue;
    try {
      out.push(parseUnitState(unit, exec('systemctl', ['show', unit, '-p', 'LoadState,ActiveState,SubState,NRestarts'])));
    } catch {
      // unreadable: unknown, not down
    }
  }
  return out;
}

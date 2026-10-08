// OS adapter layer. This is the only module allowed to branch on the
// platform (test/os-boundary.test.ts enforces it).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../brand.js';

export type OsKind = 'macos' | 'linux' | 'windows-wsl' | 'windows';
export type OsSetting = 'auto' | 'macos' | 'linux' | 'windows-wsl';

export function detectOs(setting: OsSetting = 'auto'): OsKind {
  if (setting !== 'auto') return setting;
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') {
    try {
      if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return 'windows-wsl';
    } catch {
      // not WSL
    }
    return 'linux';
  }
  return 'linux';
}

/** Agents only run where Bash can be sandboxed; native Windows can't. */
export function canRunAgents(os: OsKind): boolean {
  return os !== 'windows';
}

/** Machine-local state (event log, fingerprints, findings). Never inside a repo. */
export function stateDir(): string {
  const override = process.env[`${BRAND.envPrefix}_STATE_DIR`];
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', BRAND.cli);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), BRAND.cli);
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), BRAND.cli);
}

/** Full path of an executable on PATH, or null. */
export function which(cmd: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      if (dir && existsSync(p)) return p;
      const q = join(dir, cmd + ext);
      if (dir && existsSync(q)) return q;
    }
  }
  return null;
}

/** True if a process with this pid exists (signal 0 probes without killing). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function wslAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('wsl.exe', ['--status'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function homeDir(): string {
  return homedir();
}

/** Spawn children in their own process group where the OS supports it, so a timeout kills the whole tree. */
export const spawnDetached = process.platform !== 'win32';

export function killTree(pid: number | undefined, fallback: () => void): void {
  try {
    if (pid && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else if (pid && process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else fallback();
  } catch {
    fallback();
  }
}

/** Windows needs a shell to run npm's .cmd shims. */
export const shimsNeedShell = process.platform === 'win32';

/**
 * Environment for project commands the engine runs (checks, tests). Drops
 * variables that change how a nested runner behaves when the engine itself
 * runs under a test runner (node --test sets NODE_TEST_CONTEXT, which makes a
 * nested `node --test` report to the parent instead of exiting non-zero).
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

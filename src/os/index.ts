// OS adapter layer. This is the only module allowed to branch on the
// platform (test/os-boundary.test.ts enforces it).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, loadavg } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
/** Whether an OS user exists on this machine (POSIX; always false on native Windows). */
export function userExists(user: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('id', ['-u', '--', user], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

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

/**
 * Run a program as another (unprivileged) OS user, with exactly this
 * environment: `sudo -n -u <user> -- env -i K=V... <file> <args>`. The
 * operator's sudoers rule lets the coordinator user switch to the agent
 * user without a password, and nothing else. POSIX only.
 */
export function asUser(user: string, file: string, args: string[], env: NodeJS.ProcessEnv): [file: string, args: string[]] {
  if (process.platform === 'win32') throw new Error('running agents as a separate user needs macOS or Linux');
  const vars = Object.entries(env)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => `${k}=${v}`);
  return ['sudo', ['-n', '-u', user, '--', '/usr/bin/env', '-i', ...vars, file, ...args]];
}

/**
 * How to spawn a project command (a check, a test suite, a setup step):
 * under bash with pipefail, and as the instance's agent user when there is
 * one, with a clean environment. Project commands run code agents wrote, so
 * they never run as the user that holds the instance's credentials.
 */
export function projectCommand(command: string, runAs?: { user: string; home: string }): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [file, args] = shellCommand(command);
  if (!runAs) return { file, args, env: childEnv() };
  const env = {
    HOME: runAs.home,
    USER: runAs.user,
    LOGNAME: runAs.user,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CI: '1',
    // The checkout belongs to the coordinator user: without trusting it, git refuses it as "dubious ownership" and
    // any check that runs git fails. No credential helper: project code never authenticates as the instance.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'safe.directory',
    GIT_CONFIG_VALUE_1: '*',
  };
  const [f, a] = asUser(runAs.user, file, args, env);
  return { file: f, args: a, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}

/** Kill a process group that runs as another user: only that user (or root) may signal it. */
export function killTreeAs(user: string, pgid: number | undefined): void {
  if (!pgid || process.platform === 'win32') return;
  try {
    execFileSync('sudo', ['-n', '-u', user, '--', '/bin/kill', '-KILL', '--', `-${pgid}`], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // already gone
  }
}

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

let bashPath: string | undefined;

/**
 * The shell project commands run in: bash, never plain sh or cmd.exe, so
 * pipefail is available. On Windows that is Git for Windows' bash (the one
 * Claude Code uses for hooks); PATH's bash.exe may be the WSL launcher.
 */
export function commandBash(): string {
  if (bashPath) return bashPath;
  let found: string | null = null;
  if (process.platform === 'win32') {
    const git = which('git');
    const candidates = [
      process.env.CLAUDE_CODE_GIT_BASH_PATH,
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      // ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
      git ? join(dirname(dirname(git)), 'bin', 'bash.exe') : undefined,
    ];
    found = candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
  } else {
    found = which('bash');
  }
  if (!found) throw new Error(process.platform === 'win32' ? 'Git for Windows (its bash) is required to run project commands' : 'bash is required to run project commands');
  bashPath = found;
  return found;
}

/**
 * How to spawn a project command: `bash -o pipefail -c <command>`, so a
 * pipeline fails when any stage fails (`npm test | tail` is red when the
 * tests are). Use with shell: false.
 */
export function shellCommand(command: string): [file: string, args: string[]] {
  return [commandBash(), ['-o', 'pipefail', '-c', command]];
}

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

/**
 * Machine-wide slot directory shared by every agent harness on the box (not
 * just this one), so the name is deliberately unbranded. Override with
 * AGENT_SLOTS_DIR. See docs/slots.md.
 */
/**
 * Durable system locations for the slots and their config. /var/tmp is
 * cleaned of old files by tmp cleaners (systemd-tmpfiles after about 30
 * days), which would drop the cap and lock files of a long-running machine.
 */
export const SYSTEM_SLOTS = { dir: `/var/lib/${BRAND.cli}/agent-slots`, config: `/etc/${BRAND.cli}/slots.json` };

export function slotsDir(system = SYSTEM_SLOTS): string {
  if (process.env.AGENT_SLOTS_DIR) return process.env.AGENT_SLOTS_DIR;
  if (process.platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'agent-slots');
  if (existsSync(system.dir)) return system.dir;
  return '/var/tmp/agent-slots'; // single-user and development machines
}

/**
 * The machine's slot config (max_agents): AGENT_SLOTS_CONFIG if
 * set; else the system config file when the system slot directory is in
 * use and the file exists; else config.json in the slot directory.
 */
export function slotsConfigPath(dir = slotsDir(), system = SYSTEM_SLOTS): string {
  if (process.env.AGENT_SLOTS_CONFIG) return process.env.AGENT_SLOTS_CONFIG;
  if (dir === system.dir && existsSync(system.config)) return system.config;
  return join(dir, 'config.json');
}

export interface ServiceSpec {
  label: string; // reverse-DNS style id, unique per project
  program: string[]; // argv
  workingDir: string;
  logFile: string;
  env?: Record<string, string>;
}

/** Install and start a per-user service that restarts on failure and survives logout of any session. */
export function installService(spec: ServiceSpec): { path: string; started: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${spec.label}.plist`);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const envXml = Object.entries(spec.env ?? {}).map(([k, v]) => `<key>${esc(k)}</key><string>${esc(v)}</string>`).join('');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${esc(spec.label)}</string>
<key>ProgramArguments</key><array>${spec.program.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${esc(spec.workingDir)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${esc(spec.logFile)}</string>
<key>StandardErrorPath</key><string>${esc(spec.logFile)}</string>
<key>EnvironmentVariables</key><dict>${envXml}</dict>
</dict></plist>
`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plist);
    const uid = process.getuid?.() ?? 0;
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${spec.label}`], { stdio: 'ignore' });
    } catch {
      // not loaded yet
    }
    return { path, ...launch(['bootstrap', `gui/${uid}`, path]) };
  }
  if (process.platform === 'linux') {
    const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', `${spec.label}.service`);
    const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    const unit = `[Unit]
Description=${spec.label}

[Service]
ExecStart=${spec.program.map(q).join(' ')}
WorkingDirectory=${spec.workingDir}
Restart=always
RestartSec=30
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}
${Object.entries(spec.env ?? {}).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}

[Install]
WantedBy=default.target
`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit);
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', `${spec.label}.service`]);
      return { path, started: true, detail: 'systemd --user unit enabled (run `loginctl enable-linger` so it runs without a login session)' };
    } catch (e) {
      return { path, started: false, detail: (e as Error).message };
    }
  }
  return { path: '', started: false, detail: 'agents need macOS, Linux or WSL2; on native Windows run the coordinator on another machine' };
}

function launch(args: string[]): { started: boolean; detail: string } {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return { started: true, detail: 'launchd agent loaded (KeepAlive, starts at login)' };
  } catch (e) {
    return { started: false, detail: (e as Error).message };
  }
}

export function uninstallService(label: string): string {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: 'ignore' });
    } catch {
      // not loaded
    }
    rmSync(path, { force: true });
    return path;
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${label}.service`], { stdio: 'ignore' });
    } catch {
      // not enabled
    }
    const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', `${label}.service`);
    rmSync(path, { force: true });
    return path;
  }
  return '';
}

/**
 * Sustained load: the higher of the 5- and 15-minute averages, or null where
 * the OS doesn't report load (Windows). The 15-minute average alone reads
 * low for a while after a reboot or a burst, so it isn't enough.
 */
export function machineLoad(): number | null {
  if (process.platform === 'win32') return null;
  const [, five = 0, fifteen = 0] = loadavg();
  return Math.max(five, fifteen);
}

/** Open a URL in the default browser, best effort. */
export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try {
    execFileSync(cmd[0]!, cmd.slice(1), { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // no browser here: the URL is printed anyway
  }
}

/** A native executable's file name on this OS. */
export function executableName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/** Free disk on the volume holding `path`: percent and GB. */
export function diskFree(path: string): { freePct: number; freeGb: number; totalGb: number } {
  const st = statfsSync(path);
  const total = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  return { freePct: total ? (free / total) * 100 : 0, freeGb: free / 1e9, totalGb: total / 1e9 };
}

export function cpuCount(): number {
  return availableParallelism();
}

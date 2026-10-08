// OS adapter layer. This is the only module allowed to branch on the
// platform (test/os-boundary.test.ts enforces it).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, loadavg } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { BRAND } from '../brand.js';
export function detectOs(setting = 'auto') {
    if (setting !== 'auto')
        return setting;
    if (process.platform === 'darwin')
        return 'macos';
    if (process.platform === 'win32')
        return 'windows';
    if (process.platform === 'linux') {
        try {
            if (/microsoft/i.test(readFileSync('/proc/version', 'utf8')))
                return 'windows-wsl';
        }
        catch {
            // not WSL
        }
        return 'linux';
    }
    return 'linux';
}
/** Agents only run where Bash can be sandboxed; native Windows can't. */
export function canRunAgents(os) {
    return os !== 'windows';
}
/** Machine-local state (event log, fingerprints, findings). Never inside a repo. */
export function stateDir() {
    const override = process.env[`${BRAND.envPrefix}_STATE_DIR`];
    if (override)
        return override;
    if (process.platform === 'darwin')
        return join(homedir(), 'Library', 'Application Support', BRAND.cli);
    if (process.platform === 'win32')
        return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), BRAND.cli);
    return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), BRAND.cli);
}
/** Full path of an executable on PATH, or null. */
export function which(cmd) {
    const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        for (const ext of exts) {
            const p = join(dir, cmd + ext.toLowerCase());
            if (dir && existsSync(p))
                return p;
            const q = join(dir, cmd + ext);
            if (dir && existsSync(q))
                return q;
        }
    }
    return null;
}
/** True if a process with this pid exists (signal 0 probes without killing). */
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
export function wslAvailable() {
    if (process.platform !== 'win32')
        return false;
    try {
        execFileSync('wsl.exe', ['--status'], { stdio: 'ignore', timeout: 10_000 });
        return true;
    }
    catch {
        return false;
    }
}
export function homeDir() {
    return homedir();
}
/** Spawn children in their own process group where the OS supports it, so a timeout kills the whole tree. */
export const spawnDetached = process.platform !== 'win32';
export function killTree(pid, fallback) {
    try {
        if (pid && process.platform !== 'win32')
            process.kill(-pid, 'SIGKILL');
        else if (pid && process.platform === 'win32')
            execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else
            fallback();
    }
    catch {
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
export function childEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    delete env.NODE_TEST_CONTEXT;
    return env;
}
/**
 * Machine-wide slot directory shared by every agent harness on the box (not
 * just this one), so the name is deliberately unbranded. Override with
 * AGENT_SLOTS_DIR. See docs/slots.md.
 */
export function slotsDir() {
    if (process.env.AGENT_SLOTS_DIR)
        return process.env.AGENT_SLOTS_DIR;
    if (process.platform === 'win32')
        return join(process.env.ProgramData ?? 'C:\\ProgramData', 'agent-slots');
    return '/var/tmp/agent-slots';
}
/** Install and start a per-user service that restarts on failure and survives logout of any session. */
export function installService(spec) {
    if (process.platform === 'darwin') {
        const path = join(homedir(), 'Library', 'LaunchAgents', `${spec.label}.plist`);
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
        }
        catch {
            // not loaded yet
        }
        return { path, ...launch(['bootstrap', `gui/${uid}`, path]) };
    }
    if (process.platform === 'linux') {
        const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', `${spec.label}.service`);
        const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
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
        }
        catch (e) {
            return { path, started: false, detail: e.message };
        }
    }
    return { path: '', started: false, detail: 'agents need macOS, Linux or WSL2; on native Windows run the coordinator on another machine' };
}
function launch(args) {
    try {
        execFileSync('launchctl', args, { stdio: 'pipe' });
        return { started: true, detail: 'launchd agent loaded (KeepAlive, starts at login)' };
    }
    catch (e) {
        return { started: false, detail: e.message };
    }
}
export function uninstallService(label) {
    if (process.platform === 'darwin') {
        const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
        try {
            execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: 'ignore' });
        }
        catch {
            // not loaded
        }
        rmSync(path, { force: true });
        return path;
    }
    if (process.platform === 'linux') {
        try {
            execFileSync('systemctl', ['--user', 'disable', '--now', `${label}.service`], { stdio: 'ignore' });
        }
        catch {
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
export function machineLoad() {
    if (process.platform === 'win32')
        return null;
    const [, five = 0, fifteen = 0] = loadavg();
    return Math.max(five, fifteen);
}
/** Open a URL in the default browser, best effort. */
export function openUrl(url) {
    const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
    try {
        execFileSync(cmd[0], cmd.slice(1), { stdio: 'ignore', timeout: 10_000 });
    }
    catch {
        // no browser here: the URL is printed anyway
    }
}
/** A native executable's file name on this OS. */
export function executableName(base) {
    return process.platform === 'win32' ? `${base}.exe` : base;
}
/** Free disk on the volume holding `path`: percent and GB. */
export function diskFree(path) {
    const st = statfsSync(path);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { freePct: total ? (free / total) * 100 : 0, freeGb: free / 1e9, totalGb: total / 1e9 };
}
export function cpuCount() {
    return availableParallelism();
}
//# sourceMappingURL=index.js.map
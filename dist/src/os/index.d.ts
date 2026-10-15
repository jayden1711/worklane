export type OsKind = 'macos' | 'linux' | 'windows-wsl' | 'windows';
export type OsSetting = 'auto' | 'macos' | 'linux' | 'windows-wsl';
/**
 * The coordinator's state is for its own user and group only, never anyone else on the machine:
 * directories 0770, files 0660 (files kept 0600, like the dashboard token, are left as they are).
 * No-op on Windows, where access is by ACL, not mode bits.
 */
export declare function groupOnly(...paths: string[]): void;
/**
 * A directory the agent user can read but not write: owned by this (coordinator) user, group `gid` (the group
 * the agents share), 2750, so files made in it keep that group. No-op beyond mkdir on Windows.
 */
export declare function agentReadableDir(dir: string, gid: number): void;
/**
 * A directory the agents' group may also write (a dependency cache their setup steps fill): owned by this
 * (coordinator) user, group `gid`, 2770. The same checks as agentReadableDir keep it from being swapped.
 */
export declare function agentWritableDir(dir: string, gid: number): void;
/** A file the agent user can read but not write: owner this user, group `gid`, 0640. */
export declare function writeAgentReadable(file: string, data: string, gid: number): void;
/**
 * groupOnly over a whole tree, for state an older engine left open: every directory 0770, every file 0660
 * (0600 files stay 0600). Symlinks are never followed or changed. Returns what it changed, relative to `root`.
 * No-op on Windows.
 */
export declare function groupOnlyTree(root: string): string[];
/** mkdir -p, then groupOnly on the directory itself. */
export declare function groupOnlyDir(dir: string): void;
/** Write a state file readable by the coordinator's user and group only. */
/** A directory only this user can enter (0700): for data no group member may read, such as raw intake reports. */
export declare function ownerOnlyDir(dir: string): void;
/** Write a file only this user can read (0600), atomically (a temp file in the same directory, then a rename). */
export declare function writeOwnerOnly(file: string, data: string): void;
/** Write an executable file (a git hook) atomically, with exactly `mode` (0700: this user's only; or 0755). */
export declare function writeExecutable(file: string, data: string, mode: 0o700 | 0o755): void;
/**
 * Install a secret for this user only, as the setup scripts do (credentials.sh): `dir` 0700, the file 0400,
 * written to a fresh temp name (O_EXCL) and renamed over any old one. Refuses a symlinked directory or file, a
 * directory another user owns, and running as root (a secret belongs to the coordinator user). Returns the path.
 */
export declare function installOwnerOnlySecret(dir: string, name: string, value: string): string;
/**
 * Install a secret for `user` only, as credentials.sh does (`install -o user -m 0400` into a 0700 directory of
 * theirs): written to a fresh temp name (O_EXCL), owned by `user`, renamed over any old one. Run as root (setup),
 * the directory and file are given to `user`; run as anyone else, `user` must be this user. Refuses a symlinked
 * directory or file, and a directory someone else owns. POSIX only. Returns the path.
 */
export declare function installSecretFor(user: string, dir: string, name: string, value: string): string;
/** Whether this process runs as root (POSIX; never on native Windows). */
export declare function isRoot(): boolean;
/** An OS user's primary group id (POSIX), or null if there is no such user (or on native Windows). */
export declare function userGid(user: string): number | null;
/**
 * How to run `argv` (a fixed command) in a pseudo-terminal, for the dashboard's owner terminal. Linux only:
 * util-linux `script` makes the PTY, so no native module is needed. `script -c` hands its command to a shell, so
 * every word must be plain (no shell metacharacters). Returns the [file, args] to spawn.
 */
export declare function ptyCommand(argv: string[], size: {
    cols: number;
    rows: number;
}): [file: string, args: string[]];
/**
 * The uid that owns the client end of a loopback TCP connection to this process, from a /proc/net/tcp or
 * /proc/net/tcp6 table: the row whose local address is the client's (127.0.0.1 or ::1, `clientPort`) and whose
 * remote address is our listening port. Null when there's no such row.
 */
export declare function peerUidFromProcNet(table: string, clientPort: number, serverPort: number): number | null;
/**
 * Which OS user opened a loopback connection to us (the kernel's record, not anything the client says). Linux
 * only, from /proc/net/tcp{,6}; null elsewhere, or when the connection isn't found.
 */
export declare function loopbackPeerUid(clientPort: number, serverPort: number): number | null;
/** The OS user this process runs as. */
export declare function currentUser(): string;
export declare function writeGroupOnly(file: string, data: string | Uint8Array): void;
export declare function detectOs(setting?: OsSetting): OsKind;
/**
 * The platform a downloaded tool must be built for (src/tool-pins.ts), or null where none is pinned: native Windows
 * (local mode there runs inside WSL2, which is Linux) and anything but x64 and arm64.
 */
export declare function toolPlatform(platform?: string, arch?: string): {
    os: 'linux' | 'darwin';
    arch: 'x64' | 'arm64';
} | null;
/** Agents only run where Bash can be sandboxed; native Windows can't. */
export declare function canRunAgents(os: OsKind): boolean;
/** Machine-local state (event log, fingerprints, findings). Never inside a repo. */
export declare function stateDir(): string;
/** An OS user's numeric id (POSIX), or null if there is no such user (or on native Windows). */
export declare function userUid(user: string): number | null;
/**
 * Who owns a file and who besides the owner may touch it (POSIX): 'missing', 'hidden' when this user can't even
 * stat it (a directory it may not enter), or its owner uid and whether group or others have any permission. Never
 * reads the file. Native Windows has no POSIX modes: 'unsupported'.
 */
export declare function fileAccess(file: string): {
    kind: 'missing';
} | {
    kind: 'hidden';
} | {
    kind: 'unsupported';
} | {
    kind: 'file';
    uid: number;
    openToOthers: boolean;
    mode: string;
};
/**
 * A regular file's owner, mode and text, read through one descriptor opened without following a symlink, so what is
 * checked is what is read. Refused (by kind): no such file, unreadable, a symlink, not a regular file, or over
 * `maxBytes`. Native Windows has no owners to check: unsupported.
 */
export declare function readRegularFile(file: string, maxBytes: number): {
    kind: 'missing' | 'hidden' | 'unsupported' | 'symlink' | 'not-file';
} | {
    kind: 'too-big';
    size: number;
} | {
    kind: 'file';
    uid: number;
    mode: string;
    text: string;
};
/** Whether an OS user exists on this machine (POSIX; always false on native Windows). */
export declare function userExists(user: string): boolean;
/** Full path of an executable on `path` (PATH by default), or null. */
export declare function which(cmd: string, path?: string): string | null;
/** True if a process with this pid exists (signal 0 probes without killing). */
export declare function pidAlive(pid: number): boolean;
export declare function wslAvailable(): boolean;
export declare function homeDir(): string;
/** Where `npm install -g --prefix <prefix>` puts a package: lib/node_modules on macOS and Linux, node_modules on Windows. */
export declare function npmGlobalPackageDir(prefix: string, pkg: string, platform?: NodeJS.Platform): string;
/** Where Chrome or Chromium is usually installed on this OS, most likely first (then the PATH is searched). */
export declare function chromeCandidates(): string[];
/** Spawn children in their own process group where the OS supports it, so a timeout kills the whole tree. */
export declare const spawnDetached: boolean;
/**
 * Run a program as another (unprivileged) OS user, with exactly this
 * environment: `sudo -n -u <user> -- env -i K=V... <file> <args>`. The
 * operator's sudoers rule lets the coordinator user switch to the agent
 * user without a password, and nothing else. POSIX only.
 */
export declare function asUser(user: string, file: string, args: string[], env: NodeJS.ProcessEnv): [file: string, args: string[]];
/**
 * How to spawn a project command (a check, a test suite, a setup step):
 * under bash with pipefail, and as the instance's agent user when there is
 * one, with a clean environment. Project commands run code agents wrote, so
 * they never run as the user that holds the instance's credentials.
 */
/**
 * A command wrapped to record its largest single process's peak memory (a test worker's), where the OS can:
 * GNU time on Linux writes the peak resident size in KB to `outFile`. Elsewhere the command is unchanged and
 * nothing is recorded (peakMemoryMb then reads null).
 */
export declare function withPeakMemory(command: string, outFile: string): string;
/** The peak recorded by withPeakMemory, in MB; null when nothing was (another OS, or no output). */
export declare function peakMemoryMb(outFile: string): number | null;
/**
 * The PATH project commands get when they run as the agent user (instance.yaml run_as.path overrides it): the
 * system directories, and on macOS Homebrew's too (/opt/homebrew on Apple silicon; /usr/local is already listed).
 */
export declare function defaultAgentPath(platform?: NodeJS.Platform): string;
/** Where user homes usually are, for a user not created yet: /Users on macOS, /home elsewhere. */
export declare function homesRoot(platform?: NodeJS.Platform): string;
/** A user's home directory from the system's user database (null: no such user, or no way to ask here). */
/**
 * Open a file to one group, read only (0640), keeping its owner: on Linux, when the group exists and this process may
 * hand the file to it (root, or a member). Anywhere else, or when it can't, it stays as it was: false.
 */
export declare function shareReadWithGroup(file: string, group: string, platform?: NodeJS.Platform): boolean;
export declare function homeOf(user: string, platform?: NodeJS.Platform): string | null;
export declare function projectCommand(command: string, runAs?: {
    user: string;
    home: string;
    path?: string;
}, projectEnv?: Record<string, string>): {
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv;
};
/**
 * Whether a pid can be a child's (and its process group's): a whole number above 1. INVARIANT: never 0 or below, nor 1:
 * kill(0) signals the caller's own process group, kill(-n) the group n, and kill(-1) every process the user may signal.
 * A child that didn't start has no pid at all.
 */
export declare const isChildPid: (pid: number | undefined) => pid is number;
/** Kill a process group that runs as another user: only that user (or root) may signal it. */
export declare function killTreeAs(user: string, pgid: number | undefined): void;
export declare function killTree(pid: number | undefined, fallback: () => void): void;
/** Windows needs a shell to run npm's .cmd shims. */
export declare const shimsNeedShell: boolean;
/**
 * The shell project commands run in: bash, never plain sh or cmd.exe, so
 * pipefail is available. On Windows that is Git for Windows' bash (the one
 * Claude Code uses for hooks); PATH's bash.exe may be the WSL launcher.
 */
export declare function commandBash(): string;
/**
 * How to spawn a project command: `bash -o pipefail -c <command>`, so a
 * pipeline fails when any stage fails (`npm test | tail` is red when the
 * tests are). Use with shell: false.
 */
export declare function shellCommand(command: string): [file: string, args: string[]];
/**
 * Environment for project commands the engine runs (checks, tests). Drops
 * variables that change how a nested runner behaves when the engine itself
 * runs under a test runner (node --test sets NODE_TEST_CONTEXT, which makes a
 * nested `node --test` report to the parent instead of exiting non-zero).
 */
export declare function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
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
export declare const SYSTEM_SLOTS: {
    dir: string;
    config: string;
};
/**
 * The engine updater's drain flag (scripts/machine/<cli>-update.cjs, src/update-drain.ts): with the system slot
 * directory it is in root's /var/lib/<cli>, beside the updater's other files, so no coordinator can write or remove
 * it (the slot directory itself is group-writable); with any other slot directory (development, tests), inside it.
 */
export declare const UPDATE_DRAIN_FILE: string;
export declare function updateDrainPath(dir?: string, system?: {
    dir: string;
    config: string;
}): string;
export declare function slotsDir(system?: {
    dir: string;
    config: string;
}): string;
/**
 * The machine's slot config (max_agents): AGENT_SLOTS_CONFIG if
 * set; else the system config file when the system slot directory is in
 * use and the file exists; else config.json in the slot directory.
 */
export declare function slotsConfigPath(dir?: string, system?: {
    dir: string;
    config: string;
}): string;
export interface ServiceSpec {
    label: string;
    program: string[];
    workingDir: string;
    logFile: string;
    env?: Record<string, string>;
}
/**
 * What installService would write and how it starts it, without doing either: the file, the service manager and the
 * commands it runs. The first-run page shows this before its Start button does anything.
 */
export declare function serviceChange(label: string): {
    path: string;
    manager: string;
    commands: string[];
} | null;
/** Whether this user's service (installService's label) is loaded and running now; null where there is no service manager to ask. */
export declare function serviceRunning(label: string): boolean | null;
/** Whether a system unit (an instance's `<cli>-<name>.service`) is active; null off Linux. Any user may ask systemd this. */
export declare function systemUnitActive(unit: string): boolean | null;
/**
 * Linux only: whether this user's services run without a login session (loginctl's Linger). null elsewhere (launchd
 * agents need no such thing) or when loginctl can't tell.
 */
export declare function lingerEnabled(user?: string): boolean | null;
/** Install and start a per-user service that restarts on failure and survives logout of any session. */
export declare function installService(spec: ServiceSpec): {
    path: string;
    started: boolean;
    detail: string;
};
/**
 * Unload a per-user launchd agent and wait until launchd no longer lists it. `bootout` can return while the job is
 * still listed (one waiting out its KeepAlive throttle, say); then it is booted out again by its plist. True once it
 * is gone; false if it is still listed after `waitMs`.
 */
export declare function launchdUnload(label: string, plist: string, o?: {
    uid?: number;
    run?: (args: string[]) => boolean;
    sleep?: (ms: number) => void;
    waitMs?: number;
}): boolean;
export declare function uninstallService(label: string): string;
/**
 * Sustained load: the higher of the 5- and 15-minute averages, or null where
 * the OS doesn't report load (Windows). The 15-minute average alone reads
 * low for a while after a reboot or a burst, so it isn't enough.
 */
export declare function machineLoad(): number | null;
/** Open a URL in the default browser, best effort. */
export declare function openUrl(url: string): void;
/**
 * A browser opener that opens nothing: it writes the URL it is given to `urlFile` (this user's only), so a program
 * that opens a browser through $BROWSER (claude auth login) hands its URL to the dashboard instead. Written into
 * `dir` (a 0700 directory of this user's), 0700. Null where $BROWSER can't name such a script (Windows): there the
 * program opens the browser itself.
 */
export declare function browserRelay(dir: string, urlFile: string): string | null;
/** A native executable's file name on this OS. */
export declare function executableName(base: string): string;
/** Free disk on the volume holding `path`: percent and GB. */
export declare function diskFree(path: string): {
    freePct: number;
    freeGb: number;
    totalGb: number;
};
/**
 * Replace a file's content atomically: a temp file beside it (so the rename stays on one filesystem), with
 * `mode` and, on POSIX, the original's owner and group; then rename over it. On failure the temp file is
 * removed and the original is untouched. `ownerOf`: the file (or directory) whose owner and group it gets, for a
 * file that doesn't exist yet (root writing into a user's home keeps it that user's).
 */
export declare function replaceFileAtomically(path: string, data: string, mode: number, ownerOf?: string): void;
export declare function cpuCount(): number;
/**
 * Whether another process holds a flock(2) lock on `path`, without taking it (a lock file another workload, such as
 * a simulator, holds while it runs; such files usually always exist, so existence says nothing). Linux: the file's
 * device and inode against the FLOCK entries of /proc/locks (waiters, "->", don't hold). macOS: a non-blocking
 * shared try-lock on the file opened read-only, released at once (a holder of an exclusive lock refuses it; a
 * simulator's `flock -w` at worst waits microseconds). Windows: never held. Null when it can't tell: the caller
 * treats that as held, so it never contends.
 */
export declare function flockHeld(path: string): boolean | null;
/** A held flock(2) lock, kept by a small holder process until released (or this process exits: its stdin closes). */
export interface HeldFlock {
    release(): Promise<void>;
}
/**
 * Take a flock(2) lock on `path`, shared or exclusive, waiting for as long as it takes (until `signal` aborts). The
 * file is opened read-only, so a root-owned 0644 lock file works. A perl holder (perl ships with macOS and every
 * Linux distribution) takes it and keeps it while its stdin is open, so a crashed coordinator never leaves it held.
 * Rejects when the file is missing or the holder can't run: a run never goes ahead unlocked. Windows has no flock.
 */
export declare function holdFlock(path: string, mode: 'shared' | 'exclusive', signal?: AbortSignal): Promise<HeldFlock>;
/** Who holds flock(2) locks on `path` now, each holder's pid and mode, from /proc/locks (Linux); null where it can't tell. */
export declare function flockHolders(path: string): {
    pid: number;
    mode: 'shared' | 'exclusive';
}[] | null;

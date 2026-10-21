// OS adapter layer. This is the only module allowed to branch on the
// platform (test/os-boundary.test.ts enforces it).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { testRunSign } from './system-paths.js';
import { availableParallelism, homedir, loadavg, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, posix as posixPath, resolve as resolvePath, sep } from 'node:path';
import { BRAND } from '../brand.js';
import { ownEnv, type OwnEnv } from './own-env.js';
import { outboundEnv } from '../network.js';
import { safeProjectEnv } from '../project-env.js';
import { withoutPushGateHatch } from '../guardrails/push-hook.js';
import { readRegularSlotFile, slotFile, slotPathOf, statfsSlotDir, type SlotPath, type SlotPathLike } from '../slot-file.js';
import { devSlotsPath, etcPath, markTestRun, testSlotsRefusal, TestSlotsRefused, varLibPath } from './system-paths.js';
import { testStateRefusal, TestStateRefused } from './system-paths.js';

export type OsKind = 'macos' | 'linux' | 'windows-wsl' | 'windows';
export type OsSetting = 'auto' | 'macos' | 'linux' | 'windows-wsl';

/**
 * The coordinator's state is for its own user and group only, never anyone else on the machine:
 * directories 0770, files 0660 (files kept 0600, like the dashboard token, are left as they are).
 * No-op on Windows, where access is by ACL, not mode bits.
 */
export function groupOnly(...paths: string[]): void {
  if (process.platform === 'win32') return;
  for (const p of paths) {
    try {
      const st = statSync(p);
      const want = st.isDirectory() ? 0o770 : (st.mode & 0o777) === 0o600 ? 0o600 : 0o660;
      if ((st.mode & 0o777) !== want) chmodSync(p, want);
    } catch {
      // not there (yet)
    }
  }
}

/**
 * A directory the agent user can read but not write: owned by this (coordinator) user, group `gid` (the group
 * the agents share), 2750, so files made in it keep that group. No-op beyond mkdir on Windows.
 */
export function agentReadableDir(dir: string, gid: number): void {
  agentDir(dir, gid, 0o2750, 'task files');
}

/**
 * A directory the agents' group may also write (a dependency cache their setup steps fill): owned by this
 * (coordinator) user, group `gid`, 2770. The same checks as agentReadableDir keep it from being swapped.
 */
export function agentWritableDir(dir: string, gid: number): void {
  agentDir(dir, gid, 0o2770, 'a shared cache');
}

function agentDir(dir: string, gid: number, mode: number, what: string): void {
  if (process.platform === 'win32') {
    mkdirSync(dir, { recursive: true });
    return;
  }
  const me = process.getuid!();
  // The parent must not let anyone else rename or replace this directory: a group-writable parent (the agents'
  // group) gets the sticky bit, which this user may set on a directory it owns; otherwise refuse.
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const p = statSync(parent);
  if ((p.mode & 0o022) !== 0 && (p.mode & 0o1000) === 0) {
    if (p.uid !== me) throw new Error(`${parent} is writable by others and not sticky, and not ours to fix: ${what} can't be kept safe there`);
    chmodSync(parent, (p.mode & 0o7777) | 0o1000);
  }
  if (existsSync(dir) && statSync(dir).uid !== me) throw new Error(`${dir} exists but isn't owned by this user; refusing to keep ${what} there`);
  mkdirSync(dir, { recursive: true, mode: mode & 0o777 });
  chownSync(dir, me, gid);
  chmodSync(dir, mode);
}

/** A file the agent user can read but not write: owner this user, group `gid`, 0640. */
export function writeAgentReadable(file: string, data: string | Buffer, gid: number): void {
  writeFileSync(file, data, { mode: 0o640 });
  if (process.platform === 'win32') return;
  chownSync(file, process.getuid!(), gid);
  chmodSync(file, 0o640);
}

/**
 * groupOnly over a whole tree, for state an older engine left open: every directory 0770, every file 0660
 * (0600 files stay 0600). Symlinks are never followed or changed. Returns what it changed, relative to `root`.
 * No-op on Windows.
 */
export function groupOnlyTree(root: string): string[] {
  if (process.platform === 'win32' || !existsSync(root)) return [];
  const changed: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue; // removed meanwhile
      }
      if (st.isSymbolicLink()) continue;
      const before = st.mode & 0o777;
      groupOnly(p);
      if ((statSync(p).mode & 0o777) !== before) changed.push(r);
      if (st.isDirectory()) walk(p, r);
    }
  };
  const before = statSync(root).mode & 0o777;
  groupOnly(root);
  if ((statSync(root).mode & 0o777) !== before) changed.push('.');
  walk(root, '');
  return changed;
}

/** mkdir -p, then groupOnly on the directory itself. */
export function groupOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o770 });
  groupOnly(dir);
}

/** Write a state file readable by the coordinator's user and group only. */
/** A directory only this user can enter (0700): for data no group member may read, such as raw intake reports. */
export function ownerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
}

/** Write a file only this user can read (0600), atomically (a temp file in the same directory, then a rename). */
export function writeOwnerOnly(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Write an executable file (a git hook) atomically, with exactly `mode` (0700: this user's only; or 0755). */
export function writeExecutable(file: string, data: string, mode: 0o700 | 0o755): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  if (process.platform !== 'win32') chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/**
 * Install a secret for this user only, as the setup scripts do (credentials.sh): `dir` 0700, the file 0400,
 * written to a fresh temp name (O_EXCL) and renamed over any old one. Refuses a symlinked directory or file, a
 * directory another user owns, and running as root (a secret belongs to the coordinator user). Returns the path.
 */
export function installOwnerOnlySecret(dir: string, name: string, value: string): string {
  const posix = process.platform !== 'win32';
  if (posix && process.getuid!() === 0) throw new Error("refusing to install a secret as root; the dashboard runs as the instance's coordinator user");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink; refusing`);
  if (posix) {
    if (statSync(dir).uid !== process.getuid!()) throw new Error(`${dir} isn't owned by this user; refusing`);
    chmodSync(dir, 0o700);
  }
  const file = join(dir, name);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; refusing`);
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, value, { mode: 0o400, flag: 'wx' });
    if (posix) chmodSync(tmp, 0o400);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/**
 * Install a secret for `user` only, as credentials.sh does (`install -o user -m 0400` into a 0700 directory of
 * theirs): written to a fresh temp name (O_EXCL), owned by `user`, renamed over any old one. Run as root (setup),
 * the directory and file are given to `user`; run as anyone else, `user` must be this user. Refuses a symlinked
 * directory or file, and a directory someone else owns. POSIX only. Returns the path.
 */
export function installSecretFor(user: string, dir: string, name: string, value: string): string {
  if (process.platform === 'win32') throw new Error('installing a secret for another user needs macOS or Linux');
  const root = process.getuid!() === 0;
  if (!root && user !== currentUser()) throw new Error(`installing a secret for ${user} needs root (this is ${currentUser() || 'an unknown user'})`);
  const uid = root ? userUid(user) : process.getuid!();
  const gid = root ? userGid(user) : process.getgid!();
  if (uid === null || gid === null) throw new Error(`no user ${user}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink; refusing`);
  if (root) chownSync(dir, uid, gid);
  if (statSync(dir).uid !== uid) throw new Error(`${dir} isn't owned by ${user}; refusing`);
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; refusing`);
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, value, { mode: 0o400, flag: 'wx' });
    chmodSync(tmp, 0o400);
    if (root) chownSync(tmp, uid, gid);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/** Whether this process runs as root (POSIX; never on native Windows). */
export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** An OS user's primary group id (POSIX), or null if there is no such user (or on native Windows). */
/** A user's home directory, from the passwd database (getent); null where there is none or no such user. */
export function userHomeDir(user: string): string | null {
  if (process.platform === 'win32' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return null;
  try {
    const home = execFileSync('getent', ['passwd', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim().split(':')[5];
    return home && home.startsWith('/') ? home : null;
  } catch {
    return null;
  }
}

/** A group's gid, from the group database (getent); null where there is none or no such group. */
export function groupGid(group: string): number | null {
  if (process.platform === 'win32' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(group)) return null;
  try {
    const out = execFileSync('getent', ['group', group], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    const gid = out.split(':')[2];
    return gid && /^\d+$/.test(gid) ? Number(gid) : null;
  } catch {
    return null;
  }
}

export function userGid(user: string): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('id', ['-g', '--', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

const hexPort = (p: number) => p.toString(16).toUpperCase().padStart(4, '0');

/**
 * The uid that owns the client end of a loopback TCP connection to this process, from a /proc/net/tcp or
 * /proc/net/tcp6 table: the row whose local address is the client's (127.0.0.1 or ::1, `clientPort`) and whose
 * remote address is our listening port. Null when there's no such row.
 */
export function peerUidFromProcNet(table: string, clientPort: number, serverPort: number): number | null {
  const v4 = '0100007F';
  const v6 = ['00000000000000000000000001000000', '0000000000000000FFFF00000100007F'];
  const ok = (addr: string, port: number) => {
    const [ip, p] = addr.split(':');
    return p === hexPort(port) && (ip === v4 || v6.includes(ip!));
  };
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    if (ok(f[1]!, clientPort) && ok(f[2]!, serverPort)) {
      const uid = Number(f[7]);
      return Number.isInteger(uid) ? uid : null;
    }
  }
  return null;
}

/**
 * Which OS user opened a loopback connection to us (the kernel's record, not anything the client says). Linux
 * only, from /proc/net/tcp{,6}; null elsewhere, or when the connection isn't found.
 */
export function loopbackPeerUid(clientPort: number, serverPort: number): number | null {
  if (process.platform !== 'linux') return null;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const uid = peerUidFromProcNet(readFileSync(f, 'utf8'), clientPort, serverPort);
      if (uid !== null) return uid;
    } catch {
      // no such table
    }
  }
  return null;
}

/**
 * Whether the process at the other end of a loopback connection to us runs as this OS user: true or false on Linux
 * (the kernel's socket table), null elsewhere, where there's no check (macOS, Windows: loopback alone).
 */
export function loopbackPeerIsMe(clientPort: number, serverPort: number, platform: NodeJS.Platform = process.platform): boolean | null {
  if (platform !== 'linux') return null;
  const uid = loopbackPeerUid(clientPort, serverPort);
  return uid !== null && typeof process.getuid === 'function' && uid === process.getuid();
}

/**
 * The uid this process acts as (its effective uid), from the kernel through Node, never from a program found on PATH
 * or the environment (#715). Null on native Windows, which has no uids.
 */
export function currentUid(): number | null {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

/** The OS user this process runs as. */
export function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

export function writeGroupOnly(file: string, data: string | Uint8Array): void {
  writeFileSync(file, data, { mode: 0o660 });
  groupOnly(file);
}

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

/**
 * The platform a downloaded tool must be built for (src/tool-pins.ts), or null where none is pinned: native Windows
 * (local mode there runs inside WSL2, which is Linux) and anything but x64 and arm64.
 */
export function toolPlatform(platform: string = process.platform, arch: string = process.arch): { os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' } | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  return os && a ? { os, arch: a } : null;
}

/** Agents only run where Bash can be sandboxed; native Windows can't. */
export function canRunAgents(os: OsKind): boolean {
  return os !== 'windows';
}

/**
 * Machine-local state (event log, fingerprints, findings). Never inside a repo.
 *
 * INVARIANT (#815): in a test run, only a directory inside the test machine (test/isolate.ts); anything else throws
 * TestStateRefused before a file is opened (src/os/system-paths.ts testStateRefusal), so no test reaches the person's
 * own state dir through a default it fell through to. Outside a test run, as always.
 */
export function stateDir(): string {
  // WHY (#786): one own-variable snapshot for the dir and its refusal, as slotsDir does: a value on Object.prototype
  // neither moves the state dir nor, paired with an own-only check, un-refuses it.
  const env = ownEnv();
  const dir = unguardedStateDir(env);
  const refusal = testStateRefusal(dir, env.asProcessEnv());
  if (refusal) throw new TestStateRefused(refusal);
  return dir;
}

function unguardedStateDir(env: OwnEnv): string {
  const override = env.get(`${BRAND.envPrefix}_STATE_DIR`);
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', BRAND.cli);
  if (process.platform === 'win32') return join(env.get('LOCALAPPDATA') ?? join(homedir(), 'AppData', 'Local'), BRAND.cli);
  return join(env.get('XDG_STATE_HOME') ?? join(homedir(), '.local', 'state'), BRAND.cli);
}

/** An OS user's numeric id (POSIX), or null if there is no such user (or on native Windows). */
export function userUid(user: string): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('id', ['-u', '--', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

/**
 * Who owns a file and who besides the owner may touch it (POSIX): 'missing', 'hidden' when this user can't even
 * stat it (a directory it may not enter), or its owner uid and whether group or others have any permission. Never
 * reads the file. Native Windows has no POSIX modes: 'unsupported'.
 */
export function fileAccess(file: string): { kind: 'missing' } | { kind: 'hidden' } | { kind: 'unsupported' } | { kind: 'file'; uid: number; openToOthers: boolean; mode: string } {
  if (process.platform === 'win32') return { kind: 'unsupported' };
  try {
    const s = statSync(file);
    return { kind: 'file', uid: s.uid, openToOthers: (s.mode & 0o077) !== 0, mode: (s.mode & 0o777).toString(8).padStart(4, '0') };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' ? { kind: 'hidden' } : { kind: 'missing' };
  }
}

/**
 * A regular file's owner, mode and text, read through one descriptor opened without following a symlink, so what is
 * checked is what is read. Refused (by kind): no such file, unreadable, a symlink, not a regular file, or over
 * `maxBytes`. Native Windows has no owners to check: unsupported.
 */
export function readRegularFile(file: SlotPathLike, maxBytes: number): { kind: 'missing' | 'hidden' | 'unsupported' | 'symlink' | 'not-file' } | { kind: 'too-big'; size: number } | { kind: 'file'; uid: number; mode: string; text: string } {
  if (process.platform === 'win32') return { kind: 'unsupported' };
  // INVARIANT: O_NOFOLLOW, so a symlink is refused rather than followed (#391 follow-up). The open, the checks and the
  // read are src/slot-file.ts's, so a slot path (#772) can be read too, and no descriptor of one (whose
  // /proc/self/fd link names its path: #806 review, A2) ever leaves that module.
  return readRegularSlotFile(file, maxBytes);
}

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

/** Full path of an executable on `path` (PATH by default), or null. */
export function which(cmd: string, path: string = ownEnv().get('PATH') ?? ''): string | null {
  const exts = process.platform === 'win32' ? (ownEnv().get('PATHEXT') ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      if (dir && existsSync(p)) return p;
      const q = join(dir, cmd + ext);
      if (dir && existsSync(q)) return q;
    }
  }
  return null;
}

/**
 * Directories a version manager (or Homebrew) puts one node version in, and deletes on an upgrade or uninstall:
 * Homebrew's Cellar, nvm, fnm, asdf, volta, mise. A service that runs node by such a path stops at its next restart.
 */
const VERSIONED_NODE_DIRS: readonly RegExp[] = [/\/Cellar\/node(@\d+)?\//, /\/\.nvm\/versions\//, /\/\.fnm\/|\/fnm\/node-versions\//, /\/\.asdf\/installs\//, /\/\.volta\/tools\/image\//, /\/mise\/installs\//];
export const inVersionedNodeDir = (path: string): boolean => VERSIONED_NODE_DIRS.some((re) => re.test(path));

/**
 * INVARIANT (#468): a path no one but this user (or root) can redirect: every directory on the way to it, and to each
 * hop of its symlinks, is owned by this user or root and writable by no one else (or, like /tmp, sticky with the entry
 * owned by this user or root; or by a group whose members can become root anyway: wheel, macOS's admin). Homebrew's bin/node is named only when this holds.
 */
/** Groups whose members can become root (sudo) on this OS: wheel, and macOS's admin. */
const ROOT_EQUIVALENT_GIDS: readonly number[] = process.platform === 'darwin' ? [0, 80] : [0];

export function ownedPath(path: string, o: { uid?: number; lstat?: typeof lstatSync; readlink?: (p: string) => string } = {}): boolean {
  if (process.platform === 'win32') return true;
  const me = o.uid ?? process.getuid?.() ?? 0;
  const ls = o.lstat ?? lstatSync;
  const rl = o.readlink ?? ((p: string) => readlinkSync(p));
  const mine = (uid: number) => uid === me || uid === 0;
  let cur = resolvePath(path);
  for (let hop = 0; hop < 40; hop++) {
    const parts = cur.split(sep).filter(Boolean);
    let dir: string = sep;
    try {
      for (const name of parts) {
        const d = ls(dir);
        const child = join(dir, name);
        const c = ls(child);
        if (!mine(d.uid) || !mine(c.uid)) return false;
        // Others may write it: only with the sticky bit (like /tmp), the entry being this user's or root's (checked above).
        if (d.mode & 0o002 && !(d.mode & 0o1000)) return false;
        // Its group may write it: only a group whose members can become root anyway (wheel; on macOS admin, which
        // Homebrew's directories belong to).
        if (d.mode & 0o020 && !(d.mode & 0o1000) && !ROOT_EQUIVALENT_GIDS.includes(d.gid)) return false;
        dir = child;
      }
      const last = ls(cur);
      if (!last.isSymbolicLink()) return true;
      cur = resolvePath(dirname(cur), rl(cur));
    } catch {
      return false;
    }
  }
  return false;
}

/** Where Homebrew installs itself (`brew --prefix`): Apple silicon and Intel macOS. */
export const BREW_PREFIXES: readonly string[] = ['/opt/homebrew', '/usr/local'];

/**
 * WHY (#468): the node a local service (launchd plist, systemd user unit) or the checkout's git hooks should name.
 * The owner's rule: Homebrew's stable symlink, `$(brew --prefix)/bin/node`, when this node is Homebrew's (its
 * realpath is that symlink's); else this process's own absolute path. Never a `node` found on PATH: a directory on
 * PATH can be someone else's to plant one in. The prefix is read from Homebrew's fixed install places (where
 * `brew --prefix` itself lives), never by running a `brew` found on PATH. `versioned`: the path named is inside a
 * versioned directory an upgrade deletes; `why` then says so and what to do.
 */
export function stableNodePath(o: { execPath?: string; brewPrefixes?: readonly string[]; real?: (p: string) => string; owned?: (p: string) => boolean } = {}): { path: string; versioned: boolean; why: string | null } {
  const exec = o.execPath ?? process.execPath;
  const real = o.real ?? ((p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const target = real(exec);
  for (const prefix of o.brewPrefixes ?? BREW_PREFIXES) {
    const node = join(prefix, 'bin', 'node');
    if (!existsSync(join(prefix, 'bin', 'brew')) || !existsSync(node)) continue;
    if (real(node) === target && (o.owned ?? ownedPath)(node)) return { path: node, versioned: false, why: null };
  }
  if (!inVersionedNodeDir(exec)) return { path: exec, versioned: false, why: null };
  return { path: exec, versioned: true, why: `node runs from ${exec}, inside a versioned directory (Homebrew's Cellar, nvm, fnm, asdf, volta or mise) that isn't Homebrew's own bin/node: the next upgrade deletes it and the service stops at its next restart. Install node with Homebrew (its $(brew --prefix)/bin/node is used), or run this from a node outside a versioned directory, then run it again` };
}


/** What is wrong with the node a service runs, if anything: gone, or inside a versioned directory. */
export function nodePathProblem(node: string, exists: (p: string) => boolean = existsSync): string | null {
  if (!exists(node)) return `runs node at ${node}, which no longer exists (an upgrade removed it): the service fails at its next start`;
  if (inVersionedNodeDir(node)) return `runs node at ${node}, inside a versioned directory: the next upgrade deletes it`;
  return null;
}

/** A per-user service's program as its file has it (launchd's ProgramArguments, or systemd's ExecStart): the file and its first argument. */
export function serviceProgram(label: string, read: (file: string) => string | null = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null)): { file: string; node: string } | null {
  const file = serviceChange(label)?.path;
  if (!file) return null;
  const text = read(file);
  if (text === null) return null;
  const node = programOf(text);
  return node ? { file, node } : null;
}

/** The first program argument of a launchd plist or a systemd unit's text. */
export function programOf(text: string): string | null {
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
  if (plist) return plist[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const unit = /^ExecStart=("((?:[^"\\]|\\.)*)"|(\S+))/m.exec(text);
  if (unit) return unit[2] !== undefined ? unit[2].replace(/\\(["\\])/g, '$1') : (unit[3] ?? null);
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

/** Where `npm install -g --prefix <prefix>` puts a package: lib/node_modules on macOS and Linux, node_modules on Windows. */
export function npmGlobalPackageDir(prefix: string, pkg: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(prefix, 'node_modules', ...pkg.split('/')) : join(prefix, 'lib', 'node_modules', ...pkg.split('/'));
}

/** Where Chrome or Chromium is usually installed on this OS, most likely first (then the PATH is searched). */
export function chromeCandidates(): string[] {
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  if (process.platform === 'win32') {
    const env = ownEnv();
    return [
      join(env.get('PROGRAMFILES') ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env.get('PROGRAMFILES(X86)') ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env.get('LOCALAPPDATA') ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  return [];
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
 * A command wrapped to record its largest single process's peak memory (a test worker's), where the OS can:
 * GNU time on Linux writes the peak resident size in KB to `outFile`. Elsewhere the command is unchanged and
 * nothing is recorded (peakMemoryMb then reads null).
 */
export function withPeakMemory(command: string, outFile: string): string {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/time')) return command;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `/usr/bin/time -f %M -o ${q(outFile)} sh -c ${q(command)}`;
}

/** The peak recorded by withPeakMemory, in MB; null when nothing was (another OS, or no output). */
export function peakMemoryMb(outFile: string): number | null {
  try {
    const kb = Number(readFileSync(outFile, 'utf8').trim().split('\n').pop());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

/**
 * The PATH project commands get when they run as the agent user (instance.yaml run_as.path overrides it): the
 * system directories, and on macOS Homebrew's too (/opt/homebrew on Apple silicon; /usr/local is already listed).
 */
export function defaultAgentPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin' : '/usr/local/bin:/usr/bin:/bin';
}

/** Where user homes usually are, for a user not created yet: /Users on macOS, /home elsewhere. */
export function homesRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/Users' : '/home';
}

/**
 * Open a file to one group, read only (0640), keeping its owner: on Linux, when the group exists and this process may
 * hand the file to it (root, or a member). Anywhere else, or when it can't, it stays as it was: false.
 */
export function shareReadWithGroup(file: string, group: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(group) || typeof process.getuid !== 'function') return false;
  try {
    const gid = Number(execFileSync('getent', ['group', group], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).split(':')[2]);
    if (!Number.isInteger(gid)) return false;
    chownSync(file, statSync(file).uid, gid);
    chmodSync(file, 0o640);
    return true;
  } catch {
    return false;
  }
}

export function homeOf(user: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return null;
  try {
    if (platform === 'linux') {
      const line = execFileSync('getent', ['passwd', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
      return line.split(':')[5] || null;
    }
    if (platform === 'darwin') {
      const out = execFileSync('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
      return /NFSHomeDirectory:\s*(\S.*)$/m.exec(out)?.[1]?.trim() || null;
    }
  } catch {
    // no such user
  }
  return null;
}

/** Bubblewrap at its fixed, root-owned path: never PATH's, where a directory the agent user can write could hold a fake. */
export const PROJECT_SANDBOX_TOOL = '/usr/bin/bwrap';
/** The exit code of a project command whose sandbox couldn't start: nothing of the command ran. */
export const SANDBOX_UNAVAILABLE = 125;
export const SANDBOX_FIX = 'install bubblewrap and its AppArmor rule with scripts/setup/machine.sh, then check with scripts/setup/check.sh <name>';
/** The sandbox's flags: one source for it and its probe (check.sh). */
export const PROJECT_SANDBOX_ARGS = ['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--die-with-parent', '--proc', '/proc'] as const;
/** Whether this user can start it: check.sh's probe, and the wrapper's first step. */
export const PROJECT_SANDBOX_PROBE: readonly string[] = [PROJECT_SANDBOX_TOOL, ...PROJECT_SANDBOX_ARGS, '--', '/bin/sh', '-c', ':'];

/** A project command's agent user and what its sandbox hides beyond ~/.claude*; `hide` required, never dropped. */
export interface ProjectRunAs {
  user: string;
  home: string;
  path?: string;
  hide: readonly string[];
}

// Run as the agent user before any project code: hides each path given (the command follows `--`), every ~/.claude*
// and ~/.config/*-claude-key (credentials.sh's API key): a tmpfs over a directory, /dev/null over a file. Its own PID
// namespace and /proc: no outside process (a `claude` holding a login) is readable through /proc/<pid>. Devices and
// network stay. A tool that can't start is refused (SANDBOX_UNAVAILABLE) before the command runs.
// INVARIANT: this bash gets an empty environment, so nothing a project sets (SHELLOPTS, BASHOPTS, IFS, ...) reaches
// it; the project's variables are the inner `env -i` after `--`, passed on as words. Glob and shell options are reset
// anyway. --norc --noprofile: it reads no startup file, such as the agent's ~/.bashrc (writable by a sandboxed
// command; sourced by bash's rshd check for `bash -c` with a socket on stdin).
// Every directory above a hidden path is bound onto itself first (shallowest first, before any mask): renaming it
// fails (EBUSY), so the secret can't be moved out from under its mask. (--bind adds nosuid,nodev: a hidden path
// under /dev would cost the sandbox its devices.)
const LINUX_SANDBOX = [
  'set +f; shopt -u failglob nullglob dotglob nocaseglob extglob globstar; unset GLOBIGNORE; PATH=/usr/bin:/bin',
  // Tools by fixed path (no function or PATH entry stands in); a missing one refuses.
  `tool() { local t; for t in "/usr/bin/$1" "/bin/$1"; do [ -x "$t" ] && { printf '%s' "$t"; return 0; }; done; printf '%s\\n' "project command not run: no $1 to resolve its sandbox's paths; ${SANDBOX_FIX}" >&2; return 1; }`,
  `rl=$(tool readlink) || exit ${SANDBOX_UNAVAILABLE}; stt=$(tool stat) || exit ${SANDBOX_UNAVAILABLE}; fnd=$(tool find) || exit ${SANDBOX_UNAVAILABLE}`,
  'b=$1 h=$2 u=$3; shift 3; hide=(); dirs=(); declare -A seen=() said=(); maxd=0; bad=()',
  'above() { local d=$1 n; while d=${d%/*}; [ -n "$d" ]; do [ -n "${seen[$d]}" ] && continue; seen[$d]=1; dirs+=("$d"); n=${d//[!\\/]/}; [ "${#n}" -gt "$maxd" ] && maxd=${#n}; done; }',
  // Refusals collected, each once, so one message names every path. Quoted: the agent names them (no forged lines).
  'note() { [ -n "${said[$1]}" ] && return; said[$1]=1; bad+=("$1"); }',
  `refuse() { local t; t=$("$rl" -- "$1" 2>/dev/null); note "project command not run: \${1@Q} is a symlink (to \${t@Q}) the agent user could change (it owns or can write its directory), on the way to a credential its sandbox hides, so one project command could swap it for the next. If you didn't create it, remove it as the agent user: sudo -u $u rm -- \${1@Q}. If you did, replace it with a real directory the agent may read, or name the credential's real path in credentials.yaml"; }`,
  `unres() { note "project command not run: \${1@Q} $2; name the credential's real path in credentials.yaml"; }`,
  // INVARIANT (#787 rounds 7, 8): each decision about a component rests on ONE lstat (its type and owner, or its
  // errno), never two tests the agent could change in between. Stable because the agent can't change who owns a
  // directory, or whether one it doesn't own is writable to it. Resolved one component and symlink at a time:
  // - a symlink is followed only from a directory the agent neither owns nor can write, and the directories above it
  //   are bound onto themselves; any other symlink, or over 40, is refused;
  // - ENOENT, ENOTDIR: nothing to hide;
  // - EACCES: nothing to hide only if no directory walked so far is the agent's (owned or writable): then it is the
  //   coordinator's, unopenable by that name. Under the agent's own, it could make it searchable again: refused;
  // - any other error, or a name too long to check: refused.
  `st() { local o; o=$("$stt" -c '%F/%u' -- "$1" 2>&1); S=$?; if [ "$S" -eq 0 ]; then T=\${o%/*} U=\${o##*/}; else E=\${o##*: }; fi; }`,
  'walk() { local todo=${1#/} cur= c t n=0 own=0 cw=0',
  '  if [ -w / ]; then cw=1 own=1; fi',
  '  while [ -n "$todo" ]; do',
  '    c=${todo%%/*}; if [ "$c" = "$todo" ]; then todo=; else todo=${todo#*/}; fi',
  // A `..` (only in a root link's target; hide paths with one are refused) binds the directory it leaves first: no
  // command can remove or rename it.
  '    case $c in ""|.) continue ;; ..) [ -n "$cur" ] && above "$cur/."; cur=${cur%/*}; st "${cur:-/}"',
  '      if [ "$S" -ne 0 ]; then unres "$1" "cannot be checked ($E)"; return 2; fi',
  '      cw=0; if [ "$U" = "$UID" ] || [ -w "$cur/" ]; then cw=1 own=1; fi; continue ;; esac',
  `    if [ "\${#c}" -gt 255 ] || [ $((\${#cur} + \${#c} + 1)) -ge 4096 ]; then unres "$1" "resolves to a name too long to check"; return 2; fi`,
  '    st "$cur/$c"',
  '    if [ "$S" -ne 0 ]; then',
  '      case $E in "No such file or directory"|"Not a directory") return 1 ;; "Permission denied") if [ "$own" = 0 ]; then return 1; fi',
  '        unres "$1" "goes through a directory the agent user owns or can write but cannot search now (it could make it searchable again)"; return 2 ;; esac',
  '      unres "$1" "cannot be checked ($E)"; return 2',
  '    fi',
  '    case $T in',
  '      "symbolic link") n=$((n + 1)); if [ "$n" -gt 40 ] || [ "$cw" = 1 ]; then refuse "$cur/$c"; return 2; fi',
  '        above "$cur/$c"; t=$("$rl" -- "$cur/$c") || { refuse "$cur/$c"; return 2; }',
  '        case $t in /*) cur= cw=0; if [ -w / ]; then cw=1 own=1; fi ;; esac; todo=${t#/}${todo:+/$todo} ;;',
  '      directory) cur=$cur/$c; cw=0; if [ "$U" = "$UID" ] || [ -w "$cur/" ]; then cw=1 own=1; fi ;;',
  '      *) cur=$cur/$c cw=0 ;;',
  '    esac',
  '  done; R=${cur:-/} RT=$T; }',
  'add() { local r; case $1 in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*) unres "$1" "is under /proc, /sys or /dev"; return ;; esac',
  '  walk "$1"; case $? in 1|2) return ;; esac; r=$R',
  '  case $r in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*) unres "$1" "resolves under /proc, /sys or /dev"; return ;; esac',
  '  if [ "$RT" = directory ]; then hide+=(--tmpfs "$r"); else hide+=(--ro-bind /dev/null "$r"); fi; above "$r"; }',
  // Default masks listed by find, whose failure refuses (a glob in an unreadable directory hid nothing, #787 r7).
  'list() { local o; o=$("$fnd" "$1" -mindepth 1 -maxdepth 1 -name "$2" -printf "%f/" 2>/dev/null) || { unres "$1" "cannot be listed for its credential files"; return; }; while [ -n "$o" ]; do add "$1/${o%%/*}"; o=${o#*/}; done; }',
  // (A home or ~/.config that isn't a directory holds nothing to hide.)
  'walk "$h"; if [ $? -eq 0 ] && [ "$RT" = directory ]; then hr=$R; list "$hr" ".claude*"; walk "$hr/.config"; if [ $? -eq 0 ] && [ "$RT" = directory ]; then list "$R" "*-claude-key"; fi; fi',
  'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do add "$1"; shift; done; shift',
  `if [ "\${#bad[@]}" -gt 0 ]; then printf '%s\\n' "\${bad[@]}" >&2; exit ${SANDBOX_UNAVAILABLE}; fi`,
  'binds=(); for ((i = 1; i <= maxd; i++)); do for d in "${dirs[@]}"; do n=${d//[!\\/]/}; [ "${#n}" -eq "$i" ] && binds+=(--bind "$d" "$d"); done; done',
  `box=(${PROJECT_SANDBOX_ARGS.join(' ')})`,
  `if ! err=$("$b" "\${box[@]}" -- /bin/sh -c : 2>&1); then printf '%s\\n' "project command not run: its sandbox didn't start ($err); ${SANDBOX_FIX}" >&2; exit ${SANDBOX_UNAVAILABLE}; fi`,
  'exec "$b" "${box[@]}" "${binds[@]}" "${hide[@]}" -- "$@"',
].join('\n');

/**
 * What a sandbox may hide and a configured path must be: absolute, normal form (no `..`, `//`, `/./`, trailing `/`),
 * not `/`, no NUL or newline, under PATH_MAX and NAME_MAX (else "name too long" reads as absent). Refused, never
 * rewritten.
 */
export const normalAbsolute = (p: string): boolean =>
  p.startsWith('/') && p !== '/' && posixPath.normalize(p) === p && !p.endsWith('/') && !/[\0\n]/.test(p) && Buffer.byteLength(p) < 4096 && p.split('/').every((c) => Buffer.byteLength(c) <= 255);
/** A user's home: the same rule, but `/` is a home some users have (it is never a path to hide). */
export const normalHome = (p: string): boolean => p === '/' || normalAbsolute(p);
export const NOT_NORMAL_ABSOLUTE ='must be an absolute path in normal form (no .., //, /./, trailing /, NUL or newline; under 4096 bytes, no name over 255)';

/** macOS's sandbox profile for a project command: everything allowed but reading or writing the hidden paths. */
export function seatbeltProfile(home: string, hide: readonly string[]): string {
  const bad = [home, ...hide].find((p) => !/^\/[^"\\\n]*$/.test(p));
  if (bad !== undefined) throw new Error(`can't sandbox a project command around ${JSON.stringify(bad)}: not a plain absolute path`);
  const re = (s: string) => s.replace(/[.*+?^$()[\]{}|]/g, '\\$&');
  const h = re(home.replace(/\/$/, ''));
  const rules = [`(regex #"^${h}/\\.claude")`, `(regex #"^${h}/\\.config/[^/]*-claude-key(/|$)")`, ...hide.map((p) => `(subpath "${p}")`)];
  return `(version 1)\n(allow default)\n(deny file-read* file-write* ${rules.join(' ')})\n`;
}

/**
 * How to spawn a project command: bash with pipefail and a clean environment. With `runAs`, as the agent user and
 * always in a sandbox hiding its Claude logins, its API key and `runAs.hide` (#713): bubblewrap, or macOS's
 * sandbox-exec. No way to run one as the agent user without it; `sandboxTool` is for tests.
 */
export function projectCommand(command: string, runAs?: ProjectRunAs, projectEnv: Record<string, string> = {}, o: { sandboxTool?: string } = {}): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const [file, args] = shellCommand(command);
  const own = safeProjectEnv(projectEnv);
  if (!runAs) return { file, args, env: childEnv(own) };
  // Fail closed: a runAs without its hide list (a job file an older engine wrote, a caller outside the type) is refused,
  // never run with the default masks only.
  if (!Array.isArray(runAs.hide)) throw new Error(`a project command as ${runAs.user} needs its sandbox's hide list (runAs.hide); refusing to run it without`);
  // Normal form only (absolute, no //, /./, .. or trailing /), so the wrapper's checks on a path's text (/proc, /sys,
  // /dev) and its walk see the path the kernel would; anything else is refused, never dropped or rewritten.
  const bad = runAs.hide.find((p) => !normalAbsolute(p));
  if (bad !== undefined) throw new Error(`a project command's hidden path ${NOT_NORMAL_ABSOLUTE}: ${JSON.stringify(bad)}; refusing to run it`);
  const hide = [...runAs.hide];
  // The home too: refused, never rewritten. A lexical rewrite of `..` after a symlink names a directory the kernel
  // never reaches, and the masks would miss the real one (#787 round 6).
  if (!normalHome(runAs.home)) throw new Error(`the agent user's home ${NOT_NORMAL_ABSOLUTE}: ${JSON.stringify(runAs.home)}; refusing to run it`);
  const home = runAs.home;
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('running a project command as the agent user needs macOS or Linux, for its sandbox');
  const env = {
    ...own,
    HOME: home,
    USER: runAs.user,
    LOGNAME: runAs.user,
    // Set by the instance's owner (instance.yaml run_as.path), never by the repo: tests.yaml can't set PATH.
    PATH: runAs.path ?? defaultAgentPath(),
    LANG: ownEnv().get('LANG') ?? 'C.UTF-8',
    CI: '1',
    // The checkout belongs to the coordinator user: without trusting it, git refuses it as "dubious ownership" and
    // any check that runs git fails. No credential helper: project code never authenticates as the instance.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'safe.directory',
    GIT_CONFIG_VALUE_1: '*',
  };
  // INVARIANT: a proxy only from root's network.json, as for every child (src/network.ts).
  const full = outboundEnv(env);
  if (process.platform === 'darwin') {
    const [f, a] = asUser(runAs.user, '/usr/bin/sandbox-exec', ['-p', seatbeltProfile(home, hide), file, ...args], full);
    return { file: f, args: a, env: { PATH: ownEnv().get('PATH') ?? '/usr/bin:/bin' } };
  }
  // The wrapper's bash gets no environment at all; the command gets exactly `full`, from the env -i inside bwrap.
  const vars = Object.entries(full)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => `${k}=${v}`);
  const inner = ['/usr/bin/env', '-i', ...vars, file, ...args];
  const [f, a] = asUser(runAs.user, file, ['--norc', '--noprofile', '-c', LINUX_SANDBOX, 'sandbox', o.sandboxTool ?? PROJECT_SANDBOX_TOOL, home, runAs.user, ...hide, '--', ...inner], {});
  return { file: f, args: a, env: { PATH: ownEnv().get('PATH') ?? '/usr/bin:/bin' } };
}

/**
 * Whether a pid can be a child's (and its process group's): a whole number above 1. INVARIANT: never 0 or below, nor 1:
 * kill(0) signals the caller's own process group, kill(-n) the group n, and kill(-1) every process the user may signal.
 * A child that didn't start has no pid at all.
 */
export const isChildPid = (pid: number | undefined): pid is number => pid !== undefined && Number.isInteger(pid) && pid > 1;

/** Kill a process group that runs as another user: only that user (or root) may signal it. */
export function killTreeAs(user: string, pgid: number | undefined): void {
  if (!isChildPid(pgid) || process.platform === 'win32') return;
  try {
    execFileSync('sudo', ['-n', '-u', user, '--', '/bin/kill', '-KILL', '--', `-${pgid}`], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // already gone
  }
}

export function killTree(pid: number | undefined, fallback: () => void): void {
  try {
    if (isChildPid(pid) && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else if (isChildPid(pid) && process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
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
    const env = ownEnv();
    const candidates = [
      env.get('CLAUDE_CODE_GIT_BASH_PATH'),
      join(env.get('ProgramFiles') ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
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

/** Environment for project commands, without NODE_TEST_CONTEXT (a nested `node --test` would report to the parent). */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  // INVARIANT: no redirecting variable from the engine's environment or `extra`; a proxy only from root's network.json.
  outboundEnv(env);
  // WHY: in a test run, what it starts is one too (#669): dropping NODE_TEST_CONTEXT must not make a test's child the
  // engine's own. Outside a test run nothing is added.
  markTestRun(env);
  // WHY: project commands run code an agent wrote; the push gate's hatch in the engine's own environment stops here.
  return withoutPushGateHatch(env);
}

/**
 * The machine-wide slot directory every agent harness shares (so unbranded; AGENT_SLOTS_DIR overrides; docs/slots.md),
 * in durable locations: /var/tmp's cleaners would drop a long-running machine's cap and lock files.
 */
// Frozen: a module that set SYSTEM_SLOTS.dir to a guess would have slotsDir mark the slot dir by it (#806 round 4).
export const SYSTEM_SLOTS = Object.freeze({ dir: varLibPath('agent-slots'), config: etcPath('slots.json') });

/**
 * The engine updater's drain flag (scripts/machine/<cli>-update.cjs, src/update-drain.ts): with the system slot
 * directory it is in root's /var/lib/<cli>, beside the updater's other files, so no coordinator can write or remove
 * it (the slot directory itself is group-writable); with any other slot directory (development, tests), inside it.
 */
export const UPDATE_DRAIN_FILE = varLibPath('update-drain.json');
export function updateDrainPath(dir?: SlotPath, system?: typeof SYSTEM_SLOTS): SlotPathLike;
export function updateDrainPath(dir: string, system?: typeof SYSTEM_SLOTS): string;
export function updateDrainPath(dir: SlotPathLike, system?: typeof SYSTEM_SLOTS): SlotPathLike;
export function updateDrainPath(dir: SlotPathLike = slotsDir(), system = SYSTEM_SLOTS): SlotPathLike {
  return isSystemSlots(dir, system) ? UPDATE_DRAIN_FILE : slotFile(dir, 'update-drain.json');
}

/**
 * The slot paths slotsDir made for the machine's system directory (SYSTEM_SLOTS, this module's own): set when made,
 * never by comparing with a path or a `system` a caller passed (#806 review, A3 and the round-3 mark oracle).
 */
const systemSlotDirs = new WeakSet<SlotPath>();

/**
 * Whether `dir` is the system slot directory. A slot path is, when slotsDir made it as one. It is never compared with
 * a caller's `system`: that would let any module test a guessed path against the slot dir (#806 review, A3). A plain
 * string is compared as written: it is the caller's own path, and says nothing about the slot dir.
 */
const isSystemSlots = (dir: SlotPathLike, system: typeof SYSTEM_SLOTS) => (typeof dir === 'string' ? dir === system.dir : systemSlotDirs.has(dir));

/**
 * The machine's slot directory, as a slot path (#772): only src/slot-file.ts reads, writes or removes what it names,
 * so it can't reach any other writer. This module is the only one that makes one (test/slot-path.test.ts), and the
 * only one that reads where it is (AGENT_SLOTS_DIR, SYSTEM_SLOTS).
 *
 * INVARIANT (#669): in a test run, only a directory inside the test machine (test/isolate.ts); anything else throws
 * TestSlotsRefused before a file is opened (src/os/system-paths.ts testSlotsRefusal), so no test reaches the machine's
 * own slots, STOP, budgets or incidents through a default. Outside a test run, as always.
 */
export function slotsDir(): SlotPath {
  const dir = resolvedSlotsDir(SYSTEM_SLOTS);
  // One value while the slot dir stays where it is, so slotsDir() === slotsDir() (the budget's prune throttle keys
  // on it). It is this function's own: every other slot path, whatever path it names, is a fresh value equal to none
  // (src/slot-file.ts), so no caller can test a guess against this one (#806 round 6).
  if (current?.dir !== dir) {
    const p = slotPathOf(dir);
    if (dir === SYSTEM_SLOTS.dir) systemSlotDirs.add(p);
    current = { dir, p };
  }
  return current.p;
}

/** The slot dir slotsDir resolved last, and its value. */
let current: { dir: string; p: SlotPath } | undefined;

/** The slot dir for `system`, refused in a test run unless it is inside the test machine (#669). */
function resolvedSlotsDir(system: typeof SYSTEM_SLOTS): string {
  const dir = unguardedSlotsDir(system);
  const refusal = testSlotsRefusal(dir, ownEnv().asProcessEnv());
  if (refusal) throw new TestSlotsRefused(refusal);
  return dir;
}

/**
 * slotsDir with the system locations a test gives (test/slots.test.ts): the seam has its own name, which no src/
 * module but this one may name (test/slot-path.test.ts), so slotsDir itself takes nothing a caller could choose.
 * It gives a fresh value every call, equal to no other slot path, and never marks one as the system dir: only
 * slotsDir does, for the machine's own SYSTEM_SLOTS (#806 rounds 3 and 6).
 */
export function slotsDirFor(system: typeof SYSTEM_SLOTS): SlotPath {
  return slotPathOf(resolvedSlotsDir(system));
}

function unguardedSlotsDir(system: typeof SYSTEM_SLOTS): string {
  const env = ownEnv();
  const given = env.get('AGENT_SLOTS_DIR');
  if (given) return given;
  if (process.platform === 'win32') return join(env.get('ProgramData') ?? 'C:\\ProgramData', 'agent-slots');
  if (existsSync(system.dir)) return system.dir;
  return devSlotsPath(); // single-user and development machines
}

/**
 * The machine's slot config (max_agents): AGENT_SLOTS_CONFIG if
 * set; else the system config file when the system slot directory is in
 * use and the file exists; else config.json in the slot directory.
 */
export function slotsConfigPath(dir?: SlotPath, system?: typeof SYSTEM_SLOTS): SlotPathLike;
export function slotsConfigPath(dir: string, system?: typeof SYSTEM_SLOTS): string;
export function slotsConfigPath(dir: SlotPathLike, system?: typeof SYSTEM_SLOTS): SlotPathLike;
export function slotsConfigPath(dir: SlotPathLike = slotsDir(), system = SYSTEM_SLOTS): SlotPathLike {
  const given = ownEnv().get('AGENT_SLOTS_CONFIG');
  if (given) return given;
  if (isSystemSlots(dir, system) && existsSync(system.config)) return system.config;
  return slotFile(dir, 'config.json');
}

export interface ServiceSpec {
  label: string; // reverse-DNS style id, unique per project
  program: string[]; // argv
  workingDir: string;
  logFile: string;
  env?: Record<string, string>;
}

/**
 * What installService would write and how it starts it, without doing either: the file, the service manager and the
 * commands it runs. The first-run page shows this before its Start button does anything.
 */
export function serviceChange(label: string): { path: string; manager: string; commands: string[] } | null {
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 0;
    const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    return { path, manager: 'launchd (a per-user agent: KeepAlive, starts at login)', commands: [`launchctl bootout gui/${uid}/${label}`, `launchctl bootstrap gui/${uid} ${path}`] };
  }
  if (process.platform === 'linux') {
    const path = join(ownEnv().get('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'systemd', 'user', `${label}.service`);
    return { path, manager: 'systemd --user (Restart=always)', commands: ['systemctl --user daemon-reload', `systemctl --user enable --now ${label}.service`] };
  }
  return null;
}

/** Whether this user's service (installService's label) is loaded and running now; null where there is no service manager to ask. */
export function serviceRunning(label: string): boolean | null {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
      return /\bstate = running\b/.test(out);
    } catch {
      return false;
    }
  }
  if (process.platform === 'linux') return unitActive(['--user', 'is-active', `${label}.service`]);
  return null;
}

/** The command that shows why this user's service manager can't be read (the Claude step's fix, #738). */
export const serviceManagerCheck = (platform: NodeJS.Platform = process.platform): string => (platform === 'darwin' ? 'launchctl getenv CLAUDE_CONFIG_DIR' : 'systemctl --user show-environment');

/**
 * Which of `names` this user's service manager gives every service it starts (#738): systemd's user manager on Linux,
 * launchd on macOS. An error when it can't be read; an error never carries a value (these can be credentials).
 */
export function serviceManagerEnv(names: readonly string[], o: { platform?: NodeJS.Platform; run?: (cmd: string, args: string[]) => string } = {}): { env: Record<string, string> } | { error: string } {
  const platform = o.platform ?? process.platform;
  // INVARIANT (#738): a test run never reads this machine's manager; a test gives its own `run`, or gets unknown.
  const sign = o.run ? null : testRunSign();
  if (sign) return { error: `a test run never reads this machine's user service manager (${sign})` };
  const run = o.run ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }));
  const env: Record<string, string> = {};
  const failed = (what: string, e: unknown) => ({ error: `${what} failed: ${((e as { stderr?: unknown }).stderr ? String((e as { stderr: unknown }).stderr) : (e as Error).message).trim().split('\n')[0]?.slice(0, 200) ?? ''}` });
  if (platform === 'darwin') {
    for (const n of names) {
      try {
        const v = run('launchctl', ['getenv', n]).replace(/\r?\n$/, '');
        if (v) env[n] = v;
      } catch (e) {
        return failed(`launchctl getenv ${n}`, e);
      }
    }
    return { env };
  }
  if (platform === 'linux') {
    let out: string;
    try {
      out = run('systemctl', ['--user', 'show-environment']);
    } catch (e) {
      return failed('systemctl --user show-environment', e);
    }
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      const k = eq > 0 ? line.slice(0, eq) : '';
      if (!names.includes(k)) continue;
      const v = line.slice(eq + 1);
      // A value systemd quoted ($'...') is not guessed.
      if (v.startsWith("$'") || v.startsWith('"') || v.startsWith("'")) return { error: `the user service manager sets ${k} in a quoted form this check doesn't read` };
      if (v) env[k] = v;
    }
    return { env };
  }
  return { error: `no user service manager this check knows on ${platform}` };
}

/** Whether a system unit (an instance's `<cli>-<name>.service`) is active; null off Linux. Any user may ask systemd this. */
export function systemUnitActive(unit: string): boolean | null {
  if (process.platform !== 'linux') return null;
  return unitActive(['is-active', unit]);
}

function unitActive(args: string[]): boolean {
  // INVARIANT (#738): a test run never asks this machine's service manager; as when it doesn't answer: not active.
  if (testRunSign()) return false;
  try {
    return execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() === 'active';
  } catch {
    return false;
  }
}

/**
 * Linux only: whether this user's services run without a login session (loginctl's Linger). null elsewhere (launchd
 * agents need no such thing) or when loginctl can't tell.
 */
export function lingerEnabled(user = userInfo().username): boolean | null {
  if (process.platform !== 'linux') return null;
  try {
    return execFileSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() === 'yes';
  } catch {
    return null;
  }
}

/** The launchd agent's plist for a service spec (what installService writes on macOS). */
export function launchdPlist(spec: ServiceSpec): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const envXml = Object.entries(spec.env ?? {}).map(([k, v]) => `<key>${esc(k)}</key><string>${esc(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

/** The systemd user unit for a service spec (what installService writes on Linux). */
export function systemdUserUnit(spec: ServiceSpec): string {
  const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  return `[Unit]
Description=${spec.label}

[Service]
ExecStart=${spec.program.map(q).join(' ')}
WorkingDirectory=${spec.workingDir}
Restart=always
RestartSec=30
# The coordinator exits within SHUTDOWN_MS (20 s) of SIGTERM (src/service.ts); this leaves it room before a SIGKILL.
TimeoutStopSec=30
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}
${Object.entries(spec.env ?? {}).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}

[Install]
WantedBy=default.target
`;
}

/** Install and start a per-user service that restarts on failure and survives logout of any session. */
export function installService(spec: ServiceSpec): { path: string; started: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${spec.label}.plist`);
    const plist = launchdPlist(spec);
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
    const path = join(ownEnv().get('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'systemd', 'user', `${spec.label}.service`);
    const unit = systemdUserUnit(spec);
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

const launchctlOk = (args: string[]) => {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Unload a per-user launchd agent and wait until launchd no longer lists it. `bootout` can return while the job is
 * still listed (one waiting out its KeepAlive throttle, say); then it is booted out again by its plist. True once it
 * is gone; false if it is still listed after `waitMs`.
 */
export function launchdUnload(label: string, plist: string, o: { uid?: number; run?: (args: string[]) => boolean; sleep?: (ms: number) => void; waitMs?: number } = {}): boolean {
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const run = o.run ?? launchctlOk;
  const sleep = o.sleep ?? sleepSync;
  const waitMs = o.waitMs ?? 10_000;
  const target = `gui/${uid}/${label}`;
  const loaded = () => run(['print', target]);
  if (!loaded()) return true;
  run(['bootout', target]);
  for (let waited = 0; ; waited += 250) {
    if (!loaded()) return true;
    if (waited >= waitMs) return false;
    if (waited === 1000) run(['bootout', `gui/${uid}`, plist]);
    sleep(250);
  }
}

export function uninstallService(label: string): string {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const gone = launchdUnload(label, path);
    rmSync(path, { force: true });
    if (!gone) throw new Error(`removed ${path}, but launchd still lists ${label}: run \`launchctl bootout gui/${process.getuid?.() ?? 0}/${label}\``);
    return path;
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${label}.service`], { stdio: 'ignore' });
    } catch {
      // not enabled
    }
    const path = join(ownEnv().get('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'systemd', 'user', `${label}.service`);
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

/** A path as one POSIX shell word: single-quoted, each ' as '\'' (nothing inside is expanded). */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A command that copies `file`'s contents to this machine's clipboard, ready to paste into its shell, or null when
 * there's no clipboard tool (then the path alone is shown). macOS: pbcopy. Linux: wl-copy, else xclip, else WSL's
 * clip.exe. Windows (cmd): clip. WHY: a key file's path can have a space (~/Library/Application Support) (#467).
 */
export function copyFileCommand(file: string, platform: NodeJS.Platform = process.platform, path: string = ownEnv().get('PATH') ?? ''): string | null {
  if (platform === 'win32') return /["%^&|<>]/.test(file) ? null : `clip < "${file}"`;
  const q = shellQuote(file);
  if (platform === 'darwin') return `pbcopy < ${q}`;
  if (which('wl-copy', path)) return `wl-copy < ${q}`;
  if (which('xclip', path)) return `xclip -selection clipboard < ${q}`;
  if (which('clip.exe', path)) return `clip.exe < ${q}`;
  return null;
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

/**
 * A browser opener that opens nothing: it writes the URL it is given to `urlFile` (this user's only), so a program
 * that opens a browser through $BROWSER (claude auth login) hands its URL to the dashboard instead. Written into
 * `dir` (a 0700 directory of this user's), 0700. Null where $BROWSER can't name such a script (Windows): there the
 * program opens the browser itself.
 */
export function browserRelay(dir: string, urlFile: string): string | null {
  if (process.platform === 'win32') return null;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const file = join(dir, 'browser-relay');
  writeExecutable(file, `#!/bin/sh\numask 077\nprintf '%s\\n' "$1" > ${q(urlFile)}\n`, 0o700);
  return file;
}

/** A native executable's file name on this OS. */
export function executableName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/** Free disk on the volume holding `path`: percent and GB. */
export function diskFree(path: SlotPathLike): { freePct: number; freeGb: number; totalGb: number } {
  const st = statfsSlotDir(path); // statfsSync, through src/slot-file.ts so the slot dir (#772) can be measured too
  const total = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  return { freePct: total ? (free / total) * 100 : 0, freeGb: free / 1e9, totalGb: total / 1e9 };
}

/**
 * Replace a file's content atomically: a temp file beside it (so the rename stays on one filesystem), with
 * `mode` and, on POSIX, the original's owner and group; then rename over it. On failure the temp file is
 * removed and the original is untouched. `ownerOf`: the file (or directory) whose owner and group it gets, for a
 * file that doesn't exist yet (root writing into a user's home keeps it that user's).
 */
export function replaceFileAtomically(path: string, data: string, mode: number, ownerOf = path): void {
  const st = statSync(existsSync(path) ? path : ownerOf);
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && (st.uid !== process.getuid() || st.gid !== process.getgid!())) chownSync(tmp, st.uid, st.gid);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function cpuCount(): number {
  return availableParallelism();
}

/**
 * Whether another process holds a flock(2) lock on `path`, without taking it (a lock file another workload, such as
 * a simulator, holds while it runs; such files usually always exist, so existence says nothing). Linux: the file's
 * device and inode against the FLOCK entries of /proc/locks (waiters, "->", don't hold). macOS: a non-blocking
 * shared try-lock on the file opened read-only, released at once (a holder of an exclusive lock refuses it; a
 * simulator's `flock -w` at worst waits microseconds). Windows: never held. Null when it can't tell: the caller
 * treats that as held, so it never contends.
 */
export function flockHeld(path: string): boolean | null {
  if (!existsSync(path)) return false;
  if (process.platform === 'win32') return false;
  if (process.platform === 'linux') {
    let locks: string;
    let dev: bigint;
    let ino: bigint;
    try {
      locks = readFileSync('/proc/locks', 'utf8');
      const st = statSync(path, { bigint: true });
      dev = st.dev;
      ino = st.ino;
    } catch {
      return null;
    }
    // glibc's major/minor of a dev_t.
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
    const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
    for (const line of locks.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[1] !== 'FLOCK') continue;
      const id = /^([0-9a-f]+):([0-9a-f]+):(\d+)$/i.exec(f[5] ?? '');
      if (id && BigInt(`0x${id[1]}`) === major && BigInt(`0x${id[2]}`) === minor && BigInt(id[3]!) === ino) return true;
    }
    return false;
  }
  try {
    execFileSync('perl', ['-e', 'use Fcntl qw(:flock); open(my $f, "<", $ARGV[0]) or exit 2; exit(flock($f, LOCK_SH | LOCK_NB) ? 0 : 1)', path], { stdio: 'ignore', timeout: 5000 });
    return false;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? true : null;
  }
}

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
export function holdFlock(path: string, mode: 'shared' | 'exclusive', signal?: AbortSignal): Promise<HeldFlock> {
  if (process.platform === 'win32') return Promise.reject(new Error('flock locks need macOS or Linux'));
  if (!existsSync(path)) return Promise.reject(new Error(`the lock file ${path} is missing`));
  const script = 'use Fcntl qw(:flock); $| = 1; open(my $f, "<", $ARGV[0]) or exit 2; flock($f, $ARGV[1] eq "x" ? LOCK_EX : LOCK_SH) or exit 3; print "held\\n"; 1 while <STDIN>; exit 0';
  return new Promise((resolve, reject) => {
    const child = spawn('perl', ['-e', script, path, mode === 'exclusive' ? 'x' : 's'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let held = false;
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d: Buffer) => {
      if (held || !d.toString().includes('held')) return;
      held = true;
      signal?.removeEventListener('abort', onAbort);
      resolve({
        release: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once('exit', () => done());
            child.stdin.end();
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
          }),
      });
    });
    child.on('error', (e) => reject(new Error(`can't take ${path}: ${e.message}`)));
    child.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (!held) reject(signal?.aborted ? new Error('cancelled while waiting for the lock') : new Error(`can't take ${path} (holder exit ${code ?? 'killed'})`));
    });
    if (signal?.aborted) onAbort();
  });
}

/** Who holds flock(2) locks on `path` now, each holder's pid and mode, from /proc/locks (Linux); null where it can't tell. */
export function flockHolders(path: string): { pid: number; mode: 'shared' | 'exclusive' }[] | null {
  if (process.platform !== 'linux') return null;
  try {
    const st = statSync(path, { bigint: true });
    const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & ~0xfffn);
    const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & ~0xffn);
    const out: { pid: number; mode: 'shared' | 'exclusive' }[] = [];
    for (const line of readFileSync('/proc/locks', 'utf8').split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[1] !== 'FLOCK') continue;
      const id = /^([0-9a-f]+):([0-9a-f]+):(\d+)$/i.exec(f[5] ?? '');
      if (id && BigInt(`0x${id[1]}`) === major && BigInt(`0x${id[2]}`) === minor && BigInt(id[3]!) === st.ino) out.push({ pid: Number(f[4]), mode: f[3] === 'WRITE' ? 'exclusive' : 'shared' });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Exclusive flock(2) locks on each of `paths`, taken one after another in the order given and held together until
 * released (or this process exits). The GPU test runs' locks (src/testrun/gpu.ts): `<cli> gpu hold` and the sandbox
 * helper both take them in ascending GPU order, so neither ever holds one the other waits on while waiting itself.
 * `waiting` is told each lock another process holds before this one waits for it.
 */
export async function holdFlocksInOrder(paths: readonly string[], o: { signal?: AbortSignal; waiting?: (path: string) => void } = {}): Promise<HeldFlock> {
  const held: HeldFlock[] = [];
  const release = async () => {
    for (const h of held.reverse()) await h.release();
  };
  try {
    for (const p of paths) {
      if (flockHeld(p) !== false) o.waiting?.(p);
      held.push(await holdFlock(p, 'exclusive', o.signal));
    }
  } catch (e) {
    await release();
    throw e;
  }
  return { release };
}

/**
 * The device nodes a GPU test run with these NVIDIA GPUs needs (Linux; the sandbox helper binds exactly these): the
 * control node, the unified-memory node, and one per GPU. Never nvidia-uvm-tools, nvidia-modeset, nvidia-caps or dri.
 */
export function nvidiaNodes(indices: readonly number[], dev = '/dev'): string[] {
  return ['nvidiactl', 'nvidia-uvm', ...indices.map((i) => `nvidia${i}`)].map((n) => `${dev}/${n}`);
}

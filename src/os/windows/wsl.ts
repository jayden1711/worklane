// Windows hosts. Agents run only in WSL2's hardened mode: a dedicated distro
// (scripts/setup/windows/install.ps1) where the Linux setup runs unchanged, so
// the isolation is Linux's (separate users, the sandbox) inside the WSL VM.
// What WSL adds on top must be closed for that to hold: Windows drives mounted
// into the distro (an agent could read and write the owner's files) and
// interop (a Linux process could start Windows programs as the owner). This
// module reads what's in force and says so; it changes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

/** The /etc/wsl.conf the installer writes into the dedicated distro. The doctor checks the same keys. */
export const HARDENED_WSL_CONF: Record<string, Record<string, string>> = {
  boot: { systemd: 'true' },
  automount: { enabled: 'false', mountFsTab: 'false' },
  interop: { enabled: 'false', appendWindowsPath: 'false' },
  user: { default: 'root' },
};

/** Where WSL puts the Windows GPU driver's Linux libraries and tools (nvidia-smi among them). Not on a service's PATH. */
export const WSL_GPU_DIR = '/usr/lib/wsl/lib';

/** An INI file (wsl.conf, .wslconfig) as sections of keys; section and key names lowercased, comments dropped. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = line.match(/^\[([^\]]+)\]$/);
    if (s) {
      section = s[1]!.trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (!kv || !section) continue;
    out[section]![kv[1]!.trim().toLowerCase()] = kv[2]!.replace(/\s+[#;].*$/, '').trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export interface Mount {
  device: string;
  point: string;
  type: string;
  options: string;
}

/** /proc/mounts, with its octal escapes (\040 for a space) decoded. */
export function parseMounts(text: string): Mount[] {
  const un = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 4)
    .map(([device, point, type, options]) => ({ device: un(device!), point: un(point!), type: type!, options: options! }));
}

/** A Windows drive mounted into the distro (drvfs, over 9p or virtiofs): "C:\ on /mnt/c type 9p (…aname=drvfs…)". */
export const isWindowsDrive = (m: Mount) => m.type === 'drvfs' || (/^(9p|virtiofs)$/.test(m.type) && (/aname=drvfs/.test(m.options) || /^[A-Za-z]:\\/.test(m.device)));

export interface WslFacts {
  /** /etc/wsl.conf, or null if missing. */
  wslConf: string | null;
  /** /proc/mounts. */
  mounts: string;
  /** Interop registered (/proc/sys/fs/binfmt_misc/WSLInterop*): Linux processes can start Windows programs. */
  interop: boolean;
  /** PID 1 is systemd. */
  systemd: boolean;
}

export interface WslIsolation {
  hardened: boolean;
  /** What holds, in words, for the doctor. */
  has: string[];
  /** What's open, with how to close it. */
  gaps: string[];
}

/** What isolation this WSL distro has: Linux's own inside the VM, if Windows drives and interop are closed. */
export function wslIsolation(f: WslFacts): WslIsolation {
  const conf = parseIni(f.wslConf ?? '');
  const drives = parseMounts(f.mounts).filter(isWindowsDrive);
  const has: string[] = ['a separate VM from Windows (WSL2)', "Linux's users and sandbox inside it"];
  const gaps: string[] = [];
  if (drives.length) gaps.push(`Windows drives are mounted (${drives.map((d) => d.point).join(', ')}): set [automount] enabled=false in /etc/wsl.conf`);
  else has.push('no Windows drives mounted');
  if (f.interop) gaps.push('interop is on, so Linux processes can start Windows programs as the Windows user: set [interop] enabled=false in /etc/wsl.conf');
  else has.push('no interop (Linux processes cannot start Windows programs)');
  if (conf.interop?.appendwindowspath !== 'false') gaps.push("Windows' PATH may be added to Linux's: set [interop] appendWindowsPath=false in /etc/wsl.conf");
  if (!f.systemd) gaps.push('systemd is not running, so the coordinator and dashboard services cannot start: set [boot] systemd=true in /etc/wsl.conf');
  if (gaps.length) gaps.push('then, from Windows: wsl --terminate <distro> (or run scripts/setup/windows/install.ps1 again)');
  return { hardened: gaps.length === 0, has, gaps };
}

/** This distro's facts, read from the running system. */
export function readWslFacts(): WslFacts {
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  let pid1 = '';
  try {
    pid1 = readFileSync('/proc/1/comm', 'utf8').trim();
  } catch {
    // unreadable: not systemd as far as we can tell
  }
  return {
    wslConf: read('/etc/wsl.conf'),
    mounts: read('/proc/mounts') ?? '',
    interop: ['/proc/sys/fs/binfmt_misc/WSLInterop', '/proc/sys/fs/binfmt_misc/WSLInterop-late'].some((p) => existsSync(p)),
    systemd: pid1 === 'systemd',
  };
}

/** Why a checkout can't live at `path` under WSL, or null. Repos belong on WSL's own filesystem, never /mnt. */
export function wslCheckoutRefusal(path: string, mounts: string): string | null {
  const p = posix.normalize(path.replace(/\\/g, '/'));
  const drive = parseMounts(mounts)
    .filter(isWindowsDrive)
    .find((m) => p === m.point || p.startsWith(m.point.replace(/\/$/, '') + '/'));
  if (!drive && !(p === '/mnt' || p.startsWith('/mnt/'))) return null;
  const where = drive ? `the Windows drive mounted at ${drive.point}` : '/mnt, where WSL mounts Windows drives';
  return `${path} is on ${where}. Checkouts must live on WSL's own filesystem (for example under your Linux home or /srv), where Linux permissions and the sandbox apply and git is fast: clone it there instead.`;
}

export interface WslGpu {
  /** /dev/dxg: WSL's GPU paravirtualization is available. */
  dxg: boolean;
  /** NVIDIA's tool, under WSL's driver dir (not on a service's PATH), or null. */
  nvidiaSmi: string | null;
  /** NVIDIA's CUDA driver library for Linux, provided by the Windows driver. */
  cuda: boolean;
}

/** The GPU as WSL2 exposes it: NVIDIA appears through /usr/lib/wsl/lib, not as a PCI device. */
export function wslGpu(exists: (p: string) => boolean = existsSync): WslGpu {
  const smi = posix.join(WSL_GPU_DIR, 'nvidia-smi');
  return { dxg: exists('/dev/dxg'), nvidiaSmi: exists(smi) ? smi : null, cuda: exists(posix.join(WSL_GPU_DIR, 'libcuda.so.1')) };
}

/** The doctor's first line about the host. */
export function hostSummary(os: 'windows' | 'windows-wsl', iso: WslIsolation | null, wslInstalled: boolean): { status: 'ok' | 'warn'; detail: string } {
  if (os === 'windows') {
    return {
      status: 'warn',
      detail: `Windows host, native single-user: the dashboard and Issues work here, agents don't (no sandbox for Bash on Windows). ${wslInstalled ? 'For agents, set up WSL2 hardened mode: scripts/setup/windows/install.ps1, run elevated.' : 'For agents, install WSL2 and set up hardened mode: scripts/setup/windows/install.ps1, run elevated.'}`,
    };
  }
  if (iso?.hardened) return { status: 'ok', detail: `Windows host, WSL2 hardened. Isolation: ${iso.has.join('; ')}.` };
  return { status: 'warn', detail: `Windows host, WSL2, not hardened. Has: ${iso?.has.join('; ') ?? '?'}. Open:\n${(iso?.gaps ?? []).map((g) => `- ${g}`).join('\n')}` };
}

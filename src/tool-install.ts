// The tools a single-user install needs, pinned: each download is checked against a checksum written here before
// anything is unpacked, and refused (and deleted) when it doesn't match. `init` shows the plan (what, from
// where, its checksum, where it goes) and asks before it installs anything.
//
// The pins are scripts/bootstrap.sh's (test/tool-install.test.ts keeps them equal), plus the GitHub CLI, which only
// init installs (local mode signs in to GitHub with it). Claude Code comes as its npm package: the package's own
// tarball is checked against the integrity pinned here; npm checks its platform binary against the registry's.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from './os/child-process.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolPlatform } from './os/index.js';

type Plat = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

export const PINS = {
  gitleaks: {
    version: '8.30.1',
    sha256: {
      'linux-x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
      'linux-arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
      'darwin-x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
      'darwin-arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
    } satisfies Record<Plat, string>,
  },
  gh: {
    version: '2.101.0',
    sha256: {
      'linux-x64': '9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8',
      'linux-arm64': 'b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f',
      'darwin-x64': 'a6fd66c88e2f07d6e4e058173db341d07dd74d58cf8f19ae668293d2bb614ca3',
      'darwin-arm64': 'e4303e39d8f07141c4bad4b99b01079f05029c59b27076e8fbc825c985ecdd8b',
    } satisfies Record<Plat, string>,
  },
  claude: {
    version: '2.1.296',
    integrity: 'sha512-OX/k/rpcthMqnFKOWcpNcbiLsMKtAjLOpQNJHlYiDCFUznWCIwdRTyl/p9SdHVrsrzZuPMCNqZjnpakIni6upw==',
  },
} as const;

export type InstallableTool = keyof typeof PINS;
export const INSTALLABLE = Object.keys(PINS) as InstallableTool[];

/** One install, as shown to the person before it runs. */
export interface ToolInstall {
  tool: InstallableTool;
  version: string;
  url: string;
  /** sha256 (hex) of the download, or an npm integrity (sha512, base64). */
  checksum: { algo: 'sha256' | 'sha512'; value: string };
  archive: 'tar.gz' | 'zip' | 'npm';
  /** The binary's path inside the archive. */
  member: string;
  /** Where the binary ends up: <prefix>/bin/<tool>. */
  dest: string;
  prefix: string;
}

/** The install for a tool on this machine, or null where none is pinned (native Windows, another architecture). */
export function installPlan(tool: InstallableTool, prefix: string, plat = toolPlatform()): ToolInstall | null {
  const dest = join(prefix, 'bin', tool);
  if (tool === 'claude') {
    const v = PINS.claude.version;
    return { tool, version: v, url: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${v}.tgz`, checksum: { algo: 'sha512', value: PINS.claude.integrity.slice('sha512-'.length) }, archive: 'npm', member: '', dest, prefix };
  }
  if (!plat) return null;
  const key: Plat = `${plat.os}-${plat.arch}`;
  if (tool === 'gitleaks') {
    const v = PINS.gitleaks.version;
    const f = `gitleaks_${v}_${plat.os}_${plat.arch}.tar.gz`;
    return { tool, version: v, url: `https://github.com/gitleaks/gitleaks/releases/download/v${v}/${f}`, checksum: { algo: 'sha256', value: PINS.gitleaks.sha256[key] }, archive: 'tar.gz', member: 'gitleaks', dest, prefix };
  }
  const v = PINS.gh.version;
  const arch = plat.arch === 'x64' ? 'amd64' : 'arm64';
  const base = plat.os === 'darwin' ? `gh_${v}_macOS_${arch}` : `gh_${v}_linux_${arch}`;
  const ext = plat.os === 'darwin' ? 'zip' : 'tar.gz';
  return { tool, version: v, url: `https://github.com/cli/cli/releases/download/v${v}/${base}.${ext}`, checksum: { algo: 'sha256', value: PINS.gh.sha256[key] }, archive: ext, member: `${base}/bin/gh`, dest, prefix };
}

/** The plan in one line, as init prints it before asking. */
export function describeInstall(p: ToolInstall): string {
  const where = p.archive === 'npm' ? `npm install -g --prefix ${p.prefix}` : p.dest;
  return `${p.tool} ${p.version}: ${p.url} (${p.checksum.algo} ${p.checksum.value}) -> ${where}`;
}

/** The download's checksum in the plan's form: sha256 hex, sha512 base64. */
export function checksumOf(file: string, algo: 'sha256' | 'sha512'): string {
  return createHash(algo).update(readFileSync(file)).digest(algo === 'sha256' ? 'hex' : 'base64');
}

export type Download = (url: string, file: string) => Promise<void>;

/** Fetch a URL to a file (redirects followed; GitHub's release downloads redirect). */
export const httpDownload: Download = async (url, file) => {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
};

type Run = (cmd: string, args: string[]) => { status: number | null; stderr: string };
const spawnRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.error ? null : r.status, stderr: r.error ? r.error.message : r.stderr };
};

/**
 * Download, check, unpack and install one tool. The checksum is checked before anything is unpacked or run; a
 * mismatch deletes the download and installs nothing.
 */
export async function installTool(p: ToolInstall, o: { download?: Download; run?: Run } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const download = o.download ?? httpDownload;
  const run = o.run ?? spawnRun;
  const work = mkdtempSync(join(tmpdir(), `${p.tool}-install-`));
  try {
    const file = join(work, p.url.split('/').pop()!);
    try {
      await download(p.url, file);
    } catch (e) {
      return { ok: false, error: `couldn't download ${p.url}: ${(e as Error).message}` };
    }
    const got = existsSync(file) ? checksumOf(file, p.checksum.algo) : '(nothing downloaded)';
    if (got !== p.checksum.value) {
      rmSync(file, { force: true });
      return { ok: false, error: `checksum mismatch for ${p.url}: got ${p.checksum.algo} ${got}, want ${p.checksum.value}; nothing was installed` };
    }
    if (p.archive === 'npm') {
      const r = run('npm', ['install', '-g', '--prefix', p.prefix, '--no-audit', '--no-fund', file]);
      return r.status === 0 ? { ok: true } : { ok: false, error: `npm install of ${p.tool} failed: ${r.stderr.trim().split('\n').pop() ?? ''}` };
    }
    const out = join(work, 'out');
    mkdirSync(out);
    const r = p.archive === 'zip' ? run('unzip', ['-q', '-o', file, p.member, '-d', out]) : run('tar', ['-xzf', file, '-C', out, p.member]);
    if (r.status !== 0 || !existsSync(join(out, p.member))) return { ok: false, error: `couldn't unpack ${p.member} from ${p.url}: ${r.stderr.trim()}` };
    mkdirSync(join(p.prefix, 'bin'), { recursive: true });
    copyFileSync(join(out, p.member), p.dest);
    chmodSync(p.dest, 0o755);
    return { ok: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

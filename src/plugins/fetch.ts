// WHY: a plugin is fetched at exactly the commit the owner names and copied out of git before anyone looks at it, so
// what is inspected, hashed and later materialized is that commit's files and nothing else: no hooks, no submodules,
// no LFS smudge, no config from the machine, no ref that can move. Running this as a throwaway user (systemd
// DynamicUser) is the root side's job (scripts/setup/plugins.sh); this module is the part that is the same wherever it
// runs, and it never executes a file it fetched.
import { execFileSync } from '../os/child-process.js';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ownEnv } from '../os/own-env.js';
import { type Inspection } from './inspect.js';
import { treeFiles, treeHashOf, type TreeFile } from './tree.js';

export const SHA = /^[0-9a-f]{40}$/;
/** An https git URL on a named host: no credentials in it, no query, no fragment. */
export const GIT_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+$/;
/** A subdirectory inside the repository: plain segments only. */
export const SUBDIR = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export interface GitSource {
  url: string;
  sha: string;
  /** The plugin's directory inside the repository; the root when unset. */
  path?: string;
}

export class FetchError extends Error {}

/** Why a source can't be fetched, or null. */
export function sourceProblem(s: GitSource, o: { allowFileUrls?: boolean } = {}): string | null {
  if (!SHA.test(s.sha)) return 'the commit must be a full 40-character lowercase SHA';
  if (!(GIT_URL.test(s.url) || (o.allowFileUrls && s.url.startsWith('file:///')))) return 'the source must be an https:// git URL';
  if (s.path !== undefined && (!SUBDIR.test(s.path) || s.path.split('/').some((p) => p === '.' || p === '..'))) return 'the path must be a plain subdirectory';
  return null;
}

/**
 * git, with nothing from the machine or the user: no system or global config, no prompts, no hooks, no LFS; no
 * redirect followed (a host can't send the fetch elsewhere); and, when `pin` is given (host:443:address), only that
 * address for that host (http.curloptResolve), so DNS can't change it after it was checked (src/plugins/hosts.ts).
 */
export function gitSafety(allowFile: boolean, pin?: string): string[] {
  return ['-c', 'http.followRedirects=false', ...(pin ? ['-c', `http.curloptResolve=${pin}`] : []), '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'submodule.recurse=false', '-c', 'core.symlinks=true', '-c', 'advice.detachedHead=false'];
}
function git(cwd: string, home: string, args: string[], allowFile: boolean, pin?: string): string {
  return execFileSync('git', [...gitSafety(allowFile, pin), ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: ownEnv().get('PATH') ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false', GIT_LFS_SKIP_SMUDGE: '1', LANG: 'C' },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Fetch `s` into `dest` (which must not exist): the files of exactly that commit, at `s.path`, with no .git. Symlinks
 * are copied as symlinks so the tree hash refuses them; nothing is followed. Throws FetchError.
 */
export function fetchGitPlugin(s: GitSource, dest: string, o: { allowFileUrls?: boolean; pin?: string } = {}): void {
  const why = sourceProblem(s, o);
  if (why) throw new FetchError(why);
  if (existsSync(dest)) throw new FetchError(`${dest} already exists`);
  const work = mkdtempSync(join(tmpdir(), 'plugin-fetch-'));
  const repo = join(work, 'repo');
  try {
    mkdirSync(repo);
    const allow = !!o.allowFileUrls;
    const g = (cwd: string, home: string, args: string[]) => git(cwd, home, args, allow, o.pin);
    g(repo, work, ['init', '-q']);
    g(repo, work, ['remote', 'add', 'origin', s.url]);
    try {
      g(repo, work, ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', s.sha]);
    } catch (e) {
      throw new FetchError(`commit ${s.sha} could not be fetched from ${s.url}: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split('\n').pop()}`);
    }
    g(repo, work, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
    const head = g(repo, work, ['rev-parse', 'HEAD']).trim();
    if (head !== s.sha) throw new FetchError(`fetched ${head}, not ${s.sha}`);
    const from = s.path ? join(repo, ...s.path.split('/')) : repo;
    if (!existsSync(from)) throw new FetchError(`${s.path} is not in commit ${s.sha}`);
    // git archive of the subtree: the committed files only (never the .git dir), with their modes, links as links.
    const tar = join(work, 'tree.tar');
    g(repo, work, ['archive', '--format=tar', '-o', tar, s.path ? `HEAD:${s.path}` : 'HEAD']);
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xf', tar, '-C', dest, '--no-same-owner'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: ownEnv().get('PATH') ?? '/usr/bin:/bin', LANG: 'C' } });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface Materialized {
  tree: string;
  files: TreeFile[];
  /** Each change made to the plugin as fetched, in words, for the approval record and the review page. */
  transform: string[];
}

/**
 * The approved copy of an inspected plugin, at `dest` (must not exist): its files as inspected, minus its MCP server
 * config, which the broker runs in Claude Code's place (.mcp.json removed; `mcpServers` removed from plugin.json and
 * the files it names). Refuses a plugin with refusals, or one whose files changed since inspection.
 */
export function materialize(src: string, ins: Inspection, dest: string): Materialized {
  if (ins.refusals.length) throw new FetchError(`refused: ${ins.refusals.join('; ')}`);
  if (!ins.tree || treeHashOf(treeFiles(src)) !== ins.tree) throw new FetchError(`${src} changed since it was inspected`);
  if (existsSync(dest)) throw new FetchError(`${dest} already exists`);
  const transform: string[] = [];
  const drop = new Set<string>();
  if (ins.files.some((f) => f.path === '.mcp.json')) drop.add('.mcp.json');
  let manifest: Record<string, unknown> | null = null;
  if (ins.files.some((f) => f.path === '.claude-plugin/plugin.json')) {
    manifest = JSON.parse(readFileSync(join(src, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    for (const v of [manifest.mcpServers].flat()) if (typeof v === 'string' && v.startsWith('./')) drop.add(v.slice(2));
  }
  for (const s of ins.mcpServers) transform.push(`MCP server "${s.name}" (from ${s.from}) is run by the broker, not by Claude Code`);
  for (const f of ins.files) {
    if (drop.has(f.path)) continue;
    const to = join(dest, ...f.path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, ...f.path.split('/')), to);
    chmodSync(to, f.mode === '755' ? 0o755 : 0o644);
  }
  for (const p of [...drop].sort()) transform.push(`removed ${p}`);
  if (manifest && 'mcpServers' in manifest) {
    delete manifest.mcpServers;
    writeFileSync(join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    chmodSync(join(dest, '.claude-plugin', 'plugin.json'), 0o644);
    transform.push('removed "mcpServers" from .claude-plugin/plugin.json');
  }
  const files = treeFiles(dest);
  return { tree: treeHashOf(files), files, transform };
}

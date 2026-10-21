// The chat lane's rule in the agents' tool guard (src/hook.ts): a channel-chat run's three read tools, inside the
// checkout only, never a credential, key, config or .env file. src/intake/chat.ts uses it too.
// INVARIANT (#785): imports only node built-ins, src/brand.ts and src/guardrails/** (see src/guard/research.ts).
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BRAND } from '../brand.js';
import { globToRegExp } from '../guardrails/glob.js';

export const CHAT_ROLE = 'channel-chat';
/** The env the chat lane's settings pin for its hooks: the checkout, the only place it may read. */
export const CHAT_ROOT_ENV = `${BRAND.envPrefix}_CHAT_ROOT`;
/** Exactly these tools. */
export const CHAT_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** Every other tool, named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export const CHAT_DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'LS', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch', 'mcp__*'] as const;
/** Key-like and credential files, as Read deny rules in the chat lane's settings (the hook covers .env.* but .env.example). */
export const CHAT_KEY_GLOBS = ['**/.env', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/credentials.yaml', '**/credentials.json', '**/intake.yaml', '**/policy.yaml', '**/.git/**'] as const;

/** Config and credential file names no chat run reads, wherever they are. */
const SECRET_NAMES = new Set(['credentials.yaml', 'credentials.yml', 'credentials.json', '.credentials.json', 'intake.yaml', 'policy.yaml', 'instance.yaml', 'agent-settings.json', '.npmrc', '.netrc', '.pypirc', '.htpasswd', '.git-credentials', '.dockercfg']);
const KEY_FILE = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|der|crt|cer|tfvars)$/i;
const KEY_NAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|secrets?\.(?:ya?ml|json|toml|env|txt)|.*\.secrets?)$/i;

/** Is this path (relative to the checkout) a credential, key, config or .env file (but .env.example), or under .git? */
export function secretLike(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.includes('.git')) return true;
  const name = parts.at(-1) ?? '';
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== '.env.example') return true;
  return SECRET_NAMES.has(name.toLowerCase()) || KEY_FILE.test(name) || KEY_NAME.test(name);
}

const inside = (root: string, p: string) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** The real path of `p` (its nearest existing parent's, for a path that doesn't exist), so a symlink can't lead out. */
function real(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    return resolve(p);
  }
}

/** A Grep glob as patterns the checks can test: braces expanded (one level); classes and negations: null (unknown). */
function globPatterns(glob: string): RegExp[] | null {
  if (/[[\]!]/.test(glob)) return null;
  const m = glob.match(/^([^{}]*)\{([^{}]*)\}([^{}]*)$/);
  const alts = m ? m[2]!.split(',').map((a) => `${m[1]}${a}${m[3]}`) : /[{}]/.test(glob) ? null : [glob];
  return alts ? alts.map((g) => globToRegExp(g.includes('/') ? g : `**/${g}`)) : null;
}

/** Names a secret file could have, for telling whether a Grep glob could reach one. */
const PROBES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'server.pem', 'tls.key', 'cert.p12', 'credentials.yaml', 'credentials.json', 'intake.yaml', 'policy.yaml', 'secrets.json', 'secrets.yaml', 'prod.tfvars', '.npmrc', '.netrc'].flatMap((n) => [n, `a/${n}`, `a/b/${n}`]);

/** The most entries a directory Grep's secret check walks; past that, the Grep needs a glob that can't reach one. */
export const WALK_LIMIT = 20_000;

/** Secret-like files under `dir` (relative to `root`), or null when there are more entries than WALK_LIMIT. */
function secretFiles(root: string, dir: string): string[] | null {
  const out: string[] = [];
  let seen = 0;
  const walk = (d: string): boolean => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) return false;
      const p = join(d, e.name);
      const rel = relative(root, p).split(sep).join('/');
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        if (!walk(p)) return false;
      } else if (secretLike(rel)) out.push(rel);
    }
    return true;
  };
  return walk(dir) ? out : null;
}

/**
 * The chat lane's rule, in the PreToolUse hook: only Read, Glob and Grep; every path inside the checkout `root` (its
 * real path: a symlink out is refused); never a credential, key, config or .env file (but .env.example) or .git; a
 * Grep over a directory only when it can't reach such a file (none there, or a glob that can't match one).
 */
export function chatModeRefusal(tool: string, input: Record<string, unknown>, cwd: string, rootIn: string): string | null {
  if (!(CHAT_TOOLS as readonly string[]).includes(tool)) return `chat runs may only use ${CHAT_TOOLS.join(', ')}; ${tool} is refused`;
  const root = real(rootIn);
  if (!inside(root, real(cwd))) return `chat: the run's directory ${cwd} is outside the checkout; refusing`;
  const str = (x: unknown) => (typeof x === 'string' && x.length > 0 ? x : null);
  const target = str(tool === 'Read' ? input.file_path : input.path) ?? cwd;
  const abs = real(resolve(cwd, target));
  if (!inside(root, abs)) return `chat: ${abs} is outside the checkout; refusing`;
  const rel = relative(root, abs).split(sep).join('/');
  if (rel && secretLike(rel)) return `chat: ${rel} is a credential, key, config or .env file; never read in chat`;
  if (tool === 'Read') return null;
  if (tool === 'Glob') {
    const pattern = str(input.pattern) ?? '';
    if (pattern.split(/[\\/]/).includes('..')) return 'chat: a Glob pattern may not climb out of the checkout';
    if (isAbsolute(pattern) && !inside(root, real(pattern.replace(/[*?[{].*$/, '') || '/'))) return `chat: ${pattern} is outside the checkout; refusing`;
    return null;
  }
  // Grep reads file contents: a file target was checked above; a directory must not hold a secret it would search.
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    return null;
  }
  if (!isDir) return null;
  const glob = str(input.glob);
  const pats = glob ? globPatterns(glob) : null;
  const matches = (r: string) => (pats ? pats.some((p) => p.test(r)) : true);
  if (pats && !PROBES.some(matches)) return null;
  const found = secretFiles(root, abs);
  if (found === null) return `chat: ${rel || '.'} is too large to check for secret files; give Grep a glob such as "*.ts"`;
  const hit = found.find(matches);
  return hit ? `chat: a Grep there would search ${hit} (a credential, key or .env file); give it a glob such as "*.ts" or a narrower path` : null;
}

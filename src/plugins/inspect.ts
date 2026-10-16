// WHY: what an owner approves must be all that loads. The inspector reads a fetched plugin directory (Claude Code's own
// format, nothing of ours inside it) and either refuses it, naming every reason, or lists exactly what it carries:
// its skills, agents, commands, output styles and bin/ entries, and the stdio MCP servers that the broker will run in
// Claude Code's place. It never executes anything from the plugin and never follows a symlink (the tree hash refuses
// them first).
//
// Refused in this version, each because it runs code outside the agent's sandbox, widens what the agent may do, or
// fetches at load time (Claude Code docs: plugins-reference, skills, sub-agents, sandboxing, permissions):
// hooks anywhere (hooks/hooks.json, the manifest's `hooks`, skill frontmatter `hooks`), LSP servers, monitors,
// workflows, channels, plugin settings (`agent`, `subagentStatusLine`), `allowed-tools` grants in skills and commands,
// inline shell in skills and commands (`!` blocks), sensitive userConfig, MCP servers that aren't a plain stdio command
// (URLs, bundles, headers, headersHelper) or that fetch their code when started (npx, uvx, ...), dependencies not
// approved themselves, and any manifest key this file doesn't know: a new component type is refused until it's
// reviewed into this list.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { treeFiles, treeHashOf, TreeError, type TreeFile, type TreeLimits } from './tree.js';

/** Manifest keys a plugin may carry in this version. Anything else is refused (the "allowlist of fields" rule). */
const ALLOWED_KEYS = new Set([
  '$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'metadata',
  'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', 'defaultEnabled', 'dependencies', 'userConfig',
  'skills', 'commands', 'agents', 'outputStyles', 'mcpServers',
]);
/** Manifest keys refused with a specific reason. */
const REFUSED_KEYS: Record<string, string> = {
  hooks: 'hooks run commands as the agent user, outside its sandbox',
  lspServers: 'LSP servers run outside the agent sandbox',
  experimental: 'monitors and other experimental components run commands outside the agent sandbox',
  monitors: 'monitors run commands outside the agent sandbox',
  themes: 'themes are interactive-only and not reviewed for agent runs',
  workflows: 'workflows are not reviewed for agent runs yet',
  channels: 'channels push messages into the session from an MCP server',
  settings: 'plugin settings can replace the main agent or run a status line command',
  types: 'mods are not supported for agent runs',
};
/** Files and directories at the plugin root that Claude Code loads by default, refused like their manifest keys. */
const REFUSED_DEFAULTS: [path: string, why: string][] = [
  ['hooks/hooks.json', REFUSED_KEYS.hooks!],
  ['.lsp.json', REFUSED_KEYS.lspServers!],
  ['monitors/monitors.json', REFUSED_KEYS.monitors!],
  ['workflows', REFUSED_KEYS.workflows!],
  ['themes', REFUSED_KEYS.themes!],
  ['settings.json', REFUSED_KEYS.settings!],
];
/** Skill and agent frontmatter keys refused. */
const SKILL_REFUSED: Record<string, string> = {
  hooks: 'skill hooks keep running for the rest of the session, outside the sandbox',
  'allowed-tools': 'allowed-tools grants tools without the run\'s own rules',
  allowedTools: 'allowedTools grants tools without the run\'s own rules',
};
const AGENT_REFUSED: Record<string, string> = {
  hooks: 'agent hooks run outside the sandbox',
  mcpServers: 'an agent may not bring its own MCP servers',
  permissionMode: 'an agent may not change the permission mode',
};
/** Launchers that fetch the server's code when it starts, so no pin covers what runs. */
const FETCHING_LAUNCHERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'bun', 'uvx', 'uv', 'pipx', 'pip', 'docker', 'podman', 'deno', 'curl', 'wget', 'sh', 'bash', 'zsh']);
/** Runtimes a stdio server may be started with, running a file inside the plugin. */
const RUNTIMES = new Set(['node', 'python3', 'python']);
const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';

export interface McpServerSpec {
  /** The server key in the plugin's config. */
  name: string;
  /** argv with ${CLAUDE_PLUGIN_ROOT} kept as written; the broker resolves it against the materialized directory. */
  argv: string[];
  /** Environment variable names the config sets (values are never shown: they can carry credentials). */
  envNames: string[];
  /** Where it was declared. */
  from: string;
}

export interface Inspection {
  name: string | null;
  version: string | null;
  refusals: string[];
  skills: string[];
  agents: string[];
  commands: string[];
  outputStyles: string[];
  bin: string[];
  mcpServers: McpServerSpec[];
  /** userConfig option names (non-sensitive only; a sensitive one is a refusal). */
  options: string[];
  /** Things the owner should look at, not refusals: env vars, home paths and URLs that the plugin's text names. */
  flags: string[];
  files: TreeFile[];
  /** wl-tree-v1 of the directory as fetched; null when it can't be hashed (that is a refusal too). */
  tree: string | null;
}

export interface InspectOptions {
  /** Plugin ids (`name` or `name@marketplace`) already approved for this instance: the only dependencies allowed. */
  approved?: ReadonlySet<string>;
  limits?: TreeLimits;
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = (v: Json): Json[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** A manifest component path: `./` and inside the plugin, as Claude Code requires; null when it isn't one. */
function componentPath(p: Json): string | null {
  if (typeof p !== 'string') return null;
  if (p === '.' || p === './') return '';
  if (!p.startsWith('./') || p.includes('\\')) return null;
  const n = posix.normalize(p.slice(2));
  return n === '..' || n.startsWith('../') || posix.isAbsolute(n) ? null : n.replace(/\/$/, '');
}

/** The YAML frontmatter of a Markdown file, and its body. A file with no frontmatter has `{}`. */
export function frontmatter(text: string): { data: Record<string, Json>; body: string; error?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  try {
    const d = parseYaml(m[1]!) as Json;
    return { data: isObj(d) ? d : {}, body: text.slice(m[0].length) };
  } catch (e) {
    return { data: {}, body: text.slice(m[0].length), error: (e as Error).message };
  }
}

/** Inline shell Claude Code would run while rendering a skill or command: `` !`cmd` `` at a line start or after
 * whitespace, and ```! fenced blocks (skills docs, "Inject dynamic context"). */
export function hasInlineShell(body: string): boolean {
  return /(^|\s)!`/m.test(body) || /^\s*(```|~~~)!/m.test(body);
}

/** What the plugin's text names that the owner should see: env vars, home-relative paths and URLs. */
function textFlags(path: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) if (!['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SKILL_DIR', 'ARGUMENTS'].includes(m[1]!)) out.add(`${path} reads env ${m[1]}`);
  if (/CLAUDE_PLUGIN_DATA/.test(text)) out.add(`${path} uses CLAUDE_PLUGIN_DATA, which is read-only for agent runs`);
  for (const m of text.matchAll(/(~\/|\$HOME\/)[\w./-]+/g)) out.add(`${path} names ${m[0]}`);
  for (const m of text.matchAll(/https?:\/\/[^\s)"'<>`]+/g)) out.add(`${path} names ${m[0]}`);
  return [...out];
}

/** Inspect a fetched plugin directory. Never throws for anything the plugin contains: that is a refusal. */
export function inspectPlugin(root: string, opts: InspectOptions = {}): Inspection {
  const r: Inspection = { name: null, version: null, refusals: [], skills: [], agents: [], commands: [], outputStyles: [], bin: [], mcpServers: [], options: [], flags: [], files: [], tree: null };
  const refuse = (why: string) => r.refusals.push(why);
  try {
    r.files = treeFiles(root, opts.limits);
    r.tree = treeHashOf(r.files);
  } catch (e) {
    if (e instanceof TreeError) {
      refuse(`files: ${e.message}`);
      return r;
    }
    throw e;
  }
  const has = (rel: string) => r.files.some((f) => f.path === rel || f.path.startsWith(`${rel}/`));
  const read = (rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8');

  // The manifest (optional).
  let manifest: Record<string, Json> = {};
  if (has('.claude-plugin/plugin.json')) {
    try {
      const v = JSON.parse(read('.claude-plugin/plugin.json')) as Json;
      if (!isObj(v)) refuse('.claude-plugin/plugin.json: not a JSON object');
      else manifest = v;
    } catch (e) {
      refuse(`.claude-plugin/plugin.json: not JSON (${(e as Error).message})`);
    }
  }
  for (const f of r.files) if (f.path.startsWith('.claude-plugin/') && f.path !== '.claude-plugin/plugin.json') refuse(`${f.path}: only plugin.json belongs in .claude-plugin/ (a plugin, not a marketplace)`);
  r.name = typeof manifest.name === 'string' ? manifest.name : null;
  r.version = typeof manifest.version === 'string' ? manifest.version : null;
  if (r.name !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.name)) refuse(`name ${JSON.stringify(r.name)}: use lowercase letters, digits and dashes`);
  for (const k of Object.keys(manifest)) {
    if (REFUSED_KEYS[k]) refuse(`manifest "${k}": ${REFUSED_KEYS[k]}`);
    else if (!ALLOWED_KEYS.has(k)) refuse(`manifest "${k}": not a key this version reviews`);
  }
  for (const [p, why] of REFUSED_DEFAULTS) if (has(p)) refuse(`${p}: ${why}`);

  // userConfig: non-sensitive only (sensitive values go to the agent user's own credential store).
  if (manifest.userConfig !== undefined) {
    if (!isObj(manifest.userConfig)) refuse('manifest "userConfig": not an object');
    else
      for (const [k, o] of Object.entries(manifest.userConfig)) {
        if (isObj(o) && o.sensitive === true) refuse(`userConfig "${k}": sensitive values would be stored where the agent user can read them`);
        else r.options.push(k);
      }
  }
  // Dependencies: each must itself be approved for this instance.
  for (const d of asList(manifest.dependencies)) {
    const id = typeof d === 'string' ? d : isObj(d) && typeof d.name === 'string' ? (typeof d.marketplace === 'string' ? `${d.name}@${d.marketplace}` : d.name) : null;
    if (!id) refuse('dependencies: an entry that names no plugin');
    else if (!opts.approved?.has(id)) refuse(`dependency ${id}: not approved for this instance (approve it first, at its own pin)`);
  }

  // Component directories: defaults, plus what the manifest names.
  const paths = (key: string, def: string | null, mode: 'replace' | 'add'): string[] => {
    const v = manifest[key];
    if (v === undefined) return def !== null ? [def] : [];
    const listed: string[] = [];
    for (const p of asList(v)) {
      const c = componentPath(p);
      if (c === null) refuse(`manifest "${key}": ${JSON.stringify(p)} is not a ./ path inside the plugin`);
      else listed.push(c);
    }
    return mode === 'add' && def !== null ? [def, ...listed] : listed;
  };

  // Skills: <dir>/<name>/SKILL.md, or a directory holding SKILL.md itself; a plugin with only a root SKILL.md is one skill.
  const skillFiles = new Set<string>();
  for (const d of paths('skills', 'skills', 'add')) {
    const direct = d ? `${d}/SKILL.md` : 'SKILL.md';
    if (has(direct)) skillFiles.add(direct);
    for (const f of r.files) {
      const rest = d ? (f.path.startsWith(`${d}/`) ? f.path.slice(d.length + 1) : null) : f.path;
      if (rest && /^[^/]+\/SKILL\.md$/.test(rest)) skillFiles.add(f.path);
    }
  }
  if (manifest.skills === undefined && !has('skills') && has('SKILL.md')) skillFiles.add('SKILL.md');
  for (const f of [...skillFiles].sort()) {
    const { data, body, error } = frontmatter(read(f));
    if (error) refuse(`${f}: frontmatter is not YAML (${error})`);
    for (const k of Object.keys(data)) if (SKILL_REFUSED[k]) refuse(`${f}: "${k}": ${SKILL_REFUSED[k]}`);
    if (hasInlineShell(body)) refuse(`${f}: inline shell (!\`...\`) runs while the skill renders`);
    r.skills.push(typeof data.name === 'string' ? data.name : f.split('/').slice(-2, -1)[0] ?? f);
  }

  // Commands: flat .md files or directories of them, or an object map (source or inline content).
  const commandText: [string, string][] = [];
  if (isObj(manifest.commands)) {
    for (const [name, c] of Object.entries(manifest.commands)) {
      if (!isObj(c)) {
        refuse(`manifest "commands.${name}": not an object`);
        continue;
      }
      if (c.allowedTools !== undefined) refuse(`manifest "commands.${name}.allowedTools": ${SKILL_REFUSED.allowedTools}`);
      if (typeof c.content === 'string') commandText.push([`commands.${name}`, c.content]);
      else {
        const s = componentPath(c.source);
        if (s === null || !has(s)) refuse(`manifest "commands.${name}.source": not a file inside the plugin`);
        else commandText.push([s, read(s)]);
      }
      r.commands.push(name);
    }
  } else
    for (const d of paths('commands', 'commands', 'replace'))
      for (const f of r.files)
        if ((f.path === d || f.path.startsWith(`${d}/`)) && f.path.endsWith('.md')) {
          commandText.push([f.path, read(f.path)]);
          r.commands.push(posix.basename(f.path, '.md'));
        }
  for (const [where, text] of commandText) {
    const { data, body, error } = frontmatter(text);
    if (error) refuse(`${where}: frontmatter is not YAML (${error})`);
    for (const k of Object.keys(data)) if (SKILL_REFUSED[k]) refuse(`${where}: "${k}": ${SKILL_REFUSED[k]}`);
    if (hasInlineShell(body)) refuse(`${where}: inline shell (!\`...\`) runs while the command renders`);
  }

  // Agents: .md files.
  for (const d of paths('agents', 'agents', 'replace'))
    for (const f of r.files)
      if ((f.path === d || f.path.startsWith(`${d}/`)) && f.path.endsWith('.md')) {
        const { data, error } = frontmatter(read(f.path));
        if (error) refuse(`${f.path}: frontmatter is not YAML (${error})`);
        for (const k of Object.keys(data)) if (AGENT_REFUSED[k]) refuse(`${f.path}: "${k}": ${AGENT_REFUSED[k]}`);
        r.agents.push(typeof data.name === 'string' ? data.name : posix.basename(f.path, '.md'));
      }
  for (const d of paths('outputStyles', 'output-styles', 'replace')) for (const f of r.files) if (f.path === d || f.path.startsWith(`${d}/`)) r.outputStyles.push(f.path);
  for (const f of r.files) if (f.path.startsWith('bin/')) r.bin.push(f.path.slice(4));

  // MCP servers: .mcp.json, then the manifest's mcpServers (paths, inline maps, or bundles).
  const servers = (map: Json, from: string) => {
    const m = isObj(map) && isObj(map.mcpServers) ? map.mcpServers : map;
    if (!isObj(m)) return refuse(`${from}: not an mcpServers map`);
    for (const [name, s] of Object.entries(m)) mcpServer(name, s, from);
  };
  const mcpServer = (name: string, s: Json, from: string) => {
    const where = `${from} server "${name}"`;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return refuse(`${where}: name must be letters, digits, _ and -`);
    if (!isObj(s)) return refuse(`${where}: not an object`);
    if (s.url !== undefined || (s.type !== undefined && s.type !== 'stdio')) return refuse(`${where}: remote servers are not supported yet (deferred)`);
    if (s.headers !== undefined || s.headersHelper !== undefined) return refuse(`${where}: headers and headersHelper are not supported`);
    const extra = Object.keys(s).filter((k) => !['type', 'command', 'args', 'env'].includes(k));
    if (extra.length) return refuse(`${where}: ${extra.join(', ')} not reviewed in this version`);
    if (typeof s.command !== 'string' || !s.command) return refuse(`${where}: no command`);
    const args = s.args === undefined ? [] : s.args;
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return refuse(`${where}: args must be a list of strings`);
    if (s.env !== undefined && !(isObj(s.env) && Object.values(s.env).every((v) => typeof v === 'string'))) return refuse(`${where}: env must map names to strings`);
    const argv = [s.command, ...(args as string[])];
    if (argv.some((a) => a.includes('${user_config.'))) return refuse(`${where}: user_config values in a server's command line are not supported`);
    const base = posix.basename(s.command);
    const inPlugin = (a: string | undefined) => !!a && a.startsWith(`${ROOT_VAR}/`) && componentPath(`./${a.slice(ROOT_VAR.length + 1)}`) !== null && has(a.slice(ROOT_VAR.length + 1));
    if (FETCHING_LAUNCHERS.has(base)) return refuse(`${where}: "${base}" fetches or runs code no pin covers; ship the server inside the plugin, or approve it as a pinned npm server`);
    if (!inPlugin(s.command) && !(RUNTIMES.has(base) && !s.command.includes('/') && inPlugin(args[0] as string | undefined)))
      return refuse(`${where}: the command must be a file inside the plugin, or ${[...RUNTIMES].join('/')} running one`);
    r.mcpServers.push({ name, argv, envNames: Object.keys((s.env as Record<string, string> | undefined) ?? {}).sort(), from });
  };
  if (has('.mcp.json')) {
    try {
      servers(JSON.parse(read('.mcp.json')) as Json, '.mcp.json');
    } catch (e) {
      refuse(`.mcp.json: not JSON (${(e as Error).message})`);
    }
  }
  if (manifest.mcpServers !== undefined)
    for (const v of asList(manifest.mcpServers)) {
      if (typeof v === 'string') {
        if (/\.(mcpb|dxt)$/i.test(v) || /^https?:/i.test(v)) {
          refuse(`manifest "mcpServers": ${JSON.stringify(v)}: bundles are unpacked or downloaded at load time`);
          continue;
        }
        const p = componentPath(v);
        if (p === null || !has(p)) refuse(`manifest "mcpServers": ${JSON.stringify(v)} is not a file inside the plugin`);
        else
          try {
            servers(JSON.parse(read(p)) as Json, p);
          } catch (e) {
            refuse(`${p}: not JSON (${(e as Error).message})`);
          }
      } else servers(v, 'plugin.json');
    }
  const dup = r.mcpServers.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) refuse(`MCP server names declared twice: ${[...new Set(dup)].join(', ')}`);

  // What the text names, for the owner (not refusals).
  for (const f of r.files) if (f.size <= 256 * 1024 && /\.(md|json|sh|js|mjs|cjs|py|ts|txt|ya?ml)$/i.test(f.path)) r.flags.push(...textFlags(f.path, read(f.path)));
  r.flags = [...new Set(r.flags)].sort();
  return r;
}

/** Whether a directory looks like a plugin root at all (a manifest or any default component). */
export function looksLikePlugin(root: string): boolean {
  if (!existsSync(root) || !statSync(root).isDirectory()) return false;
  const names = new Set(readdirSync(root));
  return ['.claude-plugin', 'skills', 'commands', 'agents', '.mcp.json', 'SKILL.md'].some((n) => names.has(n));
}

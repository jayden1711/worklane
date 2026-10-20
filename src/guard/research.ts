// The research lane's rules in the agents' tool guard (src/hook.ts): which tools a researcher (or an intake run in the
// research lane) may call, where it may read, and which hosts it may fetch. src/research.ts uses them too.
// INVARIANT (#785): a module under src/guard/ imports only node built-ins, src/brand.ts, src/guardrails/** and other
// src/guard/ modules, so the guard's import tree stays small (test/review.test.ts pins it). It is locked with the guard.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { BRAND } from '../brand.js';

/** The only tools a researcher run gets. No Bash (so no shell network), no Edit/Write/NotebookEdit, no MCP. */
export const RESEARCH_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] as const;
/** Named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export const RESEARCH_DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'mcp__*'] as const;

/** The bundle file the hook reads in research mode (the blocklist, and what the run is for). */
export const RESEARCH_MANIFEST = 'research.json';

/** The env the research lane's hook runs with: the research root (reads are allowed only under it). */
export const RESEARCH_ROOT_ENV = `${BRAND.envPrefix}_RESEARCH_ROOT`;

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const inside = (root: string, p: string) => {
  const r = relative(resolve(root), resolve(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/**
 * The research lane's rule, in the PreToolUse hook (it has no project config there: its working directory is a
 * bundle). Only the research tools; every file read inside the research root (so never the checkout, a worktree, the
 * task or chat files); WebFetch only http(s) and never a domain on the bundle's blocklist. An unreadable bundle
 * manifest refuses every fetch (fail closed).
 */
export function researchModeRefusal(tool: string, input: Record<string, unknown>, cwd: string, root: string): string | null {
  if (!(RESEARCH_TOOLS as readonly string[]).includes(tool)) return `research runs may only use ${RESEARCH_TOOLS.join(', ')}; ${tool} is refused`;
  if (!inside(root, cwd)) return `research: the run's directory ${cwd} is outside its research root; refusing`;
  if (FILE_TOOLS.has(tool)) {
    const paths = [input.file_path, input.path].filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (tool === 'Glob' && typeof input.pattern === 'string' && isAbsolute(input.pattern)) paths.push(input.pattern);
    if (!paths.length) paths.push(cwd);
    const out = paths.map((p) => resolve(cwd, p)).find((p) => !inside(root, p));
    if (out) return `research: this run has no repo access; ${out} is outside its bundle`;
    return null;
  }
  if (tool === 'WebFetch') {
    let blocklist: string[];
    try {
      blocklist = (JSON.parse(readFileSync(join(cwd, RESEARCH_MANIFEST), 'utf8')) as { blocklist?: string[] }).blocklist ?? [];
    } catch (e) {
      return `research: the run's ${RESEARCH_MANIFEST} can't be read (${(e as Error).message.split('\n')[0]}), so its blocklist can't be applied; refusing`;
    }
    return researchCallRefusal(tool, input, blocklist);
  }
  return null;
}

/** A host is blocked if it is a listed domain or a subdomain of one. Matching ignores case and a leading "www.". */
export function blockedHost(host: string, blocklist: string[]): string | null {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  for (const d of blocklist) {
    const b = d.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    if (b && (h === b || h.endsWith(`.${b}`))) return d;
  }
  return null;
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/** Why a researcher's tool call is refused before it runs (the PreToolUse hook), or null. */
export function researchCallRefusal(tool: string, input: Record<string, unknown>, blocklist: string[]): string | null {
  if (!(RESEARCH_TOOLS as readonly string[]).includes(tool)) return `research runs may only use ${RESEARCH_TOOLS.join(', ')}; ${tool} is refused`;
  if (tool === 'WebFetch') {
    const url = String(input.url ?? '');
    const host = hostOf(url);
    if (!host) return `research: ${url || '(no url)'} is not an http(s) URL`;
    const hit = blockedHost(host, blocklist);
    if (hit) return `research: ${host} is on the domain blocklist (${hit})`;
  }
  return null;
}

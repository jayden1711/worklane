// WHY: which plugins an instance's agents may load is a root decision (src/policy-edit.ts: allowlists are never the
// dashboard's alone). The dashboard can preview and STAGE an approval; only a root admin, at a root shell, confirms
// one (scripts/setup/plugins.sh confirm), after the exact record is printed and its id typed back. The same pattern
// as release signers and Claude profiles.
//
// Where things live, all root's:
//   /etc/<cli>/plugins/<instance>.json                     the allowlist: confirmed entries only (0644, root)
//   /var/lib/<cli>/plugins/pending.json                    staged approvals: trusted for nothing (0644, root)
//   /var/lib/<cli>/plugins/previews/<instance>/<id>/       a fetched, inspected, materialized preview (root)
//   /var/lib/<cli>/plugins/store/<instance>/<id>/<hash>/   approved plugin directories, read-only to everyone else
//   /var/lib/<cli>/plugins/store/<instance>/.empty-root    an empty plugins root for agent runs (0555)
//
// An approval record is canonical JSON (keys sorted, no whitespace); its digest is sha256 of that. The digest the
// owner reviews on the dashboard, the one staged, and the one the root admin types are the same value, so what is
// confirmed is exactly what was reviewed: a change to any field (a file, a role, the source) is a different digest.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readRegularFile } from '../os/index.js';
import { etcPath, varLibPath } from '../os/system-paths.js';
import { TREE_PREFIX } from './tree.js';

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ROLE = /^[a-z][a-z0-9-]{0,30}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TREE = new RegExp(`^${TREE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{64}$`);
const INSTANCE = /^[a-z][a-z0-9-]{0,20}$/;

/** At most this many staged approvals per instance, each dropped this long after it was staged. */
export const PENDING_MAX_PER_INSTANCE = 4;
export const PENDING_TTL_MS = 24 * 60 * 60_000;
/** At most this many fetches per instance per hour (Q13: an owner may stage, rate-capped). */
export const FETCHES_PER_HOUR = 10;

export const allowlistPath = (instance: string) => etcPath(`plugins/${instance}.json`);
export const pendingPath = () => varLibPath('plugins/pending.json');
export const fetchLogPath = () => varLibPath('plugins/fetches.jsonl');
export const previewDir = (instance: string, id: string) => varLibPath(`plugins/previews/${instance}/${id}`);
export const storeDir = (instance: string, id: string, tree: string) => varLibPath(`plugins/store/${instance}/${id}/${tree.slice(TREE_PREFIX.length)}`);
export const emptyPluginRoot = (instance: string) => varLibPath(`plugins/store/${instance}/.empty-root`);
/** Where the broker keeps an instance's MCP secrets: one 0700 directory per server in the broker user's home. */
export const mcpSecretsDir = (brokerHome: string, id: string) => `${brokerHome.replace(/\/$/, '')}/secrets/${id}`;

const Source = z.strictObject({ type: z.literal('git'), url: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/), path: z.string().optional() });
const McpSpec = z.strictObject({ name: z.string(), argv: z.array(z.string()), envNames: z.array(z.string()), from: z.string() });

/** A plugin's approval. Every field is part of the digest. */
export const PluginRecord = z.strictObject({
  v: z.literal(1),
  kind: z.literal('plugin'),
  instance: z.string().regex(INSTANCE),
  id: z.string().regex(PLUGIN_ID),
  source: Source,
  name: z.string().nullable(),
  version: z.string().nullable(),
  /** wl-tree-v1 of the plugin as fetched, and of the approved copy (after the transform). */
  fetchedTree: z.string().regex(TREE),
  tree: z.string().regex(TREE),
  transform: z.array(z.string()),
  components: z.strictObject({ skills: z.array(z.string()), agents: z.array(z.string()), commands: z.array(z.string()), outputStyles: z.array(z.string()), bin: z.array(z.string()) }),
  /** The plugin's MCP servers: never started by Claude Code; each runs only once approved as an MCP server itself. */
  mcpServers: z.array(McpSpec),
  options: z.array(z.string()),
  flags: z.array(z.string()),
  /** The agent roles that get the plugin. */
  roles: z.array(z.string().regex(ROLE)).min(1),
});
export type PluginRecord = z.infer<typeof PluginRecord>;

/** A host an MCP server may reach (its sandbox's egress allowlist): a DNS name, optionally one *. label first. */
export const HOST = /^(\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A secret's name: the environment variable the broker sets for that one server. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

const SnapshotTool = z.strictObject({ name: z.string(), title: z.string().optional(), description: z.string().optional(), inputSchema: z.unknown(), outputSchema: z.unknown().optional(), annotations: z.unknown().optional() });
export const SnapshotSchema = z.strictObject({ serverName: z.string().nullable(), instructions: z.string().nullable(), tools: z.array(SnapshotTool) });

/** How an approved MCP server starts: a server inside an approved plugin, or a pinned npm package. */
export const McpRuntime = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('plugin'), plugin: z.string().regex(PLUGIN_ID), tree: z.string().regex(TREE), server: z.string(), argv: z.array(z.string()).min(1) }),
  z.strictObject({ type: z.literal('npm'), package: z.string(), version: z.string(), integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/), lockfile: z.string().regex(/^sha256:[0-9a-f]{64}$/), tree: z.string().regex(TREE), argv: z.array(z.string()).min(1) }),
]);
export type McpRuntime = z.infer<typeof McpRuntime>;

/**
 * An MCP server's approval: how it starts, what it may reach, and what it shows the model. The broker runs it (never
 * Claude Code), with its secrets in its own environment only, and serves the approved snapshot, never the live list.
 * snapshot null: approved code whose tools couldn't be listed without its secrets (Q3); it serves nothing until a
 * second approval adds the snapshot taken with them.
 */
export const McpRecord = z.strictObject({
  v: z.literal(1),
  kind: z.literal('mcp'),
  instance: z.string().regex(INSTANCE),
  id: z.string().regex(PLUGIN_ID),
  runtime: McpRuntime,
  secrets: z.array(z.string().regex(SECRET_NAME)),
  network: z.array(z.string().regex(HOST)),
  snapshot: SnapshotSchema.nullable(),
  snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  /** Whether the snapshot was taken with the server's secrets and network (the second approval). */
  snapshotWithSecrets: z.boolean(),
  flags: z.array(z.string()),
  /** The agent roles that get every approved tool of this server (Q6: the role grant decides). */
  roles: z.array(z.string().regex(ROLE)).min(1),
});
export type McpRecord = z.infer<typeof McpRecord>;

/** What one approval covers. Every field is part of the digest. */
export const ApprovalRecord = z.discriminatedUnion('kind', [PluginRecord, McpRecord]);
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

export const AllowlistEntry = z.strictObject({ record: ApprovalRecord, digest: z.string().regex(DIGEST), staged_at: z.string(), staged_by: z.string(), confirmed_at: z.string() });
export type AllowlistEntry = z.infer<typeof AllowlistEntry>;
export const Allowlist = z.strictObject({ version: z.literal(1), instance: z.string().regex(INSTANCE), entries: z.array(AllowlistEntry) });
export type Allowlist = z.infer<typeof Allowlist>;

export const PendingEntry = z.strictObject({
  instance: z.string().regex(INSTANCE),
  id: z.string().regex(PLUGIN_ID),
  roles: z.array(z.string().regex(ROLE)).min(1),
  /** An MCP server's egress hosts and secret names, as the owner staged them (part of its record, so of the digest). */
  network: z.array(z.string().regex(HOST)).optional(),
  secrets: z.array(z.string().regex(SECRET_NAME)).optional(),
  digest: z.string().regex(DIGEST),
  staged_at: z.string(),
  staged_by: z.string(),
});
export type PendingEntry = z.infer<typeof PendingEntry>;
export const Pending = z.strictObject({ version: z.literal(1), entries: z.array(PendingEntry) });

/** JSON with every object's keys sorted and no whitespace: one text per value. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** The digest of an approval record: what is reviewed, staged and confirmed. */
export function approvalDigest(r: ApprovalRecord): string {
  return `sha256:${createHash('sha256').update(canonicalJson(ApprovalRecord.parse(r)), 'utf8').digest('hex')}`;
}

/** Roles from the helper's `role+role` form, sorted and unique; null when any isn't a role name. */
export function parseRoles(s: string): string[] | null {
  const roles = s.split('+');
  return roles.length && roles.every((r) => ROLE.test(r)) ? [...new Set(roles)].sort() : null;
}

export class AllowlistError extends Error {}

/**
 * An instance's allowlist. No file: no plugins (an empty list). Anything else wrong with it (not root's, writable by
 * its group or others, a symlink, not JSON, not the schema, another instance's) is an error, never "no plugins" and
 * never "whatever it says": a run that would load plugins refuses to start.
 */
export function readAllowlist(instance: string, o: { file?: string; ownerUid?: number } = {}): Allowlist {
  const file = o.file ?? allowlistPath(instance);
  const f = readRegularFile(file, 4 * 1024 * 1024);
  if (f.kind === 'missing') return { version: 1, instance, entries: [] };
  if (f.kind !== 'file') throw new AllowlistError(`${file}: ${f.kind === 'too-big' ? 'too big' : f.kind === 'hidden' ? "can't be read" : f.kind}`);
  if (f.uid !== (o.ownerUid ?? 0)) throw new AllowlistError(`${file} isn't root's`);
  if (Number.parseInt(f.mode, 8) & 0o022) throw new AllowlistError(`${file} is writable by its group or others (mode ${f.mode})`);
  let raw: unknown;
  try {
    raw = JSON.parse(f.text);
  } catch {
    throw new AllowlistError(`${file}: not JSON`);
  }
  const r = Allowlist.safeParse(raw);
  if (!r.success) throw new AllowlistError(`${file}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (r.data.instance !== instance) throw new AllowlistError(`${file} is for instance ${r.data.instance}, not ${instance}`);
  for (const e of r.data.entries) {
    if (e.record.instance !== instance) throw new AllowlistError(`${file}: entry ${e.record.id} is for instance ${e.record.instance}`);
    if (approvalDigest(e.record) !== e.digest) throw new AllowlistError(`${file}: entry ${e.record.id}'s digest doesn't match its record`);
  }
  const ids = r.data.entries.map((e) => e.record.id);
  if (new Set(ids).size !== ids.length) throw new AllowlistError(`${file}: an id appears twice`);
  return r.data;
}

/** The pending list with expired entries dropped. A missing or unreadable file is an empty list (it grants nothing). */
export function livePending(raw: unknown, now = Date.now()): PendingEntry[] {
  const r = Pending.safeParse(raw);
  if (!r.success) return [];
  return r.data.entries.filter((e) => {
    const t = Date.parse(e.staged_at);
    return Number.isFinite(t) && now - t < PENDING_TTL_MS && t <= now + 60_000;
  });
}

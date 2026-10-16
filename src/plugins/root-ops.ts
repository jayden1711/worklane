// WHY: the root side of plugin and MCP server approvals, one function per step, each checking everything it is handed
// again (the helper's arguments, the files a throwaway user fetched, a coordinator's staged digest). Only these write
// the allowlist and the store; scripts/setup/plugins.sh and the machine helper call them through `<cli> plugins ...`
// as root. INVARIANT: nothing here adds or changes an allowlist entry except confirm(), which only an admin at a root
// shell runs (the helper has no confirm, and plugins.sh confirm refuses a coordinator's sudo); remove() only deletes.
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { materialize } from './fetch.js';
import { inspectPlugin, type Inspection, type McpServerSpec } from './inspect.js';
import { treeFiles, treeHash, treeHashOf, type TreeLimits } from './tree.js';
import {
  type Allowlist, allowlistPath, approvalDigest, type ApprovalRecord, canonicalJson, DIGEST, emptyPluginRoot, FETCHES_PER_HOUR, SNAPSHOTS_PER_HOUR, fetchLogPath, HOST, livePending,
  type McpRecord, type McpRuntime, type PendingEntry, pendingPath, PENDING_MAX_PER_INSTANCE, PLUGIN_ID, type PluginRecord, previewDir, readAllowlist, ROLE, SECRET_NAME, storeDir,
} from './approval.js';
import { varLibPath } from '../os/system-paths.js';
import { snapshotFlags, snapshotHash, type Snapshot } from '../mcp/snapshot.js';
import { unenforced } from '../mcp/schema.js';

export class PluginOpError extends Error {}

/** Limits for an npm MCP server's tree (its node_modules): larger than a plugin's. */
export const NPM_TREE_LIMITS: TreeLimits = { maxFiles: 20_000, maxBytes: 300 * 1024 * 1024 };

/** A plugin's preview: what the owner reviews before staging, written by root, readable by all. */
export interface PluginPreview {
  v: 1;
  kind: 'plugin';
  instance: string;
  id: string;
  source: PluginRecord['source'];
  fetched_at: string;
  inspection: Omit<Inspection, 'files'> & { files: { path: string; mode: string; size: number; sha256: string }[] };
  /** Set when the inspection passed: the approved copy's hash and the changes made to it. */
  materialized: { tree: string; transform: string[] } | null;
}

/** An MCP server's preview: how it starts, and what it showed the model when started in quarantine. */
export interface McpPreview {
  v: 1;
  kind: 'mcp';
  instance: string;
  id: string;
  runtime: McpRuntime;
  /** Env names its config sets (a plugin's server): what its secrets are likely to be called. */
  envNames: string[];
  fetched_at: string;
  snapshot: Snapshot | null;
  /** Why there is no snapshot (it couldn't list its tools without its secrets, say). */
  snapshotError: string | null;
  /** Taken with the server's installed secrets and approved network (the second approval), or with neither. */
  snapshotWithSecrets: boolean;
  /** The network the snapshot was taken with (none in quarantine). */
  snapshotNetwork: string[];
  flags: string[];
  /** Why it can't be approved at all, or empty. */
  refusals: string[];
}
export type Preview = PluginPreview | McpPreview;

/** Root's machine change log (the helper writes the same file). */
const changeLog = () => varLibPath('machine-changes.jsonl');
function logChange(by: string, what: string, to: unknown): void {
  mkdirSync(dirname(changeLog()), { recursive: true });
  appendFileSync(changeLog(), `${JSON.stringify({ at: new Date().toISOString(), by, what, from: null, to })}\n`, { mode: 0o644 });
}

/** Write a file as root keeps them: 0644, through a temp name and a rename. */
export function writePublic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, data, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
}

const check = (ok: boolean, why: string) => {
  if (!ok) throw new PluginOpError(why);
};
const checkIds = (instance: string, id: string) => {
  check(/^[a-z][a-z0-9-]{0,20}$/.test(instance), `instance ${JSON.stringify(instance)}: not an instance name`);
  check(PLUGIN_ID.test(id), `id ${JSON.stringify(id)}: lowercase letters, digits and dashes, at most 40`);
};
const sortedUnique = (l: string[]) => [...new Set(l)].sort();

/** What an MCP server stage adds to its record: the hosts it may reach and its secrets' names. */
export interface McpStageInputs {
  network: string[];
  secrets: string[];
}

/** The record a preview and the owner's choices make. Throws when the preview has nothing approvable. */
export function recordOf(p: Preview, roles: string[], mcp?: McpStageInputs): ApprovalRecord {
  check(roles.length > 0 && roles.every((r) => ROLE.test(r)), 'roles must be role names');
  if (p.kind === 'plugin') {
    check(!mcp, `${p.id} is a plugin: hosts and secrets belong to an MCP server's approval`);
    check(!!p.materialized && p.inspection.refusals.length === 0, `${p.id}: the preview has refusals, so it can't be approved`);
    const i = p.inspection;
    return {
      v: 1,
      kind: 'plugin',
      instance: p.instance,
      id: p.id,
      source: p.source,
      name: i.name,
      version: i.version,
      fetchedTree: i.tree!,
      tree: p.materialized!.tree,
      transform: p.materialized!.transform,
      components: { skills: i.skills, agents: i.agents, commands: i.commands, outputStyles: i.outputStyles, bin: i.bin },
      mcpServers: i.mcpServers,
      options: i.options,
      flags: i.flags,
      roles: sortedUnique(roles),
    };
  }
  check(p.refusals.length === 0, `${p.id}: the preview has refusals, so it can't be approved`);
  const m = mcp ?? { network: [], secrets: [] };
  check(m.network.every((h) => HOST.test(h)), 'network: host names only (one leading *. allowed)');
  check(m.secrets.every((s) => SECRET_NAME.test(s)), 'secrets: environment variable names (A-Z, 0-9, _)');
  // A snapshot taken with secrets used the network it was given: it is only valid for that same network.
  if (p.snapshotWithSecrets) check(canonicalJson(sortedUnique(m.network)) === canonicalJson(sortedUnique(p.snapshotNetwork)), `${p.id}: the snapshot was taken with network ${p.snapshotNetwork.join(', ') || 'none'}; approve the same hosts or take it again`);
  const record: McpRecord = {
    v: 1,
    kind: 'mcp',
    instance: p.instance,
    id: p.id,
    runtime: p.runtime,
    secrets: sortedUnique(m.secrets),
    network: sortedUnique(m.network),
    snapshot: p.snapshot,
    snapshotHash: p.snapshot ? snapshotHash(p.snapshot) : null,
    snapshotWithSecrets: p.snapshotWithSecrets,
    flags: p.flags,
    roles: sortedUnique(roles),
  };
  return record;
}

export function readPreview(instance: string, id: string): Preview {
  checkIds(instance, id);
  const f = join(previewDir(instance, id), 'preview.json');
  check(existsSync(f), `no preview of ${id} for ${instance}: fetch it first`);
  const p = JSON.parse(readFileSync(f, 'utf8')) as Preview;
  check(p.instance === instance && p.id === id, `${f} is not ${instance}'s ${id}`);
  // Previews written before MCP servers existed are plugin previews.
  if ((p as { kind?: string }).kind === undefined) (p as PluginPreview).kind = 'plugin';
  return p;
}

/**
 * Whether this instance may start another fetch, or another snapshot or preview, now (Q13 and the owner's condition on
 * mcp-preview and mcp-snapshot: each kind rate-capped per instance per hour), recording it when it may.
 */
export function takeFetchSlot(instance: string, kind: 'fetch' | 'snapshot' = 'fetch', now = Date.now()): void {
  const log = fetchLogPath();
  const recent = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { instance: string; at: string; kind?: string };
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.instance === instance && (e.kind ?? 'fetch') === kind && now - Date.parse(e.at) < 3_600_000).length
    : 0;
  const cap = kind === 'fetch' ? FETCHES_PER_HOUR : SNAPSHOTS_PER_HOUR;
  check(recent < cap, `${instance} has run ${recent} ${kind === 'fetch' ? 'fetches' : 'snapshots or previews'} in the last hour (at most ${cap}); try again later`);
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ at: new Date(now).toISOString(), instance, kind })}\n`, { mode: 0o644 });
}

/** Replace an id's preview directory with `next` (a sibling built beside it). */
function swapPreview(instance: string, id: string, next: string): void {
  const dir = previewDir(instance, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
  renameSync(next, dir);
}
const freshNext = (instance: string, id: string) => {
  const next = `${previewDir(instance, id)}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });
  return next;
};

/**
 * Root, after the throwaway user's fetch: inspect `from` (never executing it), and when it passes, materialize the
 * approved copy into the instance's preview directory, replacing any earlier preview of that id. `from` must already
 * be root's (plugins.sh chowns it, links untouched, before calling this).
 */
export function ingest(o: { instance: string; id: string; source: PluginRecord['source']; from: string; approvedIds?: Set<string> }): PluginPreview {
  checkIds(o.instance, o.id);
  const next = freshNext(o.instance, o.id);
  const approved = o.approvedIds ?? new Set(readAllowlist(o.instance).entries.flatMap((e) => (e.record.kind === 'plugin' ? [e.record.name ?? e.record.id] : [])));
  const ins = inspectPlugin(o.from, { approved });
  let materialized: PluginPreview['materialized'] = null;
  if (!ins.refusals.length) {
    const m = materialize(o.from, ins, join(next, 'tree'));
    materialized = { tree: m.tree, transform: m.transform };
  }
  const preview: PluginPreview = { v: 1, kind: 'plugin', instance: o.instance, id: o.id, source: o.source, fetched_at: new Date().toISOString(), inspection: ins, materialized };
  writePublic(join(next, 'preview.json'), JSON.stringify(preview, null, 2) + '\n');
  swapPreview(o.instance, o.id, next);
  return preview;
}

/** Flags for a snapshot: what its text asks for, and the schema keywords the broker can't enforce. */
export function mcpFlags(s: Snapshot | null, otherTools: string[] = []): string[] {
  if (!s) return [];
  return [...snapshotFlags(s, otherTools), ...s.tools.flatMap((t) => unenforced(t.inputSchema).map((k) => `tool ${t.name} schema: ${k} is served as approved but not enforced by the broker`))];
}

/** The code an MCP server runs, where it is approved: its plugin's copy in the store, or its own npm tree. */
export function mcpCodeDir(instance: string, id: string, runtime: McpRuntime): string {
  return runtime.type === 'plugin' ? storeDir(instance, runtime.plugin, runtime.tree) : storeDir(instance, id, runtime.tree);
}

/**
 * Root: an MCP server preview for a server inside an approved plugin. Its code is that plugin's approved copy (no
 * fetch); `snapshot` is what it showed when started in quarantine (src/mcp/quarantine.ts), or why it couldn't.
 */
export function previewPluginServer(o: { instance: string; id: string; plugin: string; server: string; snapshot: { snapshot: Snapshot | null; error: string | null; withSecrets: boolean; network: string[] }; allowlistOwnerUid?: number }): McpPreview {
  checkIds(o.instance, o.id);
  const entry = readAllowlist(o.instance, o.allowlistOwnerUid === undefined ? {} : { ownerUid: o.allowlistOwnerUid }).entries.find((e) => e.record.kind === 'plugin' && e.record.id === o.plugin);
  check(!!entry, `plugin ${o.plugin} is not approved for ${o.instance}`);
  const rec = entry!.record as PluginRecord;
  const spec = rec.mcpServers.find((s) => s.name === o.server);
  check(!!spec, `plugin ${o.plugin} has no MCP server ${o.server}`);
  const p: McpPreview = {
    v: 1,
    kind: 'mcp',
    instance: o.instance,
    id: o.id,
    runtime: { type: 'plugin', plugin: o.plugin, tree: rec.tree, server: o.server, argv: spec!.argv },
    envNames: spec!.envNames,
    fetched_at: new Date().toISOString(),
    snapshot: o.snapshot.snapshot,
    snapshotError: o.snapshot.error,
    snapshotWithSecrets: o.snapshot.withSecrets,
    snapshotNetwork: sortedUnique(o.snapshot.network),
    flags: mcpFlags(o.snapshot.snapshot),
    refusals: [],
  };
  const next = freshNext(o.instance, o.id);
  writePublic(join(next, 'preview.json'), JSON.stringify(p, null, 2) + '\n');
  swapPreview(o.instance, o.id, next);
  return p;
}

/**
 * Root: an MCP server preview for a pinned npm package the throwaway user installed at `from` (src/mcp/npm.ts checked
 * its integrity and install scripts there). Its tree is copied into the preview, root's.
 */
export function previewNpmServer(o: { instance: string; id: string; from: string; runtime: Omit<Extract<McpRuntime, { type: 'npm' }>, 'tree'>; refusals: string[]; snapshot: { snapshot: Snapshot | null; error: string | null; withSecrets: boolean; network: string[] } }): McpPreview {
  checkIds(o.instance, o.id);
  const next = freshNext(o.instance, o.id);
  let tree = `${'wl-tree-v1:sha256:'}${'0'.repeat(64)}`;
  const refusals = [...o.refusals];
  if (!refusals.length) {
    try {
      const files = treeFiles(o.from, NPM_TREE_LIMITS);
      for (const f of files) {
        const to = join(next, 'tree', ...f.path.split('/'));
        mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
        copyFileSync(join(o.from, ...f.path.split('/')), to);
        chmodSync(to, f.mode === '755' ? 0o755 : 0o644);
      }
      tree = treeHashOf(treeFiles(join(next, 'tree'), NPM_TREE_LIMITS));
    } catch (e) {
      refusals.push(`files: ${(e as Error).message}`);
    }
  }
  const p: McpPreview = {
    v: 1,
    kind: 'mcp',
    instance: o.instance,
    id: o.id,
    runtime: { ...o.runtime, tree },
    envNames: [],
    fetched_at: new Date().toISOString(),
    snapshot: o.snapshot.snapshot,
    snapshotError: o.snapshot.error,
    snapshotWithSecrets: o.snapshot.withSecrets,
    snapshotNetwork: sortedUnique(o.snapshot.network),
    flags: mcpFlags(o.snapshot.snapshot),
    refusals,
  };
  writePublic(join(next, 'preview.json'), JSON.stringify(p, null, 2) + '\n');
  swapPreview(o.instance, o.id, next);
  return p;
}

/** Root: record a snapshot (or why there is none) in an MCP server's preview. */
export function setPreviewSnapshot(instance: string, id: string, snap: { snapshot: Snapshot | null; error: string | null; withSecrets: boolean; network: string[] }): McpPreview {
  const p = readPreview(instance, id);
  check(p.kind === 'mcp', `${id} is not an MCP server preview`);
  const next: McpPreview = { ...(p as McpPreview), snapshot: snap.snapshot, snapshotError: snap.error, snapshotWithSecrets: snap.withSecrets, snapshotNetwork: sortedUnique(snap.network), flags: mcpFlags(snap.snapshot) };
  writePublic(join(previewDir(instance, id), 'preview.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** The previewed code of an MCP server: its npm tree in the preview, or its plugin's approved copy. */
export const previewCodeDir = (p: McpPreview) => (p.runtime.type === 'npm' ? join(previewDir(p.instance, p.id), 'tree') : mcpCodeDir(p.instance, p.id, p.runtime));

function readPendingFile(now = Date.now()): PendingEntry[] {
  const f = pendingPath();
  if (!existsSync(f)) return [];
  try {
    return livePending(JSON.parse(readFileSync(f, 'utf8')), now);
  } catch {
    return [];
  }
}
const writePendingFile = (entries: PendingEntry[]) => writePublic(pendingPath(), JSON.stringify({ version: 1, entries }, null, 2) + '\n');
const mcpInputsOf = (e: { network?: string[] | undefined; secrets?: string[] | undefined }): McpStageInputs | undefined => (e.network || e.secrets ? { network: e.network ?? [], secrets: e.secrets ?? [] } : undefined);

/**
 * Stage an approval (the helper's plugin-stage or mcp-stage, for the asking coordinator's instance): only when the
 * digest is the one the preview and these choices make now, so what is staged is what the owner reviewed. Grants nothing.
 */
export function stage(o: { instance: string; id: string; roles: string[]; digest: string; by: string; mcp?: McpStageInputs; now?: number }): PendingEntry {
  checkIds(o.instance, o.id);
  check(DIGEST.test(o.digest), 'the digest must be sha256:<64 hex>');
  const preview = readPreview(o.instance, o.id);
  const want = approvalDigest(recordOf(preview, o.roles, o.mcp));
  check(want === o.digest, `${o.id}: the preview or the choices changed since the review (now ${want}); review it again`);
  const now = o.now ?? Date.now();
  const rest = readPendingFile(now).filter((e) => !(e.instance === o.instance && e.id === o.id));
  check(rest.filter((e) => e.instance === o.instance).length < PENDING_MAX_PER_INSTANCE, `${o.instance} already has ${PENDING_MAX_PER_INSTANCE} approvals waiting; confirm or withdraw one first`);
  const entry: PendingEntry = {
    instance: o.instance,
    id: o.id,
    roles: sortedUnique(o.roles),
    ...(o.mcp ? { network: sortedUnique(o.mcp.network), secrets: sortedUnique(o.mcp.secrets) } : {}),
    digest: o.digest,
    staged_at: new Date(now).toISOString(),
    staged_by: o.by,
  };
  writePendingFile([...rest, entry]);
  logChange(o.by, `plugins.${o.instance}.staged`, { id: o.id, kind: preview.kind, digest: o.digest, roles: entry.roles });
  return entry;
}

/** Take a staged approval back out (the helper's plugin-withdraw). */
export function withdraw(o: { instance: string; id: string; by: string }): boolean {
  checkIds(o.instance, o.id);
  const all = readPendingFile();
  const rest = all.filter((e) => !(e.instance === o.instance && e.id === o.id));
  if (rest.length === all.length) return false;
  writePendingFile(rest);
  logChange(o.by, `plugins.${o.instance}.withdrawn`, { id: o.id });
  return true;
}

/** The previewed tree an approval copies into the store, when it has one (a plugin's, or an npm server's). */
const previewTree = (instance: string, id: string, r: ApprovalRecord): { dir: string; tree: string; limits?: TreeLimits } | null =>
  r.kind === 'plugin' ? { dir: join(previewDir(instance, id), 'tree'), tree: r.tree } : r.runtime.type === 'npm' ? { dir: join(previewDir(instance, id), 'tree'), tree: r.runtime.tree, limits: NPM_TREE_LIMITS } : null;

/** What confirm will write, for the admin to read before typing the id back. Throws when it can't be confirmed. */
export function confirmPlan(o: { instance: string; id: string; digest: string; allowlistOwnerUid?: number }): { record: ApprovalRecord; pending: PendingEntry } {
  checkIds(o.instance, o.id);
  check(DIGEST.test(o.digest), 'the digest must be sha256:<64 hex>');
  const pending = readPendingFile().find((e) => e.instance === o.instance && e.id === o.id);
  check(!!pending, `nothing staged for ${o.instance}'s ${o.id} (staged approvals lapse after 24 hours)`);
  check(pending!.digest === o.digest, `the staged approval of ${o.id} is ${pending!.digest}, not ${o.digest}: nothing confirmed`);
  const record = recordOf(readPreview(o.instance, o.id), pending!.roles, mcpInputsOf(pending!));
  check(approvalDigest(record) === o.digest, `${o.id}'s preview changed after it was staged: nothing confirmed`);
  const t = previewTree(o.instance, o.id, record);
  if (t) check(treeHash(t.dir, t.limits) === t.tree, `${o.id}'s previewed files changed after inspection: nothing confirmed`);
  if (record.kind === 'mcp' && record.runtime.type === 'plugin') {
    const rt = record.runtime;
    const plugin = readAllowlist(o.instance, o.allowlistOwnerUid === undefined ? {} : { ownerUid: o.allowlistOwnerUid }).entries.find((e) => e.record.kind === 'plugin' && e.record.id === rt.plugin);
    check(!!plugin && (plugin.record as PluginRecord).tree === rt.tree, `${o.id} runs plugin ${rt.plugin} at ${rt.tree}, which is no longer the approved copy: preview it again`);
  }
  return { record, pending: pending! };
}

/**
 * Confirm a staged approval: root only (plugins.sh confirm, at a root shell, after the id was typed back). Copies the
 * previewed files into the store, checks their hash there, and writes the allowlist entry (replacing an earlier pin
 * of the same id: an update is a new approval).
 */
export function confirm(o: { instance: string; id: string; digest: string; by: string; allowlistOwnerUid?: number }): Allowlist {
  const { record, pending } = confirmPlan(o);
  const t = previewTree(o.instance, o.id, record);
  if (t) {
    const dest = storeDir(o.instance, o.id, t.tree);
    const ok = (() => {
      try {
        return existsSync(dest) && treeHash(dest, t.limits) === t.tree;
      } catch {
        return false;
      }
    })();
    if (!ok) {
      const tmp = `${dest}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      for (const f of treeFiles(t.dir, t.limits)) {
        const to = join(tmp, ...f.path.split('/'));
        mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
        copyFileSync(join(t.dir, ...f.path.split('/')), to);
        chmodSync(to, f.mode === '755' ? 0o755 : 0o644);
      }
      check(treeHashOf(treeFiles(tmp, t.limits)) === t.tree, `the copy of ${o.id} in the store doesn't hash to ${t.tree}: nothing confirmed`);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
      renameSync(tmp, dest);
    }
  }
  const empty = emptyPluginRoot(o.instance);
  mkdirSync(empty, { recursive: true });
  chmodSync(empty, 0o555);
  const current = readAllowlist(o.instance, o.allowlistOwnerUid === undefined ? {} : { ownerUid: o.allowlistOwnerUid });
  const next: Allowlist = {
    version: 1,
    instance: o.instance,
    entries: [...current.entries.filter((e) => e.record.id !== o.id), { record, digest: o.digest, staged_at: pending.staged_at, staged_by: pending.staged_by, confirmed_at: new Date().toISOString() }].sort((a, b) => a.record.id.localeCompare(b.record.id)),
  };
  writePublic(allowlistPath(o.instance), JSON.stringify(next, null, 2) + '\n');
  writePendingFile(readPendingFile().filter((e) => !(e.instance === o.instance && e.id === o.id)));
  logChange(o.by, `plugins.${o.instance}.confirmed`, { id: o.id, kind: record.kind, digest: o.digest, ...(record.kind === 'plugin' ? { tree: record.tree, source: record.source } : { runtime: record.runtime.type, snapshot: record.snapshotHash }) });
  return next;
}

/** Remove an approved entry (the helper's plugin-remove): only ever deletes. Its store copy stays for runs in flight. */
export function remove(o: { instance: string; id: string; by: string; allowlistOwnerUid?: number }): boolean {
  checkIds(o.instance, o.id);
  const current = readAllowlist(o.instance, o.allowlistOwnerUid === undefined ? {} : { ownerUid: o.allowlistOwnerUid });
  const entries = current.entries.filter((e) => e.record.id !== o.id);
  if (entries.length === current.entries.length) return false;
  writePublic(allowlistPath(o.instance), JSON.stringify({ ...current, entries }, null, 2) + '\n');
  logChange(o.by, `plugins.${o.instance}.removed`, { id: o.id });
  return true;
}

/** The record printed for the admin before they type the id back: every field, one per line. */
export function describeRecord(r: ApprovalRecord, digest: string): string {
  if (r.kind === 'mcp') {
    const rt = r.runtime.type === 'plugin' ? `plugin ${r.runtime.plugin}'s server "${r.runtime.server}" (${r.runtime.tree})` : `npm ${r.runtime.package}@${r.runtime.version} (${r.runtime.integrity}, files ${r.runtime.tree})`;
    return [
      `instance:   ${r.instance}`,
      `MCP server: ${r.id}`,
      `runs:       ${rt}`,
      `command:    ${r.runtime.argv.join(' ')}`,
      `secrets:    ${r.secrets.join(', ') || '-'} (names only; values stay in the broker user's files)`,
      `network:    ${r.network.join(', ') || 'none'}`,
      `roles:      ${r.roles.join(', ')}`,
      r.snapshot ? `tools:      ${r.snapshot.tools.map((t) => t.name).join(', ') || '-'} (snapshot ${r.snapshotHash}${r.snapshotWithSecrets ? ', taken with its secrets' : ', taken in quarantine'})` : 'tools:      none yet: no snapshot; it serves nothing until a second approval adds one',
      ...r.flags.map((f) => `note:       ${f}`),
      `digest:     ${digest}`,
    ].join('\n');
  }
  const src = `${r.source.url}${r.source.path ? ` (${r.source.path})` : ''} at ${r.source.sha}`;
  return [
    `instance:   ${r.instance}`,
    `plugin id:  ${r.id}${r.name ? ` (${r.name}${r.version ? ` ${r.version}` : ''})` : ''}`,
    `source:     ${src}`,
    `files:      ${r.tree}`,
    `roles:      ${r.roles.join(', ')}`,
    `skills:     ${r.components.skills.join(', ') || '-'}`,
    `agents:     ${r.components.agents.join(', ') || '-'}`,
    `commands:   ${r.components.commands.join(', ') || '-'}`,
    `bin:        ${r.components.bin.join(', ') || '-'}`,
    `MCP:        ${r.mcpServers.map((s: McpServerSpec) => `${s.name} (not started until approved as an MCP server)`).join(', ') || '-'}`,
    ...r.transform.map((t) => `changed:    ${t}`),
    ...r.flags.map((f) => `note:       ${f}`),
    `digest:     ${digest}`,
  ].join('\n');
}

export { canonicalJson };

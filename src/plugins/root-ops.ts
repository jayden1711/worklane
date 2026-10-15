// WHY: the root side of plugin approvals, one function per step, each checking everything it is handed again
// (the helper's arguments, the files a throwaway user fetched, a coordinator's staged digest). Only these write the
// allowlist and the store; scripts/setup/plugins.sh and the machine helper call them through `<cli> plugins ...` as
// root. INVARIANT: nothing here adds or changes an allowlist entry except confirm(), which only an admin at a root
// shell runs (the helper has no confirm, and plugins.sh confirm refuses a coordinator's sudo); remove() only deletes.
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { materialize } from './fetch.js';
import { inspectPlugin, type Inspection } from './inspect.js';
import { treeFiles, treeHash, treeHashOf } from './tree.js';
import {
  type Allowlist, allowlistPath, approvalDigest, type ApprovalRecord, canonicalJson, DIGEST, emptyPluginRoot, FETCHES_PER_HOUR, fetchLogPath, livePending,
  type PendingEntry, pendingPath, PENDING_MAX_PER_INSTANCE, PLUGIN_ID, previewDir, readAllowlist, ROLE, storeDir,
} from './approval.js';
import { varLibPath } from '../os/system-paths.js';

export class PluginOpError extends Error {}

/** The preview a fetch leaves: what the owner reviews before staging, written by root, readable by all. */
export interface Preview {
  v: 1;
  instance: string;
  id: string;
  source: ApprovalRecord['source'];
  fetched_at: string;
  inspection: Omit<Inspection, 'files'> & { files: { path: string; mode: string; size: number; sha256: string }[] };
  /** Set when the inspection passed: the approved copy's hash and the changes made to it. */
  materialized: { tree: string; transform: string[] } | null;
}

/** Root's machine change log (the helper writes the same file). */
const changeLog = () => varLibPath('machine-changes.jsonl');
function logChange(by: string, what: string, to: unknown): void {
  mkdirSync(dirname(changeLog()), { recursive: true });
  appendFileSync(changeLog(), `${JSON.stringify({ at: new Date().toISOString(), by, what, from: null, to })}\n`, { mode: 0o644 });
}

/** Write a file as root keeps them: 0644, through a temp name and a rename. */
function writePublic(file: string, data: string): void {
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
  check(PLUGIN_ID.test(id), `plugin id ${JSON.stringify(id)}: lowercase letters, digits and dashes, at most 40`);
};

/** The record a preview and a set of roles make. Throws when the preview has no approvable copy. */
export function recordOf(p: Preview, roles: string[]): ApprovalRecord {
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
    roles: [...new Set(roles)].sort(),
  };
}

export function readPreview(instance: string, id: string): Preview {
  checkIds(instance, id);
  const f = join(previewDir(instance, id), 'preview.json');
  check(existsSync(f), `no preview of ${id} for ${instance}: fetch it first`);
  const p = JSON.parse(readFileSync(f, 'utf8')) as Preview;
  check(p.instance === instance && p.id === id, `${f} is not ${instance}'s ${id}`);
  return p;
}

/** Whether this instance may start another fetch now (Q13: rate-capped), and records it when it may. */
export function takeFetchSlot(instance: string, now = Date.now()): void {
  const log = fetchLogPath();
  const recent = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as { instance: string; at: string };
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.instance === instance && now - Date.parse(e.at) < 3_600_000).length
    : 0;
  check(recent < FETCHES_PER_HOUR, `${instance} has fetched ${recent} plugins in the last hour (at most ${FETCHES_PER_HOUR}); try again later`);
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ at: new Date(now).toISOString(), instance })}\n`, { mode: 0o644 });
}

/**
 * Root, after the throwaway user's fetch: inspect `from` (never executing it), and when it passes, materialize the
 * approved copy into the instance's preview directory, replacing any earlier preview of that id. `from` must already
 * be root's (plugins.sh chowns it, links untouched, before calling this).
 */
export function ingest(o: { instance: string; id: string; source: ApprovalRecord['source']; from: string; approvedIds?: Set<string> }): Preview {
  checkIds(o.instance, o.id);
  const dir = previewDir(o.instance, o.id);
  const next = `${dir}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });
  const approved = o.approvedIds ?? new Set(readAllowlist(o.instance).entries.map((e) => e.record.name ?? e.record.id));
  const ins = inspectPlugin(o.from, { approved });
  let materialized: Preview['materialized'] = null;
  if (!ins.refusals.length) {
    const m = materialize(o.from, ins, join(next, 'tree'));
    materialized = { tree: m.tree, transform: m.transform };
  }
  const preview: Preview = { v: 1, instance: o.instance, id: o.id, source: o.source, fetched_at: new Date().toISOString(), inspection: ins, materialized };
  writePublic(join(next, 'preview.json'), JSON.stringify(preview, null, 2) + '\n');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
  renameSync(next, dir);
  return preview;
}

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

/**
 * Stage an approval (the helper's plugin-stage, for the asking coordinator's instance): only when the digest is the
 * one the preview and these roles make now, so what is staged is what the owner reviewed. Grants nothing.
 */
export function stage(o: { instance: string; id: string; roles: string[]; digest: string; by: string; now?: number }): PendingEntry {
  checkIds(o.instance, o.id);
  check(DIGEST.test(o.digest), 'the digest must be sha256:<64 hex>');
  check(o.roles.length > 0 && o.roles.every((r) => ROLE.test(r)), 'roles must be role names');
  const want = approvalDigest(recordOf(readPreview(o.instance, o.id), o.roles));
  check(want === o.digest, `${o.id}: the preview or the roles changed since the review (now ${want}); review it again`);
  const now = o.now ?? Date.now();
  const rest = readPendingFile(now).filter((e) => !(e.instance === o.instance && e.id === o.id));
  check(rest.filter((e) => e.instance === o.instance).length < PENDING_MAX_PER_INSTANCE, `${o.instance} already has ${PENDING_MAX_PER_INSTANCE} approvals waiting; confirm or withdraw one first`);
  const entry: PendingEntry = { instance: o.instance, id: o.id, roles: [...new Set(o.roles)].sort(), digest: o.digest, staged_at: new Date(now).toISOString(), staged_by: o.by };
  writePendingFile([...rest, entry]);
  logChange(o.by, `plugins.${o.instance}.staged`, { id: o.id, digest: o.digest, roles: entry.roles });
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

/** What confirm will write, for the admin to read before typing the id back. Throws when it can't be confirmed. */
export function confirmPlan(o: { instance: string; id: string; digest: string }): { record: ApprovalRecord; pending: PendingEntry } {
  checkIds(o.instance, o.id);
  check(DIGEST.test(o.digest), 'the digest must be sha256:<64 hex>');
  const pending = readPendingFile().find((e) => e.instance === o.instance && e.id === o.id);
  check(!!pending, `nothing staged for ${o.instance}'s ${o.id} (staged approvals lapse after 24 hours)`);
  check(pending!.digest === o.digest, `the staged approval of ${o.id} is ${pending!.digest}, not ${o.digest}: nothing confirmed`);
  const preview = readPreview(o.instance, o.id);
  const record = recordOf(preview, pending!.roles);
  check(approvalDigest(record) === o.digest, `${o.id}'s preview changed after it was staged: nothing confirmed`);
  check(treeHash(join(previewDir(o.instance, o.id), 'tree')) === record.tree, `${o.id}'s previewed files changed after inspection: nothing confirmed`);
  return { record, pending: pending! };
}

/**
 * Confirm a staged approval: root only (plugins.sh confirm, at a root shell, after the id was typed back). Copies the
 * previewed files into the store, checks their hash there, and writes the allowlist entry (replacing an earlier pin
 * of the same id: an update is a new approval).
 */
export function confirm(o: { instance: string; id: string; digest: string; by: string; allowlistOwnerUid?: number }): Allowlist {
  const { record, pending } = confirmPlan(o);
  const dest = storeDir(o.instance, o.id, record.tree);
  if (!existsSync(dest) || (() => { try { return treeHash(dest) !== record.tree; } catch { return true; } })()) {
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    const src = join(previewDir(o.instance, o.id), 'tree');
    for (const f of treeFiles(src)) {
      const to = join(tmp, ...f.path.split('/'));
      mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
      copyFileSync(join(src, ...f.path.split('/')), to);
      chmodSync(to, f.mode === '755' ? 0o755 : 0o644);
    }
    check(treeHashOf(treeFiles(tmp)) === record.tree, `the copy of ${o.id} in the store doesn't hash to ${record.tree}: nothing confirmed`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    renameSync(tmp, dest);
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
  logChange(o.by, `plugins.${o.instance}.confirmed`, { id: o.id, digest: o.digest, tree: record.tree, source: record.source });
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
    `MCP:        ${r.mcpServers.map((s) => `${s.name} (not started until approved as an MCP server)`).join(', ') || '-'}`,
    ...r.transform.map((t) => `changed:    ${t}`),
    ...r.flags.map((f) => `note:       ${f}`),
    `digest:     ${digest}`,
  ].join('\n');
}

export { canonicalJson };

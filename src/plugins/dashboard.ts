// The Plugins page's server side (web/src/pages/Extend.tsx): what each role sees, and the owner's actions, each a
// Review (nothing written) then a Confirm (exactly what was reviewed). Viewers get nothing (403). Writers get a
// read-only list built from a field allowlist (WRITER_FIELDS): names, versions, roles, what each can reach. Owners get
// everything: previews, staged approvals with the root command that confirms them, blocked servers and their diffs,
// and the audit. No action here approves anything: an owner previews and stages (machine requests the coordinator runs
// through the helper, src/plugins/steps.ts); a root admin confirms at a root shell (scripts/setup/plugins.sh confirm).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { EventLog } from '../events/log.js';
import { asRoot, varLibPath } from '../os/system-paths.js';
import { MachineRequestError, MACHINE_EVENTS, machineRequests, requestPluginStep } from '../machine-requests.js';
import { revealInvisible } from '../mcp/snapshot.js';
import { approvalDigest, readAllowlist, livePending, pendingPath, previewDir, type AllowlistEntry, type ApprovalRecord, type PendingEntry } from './approval.js';
import { readPreview, recordOf, type Preview } from './root-ops.js';
import { pluginsOff, PLUGINS_OFF_FILE } from './run.js';
import { pluginStepOk } from './steps.js';
import { cachedUpdates, previewDiff } from './updates.js';

type Role = 'owner' | 'writer' | 'viewer';
export interface PluginsWho {
  login: string;
  role: Role | null;
  breakGlass?: boolean;
}

/** One approved entry as a writer may see it: an allowlist of fields, so a field added later stays an owner's. */
export const WRITER_FIELDS = ['id', 'kind', 'label', 'roles', 'on', 'reach'] as const;
export interface WriterEntry {
  id: string;
  kind: 'plugin' | 'mcp';
  label: string;
  roles: string[];
  on: boolean;
  /** What it can reach, in words: skills, agents, commands, bin; hosts, secrets' names, tools. */
  reach: string[];
}

const labelOf = (r: ApprovalRecord) =>
  r.kind === 'plugin' ? `${r.name ?? r.id}${r.version ? ` ${r.version}` : ''} (${r.source.sha.slice(0, 7)})` : r.runtime.type === 'npm' ? `${r.runtime.package}@${r.runtime.version}` : `${r.runtime.plugin}'s server ${r.runtime.server}`;

/** What an approved entry can reach, for both roles' views. */
export function reachOf(r: ApprovalRecord): string[] {
  if (r.kind === 'plugin') {
    const c = r.components;
    return [
      ...(c.skills.length ? [`skills: ${c.skills.join(', ')}`] : []),
      ...(c.agents.length ? [`agents: ${c.agents.join(', ')}`] : []),
      ...(c.commands.length ? [`commands: ${c.commands.join(', ')}`] : []),
      ...(c.bin.length ? [`bin: ${c.bin.join(', ')}`] : []),
      'runs inside the agent sandbox; no secrets',
      ...(r.mcpServers.length ? [`MCP servers (each only once approved itself): ${r.mcpServers.map((s) => s.name).join(', ')}`] : []),
    ];
  }
  return [
    `network: ${r.network.join(', ') || 'none'}`,
    `secrets: ${r.secrets.join(', ') || 'none'} (names only)`,
    `tools: ${r.snapshot ? r.snapshot.tools.map((t) => t.name).join(', ') || 'none' : 'none until its snapshot is approved'}`,
    'runs in its own sandbox, through the broker',
  ];
}

const readJsonl = (f: string): Record<string, unknown>[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
    : [];

function previewsOf(instance: string): Preview[] {
  const dir = previewDir(instance, 'x').replace(/\/x$/, '');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(n))
    .flatMap((n) => {
      try {
        return [readPreview(instance, n)];
      } catch {
        return [];
      }
    });
}

/** Text the owner reads as the model would: escaped by the page, and with every invisible character made visible here. */
function visible(p: Preview): Preview {
  if (p.kind !== 'mcp' || !p.snapshot) return p;
  const s = p.snapshot;
  return { ...p, snapshot: { ...s, instructions: s.instructions === null ? null : revealInvisible(s.instructions), tools: s.tools.map((t) => ({ ...t, ...(t.description !== undefined ? { description: revealInvisible(t.description) } : {}) })) } };
}

export interface PluginsContext {
  instance: string | null;
  instanceHome: string | null;
  eventsDb: string;
  /** The broker's blocked servers (src/mcp/client.ts brokerStatus); null without a broker. */
  blocked: () => Promise<Record<string, unknown> | null>;
  /** The dashboard's own state (the cached update check). Unset: no update check. */
  stateDir?: string;
  /** Test seams. */
  allowlistOwnerUid?: number;
  fetchJson?: (url: string) => Promise<unknown>;
}

/** The page's data for this role: null for a viewer (who gets a 403). */
export async function pluginsView(ctx: PluginsContext, role: Role | null): Promise<Record<string, unknown> | null> {
  if (role !== 'owner' && role !== 'writer') return null;
  if (!ctx.instance || !ctx.instanceHome) return { available: false, why: 'plugins belong to a server instance: this dashboard serves a checkout' };
  let entries: AllowlistEntry[] = [];
  let problem: string | null = null;
  try {
    entries = readAllowlist(ctx.instance, ctx.allowlistOwnerUid === undefined ? {} : { ownerUid: ctx.allowlistOwnerUid }).entries;
  } catch (e) {
    problem = (e as Error).message;
  }
  const off = pluginsOff(ctx.instanceHome);
  const pending = (() => {
    try {
      return livePending(JSON.parse(readFileSync(pendingPath(), 'utf8'))).filter((e) => e.instance === ctx.instance);
    } catch {
      return [] as PendingEntry[];
    }
  })();
  const isOn = (id: string) => !off.all && !off.off.has(id);
  if (role === 'writer') {
    const list: WriterEntry[] = entries.map((e) => ({ id: e.record.id, kind: e.record.kind, label: labelOf(e.record), roles: e.record.roles, on: isOn(e.record.id), reach: reachOf(e.record) }));
    return { available: true, role, entries: list.map((x) => Object.fromEntries(WRITER_FIELDS.map((k) => [k, x[k]]))), waiting: pending.length, problem: problem ? 'the allowlist could not be read; agents get no plugins until it is fixed' : null };
  }
  const blocked = await ctx.blocked();
  const log = new EventLog(ctx.eventsDb);
  let requests: unknown[] = [];
  let audit: unknown[] = [];
  try {
    requests = machineRequests(log.read(0, [...MACHINE_EVENTS])).filter((r) => r.via === 'plugins').slice(-30);
    audit = log
      .read(0, ['dashboard.audit'])
      .filter((e) => String((e.payload as { action?: unknown }).action ?? '').startsWith('plugins.'))
      .slice(-100)
      .map((e) => ({ at: e.ts, ...(e.payload as object) }));
  } finally {
    log.close();
  }
  const root = readJsonl(varLibPath('machine-changes.jsonl')).filter((l) => String(l.what ?? '').startsWith(`plugins.${ctx.instance}.`)).slice(-100);
  const status = readJsonl(varLibPath(`plugins/fetch-status/${ctx.instance}.json`))[0] ?? null;
  return {
    available: true,
    role,
    instance: ctx.instance,
    problem,
    offProblem: off.problem,
    entries: entries.map((e) => ({ id: e.record.id, kind: e.record.kind, label: labelOf(e.record), on: isOn(e.record.id), reach: reachOf(e.record), digest: e.digest, confirmed_at: e.confirmed_at, staged_by: e.staged_by, record: e.record })),
    pending: pending.map((p) => ({ ...p, command: confirmCommand(ctx.instance!, p.id, p.digest) })),
    previews: previewsOf(ctx.instance).map((p) => ({ ...visible(p), diff: previewDiff(ctx.instance!, p, entries.find((e) => e.record.id === p.id)) })),
    updates: ctx.stateDir ? cachedUpdates(ctx.stateDir, entries, ctx.fetchJson ? { fetchJson: ctx.fetchJson } : {}) : { at: null, updates: [] },
    fetchStatus: status,
    blocked,
    requests,
    audit: [...audit, ...root.map((l) => ({ at: l.at, root: true, by: l.by, action: l.what, detail: l.to }))],
  };
}

/** The one command a root admin runs to confirm a staged approval (always the installed engine's script). */
export const confirmCommand = (instance: string, id: string, digest: string) => `sudo bash ${asRoot.opt('current/scripts/setup/plugins.sh')} confirm ${instance} ${id} ${digest}`;

/** What a toggle changes, in words, for the Review panel. */
function toggleChanges(e: AllowlistEntry, on: boolean): string[] {
  const what = reachOf(e.record).filter((x) => !/^runs /.test(x));
  return [`${on ? 'From the next run, roles' : 'From the next run, roles'} ${e.record.roles.join(', ')} ${on ? 'get' : 'lose'} ${e.record.id}: ${what.join('; ')}`];
}

type Json = (res: ServerResponse, status: number, body: unknown) => void;

/**
 * The Plugins routes. Returns false for any other path. GET /api/plugins for owners and writers; every POST is the
 * owner's (the dashboard checked CSRF before routing), refused and audited otherwise.
 */
export async function handlePluginsRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: PluginsContext & { who: PluginsWho; readBody: (req: IncomingMessage) => Promise<unknown>; json: Json; audit: (action: string, detail: Record<string, unknown>) => void }): Promise<boolean> {
  if (!url.pathname.startsWith('/api/plugins')) return false;
  const { who, json, audit } = ctx;
  if (url.pathname === '/api/plugins' && req.method === 'GET') {
    const view = await pluginsView(ctx, who.role);
    if (!view) {
      json(res, 403, { error: 'plugins are for the instance\'s owners and writers' });
      return true;
    }
    json(res, 200, view);
    return true;
  }
  if (req.method !== 'POST') return false;
  const action = url.pathname.slice('/api/plugins/'.length);
  const refused = (status: number, error: string) => {
    audit(`plugins.${action || 'unknown'}_refused`, { why: error.slice(0, 300) });
    json(res, status, { error });
    return true;
  };
  if (who.role !== 'owner') return refused(403, `only the instance's owners may change its plugins; @${who.login} is a ${who.role ?? 'nobody here'}`);
  if (!ctx.instance || !ctx.instanceHome) return refused(400, 'plugins belong to a server instance: this dashboard serves a checkout');
  const body = ((await ctx.readBody(req)) ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const list = (k: string) => (Array.isArray(body[k]) ? (body[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const request = (args: string[], what: Record<string, unknown>) => {
    if (!pluginStepOk(args)) return refused(400, `not a plugin step this page may ask for: ${args.join(' ').slice(0, 200)}`);
    const log = new EventLog(ctx.eventsDb);
    try {
      const r = requestPluginStep(log, { args, by: who.login, breakGlass: !!who.breakGlass });
      audit(`plugins.${action}`, { ...what, request: r.id });
      json(res, 200, { ok: true, request: r });
    } catch (e) {
      if (e instanceof MachineRequestError) return refused(e.status, e.message);
      throw e;
    } finally {
      log.close();
    }
    return true;
  };
  const id = str('id');
  const mcpInputs = () => ({ network: list('network'), secrets: list('secrets') });
  switch (action) {
    // Fetch something to review: a plugin at one commit, a pinned npm MCP server, an approved plugin's server, or the
    // second snapshot of an approved server. The coordinator runs it; the page then shows the preview.
    case 'fetch': {
      const kind = str('kind');
      if (kind === 'plugin') return request(['plugin-fetch', id, str('url'), str('sha'), ...(str('path') ? [str('path')] : [])], { id, kind, url: str('url'), sha: str('sha') });
      if (kind === 'npm') return request(['mcp-fetch', id, str('package'), str('version')], { id, kind, package: str('package'), version: str('version') });
      if (kind === 'server') return request(['mcp-preview', id, str('plugin'), str('server')], { id, kind, plugin: str('plugin'), server: str('server') });
      if (kind === 'snapshot') return request(['mcp-snapshot', id], { id, kind });
      return refused(400, 'kind is plugin, npm, server or snapshot');
    }
    // Review: the exact record these choices make, its digest, and how it differs from what is approved now. Nothing written.
    // Stage (confirm: true, with the reviewed digest): only that same digest is staged.
    case 'stage': {
      const roles = list('roles');
      let preview: Preview;
      try {
        preview = readPreview(ctx.instance, id);
      } catch (e) {
        return refused(404, (e as Error).message);
      }
      let record: ApprovalRecord;
      try {
        record = recordOf(preview, roles, preview.kind === 'mcp' ? mcpInputs() : undefined);
      } catch (e) {
        return refused(400, (e as Error).message);
      }
      const digest = approvalDigest(record);
      const current = (() => {
        try {
          return readAllowlist(ctx.instance!, ctx.allowlistOwnerUid === undefined ? {} : { ownerUid: ctx.allowlistOwnerUid }).entries.find((e) => e.record.id === id) ?? null;
        } catch {
          return null;
        }
      })();
      if (body.confirm !== true) {
        json(res, 200, { ok: true, confirmed: false, record, digest, current: current ? { digest: current.digest, record: current.record } : null, command: confirmCommand(ctx.instance, id, digest) });
        return true;
      }
      if (str('digest') !== digest) return refused(409, `the preview or the choices changed since the review (now ${digest}); review it again`);
      const plus = (l: string[]) => (l.length ? l.join('+') : 'none');
      const args = record.kind === 'plugin' ? ['plugin-stage', id, digest, roles.join('+')] : ['mcp-stage', id, digest, roles.join('+'), plus(record.network), plus(record.secrets)];
      return request(args, { id, digest, roles, ...(record.kind === 'mcp' ? { network: record.network, secrets: record.secrets } : {}) });
    }
    case 'withdraw':
      return request(['plugin-withdraw', id], { id });
    // Remove: review says what goes; confirm asks the helper to delete the entry (it can only delete).
    case 'remove': {
      if (body.confirm !== true) {
        json(res, 200, { ok: true, confirmed: false, changes: [`${id} leaves the allowlist; agents stop getting it from their next run; using it again needs a new approval`] });
        return true;
      }
      return request(['plugin-remove', id], { id });
    }
    // Switch an approved entry off or back on for this instance's agents (plugins-off.yaml): only ever takes away what
    // root approved, so it is written here, at once, after the owner confirms the change it showed.
    case 'toggle': {
      const on = body.on === true;
      let entry: AllowlistEntry | undefined;
      try {
        entry = readAllowlist(ctx.instance, ctx.allowlistOwnerUid === undefined ? {} : { ownerUid: ctx.allowlistOwnerUid }).entries.find((e) => e.record.id === id);
      } catch (e) {
        return refused(409, (e as Error).message);
      }
      if (!entry) return refused(404, `${id} is not approved for this instance`);
      const changes = toggleChanges(entry, on);
      if (body.confirm !== true) {
        json(res, 200, { ok: true, confirmed: false, changes });
        return true;
      }
      const cur = pluginsOff(ctx.instanceHome);
      const next = new Set(cur.all ? [] : cur.off);
      if (on) next.delete(id);
      else next.add(id);
      writeFileSync(join(ctx.instanceHome, PLUGINS_OFF_FILE), stringify({ off: [...next].sort() }), { mode: 0o600 });
      audit(`plugins.${on ? 'enabled' : 'disabled'}`, { id });
      json(res, 200, { ok: true, confirmed: true, changes });
      return true;
    }
    default:
      return refused(404, `no plugins action ${action.slice(0, 40)}`);
  }
}

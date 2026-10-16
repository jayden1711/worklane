// WHY (owner's condition on mcp-preview): unapproved MCP server code never runs as the broker's user. Its first
// snapshot is taken by a throwaway identity (systemd DynamicUser), with no network (PrivateNetwork), no secrets, its
// code read-only, and no write access to anything the broker later reads or executes: homes are hidden (ProtectHome),
// the system and /var/lib are read-only (ProtectSystem=strict), its /tmp is its own (PrivateTmp). What comes back is
// one line of JSON on stdout, which root parses as data (SnapshotSchema) and nothing else.
import { spawnSync } from 'node:child_process';
import { SnapshotSchema, type McpRuntime } from '../plugins/approval.js';
import { connectUpstream } from './upstream.js';
import { launchServer, resolveArgv } from './launch.js';
import type { Snapshot } from './snapshot.js';

/** The transient unit's properties: every one is part of the boundary, so a test checks each. */
export const THROWAWAY_PROPERTIES = [
  'DynamicUser=yes',
  'PrivateNetwork=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'NoNewPrivileges=yes',
  'RestrictAddressFamilies=AF_UNIX',
  'RuntimeMaxSec=90',
  'MemoryMax=1G',
  'UMask=0077',
] as const;

/** systemd-run's arguments for one snapshot: the engine's own snapshot-job, as a throwaway user, waited for. */
export function throwawayCommand(o: { node: string; engineCli: string; runtime: McpRuntime; codeDir: string; unit: string }): string[] {
  return [
    '--unit', o.unit, '--wait', '--pipe', '--collect', '--quiet', '--service-type=exec', '--description', 'MCP server snapshot (throwaway user, no network, no secrets)',
    ...THROWAWAY_PROPERTIES.flatMap((p) => ['--property', p]),
    '--property', `ReadOnlyPaths=${o.codeDir}`,
    '--property', 'Environment=PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 HOME=/tmp',
    o.node, o.engineCli, 'plugins', 'snapshot-job', '--code', o.codeDir, '--argv', JSON.stringify(o.runtime.argv),
  ];
}

/** Root: run one snapshot as a throwaway user; the snapshot it printed, checked against the schema, or why not. */
export function runThrowawaySnapshot(o: { node: string; engineCli: string; runtime: McpRuntime; codeDir: string; unit: string }, spawn = spawnSync): { snapshot: Snapshot | null; error: string | null } {
  const r = spawn('systemd-run', throwawayCommand(o), { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } });
  return parseSnapshotOutput(String(r.stdout ?? ''), r.status, String(r.stderr ?? ''));
}

/** The job's last line, as data: {"snapshot": ...} or {"error": "..."}; anything else is an error. */
export function parseSnapshotOutput(stdout: string, status: number | null, stderr = ''): { snapshot: Snapshot | null; error: string | null } {
  const line = stdout.trim().split('\n').pop() ?? '';
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { snapshot: null, error: `the snapshot run printed no result (exit ${status ?? 'killed'}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''})` };
  }
  const o = v as { snapshot?: unknown; error?: unknown };
  if (typeof o.error === 'string') return { snapshot: null, error: o.error.slice(0, 500) };
  const s = SnapshotSchema.safeParse(o.snapshot);
  return s.success ? { snapshot: s.data as Snapshot, error: null } : { snapshot: null, error: 'the snapshot run printed something that is not a snapshot' };
}

/** Inside the throwaway unit: start the server from its read-only code, list its tools, print one JSON line. */
export async function snapshotJob(codeDir: string, argv: string[]): Promise<string> {
  const runtime: McpRuntime = { type: 'plugin', plugin: 'x', tree: `wl-tree-v1:sha256:${'0'.repeat(64)}`, server: 'x', argv };
  const child = launchServer({ engineCli: '', node: '', runtime, codeDir, secrets: {}, network: [], scratchDir: `/tmp/mcp-snapshot-${process.pid}`, denyRead: [], unsandboxed: true });
  // Why it didn't start, for the owner reviewing it (no secrets here: a throwaway run has none): its last stderr lines,
  // or the spawn error (a command not found).
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  let spawnError = '';
  child.on('error', (e) => (spawnError = e.message));
  const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const up = await connectUpstream(child, { clientName: 'snapshot', timeoutMs: 30_000 });
    const snapshot = up.snapshot;
    up.stop();
    return JSON.stringify({ snapshot });
  } catch (e) {
    child.kill('SIGKILL');
    const tail = [spawnError, stderr.trim().split('\n').slice(-3).join(' | ')].filter(Boolean).join('; ');
    return JSON.stringify({ error: `${(e as Error).message}${tail ? ` (${tail})` : ''}`.slice(0, 500) });
  } finally {
    clearTimeout(kill);
  }
}

export { resolveArgv };
